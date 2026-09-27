/**
 * Interpolation is what the player actually sees between snapshots. A bug here
 * does not crash — it makes units stutter, snap backwards, spin the long way
 * round, or glide off into fiction after a stall — so these tests are all about
 * observable positions, angles and the reliability flag.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createWorldSample, Interpolator, MAX_EXTRAPOLATION_MS } from "./interpolation";
import type { WorldSample } from "./interpolation";
import { SnapshotBuffer } from "./snapshotBuffer";
import type { Snapshot } from "./snapshotBuffer";
import type { EntityState, ProtocolEntity } from "@shared/protocol";

const T0 = 1_700_000_000_000;

function entity(id: number, over: Partial<ProtocolEntity> = {}): ProtocolEntity {
  return {
    id,
    ty: "marine",
    pl: 1,
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

function snap(tick: number, entities: ProtocolEntity[], ack = 0): Snapshot {
  return { tick, server_ms: T0 + tick * 100, ack, entities, events: [] };
}

describe("Interpolator", () => {
  let buffer: SnapshotBuffer;
  let interpolator: Interpolator;
  let sample: WorldSample;

  beforeEach(() => {
    buffer = new SnapshotBuffer(16);
    interpolator = new Interpolator(buffer);
    sample = createWorldSample();
  });

  it("reports an unreliable, empty sample before any snapshot has landed", () => {
    interpolator.sample(T0, sample);
    // Drawing fiction before the first table is how a client shows a phantom base.
    expect(sample.entities.size).toBe(0);
    expect(sample.reliability).toBe(false);
  });

  it("places a moving entity at a genuinely intermediate position", () => {
    buffer.push(snap(0, [entity(1, { x: 0 })]));
    buffer.push(snap(1, [entity(1, { x: 10 })]));

    interpolator.sample(T0 + 50, sample);
    const x = sample.entities.get(1)!.x;
    // Landing on either endpoint means the blend factor is being ignored.
    expect(x).toBeGreaterThan(0.5);
    expect(x).toBeLessThan(9.5);
    expect(x).toBeCloseTo(5, 6);
    expect(sample.alpha).toBeCloseTo(0.5, 6);
    expect(sample.reliability).toBe(true);
  });

  it("exposes the bracketing ticks and honours a different blend factor", () => {
    buffer.push(snap(0, [entity(1, { x: 0 })]));
    buffer.push(snap(1, [entity(1, { x: 10 })]));

    interpolator.sample(T0 + 25, sample);
    expect(sample.tick).toBe(0);
    expect(sample.nextTick).toBe(1);
    expect(sample.entities.get(1)!.x).toBeCloseTo(2.5, 6);
  });

  it("blends health and weapon cooldown but snaps discrete state at the midpoint", () => {
    buffer.push(snap(0, [entity(1, { hp: 40, st: "moving", w: 1 })]));
    buffer.push(snap(1, [entity(1, { hp: 20, st: "idle", w: 0 })]));

    interpolator.sample(T0 + 25, sample);
    const view = sample.entities.get(1)!;
    expect(view.hp).toBeCloseTo(35, 6);
    expect(view.w).toBeCloseTo(0.75, 6);
    // Before halfway the older state still describes the unit.
    expect(view.st).toBe("moving");

    interpolator.sample(T0 + 75, sample);
    expect(sample.entities.get(1)!.st).toBe("idle");
  });

  it("spawns an entity that appears between snapshots at the newer position", () => {
    buffer.push(snap(0, []));
    buffer.push(snap(1, [entity(7, { x: 40, z: 12 })]));

    interpolator.sample(T0 + 50, sample);
    const view = sample.entities.get(7)!;
    // Fading in from the origin instead would show every spawned unit sliding
    // across the map from (0, 0).
    expect(view.x).toBe(40);
    expect(view.z).toBe(12);
    expect(view.present).toBe(true);
    expect(sample.spawnIds).toEqual([7]);
    expect(sample.despawnIds).toEqual([]);
  });

  it("holds a disappeared entity at its older state and flags it, then drops it", () => {
    buffer.push(snap(0, [entity(7, { x: 40, st: "moving" as EntityState })]));
    buffer.push(snap(1, []));

    interpolator.sample(T0 + 50, sample);
    const view = sample.entities.get(7)!;
    expect(view.present).toBe(false);
    expect(view.x).toBe(40);
    expect(sample.despawnIds).toEqual([7]);

    // A corpse that outlives the frame that reported the death reads as a
    // unit the player cannot click.
    interpolator.sample(T0 + 150, sample);
    expect(sample.entities.has(7)).toBe(false);
  });

  it("interpolates facing the short way around the circle", () => {
    buffer.push(snap(0, [entity(1, { ang: 3.1 })]));
    buffer.push(snap(1, [entity(1, { ang: -3.1 })]));

    interpolator.sample(T0 + 50, sample);
    const ang = sample.entities.get(1)!.ang;
    // Through ±π, not the 6.2 rad sweep back through zero.
    expect(ang).toBeGreaterThan(3.1);
    expect(ang).toBeCloseTo(Math.PI, 2);
  });

  it("does not spin the long way when the arc is nearly a whole turn", () => {
    buffer.push(snap(0, [entity(1, { ang: -3.0 })]));
    buffer.push(snap(1, [entity(1, { ang: 3.0 })]));

    interpolator.sample(T0 + 25, sample);
    const ang = sample.entities.get(1)!.ang;
    // -3.0 → 3.0 is -0.28 rad the short way through -π, not +6.0 through zero.
    expect(ang).toBeCloseTo(-3.0708, 3);
  });

  it("continues motion past the newest snapshot but never past the cap", () => {
    buffer.push(snap(0, [entity(1, { x: 0 })]));
    buffer.push(snap(1, [entity(1, { x: 10 })]));

    interpolator.sample(T0 + 100 + 5_000, sample);

    expect(sample.extrapolatedMs).toBe(MAX_EXTRAPOLATION_MS);
    expect(sample.reliability).toBe(false);
    // 250 ms of a 10 m/100 ms drift, not five seconds of it.
    expect(sample.entities.get(1)!.x).toBeCloseTo(35, 6);
  });

  it("freezes at the cap however far past the newest snapshot the clock runs", () => {
    buffer.push(snap(0, [entity(1, { x: 0 })]));
    buffer.push(snap(1, [entity(1, { x: 10 })]));

    interpolator.sample(T0 + 100 + 400, sample);
    const atCap = sample.entities.get(1)!.x;
    interpolator.sample(T0 + 100 + 60_000, sample);

    expect(sample.extrapolatedMs).toBe(MAX_EXTRAPOLATION_MS);
    expect(sample.entities.get(1)!.x).toBeCloseTo(atCap, 6);
  });

  it("clamps to the oldest retained state when the render clock is behind everything", () => {
    buffer.push(snap(0, [entity(1, { x: 5 })]));
    buffer.push(snap(1, [entity(1, { x: 10 })]));

    interpolator.sample(T0 - 1_000, sample);
    expect(sample.entities.get(1)!.x).toBe(5);
    // The renderer is supposed to show a desync hint here, not draw silently.
    expect(sample.reliability).toBe(false);
    expect(sample.extrapolatedMs).toBe(0);
  });

  it("forgets every entity on reset so a resync leaves no ghosts", () => {
    buffer.push(snap(0, [entity(1), entity(2)]));
    interpolator.sample(T0 + 50, sample);
    expect(sample.entities.size).toBe(2);

    // Exactly what a reconnect does: drop the tables, drop the pooled views.
    buffer.clear();
    interpolator.reset();
    interpolator.sample(T0 + 150, sample);
    expect(sample.entities.size).toBe(0);
    expect(sample.reliability).toBe(false);
  });

  it("reuses one sample object and one entity map across frames", () => {
    buffer.push(snap(0, [entity(1, { x: 0 })]));
    buffer.push(snap(1, [entity(1, { x: 10 })]));
    const first = interpolator.sample(T0 + 50, sample);
    const entities = first.entities;
    const second = interpolator.sample(T0 + 100, sample);

    // A fresh Map per frame is the difference between zero and thousands of
    // allocations a second in the render loop.
    expect(second).toBe(first);
    expect(second.entities).toBe(entities);
  });
});
