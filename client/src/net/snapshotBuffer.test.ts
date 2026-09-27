/**
 * The snapshot ring is the client's entire world model: full entity tables
 * arrive at 10 Hz and the last N of them are what interpolation, late-join and
 * `ack` bookkeeping read. Its load-bearing properties are bounded memory,
 * correct ordering across the wrap point, and a bracket that really brackets.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SNAPSHOT_CAPACITY, MIN_SNAPSHOT_CAPACITY, SnapshotBuffer } from "./snapshotBuffer";
import type { Snapshot } from "./snapshotBuffer";

function snap(tick: number, over: Partial<Snapshot> = {}): Snapshot {
  return {
    tick,
    server_ms: 1_700_000_000_000 + tick * 100,
    ack: tick - 1,
    entities: [],
    events: [],
    ...over,
  };
}

function filled(count: number, capacity = count): SnapshotBuffer {
  const buffer = new SnapshotBuffer(capacity);
  for (let i = 0; i < count; i++) buffer.push(snap(i));
  return buffer;
}

describe("SnapshotBuffer", () => {
  it("returns null for every accessor while empty", () => {
    const buffer = new SnapshotBuffer();
    expect(buffer.latest()).toBeNull();
    expect(buffer.oldest()).toBeNull();
    expect(buffer.atOrBefore(0)).toBeNull();
    expect(buffer.bracketing(0)).toEqual([null, null]);
    expect(buffer.size).toBe(0);
  });

  it("keeps push order, so oldest and latest are the ends of the stream", () => {
    const buffer = filled(4);
    expect(buffer.oldest()?.tick).toBe(0);
    expect(buffer.latest()?.tick).toBe(3);
    expect(buffer.toArray().map((e) => e.tick)).toEqual([0, 1, 2, 3]);
  });

  it("indexes each snapshot's entity table by id", () => {
    const buffer = new SnapshotBuffer();
    const entity = {
      id: 42,
      ty: "marine",
      pl: 1,
      x: 1,
      y: 2,
      z: 0,
      hp: 10,
      hp_max: 10,
      mp: 0,
      mp_max: 0,
      ang: 0,
      st: "idle" as const,
    };
    buffer.push(snap(1, { entities: [entity] }));
    // Interpolation reads this map every frame; a raw scan would be O(n) there.
    expect(buffer.latest()?.entities.get(42)).toBe(entity);
  });

  it("atOrBefore returns the newest snapshot at or before the tick", () => {
    const buffer = filled(5);
    expect(buffer.atOrBefore(3)?.tick).toBe(3);
    expect(buffer.atOrBefore(10)?.tick).toBe(4);
  });

  it("atOrBefore returns null when the tick predates every retained snapshot", () => {
    const buffer = filled(12, 8); // retains ticks 4..11
    // Clamping a pre-window tick *forward* to the newest snapshot would hand the
    // caller the future; the interpolation path has to be able to tell "nothing
    // that old is left" apart from a real answer.
    expect(buffer.atOrBefore(1)).toBeNull();
  });

  it("atOrAfter returns the oldest snapshot at or after the tick", () => {
    const buffer = filled(5);
    expect(buffer.atOrAfter(2)?.tick).toBe(2);
    expect(buffer.atOrAfter(5)).toBeNull();
  });

  it("bracketing returns a genuine pair around the requested tick", () => {
    const buffer = filled(6);
    const [older, newer] = buffer.bracketing(2);
    expect(older?.tick).toBe(2);
    expect(newer?.tick).toBe(3);
  });

  it("bracketing clamps to one-sided results outside the retained window", () => {
    const buffer = filled(6);
    const [tooOld, newer] = buffer.bracketing(-1);
    expect(tooOld).toBeNull();
    expect(newer?.tick).toBe(0);
    const [older, tooNew] = buffer.bracketing(99);
    expect(older?.tick).toBe(5);
    expect(tooNew).toBeNull();
  });

  it("forServerTime brackets on the server clock, not the tick", () => {
    const buffer = filled(5);
    const target = buffer.latest()!.serverMs - 50; // halfway between 3 and 4
    const [older, newer] = buffer.forServerTime(target);
    expect(older?.tick).toBe(3);
    expect(newer?.tick).toBe(4);
  });

  it("evicts the oldest entries once capacity is reached", () => {
    const buffer = new SnapshotBuffer(8);
    for (let i = 0; i < 20; i++) buffer.push(snap(i));
    expect(buffer.size).toBe(8);
    expect(buffer.oldest()?.tick).toBe(12);
    expect(buffer.latest()?.tick).toBe(19);
    expect(buffer.toArray().map((e) => e.tick)).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it("never grows past its capacity however many snapshots are pushed", () => {
    const buffer = new SnapshotBuffer();
    for (let i = 0; i < 10_000; i++) {
      buffer.push(snap(i));
      // Unbounded growth here is an OOM on a long match, not a slow leak.
      expect(buffer.size).toBeLessThanOrEqual(buffer.capacity);
    }
    expect(buffer.size).toBe(DEFAULT_SNAPSHOT_CAPACITY);
    expect(buffer.latest()?.tick).toBe(9_999);
  });

  it("keeps the newest entry after the write cursor wraps repeatedly", () => {
    const buffer = new SnapshotBuffer(8);
    for (let i = 0; i < 1_000; i++) buffer.push(snap(i));
    const stats = buffer.stats();
    expect(stats.newestTick).toBe(999);
    expect(stats.oldestTick).toBe(992);
    expect(stats.tickSpan).toBe(7);
    expect(stats.count).toBe(8);
    expect(stats.dropped).toBe(1_000 - 8);
  });

  it("prune drops strictly older snapshots and keeps the boundary one", () => {
    const buffer = filled(8);
    const removed = buffer.prune(5);
    expect(removed).toBe(5);
    expect(buffer.toArray().map((e) => e.tick)).toEqual([5, 6, 7]);
    expect(buffer.size).toBe(3);
  });

  it("prune is a no-op when the cutoff is at or below the oldest retained tick", () => {
    const buffer = filled(10, 8); // retains ticks 2..9
    expect(buffer.prune(2)).toBe(0);
    expect(buffer.prune(1)).toBe(0);
    expect(buffer.size).toBe(8);
  });

  it("clear empties the buffer and resets the lifetime counters", () => {
    const buffer = filled(10, 4);
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.latest()).toBeNull();
    expect(buffer.stats().dropped).toBe(0);
    buffer.push(snap(99));
    expect(buffer.latest()?.tick).toBe(99);
    expect(buffer.toArray().map((e) => e.tick)).toEqual([99]);
  });

  it("counts duplicate and backwards ticks so a resync is visible in stats", () => {
    const buffer = new SnapshotBuffer(8);
    buffer.push(snap(10));
    buffer.push(snap(10));
    buffer.push(snap(9));
    buffer.push(snap(11));

    const stats = buffer.stats();
    // Both must stay in the buffer: a rewind is a legitimate resynchronise,
    // and dropping the newer frame would wedge interpolation.
    expect(stats.duplicates).toBe(1);
    expect(stats.outOfOrder).toBe(1);
    expect(stats.count).toBe(4);
  });

  it("reports the newest snapshot's ack as the server's progress", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snap(5, { ack: 3 }));
    buffer.push(snap(6, { ack: 4 }));
    expect(buffer.stats().ack).toBe(4);
  });

  it("raises the capacity to the floor rather than honouring a tiny request", () => {
    const buffer = new SnapshotBuffer(1);
    expect(buffer.capacity).toBe(MIN_SNAPSHOT_CAPACITY);
  });
});
