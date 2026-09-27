# frozen_string_literal: true

module ApplicationCable
  # Cable connection identity (PROTOCOL.md §1).
  #
  # The client authenticates the cable itself: it passes its session token as
  # `?token=…` on `/cable`, or in an `X-Token` header, and every message on
  # every channel then runs as that player.
  #
  # A connection *without* a token stays anonymous, because the lobby browser
  # is public (`lobby:list` is authenticated-optional, PROTOCOL.md §2) and
  # because PROTOCOL.md §1 has the client `identify` later on the game channel.
  # A connection that presents a token which is unknown or expired is rejected.
  class Connection < ActionCable::Connection::Base
    identified_by :current_player

    def connect
      token = token_from_request
      player = self.class.authenticate_token(token)

      if player.nil? && token.present?
        reject_unauthorized_connection
      end

      self.current_player = player
      logger.add_tags "ActionCable", player ? player.name : "anonymous"
    end

    # Shared with `identify` on a channel, which is how a client that opened the
    # cable before it had a token binds a player to the connection.
    def self.authenticate_token(token)
      return nil if token.blank?

      Session.live.find_by(token: token.to_s)&.player
    rescue ActiveRecord::ActiveRecordError => e
      Rails.logger.error("[starc] session lookup failed: #{e.class}: #{e.message}")
      nil
    end

    private

    def token_from_request
      request.params[:token].presence || request.headers["X-Token"].presence
    end
  end
end
