# frozen_string_literal: true

module Starc
  # Process-level registry of the matches this worker is currently serving,
  # keyed by match id.
  #
  # It is a fan-out cache, never a source of truth: `Match` in the database
  # owns lobby membership (the REST API writes it), so a missing or stale entry
  # is always re-read from the database rather than reconstructed here. What the
  # registry buys is the broadcast path — one `lobby:state` for every subscriber
  # instead of a query per subscriber — plus the stream names of a match and the
  # `MatchRunner` that is simulating it.
  class LobbyRegistry
    include Singleton

    LOBBY_STREAM = "lobby"

    # Long enough that a burst of state changes costs one query, short enough
    # that a write is visible on the next broadcast.
    CACHE_TTL = 0.5

    # `lobby:state` only advertises matches a client can still act on.
    LISTED_STATUSES = %w[lobby in_progress].freeze

    # Chat history kept per match, so somebody joining a room sees what they
    # walked into.
    CHAT_BUFFER = 100

    Entry = Struct.new(:id, :stream, :value, keyword_init: true)

    class << self
      def game_stream(match_id)
        "game:#{match_id.to_i}"
      end

      # Chat for one match, so a client only hears the room it is sitting in.
      def match_chat_stream(match_id)
        "lobby:match:#{match_id.to_i}"
      end

      # The `you` block of `lobby:state` differs per player, so it goes out on
      # the player's own stream — a player may be browsing from several tabs.
      def player_stream(player_id)
        "lobby:player:#{player_id.to_i}"
      end

      def now_ms
        (Time.now.to_f * 1000).to_i
      end
    end

    def initialize
      @mutex = Mutex.new
      @entries = {}
      @chat = {}
      @cache = nil
    end

    # --------------------------------------------------------------- entries

    def register(match_id, stream = LOBBY_STREAM, value: nil)
      entry = Entry.new(id: match_id.to_i, stream: stream.to_s, value: value)
      @mutex.synchronize do
        @entries[entry.id] = entry
        @cache = nil
      end
      entry
    end

    def unregister(match_id)
      @mutex.synchronize do
        @chat.delete(match_id.to_i)
        removed = @entries.delete(match_id.to_i)
        @cache = nil if removed
        removed
      end
    end

    def for(match_id)
      @mutex.synchronize { @entries[match_id.to_i] }
    end

    def ids
      @mutex.synchronize { @entries.keys }
    end

    def include?(match_id)
      !self.for(match_id).nil?
    end

    # Drops the cached match list. Called after anything that changes it, so the
    # next broadcast reflects the write that just happened.
    def invalidate!
      @mutex.synchronize { @cache = nil }
    end

    # ------------------------------------------------------------ broadcasts

    # The shared half of `lobby:state` (PROTOCOL.md §2): the match browser, in
    # one broadcast to every `lobby` subscriber.
    def broadcast_state(filters = nil)
      payload = envelope(matches: matches(filters), you: nil)
      ActionCable.server.broadcast(LOBBY_STREAM, payload.to_json)
      payload
    rescue StandardError => e
      Rails.logger.warn("[starc] lobby:state broadcast failed: #{e.class}: #{e.message}")
      nil
    end

    # The personal half: the `you` block, sent to every connection this player
    # has open.
    def publish_context(player_id)
      return nil if player_id.nil?

      payload = envelope(matches: matches, you: context_for(player_id))
      ActionCable.server.broadcast(self.class.player_stream(player_id), payload.to_json)
      payload
    rescue StandardError => e
      Rails.logger.warn("[starc] lobby:state publish failed: #{e.class}: #{e.message}")
      nil
    end

    # ------------------------------------------------------------------ reads

    # The browser listing.
    def matches(filters = nil)
      apply_filters(fresh_summaries, filters)
    end

    # The `you` block of `lobby:state`: the match the player is sitting in, or
    # nil. A finished or abandoned match is not "yours" any more.
    def context_for(player_id)
      return nil if player_id.nil?

      seat = current_seat(player_id)
      return nil if seat.nil?

      {
        "match_id" => seat.match_id,
        "player_id" => seat.player_id,
        "slot" => seat.slot,
        "race" => seat.race,
        "ready" => seat.ready,
        "is_host" => seat.host
      }
    end

    # ------------------------------------------------------------------- chat

    # Appends a line to the room's history and pushes it to everybody in it.
    def push_chat(match_id, line)
      id = match_id.to_i
      history = @mutex.synchronize do
        (@chat[id] ||= []) << line
        @chat[id] = @chat[id].last(CHAT_BUFFER)
        @chat[id]
      end
      ActionCable.server.broadcast(self.class.match_chat_stream(id), chat_payload(id, [line]))
      history
    rescue StandardError => e
      Rails.logger.warn("[starc] lobby chat failed: #{e.class}: #{e.message}")
      nil
    end

    # The last CHAT_BUFFER lines of a room, oldest first.
    def chat_history(match_id)
      @mutex.synchronize { (@chat[match_id.to_i] || []).dup }
    end

    def clear_chat(match_id)
      @mutex.synchronize { @chat.delete(match_id.to_i) }
    end

    private

    def envelope(fields)
      { v: 1, t: "lobby:state", ts: self.class.now_ms }.merge(fields)
    end

    # One shape for both a live line and a backlog: a client reads
    # `lines`, always oldest first.
    def chat_payload(match_id, lines)
      { v: 1, t: "lobby:chat", ts: self.class.now_ms, match_id: match_id, lines: lines }
    end

    # The lowest-slot seat of a match the player is in. A player is only ever in
    # one live match, and finished or abandoned matches are not live.
    def current_seat(player_id)
      seats = MatchPlayer.where(player_id: player_id).order(:slot).to_a
      return nil if seats.empty?

      live = Match.where(id: seats.map(&:match_id)).reject { |m| m.finished? || m.abandoned? }
      return nil if live.empty?

      seats.find { |seat| live.any? { |m| m.id == seat.match_id } }
    end

    def fresh_summaries
      now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      cached = @mutex.synchronize { @cache }
      return cached[1] if cached && (now - cached[0]) < CACHE_TTL

      listed = Match.all.select { |m| LISTED_STATUSES.include?(m.status) }
                       .map(&:to_summary_hash)
      @mutex.synchronize { @cache = [now, listed] }
      listed
    end

    def apply_filters(listed, filters)
      return listed unless filters.is_a?(Hash)

      mode = filters["mode"]
      map_id = filters["map_id"] || filters["map"]
      only_joinable = filters["only_joinable"]

      listed = listed.select { |m| m[:mode] == mode } if mode.present?
      listed = listed.select { |m| m[:map_id] == map_id } if map_id.present?
      listed = listed.reject { |m| m[:has_password] } if only_joinable
      listed
    end
  end
end
