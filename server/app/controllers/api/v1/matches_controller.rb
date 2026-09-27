# frozen_string_literal: true

module Api
  module V1
    class MatchesController < BaseController
      DEFAULT_PER_PAGE = 25
      MAX_PER_PAGE = 100
      MIN_PLAYERS = 2
      MAX_PLAYERS = 8
      COUNTDOWN_MS = 3000
      TICK_RATE = 20
      SNAPSHOT_RATE = 10

      before_action :require_auth!, except: %i[index show replay replay_file]

      # GET /api/v1/matches
      def index
        scope = Match.all
        status = coerce_str(:status, max_length: 32)
        mode = coerce_str(:mode, max_length: 32)
        map_id = coerce_str(:map_id, max_length: 64)

        scope = scope.where(status: status) if status.present? && Match.statuses.key?(status)
        scope = scope.where(mode: mode) if mode.present? && MATCH_MODES.include?(mode)
        scope = scope.where(map_id: map_id) if map_id.present?

        page = coerce_int(:page, min: 1, default: 1) || 1
        per_page = coerce_int(:per_page, min: 1, max: MAX_PER_PAGE, default: DEFAULT_PER_PAGE) || DEFAULT_PER_PAGE
        total = scope.count
        rows = scope.recent_first.limit(per_page).offset((page - 1) * per_page).to_a

        render_ok(
          matches: rows.map { |m| match_json(m) },
          page: page,
          per_page: per_page,
          total: total
        )
      end

      # POST /api/v1/matches
      def create
        return if json_body.nil?

        map_id = coerce_str(:map_id, max_length: 64) || Starc::Maps.default_map_id
        map = Starc::Maps.find(map_id)
        return render_error("invalid_payload", "Unknown map_id", :unprocessable_entity) if map.nil?

        mode = coerce_str(:mode, max_length: 32) || "melee"
        return render_error("invalid_payload", "Unknown mode", :unprocessable_entity) unless MATCH_MODES.include?(mode)

        password = json_body["password"]
        if password && !password.is_a?(String)
          return render_error("invalid_payload", "password must be a string", :unprocessable_entity)
        end

        max_players = clamp_max_players(coerce_int(:max_players, min: 0, max: 1_000_000), map)
        name = coerce_str(:name, max_length: 64) || "#{current_player.name}'s match"

        match = Match.new(
          name: name,
          mode: mode,
          map_id: map["id"].to_s,
          max_players: max_players,
          seed: SecureRandom.random_number(2**32),
          status: :lobby
        )
        assign_password(match, password) if password.present?

        saved =
          begin
            match.save!
            true
          rescue ActiveRecord::RecordInvalid => e
            render_error("invalid_payload", e.record&.errors&.full_messages&.join(", ").to_s, :unprocessable_entity)
            false
          end
        return unless saved

        # The creator is the host, in slot 0, with a free race.
        match.add_player!(player: current_player, host: true)
        broadcast_lobby_state(match)

        render_created(match: match_json_for(match, current_player))
      end

      # GET /api/v1/matches/:id
      def show
        match = find_match!(params[:id])
        return render_error("not_found", "No such match", :not_found) if match.nil?

        render_ok(match: match_json_for(match, current_player))
      end

      # POST /api/v1/matches/:id/join
      def join
        return if json_body.nil?

        match = find_match!(params[:id])
        return render_error("not_found", "No such match", :not_found) if match.nil?

        return render_error("match_in_progress", "That match is no longer joinable", :conflict) unless match.lobby?
        return render_error("already_in_match", "You are already in that match", :conflict) if in_match?(match)
        # A second live seat leaves `LobbyRegistry#current_seat` answering with
        # whichever seat it finds first, so the client is told it is in a match
        # that is not the one running and can never enter the game.
        if (other = live_seat_elsewhere(match))
          return render_error("already_in_match", "You are already in match #{other.match_id}", :conflict)
        end
        return render_error("lobby_full", "That match is full", :conflict) if match.full?

        if match.password_digest.present? && !password_matches?(match, body_value("password"))
          return render_error("wrong_password", "Incorrect match password", :forbidden)
        end

        race = coerce_str(:race, max_length: 16)
        race = nil unless RACE_KEYS.include?(race)
        match.add_player!(player: current_player, race: race, host: false)
        broadcast_lobby_state(match)

        render_ok(match: match_json_for(match, current_player))
      end

      # POST /api/v1/matches/:id/leave
      def leave
        match = find_match!(params[:id])
        return render_error("not_found", "No such match", :not_found) if match.nil?
        return render_error("match_in_progress", "A running match cannot be left", :conflict) if match.in_progress?

        seat = seat_for(match)
        return render_error("not_found", "You are not in that match", :not_found) if seat.nil?

        # `remove_player!` hands the host flag to the lowest-slot survivor.
        match.remove_player!(current_player)
        if match.player_count.zero?
          match.update!(status: :abandoned, ended_at: Time.current)
        end
        broadcast_lobby_state(match)

        render_ok(match: match_json_for(match, current_player))
      end

      # POST /api/v1/matches/:id/ready
      def ready
        return if json_body.nil?

        match = find_match!(params[:id])
        return render_error("not_found", "No such match", :not_found) if match.nil?
        return render_error("match_in_progress", "That match already started", :conflict) unless match.lobby?

        seat = seat_for(match)
        return render_error("not_found", "You are not in that match", :not_found) if seat.nil?

        flag = coerce_bool(:ready)
        return render_error("invalid_payload", "ready must be a boolean", :unprocessable_entity) if flag.nil?

        seat.update!(ready: flag)
        broadcast_lobby_state(match)

        render_ok(match: match_json_for(match, current_player))
      end

      # POST /api/v1/matches/:id/start
      def start
        match = find_match!(params[:id])
        return render_error("not_found", "No such match", :not_found) if match.nil?
        return render_error("match_in_progress", "That match already started", :conflict) unless match.lobby?

        seat = seat_for(match)
        if seat.nil? || !seat.host?
          return render_error("not_host", "Only the host can start the match", :forbidden)
        end
        if match.player_count < MIN_PLAYERS
          return render_error("not_ready", "At least #{MIN_PLAYERS} players are required", :unprocessable_entity)
        end
        if match.match_players.where(ready: false).exists?
          return render_error("not_ready", "Every player must be ready", :unprocessable_entity)
        end

        match.start!
        # Adopt the runner here, not only from the channels. Without this a
        # match started over REST flips to `in_progress` and broadcasts
        # `game:start`, but nothing ever steps the world — the match silently
        # never simulates and no snapshot is ever sent.
        if Starc::MatchRunner.adopt(match).nil?
          match.update!(status: :abandoned, ended_at: Time.current)
          return render_error("server_error", "the match could not be started on this server", :internal_server_error)
        end

        broadcast_game_start(match)

        render_ok(match: match_json_for(match, current_player))
      end

      # POST /api/v1/matches/:id/forfeit
      def forfeit
        match = find_match!(params[:id])
        return render_error("not_found", "No such match", :not_found) if match.nil?
        return render_error("match_in_progress", "That match is not running", :conflict) unless match.in_progress?

        seat = seat_for(match)
        return render_error("not_found", "You are not in that match", :not_found) if seat.nil?

        opponents = match.match_players.where.not(player_id: current_player.id).ordered.to_a
        winner = opponents.first
        seat.update!(result: :loss)
        opponents.each { |row| row.update!(result: row.id == winner&.id ? :win : :loss) }
        match.finish!(winner_player_id: winner&.player_id, reason: "forfeit", ended_at: Time.current)
        broadcast_game_ended(match)
        render_ok(match: match_json_for(match, current_player))
      end

      # GET /api/v1/matches/:id/replay
      def replay
        record = find_replay!
        return if performed?

        render_ok(record.to_download_hash.merge(final_state: record.parsed_final_state))
      end

      # GET /api/v1/matches/:id/replay_file
      def replay_file
        record = find_replay!
        return if performed?

        send_data record.to_replay_hash.to_json,
                  type: "application/json",
                  disposition: "attachment",
                  filename: "starc-match-#{record.match_id}-replay.json"
      end

      private

      # --------------------------------------------------------- shared bits

      def seat_for(match)
        match.match_players.find_by(player_id: current_player.id)
      end

      def in_match?(match)
        match.match_players.exists?(player_id: current_player.id)
      end

      # The player's seat in some *other* live match, if any. `MatchPlayer`
      # owns the one definition of "live" so the cable path cannot drift.
      def live_seat_elsewhere(match)
        MatchPlayer.live_seats_for(current_player.id).where.not(match_id: match.id).first
      end

      # Renders `404 not_found` and returns nil when the match or its replay is
      # missing.
      def find_replay!
        match = find_match!(params[:id])
        if match.nil? || match.replay.nil?
          render_error("not_found", "No replay for that match", :not_found)
          return nil
        end

        match.replay
      end

      def clamp_max_players(requested, map)
        value = requested || MIN_PLAYERS
        value = MIN_PLAYERS if value < MIN_PLAYERS
        value = MAX_PLAYERS if value > MAX_PLAYERS
        cap = map["max_players"].to_i
        value = cap if cap.positive? && value > cap
        [value, MIN_PLAYERS].max
      end

      def assign_password(match, password)
        if match.respond_to?(:password=)
          match.password = password
        else
          match.password_digest = BCrypt::Password.create(password)
        end
      end

      # ------------------------------------------------------------ payload

      # The `game:start` payload has exactly one source: `MatchRunner#start_payload`.
      # A second copy here drifted from it (it read the ground plane off
      # `point["y"]` after the axis change, sending `y: 0.0` for every seat),
      # so this now delegates rather than rebuilding the document.
      def game_start_payload(match)
        runner = Starc::MatchRunner.for(match.id)
        return runner.start_payload if runner

        raise ArgumentError, "no runner for match #{match.id} — the match was never started"
      end

      def game_ended_payload(match)
        started = match.started_at || match.created_at
        {
          v: 1,
          t: "game:ended",
          ts: (Time.current.to_f * 1000).to_i,
          tick: 0,
          winner: match.winner_player_id,
          reason: match.end_reason.presence || "stalemate",
          duration_ms: match.duration_ms || ((Time.current - started) * 1000).to_i,
          scores: match.players_ordered.map(&:to_score_hash),
          replay_url: "/api/v1/matches/#{match.id}/replay"
        }
      end

      # ------------------------------------------------------------ channel

      def broadcast_game_start(match)
        ActionCable.server.broadcast("game:#{match.id}", game_start_payload(match).to_json)
      rescue StandardError => e
        Rails.logger.warn("[starc] game:start broadcast failed: #{e.message}")
      end

      def broadcast_game_ended(match)
        ActionCable.server.broadcast("game:#{match.id}", game_ended_payload(match).to_json)
      rescue StandardError => e
        Rails.logger.warn("[starc] game:ended broadcast failed: #{e.message}")
      end

      def broadcast_lobby_state(match)
        summary = match.to_summary_hash
        payload = {
          v: 1,
          t: "lobby:state",
          ts: (Time.current.to_f * 1000).to_i,
          matches: [summary],
          you: nil
        }
        ActionCable.server.broadcast("lobby", payload.to_json)
      rescue StandardError => e
        Rails.logger.warn("[starc] lobby:state broadcast failed: #{e.message}")
      end
    end
  end
end
