/**
 * The STOMP framing is hand-written and dependency-free, which makes it the
 * single most likely place for a subtle bug: partial reads reassembled wrongly,
 * a header value that swallows its own separator, a heart-beat mistaken for a
 * message. All of those show up as a client that connects and then silently
 * receives nothing, so the fake socket below drives the transport end to end
 * rather than poking at the parser alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeStompFrame,
  gameChannelFor,
  isLobbyChannel,
  LOBBY_CHANNEL,
  StompFrameParser,
  StompTransport,
} from "./transport";
import type { StompFrame } from "./transport";
import type { ServerMessage } from "@shared/protocol";

const URL = "wss://cable.example.test/cable";
const TOKEN = "session-token";

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.last = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  /* -------------------------------------------------- test-side controls */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(text: string): void {
    this.onmessage?.({ data: text });
  }
  get sentText(): string {
    return this.sent.join("");
  }
}

/**
 * Decodes what the transport wrote. Client frames escape `:` inside header
 * values, so asserting on the raw text would pin the escaping rather than the
 * routing.
 */
function sentFrames(ws: FakeWebSocket): StompFrame[] {
  return new StompFrameParser().push(ws.sentText);
}

function sentDestinations(ws: FakeWebSocket): (string | undefined)[] {
  return sentFrames(ws).map((frame) => frame.headers.get("destination"));
}

const RealWebSocket = globalThis.WebSocket;

function socket(): FakeWebSocket {
  const ws = FakeWebSocket.last;
  if (!ws) throw new Error("no socket was created");
  return ws;
}

const SNAPSHOT_BODY = JSON.stringify({
  v: 1,
  t: "game:snapshot",
  tick: 7,
  server_ms: 1_700_000_000_000,
  ack: 6,
  entities: [],
  events: [],
});

function messageFrame(body: string, destination: string, subscription: string): string {
  return encodeStompFrame(
    "MESSAGE",
    { destination, subscription, "content-type": "application/json;charset=utf-8" },
    body,
  );
}

/** Drives a transport from construction to `connected`. */
async function handshake(transport: StompTransport): Promise<FakeWebSocket> {
  const settled = transport.connect(URL, TOKEN);
  const ws = socket();
  ws.open();
  ws.receive(encodeStompFrame("CONNECTED", { version: "1.2", session: "s-1" }));
  await settled;
  return ws;
}

describe("StompTransport", () => {
  let transport: StompTransport;

  beforeEach(() => {
    FakeWebSocket.last = null;
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    transport = new StompTransport({ heartbeatMs: 0 });
  });

  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = RealWebSocket;
  });

  it("reaches connected only after CONNECTED, and accepts STOMP 1.2", async () => {
    const states: string[] = [];
    transport.onStateChange((s) => states.push(s));

    const settled = transport.connect(URL, TOKEN);
    expect(transport.state).toBe("connecting");
    const ws = socket();
    ws.open();
    ws.receive(encodeStompFrame("CONNECTED", { version: "1.2" }));
    await settled;

    expect(transport.state).toBe("connected");
    // A server that answers with 1.0 or 1.1 never reaches this state.
    expect(ws.sentText).toContain("accept-version:1.2");
    expect(ws.sentText).toContain("host:cable.example.test");
    expect(states).toEqual(["connecting", "connected"]);
  });

  it("delivers a MESSAGE for the subscribed channel to the message handler", async () => {
    const seen: ServerMessage[] = [];
    transport.onMessage((m) => seen.push(m));
    const ws = await handshake(transport);
    const channel = gameChannelFor(12);
    transport.subscribe(channel);

    ws.receive(messageFrame(SNAPSHOT_BODY, channel, "sub-1"));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ t: "game:snapshot", tick: 7 });
  });

  it("replays frames issued before the socket opened, in order", async () => {
    // The lobby client subscribes and identifies as soon as it is constructed,
    // which is before CONNECTED arrives on a slow link.
    transport.subscribe(LOBBY_CHANNEL);
    transport.subscribe(gameChannelFor(3));
    transport.identify(gameChannelFor(3));

    const ws = await handshake(transport);
    const commands = sentFrames(ws).map((frame) => frame.command);

    expect(commands[0]).toBe("CONNECT");
    // SUBSCRIBE must precede every SEND or the server drops the connection.
    expect(commands.indexOf("SUBSCRIBE")).toBeGreaterThan(0);
    expect(commands.indexOf("SUBSCRIBE")).toBeLessThan(commands.indexOf("SEND"));
    expect(sentDestinations(ws)).toContain(gameChannelFor(3));
    expect(transport.state).toBe("connected");
  });

  it("parses a CRLF frame whose body length is declared", async () => {
    const seen: ServerMessage[] = [];
    transport.onMessage((m) => seen.push(m));
    const ws = await handshake(transport);
    const channel = gameChannelFor(1);
    transport.subscribe(channel);

    // Hand-built so the CRLF line endings and the explicit content-length are
    // exactly what a real ActionCable server emits.
    const frame =
      `MESSAGE\r\ndestination:${channel}\r\nsubscription:sub-1\r\n` +
      `content-type:application/json;charset=utf-8\r\ncontent-length:${SNAPSHOT_BODY.length}\r\n\r\n` +
      `${SNAPSHOT_BODY}\0`;
    ws.receive(frame);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ t: "game:snapshot" });
  });

  it("unescapes a header value that contains a colon", async () => {
    const receipts: string[] = [];
    transport.onReceipt((id) => receipts.push(id));
    const ws = await handshake(transport);

    // Server-generated ids embed a colon; the header separator is the first
    // *unescaped* one, so a naive split corrupts the id.
    ws.receive(encodeStompFrame("RECEIPT", { "receipt-id": "cmd-7:14" }));

    expect(receipts).toEqual(["cmd-7:14"]);
  });

  it("answers a heart-beat with a bare EOL and never treats it as a message", async () => {
    const handler = vi.fn();
    transport.onMessage(handler);
    const ws = await handshake(transport);
    ws.sent.length = 0;

    ws.receive("\n");

    // Failing to answer drops the connection; treating it as a message floods
    // the protocol handlers with an empty body.
    expect(ws.sent).toEqual(["\n"]);
    expect(handler).not.toHaveBeenCalled();
    expect(transport.state).toBe("connected");
  });

  it("reassembles a frame split across several chunks", async () => {
    const seen: ServerMessage[] = [];
    transport.onMessage((m) => seen.push(m));
    const ws = await handshake(transport);
    const channel = gameChannelFor(4);
    transport.subscribe(channel);

    const frame = messageFrame(SNAPSHOT_BODY, channel, "sub-1");
    const third = Math.floor(frame.length / 3);
    ws.receive(frame.slice(0, third));
    ws.receive(frame.slice(third, third * 2));
    expect(seen).toHaveLength(0); // an incomplete frame delivers nothing

    ws.receive(frame.slice(third * 2));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ t: "game:snapshot", tick: 7 });
  });

  it("splits a frame at every byte boundary and still delivers it once", async () => {
    const seen: ServerMessage[] = [];
    transport.onMessage((m) => seen.push(m));
    const ws = await handshake(transport);
    const channel = gameChannelFor(5);
    transport.subscribe(channel);
    const frame = messageFrame(SNAPSHOT_BODY, channel, "sub-1");

    for (const char of frame) ws.receive(char);

    // A body containing a NUL-adjacent byte or a split header is exactly the
    // case a one-chunk-at-a-time fake would never catch.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ t: "game:snapshot" });
  });

  it("delivers two frames that arrive in a single chunk", async () => {
    const seen: ServerMessage[] = [];
    transport.onMessage((m) => seen.push(m));
    const ws = await handshake(transport);
    const channel = gameChannelFor(6);
    transport.subscribe(channel);

    const other = JSON.stringify({ v: 1, t: "game:reject", rejected: [] });
    ws.receive(messageFrame(SNAPSHOT_BODY, channel, "sub-1") + messageFrame(other, channel, "sub-1"));

    // Keeping only the first frame of a coalesced read is the classic partial
    // read bug: the second message is silently lost.
    expect(seen.map((m) => m.t)).toEqual(["game:snapshot", "game:reject"]);
  });

  it("reports a malformed body as an error instead of throwing", async () => {
    const errors: string[] = [];
    transport.onError((e) => errors.push(e.message));
    const handler = vi.fn();
    transport.onMessage(handler);
    const ws = await handshake(transport);
    const channel = gameChannelFor(7);
    transport.subscribe(channel);

    ws.receive(messageFrame("{not json", channel, "sub-1"));

    expect(errors).toEqual(["malformed message body"]);
    expect(handler).not.toHaveBeenCalled();
    // One bad frame must not wedge the socket for every message after it.
    expect(transport.state).toBe("connected");
    ws.receive(messageFrame(SNAPSHOT_BODY, channel, "sub-1"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects a payload that is not a protocol envelope", async () => {
    const errors: string[] = [];
    transport.onError((e) => errors.push(e.message));
    const handler = vi.fn();
    transport.onMessage(handler);
    const ws = await handshake(transport);
    const channel = gameChannelFor(8);
    transport.subscribe(channel);

    // No `v`, so it is not a v1 message; handing it on would poison every
    // downstream switch on `t`.
    ws.receive(messageFrame(JSON.stringify({ t: "game:snapshot" }), channel, "sub-1"));

    expect(errors[0]).toContain("game:snapshot");
    expect(handler).not.toHaveBeenCalled();
  });

  it("routes a protocol message to the lobby channel and the rest to the match", async () => {
    const ws = await handshake(transport);
    transport.subscribe(gameChannelFor(9));

    transport.send({ v: 1, t: "lobby:ready", match_id: 9, ready: true });
    transport.send({ v: 1, t: "identify", token: TOKEN });

    // Misrouted traffic is silently dropped by the server, so the client just
    // looks disconnected.
    const sent = sentFrames(ws).filter((frame) => frame.command === "SEND");
    expect(sent.map((frame) => frame.headers.get("destination"))).toEqual([
      LOBBY_CHANNEL,
      gameChannelFor(9),
    ]);
    expect(sent[0]!.body).toContain("lobby:ready");
    expect(sent[1]!.body).toContain("identify");
  });

  it("refuses to send a match message with no match channel subscribed", async () => {
    const errors: string[] = [];
    transport.onError((e) => errors.push(e.message));
    const ws = await handshake(transport);

    transport.send({ v: 1, t: "game:forfeit" });

    expect(errors[0]).toContain("no game channel");
    expect(ws.sentText).not.toContain("game:forfeit");
  });

  it("closes gracefully on the server's receipt for DISCONNECT", async () => {
    const ws = await handshake(transport);
    transport.subscribe(gameChannelFor(10));

    transport.close();
    const goodbye = sentFrames(ws).find((frame) => frame.command === "DISCONNECT");
    expect(goodbye?.headers.get("receipt")).toBeTruthy();

    ws.receive(encodeStompFrame("RECEIPT", { "receipt-id": goodbye!.headers.get("receipt")! }));

    expect(transport.state).toBe("closed");
    expect(ws.readyState).toBe(3);
  });

  it("stops accepting frames once closed", async () => {
    const ws = await handshake(transport);
    transport.subscribe(gameChannelFor(11));
    transport.close();
    const goodbye = sentFrames(ws).find((frame) => frame.command === "DISCONNECT")!;
    ws.receive(encodeStompFrame("RECEIPT", { "receipt-id": goodbye.headers.get("receipt")! }));

    transport.send({ v: 1, t: "game:forfeit" });
    // A frame written after close is discarded by the server with no error.
    expect(ws.sentText).not.toContain("game:forfeit");
    expect(transport.state).toBe("closed");
  });

  it("bounds the graceful close so a silent server cannot wedge the client", async () => {
    vi.useFakeTimers();
    try {
      const ws = await handshake(transport);
      transport.close();
      // STOMP says wait for the receipt, but not forever.
      vi.advanceTimersByTime(5_000);
      expect(transport.state).toBe("closed");
      expect(ws.readyState).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves to reconnecting when the socket drops without being asked to", async () => {
    const states: string[] = [];
    await handshake(transport);
    transport.onStateChange((s) => states.push(s));

    socket().close();

    // `closed` here would make the reconnect controller give up immediately.
    expect(transport.state).toBe("reconnecting");
    expect(states).toEqual(["reconnecting"]);
  });

  it("rejects connect() when the socket dies before the handshake finishes", async () => {
    const settled = transport.connect(URL, TOKEN);
    const ws = socket();
    ws.open();
    ws.close();
    await expect(settled).rejects.toThrow(/closed before the STOMP handshake/);
  });

  it("maps match ids to the game channel and leaves the lobby alone", () => {
    expect(gameChannelFor(42)).toBe("game:42");
    expect(isLobbyChannel(LOBBY_CHANNEL)).toBe(true);
    expect(isLobbyChannel("game:42")).toBe(false);
  });
});
