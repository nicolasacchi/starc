# frozen_string_literal: true

require "monitor"

module Starc
  # Owns one live match: builds the world, drives the fixed 50 ms step in a
  # dedicated thread, broadcasts snapshots at 10 Hz, applies the commands of
  # every player, and writes the replay when the match ends.
  #
  # Exactly one runner exists per in-progress match in a process, reachable
  # through `MatchRunner.for(match_id)`. A match started through the REST API
  # has no runner until somebody subscribes to its game channel, so both start
  # paths converge on `adopt`.
  class MatchRunner
    TICK_MS = 50
    TICK_SECONDS = TICK_MS / 1000.0
    TICK_HZ = 1000 / TICK_MS
    SNAPSHOT_HZ = 10
    SNAPSHOT_EVERY = TICK_HZ / SNAPSHOT_HZ
    COUNTDOWN_MS = 3_000

    # How long a dropped player has to come back before the match is decided
    # without them (PROTOCOL.md §5, reason `disconnect`).
    FORFEIT_GRACE_MS = 60_000
    STOP_TIMEOUT_SECONDS = 5

    # Bounds a hostile client before the simulation ever sees the batch.
    MAX_COMMANDS_PER_BATCH = 256
    MAX_IDS_PER_COMMAND = 256

    # `from_tick` is a claim about what the client has seen, not an instruction;
    # anything further back than this is treated as the current tick.
    ACK_WINDOW_TICKS = 30 * TICK_HZ

    # After a pause this long the schedule is re-anchored instead of replaying
    # the missed ticks, so one slow broadcast cannot become a catch-up spiral.
    RESYNC_AFTER_SECONDS = 1.0

    COMMAND_TYPES = %w[
      move attack stop hold patrol train build cancel rally harvest ability
      select chat
    ].freeze

    class << self
      def registry
        @registry ||= {}
      end

      def registry_mutex
        @registry_mutex ||= Mutex.new
      end

      def game_stream(match_id)
        LobbyRegistry.game_stream(match_id)
      end

      def for(match_id)
        registry_mutex.synchronize { registry[match_id.to_i] }
      end

      def all
        registry_mutex.synchronize { registry.values }
      end

      def running?(match_id)
        !self.for(match_id).nil?
      end

      # The runner for a match, starting one if the match is live and this
      # process has not simulated it yet. Returns nil when the match is not
      # running or the world could not be built.
      def adopt(match)
        self.for(match.id) || (match.in_progress? ? start!(match) : nil)
      end

      def start!(match)
        runner = registry_mutex.synchronize do
          registry[match.id.to_i] ||= new(match)
        end
        runner.launch!
      end

      def forget(match_id)
        registry_mutex.synchronize { registry.delete(match_id.to_i) }
      end

      # Clean shutdown: no thread outlives the process that started it.
      def stop_all!
        all.each { |runner| runner.stop! }
      end
    end

    attr_reader :match, :match_id, :world

    def initialize(match)
      @match = match
      @match_id = match.id.to_i
      # Reentrant: the tick thread reads the forfeit deadlines while it already
      # holds the world lock.
      @mutex = Monitor.new
      @acks = {}
      @disconnect_at = {}
      @pending_events = []
      @stopping = false
      @thread = nil
      @replay = ReplayWriter.new(match)
    end

    # Builds the world, publishes the match in the registry and starts stepping.
    # Returns self, or nil if the match could not be simulated.
    def launch!
      @mutex.synchronize do
        return self if @thread

        @world = build_world
        LobbyRegistry.instance.register(@match_id, self.class.game_stream(@match_id), value: self)
        @thread = Thread.new do
          Thread.current.name = "starc-match-#{@match_id}"
          begin
            run_loop
          ensure
            # The thread checked out a connection for the end-of-match writes;
            # hand it back rather than leaking one per finished match.
            release_connection
          end
        end
      end
      self
    rescue StandardError => e
      log_error("launch", e)
      abandon_match
      forget
      nil
    end

    # PROTOCOL.md §3. Clients rebuild the opening state from seed + map_id +
    # the roster, so no world payload is transmitted.
    def start_payload
      {
        v: 1,
        t: "game:start",
        ts: now_ms,
        match_id: @match_id,
        seed: @match.seed.to_i,
        map_id: @match.map_id.to_s,
        tick_rate: TICK_HZ,
        snapshot_rate: SNAPSHOT_HZ,
        countdown_ms: COUNTDOWN_MS,
        players: start_players
      }
    end

    # Called from a channel thread for every `game:command` batch. Returns
    # `{ applied:, rejected: }`; rejections match the client's own command
    # indices (PROTOCOL.md §4).
    def apply_commands(player_id, commands, from_tick)
      return inactive unless running?

      batch = sanitize_batch(commands)
      result = nil
      tick = 0
      @mutex.synchronize do
        return inactive unless running?

        tick = @world.tick
        @acks[player_id] = [@acks[player_id].to_i, clamp_tick(from_tick, tick)].max
        result = @world.apply_commands(player_id, batch[:entries].map(&:last))
      end

      rejected = world_rejections(result, batch[:entries]) + batch[:rejected]
      record_accepted(tick, player_id, batch[:entries], rejected)
      { applied: field_of(result, "applied").to_i, rejected: rejected }
    rescue StandardError => e
      log_error("apply_commands", e)
      { applied: 0, rejected: [{ "index" => 0, "code" => "server_error", "message" => "command could not be applied" }] }
    end

    def running?
      @mutex.synchronize { !@world.nil? && !@thread.nil? && @thread.alive? && !@stopping }
    end

    def finished?
      !end_result.nil?
    end

    def player_connected(player_id)
      @mutex.synchronize { @disconnect_at.delete(player_id) }
      nil
    end

    # A dropped player has FORFEIT_GRACE_MS to come back; the countdown is
    # checked by the tick loop, so no timer thread is needed per player.
    def player_disconnected(player_id)
      @mutex.synchronize do
        # A second tab closing must not restart the countdown of a player who
        # is still connected elsewhere.
        return nil if @disconnect_at.key?(player_id)

        @disconnect_at[player_id] = monotonic + (FORFEIT_GRACE_MS / 1000.0)
        @pending_events << alert_event(
          "#{player_name(player_id)} disconnected — the match ends in #{FORFEIT_GRACE_MS / 1000} s unless they return"
        )
      end
    end

    def player_forfeits(player_id)
      push_alert("#{player_name(player_id)} forfeited")
      @mutex.synchronize { @world&.forfeit(player_id, "forfeit") }
      nil
    end

    # Clean shutdown (server restart, code reload): stop stepping, let the loop
    # finalise, and never leave the thread running.
    def stop!
      thread = @mutex.synchronize do
        @stopping = true
        @thread
      end
      return nil if thread.nil?

      thread.join(STOP_TIMEOUT_SECONDS)
      thread.kill if thread.alive?
      nil
    end

    def elapsed_ms
      @mutex.synchronize { @world&.elapsed_ms.to_i }
    end

    private

    # ------------------------------------------------------------------- loop

    def run_loop
      next_at = monotonic
      until stopping?
        delay = next_at - monotonic
        sleep(delay) if delay.positive?
        break if stopping?

        # The schedule is the source of truth: each tick moves the target time
        # on by exactly one step, so sleep error never accumulates.
        next_at += TICK_SECONDS
        next_at = monotonic if monotonic - next_at > RESYNC_AFTER_SECONDS

        step
        break if end_result
      end
    rescue StandardError => e
      # Nothing may escape the loop: a raise here would leave every client
      # waiting on snapshots that will never come.
      log_error("tick loop", e)
      end_world(nil, "stalemate")
    ensure
      finalize!
    end

    def step
      payload = nil
      @mutex.synchronize do
        @world.step!
        expire_forfeits
        payload = snapshot_payload if (@world.tick % SNAPSHOT_EVERY).zero?
      end
      broadcast(payload) if payload
    end

    # The world builds the whole `game:snapshot` envelope and drains its own
    # events; the runner adds only what the world cannot know — the alerts it
    # raised, and the acknowledgement for this broadcast.
    def snapshot_payload
      snapshot = @world.snapshot(server_ms: now_ms)
      snapshot["events"] = Array(snapshot["events"]).concat(take_pending_events)
      snapshot["ack"] = broadcast_ack
      snapshot
    end

    # `ack` is the highest `from_tick` processed for this world. The snapshot is
    # one broadcast to the whole match, so this is the highest across its
    # clients; it is clamped to the authoritative tick on the way in, so it can
    # never tell a client to drop history it has not already been superseded for.
    def broadcast_ack
      @acks.values.max.to_i
    end

    # -------------------------------------------------------------- commands

    def sanitize_batch(commands)
      unless commands.is_a?(Array)
        return { entries: [], rejected: [rejection(0, "invalid_payload", "commands must be an array")] }
      end

      entries = []
      rejected = []
      overflow = false

      commands.each_with_index do |command, index|
        if !overflow && (index >= MAX_COMMANDS_PER_BATCH || rejected.size >= MAX_COMMANDS_PER_BATCH)
          rejected << rejection(index, "invalid_payload", "batch limited to #{MAX_COMMANDS_PER_BATCH} commands")
          overflow = true
        end
        next if overflow

        problem = command_problem(command)
        if problem
          rejected << rejection(index, "invalid_payload", problem)
        else
          entries << [index, command]
        end
      end

      { entries: entries, rejected: rejected }
    end

    # Structural screening only — ownership, resources and cooldowns are the
    # world's business. Anything that is obviously hostile or malformed is
    # dropped here so it can never cost the simulation anything.
    def command_problem(command)
      return "command must be an object" unless command.is_a?(Hash)

      type = value_of(command, "c").to_s
      return "unknown command type #{type.inspect}" unless COMMAND_TYPES.include?(type)

      ids = value_of(command, "ids")
      return nil if ids.nil?

      return "ids must be an array" unless ids.is_a?(Array)
      return "ids must not be empty" if ids.empty?
      return "ids limited to #{MAX_IDS_PER_COMMAND} entries" if ids.size > MAX_IDS_PER_COMMAND
      return "ids must be entity ids" unless ids.all?(Integer)

      nil
    end

    # The world reports positions inside the list it was handed, which is the
    # batch minus the commands screened out above; this maps them back onto the
    # indices the client actually sent.
    def world_rejections(result, entries)
      Array(field_of(result, "rejected")).map do |entry|
        position = field_of(entry, "index").to_i
        original = entries[position]&.first || position
        rejection(original, field_of(entry, "code"), field_of(entry, "message"))
      end
    end

    def rejection(index, code, message)
      { "index" => index.to_i, "code" => code.to_s, "message" => message.to_s }
    end

    def inactive
      { applied: 0, rejected: [rejection(0, "not_ready", "the match is not running")] }
    end

    # Only accepted commands reach the replay (PROTOCOL.md §8): the replay has
    # to reproduce the world, and a command the world refused never happened.
    def record_accepted(tick, player_id, entries, rejected)
      dropped = rejected.each_with_object({}) { |r, set| set[r["index"]] = true }
      entries.each do |(index, command)|
        next if dropped.key?(index)

        @replay.record(tick: tick, player_id: player_id, index: index, command: command)
      end
    end

    def clamp_tick(from_tick, tick)
      claimed = from_tick.is_a?(Integer) ? from_tick : Integer(from_tick.to_s, exception: false)
      return tick if claimed.nil? || claimed > tick
      return tick if claimed < tick - ACK_WINDOW_TICKS

      claimed
    end

    # ---------------------------------------------------------------- endings

    # The world owns the ending: a forfeit or a stalemate is decided through it,
    # so the simulation and the match row can never disagree about who won.
    def end_world(winner, reason)
      @mutex.synchronize { @world&.finish!(winner, reason.to_s) }
      nil
    end

    def end_result
      @mutex.synchronize { @world&.finished? }
    end

    def expire_forfeits
      return if @disconnect_at.empty?

      now = monotonic
      expired = @disconnect_at.select { |_player_id, deadline| deadline <= now }.keys
      return if expired.empty?

      expired.each { |player_id| @disconnect_at.delete(player_id) }
      @world.forfeit(expired.first, "disconnect")
    end

    def finalize!
      result = end_result
      # The replay is written before anyone is told the match ended, so the
      # `replay_url` in `game:ended` already resolves.
      persist(result)
      broadcast(ended_payload(result)) if result
      forget
    rescue StandardError => e
      log_error("finalize", e)
      forget
    ensure
      @mutex.synchronize { @thread = nil }
    end

    def persist(result)
      states = player_states
      if result.nil?
        abandon_match
        return
      end

      winner = normalize_winner(value_of(result, "winner"))
      reason = value_of(result, "reason").to_s
      run = elapsed_ms
      apply_results(winner, states)
      @match.reload
      @match.finish!(winner_player_id: winner, reason: reason, duration_ms: run)
      write_replay(winner: winner, duration_ms: run)
    rescue StandardError => e
      log_error("persist", e)
    end

    def apply_results(winner, states)
      @match.players_ordered.each do |seat|
        state = state_for(states, seat.player_id)
        result = result_for(seat.player_id, winner)
        stats = {
          kills: stat(state, "kills"),
          deaths: stat(state, "deaths"),
          resources_mined: stat(state, "resources_mined"),
          units_built: stat(state, "units_built")
        }
        seat.update!(stats.merge(result: result, army_value: stat(state, "army_value")))
        # `Player` keeps no army_value, so the career totals take the rest.
        seat.player&.record_result!(result: result, **stats)
      rescue StandardError => e
        log_error("result for player #{seat.player_id}", e)
      end
    end

    def write_replay(winner:, duration_ms:)
      @replay.finalize!(
        winner: winner,
        duration_ms: duration_ms,
        tick_count: current_tick,
        final_state: { "entities" => final_entities }
      )
    end

    def abandon_match
      @match.reload
      return if @match.finished? || @match.abandoned?

      @match.update!(status: :abandoned, end_reason: "server_error", ended_at: Time.current)
    rescue StandardError => e
      log_error("abandon", e)
    end

    def ended_payload(result)
      states = player_states
      winner = normalize_winner(value_of(result, "winner"))
      {
        v: 1,
        t: "game:ended",
        ts: now_ms,
        tick: current_tick,
        winner: winner,
        reason: value_of(result, "reason").to_s,
        duration_ms: elapsed_ms,
        scores: build_scores(states, winner),
        replay_url: "/api/v1/matches/#{@match_id}/replay"
      }
    end

    def build_scores(states, winner)
      roster.map do |player|
        stats = state_for(states, player[:id])
        {
          "player_id" => player[:id],
          "race" => player[:race],
          "result" => result_for(player[:id], winner),
          "kills" => stat(stats, "kills"),
          "deaths" => stat(stats, "deaths"),
          "resources_mined" => stat(stats, "resources_mined"),
          "units_built" => stat(stats, "units_built"),
          "army_value" => stat(stats, "army_value")
        }
      end
    end

    def result_for(player_id, winner)
      return "draw" if winner.nil?

      player_id == winner ? "win" : "loss"
    end

    # The world is the only source of truth about who won; a winner that is not
    # in the roster is a bug, not a victory.
    def normalize_winner(winner)
      id = winner.is_a?(Integer) ? winner : Integer(winner.to_s, exception: false)
      return nil if id.nil?

      roster.any? { |player| player[:id] == id } ? id : nil
    end

    # ------------------------------------------------------------------ world

    def build_world
      Sim::World.new(seed: @match.seed.to_i, map_id: @match.map_id.to_s, players: roster)
    end

    def roster
      @roster ||= @match.players_ordered.map do |seat|
        {
          id: seat.player_id,
          name: seat.player&.name.to_s,
          race: seat.race.to_s,
          slot: seat.slot.to_i,
          team: seat.team.to_i
        }
      end
    end

    def start_players
      positions = start_positions
      roster.map do |player|
        point = positions[player[:slot]] || positions.first || { "x" => 32.0, "y" => 32.0 }
        {
          player_id: player[:id],
          slot: player[:slot],
          race: player[:race],
          name: player[:name],
          team: player[:team],
          start: { x: point["x"].to_f, y: point["y"].to_f }
        }
      end
    end

    def start_positions
      map = Maps.find(@match.map_id) || Maps.find(Maps.default_map_id)
      Array(map && map["start_positions"])
    rescue StandardError => e
      log_error("start_positions", e)
      []
    end

    def player_states
      @mutex.synchronize { @world&.player_states || {} }
    end

    def state_for(states, player_id)
      states = states.to_h
      states[player_id] || states[player_id.to_s] || {}
    end

    # The replay's `final_state` is the whole entity table, dead included, not
    # the living-only table a snapshot carries.
    def final_entities
      Array(@world&.entity_states)
    end

    def current_tick
      @mutex.synchronize { @world&.tick.to_i }
    end

    def player_name(player_id)
      roster.find { |player| player[:id] == player_id }&.fetch(:name) || "player #{player_id}"
    end

    def stopping?
      @mutex.synchronize { @stopping }
    end

    def take_pending_events
      events = @pending_events
      @pending_events = []
      events
    end

    def push_alert(text)
      @mutex.synchronize { @pending_events << alert_event(text) }
    end

    def alert_event(text)
      { "e" => "alert", "text" => text }
    end

    # --------------------------------------------------------------- plumbing

    def broadcast(payload)
      return if payload.nil?

      ActionCable.server.broadcast(self.class.game_stream(@match_id), payload.to_json)
    rescue StandardError => e
      log_error("broadcast", e)
    end

    def forget
      LobbyRegistry.instance.unregister(@match_id)
      self.class.forget(@match_id)
    end

    def release_connection
      ActiveRecord::Base.connection_pool.release_connection
    rescue StandardError => e
      log_error("release_connection", e)
    end

    def monotonic
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end

    def now_ms
      (Time.now.to_f * 1000).to_i
    end

    def value_of(hash, key)
      return nil unless hash.is_a?(Hash)
      return hash[key] if hash.key?(key)

      hash[key.to_sym]
    end

    # The world answers with a `CommandResult` and `Rejection` structs rather
    # than hashes, so a field is read through whichever shape arrives.
    def field_of(object, key)
      return value_of(object, key) if object.is_a?(Hash)
      return nil unless object.respond_to?(key)

      object.public_send(key)
    end

    def stat(states, key)
      field_of(states, key).to_i
    end

    def log_error(scope, error)
      Rails.logger.error("[starc] match #{@match_id} #{scope} failed: #{error.class}: #{error.message}")
    end
  end
end
