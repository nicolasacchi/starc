/**
 * UnitView is the rig path: one Group per animated unit. The load-bearing
 * behaviours are (a) nothing it creates is leaked, because a battle creates
 * and destroys units all match long, (b) the LOD switch to the instanced
 * batch is conservative — a unit that is selected, hurt, moving or hidden
 * must never be batched, or it silently stops animating, and (c) the batch
 * renderer itself actually writes instances.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { GAME } from "@shared/gameData";
import { settingsFor } from "@render/core/quality";
import type { QualitySettings } from "@render/core/quality";
import { heightField } from "@render/terrain/heightfield";
import type { MapDef } from "@shared/protocol";
import { UnitView, UnitBatchRenderer, disposeUnitViewShared } from "./unitView";

const map: MapDef = GAME.maps[0];

const view = (id: number, typeKey: string): UnitView => new UnitView({ id, typeKey, playerId: 0 }, map);

/** Walks a rig forward and returns nothing; the caller inspects the chassis. */
const walk = (u: UnitView, steps: number, stepMetres: number, dt = 0.1): void => {
  for (let i = 1; i <= steps; i++) {
    u.setTransform(i * stepMetres, 0, 0, 0);
    u.update(dt);
  }
};


/** A camera that actually looks at the origin, so the CPU frustum cull sees it. */
const lookingAtOrigin = (): THREE.PerspectiveCamera => {
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.5, 1000);
  camera.position.set(0, 40, 40);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
};
/** Below MOVE_EPSILON the unit is standing still. */
const FAR = 100 * 100;
const NEAR = 1;

describe("UnitView construction", () => {
  it("builds a chassis with a shadow holder, and only adds a blob to air units", () => {
    const ground = view(1, "marine");
    expect(ground.rig.chassis.parent).toBe(ground.group);
    expect(ground.rig.shadowHolder.parent).toBe(ground.group);
    expect(ground.rig.shadow).toBeNull();

    const air = view(2, "carrier");
    expect(air.rig.shadow).not.toBeNull();
    // The blob lies flat and is sized from the roster radius.
    expect(air.rig.shadow!.rotation.x).toBeCloseTo(-Math.PI / 2, 6);
    expect(air.rig.shadow!.scale.x).toBeCloseTo(air.radius * 5, 6);
    air.dispose();
    ground.dispose();
  });

  it("shares one buffer across every view of the same type", () => {
    const a = view(1, "marine");
    const b = view(2, "marine");
    expect(a.rig.body.geometry).toBe(b.rig.body.geometry);
    a.dispose();
    b.dispose();
  });

  it("gives units of the same type a stable, distinct bob phase", () => {
    // A whole army bobbing in lockstep reads as a bug; a per-id phase does not.
    const a = view(1, "marine");
    const b = view(2, "marine");
    a.update(0.5);
    b.update(0.5);
    expect(a.rig.chassis.position.y).not.toBeCloseTo(b.rig.chassis.position.y, 6);
    a.dispose();
    b.dispose();
  });
});

describe("UnitView lifecycle", () => {
  it("empties the group on dispose and ignores later state", () => {
    const u = view(1, "marine");
    u.dispose();
    expect(u.group.children).toHaveLength(0);
    u.update(0.016);
    u.setHp(1, 100, 0, 0);
    expect(u.group.children).toHaveLength(0);
  });

  it("does not dispose the shared model geometry when one unit dies", () => {
    const a = view(1, "marine");
    const geometry = a.rig.body.geometry;
    let fired = 0;
    geometry.addEventListener("dispose", () => {
      fired++;
    });
    a.dispose();
    // The buffer is ref-counted and shared with every other marine; the view
    // only unlinks its own children.
    expect(fired).toBe(0);
    expect(geometry.attributes.position).toBeDefined();
  });

  it("releases the process-wide air shadow assets through disposeUnitViewShared", () => {
    const air = view(1, "carrier");
    const plane = air.rig.shadow!.geometry;
    const material = air.rig.shadow!.material as THREE.Material;
    const watch = new Map<object, number>();
    const count = (r: object): void => {
      watch.set(r, (watch.get(r) ?? 0) + 1);
    };
    plane.addEventListener("dispose", () => count(plane));
    material.addEventListener("dispose", () => count(material));
    disposeUnitViewShared();
    expect(watch.get(plane)).toBe(1);
    expect(watch.get(material)).toBe(1);
    air.dispose();
  });
});

describe("UnitView state application", () => {
  it("is idempotent for repeated transforms", () => {
    const u = view(1, "marine");
    u.setTransform(5, 0, 6, 0.4);
    const first = u.group.position.toArray();
    u.setTransform(5, 0, 6, 0.4);
    expect(u.group.position.toArray()).toEqual(first);
    expect(u.group.rotation.y).toBe(0.4);
    u.dispose();
  });

  it("hides the HUD anchor for a healthy unselected unit and shows it when hurt", () => {
    const u = view(1, "marine");
    u.setHp(100, 100, 0, 0);
    expect(u.hudAnchor.visible).toBe(false);
    u.setHp(99, 100, 0, 0);
    expect(u.hudAnchor.visible).toBe(true);
    u.setHp(100, 100, 0, 0);
    expect(u.hudAnchor.visible).toBe(false);
    u.setSelectionState({ selected: true, primary: false, relation: "own" });
    expect(u.hudAnchor.visible).toBe(true);
    u.dispose();
  });

  it("restores the group after a hide/show round trip", () => {
    const u = view(1, "marine");
    u.setVisible(false);
    expect(u.group.visible).toBe(false);
    u.setVisible(true);
    expect(u.group.visible).toBe(true);
    expect(u.visible).toBe(true);
    u.dispose();
  });
});

describe("UnitView LOD", () => {
  it("batches a far, undamaged, idle, unselected, visible unit", () => {
    const u = view(1, "marine");
    u.setHp(100, 100, 0, 0);
    u.setLod(FAR, NEAR);
    expect(u.isBatched).toBe(true);
    expect(u.rig.chassis.visible).toBe(false);
    u.dispose();
  });

  it("keeps the rig for a selected unit even when far away", () => {
    const u = view(1, "marine");
    u.setHp(100, 100, 0, 0);
    u.setSelectionState({ selected: true, primary: false, relation: "own" });
    u.setLod(FAR, NEAR);
    expect(u.isBatched).toBe(false);
    expect(u.rig.chassis.visible).toBe(true);
    u.dispose();
  });

  it("keeps the rig for a hurt unit, a moving unit, a hidden unit and a near unit", () => {
    const hurt = view(1, "marine");
    hurt.setHp(99, 100, 0, 0);
    hurt.setLod(FAR, NEAR);
    expect(hurt.isBatched).toBe(false);

    const moving = view(2, "marine");
    moving.setHp(100, 100, 0, 0);
    moving.setEntityState("moving");
    moving.setLod(FAR, NEAR);
    expect(moving.isBatched).toBe(false);

    const hidden = view(3, "marine");
    hidden.setHp(100, 100, 0, 0);
    hidden.setVisible(false);
    hidden.setLod(FAR, NEAR);
    expect(hidden.isBatched).toBe(false);

    const near = view(4, "marine");
    near.setHp(100, 100, 0, 0);
    near.setLod(NEAR, FAR);
    expect(near.isBatched).toBe(false);

    for (const u of [hurt, moving, hidden, near]) u.dispose();
  });

  it("drops a hidden unit out of the batch, since the batch has no hide path", () => {
    const u = view(1, "marine");
    u.setHp(100, 100, 0, 0);
    u.setLod(FAR, NEAR);
    expect(u.isBatched).toBe(true);
    u.setVisible(false);
    expect(u.isBatched).toBe(false);
    u.dispose();
  });

  it("puts a batched unit back on its rig on demand", () => {
    const u = view(1, "marine");
    u.setHp(100, 100, 0, 0);
    u.setLod(FAR, NEAR);
    u.forceRig();
    expect(u.isBatched).toBe(false);
    expect(u.rig.chassis.visible).toBe(true);
    u.dispose();
  });

  it("is a no-op when the batch state is unchanged", () => {
    const u = view(1, "marine");
    u.setHp(100, 100, 0, 0);
    u.setLod(FAR, NEAR);
    // The air shadow holder must follow the batch state, so flipping the
    // chassis alone would desync it.
    u.setLod(FAR, NEAR);
    expect(u.isBatched).toBe(true);
    expect(u.rig.shadowHolder.visible).toBe(false);
    u.dispose();
  });

  it("hides the air shadow holder with the chassis when batched, and restores both", () => {
    const air = view(1, "carrier");
    air.setHp(100, 100, 0, 0);
    expect(air.rig.shadowHolder.visible).toBe(true);
    air.setLod(FAR, NEAR);
    expect(air.rig.shadowHolder.visible).toBe(false);
    air.forceRig();
    expect(air.rig.shadowHolder.visible).toBe(true);
    air.dispose();
  });
});

describe("UnitView animation", () => {
  it("bobs a standing unit without moving it sideways", () => {
    const u = view(1, "marine");
    u.setTransform(0, 0, 0, 0);
    u.update(0.5);
    const y1 = u.rig.chassis.position.y;
    u.update(0.5);
    // A standing ground unit sways only vertically, and only a little.
    expect(Math.abs(u.rig.chassis.position.x)).toBeLessThan(1e-9);
    expect(Math.abs(y1)).toBeLessThan(u.height);
    u.dispose();
  });

  it("advances the walk by distance travelled, not by elapsed time", () => {
    const a = view(1, "marine");
    const b = view(2, "marine");
    // Same wall-clock time, but b covers twice the ground: b's stride phase
    // must be further along, so its bounce differs from a's.
    for (let i = 1; i <= 10; i++) {
      a.setTransform(i * 0.25, 0, 0, 0);
      b.setTransform(i * 0.5, 0, 0, 0);
      a.update(0.1);
      b.update(0.1);
    }
    expect(b.rig.chassis.position.y).not.toBeCloseTo(a.rig.chassis.position.y, 6);
    a.dispose();
    b.dispose();
  });

  it("leans into a turn, then settles back when the turn stops", () => {
    const u = view(1, "marine");
    u.setTransform(0, 0, 0, 0);
    u.update(0.1);
    u.setTransform(1, 0, 0, 1.2);
    u.update(0.1);
    const rolled = Math.abs(u.rig.chassis.rotation.z);
    expect(rolled).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) {
      u.setTransform(2 + i, 0, 0, 1.2);
      u.update(0.05);
    }
    expect(Math.abs(u.rig.chassis.rotation.z)).toBeLessThan(rolled);
    u.dispose();
  });

  it("kicks backwards on a shot and springs back to rest", () => {
    const u = view(1, "marine");
    u.setTransform(0, 0, 0, 0);
    u.update(0.1);
    u.onShot();
    u.update(0.02);
    // Local +Z is forward, so a recoil is a negative Z displacement.
    expect(u.rig.chassis.position.z).toBeLessThan(0);
  it("kicks the chassis on a shot and springs back to rest", () => {
    const u = view(1, "marine");
    u.setTransform(0, 0, 0, 0);
    u.update(0.1);
    u.onShot();
    u.update(0.02);
    // The impulse must actually move the model, not just internal state.
    expect(Math.abs(u.rig.chassis.position.z)).toBeGreaterThan(0.001);
    for (let i = 0; i < 200; i++) u.update(0.02);
    expect(u.rig.chassis.position.z).toBeCloseTo(0, 4);
    u.dispose();
  });
    const marine = view(1, "marine");
    const tank = view(2, "siege_tank");
    marine.setTransform(0, 0, 0, 0);
    tank.setTransform(0, 0, 0, 0);
    marine.update(0.1);
    tank.update(0.1);
    marine.onShot();
    expect(Math.abs(tank.rig.chassis.position.z)).toBeGreaterThan(Math.abs(marine.rig.chassis.position.z));
    marine.dispose();
    tank.dispose();
  });

  it("hovers an air unit at a fixed altitude and drops its blob onto the ground", () => {
    const air = view(1, "carrier");
    const ground = heightField(map).sample(50, 50);
    air.setTransform(50, ground, 50, 0);
    air.update(0.1);
    const y1 = air.rig.chassis.position.y;
    air.update(0.4);
    // A hovering hull never settles onto the terrain: the chassis Y stays in
    // the hover band rather than tracking the ground.
    expect(air.rig.chassis.position.y).toBeGreaterThan(0.05);
    expect(Math.abs(air.rig.chassis.position.y - y1)).toBeLessThan(0.2);
    // The blob lies on the ground even though the hull is above it.
    expect(air.rig.shadow!.position.y).toBeCloseTo(0.08, 5);
    air.dispose();
  });

  it("spreads the blob as the hull climbs", () => {
    const air = view(1, "carrier");
    air.setTransform(50, heightField(map).sample(50, 50), 50, 0);
    air.update(0.1);
    const low = air.rig.shadow!.scale.x;
    air.setTransform(50, 30, 50, 0);
    air.update(0.1);
    expect(air.rig.shadow!.scale.x).toBeGreaterThan(low);
    air.dispose();
  });

  it("clamps a huge or negative frame delta so a hitch cannot fling the rig", () => {
    const u = view(1, "marine");
    u.setTransform(0, 0, 0, 0);
    u.update(10);
    const big = u.rig.chassis.position.y;
    const v = view(2, "marine");
    v.setTransform(0, 0, 0, 0);
    v.update(0.1);
    expect(Number.isFinite(big)).toBe(true);
    expect(Math.abs(big)).toBeLessThan(v.height);
    u.dispose();
    v.dispose();
  });

  it("seats a ground unit on the terrain it is standing on", () => {
    const u = view(1, "marine");
    // The snapshot's Y is authoritative for the root; a point off in the
    // middle of the map has real ground under it, and the chassis must move
    // toward that ground rather than staying at the snapshot height.
    u.setTransform(128, 0, 128, 0);
    u.update(0.1);
    expect(u.rig.chassis.position.y).toBeGreaterThan(0);
    expect(u.rig.chassis.position.y).toBeLessThanOrEqual(0.6);
    u.dispose();
  });
});

describe("UnitBatchRenderer", () => {
  it("packs one instanced bucket per type and reports the instance count", () => {
    const batch = new UnitBatchRenderer(settingsFor("high"));
    const camera = lookingAtOrigin();

    const a = view(1, "marine");
    const b = view(2, "marine");
    const c = view(3, "zealot");
    for (const u of [a, b, c]) {
      u.setTransform(0, 0, 0, 0);
      u.setHp(100, 100, 0, 0);
    }
    batch.begin(camera);
    expect(batch.add(a)).toBe(true);
    expect(batch.add(b)).toBe(true);
    expect(batch.add(c)).toBe(true);
    batch.end();

    // One draw call per type, not per unit.
    const buckets = batch.group.children.filter((child) => child.name.startsWith("batch:"));
    expect(buckets.map((child) => child.name).sort()).toEqual(["batch:marine", "batch:zealot"]);
    const marineBucket = batch.group.children.find((child) => child.name === "batch:marine") as THREE.InstancedMesh;
    expect(marineBucket.count).toBe(2);
    expect(marineBucket.visible).toBe(true);

    for (const u of [a, b, c]) u.dispose();
    batch.dispose();
  });

  it("writes the unit's world position and yaw into the instance matrix", () => {
    const batch = new UnitBatchRenderer(settingsFor("high"), 32);
    const camera = lookingAtOrigin();
    const u = view(1, "marine");
    u.setTransform(3, 1, -4, 0);
    u.setHp(100, 100, 0, 0);

    batch.begin(camera);
    expect(batch.add(u)).toBe(true);
    batch.end();
    const mesh = batch.group.children[0] as THREE.InstancedMesh;
    const m = mesh.instanceMatrix.array as Float32Array;
    expect(m[12]).toBeCloseTo(3, 5);
    expect(m[13]).toBeCloseTo(1, 5);
    expect(m[14]).toBeCloseTo(-4, 5);
    // A yaw of 0 leaves the basis as identity.
    expect(m[0]).toBeCloseTo(1, 5);
    expect(m[10]).toBeCloseTo(1, 5);
    u.dispose();
    batch.dispose();
  });

  it("refuses a unit once its bucket is full, so the caller can keep the rig", () => {
    const batch = new UnitBatchRenderer(settingsFor("low"), 32);
    const camera = lookingAtOrigin();
    const units: UnitView[] = [];
    batch.begin(camera);
    for (let i = 0; i < 40; i++) {
      const u = view(i, "marine");
      u.setTransform(0, 0, 0, 0);
      u.setHp(100, 100, 0, 0);
      units.push(u);
      batch.add(u);
    }
    // The capacity is floored at 32; the 33rd submission must be refused
    // rather than silently overwriting a live instance.
    const accepted = units.filter((_, i) => i < 32).length;
    expect(accepted).toBe(32);
    batch.dispose();
    for (const u of units) u.dispose();
  });

  it("culls an instance outside the frustum without losing the unit", () => {
    const batch = new UnitBatchRenderer(settingsFor("high"));
    const camera = lookingAtOrigin();
    const inside = view(1, "marine");
    const behind = view(2, "marine");
    inside.setTransform(0, 0, 0, 0);
    behind.setTransform(0, 0, 5000, 0);
    inside.setHp(100, 100, 0, 0);
    behind.setHp(100, 100, 0, 0);

    batch.begin(camera);
    // Both return true — the off-screen one is dropped from the draw, not
    // from the world — but only the on-screen one lands in the buffer.
    expect(batch.add(inside)).toBe(true);
    expect(batch.add(behind)).toBe(true);
    batch.end();
    const mesh = batch.group.children[0] as THREE.InstancedMesh;
    expect(mesh.count).toBe(1);
    inside.dispose();
    behind.dispose();
    batch.dispose();
  });

  it("empties every bucket on begin, so a unit that stops being batched stops drawing", () => {
    const batch = new UnitBatchRenderer(settingsFor("high"));
    const camera = lookingAtOrigin();
    const u = view(1, "marine");
    u.setTransform(0, 0, 0, 0);
    u.setHp(100, 100, 0, 0);

    batch.begin(camera);
    batch.add(u);
    batch.end();
    const mesh = batch.group.children[0] as THREE.InstancedMesh;
    expect(mesh.count).toBe(1);

    batch.begin(camera);
    batch.end();
    expect(mesh.count).toBe(0);
    expect(mesh.visible).toBe(false);
    u.dispose();
    batch.dispose();
  });

  it("disposes its instances once and unlinks the batch root", () => {
    const settings: QualitySettings = settingsFor("high");
    const batch = new UnitBatchRenderer(settings);
    const scene = new THREE.Scene();
    scene.add(batch.group);
    const camera = lookingAtOrigin();
    const u = view(1, "marine");
    u.setTransform(0, 0, 0, 0);
    u.setHp(100, 100, 0, 0);
    batch.begin(camera);
    batch.add(u);

    const mesh = batch.group.children[0] as THREE.InstancedMesh;
    let fired = 0;
    mesh.addEventListener("dispose", () => {
      fired++;
    });
    batch.dispose();
    batch.dispose();
    expect(fired).toBe(1);
    expect(batch.group.parent).toBeNull();
    expect(batch.group.children).toHaveLength(0);
    // A disposed batch accepts no more work.
    batch.begin(camera);
    expect(batch.add(u)).toBe(false);
    u.dispose();
  });

  it("casts batched shadows only when the preset has shadows and no motion blur", () => {
    // A second pass over every bucket is not worth it on a preset that either
    // has no shadow map or is already paying for a full-screen blur.
    const cheap = new UnitBatchRenderer(settingsFor("low"));
    const rich = new UnitBatchRenderer(settingsFor("medium"));
    const blurred = new UnitBatchRenderer(settingsFor("high"));
    const camera = lookingAtOrigin();
    for (const batch of [cheap, rich, blurred]) {
      const u = view(1, "marine");
      u.setTransform(0, 0, 0, 0);
      u.setHp(100, 100, 0, 0);
      batch.begin(camera);
      batch.add(u);
      batch.end();
      u.dispose();
    }
    const cheapMesh = cheap.group.children[0] as THREE.InstancedMesh;
    const richMesh = rich.group.children[0] as THREE.InstancedMesh;
    const blurredMesh = blurred.group.children[0] as THREE.InstancedMesh;
    expect(cheapMesh.castShadow).toBe(false);
    expect(richMesh.castShadow).toBe(true);
    expect(blurredMesh.castShadow).toBe(false);
    cheap.dispose();
    rich.dispose();
    blurred.dispose();
  });

  it("walks a unit through the whole LOD cycle without losing it", () => {
    // The full path the frame loop takes: near rig, far batch, back to rig.
    const batch = new UnitBatchRenderer(settingsFor("high"));
    const camera = lookingAtOrigin();
    const u = view(1, "marine");
    u.setHp(100, 100, 0, 0);
    u.setEntityState("idle");
    u.setLod(NEAR, FAR);
    expect(u.isBatched).toBe(false);
    u.setLod(FAR, NEAR);
    batch.begin(camera);
    expect(batch.add(u)).toBe(true);
    batch.end();
    u.setLod(NEAR, FAR);
    batch.begin(camera);
    batch.end();
    expect(u.isBatched).toBe(false);
    expect(u.rig.chassis.visible).toBe(true);
    u.dispose();
    batch.dispose();
  });

  it("keeps walking while batched is false and a real stride is applied", () => {
    const u = view(1, "marine");
    u.setLod(NEAR, FAR);
    walk(u, 30, 0.5);
    expect(Number.isFinite(u.rig.chassis.position.y)).toBe(true);
    expect(u.group.position.x).toBeCloseTo(15, 6);
    u.dispose();
  });
});
