/**
 * Prediction is the "my unit starts walking on the click" hack. Everything here
 * is about the two ways it goes wrong in play: a unit that overshoots its order
 * (visible as a stutter or a rubber band when the snapshot arrives), and a
 * unit that never forgets the player's click.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SNAP_THRESHOLD_M, MovementPredictor } from "./prediction";
import type { PredictedUnit } from "./prediction";
import type { Snapshot } from "./snapshotBuffer";
import type { EntityState, ProtocolEntity } from "@shared/protocol";

const T0 = 1_700_000_000_000;
const MARINE_SPEED = 4; // m/s, from the shared roster
const TICK_MS = 50;

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
  return { tick, server_ms: T0 + tick * TICK_MS, ack, entities, events: [] };
}

describe("MovementPredictor", () => {
  let predictor: MovementPredictor;

  beforeEach(() => {
    predictor = new MovementPredictor({ playerId: 1 });
  });

  it("learns roster speed and radius from the shared data, not a constant", () => {
    predictor.applySnapshot(snap(1, [entity(1), entity(2, { ty: "siege_tank" })]));
    expect(predictor.predicted(1)?.speed).toBe(MARINE_SPEED);
    expect(predictor.predicted(1)?.radius).toBe(0.5);
    expect(predictor.predicted(2)?.radius).toBe(1.1);
  });

  it("covers at most speed * dt per step", () => {
    predictor.applySnapshot(snap(1, [entity(1)]));
    const unit = predictor.predicted(1)!;

    const moved = predictor.predictMove(unit, 100, 0, TICK_MS);
    // 4 m/s over 50 ms is 0.2 m; a bigger step means the client runs faster than
    // the server and every unit visibly overshoots its order.
    expect(moved).toBeCloseTo(MARINE_SPEED * (TICK_MS / 1000), 9);
    expect(unit.x).toBeCloseTo(0.2, 9);
  });

  it("never exceeds its speed however many ticks are requested at once", () => {
    predictor.applySnapshot(snap(1, [entity(1)]));
    predictor.queueCommand([{ c: "move", ids: [1], x: 500, z: 0 }], 1);

    predictor.update(8); // the per-frame catch-up ceiling

    // Eight ticks is 400 ms of walking; beyond that would be teleporting.
    expect(predictor.predicted(1)!.x).toBeLessThanOrEqual(MARINE_SPEED * 0.4 + 1e-9);
  });

  it("stops exactly on the order destination instead of oscillating around it", () => {
    predictor.applySnapshot(snap(1, [entity(1)]));
    predictor.queueCommand([{ c: "move", ids: [1], x: 3, z: 4 }], 1);

    for (let i = 0; i < 200 && predictor.predicted(1)!.order; i++) predictor.update(1);
    const unit = predictor.predicted(1)!;

    expect(unit.x).toBeCloseTo(3, 6);
    expect(unit.z).toBeCloseTo(4, 6);
    expect(unit.order).toBeNull();
    expect(unit.orderKind).toBe(0);
    expect(unit.st).toBe("idle");
  });

  it("faces the way the server does, not the way that reads naturally", () => {
    predictor.applySnapshot(snap(1, [entity(1)]));

    // `Systems::Movement` sets `angle = atan2(dx, dz)` and three.js turns
    // `rotation.y` into the heading `(sin θ, cos θ)` with `+Z` forward, so
    // straight along +Z is 0 and straight along +X is π/2. The intuitive
    // `atan2(dz, dx)` is 90° out on both axes and only looks right on the
    // diagonals, which is why a wrong convention survives casual play.
    const unit = predictor.predicted(1)!;
    unit.x = 0;
    unit.z = 0;
    predictor.predictMove(unit, 0, 10, TICK_MS);
    expect(unit.ang).toBeCloseTo(0, 6);

    unit.x = 0;
    unit.z = 0;
    predictor.predictMove(unit, 10, 0, TICK_MS);
    expect(unit.ang).toBeCloseTo(Math.PI / 2, 6);

    unit.x = 0;
    unit.z = 0;
    predictor.predictMove(unit, 10, 10, TICK_MS);
    expect(unit.ang).toBeCloseTo(Math.PI / 4, 6);
  });

  it("clamps a destination outside the world to the map edge", () => {
    predictor.applySnapshot(snap(1, [entity(1)]));
    predictor.queueCommand([{ c: "move", ids: [1], x: 5_000, z: 5_000 }], 1);
    for (let i = 0; i < 400 && predictor.predicted(1)!.order; i++) predictor.update(1);

    const unit = predictor.predicted(1)!;
    // Walking off the edge of the world is an instantly visible desync.
    expect(unit.x).toBeLessThanOrEqual(256);
    expect(unit.y).toBeLessThanOrEqual(256);
  });

  it("starts walking on the click, before the server has seen anything", () => {
    predictor.applySnapshot(snap(10, [entity(1)], 10));
    predictor.queueCommand([{ c: "move", ids: [1], x: 50, z: 0 }], 10);

    const unit = predictor.predicted(1)!;
    expect(unit.order).toEqual({ x: 50, z: 0 });
    expect(unit.st).toBe("moving");
  });

  it("keeps a click the server has not echoed even when the match-wide ack is past it", () => {
    predictor.applySnapshot(snap(10, [entity(1, { x: 0 })], 10));
    predictor.queueCommand([{ c: "move", ids: [1], x: 50, z: 0 }], 10);
    predictor.update(4);
    expect(predictor.predicted(1)!.x).toBeGreaterThan(0);

    // The server has no order for this unit yet, so it has not seen the
    // click — but `ack` is 1000 because some *other* client's batch got
    // there first. Retiring on `ack` would drop a live order on the floor
    // and freeze the unit where the server last put it.
    predictor.applySnapshot(snap(11, [entity(1, { x: 0, ord: 0 })], 1000));
    const unit = predictor.predicted(1)!;
    expect(unit.order).toEqual({ x: 50, z: 0 });
    predictor.update(1);
    // The unit must still be walking after the snapshot re-based it onto the
    // server's stale position.
    expect(unit.x).toBeGreaterThan(0);
    expect(unit.st).toBe("moving");
  });

  it("adopts the server's answer the moment the snapshot echoes an order", () => {
    predictor.applySnapshot(snap(10, [entity(1)], 10));
    predictor.queueCommand([{ c: "move", ids: [1], x: 50, z: 0 }], 10);

    // A destination that is not the one we sent is what a queued or
    // superseded order looks like; the server's answer wins either way.
    predictor.applySnapshot(snap(11, [entity(1, { ord: 1, ox: 12, oz: 0 })], 11));
    const unit = predictor.predicted(1)!;
    expect(unit.order).toEqual({ x: 12, z: 0 });
    expect(unit.localOrderTick).toBe(0);
  });

  it("stops predicting once the unit is no longer ours to override", () => {
    predictor.applySnapshot(snap(10, [entity(1, { x: 0 })], 10));
    predictor.queueCommand([{ c: "move", ids: [1], x: 50, z: 0 }], 10);
    predictor.update(2);
    expect(predictor.predicted(1)!.localOrderTick).toBe(10);

    predictor.applySnapshot(snap(11, [entity(1, { x: 0, st: "moving", ord: 1, ox: 50, oz: 0 })], 11));
    // The echo is the server confirming it consumed a command about this
    // unit, so the renderer gets the server's own position from here on.
    expect(predictor.predicted(1)!.localOrderTick).toBe(0);
  });

  it("gives up on a local order the server never echoes", () => {
    vi.useFakeTimers();
    try {
      const impatient = new MovementPredictor({ playerId: 1, orderTimeoutMs: 1_000 });
      impatient.applySnapshot(snap(1, [entity(1)]));
      impatient.queueCommand([{ c: "move", ids: [1], x: 50, z: 0 }], 1);
      vi.advanceTimersByTime(500);
      impatient.update(1);
      expect(impatient.predicted(1)!.x).toBeGreaterThan(0);

      vi.advanceTimersByTime(2_000);
      impatient.applySnapshot(snap(2, [entity(1, { x: 0 })]));
      // A send that never reached the server would otherwise walk a unit
      // across the map for the rest of the match.
      expect(impatient.predicted(1)!.order).toBeNull();
      expect(impatient.predicted(1)!.st).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests a correction when the server disagrees by more than the threshold", () => {
    predictor.applySnapshot(snap(10, [entity(1, { x: 0 })], 10));
    expect(predictor.needsCorrection()).toBe(false);

    // Locally walked 20 m; the server still has us at the origin.
    predictor.predictMove(predictor.predicted(1)!, 100, 0, 5_000);
    predictor.applySnapshot(snap(11, [entity(1, { x: 0 })], 11));

    // Without a correction the unit keeps walking a path the server rejected.
    expect(predictor.needsCorrection()).toBe(true);
    expect(predictor.lastCorrection().errorMetres).toBeGreaterThan(DEFAULT_SNAP_THRESHOLD_M);
    expect(predictor.predicted(1)!.x).toBe(0);

    expect(predictor.consumeCorrection()).toBe(true);
    expect(predictor.needsCorrection()).toBe(false);
  });

  it("does not request a correction for disagreement inside the threshold", () => {
    predictor.applySnapshot(snap(10, [entity(1, { x: 0 })], 10));
    predictor.predictMove(predictor.predicted(1)!, 100, 0, 100); // 0.4 m
    predictor.applySnapshot(snap(11, [entity(1, { x: 0 })], 11));
    // Snapping on every millimetre of jitter is what makes a unit vibrate.
    expect(predictor.needsCorrection()).toBe(false);
  });

  it("only predicts entities the local player owns", () => {
    predictor.applySnapshot(snap(1, [entity(1), entity(2, { pl: 2 })]));
    expect([...predictor.predictions().keys()]).toEqual([1]);
  });

  it("forgets a unit the player no longer owns, so no ghost survives", () => {
    predictor.applySnapshot(snap(1, [entity(1), entity(2)]));
    expect(predictor.predicted(2)).not.toBeNull();

    predictor.applySnapshot(snap(2, [entity(1)]));
    // A destroyed (or reassigned) unit left in the map is a unit that cannot be
    // clicked but still draws.
    expect(predictor.predicted(2)).toBeNull();
    expect(predictor.predicted(1)).not.toBeNull();
  });

  it("does not move a dead unit", () => {
    predictor.applySnapshot(snap(1, [entity(1, { st: "dead" as EntityState })]));
    predictor.queueCommand([{ c: "move", ids: [1], x: 50, z: 0 }], 1);
    predictor.update(10);
    expect(predictor.predicted(1)!.x).toBe(0);
  });

  it("clears the order when the player hits stop", () => {
    predictor.applySnapshot(snap(1, [entity(1)]));
    predictor.queueCommand([{ c: "move", ids: [1], x: 50, z: 0 }], 1);
    predictor.queueCommand([{ c: "stop", ids: [1] }], 2);

    const unit = predictor.predicted(1)!;
    expect(unit.order).toBeNull();
    expect(unit.st).toBe("idle");
  });

  it("keeps only the newest click's destination, however many are queued", () => {
    predictor.applySnapshot(snap(0, [entity(1)]));
    for (let i = 1; i <= 20; i++) {
      predictor.queueCommand([{ c: "move", ids: [1], x: i, z: 0 }], i, `batch-${i}`);
    }
    // Every queued batch is remembered per unit rather than in a growing
    // table, so a long click-spam cannot leak — and the last click is the one
    // the unit actually walks to.
    expect(predictor.predicted(1)!.order).toEqual({ x: 20, z: 0 });
  });

  it("keeps predicting after a long stall by bounding the catch-up", () => {
    predictor.applySnapshot(snap(1, [entity(1)]));
    predictor.queueCommand([{ c: "move", ids: [1], x: 1_000, z: 0 }], 1);
    predictor.update(1_000);
    // One long frame must not spin the main thread for a thousand steps.
    expect(predictor.predicted(1)!.x).toBeLessThanOrEqual(MARINE_SPEED * 0.4 + 1e-9);
  });

  it("reset forgets units and the correction flag", () => {
    predictor.applySnapshot(snap(10, [entity(1, { x: 0 })], 10));
    predictor.queueCommand([{ c: "move", ids: [1], x: 9, z: 0 }], 10);
    predictor.applySnapshot(snap(11, [entity(1, { x: 50 })], 11));

    predictor.reset();

    expect(predictor.predictions().size).toBe(0);
    expect(predictor.needsCorrection()).toBe(false);
  });

  it("keeps working when the destination is already reached", () => {
    predictor.applySnapshot(snap(1, [entity(1, { x: 5, z: 5 })]));
    const unit = predictor.predicted(1)! as PredictedUnit;
    const moved = predictor.predictMove(unit, 5, 5, TICK_MS);
    expect(moved).toBe(0);
    expect(unit.order).toBeNull();
  });
});
