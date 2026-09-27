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

    # A fatal error ends the current exchange: the client is told why and is
    # expected to leave. The subscription itself is left alone — rejecting it
    # also deafens the channel to every later message, and a client that can
    # recover (identify, rejoin) has to be able to.
    def terminate!(code, message)
      transmit_error(code, message, fatal: true)
      nil
    end

    # The refusal a client cannot recover from, and the one that must not be
    # left half-open. `terminate!` deliberately leaves the subscription alive
    # for `identify` (PROTOCOL.md §1); this is the opposite — the client is
    # not a participant in what it asked for, so no later message on this
    # subscription can change that. `reject` deafens the channel to every
    # later action, and removing the subscription runs `unsubscribed`
    # straight away, so a client that is turned away leaves nothing behind —
    # in particular no half-armed game state that a later disconnect could be
    # misread as "a player of this match left".
    #
    # Safe from `subscribed` (before ActionCable has confirmed the
    # subscription) as well as from any later action: `reject` is a flag
    # ActionCable reads at confirmation time, and the removal is idempotent.
    def refuse!(code, message)
      transmit_error(code, message, fatal: true)
      return nil if @refused

      @refused = true
      reject
      connection.subscriptions.remove_subscription(self)
      nil
    end

    # True once this subscription has been refused for good. `unsubscribed`
    # consults it so a turned-away subscriber is never counted as a departing
    # player, however often the connection drops afterwards.
    def refused?
      @refused == true
    end
  end
end
