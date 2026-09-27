# frozen_string_literal: true

require "socket"
require "digest"
require "base64"
require "securerandom"
require "uri"

# A minimal RFC 6455 WebSocket client, written from scratch because the bundle
# has no WebSocket gem and the end-to-end suite must not add one.
#
# It is deliberately not general purpose: it speaks exactly what Puma and
# ActionCable need. The handshake is a plain HTTP/1.1 `GET` with the upgrade
# headers, the response is checked for `101` and a correct
# `Sec-WebSocket-Accept`, and from then on frames are read on a background
# thread and handed to {#each_text} through a queue.
#
# Client → server frames are always masked (RFC 6455 §5.3) and server → client
# frames are expected unmasked. Payloads of 0..125 bytes use the short length
# form, 126 selects the 16-bit form and 127 the 64-bit one; fragmented messages
# are reassembled from their continuation frames. `Ping` is answered with
# `Pong` and `Close` is echoed before the socket is dropped.
class WebSocketClient
  # RFC 6455 §1.3 — the GUID the accept hash is computed over.
  GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

  OPCODE_CONTINUATION = 0x0
  OPCODE_TEXT = 0x1
  OPCODE_BINARY = 0x2
  OPCODE_CLOSE = 0x8
  OPCODE_PING = 0x9
  OPCODE_PONG = 0xA

  # A frame bigger than this is a bug in the peer, not a message worth
  # buffering; ActionCable snapshots are a few tens of kB at most.
  MAX_PAYLOAD = 8 * 1024 * 1024

  class HandshakeError < StandardError; end
  class ConnectionClosed < StandardError; end

  # Raised by {#each_text} when the deadline passes with nothing to read, so a
  # failing expectation names the wait instead of hanging the suite.
  class TimeoutError < StandardError; end

  # Opens a socket to `ws://host:port/path` and completes the upgrade.
  #
  # `headers` are added verbatim, which is how the auth token reaches
  # `ApplicationCable::Connection` (it reads `?token=` or `X-Token`). `origin`
  # must be the same scheme/host/port as the target, because ActionCable
  # refuses a cross-origin upgrade by default. `protocols` is the
  # `Sec-WebSocket-Protocol` offer; ActionCable serves `actioncable-v1-json`
  # and offers no STOMP subprotocol at all.
  def self.open(url, headers: {}, origin: nil, protocols: nil, open_timeout: 15)
    uri = URI.parse(url)
    raise HandshakeError, "only ws:// is supported, got #{url}" unless uri.scheme == "ws"

    port = uri.port || 80
    socket = TCPSocket.new(uri.host, port)
    socket.setsockopt(Socket::IPPROTO_TCP, Socket::TCP_NODELAY, 1)

    key = Base64.strict_encode64(SecureRandom.random_bytes(16))
    request = build_request(uri, key, headers, origin || "http://#{uri.host}:#{port}", protocols)

    begin
      socket.write(request)
      new(socket, read_handshake(socket, key))
    rescue StandardError
      socket.close unless socket.closed?
      raise
    end
  end

  def self.build_request(uri, key, headers, origin, protocols = nil)
    path = uri.request_uri
    lines = [
      "GET #{path} HTTP/1.1",
      "Host: #{uri.host}:#{uri.port || 80}",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: #{key}",
      "Sec-WebSocket-Version: 13",
      "Origin: #{origin}"
    ]
    lines << "Sec-WebSocket-Protocol: #{Array(protocols).join(', ')}" if Array(protocols).any?
    headers.each { |name, value| lines << "#{name}: #{value}" }
    "#{lines.join("\r\n")}\r\n\r\n"
  end

  # Reads the response head, verifies the upgrade really happened, and returns
  # `[status, headers, leftover_bytes]`. A rejected connection (a bad token, a
  # disallowed origin) comes back as a plain HTTP error, and that error text is
  # worth surfacing — it is the only diagnostic the server gives.
  def self.read_handshake(socket, key)
    buffer = +""
    buffer.force_encoding(Encoding::BINARY)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 15
    until buffer.include?("\r\n\r\n")
      remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
      raise HandshakeError, "no HTTP response within 15s" if remaining <= 0
      raise HandshakeError, "connection closed before the HTTP response" unless wait_readable(socket, remaining)

      begin
        buffer << socket.read_nonblock(4096)
      rescue IO::WaitReadable
        next
      rescue EOFError
        raise HandshakeError, "connection closed before the HTTP response"
      end
    end

    head, leftover = buffer.split("\r\n\r\n", 2)
    status_line = head.lines.first.to_s.strip
    status = status_line.split(/\s+/)[1].to_i
    headers = parse_handshake_headers(head.lines.drop(1))

    unless status == 101
      raise HandshakeError,
            "server refused the WebSocket upgrade with HTTP #{status}: #{summarize(head)}"
    end

    expected = Digest::SHA1.base64digest(key + GUID)
    actual = headers["sec-websocket-accept"]
    unless actual == expected
      raise HandshakeError,
            "Sec-WebSocket-Accept mismatch: server sent #{actual.inspect}, expected #{expected.inspect}"
    end

    [status, headers, leftover.to_s]
  end

  def self.parse_handshake_headers(lines)
    lines.each_with_object({}) do |line, out|
      name, value = line.split(":", 2)
      next if value.nil?

      out[name.strip.downcase] = value.strip
    end
  end

  def self.summarize(head)
    head.to_s.lines.drop(1).map(&:strip).reject(&:empty?).join(" | ")
  end

  def self.wait_readable(socket, seconds)
    !!IO.select([socket], nil, nil, seconds)
  end

  attr_reader :status, :negotiated_protocol

  def initialize(socket, handshake)
    @socket = socket
    @status = handshake[0]
    @negotiated_protocol = handshake[1]["sec-websocket-protocol"]
    @buffer = handshake[2].dup.force_encoding(Encoding::BINARY)
    @inbox = []
    @mutex = Mutex.new
    @closed = false
    @close_reason = nil
    start_reader
  end

  def closed?
    @closed
  end

  # The close code and reason the peer sent, once it has.
  def close_info
    @close_reason
  end

  def send_text(text)
    write_frame(OPCODE_TEXT, text.to_s.dup.force_encoding(Encoding::BINARY))
  end

  def send_ping(payload = "")
    write_frame(OPCODE_PING, payload.to_s.dup.force_encoding(Encoding::BINARY))
  end

  # Sends a close frame and shuts the socket down. Safe to call twice and safe
  # to call on an already-dead connection, so an `after` hook can be blunt.
  def close(code = 1000, reason = "")
    frame = [code].pack("n") + reason.to_s.dup.force_encoding(Encoding::BINARY)
    begin
      write_frame(OPCODE_CLOSE, frame)
    rescue StandardError
      nil
    end
    shutdown
  end

  # Yields the next complete text message, or returns false once the socket is
  # closed and the inbox is empty.
  #
  # `timeout` is a deadline, not a sleep: on expiry this raises
  # {TimeoutError} carrying `description`, so a broken expectation reports what
  # it was waiting for instead of hanging.
  def each_text(timeout: 5, description: "a WebSocket text frame")
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout

    loop do
      message = @mutex.synchronize { @inbox.shift }
      return message if message

      if @closed
        raise ConnectionClosed,
              "socket closed (#{@close_reason.inspect}) while waiting for #{description}"
      end

      remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
      raise TimeoutError, "timed out after #{timeout}s waiting for #{description}" if remaining <= 0

      # The reader thread is parked in `read_nonblock`; a short wait here just
      # avoids a hot spin while it is still assembling the frame.
      sleep 0.005
    end
  end

  private

  def start_reader
    @reader = Thread.new do
      begin
        read_loop
      rescue StandardError => e
        @close_reason ||= "#{e.class}: #{e.message}"
      ensure
        @mutex.synchronize { @closed = true }
        begin
          @socket.close unless @socket.closed?
        rescue StandardError
          nil
        end
      end
    end
    @reader.abort_on_exception = false
  end

  def read_loop
    fragments = +"".b
    fragment_opcode = nil

    loop do
      frame = read_frame
      case frame[:opcode]
      when OPCODE_PING
        write_frame(OPCODE_PONG, frame[:payload])
      when OPCODE_PONG
        nil
      when OPCODE_CLOSE
        @close_reason = frame[:payload].to_s
        begin
          write_frame(OPCODE_CLOSE, frame[:payload])
        rescue StandardError
          nil
        end
        break
      when OPCODE_TEXT, OPCODE_BINARY
        if frame[:fin]
          deliver(frame[:payload])
        else
          fragment_opcode = frame[:opcode]
          fragments = +"".b
          fragments << frame[:payload]
        end
      when OPCODE_CONTINUATION
        fragments << frame[:payload]
        if frame[:fin]
          deliver(fragments)
          fragments = +"".b
          fragment_opcode = nil
        end
      end
      # fragment_opcode only distinguishes text from binary; both arrive as
      # UTF-8 JSON documents here, so they share one path.
      _ = fragment_opcode
    end
  end

  def deliver(payload)
    @mutex.synchronize { @inbox << payload.dup.force_encoding(Encoding::UTF_8) }
  end

  def read_frame
    b0 = read_exactly(1).getbyte(0)
    b1 = read_exactly(1).getbyte(0)

    fin = b0.anybits?(0x80)
    opcode = b0 & 0x0F
    masked = b1.anybits?(0x80)
    length = b1 & 0x7F

    length = read_exactly(2).unpack1("n") if length == 126
    length = read_exactly(8).unpack1("Q>") if length == 127
    raise HandshakeError, "frame of #{length} bytes exceeds the #{MAX_PAYLOAD} cap" if length > MAX_PAYLOAD

    mask = masked ? read_exactly(4) : nil
    payload = length.zero? ? +"".b : read_exactly(length)
    payload = apply_mask(payload, mask) if mask

    { fin: fin, opcode: opcode, payload: payload }
  end

  def read_exactly(count)
    while @buffer.bytesize < count
      # `read_more` returns nil both for "nothing yet" and for "peer gone", so
      # only an actual EOF raises; an idle socket just keeps waiting.
      chunk = read_more
      raise ConnectionClosed, "socket closed mid-frame" if chunk == :eof

      @buffer << chunk if chunk
    end

    @buffer.slice!(0, count)
  end

  # Blocks until bytes arrive, the peer closes, or the socket dies.
  #
  # A quiet socket is not a closed one: the cable is idle between heartbeats
  # and while nobody is talking, and treating that as EOF would tear the
  # connection down mid-match. Returns nil for "nothing yet" and `:eof` only
  # when the peer really is gone.
  def read_more
    return :eof if @socket.closed?
    return nil unless self.class.wait_readable(@socket, 1.0)

    begin
      @socket.read_nonblock(65_536)
    rescue IO::WaitReadable
      nil
    rescue EOFError, IOError, SystemCallError
      :eof
    end
  end

  def apply_mask(payload, mask)
    key = mask.unpack("C4")
    out = payload.dup
    i = 0
    size = out.bytesize
    while i < size
      out.setbyte(i, out.getbyte(i) ^ key[i % 4])
      i += 1
    end
    out
  end

  def write_frame(opcode, payload)
    return if @socket.closed?

    mask = SecureRandom.random_bytes(4)
    size = payload.bytesize
    header = +"".b
    header << (0x80 | opcode).chr
    if size < 126
      header << (0x80 | size).chr
    elsif size <= 0xFFFF
      header << (0x80 | 126).chr
      header << [size].pack("n")
    else
      header << (0x80 | 127).chr
      header << [size].pack("Q>")
    end
    header << mask << apply_mask(payload, mask)

    @write_lock ||= Mutex.new
    @write_lock.synchronize { @socket.write(header) }
  end

  def shutdown
    @mutex.synchronize { @closed = true }
    begin
      @socket.close unless @socket.closed?
    rescue StandardError
      nil
    end
    @reader&.join(2)
    @reader&.kill if @reader&.alive?
  end
end
