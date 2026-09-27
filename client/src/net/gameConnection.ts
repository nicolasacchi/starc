/**
 * The state machine a game screen drives.
 *
 * Owns one cable connection and the whole live-match pipeline: snapshots in,
 * local prediction out, commands coalesced and rate-limited on the way to the
 * server, and reconnection with a clean resync when the socket dies.
 *
 * Lifecycle, from the UI's point of view:
 *
 * ```
 * connect(matchId) ──▶ waiting ──game:start──▶ countdown ──▶ running ──▶ ended
 *      └── reconnecting ◀── socket lost ──▶ (resync, then waiting again)
 * ```
 *
 * - `connect` opens the cable, subscribes to `lobby` and `game:<id>`, and
 *   identifies (PROTOCOL.md §1).
 * - `start` says "the game screen is mounted and may act". Commands accepted
 *   before `game:start` arrives are buffered, not dropped, and flushed the
 *   moment the match opens.
 * - `send` is the only way to affect the world. It is bounded three ways
 *   (PROTOCOL.md §4 plus the abuse rules): 256 commands per batch, 256 ids per
 *   command, and 20 batches a second with move orders from the same frame
 *   coalesced into one. A local token bucket sheds the excess and says so.
 * - `forfeit` ends the match from this side; `disconnect` tears the connection
 *   down; `dispose` additionally drops every event handler.
 *
 * The clock: snapshots carry the server's epoch millis, so the connection
 * estimates its offset from them, corrected by half the measured RTT.
 *
 * ## What this module deliberately does not do
 *
 * It does not interpolate. The renderer already blends each entity between
 * the two newest snapshots (`SceneManager.applySnapshot`/`update`), so a
 * second interpolator here would smooth the same data twice and add a
 * snapshot interval of latency for nothing. The render clock this connection
 * keeps is used for one thing — folding local prediction into the frame the
 * renderer is about to draw, through {@link predictedEntities}.
 *
 * That is also why {@link tick} matters even though the renderer drives its
 * own smoothing: without it the predictor would never advance between
 * snapshots, and a right-click would not move anything until the server
 * answered.
 */
import { PROTOCOL_VERSION, TICK_MS } from "@shared/protocol";
import type {
  ClientMessage,
  Command,
  LobbyChatLine,
  Rejection,
  ProtocolEntity,
  ServerErrorCode,
  ServerMessage,
} from "@shared/protocol";
import { TypedEmitter } from "./events";
import type { Unsubscribe } from "./events";
import { NetMetrics } from "./metrics";
import { MovementPredictor } from "./prediction";
import type { TerrainProbe, UnacknowledgedCommand } from "./prediction";
import { ReconnectController, systemTimer } from "./reconnect";
import type { TimerApi, TimerHandle } from "./reconnect";
import { SnapshotBuffer } from "./snapshotBuffer";
import type { BufferedSnapshot, Snapshot } from "./snapshotBuffer";
import { CableTransport, gameParams, lobbyParams } from "./transport";
import type { ChannelTransport, ServerDisconnect, TransportState } from "./transport";

/** Phase of the connection, from the game screen's point of view. */
export type GameConnectionState =
  | "idle"
  | "connecting"
  | "waiting"
  | "countdown"
  | "running"
  | "ended"
  | "reconnecting"
  | "closed";

export type GameStartMessage = Extract<ServerMessage, { t: "game:start" }>;
export type GameSnapshotMessage = Extract<ServerMessage, { t: "game:snapshot" }>;
export type GameEndedMessage = Extract<ServerMessage, { t: "game:ended" }>;

export interface GameRejectionEvent {
  rejections: Rejection[];
  /** `game:command` id the server was answering, when known. */
  batchId: string | null;
}

export type ConnectionErrorCode =
  | ServerErrorCode
  | "rate_limited"
  | "invalid_command"
  | "not_started"
  | "transport_error"
  | "server_error";

export interface ConnectionError {
  code: ConnectionErrorCode;
  message: string;
  fatal: boolean;
}

export interface GameConnectionEvents {
  start: GameStartMessage;
  snapshot: GameSnapshotMessage;
  end: GameEndedMessage;
  reject: GameRejectionEvent;
  chat: LobbyChatLine;
  error: ConnectionError;
  stateChange: GameConnectionState;
}

/** PROTOCOL.md §4: 256 ids per command, 256 commands per batch. */
export const MAX_COMMANDS_PER_BATCH = 256;
export const MAX_IDS_PER_COMMAND = 256;
/** The send cap: at most one batch per simulation tick. */
export const MAX_BATCHES_PER_SECOND = 20;
/** Local abuse ceiling — the server rate-limits far harder than this. */
export const MAX_COMMANDS_PER_SECOND = 400;
/** PROTOCOL.md §2: chat is 1..280 characters. */
export const MAX_CHAT_LENGTH = 280;

export interface GameConnectionOptions {
  /** Cable endpoint, e.g. `wss://host/cable`. */
  url: string;
  /** Session token from the REST login. */
  token: string;
  /** Transport override; a {@link CableTransport} is built when absent. */
  transport?: ChannelTransport;
  /** Player id, when the caller already knows it. */
  playerId?: number;
  /** Snapshots retained for late-join and reconnect bookkeeping. */
  snapshotCapacity?: number;
  /** Terrain queries for prediction; flat ground when absent. */
  terrain?: TerrainProbe;
  /** Command ceilings. */
  maxCommandsPerBatch?: number;
  maxIdsPerCommand?: number;
  maxBatchesPerSecond?: number;
  maxCommandsPerSecond?: number;
  /** Reconnection attempt budget before giving up. */
  maxReconnectAttempts?: number;
  /** Injectable sources, so the state machine is testable without waiting. */
  timer?: TimerApi;
  random?: () => number;
  /** Batch-id source; defaults to `crypto.randomUUID`. */
  uuid?: () => string;
}

export class GameConnection {
  readonly snapshots: SnapshotBuffer;
  readonly metrics: NetMetrics;
  readonly events = new TypedEmitter<GameConnectionEvents>();

  private readonly transport: ChannelTransport;
  private readonly ownsTransport: boolean;
  private readonly url: string;
  private readonly token: string;
  private readonly maxCommandsPerBatch: number;
  private readonly maxIdsPerCommand: number;
  private readonly flushIntervalMs: number;
  private readonly maxCommandsPerSecond: number;
  private readonly timer: TimerApi;
  private readonly uuid: () => string;
  private readonly reconnect: ReconnectController;
  private readonly terrain: TerrainProbe | undefined;

  private currentState: GameConnectionState = "idle";
  private currentMatchId: number | null = null;
  private localPlayerId: number | null;
  private predictor: MovementPredictor | null = null;
  private startInfo: GameStartMessage | null = null;
  private started = false;
  /** True once the caller closed us on purpose: never auto-reconnect then. */
  private intentionalClose = false;
  /** True while the transport has dropped and reconnection is pending. */
  private dropPending = false;
  private countdownHandle: TimerHandle | null = null;
  private flushHandle: TimerHandle | null = null;
  private lastFlushAtMs = 0;
  private clockOffsetMs = Number.NaN;
  private rttMs = 0;
  private lastSnapshot: BufferedSnapshot | null = null;
  private simAccumulatorMs = 0;
  /** Batches accepted but not yet written to the socket. */
  private readonly outbound: UnacknowledgedCommand[] = [];
  private rateWindowStartMs = 0;
  private rateWindowCount = 0;
  /** What this connection has subscribed, so a repeat is a no-op. */
  private lobbySubscribed = false;
  private subscribedMatchId: number | null = null;

  constructor(options: GameConnectionOptions) {
    this.url = options.url;
    this.token = options.token;
    this.terrain = options.terrain;
    this.localPlayerId = options.playerId ?? null;
    this.maxCommandsPerBatch = options.maxCommandsPerBatch ?? MAX_COMMANDS_PER_BATCH;
    this.maxIdsPerCommand = options.maxIdsPerCommand ?? MAX_IDS_PER_COMMAND;
    this.flushIntervalMs = 1000 / (options.maxBatchesPerSecond ?? MAX_BATCHES_PER_SECOND);
    this.maxCommandsPerSecond = options.maxCommandsPerSecond ?? MAX_COMMANDS_PER_SECOND;
    this.uuid = options.uuid ?? defaultUuid;
    this.timer = options.timer ?? systemTimer;

    this.ownsTransport = options.transport === undefined;
    this.transport = options.transport ?? new CableTransport();
    this.snapshots = new SnapshotBuffer(options.snapshotCapacity);
    this.metrics = new NetMetrics();

    this.reconnect = new ReconnectController(() => this.transport.connect(this.url, this.token), {
      maxAttempts: options.maxReconnectAttempts,
      random: options.random,
      timer: this.timer,
      onResync: () => this.resync(),
      onGiveUp: (attempts) => {
        this.setState("closed");
        this.emitError("server_error", `gave up after ${attempts} reconnection attempts`, true);
      },
    });

    this.transport.onStateChange((state) => this.onTransportState(state));
    this.transport.onMessage((msg) => this.onMessage(msg));
    this.transport.onError((err) => this.emitError("transport_error", err.message, false));
    this.transport.onDisconnect((info) => this.onServerDisconnect(info));
    this.transport.onReceipt((_id, sentAtMs, receivedAtMs) => {
      this.rttMs = Math.max(0, receivedAtMs - sentAtMs);
      this.metrics.recordReceipt(sentAtMs, receivedAtMs);
    });
  }

  /* ------------------------------------------------------------- accessors */

  get state(): GameConnectionState {
    return this.currentState;
  }

  get matchId(): number | null {
    return this.currentMatchId;
  }

  get playerId(): number | null {
    return this.localPlayerId;
  }

  get startMessage(): GameStartMessage | null {
    return this.startInfo;
  }

  /** Latest snapshot pushed into the buffer. */
  get snapshot(): BufferedSnapshot | null {
    return this.lastSnapshot;
  }

  /** Newest server tick seen; also the `from_tick` stamped on new commands. */
  get serverTick(): number {
    return this.lastSnapshot?.tick ?? 0;
  }

  /** Commands accepted but not yet flushed to the socket. */
  get pendingCommandCount(): number {
    let total = 0;
    for (const batch of this.outbound) total += batch.commands.length;
    return total;
  }

  /** Estimated server epoch millis, from snapshot arrival plus half the RTT. */
  serverTime(): number {
    const local = Date.now();
    return Number.isNaN(this.clockOffsetMs) ? local : local + this.clockOffsetMs;
  }

  /* ---------------------------------------------------------------- events */

  onStart(handler: (msg: GameStartMessage) => void): Unsubscribe {
    return this.events.on("start", handler);
  }

  onSnapshot(handler: (msg: GameSnapshotMessage) => void): Unsubscribe {
    return this.events.on("snapshot", handler);
  }

  onEnd(handler: (msg: GameEndedMessage) => void): Unsubscribe {
    return this.events.on("end", handler);
  }

  onReject(handler: (event: GameRejectionEvent) => void): Unsubscribe {
    return this.events.on("reject", handler);
  }

  onChat(handler: (line: LobbyChatLine) => void): Unsubscribe {
    return this.events.on("chat", handler);
  }

  onError(handler: (error: ConnectionError) => void): Unsubscribe {
    return this.events.on("error", handler);
  }

  onStateChange(handler: (state: GameConnectionState) => void): Unsubscribe {
    return this.events.on("stateChange", handler);
  }

  /* ------------------------------------------------------------- lifecycle */

  /** Opens the cable, subscribes to the lobby and the match, and identifies. */
  async connect(matchId: number): Promise<void> {
    this.currentMatchId = matchId;
    this.dropPending = false;
    this.intentionalClose = false;
    this.setState("connecting");
    try {
      await this.transport.connect(this.url, this.token);
    } catch {
      // The transport already reported why; back off and try again.
      this.setState("reconnecting");
      this.reconnect.notifyLoss();
      return;
    }
    // The cable may already have been open — by the lobby, or by a previous
    // attempt — in which case there was no `connected` transition to react to.
    // Ask for the subscription outright rather than hope one arrives.
    if (this.transport.connected) {
      this.subscribeAll();
      this.setState("waiting");
    }
  }

  /**
   * Marks the game screen as live. Commands issued before this point stay
   * buffered and go out when the match opens.
   */
  start(): void {
    this.started = true;
    if (this.currentState === "ended" || this.currentState === "closed") return;
    this.flush();
  }

  /**
   * Queues commands for the next send slot. Move orders in the same frame are
   * coalesced into one batch, ids are capped, and the local token bucket sheds
   * anything over budget rather than letting it queue forever. Prediction is
   * applied immediately, so a unit moves on the same frame as the click.
   */
  send(commands: Command[]): void {
    if (this.currentState === "closed" || this.currentState === "ended") {
      this.emitError("not_started", "the match is not running", false);
      return;
    }
    const accepted = this.sanitize(commands);
    if (accepted.length === 0) return;
    if (!this.consumeRateBudget(accepted.length)) {
      this.emitError("rate_limited", `dropped ${accepted.length} commands over the local rate limit`, false);
      return;
    }
    const fromTick = this.serverTick;
    const predicted = this.prediction()?.queueCommand(accepted, fromTick, this.uuid());
    this.outbound.push(
      predicted ?? { id: this.uuid(), fromTick, commands: accepted, sentAtMs: Date.now() },
    );
    this.armFlush();
  }

  /** Surrenders the match. The server answers with `game:ended`. */
  forfeit(reason?: string): void {
    const message: ClientMessage =
      reason === undefined
        ? { v: PROTOCOL_VERSION, t: "game:forfeit" }
        : { v: PROTOCOL_VERSION, t: "game:forfeit", reason };
    this.transport.send(message);
    this.setState("ended");
  }

  /** Tears the connection down and forgets every piece of match state. */
  disconnect(): void {
    this.intentionalClose = true;
    this.reconnect.stop();
    this.cancelFlush();
    this.cancelCountdown();
    // Only our own subscription: the transport is shared with the lobby, and
    // unsubscribing the lobby channel here would take the match browser down
    // with us. Read it before `forgetWorld` clears the bookkeeping.
    const leaving = this.subscribedMatchId;
    this.forgetWorld();
    if (leaving !== null) this.transport.unsubscribe(gameParams(leaving));
    if (this.ownsTransport) this.transport.close();
    this.started = false;
    this.setState("closed");
  }

  /** `disconnect`, then drop every event handler and release the emitter. */
  dispose(): void {
    this.disconnect();
    this.events.removeAll();
  }

  /* ------------------------------------------------------------- game loop */

  /**
   * Drives prediction, metrics and the send cap. Call once per animation frame
   * with that frame's delta in milliseconds.
   */
  tick(deltaMs: number): void {
    this.metrics.recordFrame(deltaMs);
    this.simAccumulatorMs += Math.max(0, deltaMs);
    const ticks = Math.floor(this.simAccumulatorMs / TICK_MS);
    if (ticks > 0) {
      this.simAccumulatorMs -= ticks * TICK_MS;
      this.prediction()?.update(ticks);
    }
    // A backgrounded tab can starve the flush timer; catch up here too.
    if (this.outbound.length > 0 && Date.now() - this.lastFlushAtMs >= this.flushIntervalMs) {
      this.flush();
    }
  }

  /**
   * The entity table to draw, with local prediction folded in: an own unit
   * still running an order the server has not echoed is drawn where this
   * client has walked it, not where the last snapshot left it. Every other
   * entity is the server's, untouched.
   *
   * This is what puts prediction on the screen. The renderer then blends
   * between successive calls, so an own unit starts walking on the frame
   * after the click rather than after the server has answered — and snaps back
   * only if the server genuinely disagrees.
   *
   * Returns the input array unchanged when there is nothing to predict, so a
   * match with no local orders allocates nothing here.
   */
  predictedEntities(entities: readonly ProtocolEntity[]): readonly ProtocolEntity[] {
    const predictor = this.predictor;
    if (!predictor) return entities;

    let out: ProtocolEntity[] | null = null;
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (entity.pl !== predictor.playerId) continue;
      const unit = predictor.predicted(entity.id);
      // Only a unit running an order the server has not echoed is overridden.
      // Once the snapshot answers, the server's own position is both
      // authoritative and already being extrapolated by the renderer, and
      // predicting on top of that would make own units lead their own echo.
      if (!unit || unit.localOrderTick === 0 || unit.st === "dead") continue;
      if (out === null) out = entities.slice();
      out[i] = { ...entity, x: unit.x, z: unit.z, ang: unit.ang, st: unit.st };
    }
    return out ?? entities;
  }

  /* --------------------------------------------------------------- inbound */

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case "game:start":
        this.onGameStart(msg);
        break;
      case "game:snapshot":
        this.onGameSnapshot(msg);
        break;
      case "game:reject":
        this.events.emit("reject", { rejections: msg.rejected, batchId: null });
        break;
      case "game:ended":
        this.cancelCountdown();
        this.cancelFlush();
        this.setState("ended");
        this.events.emit("end", msg);
        break;
      case "error":
        if (msg.fatal) {
          this.reconnect.stop();
          this.setState("closed");
        }
        this.emitError(msg.code, msg.message, msg.fatal);
        break;
      case "lobby:state":
        // The lobby client owns this; the game screen ignores it.
        break;
      case "lobby:chat":
        // The backlog plus any new line, so a late joiner renders in one go.
        for (const line of msg.lines) this.events.emit("chat", line);
        break;
    }
  }

  private onGameStart(msg: GameStartMessage): void {
    this.startInfo = msg;
    this.currentMatchId = msg.match_id;
    this.snapshots.clear();
    this.metrics.reset();
    this.predictor?.reset();
    if (this.localPlayerId === null) this.localPlayerId = ownPlayerId(msg);
    this.setState("countdown");
    this.cancelCountdown();
    if (msg.countdown_ms > 0) {
      this.countdownHandle = this.timer.set(() => {
        this.countdownHandle = null;
        if (this.currentState === "countdown") this.setState("running");
      }, msg.countdown_ms);
    } else {
      this.setState("running");
    }
    this.events.emit("start", msg);
    this.flush();
  }

  private onGameSnapshot(msg: GameSnapshotMessage): void {
    const receivedAt = Date.now();
    const snapshot: Snapshot = {
      tick: msg.tick,
      server_ms: msg.server_ms,
      ack: msg.ack,
      entities: msg.entities,
      events: msg.events,
    };
    this.lastSnapshot = this.snapshots.push(snapshot, receivedAt);
    this.updateClock(msg.server_ms, receivedAt);
    this.metrics.recordSnapshot(receivedAt, estimateBytes(msg));
    this.metrics.recordAck(msg.ack, receivedAt);
    const predictor = this.prediction();
    if (predictor) {
      predictor.applySnapshot(snapshot);
      const correction = predictor.lastCorrection();
      if (correction.tick === msg.tick) this.metrics.recordPredictionError(correction.errorMetres);
    }
    this.events.emit("snapshot", msg);
  }

  private onServerDisconnect(info: ServerDisconnect): void {
    // `reconnect: false` is the server refusing this connection for good;
    // retrying it would fail identically forever.
    if (!info.reconnect) {
      this.reconnect.stop();
      this.intentionalClose = true;
      this.setState("closed");
      this.emitError("server_error", `the server closed the cable: ${info.reason}`, true);
      return;
    }
    this.emitError("server_error", `the server closed the cable: ${info.reason}`, false);
  }

  private onTransportState(state: TransportState): void {
    if (this.intentionalClose) return;
    if (state === "connected") {
      this.dropPending = false;
      this.reconnect.notifyConnected();
      // A controller-driven reconnect re-subscribes from the resync, once the
      // stale world has been thrown away; doing it here would subscribe twice.
      if (this.reconnect.recovering) return;
      if (this.currentState === "connecting" || this.currentState === "reconnecting") {
        this.subscribeAll();
        this.setState("waiting");
      }
      return;
    }
    if (state === "reconnecting" || state === "closed") {
      if (this.dropPending || this.currentState === "closed") return;
      this.dropPending = true;
      this.setState("reconnecting");
      this.reconnect.notifyLoss();
    }
  }

  /* -------------------------------------------------------------- outbound */

  /**
   * Subscribes to what this connection needs and identifies on the game
   * channel. Idempotent: the transport is shared with the lobby, the transport
   * replays subscriptions on every welcome, and `connect()` may be called on an
   * already-open cable — so this must be safe to call again rather than
   * sending a second subscribe for the same identifier.
   */
  private subscribeAll(): void {
    if (!this.lobbySubscribed) {
      this.lobbySubscribed = true;
      this.transport.subscribe(lobbyParams());
    }
    const matchId = this.currentMatchId;
    if (matchId === null || this.subscribedMatchId === matchId) return;
    this.subscribedMatchId = matchId;
    const params = gameParams(matchId);
    this.transport.subscribe(params);
    this.transport.identify(params);
  }

  /**
   * Writes the buffered commands as one or more `game:command` batches. Move
   * orders from the same frame are merged by destination, so a 200-unit order
   * costs one command rather than two hundred.
   */
  private flush(): void {
    this.cancelFlush();
    if (this.outbound.length === 0) return;
    if (!this.started || this.startInfo === null) return; // buffered until the match opens
    if (this.currentState === "ended" || this.currentState === "closed") {
      this.outbound.length = 0;
      return;
    }

    const flat: Command[] = [];
    for (const batch of this.outbound) flat.push(...batch.commands);
    this.outbound.length = 0;
    const coalesced = this.coalesce(flat);

    for (let i = 0; i < coalesced.length; i += this.maxCommandsPerBatch) {
      const fromTick = this.serverTick;
      const message: ClientMessage = {
        v: PROTOCOL_VERSION,
        t: "game:command",
        id: this.uuid(),
        from_tick: fromTick,
        commands: coalesced.slice(i, i + this.maxCommandsPerBatch),
      };
      this.transport.send(message);
      this.metrics.recordCommandSent(fromTick);
    }
    this.lastFlushAtMs = Date.now();
  }

  /** Merges move orders sharing a destination, respecting the id cap. */
  private coalesce(commands: Command[]): Command[] {
    const out: Command[] = [];
    for (const command of commands) {
      if (command.c !== "move") {
        out.push(command);
        continue;
      }
      const queue = command.queue ?? false;
      const existing = out.find(
        (candidate): candidate is Extract<Command, { c: "move" }> =>
          candidate.c === "move" &&
          candidate.x === command.x &&
          candidate.z === command.z &&
          (candidate.queue ?? false) === queue &&
          candidate.ids.length + command.ids.length <= this.maxIdsPerCommand,
      );
      if (existing) {
        for (const id of command.ids) existing.ids.push(id);
        continue;
      }
      out.push({ ...command, ids: [...command.ids] });
    }
    return out;
  }

  private armFlush(): void {
    if (this.flushHandle !== null) return;
    const wait = Math.max(0, this.flushIntervalMs - (Date.now() - this.lastFlushAtMs));
    this.flushHandle = this.timer.set(() => {
      this.flushHandle = null;
      this.flush();
      if (this.outbound.length > 0) this.armFlush();
    }, wait);
  }

  private cancelFlush(): void {
    if (this.flushHandle === null) return;
    this.timer.clear(this.flushHandle);
    this.flushHandle = null;
  }

  private cancelCountdown(): void {
    if (this.countdownHandle === null) return;
    this.timer.clear(this.countdownHandle);
    this.countdownHandle = null;
  }

  /* ---------------------------------------------------------------- limits */

  /** Drops malformed or over-sized commands, reporting what went. */
  private sanitize(commands: Command[]): Command[] {
    const accepted: Command[] = [];
    for (const command of commands) {
      const normalized = this.normalize(command);
      if (normalized) accepted.push(normalized);
    }
    return accepted.slice(0, this.maxCommandsPerBatch);
  }

  private normalize(command: Command): Command | null {
    if (command.c === "chat") {
      const text = command.text.slice(0, MAX_CHAT_LENGTH);
      return text.length === 0 ? null : { c: "chat", text };
    }
    if ("ids" in command) {
      const ids = Array.isArray(command.ids) ? command.ids.filter((id) => Number.isInteger(id) && id > 0) : [];
      if (ids.length === 0) return null;
      if (ids.length > this.maxIdsPerCommand) {
        this.emitError(
          "invalid_command",
          `${command.c} carried ${ids.length} ids; capped at ${this.maxIdsPerCommand}`,
          false,
        );
      }
      return { ...command, ids: ids.slice(0, this.maxIdsPerCommand) } as Command;
    }
    const owner = "building_id" in command ? command.building_id : "worker_id" in command ? command.worker_id : null;
    return owner !== null && !Number.isInteger(owner) ? null : command;
  }

  /** Fixed-window bucket over command count. */
  private consumeRateBudget(count: number): boolean {
    const now = Date.now();
    if (now - this.rateWindowStartMs >= 1000) {
      this.rateWindowStartMs = now;
      this.rateWindowCount = 0;
    }
    if (this.rateWindowCount + count > this.maxCommandsPerSecond) return false;
    this.rateWindowCount += count;
    return true;
  }

  /* ------------------------------------------------------------- internals */

  /** Lazily built, because the player id is unknown until the match opens. */
  private prediction(): MovementPredictor | null {
    if (this.localPlayerId === null) return null;
    if (!this.predictor) {
      this.predictor = new MovementPredictor({ playerId: this.localPlayerId, terrain: this.terrain });
    }
    return this.predictor;
  }


  private updateClock(serverMs: number, receivedAtMs: number): void {
    // One-way delay is half the round trip, so the server clock at *arrival* was
    // `serverMs - rtt/2`; the offset from ours is that minus our own clock.
    const offset = serverMs - this.rttMs / 2 - receivedAtMs;
    if (Number.isNaN(this.clockOffsetMs) || Math.abs(offset - this.clockOffsetMs) > 1000) {
      // First sample, or a jump too big to be jitter — a reconnect.
      this.clockOffsetMs = offset;
      return;
    }
    this.clockOffsetMs += (offset - this.clockOffsetMs) * 0.1;
  }

  /**
   * The resync path. Everything describing the pre-drop world is discarded —
   * snapshots, predictions, unacknowledged commands and the clock estimate —
   * before the fresh `game:start` and snapshot stream arrive. That is what
   * guarantees no ghost entities: the buffer is empty and the predictor has
   * forgotten every unit, so the next frame draws nothing until real data
   * lands.
   */
  private resync(): void {
    this.forgetWorld();
    this.subscribeAll();
    this.setState("waiting");
  }

  private forgetWorld(): void {
    this.subscribedMatchId = null;
    this.lobbySubscribed = false;
    this.snapshots.clear();
    this.predictor?.reset();
    this.metrics.reset();
    this.outbound.length = 0;
    this.lastSnapshot = null;
    this.startInfo = null;
    this.simAccumulatorMs = 0;
    this.clockOffsetMs = Number.NaN;
  }

  private setState(state: GameConnectionState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.events.emit("stateChange", state);
  }

  private emitError(code: ConnectionErrorCode, message: string, fatal: boolean): void {
    this.events.emit("error", { code, message, fatal });
  }
}

function defaultUuid(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  let out = "";
  while (out.length < 32) out += Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return out.slice(0, 32);
}

/** Rough serialised cost of one entity and one event, for the bandwidth series. */
const ENTITY_FRAME_BYTES = 96;
const EVENT_FRAME_BYTES = 48;

/** Rough serialised size of a snapshot, for the bandwidth series. */
function estimateBytes(msg: GameSnapshotMessage): number {
  return msg.entities.length * ENTITY_FRAME_BYTES + msg.events.length * EVENT_FRAME_BYTES;
}

/** The local player's id from a `game:start` roster, or null when unknowable. */
function ownPlayerId(msg: GameStartMessage): number | null {
  return msg.players.length === 1 ? msg.players[0].player_id : null;
}

