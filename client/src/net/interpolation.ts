/**
 * Snapshot interpolation for the render clock.
 *
 * The server simulates at a fixed 20 Hz and broadcasts a full entity table at
 * 10 Hz (PROTOCOL.md §5). The renderer runs at display rate on a clock that
 * lags the newest snapshot by a fixed delay, so every frame is drawn between two
 * *received* snapshots rather than extrapolated into the future. That is what
 * this class produces: for a render time it finds the bracketing pair and
 * blends position, facing, health and order state across it.
 *
 * Rules that matter:
 *
 * - **Angles take the short arc.** A unit turning from 3.10 rad to -3.10 rad
 *   rotates +0.08 rad, not -6.2 rad through the back.
 * - **Spawns land on the newer snapshot.** An entity present only in `newer`
 *   is drawn at its `newer` position the moment it appears there, not faded in
 *   from the ground between the two.
 * - **Deaths linger until the newer frame.** An entity present only in `older`
 *   is drawn at its `older` state and flagged in `despawnIds`; the next sample,
 *   which no longer brackets it, drops it. No corpse lingers past the frame
 *   that reported the death.
 * - **Extrapolation is capped at {@link MAX_EXTRAPOLATION_MS}.** Past the newest
 *   snapshot the newest two are continued along their measured velocity for at
 *   most 250 ms, then frozen. Any sample that clamps or extrapolates reports
 *   `reliability === false` so the UI can show a desync hint instead of
 *   silently showing fiction.
 *
 * Allocation: entity views are pooled and mutated in place, and `out` is reused
 * across frames, so a steady-state frame allocates nothing.
 */
import { SNAPSHOT_HZ, TICK_MS } from "@shared/protocol";
import type { EntityState, OrderKind, ProtocolEntity } from "@shared/protocol";
import type { BufferedSnapshot, SnapshotBuffer } from "./snapshotBuffer";

/** Hard ceiling on continued motion past the newest snapshot. */
export const MAX_EXTRAPOLATION_MS = 250;
/** Default render delay: two snapshot intervals of interpolation headroom. */
export const DEFAULT_INTERPOLATION_DELAY_MS = (1000 / SNAPSHOT_HZ) * 2;
/** Nominal spacing between snapshots, used to sanity-check the render clock. */
export const EXPECTED_SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_HZ;

/** A blended view of one entity, in the shape the renderer consumes. */
export interface InterpolatedEntity {
  id: number;
  ty: string;
  pl: number;
  x: number;
  y: number;
  z: number;
  ang: number;
  hp: number;
  hp_max: number;
  mp: number;
  mp_max: number;
  st: EntityState;
  /** Weapon cooldown remaining, seconds. */
  w: number;
  /** Current target entity id, 0 for none. */
  tid: number;
  ord: OrderKind;
  ox: number;
  oy: number;
  prog: number;
  cargo: number;
  res: number;
  /** Queued production count. */
  n: number;
  /** Active ability buff bitmask. */
  b: number;
  sel: 0 | 1 | 2 | 3;
  /** False while the entity is only present in the older snapshot. */
  present: boolean;
}

/** One frame's world view. Reuse the object; only its contents change. */
export interface WorldSample {
  /** Server-clock millis this sample was taken for. */
  timeMs: number;
  /** Tick of the older bracketing snapshot (0 when extrapolating a single frame). */
  tick: number;
  /** Tick of the newer bracketing snapshot, 0 when there is none. */
  nextTick: number;
  /** Blend factor actually applied, in [0, 1]. */
  alpha: number;
  entities: Map<number, InterpolatedEntity>;
  /** Ids that entered the world in this sample. */
  spawnIds: number[];
  /** Ids present only in the older snapshot; the next sample drops them. */
  despawnIds: number[];
  /** False when the sample had to clamp or extrapolate — show a desync hint. */
  reliability: boolean;
  /** Milliseconds extrapolated past the newest snapshot, 0 when interpolating. */
  extrapolatedMs: number;
}

/** Allocates a sample the interpolator can reuse frame after frame. */
export function createWorldSample(): WorldSample {
  return {
    timeMs: 0,
    tick: 0,
    nextTick: 0,
    alpha: 0,
    entities: new Map<number, InterpolatedEntity>(),
    spawnIds: [],
    despawnIds: [],
    reliability: true,
    extrapolatedMs: 0,
  };
}

export interface InterpolatorOptions {
  /** Override the extrapolation ceiling; clamped to [0, 1000]. */
  maxExtrapolationMs?: number;
}

const TWO_PI = Math.PI * 2;

/** Wraps to (-π, π]. */
export function normalizeAngle(radians: number): number {
  let a = radians % TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  else if (a <= -Math.PI) a += TWO_PI;
  return a;
}

/** Signed shortest rotation taking `from` to `to`, in (-π, π]. */
export function shortestAngleDelta(from: number, to: number): number {
  return normalizeAngle(to - from);
}

export class Interpolator {
  readonly buffer: SnapshotBuffer;
  readonly maxExtrapolationMs: number;
  /** Reused per-frame bookkeeping, so the steady state allocates nothing. */
  private readonly pool = new Map<number, InterpolatedEntity>();
  private readonly seen = new Set<number>();

  constructor(buffer: SnapshotBuffer, options: InterpolatorOptions = {}) {
    this.buffer = buffer;
    const requested = options.maxExtrapolationMs ?? MAX_EXTRAPOLATION_MS;
    this.maxExtrapolationMs = Math.min(1000, Math.max(0, requested));
  }

  /**
   * Blends the world at `renderTimeMs` (server epoch millis) into `out`.
   * Always returns `out`.
   */
  sample(renderTimeMs: number, out: WorldSample): WorldSample {
    out.timeMs = renderTimeMs;
    out.entities = this.pool;
    out.spawnIds.length = 0;
    out.despawnIds.length = 0;
    out.extrapolatedMs = 0;
    out.tick = 0;
    out.nextTick = 0;
    out.alpha = 1;
    out.reliability = true;
    const newest = this.buffer.latest();
    if (!newest) {
      this.forgetAll();
      out.reliability = false;
      return out;
    }

    let older: BufferedSnapshot | null;
    let newer: BufferedSnapshot | null;
    [older, newer] = this.buffer.forServerTime(renderTimeMs);

    if (!older) {
      // Render clock is behind everything we hold: clamp forward to the oldest
      // state rather than inventing motion we cannot see.
      const oldest = this.buffer.oldest();
      if (!oldest) {
        this.forgetAll();
        out.reliability = false;
        return out;
      }
      older = oldest;
      const next = this.buffer.atOrAfter(oldest.tick);
      newer = next && next.serverMs > renderTimeMs ? next : null;
      out.reliability = false;
    }
    out.tick = older.tick;

    if (newer && newer !== older) {
      out.nextTick = newer.tick;
      const span = newer.serverMs - older.serverMs;
      out.alpha = span > 0 ? clamp01((renderTimeMs - older.serverMs) / span) : 1;
      this.blend(older, newer, out.alpha, out);
    } else {
      // Past the newest snapshot: continue along measured velocity, briefly.
      const previous = this.buffer.atOrBefore(older.tick - 1);
      const ahead = renderTimeMs - older.serverMs;
      const step = Math.min(Math.max(ahead, 0), this.maxExtrapolationMs);
      out.extrapolatedMs = step;
      out.reliability = false;
      this.continueFrom(previous, older, step, out);
    }
    return out;
  }

  /** Drops every pooled entity view; used on disconnect and resync. */
  reset(): void {
    this.forgetAll();
  }

  /* ------------------------------------------------------------- internals */

  private blend(older: BufferedSnapshot, newer: BufferedSnapshot, alpha: number, out: WorldSample): void {
    const seen = this.seen;
    seen.clear();

    for (const [id, to] of newer.entities) {
      seen.add(id);
      const from = older.entities.get(id);
      const view = this.pool.get(id) ?? this.createView(to);
      copyStatic(view, to);
      if (from) {
        view.x = from.x + (to.x - from.x) * alpha;
        view.y = from.y + (to.y - from.y) * alpha;
        view.z = from.z + (to.z - from.z) * alpha;
        view.ang = from.ang + shortestAngleDelta(from.ang, to.ang) * alpha;
        view.hp = from.hp + (to.hp - from.hp) * alpha;
        view.mp = from.mp + (to.mp - from.mp) * alpha;
        view.w = (from.w ?? 0) + ((to.w ?? 0) - (from.w ?? 0)) * alpha;
        // Discrete state flips at the midpoint: the newer snapshot is the
        // future, and past halfway it is the more likely present.
        const flip = alpha >= 0.5 ? to : from;
        view.st = flip.st;
        view.prog = flip.prog ?? 0;
      } else {
        // Spawn: already fully where the newer snapshot put it.
        out.spawnIds.push(id);
        view.x = to.x;
        view.y = to.y;
        view.z = to.z;
        view.ang = to.ang;
        view.hp = to.hp;
        view.mp = to.mp;
        view.w = to.w ?? 0;
        view.st = to.st;
        view.prog = to.prog ?? 0;
      }
      copyVolatile(view, to);
      view.present = true;
      this.pool.set(id, view);
    }

    for (const [id, from] of older.entities) {
      if (newer.entities.has(id)) continue;
      // Despawn: hold the older state for this one frame, then drop it.
      out.despawnIds.push(id);
      seen.add(id);
      const view = this.pool.get(id) ?? this.createView(from);
      copyStatic(view, from);
      view.x = from.x;
      view.y = from.y;
      view.z = from.z;
      view.ang = from.ang;
      view.hp = from.hp;
      view.mp = from.mp;
      view.w = from.w ?? 0;
      view.st = from.st;
      view.prog = from.prog ?? 0;
      copyVolatile(view, from);
      view.present = false;
      this.pool.set(id, view);
    }

    for (const id of this.pool.keys()) if (!seen.has(id)) this.pool.delete(id);
  }

  private continueFrom(previous: BufferedSnapshot | null, newest: BufferedSnapshot, stepMs: number, out: WorldSample): void {
    const seen = this.seen;
    seen.clear();
    for (const [id, to] of newest.entities) {
      seen.add(id);
      const view = this.pool.get(id) ?? this.createView(to);
      copyStatic(view, to);
      const from = previous?.entities.get(id);
      if (from && previous && stepMs > 0) {
        const span = newest.serverMs - previous.serverMs;
        if (span > 0) {
          const k = stepMs / span;
          view.x = to.x + (to.x - from.x) * k;
          view.y = to.y + (to.y - from.y) * k;
          view.z = to.z + (to.z - from.z) * k;
          view.ang = to.ang + shortestAngleDelta(from.ang, to.ang) * k;
        } else {
          view.x = to.x;
          view.y = to.y;
          view.z = to.z;
          view.ang = to.ang;
        }
      } else {
        view.x = to.x;
        view.y = to.y;
        view.z = to.z;
        view.ang = to.ang;
      }
      view.hp = to.hp;
      view.mp = to.mp;
      view.w = to.w ?? 0;
      view.st = to.st;
      view.prog = to.prog ?? 0;
      copyVolatile(view, to);
      view.present = true;
      this.pool.set(id, view);
    }
    for (const id of this.pool.keys()) if (!seen.has(id)) this.pool.delete(id);
  }

  private createView(source: ProtocolEntity): InterpolatedEntity {
    return {
      id: source.id,
      ty: source.ty,
      pl: source.pl,
      x: source.x,
      y: source.y,
      z: source.z,
      ang: source.ang,
      hp: source.hp,
      hp_max: source.hp_max,
      mp: source.mp,
      mp_max: source.mp_max,
      st: source.st,
      w: source.w ?? 0,
      tid: source.tid ?? 0,
      ord: source.ord ?? 0,
      ox: source.ox ?? 0,
      oy: source.oy ?? 0,
      prog: source.prog ?? 0,
      cargo: source.cargo ?? 0,
      res: source.res ?? 0,
      n: source.n ?? 0,
      b: source.b ?? 0,
      sel: source.sel ?? 0,
      present: true,
    };
  }

  private forgetAll(): void {
    this.pool.clear();
    this.seen.clear();
  }
}

/** Fields that cannot change between snapshots for a given entity id. */
function copyStatic(view: InterpolatedEntity, source: ProtocolEntity): void {
  view.id = source.id;
  view.ty = source.ty;
  view.pl = source.pl;
  view.hp_max = source.hp_max;
  view.mp_max = source.mp_max;
}

/**
 * Fields that only the newest snapshot knows. The protocol omits values equal
 * to a type's static default, so every one of these needs a fallback.
 */
function copyVolatile(view: InterpolatedEntity, source: ProtocolEntity): void {
  view.tid = source.tid ?? 0;
  view.ord = source.ord ?? 0;
  view.ox = source.ox ?? 0;
  view.oy = source.oy ?? 0;
  view.cargo = source.cargo ?? 0;
  view.res = source.res ?? 0;
  view.n = source.n ?? 0;
  view.b = source.b ?? 0;
  view.sel = source.sel ?? 0;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** One simulation step, re-exported so callers can size prediction substeps. */
export const INTERPOLATION_TICK_MS = TICK_MS;
