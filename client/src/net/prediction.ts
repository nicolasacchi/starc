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
 * - An unacknowledged batch is kept keyed by `from_tick` until a snapshot's
 *   `ack` covers it. If the predicted position has drifted past
 *   {@link MovementPredictorOptions.snapThreshold} at that point, the server
 *   disagreed with us and we snap to it rather than creep.
 *
 * Everything is bounded: the unacknowledged map holds at most
 * `maxPendingBatches` entries, oldest evicted.
 */
import { TICK_MS } from "@shared/protocol";
import type { Command, EntityState, OrderKind, ProtocolEntity } from "@shared/protocol";
import { entityDef, hasEntityDef } from "@shared/gameData";
import type { Snapshot } from "./snapshotBuffer";

/** Where a predicted unit is heading. */
export interface PendingOrder {
  x: number;
  y: number;
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
  x: number;
  y: number;
  z: number;
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
  /** How many unacknowledged batches to retain before evicting the oldest. */
  maxPendingBatches?: number;
  /** Give up on a batch the server never acknowledges after this long, ms. */
  pendingTimeoutMs?: number;
}

/**
 * The slice of the height field the predictor needs. `HeightField` from
 * `@render/terrain/heightfield` satisfies it structurally, so the render slice
 * can hand its cached field straight in without the netcode importing three.js.
 */
export interface TerrainProbe {
  passable(x: number, y: number): boolean;
  sample(x: number, y: number): number;
}

export const DEFAULT_SNAP_THRESHOLD_M = 1.25;
export const DEFAULT_PENDING_BATCHES = 64;
export const DEFAULT_PENDING_TIMEOUT_MS = 3000;
/** PROTOCOL.md §4: the world is 0 ≤ x, y < 256. */
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
  private readonly maxPendingBatches: number;
  private readonly pendingTimeoutMs: number;
  private readonly units = new Map<number, PredictedUnit>();
  /** Unacknowledged batches, keyed by the `from_tick` they were stamped with. */
  private readonly pending = new Map<number, UnacknowledgedCommand[]>();
  private correctionPending = false;
  private lastCorrectionTick = 0;
  private lastErrorMetres = 0;
  private tickCursor = 0;

  constructor(options: MovementPredictorOptions) {
    this.playerId = options.playerId;
    this.worldSize = options.worldSize ?? PROTOCOL_WORLD_SIZE;
    this.terrain = options.terrain ?? null;
    this.snapThreshold = options.snapThreshold ?? DEFAULT_SNAP_THRESHOLD_M;
    this.maxPendingBatches = Math.max(1, options.maxPendingBatches ?? DEFAULT_PENDING_BATCHES);
    this.pendingTimeoutMs = options.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS;
  }

  /** Units currently predicted, keyed by entity id. */
  predictions(): ReadonlyMap<number, PredictedUnit> {
    return this.units;
  }

  predicted(id: number): PredictedUnit | null {
    return this.units.get(id) ?? null;
  }

  /** Highest unacknowledged `from_tick`, or the last acked tick when idle. */
  pendingTick(): number {
    let highest = this.tickCursor;
    for (const tick of this.pending.keys()) if (tick > highest) highest = tick;
    return highest;
  }

  pendingCount(): number {
    let total = 0;
    for (const batch of this.pending.values()) total += batch.length;
    return total;
  }

  /**
   * Advances `unit` toward `(x, y)` by at most `speed * dt`, returns the
   * distance actually covered, and clears the order on arrival. Allocation-free.
   */
  predictMove(unit: PredictedUnit, x: number, y: number, dt: number): number {
    const stepSeconds = Math.max(0, dt) / 1000;
    if (stepSeconds <= 0) return 0;
    const maxStep = Math.max(0, unit.speed) * stepSeconds;

    const targetX = clamp(x, 0, this.worldSize);
    const targetY = clamp(y, 0, this.worldSize);
    const dx = targetX - unit.x;
    const dy = targetY - unit.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= ARRIVAL_EPSILON) {
      unit.x = targetX;
      unit.y = targetY;
      unit.order = null;
      unit.orderKind = 0;
      unit.st = "idle";
      unit.stalledTicks++;
      return 0;
    }

    const inv = 1 / distance;
    const ux = dx * inv;
    const uy = dy * inv;
    const travel = Math.min(maxStep, distance);
    const moved = this.advance(unit, ux * travel, uy * travel, unit.air);
    unit.ang = Math.atan2(uy, ux);
    if (moved > ARRIVAL_EPSILON) {
      unit.st = "moving";
      unit.stalledTicks = 0;
    } else {
      // Blocked on every axis: the order is unreachable, so drop it.
      unit.st = "idle";
      unit.order = null;
      unit.orderKind = 0;
      unit.stalledTicks++;
    }
    return moved;
  }

  /**
   * Registers a locally-issued batch keyed by the `from_tick` it was stamped
   * with, and applies its orders immediately so the unit starts walking before
   * the server has seen anything. Returns the batch for the caller to track.
   */
  queueCommand(commands: Command[], fromTick: number, id = `local-${fromTick}`): UnacknowledgedCommand {
    const batch: UnacknowledgedCommand = { id, fromTick, commands, sentAtMs: Date.now() };
    if (fromTick >= this.tickCursor) {
      const bucket = this.pending.get(fromTick);
      if (bucket) bucket.push(batch);
      else this.pending.set(fromTick, [batch]);
      while (this.pending.size > this.maxPendingBatches) {
        const oldest = this.pending.keys().next();
        if (oldest.done) break;
        this.pending.delete(oldest.value);
      }
    }
    // The order applies whether or not the server has already seen the tick:
    // the player clicked, and the unit should be moving now.
    for (const command of commands) {
      if (command.c === "move") this.issueMove(command.ids, command.x, command.y);
      else if (command.c === "stop" || command.c === "hold") this.issueStop(command.ids);
    }
    return batch;
  }

  /** Drops every batch the server has confirmed, at or below `ackTick`. */
  acknowledge(ackTick: number): void {
    this.tickCursor = Math.max(this.tickCursor, ackTick);
    for (const tick of [...this.pending.keys()]) {
      if (tick <= ackTick) this.pending.delete(tick);
    }
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
    this.acknowledge(snapshot.ack);
    this.tickCursor = Math.max(this.tickCursor, snapshot.tick);
    this.expireStaleOrders(Date.now());

    // Which of our units still have a move the server has not confirmed?
    const unacknowledged = this.unacknowledgedMoveTargets();
    const stillOwned = new Set<number>();
    for (const entity of snapshot.entities) {
      if (entity.pl !== this.playerId) continue;
      stillOwned.add(entity.id);
      const unit = this.units.get(entity.id);
      if (!unit) {
        this.units.set(entity.id, this.unitFromServer(entity));
        continue;
      }
      const error = Math.hypot(unit.x - entity.x, unit.y - entity.y);
      if (error > this.lastErrorMetres) this.lastErrorMetres = error;

      // Re-base on the server's authoritative position; local orders survive.
      unit.x = entity.x;
      unit.y = entity.y;
      unit.z = entity.z;
      unit.hp = entity.hp;
      unit.ang = entity.ang;
      unit.st = entity.st;
      if (unacknowledged.has(entity.id)) {
        // Keep predicting toward our own, still-unconfirmed destination.
      } else {
        unit.orderKind = entity.ord ?? 0;
        unit.order = unit.orderKind === 1 ? { x: entity.ox ?? 0, z: entity.oz ?? 0 } : null;
      }

      if (error > this.snapThreshold) {
        // The server disagreed materially: the re-base above *is* the snap.
        this.correctionPending = true;
        this.lastCorrectionTick = snapshot.tick;
        this.lastErrorMetres = error;
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
        this.predictMove(unit, unit.order.x, unit.order.y, TICK_MS);
      }
    }
  }

  /** Forgets every unit, pending batch and correction — used on disconnect. */
  reset(): void {
    this.units.clear();
    this.pending.clear();
    this.correctionPending = false;
    this.lastCorrectionTick = 0;
    this.lastErrorMetres = 0;
    this.tickCursor = 0;
  }

  /* ------------------------------------------------------------- internals */

  private issueMove(ids: number[], x: number, y: number): void {
    const targetX = clamp(x, 0, this.worldSize);
    const targetY = clamp(y, 0, this.worldSize);
    for (const id of ids) {
      const unit = this.units.get(id);
      if (!unit || unit.st === "dead") continue;
      unit.order = { x: targetX, y: targetY };
      unit.orderKind = 1;
      unit.st = "moving";
    }
  }

  private issueStop(ids: number[]): void {
    for (const id of ids) {
      const unit = this.units.get(id);
      if (!unit) continue;
      unit.order = null;
      unit.orderKind = 0;
      if (unit.st !== "dead") unit.st = "idle";
    }
  }

  /** Ids with a move order the server has not yet acknowledged. */
  private unacknowledgedMoveTargets(): Set<number> {
    const ids = new Set<number>();
    for (const bucket of this.pending.values()) {
      for (const batch of bucket) {
        for (const command of batch.commands) {
          if (command.c === "move") for (const id of command.ids) ids.add(id);
        }
      }
    }
    return ids;
  }

  /** Drops batches the server never confirmed, so a lost send cannot loop. */
  private expireStaleOrders(nowMs: number): void {
    for (const [tick, bucket] of this.pending) {
      const kept = bucket.filter((batch) => nowMs - batch.sentAtMs <= this.pendingTimeoutMs);
      if (kept.length === 0) this.pending.delete(tick);
      else if (kept.length !== bucket.length) this.pending.set(tick, kept);
    }
  }

  private advance(unit: PredictedUnit, dx: number, dy: number, air: boolean): number {
    // Air units ignore the ground probe; ground units slide along whichever
    // axis is still passable, and stop dead when neither is.
    const candidates: [number, number][] = [[dx, dy], [dx, 0], [0, dy]];
    for (const [mx, my] of candidates) {
      if (air && (mx !== dx || my !== dy)) continue;
      if (mx === 0 && my === 0) continue;
      const nx = clamp(unit.x + mx, 0, this.worldSize);
      const ny = clamp(unit.y + my, 0, this.worldSize);
      if (!this.canStand(nx, ny, unit.radius, air)) continue;
      const moved = Math.hypot(nx - unit.x, ny - unit.y);
      unit.x = nx;
      unit.y = ny;
      if (this.terrain && !air) unit.z = this.terrain.sample(nx, ny);
      return moved;
    }
    return 0;
  }

  private canStand(x: number, y: number, radius: number, air: boolean): boolean {
    if (air || !this.terrain) return true;
    // A unit is a disc, not a point: probe the centre and all four flanks.
    if (this.terrain.passable(x, y)) return true;
    if (radius <= 0) return false;
    return (
      this.terrain.passable(x + radius, y) ||
      this.terrain.passable(x - radius, y) ||
      this.terrain.passable(x, y + radius) ||
      this.terrain.passable(x, y - radius)
    );
  }

  private unitFromServer(entity: ProtocolEntity): PredictedUnit {
    const def = hasEntityDef(entity.ty) ? entityDef(entity.ty) : null;
    const unit: PredictedUnit = {
      id: entity.id,
      ty: entity.ty,
      x: entity.x,
      y: entity.y,
      z: entity.z,
      ang: entity.ang,
      hp: entity.hp,
      st: entity.st,
      speed: def && def.kind === "unit" ? def.speed : 0,
      radius: def?.size.radius ?? 0.5,
      air: def?.kind === "unit" ? def.movement === "air" : false,
      order: null,
      orderKind: entity.ord ?? 0,
      stalledTicks: 0,
    };
    if (unit.orderKind === 1) unit.order = { x: entity.ox ?? 0, z: entity.oz ?? 0 };
    return unit;
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
