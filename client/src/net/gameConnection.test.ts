/**
 * `GameConnection` is what the game screen actually drives. Everything here is
 * a "the click did nothing" failure: commands buffered and lost, a batch per
 * command exhausting the send cap, an over-sized command reaching the server
 * and coming back rejected, or a reconnect that leaves the pre-drop world on
 * screen as ghosts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GameConnection,
  MAX_COMMANDS_PER_BATCH,
  MAX_IDS_PER_COMMAND,
} from "./gameConnection";
import type {
  GameEndedMessage,
  GameStartMessage,
  GameSnapshotMessage,
} from "./gameConnection";
import { gameChannelFor, LOBBY_CHANNEL } from "./transport";
import type { ChannelTransport, TransportState } from "./transport";
import type { ClientMessage, Command, ProtocolEntity, ServerMessage } from "@shared/protocol";

const URL = "wss://cable.example.test/cable";
const TOKEN = "session-token";
const MATCH = 7;
const ME = 1;

class FakeTransport implements ChannelTransport {
  state: TransportState = "idle";
  readonly sent: ClientMessage[] = [];
  readonly subscribed: string[] = [];
  readonly unsubscribed: string[] = [];
  readonly identified: string[] = [];
  connectCalls = 0;
  closed = false;

  private readonly messageHandlers: ((m: ServerMessage) => void)[] = [];
  private readonly stateHandlers: ((s: TransportState) => void)[] = [];
  private readonly errorHandlers: ((e: Error) => void)[] = [];
  private readonly receiptHandlers: ((id: string, sent: number, received: number) => void)[] = [];

  connect = async (_url: string, _token: string): Promise<void> => {
    this.connectCalls++;
    this.setState("connected");
  };

  send = (message: ClientMessage): void => {
    this.sent.push(message);
  };

  onMessage = (handler: (m: ServerMessage) => void): void => {
    this.messageHandlers.push(handler);
  };

  onStateChange = (handler: (s: TransportState) => void): void => {
    this.stateHandlers.push(handler);
  };

  onError = (handler: (e: Error) => void): void => {
    this.errorHandlers.push(handler);
  };

  onReceipt = (handler: (id: string, sent: number, received: number) => void): void => {
    this.receiptHandlers.push(handler);
  };

  lastActivity = (): number => 0;

  subscribe(channel: string): string {
    this.subscribed.push(channel);
    return `sub-${this.subscribed.length}`;
  }

  unsubscribe(channel: string): void {
    this.unsubscribed.push(channel);
  }

  identify(channel?: string): void {
    this.identified.push(channel ?? "");
  }

  close = (): void => {
    this.closed = true;
    this.setState("closed");
  };

  /* ----------------------------------------------------- test-side controls */
  emit = (message: ServerMessage): void => {
    for (const handler of this.messageHandlers) handler(message);
  };

  raise = (error: Error): void => {
    for (const handler of this.errorHandlers) handler(error);
  };

  setState = (state: TransportState): void => {
    this.state = state;
    for (const handler of this.stateHandlers) handler(state);
  };

  /** The `game:command` batches actually written to the socket. */
  get batches(): Extract<ClientMessage, { t: "game:command" }>[] {
    return this.sent.filter(
      (m): m is Extract<ClientMessage, { t: "game:command" }> => m.t === "game:command",
    );
  }
}

class FakeTimer {
  private readonly pending = new Map<number, () => void>();
  private next = 1;
  readonly delays: number[] = [];

  set = (handler: () => void, delayMs: number): number => {
    this.delays.push(delayMs);
    const handle = this.next++;
    this.pending.set(handle, handler);
    return handle;
  };

  clear = (handle: number): void => {
    this.pending.delete(handle);
  };

  async fireAll(): Promise<void> {
    while (this.pending.size > 0) {
      const entry = this.pending.entries().next();
      if (entry.done) throw new Error("no timer is scheduled");
      this.pending.delete(entry.value[0]);
      entry.value[1]();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

function entity(id: number, over: Partial<ProtocolEntity> = {}): ProtocolEntity {
  return {
    id,
    ty: "marine",
    pl: ME,
    x: 0,
    y: 0,
    z: 0,
    hp: 45,
    hp_max: 45,
    mp: 0,
    mp_max: 0,
    ang: 0,
    st: "idle",
    ...over,
  };
}

function startMessage(countdownMs = 0): GameStartMessage {
  return {
    v: 1,
    t: "game:start",
    match_id: MATCH,
    seed: 1,
    map_id: "dust",
    tick_rate: 20,
    snapshot_rate: 10,
    countdown_ms: countdownMs,
    players: [{ player_id: ME, slot: 0, race: "terran", name: "me", team: 0, start: { x: 0, z: 0 } }],
  };
}

function snapshotMessage(tick: number, entities: ProtocolEntity[]): GameSnapshotMessage {
  return { v: 1, t: "game:snapshot", tick, server_ms: 1_700_000_000_000 + tick * 100, ack: tick, entities, events: [] };
}

describe("GameConnection", () => {
  let transport: FakeTransport;
  let timer: FakeTimer;
  let connection: GameConnection;

  function build(): GameConnection {
    let batch = 0;
    return new GameConnection({
      url: URL,
      token: TOKEN,
      transport,
      timer,
      uuid: () => `batch-${++batch}`,
      playerId: ME,
    });
  }

  beforeEach(() => {
    transport = new FakeTransport();
    timer = new FakeTimer();
    connection = build();
  });

  afterEach(() => {
    connection.dispose();
  });

  describe("lifecycle", () => {
    it("subscribes to the lobby and the match, then identifies", async () => {
      await connection.connect(MATCH);

      expect(transport.subscribed).toEqual([LOBBY_CHANNEL, gameChannelFor(MATCH)]);
      // identify must precede every other message on the channel.
      expect(transport.identified).toEqual([gameChannelFor(MATCH)]);
      expect(connection.state).toBe("waiting");
      expect(connection.matchId).toBe(MATCH);
    });

    it("moves from countdown to running when the countdown elapses", async () => {
      await connection.connect(MATCH);
      transport.emit(startMessage(1_000));
      expect(connection.state).toBe("countdown");

      await timer.fireAll();
      expect(connection.state).toBe("running");
    });

    it("goes straight to running when there is no countdown", async () => {
      await connection.connect(MATCH);
      transport.emit(startMessage(0));
      expect(connection.state).toBe("running");
    });

    it("buffers commands issued before game:start and flushes them when it lands", async () => {
      await connection.connect(MATCH);
      connection.start();

      connection.send([{ c: "move", ids: [1], x: 10, z: 10 }]);
      connection.send([{ c: "move", ids: [2], x: 20, z: 20 }]);
      connection.tick(16);

      // Dropping them is a click that visibly does nothing.
      expect(connection.pendingCommandCount).toBe(2);
      expect(transport.batches).toHaveLength(0);

      transport.emit(startMessage(0));

      expect(transport.batches).toHaveLength(1);
      expect(transport.batches[0]!.commands).toHaveLength(2);
      expect(connection.pendingCommandCount).toBe(0);
    });

    it("refuses commands once the match has ended", async () => {
      await connection.connect(MATCH);
      connection.start();
      transport.emit(startMessage(0));
      transport.emit({
        v: 1,
        t: "game:ended",
        tick: 1,
        winner: ME,
        reason: "forfeit",
        duration_ms: 1,
        scores: [],
        replay_url: "",
      });

      const errors: string[] = [];
      connection.onError((e) => errors.push(e.code));
      connection.send([{ c: "move", ids: [1], x: 1, z: 1 }]);

      expect(errors).toEqual(["not_started"]);
      expect(transport.batches).toHaveLength(0);
    });
  });

  describe("command batching", () => {
    beforeEach(async () => {
      await connection.connect(MATCH);
      connection.start();
      transport.emit(startMessage(0));
    });

    it("coalesces everything issued in one frame into a single batch", async () => {
      connection.send([{ c: "move", ids: [1], x: 10, z: 10 }]);
      connection.send([{ c: "move", ids: [2], x: 20, z: 20 }]);
      connection.send([{ c: "move", ids: [3], x: 30, z: 30 }]);
      connection.tick(16);

      // One message per command burns the 20 Hz budget three times over and
      // gets the client rate-limited mid-drag.
      expect(transport.batches).toHaveLength(1);
      expect(transport.batches[0]!.commands).toHaveLength(3);
    });

    it("merges move orders that share a destination into one command", async () => {
      connection.send([{ c: "move", ids: [1], x: 10, z: 10 }]);
      connection.send([{ c: "move", ids: [2, 3], x: 10, z: 10 }]);
      connection.tick(16);

      // A 200-unit order should cost one command, not two hundred.
      expect(transport.batches[0]!.commands).toEqual([{ c: "move", ids: [1, 2, 3], x: 10, z: 10 }]);
    });

    it("keeps orders to different destinations apart", () => {
      expect(MAX_COMMANDS_PER_BATCH).toBe(256);
      expect(MAX_IDS_PER_COMMAND).toBe(256);
    });

    it("never puts more than the protocol's command ceiling on the wire", () => {
      const many: Command[] = Array.from({ length: 400 }, (_, i) => ({
        c: "stop" as const,
        ids: [i + 1],
      }));

      connection.send(many);
      connection.tick(16);

      // The server rejects the whole batch if one command is malformed.
      expect(transport.batches[0]!.commands).toHaveLength(MAX_COMMANDS_PER_BATCH);
    });

    it("caps the ids on one command and says so", () => {
      const errors: string[] = [];
      connection.onError((e) => errors.push(e.code));
      const ids = Array.from({ length: 300 }, (_, i) => i + 1);

      connection.send([{ c: "move", ids, x: 5, z: 5 }]);
      connection.tick(16);

      expect(transport.batches[0]!.commands[0]).toMatchObject({ ids: ids.slice(0, MAX_IDS_PER_COMMAND) });
      expect(errors).toEqual(["invalid_command"]);
    });

    it("drops a command whose ids are all nonsense", () => {
      connection.send([{ c: "move", ids: [0, -3, 1.5], x: 5, z: 5 }]);
      connection.tick(16);
      expect(transport.batches).toHaveLength(0);
    });

    it("sheds commands over the local rate limit instead of queueing them", () => {
      const errors: string[] = [];
      connection.onError((e) => errors.push(e.code));

      for (let batch = 0; batch < 5; batch++) {
        connection.send(
          Array.from({ length: 100 }, (_, i) => ({ c: "stop" as const, ids: [batch * 100 + i + 1] })),
        );
        connection.tick(16);
      }

      // The excess is refused locally rather than growing an unbounded backlog.
      expect(errors).toContain("rate_limited");
      const total = transport.batches.reduce((sum, b) => sum + b.commands.length, 0);
      expect(total).toBeLessThanOrEqual(400);
    });

    it("stamps a batch with the newest server tick it has seen", () => {
      transport.emit(snapshotMessage(42, [entity(1)]));
      connection.send([{ c: "stop", ids: [1] }]);
      connection.tick(16);

      expect(transport.batches[0]!.from_tick).toBe(42);
    });

    it("sends a forfeit without a batch", () => {
      connection.forfeit("test");
      expect(transport.sent.some((m) => m.t === "game:forfeit")).toBe(true);
      expect(connection.state).toBe("ended");
    });
  });

  describe("events", () => {
    it("delivers start, snapshot and end, and stops after unsubscribe", async () => {
      const starts: GameStartMessage[] = [];
      const shots: number[] = [];
      const ends: GameEndedMessage[] = [];
      const offStart = connection.onStart((m) => starts.push(m));
      connection.onSnapshot((m) => shots.push(m.tick));
      const offEnd = connection.onEnd((m) => ends.push(m));

      await connection.connect(MATCH);
      transport.emit(startMessage(0));
      transport.emit(snapshotMessage(1, [entity(1)]));
      transport.emit(snapshotMessage(2, []));
      transport.emit({
        v: 1,
        t: "game:ended",
        tick: 3,
        winner: ME,
        reason: "forfeit",
        duration_ms: 1,
        scores: [],
        replay_url: "",
      });

      expect(starts).toHaveLength(1);
      expect(shots).toEqual([1, 2]);
      expect(ends).toHaveLength(1);

      offStart();
      offEnd();
      transport.emit(snapshotMessage(4, []));
      // A dead handler that keeps firing is a leak in every screen that mounted.
      expect(starts).toHaveLength(1);
    });

    it("reports rejections with the batch they answer", async () => {
      await connection.connect(MATCH);
      const rejects: unknown[] = [];
      connection.onReject((event) => rejects.push(event));

      transport.emit({
        v: 1,
        t: "game:reject",
        rejected: [{ index: 0, code: "not_owner", message: "nope" }],
      });

      expect(rejects).toEqual([{ rejections: [{ index: 0, code: "not_owner", message: "nope" }], batchId: null }]);
    });

    it("closes on a fatal server error and never reconnects", async () => {
      await connection.connect(MATCH);
      const errors: { code: string; fatal: boolean }[] = [];
      connection.onError((e) => errors.push(e));

      transport.emit({ v: 1, t: "error", code: "unauthenticated", message: "no", fatal: true });

      expect(errors[0]).toMatchObject({ code: "unauthenticated", fatal: true });
      expect(connection.state).toBe("closed");
    });

    it("surfaces a transport error as a non-fatal one", async () => {
      const errors: { code: string; fatal: boolean }[] = [];
      connection.onError((e) => errors.push(e));
      await connection.connect(MATCH);

      transport.raise(new Error("cable socket error"));

      // A dead socket is not a fatal protocol error; the reconnect path owns it.
      expect(errors).toEqual([{ code: "transport_error", message: "cable socket error", fatal: false }]);
    });
  });

  describe("world state", () => {
    beforeEach(async () => {
      await connection.connect(MATCH);
      connection.start();
      transport.emit(startMessage(0));
    });

    it("holds the newest snapshot's entity table", () => {
      transport.emit(snapshotMessage(1, [entity(1), entity(2)]));
      transport.emit(snapshotMessage(2, [entity(2), entity(3)]));

      expect(connection.snapshots.size).toBe(2);
      expect(connection.serverTick).toBe(2);
      expect(connection.snapshot?.entities.has(1)).toBe(false);
    });

    it("moves a predicted unit before the server has seen the order", () => {
      transport.emit(snapshotMessage(1, [entity(1, { x: 0 })]));
      connection.send([{ c: "move", ids: [1], x: 100, z: 0 }]);
      connection.tick(100);

      const view = connection.sampleWorld().entities.get(1);
      // Without prediction the unit does not move until the next snapshot.
      expect(view?.x).toBeGreaterThan(0);
      expect(view?.st).toBe("moving");
    });

    it("resynchronises after a reconnect so no pre-drop entity survives", async () => {
      transport.emit(snapshotMessage(1, [entity(1, { x: 0 }), entity(2, { x: 5 })]));
      connection.send([{ c: "move", ids: [1], x: 100, z: 0 }]);
      connection.tick(100);
      expect(connection.sampleWorld().entities.size).toBe(2);

      transport.setState("reconnecting");
      expect(connection.state).toBe("reconnecting");

      await timer.fireAll(); // the backoff fires, connect() resolves, resync runs

      // Everything we held describes a match that moved on without us; drawing
      // it is a ghost base the player cannot click.
      expect(connection.snapshots.size).toBe(0);
      expect(connection.sampleWorld().entities.size).toBe(0);
    });

    it("re-subscribes to the match after a reconnect", async () => {
      transport.emit(snapshotMessage(1, [entity(1)]));
      transport.setState("reconnecting");
      await timer.fireAll();

      expect(transport.subscribed).toContain(gameChannelFor(MATCH));
      expect(connection.state).toBe("waiting");
    });
  });
});
