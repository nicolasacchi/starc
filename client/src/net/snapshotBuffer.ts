/**
 * Fixed-capacity ring buffer of the most recent full-table snapshots.
 *
 * Snapshots are the substrate for three things: entity interpolation
 * ({@link ../net/interpolation}), late-join / reconnect resynchronisation, and
 * `ack` bookkeeping for command prediction. Because the server broadcasts the
 * whole entity table every snapshot (PROTOCOL.md §5), there is no delta stream
 * to apply — holding the last N tables is the entire client-side world model.
 *
 * The buffer is preallocated at construction and never resized, so a ten-minute
 * match allocates exactly `capacity` slots and no more. Slots hold a reference
 * to the snapshot object that arrived on the wire; nothing is copied.
 */
import type { GameEvent, ProtocolEntity } from "@shared/protocol";

/** The `game:snapshot` payload as it arrives on the wire. */
export interface Snapshot {
  tick: number;
  server_ms: number;
  ack: number;
  entities: ProtocolEntity[];
  events: GameEvent[];
}

/** A snapshot plus the bookkeeping the client keeps about it. */
export interface BufferedSnapshot {
  readonly snapshot: Snapshot;
  /** Server epoch millis the snapshot was generated for. */
  readonly serverMs: number;
  /** Local `Date.now()` when the frame was handed to `push`. */
  readonly receivedAtMs: number;
  readonly tick: number;
  /** Highest `from_tick` the server had processed when this was produced. */
  readonly ack: number;
  /** Entity table indexed by id — built once per snapshot, then reused. */
  readonly entities: ReadonlyMap<number, ProtocolEntity>;
}

export interface SnapshotBufferStats {
  readonly count: number;
  readonly capacity: number;
  readonly oldestTick: number;
  readonly newestTick: number;
  /** Tick distance covered by the retained window. */
  readonly tickSpan: number;
  /** Wall-clock span covered by the retained window. */
  readonly serverSpanMs: number;
  /** Newest snapshot's `ack`, i.e. how far the server has consumed us. */
  readonly ack: number;
  /** Snapshots pushed then evicted by the ring (lifetime counter). */
  readonly dropped: number;
  /** Pushes that arrived with a tick we already hold (lifetime counter). */
  readonly duplicates: number;
  /** Pushes whose tick went backwards relative to the newest (lifetime). */
  readonly outOfOrder: number;
}

/** 2 s of snapshots at 10 Hz: deep enough for 250 ms extrapolation plus
 *  interpolation headroom, small enough to stay trivial in memory. */
export const DEFAULT_SNAPSHOT_CAPACITY = 32;
export const MIN_SNAPSHOT_CAPACITY = 8;

export class SnapshotBuffer {
  readonly capacity: number;
  private readonly slots: (BufferedSnapshot | null)[];
  /** Index of the oldest entry; the ring's write cursor is `head + count`. */
  private head = 0;
  private count = 0;
  private dropped = 0;
  private duplicates = 0;
  private outOfOrder = 0;

  constructor(capacity: number = DEFAULT_SNAPSHOT_CAPACITY) {
    this.capacity = Math.max(MIN_SNAPSHOT_CAPACITY, Math.floor(capacity));
    this.slots = new Array<BufferedSnapshot | null>(this.capacity).fill(null);
  }

  get size(): number {
    return this.count;
  }

  /**
   * Stores `snapshot`, evicting the oldest entry when full. Ticks that repeat
   * or go backwards are recorded but still stored: a mid-match resynchronise
   * legitimately rewinds the buffer, and dropping the newer frame would leave
   * interpolation wedged.
   */
  push(snapshot: Snapshot, receivedAtMs: number = Date.now()): BufferedSnapshot {
    const tick = snapshot.tick;
    const newest = this.latest();
    if (newest) {
      if (newest.tick === tick) this.duplicates++;
      else if (newest.tick > tick) this.outOfOrder++;
    }

    const entry: BufferedSnapshot = {
      snapshot,
      tick,
      serverMs: snapshot.server_ms,
      receivedAtMs,
      ack: snapshot.ack,
      entities: indexEntities(snapshot.entities),
    };

    const writeAt = (this.head + this.count) % this.capacity;
    if (this.count === this.capacity) {
      this.slots[this.head] = entry;
      this.head = (this.head + 1) % this.capacity;
      this.dropped++;
    } else {
      this.slots[writeAt] = entry;
      this.count++;
    }
    return entry;
  }

  /** Newest retained snapshot, or null when empty. */
  latest(): BufferedSnapshot | null {
    if (this.count === 0) return null;
    return this.slots[(this.head + this.count - 1) % this.capacity];
  }

  /** Oldest retained snapshot, or null when empty. */
  oldest(): BufferedSnapshot | null {
    if (this.count === 0) return null;
    return this.slots[this.head];
  }

  /** Newest snapshot with `tick <= target`, or null when none qualifies. */
  atOrBefore(tick: number): BufferedSnapshot | null {
    let found: BufferedSnapshot | null = null;
    for (let i = 0; i < this.count; i++) {
      const entry = this.slots[(this.head + i) % this.capacity];
      if (!entry) continue;
      if (entry.tick <= tick) found = entry;
      else break;
    }
    return found;
  }

  /** Oldest snapshot with `tick >= target`, or null when none qualifies. */
  atOrAfter(tick: number): BufferedSnapshot | null {
    for (let i = 0; i < this.count; i++) {
      const entry = this.slots[(this.head + i) % this.capacity];
      if (!entry) continue;
      if (entry.tick >= tick) return entry;
    }
    return null;
  }

  /**
   * The pair that brackets `tick`: `[older, newer]` where `older.tick <= tick`
   * and `newer.tick > tick`. Either side may be null when the tick falls
   * outside the retained window — the caller decides whether to clamp or
   * extrapolate.
   */
  bracketing(tick: number): [BufferedSnapshot | null, BufferedSnapshot | null] {
    let older: BufferedSnapshot | null = null;
    let newer: BufferedSnapshot | null = null;
    for (let i = 0; i < this.count; i++) {
      const entry = this.slots[(this.head + i) % this.capacity];
      if (!entry) continue;
      if (entry.tick <= tick) older = entry;
      else {
        newer = entry;
        break;
      }
    }
    return [older, newer];
  }

  /**
   * Same bracketing, but on the server's clock — the axis the renderer
   * interpolates along, since client `Date.now()` is not the server's epoch.
   */
  forServerTime(serverMs: number): [BufferedSnapshot | null, BufferedSnapshot | null] {
    let older: BufferedSnapshot | null = null;
    let newer: BufferedSnapshot | null = null;
    for (let i = 0; i < this.count; i++) {
      const entry = this.slots[(this.head + i) % this.capacity];
      if (!entry) continue;
      if (entry.serverMs <= serverMs) older = entry;
      else {
        newer = entry;
        break;
      }
    }
    return [older, newer];
  }

  /**
   * Drops every snapshot strictly older than `olderThanTick`, keeping the one
   * at or after it. Returns how many were dropped. Used to bound memory after a
   * long idle stretch and to clear history on resynchronise.
   */
  prune(olderThanTick: number): number {
    let removed = 0;
    while (this.count > 0) {
      const entry = this.slots[this.head];
      if (!entry || entry.tick >= olderThanTick) break;
      this.slots[this.head] = null;
      this.head = (this.head + 1) % this.capacity;
      this.count--;
      removed++;
    }
    return removed;
  }

  /** Empties the buffer and zeroes the lifetime counters. */
  clear(): void {
    this.slots.fill(null);
    this.head = 0;
    this.count = 0;
    this.dropped = 0;
    this.duplicates = 0;
    this.outOfOrder = 0;
  }

  /** Retained entries oldest-first. Allocates; for diagnostics and tests. */
  toArray(): BufferedSnapshot[] {
    const out: BufferedSnapshot[] = [];
    for (let i = 0; i < this.count; i++) {
      const entry = this.slots[(this.head + i) % this.capacity];
      if (entry) out.push(entry);
    }
    return out;
  }

  stats(): SnapshotBufferStats {
    const oldest = this.oldest();
    const newest = this.latest();
    return {
      count: this.count,
      capacity: this.capacity,
      oldestTick: oldest?.tick ?? 0,
      newestTick: newest?.tick ?? 0,
      tickSpan: oldest && newest ? newest.tick - oldest.tick : 0,
      serverSpanMs: oldest && newest ? newest.serverMs - oldest.serverMs : 0,
      ack: newest?.ack ?? 0,
      dropped: this.dropped,
      duplicates: this.duplicates,
      outOfOrder: this.outOfOrder,
    };
  }
}

/**
 * Indexes one snapshot's entity table. Called once per pushed snapshot and the
 * result is what interpolation reads, so this is the only per-snapshot
 * allocation in the pipeline.
 */
function indexEntities(entities: ProtocolEntity[]): ReadonlyMap<number, ProtocolEntity> {
  const map = new Map<number, ProtocolEntity>();
  for (const entity of entities) map.set(entity.id, entity);
  return map;
}
