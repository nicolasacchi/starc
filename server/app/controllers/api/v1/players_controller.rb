# frozen_string_literal: true

module Api
  module V1
    class PlayersController < BaseController
      NAME_PATTERN = Player::NAME_PATTERN
      NAME_MAX = 24
      PASSWORD_MIN = 6
      PASSWORD_MAX = 128

      # POST /api/v1/players
      def create
        return if json_body.nil?

        name = coerce_str(:name, max_length: NAME_MAX)
        password = json_body["password"]

        errors = []
        errors << "name must be 1..#{NAME_MAX} characters of [A-Za-z0-9_-]" unless name_shape_ok?(name)
        errors << "password must be #{PASSWORD_MIN}..#{PASSWORD_MAX} characters" unless password_shape_ok?(password)
        return render_error("invalid_payload", errors.join("; "), :unprocessable_entity) if errors.any?

        if find_player_by_name(name)
          return render_error("taken", "That name is already registered", :conflict)
        end

        player = build_player(name, password)
        return if player.nil?

        session = issue_session!(player)
        render_created(token: session.token, player: player_json(player))
      end

      # GET /api/v1/players/:name/stats
      def stats
        player = find_player_by_name(params[:name])
        return render_error("not_found", "No such player", :not_found) if player.nil?

        render_ok(stats_payload_for(player))
      end

      private

      def name_shape_ok?(name)
        name.is_a?(String) && name.match?(NAME_PATTERN)
      end

      def password_shape_ok?(password)
        password.is_a?(String) && password.length.between?(PASSWORD_MIN, PASSWORD_MAX)
      end

      # Renders the error and returns nil when the record cannot be created.
      def build_player(name, password)
        player = Player.new(name: name, password: password, password_confirmation: password, last_ip: request.remote_ip)
        if player.save
          player
        else
          render_error(duplicate_name?(player) ? "taken" : "invalid_payload", invalid_message(player), :unprocessable_entity)
          nil
        end
      end

      def duplicate_name?(player)
        player.errors.of_kind?(:name, :taken)
      end

      # Takes the unsaved record, not a `RecordInvalid` — `build_player` saves
      # and inspects errors directly so it can distinguish a duplicate name.
      def invalid_message(player)
        messages = player.errors.full_messages
        return "Invalid player" if messages.empty?

        messages.join(", ")
      end
    end
  end
end
