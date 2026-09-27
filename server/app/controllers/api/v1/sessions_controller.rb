# frozen_string_literal: true

module Api
  module V1
    class SessionsController < BaseController
      # POST /api/v1/session
      def create
        return if json_body.nil?

        name = coerce_str(:name, max_length: 64)
        password = json_body["password"]
        if name.blank? || !password.is_a?(String)
          return render_error("invalid_payload", "name and password are required", :unprocessable_entity)
        end

        player = find_player_by_name(name)
        if player.nil? || !player.authenticate(password)
          return render_error("unauthenticated", "Invalid name or password", :unauthorized)
        end

        player.update_columns(last_ip: request.remote_ip)
        session = issue_session!(player)

        render_ok(token: session.token, player: player_json(player))
      end

      # DELETE /api/v1/session
      def destroy
        token = bearer_token
        Session.find_by(token: token)&.destroy! if token.present?
        head :no_content
      end

      # GET /api/v1/me
      def show
        require_auth!
        return if performed?

        render_ok(player: player_json(current_player))
      end

      # GET /api/v1/me/stats
      def stats
        require_auth!
        return if performed?

        render_ok(stats_payload_for(current_player))
      end
    end
  end
end
