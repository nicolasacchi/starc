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
import { LobbyClient } from "./lobbyClient";
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
