# frozen_string_literal: true

# Lobby channel `lobby` (PROTOCOL.md §2): the match browser and the room in
# front of a match.
#
# `lobby:list` is open — browsing the lobby is public — while every mutating
# action needs a player. Any state change is announced twice: once on the shared
# `lobby` stream for everybody, and once on the player's own stream for the
# `you` block, which is per-player by definition. The database is the source of
# truth; `Starc::LobbyRegistry` is the fan-out cache in front of it.
class LobbyChannel < ApplicationCable::Channel
  CHAT_MIN_LENGTH = 1
  CHAT_MAX_LENGTH = 280
  CHAT_RATE_LIMIT = 0.5
  MIN_PLAYERS = 2
  MAX_PLAYERS = 8

  handles "identify", :identify
  handles "lobby:list", :lobby_list
  handles "lobby:create", :lobby_create
  handles "lobby:join", :lobby_join
  handles "lobby:leave", :lobby_leave
  handles "lobby:ready", :lobby_ready
  handles "lobby:settings", :lobby_settings
  handles "lobby:start", :lobby_start
  handles "lobby:chat", :lobby_chat

  def subscribed
    stream_from Starc::LobbyRegistry::LOBBY_STREAM
    subscribe_personal
    sync_chat_stream
    send_state
  end

  def unsubscribed
    # Losing the lobby tab while still in its lobby means leaving it: a match
    # must not sit in the browser waiting for somebody who has gone. A match
    # already under way is left alone — `GameChannel` owns disconnect handling
    # from there, and its forfeit countdown must not be started twice.
    match = lobby_match_of(player_id)
    return if match.nil?

    match.remove_player!(player_id)
    if match.player_count.zero?
      match.update!(status: :abandoned, ended_at: Time.current)
      registry.unregister(match.id)
    end
    registry.broadcast_state
  rescue StandardError => e
    Rails.logger.warn("[starc] lobby leave on disconnect failed: #{e.class}: #{e.message}")
  end

  def identify(data)
    player = identify_player(data["token"].to_s)
    if player.nil?
      terminate!("unauthenticated", "that session token is not valid")
      return
    end

    subscribe_personal
    sync_chat_stream
    send_state
  end

  def lobby_list(data)
    transmit_message("lobby:state", matches: registry.matches(data["filters"]), you: registry.context_for(player_id))
  end

  def lobby_create(data)
    return unless require_player

    name = data["name"].to_s.strip
    mode = data["mode"].to_s
    map_id = data["map_id"].to_s
    return reject_payload("name must be 1..64 characters") if name.empty? || name.length > 64
    return reject_payload("mode must be one of #{Match::MODES.join(', ')}") unless Match::MODES.include?(mode)

    map = Starc::Maps.find(map_id)
    return reject_payload("unknown map #{map_id.inspect}") if map.nil?

    match = Match.create!(
      name: name,
      mode: mode,
      map_id: map_id,
      max_players: clamp_max_players(data["max_players"], map),
      seed: SecureRandom.random_number(2**32),
      status: :lobby,
      password_digest: password_digest(data["password"])
    )
    match.add_player!(player: current_player, race: preferred_race(data), host: true)
    registry.register(match.id)
    announce_state
  rescue ActiveRecord::RecordInvalid => e
    reject_payload(invalid_message(e))
  end

  def lobby_join(data)
    return unless require_player

    match = Match.find_by(id: data["match_id"].to_i)
    return reject_message("not_found", "no such match") if match.nil?
    return reject_message("match_in_progress", "that match has already started") unless match.lobby?
    return reject_message("already_in_match", "you are already in that match") if match.match_players.exists?(player_id: player_id)
    return reject_message("lobby_full", "that match is full") if match.full?
    return reject_message("wrong_password", "incorrect match password") unless password_ok?(match, data["password"])

    match.add_player!(player: current_player, race: preferred_race(data), host: false)
    registry.register(match.id)
    announce_state
  rescue ActiveRecord::RecordInvalid => e
    reject_message("lobby_full", invalid_message(e))
  end

  def lobby_leave(data)
    return unless require_player

    seat = seat_in(data["match_id"])
    return reject_message("not_found", "you are not in that match") if seat.nil?

    match = seat.match
    return reject_message("match_in_progress", "a running match cannot be left") if match.in_progress?

    match.remove_player!(current_player)
    if match.player_count.zero?
      match.update!(status: :abandoned, ended_at: Time.current)
      registry.unregister(match.id)
    end
    announce_state
  end

  def lobby_ready(data)
    return unless require_player

    seat = seat_in(data["match_id"])
    return reject_message("not_found", "you are not in that match") if seat.nil?

    seat.update!(ready: data["ready"] ? true : false)
    announce_state
  end

  def lobby_settings(data)
    return unless require_player

    match = Match.find_by(id: data["match_id"].to_i)
    return reject_message("not_found", "no such match") if match.nil?
    return reject_message("not_host", "only the host can change the settings") unless host?(match)
    return reject_message("match_in_progress", "a running match cannot be changed") unless match.lobby?

    problem = apply_settings(match, data)
    return reject_payload(problem) if problem

    match.save!
    announce_state
  rescue ActiveRecord::RecordInvalid => e
    reject_payload(invalid_message(e))
  end

  def lobby_start(data)
    return unless require_player

    match = Match.find_by(id: data["match_id"].to_i)
    return reject_message("not_found", "no such match") if match.nil?
    return reject_message("match_in_progress", "that match has already started") unless match.lobby?
    return reject_message("not_host", "only the host can start the match") unless host?(match)
    return reject_message("not_ready", "every player has to be ready first") unless match.all_ready?

    match.start!
    # The runner is what makes a match live: it builds the world and starts
    # stepping. Subscribers of `game:<id>` get their `game:start` from it.
    if Starc::MatchRunner.adopt(match).nil?
      match.update!(status: :abandoned, ended_at: Time.current)
      return reject_message("server_error", "the match could not be started on this server")
    end

    announce_state
  end

  def lobby_chat(data)
    return unless require_player

    match_id = data["match_id"].to_i
    return reject_message("not_found", "you are not in that match") if seat_in(match_id).nil?

    text = data["text"].to_s
    return reject_payload("chat must be #{CHAT_MIN_LENGTH}..#{CHAT_MAX_LENGTH} characters") unless valid_chat?(text)

    now = monotonic
    return reject_message("rate_limited", "you are sending chat too fast") if (now - @last_chat_at.to_f) < CHAT_RATE_LIMIT

    @last_chat_at = now
    line = {
      "player_id" => player_id,
      "name" => current_player.name,
      "text" => text,
      "ts" => self.class.now_ms
    }
    registry.push_chat(match_id, line)
    transmit_message("lobby:chat", match_id: match_id, lines: [line])
  end

  private

  def registry
    Starc::LobbyRegistry.instance
  end

  # Any state change: the browser for everybody, then the `you` block for this
  # player on every tab they have open.
  def announce_state
    registry.invalidate!
    registry.broadcast_state
    registry.publish_context(player_id)
    sync_chat_stream
  end

  def send_state
    transmit_message("lobby:state", matches: registry.matches, you: registry.context_for(player_id))
  end

  def subscribe_personal
    return if player_id.nil? || @personal_stream

    @personal_stream = Starc::LobbyRegistry.player_stream(player_id)
    stream_from @personal_stream
  end

  # Chat is per match, so a connection only listens to the room it is in — and
  # is caught up on the buffered lines when it arrives.
  def sync_chat_stream
    context = registry.context_for(player_id)
    match_id = context && context["match_id"]
    return if match_id == @chat_match_id

    # Rails 8.1 spells this `stop_stream_from`; `stop_stream` raises
    # NoMethodError, which aborted `lobby:leave` after the seat row was already
    # deleted, so the client never got an `announce_state`.
    stop_stream_from(Starc::LobbyRegistry.match_chat_stream(@chat_match_id)) if @chat_match_id
    @chat_match_id = match_id
    return if match_id.nil?

    stream_from Starc::LobbyRegistry.match_chat_stream(match_id)
    history = registry.chat_history(match_id)
    transmit_message("lobby:chat", match_id: match_id, lines: history) if history.any?
  end

  def require_player
    return true if player_id

    terminate!("unauthenticated", "sign in before joining a match")
    false
  end

  def reject_message(code, message)
    transmit_error(code, message)
    nil
  end

  def reject_payload(message)
    reject_message("invalid_payload", message)
  end

  # The seat of this player in a named match, whatever its state.
  def seat_in(match_id)
    return nil if player_id.nil?

    MatchPlayer.find_by(match_id: match_id.to_i, player_id: player_id)
  end

  # The live match this player is sitting in, if any.
  def lobby_match_of(player)
    return nil if player.nil?

    seat = MatchPlayer.where(player_id: player).order(:slot).first
    return nil if seat.nil?

    match = Match.find_by(id: seat.match_id)
    # A running match is GameChannel's business: its forfeit countdown would
    # fight the lobby abandoning the match on a tab close.
    return nil if match.nil? || match.in_progress? || match.finished? || match.abandoned?

    match
  end

  def host?(match)
    match.match_players.find_by(player_id: player_id)&.host?
  end

  # Returns a problem description, or nil when the settings were applied.
  def apply_settings(match, data)
    name = data["name"].to_s.strip
    mode = data["mode"].to_s
    match.name = name if name.present?
    return "mode must be one of #{Match::MODES.join(', ')}" if mode.present? && !Match::MODES.include?(mode)

    match.mode = mode if mode.present?

    map_id = data["map_id"].to_s
    if map_id.present?
      map = Starc::Maps.find(map_id)
      return "unknown map #{map_id.inspect}" if map.nil?
      return "that map only seats #{map['max_players']}" if map["max_players"].to_i < match.player_count

      match.map_id = map_id
      match.max_players = [clamp_max_players(data["max_players"], map), match.player_count].max
    elsif data.key?("max_players")
      requested = clamp_max_players(data["max_players"], nil)
      return "the match already has #{match.player_count} players" if requested < match.player_count

      match.max_players = requested
    end

    match.password_digest = password_digest(data["password"]) || match.password_digest
    nil
  end

  # A match password is a shared secret rather than a player's, so the digest
  # is built here and checked through `Match#authenticate`.
  def password_digest(password)
    return nil if password.blank?

    BCrypt::Password.create(password.to_s)
  end

  def password_ok?(match, password)
    return true if match.password_digest.blank?
    return false if password.blank?

    match.authenticate(password.to_s)
  rescue BCrypt::Errors::InvalidHash, BCrypt::Errors::InvalidPassword
    false
  end

  # A race preference is honoured when it is playable; `Match#add_player!` then
  # hands out a free one if it is taken.
  def preferred_race(data)
    race = (data["race_preference"] || data["race"]).to_s
    MatchPlayer::RACES.include?(race) ? race : nil
  end

  def valid_chat?(text)
    text.length >= CHAT_MIN_LENGTH && text.length <= CHAT_MAX_LENGTH
  end

  def clamp_max_players(requested, map)
    value = requested.is_a?(Integer) ? requested : Integer(requested.to_s, exception: false)
    value = MIN_PLAYERS if value.nil? || value < MIN_PLAYERS
    value = MAX_PLAYERS if value > MAX_PLAYERS
    # `map` is nil when only `max_players` was sent, so `cap` has to be a real
    # Integer — `nil.positive?` would raise instead of rejecting the payload.
    cap = map ? map["max_players"].to_i : 0
    value = cap if cap.positive? && value > cap
    value
  end

  def invalid_message(error)
    error.record&.errors&.full_messages&.to_sentence.presence || "the request could not be applied"
  end

  def monotonic
    Process.clock_gettime(Process::CLOCK_MONOTONIC)
  end
end
