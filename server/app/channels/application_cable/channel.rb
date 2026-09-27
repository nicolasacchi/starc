# frozen_string_literal: true

module ApplicationCable
  # Shared plumbing for every STARC channel: the message envelope of
  # PROTOCOL.md, error reporting and dispatch of the wire message types.
  #
  # Two things here are not stock ActionCable:
  #
  # * the client names its message type `t` (`{"v":1,"t":"game:command",…}`),
  #   and those types contain a colon, which cannot be a Ruby method name, so
  #   each channel declares an explicit type → handler table;
  # * every message leaves the server as one JSON document, the same convention
  #   the REST broadcasts use, so a client parses `message.data` exactly once.
  class Channel < ActionCable::Channel::Base
    PROTOCOL_VERSION = 1

    class << self
      # Wire type => handler method, e.g. "game:command" => :game_command.
      def message_handlers
        @message_handlers ||= {}
      end

      def handles(type, handler)
        message_handlers[type.to_s] = handler.to_sym
      end

      def handler_for(type)
        message_handlers[type.to_s]
      end

      # The envelope every server → client message is wrapped in
      # (PROTOCOL.md, "Every message has the shape").
      def envelope(type, fields = {})
        { v: PROTOCOL_VERSION, t: type.to_s, ts: now_ms }.merge(fields)
      end

      def now_ms
        (Time.now.to_f * 1000).to_i
      end
    end

    def perform_action(data)
      payload = data.is_a?(Hash) ? data : {}
      type = (payload["t"] || payload["action"]).to_s
      handler = self.class.handler_for(type)

      if handler.nil?
        transmit_error("invalid_payload", "unknown message type #{type.inspect}")
        return
      end

      super(payload.merge("action" => handler.to_s))
    end

    private

    def player_id
      current_player&.id
    end

    def transmit_message(type, fields = {})
      transmit self.class.envelope(type, fields).to_json
    end

    def transmit_error(code, message, fatal: false)
      transmit_message("error", code: code.to_s, message: message.to_s, fatal: fatal)
    end

    # Binds a token to this connection, as PROTOCOL.md §1 requires before any
    # other message. Returns the player, or nil when the token is not live.
    def identify_player(token)
      player = connection.class.authenticate_token(token)
      connection.current_player = player if player
      player
    end

    # A fatal error ends the conversation: the client is told why, the
    # subscription is never confirmed and the channel stops receiving.
    def terminate!(code, message)
      transmit_error(code, message, fatal: true)
      reject
      stop_all_streams
      nil
    end
  end
end
