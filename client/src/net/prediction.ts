/**
 * Local movement prediction for the player's own units — and nothing else.
 *
 * ## Why this file is small
 *
 * The server is authoritative and the client deliberately does **not** port the
 * server simulation to TypeScript. A full local sim would duplicate the damage,
 * economy, production and pathing rules, guarantee drift from the Ruby side the
 * moment either changes, and buy nothing: the snapshot already lands 50–100 ms
 * after the tick it describes. This module predicts only the local feedback a
 * player can actually feel — *my unit starts walking the instant I
 * right-click* — and reconciles that against every snapshot.
 *
 * Consequences of that choice, all deliberate:
 *
 * - Only entities owned by the local player are tracked; a snapshot is the sole
 *   source of truth for everyone else.
 * - Only `move` and `stop` orders are predicted. Attack, harvest and production
 *   resolve on the server, where their latency is masked by the snapshot anyway.
 * - Movement integrates in fixed `TICK_MS` steps, matching the server's step
 *   order (PROTOCOL.md §6), clamped to the unit's roster speed and to passable
 *   ground, so a prediction can never outrun what the server would do.
 * - Facing uses the server's convention, `atan2(dx, dz)`, because
 *   `Systems::Movement` does and three.js maps `rotation.y` onto `(sin θ, cos θ)`
 *   with forward `+Z`. Any other mapping turns a predicted unit 90° off on the
 *   axes, and the error only shows when the unit's path lies on one.
 * - A local order is retired when the *server's own snapshot* reports a move
 *   order for that unit, which is a genuinely per-client signal. It is
 *   deliberately not retired on the envelope's `ack`: that field is the
 *   highest `from_tick` processed for *any* client in the match
 *   (PROTOCOL.md §5), so a client at 950 reading 1000 because somebody else
 *   got there first would throw away clicks the server has never seen.
 * - An order the server never echoes is given up on after
 *   {@link MovementPredictorOptions.orderTimeoutMs}, so a lost send retires
 *   the order instead of walking a unit across the map forever.
 */
import { TICK_MS } from "@shared/protocol";
import type { Command, EntityState, OrderKind, ProtocolEntity } from "@shared/protocol";
import { entityDef, hasEntityDef } from "@shared/gameData";
import type { Snapshot } from "./snapshotBuffer";

/** Where a predicted unit is heading, on the ground plane (x/z). */
export interface PendingOrder {
  x: number;
  z: number;
}

/** A batch the server has not acknowledged yet. */
export interface UnacknowledgedCommand {
  id: string;
  fromTick: number;
  commands: Command[];
  sentAtMs: number;
}

/** Per-unit prediction state for one locally-owned entity. */
export interface PredictedUnit {
  id: number;
  ty: string;
  /** Ground-plane X. */
  x: number;
  /** Ground-plane Z — the wire's second ground axis (three.js Z). */
  z: number;
  /** World height. The server owns this; prediction never recomputes it. */
  y: number;
  ang: number;
  /** Server-reported health, carried through so the HUD need not re-read. */
  hp: number;
  st: EntityState;
  /** Roster speed in m/s. Read from game-data, never hard-coded. */
  speed: number;
  radius: number;
  air: boolean;
  order: PendingOrder | null;
  orderKind: OrderKind;
  /**
   * `from_tick` of the local batch that issued {@link order}, or 0 when the
   * order came from the server. The server confirming *any* order for this
   * unit is what retires the local one, so this is the whole of the
   * unacknowledged-command bookkeeping — there is no per-batch map to keep.
   */
  localOrderTick: number;
  /** When that batch went out, for the give-up timeout. */
  localOrderAtMs: number;
  /** Ticks since the unit last moved; lets callers park an idle unit. */
  stalledTicks: number;
}

export interface MovementPredictorOptions {
  /** Player id whose units are predicted. */
  playerId: number;
  /** World extent clamp in metres. Defaults to the protocol world size. */
  worldSize?: number;
  /** Ground/wall queries. Absent means flat, always-passable ground. */
  terrain?: TerrainProbe;
  /** Positional disagreement beyond this snaps to the server, in metres. */
  snapThreshold?: number;
  /** Give up on a local order the server never echoes, after this long, ms. */
  orderTimeoutMs?: number;
}

/**
 * The slice of the height field the predictor needs. `HeightField` from
 * `@render/terrain/heightfield` satisfies it structurally, so the render slice
 * can hand its cached field straight in without the netcode importing three.js.
 */
export interface TerrainProbe {
  passable(x: number, z: number): boolean;
  sample(x: number, z: number): number;
}

export const DEFAULT_SNAP_THRESHOLD_M = 1.25;
export const DEFAULT_ORDER_TIMEOUT_MS = 3000;
/** PROTOCOL.md §4: the world is 0 ≤ x, z < 256. */
const PROTOCOL_WORLD_SIZE = 256;
/** Arrival tolerance, in metres, before a unit is considered stopped. */
const ARRIVAL_EPSILON = 0.02;
/** Cap on catch-up substeps so a long stall cannot spin the predictor. */
const MAX_CATCHUP_TICKS = 8;

export class MovementPredictor {
  readonly playerId: number;
  readonly snapThreshold: number;
  private readonly worldSize: number;
  private readonly terrain: TerrainProbe | null;
  private readonly orderTimeoutMs: number;
  private readonly units = new Map<number, PredictedUnit>();
  private correctionPending = false;
  private lastCorrectionTick = 0;
  private lastErrorMetres = 0;
  private tickCursor = 0;

  constructor(options: MovementPredictorOptions) {
    this.playerId = options.playerId;
    this.worldSize = options.worldSize ?? PROTOCOL_WORLD_SIZE;
    this.terrain = options.terrain ?? null;
    this.snapThreshold = options.snapThreshold ?? DEFAULT_SNAP_THRESHOLD_M;
    this.orderTimeoutMs = options.orderTimeoutMs ?? DEFAULT_ORDER_TIMEOUT_MS;
  }

  /** Units currently predicted, keyed by entity id. */
  predictions(): ReadonlyMap<number, PredictedUnit> {
    return this.units;
  }

  predicted(id: number): PredictedUnit | null {
    return this.units.get(id) ?? null;
  }

  /**
   * Advances `unit` toward `(x, z)` by at most `speed * dt`, returns the
   * distance actually covered, and clears the order on arrival. Allocation-free.
   */
  predictMove(unit: PredictedUnit, x: number, z: number, dt: number): number {
    const stepSeconds = Math.max(0, dt) / 1000;
    if (stepSeconds <= 0) return 0;
    const maxStep = Math.max(0, unit.speed) * stepSeconds;

    const targetX = clamp(x, 0, this.worldSize);
    const targetZ = clamp(z, 0, this.worldSize);
    const dx = targetX - unit.x;
    const dz = targetZ - unit.z;
    const distance = Math.hypot(dx, dz);
    if (distance <= ARRIVAL_EPSILON) {
      unit.x = targetX;
      unit.z = targetZ;
      this.clearOrder(unit);
      unit.st = "idle";
      unit.stalledTicks++;
      return 0;
    }

    const inv = 1 / distance;
    const ux = dx * inv;
    const uz = dz * inv;
    const travel = Math.min(maxStep, distance);
    const moved = this.advance(unit, ux * travel, uz * travel, unit.air);
    // The server's convention, not the intuitive one: `Systems::Movement` sets
    // `angle = atan2(dx, dz)`, and three.js turns `rotation.y` into the
    // heading `(sin θ, cos θ)` with `+Z` forward. `atan2(dz, dx)` would face a
    // predicted unit 90° off on both axes, and look right only on a diagonal.
    unit.ang = Math.atan2(ux, uz);
    if (moved > ARRIVAL_EPSILON) {
      unit.st = "moving";
      unit.stalledTicks = 0;
    } else {
      // Blocked on every axis: the order is unreachable, so drop it.
      unit.st = "idle";
      this.clearOrder(unit);
      unit.stalledTicks++;
    }
    return moved;
  }

  /**
   * Applies a locally-issued batch immediately so the unit starts walking
   * before the server has seen anything, and returns the batch so the caller
   * can put it on the wire.
   *
   * The batch is not filed anywhere here. What has to survive is only *which
   * of our units is running an order the server has not echoed*, and that is
   * per-unit state — so the units carry it and a lost or replayed batch
   * cannot desynchronise a map keyed by `from_tick`.
   */
  queueCommand(commands: Command[], fromTick: number, id = `local-${fromTick}`): UnacknowledgedCommand {
    const batch: UnacknowledgedCommand = { id, fromTick, commands, sentAtMs: Date.now() };
    for (const command of commands) {
      if (command.c === "move") this.issueMove(command.ids, command.x, command.z, fromTick, batch.sentAtMs);
      else if (command.c === "stop" || command.c === "hold") this.issueStop(command.ids);
    }
    return batch;
  }

  /**
   * True when the last snapshot forced a hard correction. A pure query — the
   * caller decides whether to log it, flash, or ignore it.
   */
  needsCorrection(): boolean {
    return this.correctionPending;
  }

  /** Reads and clears the correction flag. */
  consumeCorrection(): boolean {
    const pending = this.correctionPending;
    this.correctionPending = false;
    return pending;
  }

  /** Tick of the last forced snap and how far off we were, or zeroes. */
  lastCorrection(): { tick: number; errorMetres: number } {
    return { tick: this.lastCorrectionTick, errorMetres: this.lastErrorMetres };
  }

  /**
   * Folds a server snapshot into the prediction. Own units re-base onto the
   * server's position; entities the player no longer owns are dropped, which is
   * what stops a reconnect from leaving ghosts on screen.
   */
  applySnapshot(snapshot: Snapshot): void {
    this.tickCursor = Math.max(this.tickCursor, snapshot.tick);
    this.expireLostOrders(Date.now());

    const stillOwned = new Set<number>();
    for (const entity of snapshot.entities) {
      if (entity.pl !== this.playerId) continue;
      stillOwned.add(entity.id);
      const unit = this.units.get(entity.id);
      if (!unit) {
        this.units.set(entity.id, this.unitFromServer(entity));
        continue;
      }
      const error = Math.hypot(unit.x - entity.x, unit.z - entity.z);
      if (error > this.lastErrorMetres) this.lastErrorMetres = error;

      // The server reporting *any* order for this unit is proof it consumed a
      // command about it, so the local order is retired and the server's
      // answer is adopted — even when the answer is a different destination,
      // which is what a queued or superseded order looks like.
      const serverOrder = entity.ord ?? 0;
      if (serverOrder !== 0) {
        this.clearOrder(unit);
        unit.orderKind = serverOrder;
        unit.order = serverOrder === 1 ? { x: entity.ox ?? 0, z: entity.oz ?? 0 } : null;
      }

      // While a click is still in flight the server's position is stale by
      // construction: it describes a tick from before the server had the
      // order. Re-basing onto it on every snapshot would throw the lead away
      // and leave prediction with nothing to show, so the local position
      // stands — and only a disagreement past the snap threshold (a push, a
      // teleport, an order the server refused) pulls it back.
      const unconfirmed = unit.localOrderTick > 0;
      if (!unconfirmed || error > this.snapThreshold) {
        unit.x = entity.x;
        unit.z = entity.z;
        unit.y = entity.y;
        unit.ang = entity.ang;
        unit.st = entity.st;
        if (error > this.snapThreshold) {
          // The server disagreed materially: the re-base above *is* the snap.
          this.correctionPending = true;
          this.lastCorrectionTick = snapshot.tick;
          this.lastErrorMetres = error;
        }
      }
      unit.hp = entity.hp;
      if (!unconfirmed && serverOrder === 0) {
        unit.order = null;
        unit.orderKind = 0;
      }
    }

    for (const id of this.units.keys()) {
      if (!stillOwned.has(id)) this.units.delete(id);
    }
  }

  /**
   * Advances every pending order by whole server ticks. Call it once per tick
   * of simulated time; `ticks` lets a stutter catch up in bounded steps.
   */
  update(ticks = 1): void {
    const steps = Math.max(0, Math.min(MAX_CATCHUP_TICKS, Math.floor(ticks)));
    for (let s = 0; s < steps; s++) {
      for (const unit of this.units.values()) {
        if (!unit.order || unit.st === "dead") continue;
        this.predictMove(unit, unit.order.x, unit.order.z, TICK_MS);
      }
    }
  }

  /** Forgets every unit and correction — used on disconnect. */
  reset(): void {
    this.units.clear();
    this.correctionPending = false;
    this.lastCorrectionTick = 0;
    this.lastErrorMetres = 0;
    this.tickCursor = 0;
  }

  /* ------------------------------------------------------------- internals */

  private issueMove(ids: number[], x: number, z: number, fromTick: number, sentAtMs: number): void {
    const targetX = clamp(x, 0, this.worldSize);
    const targetZ = clamp(z, 0, this.worldSize);
    for (const id of ids) {
      const unit = this.units.get(id);
      if (!unit || unit.st === "dead") continue;
      unit.order = { x: targetX, z: targetZ };
      unit.orderKind = 1;
      unit.localOrderTick = fromTick;
      unit.localOrderAtMs = sentAtMs;
      unit.st = "moving";
    }
  }

  private issueStop(ids: number[]): void {
    for (const id of ids) {
      const unit = this.units.get(id);
      if (!unit) continue;
      this.clearOrder(unit);
      if (unit.st !== "dead") unit.st = "idle";
    }
  }

  /**
   * Forgets an order outright — destination, kind, and the stamp of the batch
   * that issued it. Every path that ends a local order goes through here, so
   * "is this unit running an order the server has not seen" is one field
   * rather than a table that can drift out of step with it.
   */
  private clearOrder(unit: PredictedUnit): void {
    unit.order = null;
    unit.orderKind = 0;
    unit.localOrderTick = 0;
    unit.localOrderAtMs = 0;
  }

  /**
   * Gives up on orders the server never echoed within the timeout. A send that
   * never reached the server would otherwise walk a unit across the map for
   * the rest of the match on the strength of a click that was lost.
   */
  private expireLostOrders(nowMs: number): void {
    for (const unit of this.units.values()) {
      if (unit.localOrderTick === 0) continue;
      if (nowMs - unit.localOrderAtMs <= this.orderTimeoutMs) continue;
      this.clearOrder(unit);
      if (unit.st !== "dead") unit.st = "idle";
    }
  }

  private advance(unit: PredictedUnit, dx: number, dz: number, air: boolean): number {
    // Air units ignore the ground probe; ground units slide along whichever
    // axis is still passable, and stop dead when neither is.
    const candidates: [number, number][] = [[dx, dz], [dx, 0], [0, dz]];
    for (const [mx, mz] of candidates) {
      if (air && (mx !== dx || mz !== dz)) continue;
      if (mx === 0 && mz === 0) continue;
      const nx = clamp(unit.x + mx, 0, this.worldSize);
      const nz = clamp(unit.z + mz, 0, this.worldSize);
      if (!this.canStand(nx, nz, unit.radius, air)) continue;
      const moved = Math.hypot(nx - unit.x, nz - unit.z);
      unit.x = nx;
      unit.z = nz;
      // The server owns height; the local field only keeps a predicted unit
      // glued to the ground between snapshots.
      if (this.terrain && !air) unit.y = this.terrain.sample(nx, nz);
      return moved;
    }
    return 0;
  }

  private canStand(x: number, z: number, radius: number, air: boolean): boolean {
    if (air || !this.terrain) return true;
    // A unit is a disc, not a point: probe the centre and all four flanks.
    if (this.terrain.passable(x, z)) return true;
    if (radius <= 0) return false;
    return (
      this.terrain.passable(x + radius, z) ||
      this.terrain.passable(x - radius, z) ||
      this.terrain.passable(x, z + radius) ||
      this.terrain.passable(x, z - radius)
    );
  }

  private unitFromServer(entity: ProtocolEntity): PredictedUnit {
    const def = hasEntityDef(entity.ty) ? entityDef(entity.ty) : null;
    const unit: PredictedUnit = {
      id: entity.id,
      ty: entity.ty,
      x: entity.x,
      z: entity.z,
      y: entity.y,
      ang: entity.ang,
      hp: entity.hp,
      st: entity.st,
      speed: def && def.kind === "unit" ? def.speed : 0,
      radius: def?.size.radius ?? 0.5,
      air: def?.kind === "unit" ? def.movement === "air" : false,
      order: null,
      orderKind: entity.ord ?? 0,
      localOrderTick: 0,
      localOrderAtMs: 0,
      stalledTicks: 0,
    };
    if (unit.orderKind === 1) unit.order = { x: entity.ox ?? 0, z: entity.oz ?? 0 };
    return unit;
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
