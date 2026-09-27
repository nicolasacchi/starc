/**
 * Selection rules the player feels immediately: a drag that picks up the wrong
 * units, a double-click that grabs the whole enemy army, or a box that quietly
 * selects 140 entities and stalls the renderer. `selection.ts` is where the
 * StarCraft rules live, so these assert the rules, not the bookkeeping.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DOUBLE_CLICK_MS,
  DRAG_SELECT_RADIUS,
  groundPoint,
  MAX_SELECTION,
  normaliseRect,
  SelectionManager,
} from "./selection";
import type { RectSelectOptions } from "./selection";
import type { ProtocolEntity } from "@shared/protocol";

const ME = 1;

function entity(id: number, over: Partial<ProtocolEntity> = {}): ProtocolEntity {
  return {
    id,
    ty: "marine",
    pl: ME,
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

const FRIENDLY: RectSelectOptions = {
  myPlayerId: ME,
  additive: false,
  requiresAttackable: false,
  maxRangeFromCentre: 0,
};

describe("groundPoint and normaliseRect", () => {
  it("maps a protocol entity's ground axes to the renderer's x/z pair", () => {
    // The protocol's y is the renderer's z; getting this backwards mirrors the
    // selection about the map diagonal.
    expect(groundPoint(entity(1, { x: 3, z: 7 }))).toEqual({ x: 3, z: 7 });
  });

  it("normalises a rectangle dragged in any direction", () => {
    expect(normaliseRect({ x0: 20, z0: 30, x1: 10, z1: 5 })).toEqual({ x0: 10, z0: 5, x1: 20, z1: 30 });
  });

  it("clamps a drag that leaves the map so it cannot select the void", () => {
    expect(normaliseRect({ x0: -50, z0: -50, x1: 400, z1: 400 }, 256)).toEqual({
      x0: 0,
      z0: 0,
      x1: 256,
      z1: 256,
    });
  });
});

describe("SelectionManager", () => {
  let selection: SelectionManager;

  beforeEach(() => {
    selection = new SelectionManager();
  });

  it("keeps only the entities whose centre is inside the dragged box", () => {
    const entities = [
      entity(1, { x: 5, z: 5 }),
      entity(2, { x: 9, z: 9 }),
      entity(3, { x: 12, z: 5 }), // outside on x
      entity(4, { x: 5, z: 11 }), // outside on the ground axis
    ];

    const result = selection.selectInRect({ x0: 0, z0: 0, x1: 10, z1: 10 }, entities, FRIENDLY);

    expect(result.ids).toEqual([1, 2]);
    expect(result.total).toBe(2);
    expect(result.overflow).toBe(0);
  });

  it("never selects another player's units on a plain drag", () => {
    const entities = [entity(1), entity(2, { pl: 2 })];

    selection.selectInRect({ x0: 0, z0: 0, x1: 10, z1: 10 }, entities, FRIENDLY);

    expect(selection.selectedIds()).toEqual([1]);
  });

  it("skips dead entities", () => {
    const entities = [entity(1), entity(2, { st: "dead" })];

    selection.selectInRect({ x0: 0, z0: 0, x1: 10, z1: 10 }, entities, FRIENDLY);

    // A corpse in the box is a unit the player cannot command.
    expect(selection.selectedIds()).toEqual([1]);
  });

  it("excludes units beyond the drag distance cap from the anchor", () => {
    const anchor = entity(1, { x: 50, z: 50 });
    const near = entity(2, { x: 60, z: 50 });
    const far = entity(3, { x: 50 + DRAG_SELECT_RADIUS + 1, y: 50 });
    const entities = [anchor, near, far];

    const result = selection.selectInRect(
      { x0: 0, z0: 0, x1: 200, z1: 200 },
      entities,
      { ...FRIENDLY, maxRangeFromCentre: DRAG_SELECT_RADIUS, centre: groundPoint(anchor) },
    );

    // A full-map drag is how a player says "everything near that unit".
    expect(result.ids).toEqual([1, 2]);
  });

  it("measures the distance cap from the rectangle centre when no anchor is given", () => {
    // The rect centre is (50, 50); the second unit sits just past the cap.
    const entities = [entity(1, { x: 50, z: 50 }), entity(2, { x: 50 + DRAG_SELECT_RADIUS + 1, y: 50 })];

    const result = selection.selectInRect(
      { x0: 0, z0: 0, x1: 100, z1: 100 },
      entities,
      { ...FRIENDLY, maxRangeFromCentre: DRAG_SELECT_RADIUS },
    );

    expect(result.ids).toEqual([1]);
  });

  it("enforces the 100-entity ceiling and reports the overflow", () => {
    const entities = Array.from({ length: 150 }, (_, i) => entity(i + 1, { x: i % 10, y: 1 }));

    const result = selection.selectInRect({ x0: 0, z0: 0, x1: 20, z1: 20 }, entities, FRIENDLY);

    expect(selection.size).toBe(MAX_SELECTION);
    expect(result.total).toBe(150);
    expect(result.overflow).toBe(50);
    expect(selection.lastOverflow).toBe(50);
  });

  it("keeps an existing selection within the ceiling on an additive drag", () => {
    selection.set([1, 2]);
    const entities = Array.from({ length: 120 }, (_, i) => entity(i + 1, { x: i % 10, y: 1 }));

    const result = selection.selectInRect(
      { x0: 0, z0: 0, x1: 20, z1: 20 },
      entities,
      { ...FRIENDLY, additive: true },
    );

    // Adding past the ceiling must drop the newcomers, not the established pick.
    expect(selection.size).toBe(MAX_SELECTION);
    expect(selection.has(1)).toBe(true);
    expect(selection.has(2)).toBe(true);
    expect(result.overflow).toBe(20);
  });

  it("picks only enemy combat units when the drag asks for attackable", () => {
    const entities = [
      entity(1), // ours
      entity(2, { pl: 2 }), // enemy marine
      entity(3, { pl: 2, ty: "siege_tank" }),
      entity(4, { pl: 2, ty: "scv" }), // a worker, not a combat unit
      entity(5, { pl: 2, ty: "command_center" }), // a building
    ];

    const result = selection.selectInRect(
      { x0: 0, z0: 0, x1: 20, z1: 20 },
      entities,
      { ...FRIENDLY, requiresAttackable: true },
    );

    expect(result.ids).toEqual([2, 3]);
  });

  it("selects every visible unit of the anchor's type on a double-click", () => {
    const entities = [
      entity(1, { x: 1, z: 1 }),
      entity(2, { x: 40, z: 40 }),
      entity(3, { x: 200, z: 200 }), // off screen
      entity(4, { ty: "zealot", x: 5, z: 5 }), // a different type
      entity(5, { ty: "marine", pl: 2, x: 6, z: 6 }), // the enemy's
    ];
    const visible = (x: number) => x < 100;

    const result = selection.selectSameType(1, entities, { myPlayerId: ME, additive: false, isVisible: visible });

    // Selecting off-screen or enemy units here is how a double-click ends a game.
    expect(result.ids).toEqual([1, 2]);
    expect(result.total).toBe(2);
  });

  it("leaves the selection alone when the double-click anchor is gone", () => {
    selection.set([7]);
    const result = selection.selectSameType(99, [entity(1)], { myPlayerId: ME, additive: false });
    expect(result.ids).toEqual([7]);
  });

  it("recognises a second click on the same entity inside the double-click window", () => {
    expect(selection.noteClick(5, 1_000)).toBe(false);
    expect(selection.noteClick(5, 1_000 + DOUBLE_CLICK_MS / 2)).toBe(true);
  });

  it("does not treat a slow second click, or a click elsewhere, as a double-click", () => {
    expect(selection.noteClick(5, 1_000)).toBe(false);
    expect(selection.noteClick(5, 1_000 + DOUBLE_CLICK_MS + 1)).toBe(false);
    expect(selection.noteClick(6, 1_100)).toBe(false);
    expect(selection.noteClick(null, 1_100)).toBe(false);
  });

  it("toggles and removes individual units", () => {
    selection.toggle(1);
    selection.toggle(2);
    expect(selection.selectedIds()).toEqual([1, 2]);
    selection.toggle(1);
    expect(selection.selectedIds()).toEqual([2]);
    selection.remove([2]);
    expect(selection.size).toBe(0);
  });

  it("bumps version on every change so the renderer can diff cheaply", () => {
    const before = selection.version;
    selection.set([1, 2]);
    expect(selection.version).toBeGreaterThan(before);

    const afterSet = selection.version;
    selection.clear();
    expect(selection.version).toBeGreaterThan(afterSet);

    const afterClear = selection.version;
    selection.clear();
    // An empty clear that bumps the version every frame would redraw forever.
    expect(selection.version).toBe(afterClear);
  });

  it("returns ids in a stable ascending order", () => {
    selection.set([9, 3, 7]);
    expect(selection.selectedIds()).toEqual([3, 7, 9]);
  });

  it("reports what a direct add dropped once the ceiling is reached", () => {
    const dropped = selection.add(Array.from({ length: 105 }, (_, i) => i + 1));
    expect(dropped).toHaveLength(5);
    expect(selection.size).toBe(MAX_SELECTION);
  });

  it("honours a lowered ceiling without letting the selection grow past it", () => {
    const small = new SelectionManager({ max: 3 });
    small.set([1, 2, 3, 4, 5]);
    expect(small.size).toBe(3);
  });
});
