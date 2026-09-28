/**
 * BuildingView carries the state a player reads at a glance: how far along
 * construction is, whether the thing is burning, where its rally point is and
 * whether its production ring is running. The thresholds are the whole point
 * of this file — a building that starts smoking at 51% or that scales from
 * its centre instead of its base is visible in-game and wrong.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { GAME } from "@shared/gameData";
import { settingsFor } from "@render/core/quality";
import type { QualitySettings } from "@render/core/quality";
import type { MapDef, ProtocolEntity } from "@shared/protocol";
import { heightField } from "@render/terrain/heightfield";
import { BuildingView, disposeBuildingViewShared } from "./buildingView";

const map: MapDef = GAME.maps[0];
const RICH = settingsFor("high");
const CHEAP = settingsFor("low");

const view = (typeKey: string, id = 1, settings: QualitySettings = RICH): BuildingView =>
  new BuildingView({ id, typeKey, playerId: 0 }, map, settings);

/**
 * The rig's private children. Reading them is the only way to assert what the
 * player actually sees; the public surface is vitals and state.
 */
interface Rig {
  model: THREE.Group;
  scaffold: THREE.Group;
  barHolder: THREE.Group;
  barBack: THREE.Mesh<THREE.PlaneGeometry, THREE.Material>;
  barFill: THREE.Mesh<THREE.PlaneGeometry, THREE.Material>;
  ring: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  rally: THREE.Group;
  flag: THREE.Mesh<THREE.PlaneGeometry, THREE.Material>;
  scorch: THREE.Mesh;
  dust: { mesh: THREE.InstancedMesh; material: THREE.ShaderMaterial };
  smoke: { mesh: THREE.InstancedMesh; material: THREE.ShaderMaterial };
  hasScaffold: boolean;
}

const rig = (b: BuildingView): Rig => b as unknown as Rig;

/**
 * Pushes one `game:snapshot` entity at a view the way `SceneManager` does, then
 * runs a frame. Building the payload from the wire (rather than poking the
 * view) is the point: `prog` and `st` only mean anything together, and a test
 * that sets them independently can pin a state the sim never sends.
 */
const wire = (b: BuildingView, entity: Pick<ProtocolEntity, "st"> & Partial<ProtocolEntity>): void => {
  const e: ProtocolEntity = {
    id: b.id,
    ty: b.typeKey,
    pl: b.playerId,
    x: 0,
    z: 0,
    y: 0,
    hp: 1000,
    hp_max: 1000,
    mp: 0,
    mp_max: 0,
    ang: 0,
    ...entity,
  };
  b.setTransform(e.x, e.y, e.z, e.ang);
  b.setHp(e.hp, e.hp_max, e.mp, e.mp_max);
  b.setEntityState(e.st);
  b.setVisible(e.st !== "dead" && e.hp > 0);
  b.setOrder(e.ord ?? 0, e.ox ?? e.x, e.oz ?? e.z, e.prog ?? 0);
  b.update(0.016);
};

/** A construction site, as the sim reports it: `st: "building"` plus `prog`. */
const building = (b: BuildingView, progress: number): void => {
  b.setEntityState("building");
  b.setOrder(0, 0, 0, progress);
  b.update(0.016);
};

describe("BuildingView construction", () => {
  it("builds the model, scaffolding, bar, ring, rally and scorch as separate parts", () => {
    const b = view("barracks");
    const r = rig(b);
    expect(r.model.children).toHaveLength(1);
    expect(r.scaffold.parent).toBe(b.group);
    expect(r.barHolder.parent).toBe(b.group);
    expect(r.ring.parent).toBe(b.group);
    expect(r.rally.parent).toBe(b.group);
    expect(r.scorch.parent).toBe(b.group);
    expect(b.kind).toBe("building");
    expect(b.isAir).toBe(false);
    b.dispose();
  });

  it("starts with the construction furniture hidden on a finished building", () => {
    const b = view("barracks");
    const r = rig(b);
    b.setEntityState("idle");
    b.setHp(1000, 1000, 0, 0);
    b.update(0.016);
    expect(r.scaffold.visible).toBe(false);
    expect(r.barHolder.visible).toBe(false);
    expect(r.dust.mesh.visible).toBe(false);
    expect(r.smoke.mesh.visible).toBe(false);
    expect(r.ring.visible).toBe(false);
    expect(r.rally.visible).toBe(false);
    expect(r.scorch.visible).toBe(false);
    b.dispose();
  });

  it("skips the scaffold only where the merged geometry already carries a mast", () => {
    // A mast inside the shell plus four more poles reads as a scaffold forest.
    expect(rig(view("barracks")).hasScaffold).toBe(true);
    expect(rig(view("command_center")).hasScaffold).toBe(false);
    expect(rig(view("starport")).hasScaffold).toBe(false);
    expect(rig(view("refinery")).hasScaffold).toBe(false);
  });

  it("scales the progress bar to the building's footprint", () => {
    const wide = rig(view("hatchery", 1)).barBack.scale.x;
    const narrow = rig(view("pylon", 2)).barBack.scale.x;
    expect(wide).toBeGreaterThan(narrow);
    expect(narrow).toBeGreaterThanOrEqual(2);
  });

  it("halves the puff counts on a preset without post-processing", () => {
    const rich = rig(view("barracks", 1, RICH));
    const cheap = rig(view("barracks", 2, CHEAP));
    expect(rich.dust.mesh.count).toBe(10);
    expect(rich.smoke.mesh.count).toBe(10);
    expect(cheap.dust.mesh.count).toBe(5);
    expect(cheap.smoke.mesh.count).toBe(5);
    rich.dust.mesh.dispose();
    cheap.dust.mesh.dispose();
  });
});

describe("BuildingView construction progress", () => {
  it("scales the shell up monotonically as progress rises", () => {
    const b = view("barracks");
    const r = rig(b);
    const heights: number[] = [];
    for (const progress of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      building(b, progress);
      heights.push(r.model.scale.y);
    }
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i], `progress step ${i}`).toBeGreaterThan(heights[i - 1]);
    }
    b.dispose();
  });

  it("raises the shell out of the ground rather than growing it from the centre", () => {
    const b = view("nexus");
    const r = rig(b);
    b.setTransform(0, 0, 0, 0);
    // The shell is anchored at its own base, so a half-built building must
    // still stand on the ground: its world-space base cannot drift upwards.
    const worldBase = (): number => {
      const shell = r.model.children[0] as THREE.Mesh;
      shell.geometry.computeBoundingBox();
      r.model.updateWorldMatrix(true, true);
      const box = shell.geometry.boundingBox!.clone();
      box.applyMatrix4(shell.matrixWorld);
      return box.min.y;
    };
    building(b, 0.25);
    const lowBase = worldBase();
    building(b, 0.5);
    const midBase = worldBase();
    building(b, 1);
    const doneBase = worldBase();
    // Every stage is at or below the finished footprint's base, and the
    // finished building sits on the ground rather than floating.
    expect(lowBase).toBeLessThanOrEqual(midBase + 1e-6);
    expect(midBase).toBeLessThanOrEqual(doneBase + 1e-6);
    expect(doneBase).toBeCloseTo(0, 3);
  });

  it("clamps progress above one to a finished building and below zero to a stump", () => {
    const b = view("barracks");
    const r = rig(b);
    building(b, 5);
    expect(r.model.scale.y).toBe(1);
    expect(r.model.position.y).toBeCloseTo(0, 9);
    building(b, -3);
    expect(r.model.scale.y).toBeGreaterThan(0);
    expect(r.model.scale.y).toBeLessThan(0.1);
    b.dispose();
  });

  it("never collapses the shell to nothing, so the footprint still reads", () => {
    const b = view("nexus");
    const r = rig(b);
    building(b, 0);
    expect(r.model.scale.y).toBeGreaterThan(0);
    b.dispose();
  });

  it("shows the scaffold and progress bar only while under construction", () => {
    const b = view("barracks");
    const r = rig(b);
    building(b, 0.4);
    expect(r.scaffold.visible).toBe(true);
    expect(r.barHolder.visible).toBe(true);
    expect(r.rally.visible).toBe(false);

    b.setEntityState("idle");
    b.setOrder(0, 0, 0, 0);
    b.update(0.016);
    expect(r.scaffold.visible).toBe(false);
    expect(r.barHolder.visible).toBe(false);
    b.dispose();
  });

  it("reads construction state from `st`, not from a bare progress number", () => {
    // On the wire `st` is "building" for the whole of construction and only
    // becomes "idle" once the shell is up, so `prog` in (0, 1) never has to be
    // second-guessed as construction. It means the same range when `st` is
    // "training" — that is production, and the ring owns it.
    const b = view("barracks");
    const r = rig(b);
    b.setEntityState("building");
    b.setOrder(0, 0, 0, 0.4);
    b.update(0.016);
    expect(r.barHolder.visible).toBe(true);
    expect(r.model.scale.y).toBeLessThan(1);
    expect(r.ring.visible).toBe(false);
    b.dispose();
  });

  it("fills the bar in step with the shell and keeps it left-aligned", () => {
    const b = view("barracks");
    const r = rig(b);
    b.setViewCamera(new THREE.PerspectiveCamera());
    building(b, 0);
    expect(r.barFill.scale.x).toBeCloseTo(0, 6);
    building(b, 0.5);
    const halfWidth = r.barBack.scale.x;
    expect(r.barFill.scale.x).toBeGreaterThan(0);
    expect(r.barFill.scale.x).toBeLessThan(halfWidth);
    // Left-aligned: the fill's left edge is pinned to the back plate's left.
    expect(r.barFill.position.x - r.barFill.scale.x / 2).toBeCloseTo(-halfWidth / 2, 6);
    building(b, 1);
    expect(r.barFill.scale.x).toBeCloseTo(halfWidth, 6);
    expect(r.barFill.position.x).toBeCloseTo(0, 6);
    b.dispose();
  });

  it("animates the dust puffs, not just the shell", () => {
    const b = view("barracks");
    const r = rig(b);
    building(b, 0.5);
    const before = Float32Array.from(r.dust.mesh.instanceMatrix.array as Float32Array);
    for (let i = 0; i < 20; i++) b.update(0.05);
    const after = r.dust.mesh.instanceMatrix.array as Float32Array;
    expect(Array.from(after)).not.toEqual(Array.from(before));
    b.dispose();
  });

  it("shows the construction dust only while the shell is going up", () => {
    // The dust is a construction cue like the scaffold and the bar. Simulating
    // puffs nobody can see would be a hundred matrix writes a frame for nothing.
    const b = view("barracks");
    const r = rig(b);
    building(b, 0.5);
    expect(r.dust.mesh.visible).toBe(true);

    b.setEntityState("idle");
    b.setOrder(0, 0, 0, 0);
    b.update(0.016);
    expect(r.dust.mesh.visible).toBe(false);
    b.dispose();
  });
});

describe("BuildingView damage states", () => {
  it("keeps a healthy building clean", () => {
    const b = view("barracks", 1);
    const r = rig(b);
    b.setEntityState("idle");
    b.setHp(1000, 1000, 0, 0);
    b.update(0.016);
    expect(r.smoke.mesh.visible).toBe(false);
    expect(r.scorch.visible).toBe(false);
    b.dispose();
  });

  it("does not smoke a building that is only barely hurt", () => {
    const b = view("barracks");
    const r = rig(b);
    b.setHp(900, 1000, 0, 0);
    b.update(0.016);
    expect(r.smoke.mesh.visible).toBe(false);
    expect(r.scorch.visible).toBe(false);
    b.dispose();
  });

  it("smokes below half health and not at exactly half", () => {
    const b = view("barracks");
    const r = rig(b);
    b.setHp(510, 1000, 0, 0);
    b.update(0.016);
    expect(r.smoke.mesh.visible).toBe(false);
    b.setHp(500, 1000, 0, 0);
    b.update(0.016);
    expect(r.smoke.mesh.visible).toBe(false);
    b.setHp(499, 1000, 0, 0);
    b.update(0.016);
    expect(r.smoke.mesh.visible).toBe(true);
    // Scorch is a quarter-health state, not a half-health one.
    expect(r.scorch.visible).toBe(false);
    b.dispose();
  });

  it("scorches below a quarter health and not at exactly a quarter", () => {
    const b = view("barracks");
    const r = rig(b);
    b.setHp(260, 1000, 0, 0);
    b.update(0.016);
    expect(r.scorch.visible).toBe(false);
    b.setHp(250, 1000, 0, 0);
    b.update(0.016);
    expect(r.scorch.visible).toBe(false);
    b.setHp(249, 1000, 0, 0);
    b.update(0.016);
    expect(r.scorch.visible).toBe(true);
    expect(r.smoke.mesh.visible).toBe(true);
    b.dispose();
  });

  it("scorches only a building that still stands", () => {
    const b = view("barracks");
    const r = rig(b);
    b.setHp(0, 1000, 0, 0);
    b.update(0.016);
    expect(r.scorch.visible).toBe(false);
    expect(r.smoke.mesh.visible).toBe(false);
    b.dispose();
  });

  it("always shows the health bar of a damaged building, and only a selected healthy one", () => {
    const b = view("barracks");
    b.setHp(1000, 1000, 0, 0);
    expect(b.hudAnchor.visible).toBe(false);
    b.setHp(999, 1000, 0, 0);
    expect(b.hudAnchor.visible).toBe(true);
    b.setHp(1000, 1000, 0, 0);
    expect(b.hudAnchor.visible).toBe(false);
    b.setSelectionState({ selected: true, primary: false, relation: "own" });
    expect(b.hudAnchor.visible).toBe(true);
    b.setSelectionState({ selected: false, primary: false, relation: "own" });
    expect(b.hudAnchor.visible).toBe(false);
    b.dispose();
  });

  it("hides the bar again when the building leaves the world", () => {
    const b = view("barracks");
    b.setSelectionState({ selected: true, primary: false, relation: "own" });
    b.setVisible(false);
    expect(b.hudAnchor.visible).toBe(false);
    b.setVisible(true);
    expect(b.group.visible).toBe(true);
    b.dispose();
  });
});

describe("BuildingView production ring", () => {
  it("shows the ring on a building that is producing, and only then", () => {
    // The three states a barracks is actually in, each as the snapshot the
    // server sends. `prog` is present in (0, 1) for the first two and omitted
    // for the third, so the ring has to be told apart by `st`.
    const b = view("barracks");
    const r = rig(b);

    wire(b, { st: "building", prog: 0.4 });
    expect(r.ring.visible).toBe(false);
    expect(r.barHolder.visible).toBe(true);

    wire(b, { st: "training", prog: 0.4 });
    expect(r.ring.visible).toBe(true);
    expect(r.barHolder.visible).toBe(false);
    expect(r.model.scale.y).toBe(1);

    wire(b, { st: "idle" });
    expect(r.ring.visible).toBe(false);
    b.dispose();
  });

  it("feeds the ring uniform the production progress", () => {
    const b = view("barracks");
    const r = rig(b);
    const material = r.ring.material as THREE.ShaderMaterial;
    wire(b, { st: "training", prog: 0.65 });
    expect(material.uniforms.uProgress.value).toBeCloseTo(0.65, 6);
    b.dispose();
  });

  it("leaves the ring alone when a training order is issued but not started", () => {
    // `train_progress` is still 0, so the sim omits `prog` and it arrives as 0.
    const b = view("barracks");
    const r = rig(b);
    wire(b, { st: "training" });
    expect(r.ring.visible).toBe(false);
    b.dispose();
  });
});

describe("BuildingView rally flag", () => {
  it("is hidden until a rally point is set, and hides again on null", () => {
    const b = view("barracks");
    const r = rig(b);
    b.setEntityState("idle");
    b.update(0.016);
    expect(r.rally.visible).toBe(false);
    b.setRallyPoint(20, 30);
    b.update(0.016);
    expect(r.rally.visible).toBe(true);
    b.setRallyPoint(null);
    b.update(0.016);
    expect(r.rally.visible).toBe(false);
    b.dispose();
  });

  it("stands the flag on the ground at the rally point, in the building's local frame", () => {
    const b = view("barracks");
    const r = rig(b);
    const rallyX = 40;
    const rallyZ = 40;
    b.setTransform(0, 0, 0, 0);
    b.setEntityState("idle");
    b.setRallyPoint(rallyX, rallyZ);
    b.update(0.016);
    const groundY = heightField(map).sample(rallyX, rallyZ);
    expect(r.rally.position.x).toBeCloseTo(rallyX, 4);
    expect(r.rally.position.z).toBeCloseTo(rallyZ, 4);
    expect(r.rally.position.y).toBeCloseTo(groundY, 4);
    b.dispose();
  });

  it("rotates the rally offset with the building, so the flag stays put in the world", () => {
    const b = view("barracks");
    const r = rig(b);
    const rallyX = 10;
    const rallyZ = 0;
    b.setTransform(0, 0, 0, 0);
    b.setEntityState("idle");
    b.setRallyPoint(rallyX, rallyZ);
    b.update(0.016);
    const unrotated = r.rally.position.clone();

    b.setTransform(0, 0, 0, Math.PI / 2);
    b.update(0.016);
    // Turning the building a quarter turn must move the flag in local space,
    // because the rally point did not move.
    expect(r.rally.position.x).not.toBeCloseTo(unrotated.x, 3);
    b.dispose();
  });

  it("waves the banner while the flag is up", () => {
    const b = view("barracks");
    const r = rig(b);
    b.setEntityState("idle");
    b.setRallyPoint(5, 5);
    b.update(0.016);
    const first = r.flag.rotation.y;
    for (let i = 0; i < 30; i++) b.update(0.05);
    expect(r.flag.rotation.y).not.toBeCloseTo(first, 6);
    b.dispose();
  });

  it("hides the flag while the building is still going up", () => {
    const b = view("barracks");
    const r = rig(b);
    b.setRallyPoint(5, 5);
    building(b, 0.5);
    expect(r.rally.visible).toBe(false);
    b.setEntityState("idle");
    b.setOrder(0, 0, 0, 0);
    b.update(0.016);
    expect(r.rally.visible).toBe(true);
    b.dispose();
  });
});

describe("BuildingView disposal", () => {
  it("emits dispose for the per-building shader materials and cloned geometry", () => {
    const b = view("barracks");
    const r = rig(b);
    const owned: THREE.BufferGeometry[] = [
      r.ring.geometry,
      r.dust.mesh.geometry,
      r.smoke.mesh.geometry,
    ];
    const ownedMaterials: THREE.Material[] = [r.ring.material, r.dust.material, r.smoke.material];
    const fired = [...owned, ...ownedMaterials].map(() => 0);
    [...owned, ...ownedMaterials].forEach((resource, i) => {
      resource.addEventListener("dispose", () => {
        fired[i]++;
      });
    });
    b.dispose();
    // Every one of these is owned by this view alone; missing one is a leak
    // that only shows up as a slow GPU-memory climb over a long match.
    expect(fired).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("does not dispose the process-wide shared primitives, which other buildings still use", () => {
    const a = view("barracks", 1);
    const sharedCube = (rig(a).scaffold.children[0] as THREE.Mesh).geometry;
    let fired = 0;
    sharedCube.addEventListener("dispose", () => {
      fired++;
    });
    a.dispose();
    // The scaffold cubes are the shared BoxGeometry; only disposeBuilding-
    // ViewShared may release them.
    expect(fired).toBe(0);
  });

  it("empties the group and detaches from the scene", () => {
    const scene = new THREE.Scene();
    const b = view("barracks");
    scene.add(b.group);
    b.dispose();
    expect(b.group.children).toHaveLength(0);
    expect(b.group.parent).toBeNull();
  });

  it("releases resources exactly once across a double dispose", () => {
    const b = view("barracks");
    const ring = rig(b).ring.material;
    let fired = 0;
    ring.addEventListener("dispose", () => {
      fired++;
    });
    b.dispose();
    b.dispose();
    expect(fired).toBe(1);
  });

  it("ignores state and animation pushed after disposal", () => {
    const b = view("barracks");
    b.dispose();
    b.setHp(1, 1000, 0, 0);
    building(b, 0.5);
    b.update(0.016);
    expect(b.group.children).toHaveLength(0);
  });

  it("releases every shared primitive, texture and material through disposeBuildingViewShared", () => {
    const b = view("barracks", 1);
    const b2 = view("factory", 2);
    const r = rig(b);
    const r2 = rig(b2);
    // The shared pole material and the puff texture, reached through two
    // live views so the watch is not holding something private.
    const pole = (r.scaffold.children[0] as THREE.Mesh).material as THREE.Material;
    const flagA = r.flag.material;
    const flagB = r2.flag.material;
    expect(flagA).toBe(flagB);
    const fired = new Map<object, number>();
    for (const resource of [pole, flagA]) {
      fired.set(resource, 0);
      resource.addEventListener("dispose", () => {
        fired.set(resource, (fired.get(resource) ?? 0) + 1);
      });
    }
    disposeBuildingViewShared();
    expect(fired.get(pole)).toBe(1);
    expect(fired.get(flagA)).toBe(1);
    b.dispose();
    b2.dispose();
  });
});
