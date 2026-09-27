/**
 * The cable framing is hand-written and dependency-free, which makes it the
 * single most likely place for a subtle bug: a document reassembled wrongly, a
 * payload routed to the wrong subscription, a `welcome` assumed when the
 * socket merely opened. All of those show up as a client that connects and
 * then silently receives nothing, so the fake socket below drives the
 * transport end to end rather than poking at the reader alone.
 *
 * The protocol is ActionCable's native JSON one (actioncable-8.1.4 has no
 * STOMP support): `{"type":"welcome"}` opens the connection, channels are
 * addressed by a JSON-encoded `identifier`, and a server payload arrives on
 * `{identifier, message}`.
 */
import { describe, expect, it } from "vitest";
import {
  CableMessageReader,
  CableTransport,
  cableUrl,
  channelIdentifier,
  gameParams,
  lobbyParams,
} from "./transport";
import type { CableFrame } from "./transport";
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

  constructor(readonly url: string) {
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

  /** The TCP upgrade, which is not the connection. */
  upgrade(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(text: string): void {
    this.onmessage?.({ data: text });
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  /** Everything the client wrote, decoded. */
  written(): Record<string, unknown>[] {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  }
}

function makeTransport(options: { heartbeatMs?: number } = {}) {
  FakeWebSocket.last = null;
  const transport = new CableTransport({
    heartbeatMs: options.heartbeatMs ?? 0,
    socketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
  });
  return { transport, socket: () => FakeWebSocket.last as unknown as FakeWebSocket };
}

/** A connected transport whose socket has already been welcomed. */
async function connected(options: { heartbeatMs?: number } = {}) {
  const { transport, socket } = makeTransport(options);
  const states: string[] = [];
  transport.onStateChange((s) => states.push(s));
  const connectedPromise = transport.connect(URL, TOKEN);
  const ws = socket();
  ws.upgrade();
  ws.receive(JSON.stringify({ type: "welcome" }));
  await connectedPromise;
  return { transport, ws, states };
}

const LOBBY_ID = channelIdentifier(lobbyParams());
const GAME_ID = channelIdentifier(gameParams(12));

function payload(body: ServerMessage, identifier = LOBBY_ID): string {
  return JSON.stringify({ identifier, message: JSON.stringify(body) });
}

describe("cable url", () => {
  it("carries the session token the connection authenticates from", () => {
    expect(cableUrl(URL, TOKEN)).toBe(`${URL}?token=session-token`);
  });

  it("appends to an existing query and escapes the token", () => {
    expect(cableUrl(`${URL}?x=1`, "a b&c")).toBe(`${URL}?x=1&token=a%20b%26c`);
  });

  it("omits the parameter when there is no token", () => {
    expect(cableUrl(URL, "")).toBe(URL);
  });
});

describe("cable message reader", () => {
  it("reassembles a document delivered in pieces", () => {
    const reader = new CableMessageReader();
    expect(reader.push('{"type":"wel')).toEqual([]);
    expect(reader.push('come"}')).toEqual([{ type: "welcome" }]);
  });

  it("splits several documents in one read", () => {
    const reader = new CableMessageReader();
    expect(reader.push('{"type":"ping"}{"type":"welcome"}')).toEqual([
      { type: "ping" },
      { type: "welcome" },
    ]);
  });

  it("is not fooled by braces inside a payload string", () => {
    const reader = new CableMessageReader();
    const frame = reader.push('{"identifier":"a","message":"{\\"v\\":1}"}')[0];
    expect(frame.identifier).toBe("a");
  });

  it("reports how much is still waiting", () => {
    const reader = new CableMessageReader();
    reader.push('{"type":"wel');
    expect(reader.pending).toBeGreaterThan(0);
    reader.reset();
    expect(reader.pending).toBe(0);
  });

  it("drops text that is not a document rather than throwing", () => {
    const reader = new CableMessageReader();
    expect(reader.push("not json at all")).toEqual([]);
  });
});

describe("handshake", () => {
  it("is connected on welcome, not on the socket upgrade", async () => {
    const { transport, socket } = makeTransport();
    const states: string[] = [];
    transport.onStateChange((s) => states.push(s));
    let resolved = false;
    const connectedPromise = transport.connect(URL, TOKEN).then(() => {
      resolved = true;
    });
    const ws = socket();
    ws.upgrade();
    await Promise.resolve();
    expect(transport.state).toBe("connecting");
    expect(resolved).toBe(false);
    expect(states).toEqual(["connecting"]);

    ws.receive(JSON.stringify({ type: "welcome" }));
    await connectedPromise;
    expect(transport.state).toBe("connected");
    expect(states).toEqual(["connecting", "connected"]);
  });

  it("connects to the tokenised url and never requests a subprotocol", async () => {
    const { transport, socket } = makeTransport();
    const promise = transport.connect(URL, TOKEN);
    const ws = socket();
    ws.upgrade();
    ws.receive(JSON.stringify({ type: "welcome" }));
    await promise;
    expect(ws.url).toBe(`${URL}?token=session-token`);
  });

  it("rejects when the socket dies before welcome", async () => {
    const { transport, socket } = makeTransport();
    const promise = transport.connect(URL, TOKEN);
    socket().drop();
    await expect(promise).rejects.toThrow(/before welcome/);
  });
});

describe("subscribing", () => {
  it("queues the subscribe until welcome and preserves order", async () => {
    const { transport, socket } = makeTransport();
    void transport.connect(URL, TOKEN);
    const ws = socket();
    ws.upgrade();
    transport.subscribe(lobbyParams());
    transport.subscribe(gameParams(12));
    // Nothing may precede welcome: ActionCable drops it.
    expect(ws.sent).toHaveLength(0);
    ws.receive(JSON.stringify({ type: "welcome" }));
    expect(ws.written()).toEqual([
      { command: "subscribe", identifier: LOBBY_ID },
      { command: "subscribe", identifier: GAME_ID },
    ]);
  });

  it("addressed the channel by a JSON-encoded identifier", async () => {
    const { ws } = await connected();
    expect(JSON.parse(LOBBY_ID)).toEqual({ channel: "LobbyChannel" });
    expect(JSON.parse(GAME_ID)).toEqual({ channel: "GameChannel", match_id: 12 });
    expect(ws.written()).toHaveLength(0);
  });

  it("confirms a subscription and reports the round trip", async () => {
    const { transport, ws } = await connected();
    const receipts: { id: string; sentAtMs: number; receivedAtMs: number }[] = [];
    transport.onReceipt((id, sentAtMs, receivedAtMs) => receipts.push({ id, sentAtMs, receivedAtMs }));
    transport.subscribe(lobbyParams());
    const sentAt = Date.now();
    ws.receive(JSON.stringify({ type: "confirm_subscription", identifier: LOBBY_ID }));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].id).toBe(LOBBY_ID);
    expect(receipts[0].sentAtMs).toBeGreaterThanOrEqual(sentAt);
    expect(receipts[0].receivedAtMs).toBeGreaterThanOrEqual(receipts[0].sentAtMs);
  });

  it("reports a rejected subscription as an error and forgets it", async () => {
    const { transport, ws } = await connected();
    const errors: string[] = [];
    transport.onError((err) => errors.push(err.message));
    transport.subscribe(gameParams(99));
    ws.receive(JSON.stringify({ type: "rejection", identifier: channelIdentifier(gameParams(99)) }));
    expect(errors[0]).toMatch(/rejected/);
    // A rejected subscription drops whatever was held for it.
    transport.send({ v: 1, t: "game:command", id: "b1", from_tick: 1, commands: [] });
    expect(ws.written().map((f) => f.command)).not.toContain("message");
  });

  it("unsubscribes by identifier", async () => {
    const { transport, ws } = await connected();
    transport.subscribe(lobbyParams());
    transport.unsubscribe(lobbyParams());
    expect(ws.written().at(-1)).toEqual({ command: "unsubscribe", identifier: LOBBY_ID });
  });
});

describe("sending", () => {
  it("routes lobby traffic to the lobby channel as a string payload", async () => {
    const { transport, ws } = await connected();
    transport.subscribe(lobbyParams());
    ws.receive(JSON.stringify({ type: "confirm_subscription", identifier: LOBBY_ID }));
    transport.send({ v: 1, t: "lobby:list" });
    const frame = ws.written().at(-1) as { command: string; identifier: string; data: string };
    expect(frame.command).toBe("message");
    expect(frame.identifier).toBe(LOBBY_ID);
    // ActionCable parses `data` as a string, never as an embedded object.
    expect(typeof frame.data).toBe("string");
    expect(JSON.parse(frame.data)).toEqual({ v: 1, t: "lobby:list" });
  });

  it("routes gameplay traffic to the game channel", async () => {
    const { transport, ws } = await connected();
    transport.subscribe(gameParams(12));
    ws.receive(JSON.stringify({ type: "confirm_subscription", identifier: GAME_ID }));
    transport.send({ v: 1, t: "game:command", id: "b1", from_tick: 840, commands: [] });
    const frame = ws.written().at(-1) as { identifier: string; data: string };
    expect(frame.identifier).toBe(GAME_ID);
    expect(JSON.parse(frame.data).t).toBe("game:command");
  });

  it("sends identify on the game channel with the token", async () => {
    const { transport, ws } = await connected();
    transport.subscribe(lobbyParams());
    transport.subscribe(gameParams(12));
    transport.identify();
    // Held until the subscription is live: the server registers a
    // subscription asynchronously relative to our write.
    expect(ws.sent).toHaveLength(2);
    ws.receive(JSON.stringify({ type: "confirm_subscription", identifier: GAME_ID }));
    const frame = ws.written().at(-1) as { identifier: string; data: string };
    expect(frame.identifier).toBe(GAME_ID);
    expect(JSON.parse(frame.data)).toEqual({ v: 1, t: "identify", token: TOKEN });
  });

  it("holds a message until the subscription is confirmed", async () => {
    const { transport, ws } = await connected();
    transport.subscribe(gameParams(12));
    transport.send({ v: 1, t: "game:command", id: "b1", from_tick: 840, commands: [] });
    // The server registers a subscription asynchronously relative to our write,
    // and refuses a message that beats it: only the subscribe is on the wire.
    expect(ws.written().map((f) => f.command)).toEqual(["subscribe"]);
    ws.receive(JSON.stringify({ type: "confirm_subscription", identifier: GAME_ID }));
    const frame = ws.written().at(-1) as { command: string; data: string };
    expect(frame.command).toBe("message");
    expect(JSON.parse(frame.data).id).toBe("b1");
  });

  it("queues a message issued before welcome", async () => {
    const { transport, socket } = makeTransport();
    void transport.connect(URL, TOKEN);
    transport.subscribe(lobbyParams());
    const ws = socket();
    ws.upgrade();
    transport.send({ v: 1, t: "lobby:list" });
    expect(ws.sent).toHaveLength(0);
    ws.receive(JSON.stringify({ type: "welcome" }));
    expect(ws.written().map((f) => f.command)).toEqual(["subscribe"]);
    ws.receive(JSON.stringify({ type: "confirm_subscription", identifier: LOBBY_ID }));
    expect(ws.written().map((f) => f.command)).toEqual(["subscribe", "message"]);
  });

  it("reports sending on a channel that was never subscribed", async () => {
    const { transport } = await connected();
    const errors: string[] = [];
    transport.onError((err) => errors.push(err.message));
    transport.send({ v: 1, t: "game:command", id: "b1", from_tick: 1, commands: [] });
    expect(errors[0]).toMatch(/no game subscription/);
  });
});

describe("receiving", () => {
  it("delivers a payload to handlers", async () => {
    const { transport, ws } = await connected();
    transport.subscribe(lobbyParams());
    const seen: ServerMessage[] = [];
    transport.onMessage((m) => seen.push(m));
    ws.receive(payload({ v: 1, t: "lobby:state", matches: [], you: null }));
    expect(seen).toHaveLength(1);
    expect(seen[0].t).toBe("lobby:state");
  });

  it("accepts a payload that arrives already decoded", async () => {
    const { transport, ws } = await connected();
    transport.subscribe(lobbyParams());
    const seen: ServerMessage[] = [];
    transport.onMessage((m) => seen.push(m));
    ws.receive(JSON.stringify({ identifier: LOBBY_ID, message: { v: 1, t: "lobby:state", matches: [], you: null } }));
    expect(seen[0].t).toBe("lobby:state");
  });

  it("routes a frame to the subscription that owns its identifier", async () => {
    const { transport, ws } = await connected();
    transport.subscribe(lobbyParams());
    transport.subscribe(gameParams(12));
    const seen: ServerMessage[] = [];
    transport.onMessage((m) => seen.push(m));
    ws.receive(payload({ v: 1, t: "lobby:state", matches: [], you: null }, LOBBY_ID));
    ws.receive(
      payload({ v: 1, t: "game:snapshot", tick: 1, server_ms: 0, ack: 0, entities: [], events: [] }, GAME_ID),
    );
    expect(seen.map((m) => m.t)).toEqual(["lobby:state", "game:snapshot"]);
  });

  it("ignores a frame for an identifier we do not hold", async () => {
    const { transport, ws } = await connected();
    transport.subscribe(lobbyParams());
    const seen: ServerMessage[] = [];
    const errors: string[] = [];
    transport.onMessage((m) => seen.push(m));
    transport.onError((err) => errors.push(err.message));
    ws.receive(payload({ v: 1, t: "game:snapshot", tick: 1, server_ms: 0, ack: 0, entities: [], events: [] }, GAME_ID));
    expect(seen).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("reports an unparsable payload as a protocol error", async () => {
    const { transport, ws } = await connected();
    transport.subscribe(lobbyParams());
    const errors: string[] = [];
    transport.onError((err) => errors.push(err.message));
    ws.receive(JSON.stringify({ identifier: LOBBY_ID, message: "{not json" }));
    expect(errors[0]).toMatch(/unsupported protocol message/);
  });

  it("treats ping as liveness and answers nothing", async () => {
    const { transport, ws } = await connected();
    const before = transport.lastActivity();
    ws.receive(JSON.stringify({ type: "ping", message: 1712345678901 }));
    expect(ws.sent).toHaveLength(0);
    expect(transport.lastActivity()).toBeGreaterThanOrEqual(before);
  });

  it("reassembles a payload split across socket reads", async () => {
    const { transport, ws } = await connected();
    transport.subscribe(lobbyParams());
    const seen: ServerMessage[] = [];
    transport.onMessage((m) => seen.push(m));
    const frame = payload({ v: 1, t: "lobby:state", matches: [], you: null });
    ws.receive(frame.slice(0, 20));
    expect(seen).toHaveLength(0);
    ws.receive(frame.slice(20));
    expect(seen[0].t).toBe("lobby:state");
  });
});

describe("server-requested close", () => {
  it("is terminal when reconnect is false", async () => {
    const { transport, ws } = await connected();
    const disconnects: { reason: string; reconnect: boolean }[] = [];
    transport.onDisconnect((info) => disconnects.push(info));
    ws.receive(JSON.stringify({ type: "disconnect", reason: "unauthorized", reconnect: false }));
    expect(disconnects).toEqual([{ reason: "unauthorized", reconnect: false }]);
    expect(transport.terminated).toBe(true);
    expect(transport.state).toBe("closed");
  });

  it("stays retryable when the server allows a reconnect", async () => {
    const { transport, ws } = await connected();
    const disconnects: ServerDisconnectLike[] = [];
    transport.onDisconnect((info) => disconnects.push(info));
    ws.receive(JSON.stringify({ type: "disconnect", reason: "server_restart", reconnect: true }));
    expect(disconnects[0].reconnect).toBe(true);
    expect(transport.terminated).toBe(false);
  });
});

type ServerDisconnectLike = { reason: string; reconnect: boolean };

describe("lifecycle", () => {
  it("goes to reconnecting when an established connection drops", async () => {
    const { transport, ws } = await connected();
    transport.subscribe(lobbyParams());
    ws.drop();
    expect(transport.state).toBe("reconnecting");
  });

  it("goes to closed when the client closes", async () => {
    const { transport } = await connected();
    transport.close();
    expect(transport.state).toBe("closed");
    expect(transport.terminated).toBe(false);
  });

  it("forgets its subscriptions on close so a resubscribe is clean", async () => {
    const { transport, socket } = makeTransport();
    void transport.connect(URL, TOKEN);
    socket().upgrade();
    socket().receive(JSON.stringify({ type: "welcome" }));
    transport.subscribe(lobbyParams());
    transport.close();

    const promise = transport.connect(URL, TOKEN);
    const fresh = socket();
    fresh.upgrade();
    fresh.receive(JSON.stringify({ type: "welcome" }));
    await promise;
    // Nothing is replayed onto the new socket: the old subscriptions are gone
    // rather than silently resurrected, so the caller re-subscribes explicitly.
    expect(fresh.sent).toHaveLength(0);
  });
});

describe("frame shape", () => {
  it("decodes the documented server frame kinds", () => {
    const reader = new CableMessageReader();
    const frames: CableFrame[] = reader.push(
      [
        '{"type":"welcome"}',
        '{"type":"ping","message":1712345678901}',
        '{"type":"confirm_subscription","identifier":"{\\"channel\\":\\"LobbyChannel\\"}"}',
        '{"type":"rejection","identifier":"x"}',
        '{"type":"disconnect","reason":"unauthorized","reconnect":false}',
        '{"identifier":"i","message":"{}"}',
      ].join(""),
    );
    // A payload frame carries no `type`: that is what makes it a payload.
    expect(frames.map((f) => f.type)).toEqual([
      "welcome",
      "ping",
      "confirm_subscription",
      "rejection",
      "disconnect",
      undefined,
    ]);
    expect(frames[1].message).toBe(1712345678901);
    expect(frames[4].reconnect).toBe(false);
  });
});
