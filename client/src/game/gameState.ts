/**
 * Live match state — the single mutable source of truth for one running game.
 *
 * Everything here is derived from exactly two wire messages, `game:start` and
 * `game:snapshot`, because the server is authoritative (see docs/PROTOCOL.md
 * §5). No DOM, no three.js, no timers: the class is a synchronous value holder
 * so a test can drive it with two snapshots and assert on the result.
 *
 * Snapshots are *full table* broadcasts, not deltas, so applying one replaces
 * the entity set wholesale — an id absent from the newest snapshot is gone.
 * Only strictly newer ticks are accepted; a late or duplicated snapshot never
 * rewinds the world.
 *
 * Two quantities are not on the wire at all and are therefore derived from the
 * shared roster rather than guessed:
 *
 * - **supply / supply cap** — the entity record carries no supply field, so
 *   the used amount is the sum of the roster costs of our own units (buildings
 *   under construction count, matching the server reserving supply the moment
 *   a placement is accepted) and the cap is the base supply plus the
 *   `supply_provided` of our own completed buildings.
 * - **minerals / vespene** — the server echoes one spendable balance per player
 *   on that player's own entities (`res`, PROTOCOL.md §5). The split is
 *   attributed, not simulated: cargo deliveries arrive as `res` events with an
 *   exact amount, so whatever growth those events do not explain is geyser
 *   income. The two
 *   numbers always sum back to the echoed balance, and the server still has
 *   the last word — an over-spend comes back as an `insufficient_resources`
 *   rejection.
 */
import { GAME, entityDef, hasEntityDef, isBuilding } from "@shared/gameData";
import type { GameEvent, ProtocolEntity, Race, ServerMessage } from "@shared/protocol";

export type StartMessage = Extract<ServerMessage, { t: "game:start" }>;
export type EndMessage = Extract<ServerMessage, { t: "game:ended" }>;
export type SnapshotPayload = {
  tick: number;
  entities: readonly ProtocolEntity[];
  events?: readonly GameEvent[];
};

export type Relation = "own" | "ally" | "enemy";

/** One seat as `game:start` announced it. */
export interface PlayerInfo {
  playerId: number;
  slot: number;
  race: Race;
  name: string;
  team: number;
}

export class GameState {
  private readonly byId = new Map<number, ProtocolEntity>();
  private readonly teamOf = new Map<number, number>();
  private readonly infoOf = new Map<number, PlayerInfo>();

  private _myPlayerId: number;
  private _tick = 0;
  private _started = false;
  private _finished = false;
  private _end: EndMessage | null = null;
  private _matchId = 0;
  private _mapId = "";
  private _countdownMs = 0;
  private _lastAck = 0;

  private selectionIds: number[] = [];

  /** Echoed spendable balance for my player, and its attributed split. */
  private echoBalance = 0;
  private hasEcho = false;
  private vespeneEcho = 0;

  /** Cached projections, rebuilt only when a newer tick lands. */
  private cachedTick = -1;
  private cachedAll: ProtocolEntity[] = [];
  private cachedOwn: ProtocolEntity[] = [];

  constructor(myPlayerId = 0) {
    this._myPlayerId = myPlayerId;
  }

  /* ------------------------------------------------------------------ inputs */

  start(payload: StartMessage): void {
    this.byId.clear();
    this.teamOf.clear();
    this.infoOf.clear();
    this.selectionIds = [];
    this._tick = 0;
    this._lastAck = 0;
    this._started = true;
    this._finished = false;
    this._end = null;
    this._matchId = payload.match_id;
    this._mapId = payload.map_id;
    this._countdownMs = payload.countdown_ms;
    this.echoBalance = 0;
    this.hasEcho = false;
    this.vespeneEcho = 0;
    this.cachedTick = -1;
    this.cachedAll = [];
    this.cachedOwn = [];
    for (const p of payload.players) {
      this.teamOf.set(p.player_id, p.team);
      this.infoOf.set(p.player_id, {
        playerId: p.player_id,
        slot: p.slot,
        race: p.race,
        name: p.name,
        team: p.team,
      });
    }
  }

  applySnapshot(snapshot: SnapshotPayload): void {
    // `_finished` matters as much as `_started`: a snapshot still in flight
    // when `game:ended` lands would otherwise revive the world, putting back
    // entities the server had already removed underneath the results screen.
    if (!this._started || this._finished) return;
    if (snapshot.tick < this._tick) return;

    this._tick = snapshot.tick;
    this.byId.clear();
    let balance = 0;
    let sawBalance = false;
    for (const e of snapshot.entities) {
      this.byId.set(e.id, e);
      if (e.pl === this._myPlayerId && e.res !== undefined) {
        balance = e.res;
        sawBalance = true;
      }
    }
    this.splitResources(snapshot.events, balance, sawBalance);
  }

  end(payload: EndMessage): void {
    this._finished = true;
    this._end = payload;
    this._tick = payload.tick;
  }

  /** Clears everything; the instance is reusable for the next match. */
  dispose(): void {
    this.byId.clear();
    this.teamOf.clear();
    this.infoOf.clear();
    this.selectionIds = [];
    this._started = false;
    this._finished = false;
    this._end = null;
    this._matchId = 0;
    this._mapId = "";
    this._countdownMs = 0;
    this._tick = 0;
    this._lastAck = 0;
    this.echoBalance = 0;
    this.hasEcho = false;
    this.vespeneEcho = 0;
    this.cachedAll = [];
    this.cachedOwn = [];
    this.cachedTick = -1;
  }

  /* ------------------------------------------------------------------ readouts */

  get matchId(): number {
    return this._matchId;
  }

  get mapId(): string {
    return this._mapId;
  }

  get myPlayerId(): number {
    return this._myPlayerId;
  }

  get tick(): number {
    return this._tick;
  }

  get started(): boolean {
    return this._started;
  }

  get finished(): boolean {
    return this._finished;
  }

  get countdownMs(): number {
    return this._countdownMs;
  }

  /**
   * The highest `from_tick` the server has processed for *any* client in this
   * match. The snapshot is one broadcast (PROTOCOL.md §5), so this is a
   * match-wide progress figure and must never be used to retire this client's
   * own unacknowledged commands — see `MovementPredictor`.
   */
  get ack(): number {
    return this._lastAck;
  }

  get endPayload(): EndMessage | null {
    return this._end;
  }

  get players(): PlayerInfo[] {
    const out: PlayerInfo[] = [];
    for (const info of this.infoOf.values()) out.push(info);
    out.sort((a, b) => a.slot - b.slot);
    return out;
  }

  entity(id: number): ProtocolEntity | undefined {
    return this.byId.get(id);
  }

  entities(): ProtocolEntity[] {
    if (this.cachedTick !== this._tick) this.rebuild();
    return this.cachedAll;
  }

  ownEntities(): ProtocolEntity[] {
    if (this.cachedTick !== this._tick) this.rebuild();
    return this.cachedOwn;
  }

  entitiesOf(playerId: number): ProtocolEntity[] {
    const out: ProtocolEntity[] = [];
    for (const e of this.byId.values()) if (e.pl === playerId) out.push(e);
    return out;
  }

  relationTo(id: number): Relation {
    const e = this.byId.get(id);
    if (!e) return "enemy";
    return this.relationOfPlayer(e.pl);
  }

  /** How my player relates to a player id, from the `team` in `game:start`. */
  relationOfPlayer(playerId: number): Relation {
    if (playerId === this._myPlayerId) return "own";
    return this.teamOf.get(playerId) === this.teamOf.get(this._myPlayerId) ? "ally" : "enemy";
  }

  isOwner(id: number): boolean {
    const e = this.byId.get(id);
    return e !== undefined && e.pl === this._myPlayerId;
  }

  playerInfo(playerId: number): PlayerInfo | undefined {
    return this.infoOf.get(playerId);
  }

  raceOf(playerId: number): Race | undefined {
    return this.infoOf.get(playerId)?.race;
  }

  /** Own-unit spendable pool, as echoed by the server. */
  minerals(): number {
    return Math.max(0, Math.round(this.echoBalance - this.vespeneEcho));
  }

  /** Vespene share of the echoed balance; see the header note on attribution. */
  vespene(): number {
    return Math.max(0, Math.round(this.vespeneEcho));
  }

  /**
   * Supply used, mirroring the server's accounting pass exactly: the roster
   * `supply` cost of our own living units. Buildings cost no supply, and a
   * half-built one had its reservation taken the moment it was placed (see the
   * server's `spawn_entity` and `Systems::Accounting`).
   */
  supply(): number {
    let used = 0;
    for (const e of this.ownEntities()) {
      if (e.st === "dead" || !hasEntityDef(e.ty) || isBuilding(e.ty)) continue;
      used += entityDef(e.ty).cost.supply;
    }
    return used;
  }

  /** Base supply plus what our own finished buildings provide. */
  supplyMax(): number {
    let cap = GAME.base_supply;
    for (const e of this.ownEntities()) {
      if (e.st === "dead" || !hasEntityDef(e.ty) || !isBuilding(e.ty)) continue;
      if ((e.prog ?? 1) < 1) continue;
      cap += entityDef(e.ty).cost.supply_provided ?? 0;
    }
    return cap;
  }

  selection(): number[] {
    return this.selectionIds;
  }

  setSelection(ids: readonly number[]): void {
    this.selectionIds = ids.length === 0 ? [] : ids.slice();
  }

  /* ------------------------------------------------------------------ mutation */

  /** The lobby (or a reconnect) can tell us our seat id after construction. */
  setMyPlayerId(id: number): void {
    if (id === this._myPlayerId) return;
    this._myPlayerId = id;
    this.cachedTick = -1;
  }

  setAck(ack: number): void {
    if (ack > this._lastAck) this._lastAck = ack;
  }

  /* ----------------------------------------------------------------- internals */

  private splitResources(
    events: readonly GameEvent[] | undefined,
    balance: number,
    sawBalance: boolean,
  ): void {
    if (!sawBalance) return;
    if (!this.hasEcho) {
      this.echoBalance = balance;
      this.vespeneEcho = 0;
      this.hasEcho = true;
      return;
    }
    const delta = balance - this.echoBalance;
    if (delta > 0 && events) {
      let delivered = 0;
      for (const ev of events) {
        if (ev.e === "res" && ev.pl === this._myPlayerId) delivered += ev.amount;
      }
      this.vespeneEcho += Math.max(0, delta - delivered);
    }
    this.echoBalance = balance;
  }

  private rebuild(): void {
    const all: ProtocolEntity[] = [];
    const own: ProtocolEntity[] = [];
    for (const e of this.byId.values()) {
      all.push(e);
      if (e.pl === this._myPlayerId) own.push(e);
    }
    this.cachedAll = all;
    this.cachedOwn = own;
    this.cachedTick = this._tick;
  }
}
