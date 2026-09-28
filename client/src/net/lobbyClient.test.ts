/**
 * Regression tests for the lobby channel's subscription lifetime.
 *
 * The bug these pin: `CableTransport` clears its entire subscription set when
 * a socket closes — the server forgets them too, so they are re-sent on the
 * next welcome. `LobbyClient` guarded `subscribe()` with a `subscribed` flag
 * that was only cleared by `dispose()`, so after any close/reconnect cycle the
 * flag said "already subscribed" while the transport held no lobby
 * subscription at all, and every `lobby:*` message failed with
 * "no lobby subscription for lobby:list".
 *
 * Found by driving the real app: reload the page while the cable is cycling and
 * the match browser goes permanently deaf. A test that only ever connects once
 * cannot see it.
 */
import { describe, expect, it } from "vitest";
import { LOBBY_CHAT_MAX_LENGTH, LobbyClient } from "./lobbyClient";
import type { LobbyClientOptions, LobbyState } from "./lobbyClient";
import { PROTOCOL_VERSION } from "@shared/protocol";
import type { ClientMessage, LobbyChatLine, ServerMessage } from "@shared/protocol";
import { CableTransport, channelIdentifier, lobbyParams } from "./transport";
import type { ChannelTransport, ChannelParams, TransportState } from "./transport";

/**
 * The fake the tests drive, with the channels a real `CableTransport` exposes
 * plus the levers a test needs: forcing a state, dropping the connection the
 * way a real socket drop does, and reopening it.
 */
interface FakeTransport extends ChannelTransport {
  /** The real `Transport` surface, unused by these tests. */
  readonly state: TransportState;
  connect(url: string, token: string): Promise<void>;
  close(): void;
  setState(next: TransportState): void;
  /** The socket dropped: the transport forgets its subscriptions. */
  dropConnection(): void;
  /** A fresh connection: the server has forgotten everything. */
  reopen(): void;
  /** Whether the transport currently holds a lobby subscription. */
  hasLobbySubscription: boolean;
  sent: string[];
  subscribed: ChannelParams[];
}

function fakeTransport(): FakeTransport {
  const stateHandlers: ((s: TransportState) => void)[] = [];
  let currentState: TransportState = "idle";
  const sent: string[] = [];
  const subscribed: ChannelParams[] = [];
  const transport: FakeTransport = {
    sent,
    subscribed,
    hasLobbySubscription: true,
    setState(next: TransportState): void {
      currentState = next;
      for (const handler of [...stateHandlers]) handler(next);
    },
    dropConnection(): void {
      transport.hasLobbySubscription = false;
      transport.setState("closed");
    },
    reopen(): void {
      transport.hasLobbySubscription = true;
      transport.setState("connected");
    },
    subscribe(params: ChannelParams): string {
      subscribed.push(params);
      return channelIdentifier(params);
    },
    unsubscribe(): void {},
    identify(): void {},
    onError(): void {},
    onReceipt(): void {},
    onMessage(): void {},
    onStateChange(handler: (s: TransportState) => void): void {
      stateHandlers.push(handler);
    },
    lastActivity: () => Date.now(),
    onDisconnect(): void {},
    get state(): TransportState {
      return currentState;
    },
    connect(): Promise<void> {
      return Promise.resolve();
    },
    close(): void {
      transport.dropConnection();
    },
    get connected(): boolean {
      return transport.hasLobbySubscription;
    },
    send(message: unknown): void {
      sent.push(JSON.stringify(message));
    },
  };
  return transport;
}

const lobbySubs = (t: FakeTransport): ChannelParams[] => t.subscribed.filter((p) => p.channel === "LobbyChannel");

describe("LobbyClient subscription lifetime", () => {
  it("subscribes on connect", () => {
    const transport = fakeTransport();
    new LobbyClient({ transport });
    transport.setState("connected");
    expect(transport.subscribed).toContainEqual(lobbyParams());
  });

  it("does not subscribe twice while the connection is live", () => {
    const transport = fakeTransport();
    const lobby = new LobbyClient({ transport });
    transport.setState("connected");
    transport.setState("connected");
    lobby.subscribe();
    expect(lobbySubs(transport)).toHaveLength(1);
  });

  it("re-subscribes after the socket drops, instead of caching a stale flag", () => {
    const transport = fakeTransport();
    const lobby = new LobbyClient({ transport });

    transport.setState("connected");
    expect(lobbySubs(transport)).toHaveLength(1);

    // The transport forgets its subscriptions when the socket closes.
    transport.dropConnection();
    expect(transport.hasLobbySubscription).toBe(false);

    // A new connection. Without the fix the `subscribed` guard made
    // subscribe() a no-op, and the client could never use the lobby again.
    transport.reopen();
    expect(() => lobby.list()).not.toThrow();
    expect(lobbySubs(transport)).toHaveLength(2);
  });

  it("survives repeated close/reopen cycles", () => {
    const transport = fakeTransport();
    new LobbyClient({ transport });

    for (let i = 0; i < 5; i++) {
      transport.setState("connected");
      transport.dropConnection();
    }
    transport.reopen();
    expect(lobbySubs(transport)).toHaveLength(6);
  });

  it("treats a reconnect as needing a fresh subscription too", () => {
    const transport = fakeTransport();
    new LobbyClient({ transport });
    transport.setState("connected");
    transport.setState("reconnecting");
    transport.setState("connected");
    expect(lobbySubs(transport)).toHaveLength(2);
  });

  it("dispose unsubscribes and leaves the transport unsubscribed", () => {
    const transport = fakeTransport();
    const lobby = new LobbyClient({ transport });
    transport.setState("connected");
    expect(() => lobby.list()).not.toThrow();
    expect(transport.sent).toHaveLength(1);

    lobby.dispose();
    // After dispose the client must not keep a stale subscription flag that
    // would suppress a later subscribe.
    transport.dropConnection();
    transport.reopen();
    expect(lobbySubs(transport)).toHaveLength(2);
  });
});

describe("the real transport keeps its subscription bookkeeping honest", () => {
  it("re-sends every live subscription on welcome, so a reconnect is not silent", () => {
    const written: string[] = [];
    const transport = new CableTransport({
      socketFactory: () => {
        throw new Error("not used: this test only inspects the frame list");
      },
    });
    // Record frames without a socket by stubbing the write path.
    // @ts-expect-error — reaching the private writer is the point of the test.
    transport.writeRaw = (text: string) => {
      written.push(text);
    };
    // @ts-expect-error — drive the welcome handler directly.
    transport.onWelcome();

    transport.subscribe(lobbyParams());
    written.length = 0;
    // @ts-expect-error — a second welcome replays the subscription.
    transport.onWelcome();

    expect(written.some((f) => f.includes('"command":"subscribe"'))).toBe(true);
    expect(written.some((f) => f.includes("LobbyChannel"))).toBe(true);
  });

  it("holds a message whose subscription is not confirmed yet, rather than dropping it", () => {
    const sent: string[] = [];
    const transport = new CableTransport({
      socketFactory: () =>
        ({ readyState: 1, send: (t: string) => sent.push(t) }) as unknown as WebSocket,
    });
    // @ts-expect-error — mark the connection open without a handshake.
    transport.welcomed = true;

    transport.subscribe(lobbyParams());
    transport.send({ v: 1, t: "lobby:list" });
    // Not confirmed, so nothing is on the wire yet.
    expect(sent).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------- *
 * Wire-message shape and inbound handling, per docs/PROTOCOL.md §2.
 *
 * The table there is authoritative: every client→server lobby message is
 * `{v, t, …}` with the payload columns named in the row. These tests assert
 * the wire JSON, not that a method exists.
 * ------------------------------------------------------------------------- */

interface WireRecorder extends ChannelTransport {
  /** Every `ClientMessage` the client handed to the transport, in order. */
  readonly sent: ClientMessage[];
  /** Pushes an inbound `lobby:*` / `error` frame at the client. */
  receive(msg: ServerMessage): void;
  setState(next: TransportState): void;
}

/** A recorder wired for inspection: inbound frames in, errors out. */
function harness(options: LobbyClientOptions = {}): { lobby: LobbyClient; transport: WireRecorder } {
  const stateHandlers: ((s: TransportState) => void)[] = [];
  const messageHandlers: ((m: ServerMessage) => void)[] = [];
  const errorHandlers: ((e: Error) => void)[] = [];
  const sent: ClientMessage[] = [];
  let currentState: TransportState = "connected";
  const transport = {
    sent,
    receive(msg: ServerMessage): void {
      for (const h of [...messageHandlers]) h(msg);
    },
    subscribe: (params: ChannelParams) => channelIdentifier(params),
    unsubscribe: () => {},
    identify: () => {},
    onReceipt: () => {},
    onDisconnect: () => {},
    lastActivity: () => Date.now(),
    onStateChange(handler: (s: TransportState) => void) {
      stateHandlers.push(handler);
    },
    onMessage(handler: (msg: ServerMessage) => void) {
      messageHandlers.push(handler);
    },
    onError(handler: (err: Error) => void) {
      errorHandlers.push(handler);
    },
    send(message: ClientMessage) {
      sent.push(message);
    },
    /** The transport's own failure path, so a refusal is observable. */
    setState(next: TransportState): void {
      currentState = next;
      for (const h of [...stateHandlers]) h(next);
    },
    get state() {
      return currentState;
    },
    connected: true,
    connect: () => Promise.resolve(),
    close: () => {
      currentState = "closed";
    },
  };
  const lobby = new LobbyClient({ ...options, transport: transport as unknown as ChannelTransport });
  return { lobby, transport: transport as unknown as WireRecorder };
}

describe("lobby wire messages (PROTOCOL.md §2)", () => {
  it("sends lobby:list with the filters nested under `filters`, omitted when there are none", () => {
    const { lobby, transport } = harness();
    lobby.list();
    expect(transport.sent[0]).toEqual({ v: PROTOCOL_VERSION, t: "lobby:list" });

    lobby.list({ mode: "melee", map_id: "altaior", only_joinable: true });
    expect(transport.sent[1]).toEqual({
      v: PROTOCOL_VERSION,
      t: "lobby:list",
      filters: { mode: "melee", map_id: "altaior", only_joinable: true },
    });
  });

  it("sends lobby:create with the protocol's column names at the top level", () => {
    const { lobby, transport } = harness();
    lobby.create({ name: "scrim", mode: "melee", map_id: "altaior", max_players: 2, password: "pw", race_preference: "zerg" });

    expect(transport.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      t: "lobby:create",
      name: "scrim",
      mode: "melee",
      map_id: "altaior",
      max_players: 2,
      password: "pw",
      race_preference: "zerg",
    });
  });

  it("sends lobby:join with match_id, and a password only when one was given", () => {
    const { lobby, transport } = harness();
    lobby.join(12);
    lobby.join(12, "pw");

    expect(transport.sent[0]).toEqual({ v: PROTOCOL_VERSION, t: "lobby:join", match_id: 12 });
    expect(transport.sent[1]).toEqual({ v: PROTOCOL_VERSION, t: "lobby:join", match_id: 12, password: "pw" });
  });

  it("sends lobby:leave, lobby:ready, lobby:start and lobby:settings for the seated match", () => {
    const { lobby, transport } = harness({ matchId: 12 });

    lobby.leave();
    lobby.ready();
    lobby.start();
    lobby.settings({ name: "renamed", max_players: 4 });
    lobby.ready(13, false);

    expect(transport.sent[0]).toEqual({ v: PROTOCOL_VERSION, t: "lobby:leave", match_id: 12 });
    expect(transport.sent[1]).toEqual({ v: PROTOCOL_VERSION, t: "lobby:ready", match_id: 12, ready: true });
    expect(transport.sent[2]).toEqual({ v: PROTOCOL_VERSION, t: "lobby:start", match_id: 12 });
    expect(transport.sent[3]).toEqual({ v: PROTOCOL_VERSION, t: "lobby:settings", match_id: 12, name: "renamed", max_players: 4 });
    expect(transport.sent[4]).toEqual({ v: PROTOCOL_VERSION, t: "lobby:ready", match_id: 13, ready: false });
  });

  it("stamps the protocol version on every message, as §0 requires", () => {
    const { lobby, transport } = harness({ matchId: 1 });
    lobby.list();
    lobby.create({ name: "n", mode: "melee", map_id: "altaior", max_players: 2 });
    lobby.join(1);
    lobby.leave();
    lobby.ready();
    lobby.settings({ mode: "1v1" });
    lobby.start();
    lobby.chat("gg");

    for (const message of transport.sent) {
      expect(message.v).toBe(PROTOCOL_VERSION);
      expect(typeof message.t).toBe("string");
      expect(message.t.startsWith("lobby:")).toBe(true);
    }
  });

  it("addresses an explicit match without rebinding the default seat", () => {
    // The default is what an argument-free call means. A helper given an
    // explicit id addresses that match for that call only — latching it meant
    // `ready(13, false)` then `start()` started match 13 rather than 12.
    const { lobby, transport } = harness({ matchId: 12 });
    lobby.ready(7);
    expect(transport.sent[0]).toEqual({ v: PROTOCOL_VERSION, t: "lobby:ready", match_id: 7, ready: true });
    expect(lobby.matchId).toBe(12);

    lobby.leave();
    expect(transport.sent[1]).toEqual({ v: PROTOCOL_VERSION, t: "lobby:leave", match_id: 12 });
  });

  it("still lets a caller set the default seat deliberately", () => {
    const { lobby, transport } = harness();
    lobby.join(7);
    // `join` is a request, not a fact; the server broadcast is what seats you.
    expect(lobby.matchId).toBeNull();

    lobby.leave();
    // No default and no argument: reported, not guessed at.
    expect(transport.sent).toHaveLength(1);
  });

  it("does not treat join() as seating the client: the server broadcast does that", () => {
    const { lobby } = harness();
    lobby.join(7);
    // `join` is a request, not a fact. Claiming the seat client-side would let
    // `leave`/`ready` address a match the server may have refused.
    expect(lobby.matchId).toBeNull();

    lobby.onState(() => {});
    lobby.ready();
    expect(lobby.matchId).toBeNull();
  });
});

describe("lobby refusals are reported, not swallowed", () => {
  it("reports no_match instead of sending when there is no seated match", () => {
    const { lobby, transport } = harness();
    const errors: { code: string; message: string; fatal: boolean }[] = [];
    lobby.onError((e) => errors.push(e));

    lobby.leave();
    lobby.ready();
    lobby.start();
    lobby.settings({ name: "x" });

    // Nothing goes on the wire: a leave with match_id 0 would tell the server
    // to act on match 0, and a settings with no match_id is invalid_payload.
    expect(transport.sent).toEqual([]);
    expect(errors).toHaveLength(4);
    expect(errors.every((e) => e.code === "no_match" && e.fatal === false)).toBe(true);
  });

  it("reports rate_limited and sends nothing for a second chat inside the cooldown", () => {
    const { lobby, transport } = harness({ matchId: 3, chatCooldownMs: 10_000 });
    const errors: { code: string }[] = [];
    lobby.onError((e) => errors.push(e));

    expect(lobby.chat("gg")).toBe(true);
    expect(lobby.chat("wp")).toBe(false);

    expect(transport.sent).toHaveLength(1);
    expect(errors.map((e) => e.code)).toEqual(["rate_limited"]);
  });

  it("truncates chat to the protocol's 280 characters rather than sending an invalid line", () => {
    const { lobby, transport } = harness({ matchId: 3 });
    const long = "x".repeat(LOBBY_CHAT_MAX_LENGTH + 50);

    expect(lobby.chat(long)).toBe(true);
    const message = transport.sent[0] as { t: string; text: string };
    expect(message.t).toBe("lobby:chat");
    expect(message.text).toHaveLength(LOBBY_CHAT_MAX_LENGTH);
  });

  it("refuses empty chat without touching the wire or the cooldown", () => {
    const { lobby, transport } = harness({ matchId: 3 });
    expect(lobby.chat("")).toBe(false);
    expect(transport.sent).toEqual([]);
  });

  it("surfaces a transport refusal rather than losing it", () => {
    const errors: { code: string; message: string; fatal: boolean }[] = [];
    const stateHandlers: ((s: TransportState) => void)[] = [];
    const errorHandlers: ((e: Error) => void)[] = [];
    const sent: ClientMessage[] = [];
    const transport = {
      subscribe: (p: ChannelParams) => channelIdentifier(p),
      unsubscribe: () => {},
      identify: () => {},
      onReceipt: () => {},
      onDisconnect: () => {},
      lastActivity: () => Date.now(),
      onStateChange: (h: (s: TransportState) => void) => stateHandlers.push(h),
      onMessage: () => {},
      onError: (h: (e: Error) => void) => errorHandlers.push(h),
      // The real CableTransport refuses to write a lobby message when it holds
      // no lobby subscription, and reports that through onError.
      send: (m: ClientMessage) => {
        if (!transport.subscribedLobby) {
          const err = new Error(`no lobby subscription for ${m.t}`);
          for (const h of [...errorHandlers]) h(err);
          return;
        }
        sent.push(m);
      },
      state: "connected" as TransportState,
      subscribedLobby: false,
      connected: true,
      connect: () => Promise.resolve(),
      close: () => {},
    };
    const lobby = new LobbyClient({ transport: transport as unknown as ChannelTransport });
    lobby.onError((e) => errors.push(e));

    lobby.list();
    expect(sent).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("transport_error");
    expect(errors[0].message).toContain("no lobby subscription for lobby:list");
    expect(errors[0].fatal).toBe(false);
  });
});

describe("lobby inbound state", () => {
  it("records the broadcast and notifies state subscribers", () => {
    const { lobby, transport } = harness();
    const seen: LobbyState[] = [];
    lobby.onState((s) => seen.push(s));

    const matches = [{ id: 1, name: "scrim", mode: "melee", map_id: "altaior", max_players: 2, player_count: 1, status: "lobby", has_password: false, host: "nik" }];
    const you = { match_id: 1, player_id: 7, slot: 0, race: "terran", ready: false, is_host: true };
    transport.receive({ v: PROTOCOL_VERSION, t: "lobby:state", ts: 0, matches, you } as ServerMessage);

    expect(seen).toHaveLength(1);
    expect(seen[0].matches).toEqual(matches);
    expect(seen[0].you).toEqual(you);
    // `state` is the most recent broadcast, readable without a subscription.
    expect(lobby.state.matches).toHaveLength(1);
    expect(lobby.state.you?.is_host).toBe(true);
  });

  it("starts empty and stays empty for a state with no matches and no seat", () => {
    const { lobby, transport } = harness();
    expect(lobby.state).toEqual({ matches: [], you: null });

    transport.receive({ v: PROTOCOL_VERSION, t: "lobby:state", ts: 0, matches: [], you: null } as ServerMessage);
    expect(lobby.state).toEqual({ matches: [], you: null });
  });

  it("relays each line of a lobby:chat backlog, oldest first", () => {
    const { lobby, transport } = harness();
    const lines: LobbyChatLine[] = [];
    lobby.onChat((line) => lines.push(line));

    const backlog: LobbyChatLine[] = [
      { player_id: 7, name: "nik", text: "gg", ts: 1 },
      { player_id: 8, name: "zz", text: "wp", ts: 2 },
    ];
    transport.receive({ v: PROTOCOL_VERSION, t: "lobby:chat", ts: 0, match_id: 3, lines: backlog } as ServerMessage);

    expect(lines.map((l) => l.text)).toEqual(["gg", "wp"]);
  });

  it("surfaces a server error with its code, message and fatal flag intact", () => {
    const { lobby, transport } = harness();
    const errors: { code: string; message: string; fatal: boolean }[] = [];
    lobby.onError((e) => errors.push(e));

    transport.receive({ v: PROTOCOL_VERSION, t: "error", ts: 0, code: "not_host", message: "Only the host can start", fatal: false } as ServerMessage);
    transport.receive({ v: PROTOCOL_VERSION, t: "error", ts: 0, code: "unauthenticated", message: "identify first", fatal: true } as ServerMessage);

    expect(errors).toEqual([
      { code: "not_host", message: "Only the host can start", fatal: false },
      { code: "unauthenticated", message: "identify first", fatal: true },
    ]);
  });

  it("ignores game-channel traffic, which shares the socket", () => {
    const { lobby, transport } = harness();
    const errors: unknown[] = [];
    const states: LobbyState[] = [];
    lobby.onError((e) => errors.push(e));
    lobby.onState((s) => states.push(s));

    transport.receive({ v: PROTOCOL_VERSION, t: "game:snapshot", ts: 0, tick: 1, server_ms: 0, ack: 0, entities: [], events: [] } as ServerMessage);

    expect(errors).toEqual([]);
    expect(states).toEqual([]);
    expect(lobby.state).toEqual({ matches: [], you: null });
  });

  it("stops delivering to unsubscribed handlers, and after dispose", () => {
    const { lobby, transport } = harness();
    const seen: LobbyState[] = [];
    const off = lobby.onState((s) => seen.push(s));
    const broadcast = (): void => {
      transport.receive({ v: PROTOCOL_VERSION, t: "lobby:state", ts: 0, matches: [], you: null } as ServerMessage);
    };

    broadcast();
    off();
    broadcast();
    expect(seen).toHaveLength(1);

    const after: LobbyState[] = [];
    lobby.onState((s) => after.push(s));
    lobby.dispose();
    broadcast();
    expect(after).toEqual([]);
  });
});

describe("connection state", () => {
  it("forwards transport state changes and unsubscribes on request", () => {
    const { lobby, transport } = harness();
    const seen: TransportState[] = [];
    const off = lobby.onConnectionState((s) => seen.push(s));

    transport.setState("reconnecting");
    transport.setState("connected");
    off();
    transport.setState("closed");

    expect(seen).toEqual(["reconnecting", "connected"]);
  });
});
