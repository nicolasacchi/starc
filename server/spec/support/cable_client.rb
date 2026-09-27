# frozen_string_literal: true

require "json"
require "cgi"
require_relative "websocket_client"

# The protocol layer above {WebSocketClient}: ActionCable's own JSON framing, as
# PROTOCOL.md describes it in practice.
#
# ActionCable 8.1 has no STOMP support — the negotiated subprotocol is
# `actioncable-v1-json` and every frame in both directions is one JSON
# document. Client → server frames are `{"command": …, "identifier": …}`, where
# `identifier` is a *JSON-encoded string* of the channel's params and `data` is
# itself a JSON string. Server → client frames are `{"type": …}` control
# frames, or `{"identifier": …, "message": "<json string>"}` for a channel
# payload.
#
# The surface is deliberately small — `#subscribe`, `#send_message`, `#on`,
# `#messages`, `#close` — because a test should read as a sequence of protocol
# facts, not as socket plumbing.
class CableClient
  # One inbound channel payload: which subscription it belongs to and the
  # decoded protocol message.
  Delivery = Struct.new(:channel_key, :payload) do
    def type
      payload["t"]
    end

    def [](key)
      payload[key]
    end
  end

  attr_reader :negotiated_protocol

  # Opens an authenticated cable connection. `token` is the session token from
  # `POST /api/v1/players`; `ApplicationCable::Connection` reads it from
  # `?token=`, and rejects the upgrade outright when it is present and invalid.
  def self.open(base_url, token: nil, open_timeout: 15, label: nil)
    url = base_url.sub(%r{\Ahttp}, "ws")
    url = "#{url}/cable"
    url = "#{url}?token=#{CGI.escape(token)}" if token

    client = new(WebSocketClient.open(url, protocols: ["actioncable-v1-json"],
                                                 origin: base_url, open_timeout: open_timeout))
    client.label = label || "cable"
    client
  end

  # A human-readable name for this client, used in failure messages so a
  # timeout says *which* player stalled.
  attr_accessor :label

  def initialize(socket)
    @socket = socket
    @negotiated_protocol = socket.negotiated_protocol
    @inbox = Queue.new
    @listeners = {}
    @identifiers = {}
    @seen = Hash.new(0)
    @mutex = Mutex.new
    @closed = false
    @server_closed = false
    @disconnect_reason = nil
    start_pump
  end

  def closed?
    @closed
  end

  # True once the server asked for a terminal close (`reconnect: false`), which
  # the client must not paper over by reconnecting.
  def server_closed?
    @server_closed
  end

  def disconnect_reason
    @disconnect_reason
  end

  # Subscribes to a channel and returns the key its payloads are routed under.
  #
  # `params` are the channel's own params, e.g.
  # `{ channel: "GameChannel", match_id: 5 }`. The key is derived from them so a
  # test can talk about `"GameChannel:5"` instead of repeating the hash.
  def subscribe(params)
    key = channel_key(params)
    identifier = JSON.generate(params.transform_keys(&:to_s))
    @mutex.synchronize { @identifiers[key] = identifier }

    write(command: "subscribe", identifier: identifier)
    key
  end

  def unsubscribe(params)
    key = channel_key(params)
    identifier = @mutex.synchronize { @identifiers.delete(key) }
    return nil if identifier.nil?

    write(command: "unsubscribe", identifier: identifier)
    key
  end

  # Sends one protocol message on a channel, e.g.
  # `send_message({ channel: "GameChannel", match_id: 5 }, { "v" => 1, "t" => "identify", … })`.
  def send_message(params, payload)
    identifier = @mutex.synchronize { @identifiers[channel_key(params)] }
    raise ArgumentError, "not subscribed to #{channel_key(params)}" if identifier.nil?

    write(command: "message", identifier: identifier, data: JSON.generate(payload))
  end

  # Registers a block invoked with every payload delivered to `channel_key`.
  # Returns the key so it can be captured in one expression.
  def on(channel_key, &block)
    @mutex.synchronize { (@listeners[channel_key.to_s] ||= []) << block }
    channel_key.to_s
  end

  # Pops the next inbound channel payload, waiting up to `timeout` seconds.
  #
  # Raises {WebSocketClient::TimeoutError} naming `description` when nothing
  # arrives in time, and {WebSocketClient::ConnectionClosed} when the socket
  # dies mid-wait — so a failing expectation says what it was waiting for
  # instead of hanging.
  def messages(timeout: 5, description: "a message from the cable")
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout

    loop do
      begin
        return @inbox.pop(true)
      rescue ThreadError
        nil
      end

      if @closed
        raise WebSocketClient::ConnectionClosed,
              "cable closed (#{@disconnect_reason.inspect}) while waiting for #{description}"
      end

      remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
      raise WebSocketClient::TimeoutError, "timed out after #{timeout}s waiting for #{description}" if remaining <= 0

      sleep 0.005
    end
  end

  # Every payload this client has received, as a tally of message types. A
  # failing wait quotes it, so the report says what the client *did* see
  # rather than only what it never saw.
  def seen
    @mutex.synchronize { @seen.dup }
  end


  # Collects every payload matching `type` (and optionally `channel_key`) that
  # arrives within `timeout`. Returns what it got, so a caller can assert on
  # how many — and the timeout is the bound, not a failure in itself.
  def drain(timeout: 1, type: nil, channel_key: nil)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    collected = []
    loop do
      remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
      break if remaining <= 0

      delivery =
        begin
          @inbox.pop(true)
        rescue ThreadError
          nil
        end

      if delivery.nil?
        break if @closed

        sleep 0.005
        next
      end

      next if type && delivery.type != type
      next if channel_key && delivery.channel_key != channel_key.to_s

      collected << delivery
    end

    collected
  end

  def close
    return if @closed

    @closed = true
    @socket.close
  end

  # The routing key for a channel's params, e.g. `"GameChannel:5"`.
  def self.channel_key(params)
    normalized = params.transform_keys(&:to_s)
    channel = normalized["channel"].to_s
    rest = normalized.except("channel").sort.to_h
    rest.empty? ? channel : "#{channel}:#{rest.values.join(',')}"
  end

  private

  def channel_key(params)
    self.class.channel_key(params)
  end

  def write(frame)
    @socket.send_text(JSON.generate(frame))
  end

  # Drains the socket on its own thread so a test thread is never blocked by a
  # frame it is not currently reading, and so a slow or absent reader cannot
  # stall the connection.
  def start_pump
    @pump = Thread.new do
      begin
        pump_loop
      rescue StandardError => e
        @disconnect_reason ||= "#{e.class}: #{e.message}"
      ensure
        @closed = true
      end
    end
    @pump.abort_on_exception = false
  end

  def pump_loop
    loop do
      raw = @socket.each_text(timeout: 30, description: "the next cable frame")
      frame = JSON.parse(raw)
      dispatch(frame)
      break if @server_closed
    end
  rescue JSON::ParserError
    # A frame that is not JSON is not a protocol message; dropping it keeps the
    # connection usable, and the assertions downstream will notice the gap.
    nil
  end

  def dispatch(frame)
    type = frame["type"]

    case type
    when "welcome", "confirm_subscription", "ping"
      nil
    when "rejection"
      @inbox << Delivery.new(identifier_key(frame["identifier"]), { "t" => "rejection", "identifier" => frame["identifier"] })
    when "disconnect"
      @server_closed = true
      @disconnect_reason = "#{frame['reason']} (reconnect: #{frame['reconnect'].inspect})"
    else
      deliver(frame)
    end
  end

  def deliver(frame)
    identifier = frame["identifier"]
    key = identifier_key(identifier)
    body = frame["message"]
    # `message` is a JSON *string*; anything else is a frame shape we do not
    # understand and must not hand to a test as if it were a payload.
    payload = body.is_a?(String) ? JSON.parse(body) : body
    return unless payload.is_a?(Hash)

    delivery = Delivery.new(key, payload)
    @inbox << delivery
    @mutex.synchronize do
      @seen[payload["t"].to_s] += 1
      @listeners[key]&.each { |block| block.call(delivery) }
    end
  end

  def identifier_key(identifier)
    return "" if identifier.nil?

    params = begin
      JSON.parse(identifier)
    rescue JSON::ParserError
      nil
    end
    params.is_a?(Hash) ? self.class.channel_key(params) : identifier.to_s
  end
end
