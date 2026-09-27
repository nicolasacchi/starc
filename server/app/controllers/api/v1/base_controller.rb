# frozen_string_literal: true

module Api
  module V1
    # Shared plumbing for every v1 JSON endpoint: bearer auth, the single error
    # shape from PROTOCOL.md §7, body parsing that can never raise, and the
    # serializers the responses share.
    class BaseController < ApplicationController
      STATS_RECENT_LIMIT = 10
      MATCH_MODES = %w[melee custom 1v1 team].freeze
      RACE_KEYS = %w[terran zerg protoss].freeze

      # ---------------------------------------------------------------- auth

      # Resolves `Authorization: Bearer <token>` through a live Session.
      # Memoized; nil when the header is absent or the session is expired.
      def current_player
        return @current_player if defined?(@current_player)

        @current_player = resolve_player
      end

      def require_auth!
        return if current_player

        render_error("unauthenticated", "A valid bearer token is required", :unauthorized)
      end

      def bearer_token
        header = request.headers["Authorization"].to_s
        return nil if header.empty?

        match = header.match(/\ABearer\s+(.+)\z/i)
        return nil if match.nil?

        match[1].strip.presence
      end

      # ---------------------------------------------------------------- io

      # `status` is positional so `render_ok(foo: 1)` passes a plain Hash.
      def render_ok(payload, status = :ok)
        render json: payload, status: status
      end

      def render_created(payload)
        render json: payload, status: :created
      end

      # The one error shape: `{ "error": { "code", "message" } }`.
      def render_error(code, message, status)
        render json: { error: { code: code.to_s, message: message.to_s } }, status: status
      end

      # Parsed request body, always a Hash. Malformed JSON renders
      # `400 invalid_payload` and returns nil; every action bails out on nil.
      def json_body
        return @json_body if defined?(@json_body)

        raw = request.raw_post.to_s
        parsed =
          if raw.strip.empty?
            {}
          else
            begin
              JSON.parse(raw)
            rescue JSON::ParserError
              nil
            end
          end

        @json_body = parsed.is_a?(Hash) ? parsed : begin
          render_error("invalid_payload", "Request body must be a JSON object", :bad_request)
          nil
        end
      end

      def body_value(key)
        json_body&.[](key.to_s)
      end

      # ------------------------------------------------------------ coercion

      # Integer from query or body; nil (never raises) on absent, non-numeric
      # or out-of-range input.
      def coerce_int(name, min: nil, max: nil, default: nil)
        raw =
          if params[name.to_s].present?
            params[name.to_s]
          else
            body = json_body
            body.is_a?(Hash) && body[name.to_s].present? ? body[name.to_s] : default
          end
        return nil if raw.nil?
        return nil if raw == true || raw == false
        return nil if raw.is_a?(String) && !raw.match?(/\A-?\d+\z/)

        value = Integer(raw.to_s, 10)
        return nil if min && value < min
        return nil if max && value > max

        value
      rescue ArgumentError, TypeError
        nil
      end

      def coerce_str(name, max_length: 255, default: nil)
        raw = params[name.to_s]
        raw = body_value(name) if raw.blank?
        raw = default if raw.blank?
        return nil unless raw.is_a?(String) || raw.is_a?(Symbol) || raw.is_a?(Numeric)

        value = raw.to_s.strip
        return nil if value.empty? || value.length > max_length

        value
      end

      def coerce_bool(key, default: nil)
        raw = params[key.to_s]
        raw = body_value(key) if raw.nil?
        return default if raw.nil?
        return raw if raw == true || raw == false
        return nil unless raw.is_a?(String) || raw.is_a?(Integer)

        %w[1 true yes on].include?(raw.to_s.strip.downcase)
      end

      # --------------------------------------------------------- serializers

      def player_json(player)
        return nil if player.nil?

        {
          id: player.id,
          name: player.name,
          wins: player.wins.to_i,
          losses: player.losses.to_i,
          draws: player.draws.to_i,
          kills: player.kills.to_i,
          deaths: player.deaths.to_i,
          resources_mined: player.resources_mined.to_i,
          units_built: player.units_built.to_i,
          rating: player.rating.to_i,
          created_at: player.created_at&.iso8601
        }
      end

      def match_player_json(mp)
        {
          player_id: mp.player_id,
          name: mp.player&.name.to_s,
          slot: mp.slot.to_i,
          team: mp.team.to_i,
          race: mp.race.to_s,
          host: !!mp.host,
          ready: !!mp.ready,
          result: mp.result.to_s,
          kills: mp.kills.to_i,
          deaths: mp.deaths.to_i,
          army_value: mp.army_value.to_i
        }
      end

      def match_json(match)
        seats = match.players_ordered
        {
          id: match.id,
          name: match.name.to_s,
          mode: match.mode.to_s,
          map_id: match.map_id.to_s,
          max_players: match.max_players.to_i,
          player_count: seats.length,
          status: match.status.to_s,
          has_password: match.password_digest.present?,
          host: match.host_player&.name.to_s,
          seed: match.seed.to_i,
          winner_player_id: match.winner_player_id,
          end_reason: match.end_reason,
          duration_ms: match.duration_ms&.to_i,
          started_at: match.started_at&.iso8601,
          ended_at: match.ended_at&.iso8601,
          created_at: match.created_at&.iso8601,
          players: seats.map { |mp| match_player_json(mp) }
        }
      end

      # Adds the caller's own seat under `you` (PROTOCOL §2 `lobby:state`).
      def match_json_for(match, player)
        payload = match_json(match)
        own = payload[:players].find { |seat| seat[:player_id] == player&.id }
        payload[:you] =
          if own
            { player_id: own[:player_id], slot: own[:slot], race: own[:race], ready: own[:ready], is_host: own[:host] }
          else
            nil
          end
        payload
      end

      # { player, stats, recent_matches } for PlayersController#stats and
      # SessionsController#stats.
      def stats_payload_for(player)
        rows = player.match_players.includes(:match).order(created_at: :desc).to_a
        played = rows.reject { |mp| mp.result.to_s == "pending" }

        {
          player: player_json(player),
          stats: {
            matches: played.length,
            wins: played.count { |mp| mp.result.to_s == "win" },
            losses: played.count { |mp| mp.result.to_s == "loss" },
            draws: played.count { |mp| mp.result.to_s == "draw" },
            win_rate: win_rate(played.count { |mp| mp.result.to_s == "win" }, played.length),
            kills: rows.sum { |mp| mp.kills.to_i },
            deaths: rows.sum { |mp| mp.deaths.to_i },
            kd_ratio: kd_ratio(rows.sum { |mp| mp.kills.to_i }, rows.sum { |mp| mp.deaths.to_i }),
            resources_mined: rows.sum { |mp| mp.resources_mined.to_i },
            units_built: rows.sum { |mp| mp.units_built.to_i },
            by_race: rows.group_by(&:race).transform_values { |group| race_stats(group) }
          },
          recent_matches: rows.first(STATS_RECENT_LIMIT).map { |mp| recent_match_json(mp) }
        }
      end

      # The `sessions` table is the single source of truth for tokens; there is
      # no denormalised copy on the player row.
      def issue_session!(player)
        player.issue_session!(ip: request.remote_ip)
      end

      def race_stats(group)
        played = group.reject { |mp| mp.result.to_s == "pending" }
        wins = played.count { |mp| mp.result.to_s == "win" }
        kills = group.sum { |mp| mp.kills.to_i }
        deaths = group.sum { |mp| mp.deaths.to_i }
        {
          matches: played.length,
          wins: wins,
          losses: played.count { |mp| mp.result.to_s == "loss" },
          draws: played.count { |mp| mp.result.to_s == "draw" },
          win_rate: win_rate(wins, played.length),
          kills: kills,
          deaths: deaths,
          kd_ratio: kd_ratio(kills, deaths),
          resources_mined: group.sum { |mp| mp.resources_mined.to_i },
          units_built: group.sum { |mp| mp.units_built.to_i }
        }
      end

      def recent_match_json(mp)
        match = mp.match
        {
          match_id: mp.match_id,
          name: match&.name.to_s,
          mode: match&.mode.to_s,
          map_id: match&.map_id.to_s,
          status: match&.status.to_s,
          result: mp.result.to_s,
          kills: mp.kills.to_i,
          deaths: mp.deaths.to_i,
          resources_mined: mp.resources_mined.to_i,
          units_built: mp.units_built.to_i,
          started_at: match&.started_at&.iso8601,
          ended_at: match&.ended_at&.iso8601
        }
      end

      def win_rate(wins, matches)
        return 0.0 if matches.to_i.zero?

        (wins.to_f / matches).round(4)
      end

      def kd_ratio(kills, deaths)
        return kills.to_f if deaths.to_i.zero?

        (kills.to_f / deaths).round(4)
      end

      # ---------------------------------------------------------- lookups

      def find_match!(id)
        Match.find_by(id: Integer(id.to_s, 10))
      rescue ArgumentError, TypeError
        nil
      end

      def find_player_by_name(name)
        return nil if name.blank?

        Player.find_by("LOWER(name) = ?", name.to_s.strip.downcase)
      end

      def password_matches?(record, password)
        return false if password.blank? || record.password_digest.blank?
        return true if record.respond_to?(:authenticate_password) && record.authenticate_password(password)

        BCrypt::Password.new(record.password_digest) == password
      rescue BCrypt::Errors::InvalidHash, BCrypt::Errors::InvalidPassword
        false
      end

      private

      def resolve_player
        token = bearer_token
        return nil if token.nil?

        session = Session.live.find_by(token: token)
        return nil if session.nil? || !session.valid?

        session.player
      end
    end
  end
end
