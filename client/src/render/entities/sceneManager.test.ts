/**
 * SceneManager is the only owner of the view registry, and the only thing
 * that turns 10 Hz snapshots into something on screen. These tests run
 * headlessly: with no canvas there is no WebGL2 context, so the GL subsystems
 * are skipped and the path that matters — applySnapshot diffing the registry
 * and pushing state into the views — is what runs.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { GAME } from "@shared/gameData";
import { settingsFor } from "@render/core/quality";
import { heightField } from "@render/terrain/heightfield";
import type { ProtocolEntity, MapDef, EntityState, Command } from "@shared/protocol";
import { SceneManager } from "./sceneManager";
import type { Relation } from "./entityView";
import type { EntityView } from "./entityView";

const map: MapDef = GAME.maps[0];

/** The registry is private; these tests read it to assert the diff by identity. */
interface Registry {
  readonly views: Map<number, EntityView>;
  readonly activeViews: EntityView[];
}

const registry = (sm: SceneManager): Registry => sm as unknown as Registry;

/** A tick that advances on every read, so each snapshot is a later one. */
const nextTick = (): number => {
  TICK += 1;
  return TICK;
};
let TICK = 0;

const manager = (myPlayerId = 0): SceneManager =>
  new SceneManager(null, map, settingsFor("medium"), myPlayerId);

/** One snapshot entity with the vitals fields the wire always carries. */
const entity = (over: Partial<ProtocolEntity> & Pick<ProtocolEntity, "id" | "ty">): ProtocolEntity => ({
  pl: 0,
  x: 10,
  y: 0,
  z: 20,
  hp: 100,
  hp_max: 100,
  mp: 0,
  mp_max: 0,
  ang: 0,
  st: "idle" as EntityState,
  ...over,
});

const marine = (id: number, over: Partial<ProtocolEntity> = {}): ProtocolEntity =>
  entity({ id, ty: "marine", ...over });

const barracks = (id: number, over: Partial<ProtocolEntity> = {}): ProtocolEntity =>
  entity({ id, ty: "barracks", hp: 1000, hp_max: 1000, ...over });

describe("SceneManager headless construction", () => {
  it("runs the snapshot path with no canvas and no GL context", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1)] });
    sm.update(1 / 60);
    expect(registry(sm).views.size).toBe(1);
    sm.dispose();
  });

  it("renders nothing rather than throwing when there is no renderer", () => {
    const sm = manager();
    sm.render();
    sm.dispose();
  });

  // A quality switch genuinely tears the whole GL stack down and rebuilds it
  // twice, so it is the slowest thing in this file. Under coverage
  // instrumentation that exceeds the default 5 s per-test budget, which is an
  // artefact of measuring, not of the code — hence the explicit timeout rather
  // than trimming the assertions.
  it("survives a quality change and keeps the views it already had", { timeout: 30_000 }, () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1), barracks(2)] });
    const before = registry(sm).views.get(1);
    sm.setQuality("low");
    sm.setQuality("high");
    // A quality switch rebuilds the GL stack, but the world must not blink.
    expect(registry(sm).views.size).toBe(2);
    expect(registry(sm).views.get(1)).toBe(before);
    sm.dispose();
  });

  it("ignores a quality change to the preset it is already on", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1)] });
    const before = registry(sm).views.get(1);
    sm.setQuality("medium");
    expect(registry(sm).views.get(1)).toBe(before);
    sm.dispose();
  });
});

describe("SceneManager applySnapshot reaches the views", () => {
  it("puts the snapshot's entities in the registry, not just in the HUD", () => {
    // This is the exact defect that shipped once: applySnapshot had no
    // caller and the world was never drawn. The registry is the world.
    const sm = manager();
    const snapshot = { tick: nextTick(), entities: [marine(1), barracks(2), marine(3, { ty: "zealot" })] };
    sm.applySnapshot(snapshot);
    const views = registry(sm).views;
    expect(views.size).toBe(3);
    expect(views.get(1)!.typeKey).toBe("marine");
    expect(views.get(2)!.typeKey).toBe("barracks");
    expect(views.get(2)!.kind).toBe("building");
    expect(views.get(3)!.typeKey).toBe("zealot");
    sm.dispose();
  });

  it("adds every view to the scene graph so it can actually be drawn", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1), barracks(2)] });
    const scene = (sm as unknown as { scene: THREE.Scene }).scene;
    const groups = [...registry(sm).views.values()].map((v) => v.group);
    for (const group of groups) expect(group.parent).toBe(scene);
    sm.dispose();
  });

  it("pushes vitals, state and order into the view", () => {
    const sm = manager();
    sm.applySnapshot({
      tick: nextTick(),
      entities: [barracks(1, { hp: 420, hp_max: 1000, mp: 7, mp_max: 50, st: "building", prog: 0.4 })],
    });
    const view = registry(sm).views.get(1)!;
    expect([view.hp, view.hpMax, view.shield, view.shieldMax]).toEqual([420, 1000, 7, 50]);
    expect(view.state).toBe("building");
    sm.dispose();
  });

  it("hides a dead or drained entity and shows a live one", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1, { st: "dead" }), marine(2, { hp: 0 })] });
    expect(registry(sm).views.get(1)!.visible).toBe(false);
    expect(registry(sm).views.get(2)!.visible).toBe(false);
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1, { st: "idle" }), marine(2, { hp: 10 })] });
    expect(registry(sm).views.get(1)!.visible).toBe(true);
    expect(registry(sm).views.get(2)!.visible).toBe(true);
    sm.dispose();
  });

  it("skips an entity whose type is not in the roster instead of throwing", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1), entity({ id: 2, ty: "not_a_real_unit" })] });
    expect(registry(sm).views.size).toBe(1);
    expect(registry(sm).views.has(2)).toBe(false);
    sm.dispose();
  });

  it("moves the views to the snapshot's world positions on the first frame", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1, { x: 30, y: 1.5, z: -12, ang: 0.5 })] });
    const view = registry(sm).views.get(1)!;
    sm.update(0.016);
    expect(view.group.position.toArray()).toEqual([30, 1.5, -12]);
    expect(view.group.rotation.y).toBeCloseTo(0.5, 6);
    sm.dispose();
  });

  it("interpolates toward the newer snapshot rather than snapping to it", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1, { x: 0 })] });
    sm.update(0.016);
    const view = registry(sm).views.get(1)!;
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1, { x: 10 })] });
    // Immediately after the snapshot the view is still where it was; it walks
    // to the new position over the next interpolation interval.
    expect(view.group.position.x).toBeCloseTo(0, 6);
    const path: number[] = [];
    for (let i = 0; i < 6; i++) {
      sm.update(0.016);
      path.push(view.group.position.x);
    }
    // Monotonically closing on the new position, never jumping past it in one
    // frame: a 10 m jump has to take the whole interval to cover.
    for (let i = 1; i < path.length; i++) expect(path[i]).toBeGreaterThan(path[i - 1]);
    expect(path[0]).toBeLessThan(10);
    sm.dispose();
  });

  it("animates every view once per frame", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1), marine(2)] });
    const a = registry(sm).views.get(1)!;
    const b = registry(sm).views.get(2)!;
    const rest = (v: EntityView): number => (v.group.getObjectByName("chassis") as THREE.Group).position.y;
    sm.update(0.5);
    sm.update(0.5);
    // Every live view is animated, and the two rigs bob out of phase with
    // each other rather than as one block.
    expect(Number.isFinite(rest(a))).toBe(true);
    expect(rest(a)).not.toBeCloseTo(rest(b), 6);
    sm.dispose();
  });
});

describe("SceneManager snapshot diffing", () => {
  it("creates views for new entities and keeps the existing ones by identity", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1), marine(2)] });
    const first = registry(sm).views.get(1);
    const second = registry(sm).views.get(2);

    sm.applySnapshot({ tick: nextTick(), entities: [marine(1, { x: 44 }), marine(3)] });

    // 1 survives as the same object, not a rebuilt one; 2 is gone; 3 is new.
    expect(registry(sm).views.get(1)).toBe(first);
    expect(registry(sm).views.has(2)).toBe(false);
    expect(registry(sm).views.has(3)).toBe(true);
    expect(registry(sm).views.get(3)).not.toBe(first);
    // A rebuilt view would have lost the entity's identity and state.
    expect(registry(sm).views.get(1)!.id).toBe(1);
    expect(second).toBeDefined();
    sm.dispose();
  });

  it("updates an existing view in place rather than replacing it", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1, { hp: 100, hp_max: 100 })] });
    const view = registry(sm).views.get(1)!;
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1, { hp: 30, hp_max: 100 })] });
    expect(registry(sm).views.get(1)).toBe(view);
    expect(view.hp).toBe(30);
    sm.dispose();
  });

  it("removes and disposes a view whose entity left the snapshot", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1), marine(2)] });
    const scene = (sm as unknown as { scene: THREE.Scene }).scene;
    const doomed = registry(sm).views.get(2)!;
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1)] });
    expect(registry(sm).views.has(2)).toBe(false);
    // A removed view must be unlinked from the scene, or it keeps rendering
    // forever at its last position.
    expect(doomed.group.parent).toBeNull();
    expect(scene.children).not.toContain(doomed.group);
    sm.dispose();
  });

  it("drops a removed entity from the selection as well", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1), marine(2)] });
    sm.setSelection([1, 2], "own");
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1)] });
    sm.setSelection([], "own");
    // If the dead id were still selected, the HUD would show a ghost bar.
    expect(registry(sm).views.get(1)!.selected).toBe(false);
    sm.dispose();
  });

  it("empties the registry on a snapshot with no entities", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1), barracks(2)] });
    expect(registry(sm).views.size).toBe(2);
    sm.applySnapshot({ tick: nextTick(), entities: [] });
    expect(registry(sm).views.size).toBe(0);
    expect(registry(sm).activeViews).toHaveLength(0);
    sm.dispose();
  });

  it("keeps the registry in step over a long alternating stream", () => {
    const sm = manager();
    const seen = new Map<number, EntityView>();
    for (let tick = 0; tick < 12; tick++) {
      const entities: ProtocolEntity[] = [];
      for (let i = 0; i < 5; i++) {
        // Entity i lives on ticks where i <= tick, so ids come and go.
        if (i > tick) continue;
        entities.push(marine(i, { x: tick * 2 + i }));
      }
      sm.applySnapshot({ tick: nextTick(), entities });
      const live = new Set(entities.map((e) => e.id));
      for (const [id, view] of registry(sm).views) {
        expect(live.has(id), `id ${id} still registered`).toBe(true);
        seen.set(id, view);
      }
      for (const e of entities) {
        if (seen.has(e.id)) expect(registry(sm).views.get(e.id)).toBe(seen.get(e.id));
      }
    }
    expect(registry(sm).views.size).toBe(5);
    sm.dispose();
  });

  it("keeps only visible views on the per-frame active list", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1), marine(2, { st: "dead" })] });
    const active = registry(sm).activeViews.map((v) => v.id);
    expect(active).toEqual([1]);
    sm.dispose();
  });

  it("ignores a snapshot after dispose", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1)] });
    sm.dispose();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1), marine(2)] });
    expect(registry(sm).views.size).toBe(0);
  });
});

describe("SceneManager selection", () => {
  it("marks every selected view and clears the rest", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1), marine(2), marine(3)] });
    sm.setSelection([1, 3], "enemy");
    const views = registry(sm).views;
    expect(views.get(1)!.selected).toBe(true);
    expect(views.get(2)!.selected).toBe(false);
    expect(views.get(3)!.selected).toBe(true);
    // A multi-selection has no single primary.
    expect(views.get(1)!.primary).toBe(false);
    sm.dispose();
  });

  it("marks a lone selection as the primary pick", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1), marine(2)] });
    sm.setSelection([2], "own");
    expect(registry(sm).views.get(2)!.primary).toBe(true);
    expect(registry(sm).views.get(1)!.primary).toBe(false);
    sm.dispose();
  });

  it("replaces the previous selection rather than accumulating it", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1), marine(2)] });
    sm.setSelection([1], "own");
    sm.setSelection([2], "own");
    expect(registry(sm).views.get(1)!.selected).toBe(false);
    expect(registry(sm).views.get(2)!.selected).toBe(true);
    // One id selected means that one is primary.
    expect(registry(sm).views.get(2)!.primary).toBe(true);
    sm.dispose();
  });

  it("colours the whole selection with the caller's relation", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1), marine(2)] });
    for (const relation of ["own", "ally", "enemy"] as const satisfies readonly Relation[]) {
      sm.setSelection([1, 2], relation);
      expect(registry(sm).views.get(1)!.relation).toBe(relation);
      expect(registry(sm).views.get(2)!.relation).toBe(relation);
    }
    sm.dispose();
  });

  it("maps the wire sel code onto a relation, and treats a missing one as own", () => {
    // `sel` is advisory colour state: 0 none, 1 self, 2 ally, 3 enemy. A
    // missing `sel` must read as own, not as unrelated — otherwise the sim,
    // which never sends `sel`, paints every selection ring the wrong colour.
    const sm = manager();
    const cases: readonly (readonly [ProtocolEntity["sel"], Relation])[] = [
      [0, "own"],
      [1, "own"],
      [2, "ally"],
      [3, "enemy"],
      [undefined, "own"],
    ];
    for (const [sel, expected] of cases) {
      sm.applySnapshot({ tick: nextTick(), entities: [marine(1, sel === undefined ? {} : { sel })] });
      expect(registry(sm).views.get(1)!.relation, `sel=${String(sel)}`).toBe(expected);
    }
    sm.dispose();
  });

  it("leaves an unselected entity on its own sel relation", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1, { sel: 3 }), marine(2, { sel: 0 })] });
    sm.setSelection([1], "own");
    // The selected view takes the caller's relation, not the wire's.
    expect(registry(sm).views.get(1)!.relation).toBe("own");
    expect(registry(sm).views.get(2)!.relation).toBe("own");
    sm.dispose();
  });

  it("ignores a selection after dispose", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1)] });
    sm.dispose();
    sm.setSelection([1], "enemy");
  });
});

describe("SceneManager commands and events", () => {
  it("emits a move command for the ids it is given", () => {
    const sm = manager();
    const commands: Command[] = [];
    sm.onCommand = (c) => commands.push(c);
    sm.issueMove([4, 5], 12, 34);
    expect(commands).toEqual([{ c: "move", ids: [4, 5], x: 12, z: 34 }]);
    sm.dispose();
  });

  it("sends nothing for an empty selection", () => {
    const sm = manager();
    const commands: Command[] = [];
    sm.onCommand = (c) => commands.push(c);
    sm.issueMove([], 1, 2);
    expect(commands).toHaveLength(0);
    sm.dispose();
  });

  it("does not mutate the caller's id array when issuing a move", () => {
    const sm = manager();
    const commands: Command[] = [];
    sm.onCommand = (c) => commands.push(c);
    const ids = [4, 5];
    sm.issueMove(ids, 1, 2);
    ids.push(6);
    expect(commands[0]).toMatchObject({ ids: [4, 5] });
    sm.dispose();
  });

  it("sends nothing after dispose", () => {
    const sm = manager();
    const commands: Command[] = [];
    sm.onCommand = (c) => commands.push(c);
    sm.dispose();
    sm.issueMove([1], 0, 0);
    expect(commands).toHaveLength(0);
  });

  it("recoils the shooter's rig on a shot event", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1, { x: 0, y: 0, z: 0 })] });
    const view = registry(sm).views.get(1)!;
    const chassis = view.group.getObjectByName("chassis") as THREE.Group;
    const before = chassis.position.z;
    sm.applySnapshot({
      tick: nextTick(),
      entities: [marine(1, { x: 0, y: 0, z: 0 })],
      events: [{ e: "shot", id: 1, x: 0, y: 1, z: 0, tx: 0, ty: 1, tz: 5 }],
    });
    sm.update(0.02);
    // Events run before the diff, so a shot in the same snapshot still finds
    // its view and the rig actually kicks.
    expect(chassis.position.z).not.toBe(before);
    sm.dispose();
  });

  it("keeps a view alive for a death event in the snapshot that removes it", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [barracks(1, { x: 5, y: 0, z: 5 })] });
    // The building is gone from the next snapshot but explodes on the way.
    sm.applySnapshot({
      tick: nextTick(),
      entities: [],
      events: [{ e: "death", id: 1, ty: "barracks", x: 5, y: 0, z: 5, killer: 2 }],
    });
    expect(registry(sm).views.has(1)).toBe(false);
    sm.dispose();
  });

  it("does not throw on any event kind without a GL context", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1, { x: 0, y: 0, z: 0 })] });
    sm.playEvents([
      { e: "shot", id: 1, x: 0, y: 1, z: 0, tx: 0, ty: 1, tz: 5 },
      { e: "hit", id: 1, tid: 1, dmg: 12, crit: true, shield: false },
      { e: "death", id: 1, ty: "marine", x: 0, y: 0, z: 0, killer: 2 },
      { e: "built", id: 1, ty: "barracks", x: 0, y: 0, z: 0 },
      { e: "proj", id: 1, pk: "bullet", x: 0, y: 1, z: 0, tx: 0, ty: 1, tz: 5 },
      { e: "ability", id: 1, ab: "stimpack", x: 0, y: 1, z: 0 },
      { e: "res", pl: 0, amount: 50, x: 0, z: 0 },
      { e: "alert", text: "Enemy incoming" },
    ]);
    sm.update(1 / 60);
    sm.dispose();
  });
});

describe("SceneManager framing and culling", () => {
  it("reports a point in front of the camera as visible and one behind it as not", () => {
    const sm = manager();
    sm.camera.focus(64, 64, 0);
    for (let i = 0; i < 5; i++) sm.update(1 / 60);
    // Dead centre of the frame, and off to one side but still in front.
    expect(sm.isVisible(64, 64)).toBe(true);
    expect(sm.isVisible(64, 10)).toBe(true);
    // Well outside the world, behind the camera.
    expect(sm.isVisible(256, 256)).toBe(false);
    expect(sm.isVisible(500, 500)).toBe(false);
    sm.dispose();
  });

  it("does nothing on update after dispose", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1)] });
    sm.dispose();
    sm.update(1 / 60);
    expect(registry(sm).views.size).toBe(0);
  });

  it("clamps a huge frame delta instead of flinging the world", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1, { x: 0, z: 0 })] });
    sm.update(30);
    const view = registry(sm).views.get(1)!;
    expect(Number.isFinite(view.group.position.x)).toBe(true);
    sm.dispose();
  });
});

describe("SceneManager opening framing", () => {
  it("opens on the player's own base rather than the middle of the map", () => {
    const sm = manager();
    const centre = GAME.maps[0].size / 2;
    sm.camera.focus(centre, centre, 0);
    sm.applySnapshot({
      tick: nextTick(),
      entities: [
        barracks(1, { x: 20, z: 20, sel: 0 }),
        barracks(2, { x: 40, z: 20, sel: 0 }),
        barracks(3, { x: 200, z: 200, sel: 3 }),
      ],
    });
    for (let i = 0; i < 60; i++) sm.update(1 / 60);
    // The first frame of a match is the player's base, not the map centre and
    // not an enemy building.
    expect(sm.camera.focusX).toBeCloseTo(30, 0);
    expect(sm.camera.focusZ).toBeCloseTo(20, 0);
    sm.dispose();
  });

  it("leaves the camera alone when the player owns no buildings yet", () => {
    const sm = manager();
    const centre = GAME.maps[0].size / 2;
    sm.camera.focus(centre, centre, 0);
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1, { x: 20, z: 20, sel: 0 })] });
    for (let i = 0; i < 10; i++) sm.update(1 / 60);
    expect(sm.camera.focusX).toBeCloseTo(centre, 0);
    expect(sm.camera.focusZ).toBeCloseTo(centre, 0);
    sm.dispose();
  });
});

describe("SceneManager ground picking", () => {
  it("turns a screen point into the ground under it", () => {
    const sm = manager();
    sm.camera.focus(64, 64, 0);
    for (let i = 0; i < 60; i++) sm.update(1 / 60);
    const out = { x: 0, z: 0 };
    const surface = heightField(map);
    // A pick has to land on the ground, not in the air: the returned point
    // must sit on the height field, inside the map.
    expect(sm.screenToGround(0.5, 0.5, out)).toBe(true);
    expect(out.x).toBeGreaterThanOrEqual(0);
    expect(out.x).toBeLessThanOrEqual(map.size);
    expect(out.z).toBeGreaterThanOrEqual(0);
    expect(out.z).toBeLessThanOrEqual(map.size);
    // Near the centre of the frame the ray points at the focused ground, so
    // the pick must be close to where the camera was pointed.
    expect(Math.hypot(out.x - 64, out.z - 64)).toBeLessThan(20);
    expect(surface.sample(out.x, out.z)).toBeGreaterThanOrEqual(0);
    sm.dispose();
  });
});

describe("SceneManager frame-loop LOD", () => {
  it("batches a far, idle, healthy, unselected unit and pulls it back when hurt", () => {
    const sm = manager();
    // Put the unit far from the camera so the LOD switch fires.
    const far = 300;
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1, { x: far, z: far, hp: 100, hp_max: 100 })] });
    for (let i = 0; i < 30; i++) sm.update(1 / 60);
    const view = registry(sm).views.get(1)! as unknown as { isBatched: boolean };
    expect(view.isBatched).toBe(true);

    // A wounded unit must animate again, not sit in the instanced bucket.
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1, { x: far, z: far, hp: 50, hp_max: 100 })] });
    for (let i = 0; i < 5; i++) sm.update(1 / 60);
    expect(view.isBatched).toBe(false);
    sm.dispose();
  });

  it("keeps a selected unit on its rig however far away it is", () => {
    const sm = manager();
    const far = 300;
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1, { x: far, z: far, hp: 100, hp_max: 100 })] });
    sm.setSelection([1], "own");
    for (let i = 0; i < 30; i++) sm.update(1 / 60);
    const view = registry(sm).views.get(1)! as unknown as { isBatched: boolean };
    expect(view.isBatched).toBe(false);
    sm.dispose();
  });
});

describe("SceneManager disposal", () => {
  it("empties the registry and detaches every view", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1), barracks(2)] });
    const views = [...registry(sm).views.values()];
    sm.dispose();
    expect(registry(sm).views.size).toBe(0);
    for (const view of views) {
      expect(view.group.parent).toBeNull();
      expect(view.group.children).toHaveLength(0);
    }
  });

  it("is idempotent", () => {
    const sm = manager();
    sm.applySnapshot({ tick: nextTick(), entities: [marine(1)] });
    sm.dispose();
    sm.dispose();
    sm.render();
  });
});
