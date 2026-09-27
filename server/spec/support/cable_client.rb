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

  # How many messages may be held per subscription waiting for its
  # confirmation. A client that queues this much is already wedged, and an
  # unbounded queue would turn a protocol-ordering bug into an out-of-memory
  # one.
  MAX_PENDING_PER_CHANNEL = 64

  def initialize(socket)
    @socket = socket
    @negotiated_protocol = socket.negotiated_protocol
    @inbox = Queue.new
    @listeners = {}
    @identifiers = {}
    @seen = Hash.new(0)
    @mutex = Mutex.new
    @closed = false
    @welcomed = false
    @confirmed = {}
    @rejected = {}
    @pending = Hash.new { |hash, key| hash[key] = [] }
    @startup = []
    @dropped = 0
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
  #
  # The `subscribe` frame itself waits for `welcome` (PROTOCOL.md §1, ordering
  # rule 1).
  def subscribe(params)
    key = channel_key(params)
    identifier = JSON.generate(params.transform_keys(&:to_s))
    @mutex.synchronize { @identifiers[key] = identifier }

    enqueue_startup(command: "subscribe", identifier: identifier)
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
  #
  # The frame is held until `welcome` has arrived and this subscription has been
  # confirmed. The server registers a subscription asynchronously relative to
  # the client's write, so a `message` that beats its own confirmation is
  # refused outright with "Unable to find subscription with identifier" — and
  # the refusal is swallowed server-side, which makes it look like a flaky
  # server rather than an ordering bug. Queueing here is what makes the first
  # `identify` land (PROTOCOL.md §1, ordering rule 2).
  def send_message(params, payload)
    key = channel_key(params)
    identifier = @mutex.synchronize { @identifiers[key] }
    raise ArgumentError, "not subscribed to #{key}" if identifier.nil?
    raise ArgumentError, "subscription to #{key} was rejected by the server" if rejected?(key)

    frame = { command: "message", identifier: identifier, data: JSON.generate(payload) }
    enqueue_for(key, frame)
  end

  # Waits until the subscription is confirmed, so a caller can rely on the
  # channel existing before it starts issuing messages.
  def await_confirmation(key, timeout: 10)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    until confirmed?(key) || rejected?(key)
      if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
        raise "timed out after #{timeout}s waiting for #{key} to be confirmed by the server " \
              "(saw: #{describe_inbox})"
      end

      sleep 0.005
    end
    key
  end

  def confirmed?(key)
    @mutex.synchronize { @confirmed[key.to_s] }
  end

  def rejected?(key)
    @mutex.synchronize { @rejected[key.to_s] }
  end

  # Everything this client has received, as a tally of message types. A
  # failing wait quotes it, so the report says what the client *did* see
  # rather than only what it never saw.
  def describe_inbox
    counts = seen
    counts.empty? ? "nothing yet" : counts.map { |type, n| "#{type}x#{n}" }.join(", ")
  end

  # Frames issued before `welcome` are held here and replayed in order once it
  # arrives (PROTOCOL.md §1, ordering rule 1).
  def enqueue_startup(frame)
    ready =
      @mutex.synchronize do
        return write(frame) if @welcomed

        @startup << frame
        nil
      end
    ready
  end

  # Frames issued for a subscription that is not confirmed yet are held per
  # channel key and flushed on `confirm_subscription` (PROTOCOL.md §1, ordering
  # rule 2). A rejected subscription drops them: the server will never accept
  # them, and replaying them would just produce a second refusal.
  def enqueue_for(key, frame)
    ready =
      @mutex.synchronize do
        return write(frame) if @welcomed && @confirmed[key]

        queue = @pending[key]
        if queue.size >= MAX_PENDING_PER_CHANNEL
          raise "dropping a message for #{key}: #{queue.size} messages are already waiting for its " \
                "subscription to be confirmed, so the server is not accepting it"
        end

        queue << frame
        nil
      end
    ready
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
    when "welcome"
      flush_startup
    when "confirm_subscription"
      confirm(identifier_key(frame["identifier"]))
    when "rejection"
      reject(identifier_key(frame["identifier"]))
    when "ping"
      # Fire-and-forget: the gem's own client answers nothing, so neither does
      # this one. It exists to refresh liveness on the connection indicator.
      nil
    when "disconnect"
      @server_closed = true
      @disconnect_reason = "#{frame['reason']} (reconnect: #{frame['reconnect'].inspect})"
    else
      deliver(frame)
    end
  end

  # The connection is only usable once the server has said `welcome`; anything
  # written before that is replayed here, in issue order.
  def flush_startup
    frames = @mutex.synchronize do
      @welcomed = true
      @startup.dup.tap { @startup.clear }
    end
    frames.each { |frame| write(frame) }
  end

  def confirm(key)
    frames = @mutex.synchronize do
      @confirmed[key] = true
      # Only flush once the connection itself is live, or a message issued
      # before `welcome` would go out ahead of the connection.
      @welcomed ? (@pending.delete(key) || []) : []
    end
    frames.each { |frame| write(frame) }
  end

  # A rejected subscription is terminal for that key: its queued messages are
  # dropped rather than replayed, because the server has said it will never
  # accept them.
  def reject(key)
    dropped = @mutex.synchronize do
      @rejected[key] = true
      @pending.delete(key) || []
    end
    @dropped += dropped.size
    @inbox << Delivery.new(key, { "t" => "rejection", "identifier" => key })
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
