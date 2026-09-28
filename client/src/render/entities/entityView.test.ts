/**
 * The shared half of every entity view: identity, transform, vitals,
 * selection and lifetime. Views are driven at 10 Hz for the length of a
 * match, so the two things that matter here are that applying the same state
 * twice lands in the same place, and that `dispose()` actually releases what
 * the view created.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { entityDef } from "@shared/gameData";
import { AbstractEntityView } from "./entityView";
import type { EntityViewOptions, Relation, SelectionState } from "./entityView";

/** Counts the dispose events three fires, so leaks are observable. */
class DisposeWatch {
  private readonly counts = new Map<object, number>();

  watch(resource: { addEventListener(type: "dispose", fn: () => void): void }): void {
    resource.addEventListener("dispose", () => {
      this.counts.set(resource, (this.counts.get(resource) ?? 0) + 1);
    });
  }

  fired(resource: object): number {
    return this.counts.get(resource) ?? 0;
  }
}

/**
 * A minimal concrete view that owns one geometry and one material, so the
 * base class's teardown contract is testable without a real rig. Passing
 * `shared` makes two views model the same type off one buffer, exactly like
 * the real geometry cache.
 */
class ProbeView extends AbstractEntityView {
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
  readonly mesh: THREE.Mesh;
  releaseCount = 0;

  constructor(options: EntityViewOptions, shared?: { geometry: THREE.BufferGeometry }) {
    super(options);
    this.geometry = shared?.geometry ?? new THREE.BoxGeometry(1, 1, 1);
    this.material = new THREE.MeshStandardMaterial();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.group.add(this.mesh);
  }

  protected releaseResources(): void {
    this.releaseCount++;
    this.group.clear();
    this.geometry.dispose();
    this.material.dispose();
  }
}

const marine = (id = 1, typeKey = "marine"): ProbeView => new ProbeView({ id, typeKey, playerId: 0 });

const selection = (over: Partial<SelectionState> = {}): SelectionState => ({
  selected: true,
  primary: false,
  relation: "own",
  ...over,
});

describe("AbstractEntityView construction", () => {
  it("takes its identity and dimensions from the roster, not from the caller", () => {
    const def = entityDef("siege_tank");
    const view = marine(7, "siege_tank");
    expect(view.id).toBe(7);
    expect(view.typeKey).toBe("siege_tank");
    expect(view.kind).toBe("unit");
    expect(view.radius).toBe(def.size.radius);
    expect(view.height).toBe(def.size.height);
    expect(view.isAir).toBe(false);
    expect(view.group.name).toBe("unit:siege_tank#7");
  });

  it("derives the owning race from the roster rather than the player", () => {
    // Player 0 is terran in every match, so only the roster can explain a
    // protoss or zerg view here.
    expect(marine(1, "zealot").race).toBe("protoss");
    expect(marine(2, "drone").race).toBe("zerg");
    expect(marine(3, "marine").race).toBe("terran");
  });

  it("flags air units and never flags buildings as air", () => {
    expect(marine(1, "carrier").isAir).toBe(true);
    expect(new ProbeView({ id: 2, typeKey: "factory", playerId: 0 }).isAir).toBe(false);
  });

  it("anchors the HUD above the model so bars never intersect it", () => {
    const view = marine(1, "siege_tank");
    expect(view.hudAnchor.position.y).toBeCloseTo(view.height + Math.max(0.6, view.height * 0.22), 9);
    expect(view.hudAnchor.visible).toBe(false);
    expect(view.hudAnchor.parent).toBe(view.group);
  });

  it("starts with no selection and no parent", () => {
    const view = marine();
    expect(view.selected).toBe(false);
    expect(view.primary).toBe(false);
    expect(view.relation).toBe("enemy");
    expect(view.group.parent).toBeNull();
  });
});

describe("AbstractEntityView transform", () => {
  it("is idempotent: the same snapshot applied twice lands in the same place", () => {
    const view = marine();
    const apply = (): void => view.setTransform(12.5, 1.25, -7.75, 1.1);
    apply();
    const first = { position: view.group.position.toArray(), yaw: view.group.rotation.y };
    apply();
    expect(view.group.position.toArray()).toEqual(first.position);
    expect(view.group.rotation.y).toBe(first.yaw);
  });

  it("writes position and yaw, and nothing else", () => {
    const view = marine();
    view.setTransform(3, 4, 5, 0.75);
    expect(view.group.position.toArray()).toEqual([3, 4, 5]);
    expect(view.group.rotation.y).toBe(0.75);
    expect(view.group.rotation.x).toBe(0);
    expect(view.group.rotation.z).toBe(0);
  });

  it("ignores state pushed after disposal", () => {
    const view = marine();
    view.dispose();
    view.setTransform(9, 9, 9, 1);
    expect(view.group.position.toArray()).toEqual([0, 0, 0]);
    expect(view.group.rotation.y).toBe(0);
  });
});

describe("AbstractEntityView vitals", () => {
  it("records hp and shields verbatim, at full health and damaged", () => {
    const view = marine();
    view.setHp(45, 100, 12, 50);
    expect([view.hp, view.hpMax, view.shield, view.shieldMax]).toEqual([45, 100, 12, 50]);
    view.setHp(100, 100, 50, 50);
    expect([view.hp, view.hpMax, view.shield, view.shieldMax]).toEqual([100, 100, 50, 50]);
  });

  it("is stable when the same vitals arrive twice", () => {
    const view = marine();
    view.setHp(45, 100, 12, 50);
    view.setHp(45, 100, 12, 50);
    expect([view.hp, view.hpMax, view.shield, view.shieldMax]).toEqual([45, 100, 12, 50]);
  });

  it("does not damage the model at full health", () => {
    const view = marine();
    view.setHp(100, 100, 0, 0);
    const before = view.group.children.length;
    view.update(0.016);
    expect(view.group.children).toHaveLength(before);
  });
});

describe("AbstractEntityView selection", () => {
  it("never reports primary for an entity that is not selected", () => {
    const view = marine();
    view.setSelectionState(selection({ selected: false, primary: true }));
    expect(view.selected).toBe(false);
    expect(view.primary).toBe(false);
  });

  it("carries the relation through for every relation code", () => {
    const view = marine();
    for (const relation of ["own", "ally", "enemy"] as const satisfies readonly Relation[]) {
      view.setSelectionState(selection({ relation }));
      expect(view.relation).toBe(relation);
    }
  });

  it("shows the HUD anchor only while selected, and restores exactly", () => {
    const view = marine();
    view.setSelectionState(selection({ selected: true }));
    expect(view.hudAnchor.visible).toBe(true);
    view.setSelectionState(selection({ selected: false }));
    expect(view.hudAnchor.visible).toBe(false);
    view.setSelectionState(selection({ selected: true }));
    expect(view.hudAnchor.visible).toBe(true);
  });
});

describe("AbstractEntityView visibility", () => {
  it("restores the group exactly after a hide/show round trip", () => {
    const view = marine();
    view.setTransform(1, 2, 3, 0.5);
    view.setSelectionState(selection({ selected: true }));
    view.setVisible(false);
    expect(view.visible).toBe(false);
    expect(view.group.visible).toBe(false);
    view.setVisible(true);
    expect(view.visible).toBe(true);
    expect(view.group.visible).toBe(true);
    expect(view.group.position.toArray()).toEqual([1, 2, 3]);
    expect(view.group.rotation.y).toBe(0.5);
  });

  it("keeps the HUD anchor hidden while the view is hidden", () => {
    const view = marine();
    view.setSelectionState(selection({ selected: true }));
    view.setVisible(false);
    expect(view.hudAnchor.visible).toBe(false);
  });
});

describe("AbstractEntityView disposal", () => {
  it("emits dispose for every geometry and material the view created", () => {
    const view = marine();
    const watch = new DisposeWatch();
    watch.watch(view.geometry);
    watch.watch(view.material);
    expect(watch.fired(view.geometry)).toBe(0);
    view.dispose();
    expect(watch.fired(view.geometry)).toBe(1);
    expect(watch.fired(view.material)).toBe(1);
  });

  it("unlinks the view from the scene and empties the group", () => {
    const scene = new THREE.Scene();
    const view = marine();
    scene.add(view.group);
    view.dispose();
    expect(view.group.parent).toBeNull();
    expect(view.group.children).toHaveLength(0);
    expect(scene.children).not.toContain(view.group);
  });

  it("releases resources exactly once even if dispose is called twice", () => {
    const view = marine();
    const watch = new DisposeWatch();
    watch.watch(view.geometry);
    watch.watch(view.material);
    view.dispose();
    view.dispose();
    expect(view.releaseCount).toBe(1);
    expect(watch.fired(view.geometry)).toBe(1);
    expect(watch.fired(view.material)).toBe(1);
  });

  it("leaves a sibling view's shared buffer alone when only one view dies", () => {
    // A hundred Marines share one buffer; one Marine dying must not pull the
    // geometry out from under the other ninety-nine.
    const shared = new THREE.BoxGeometry(1, 1, 1);
    const a = new ProbeView({ id: 1, typeKey: "marine", playerId: 0 }, { geometry: shared });
    const b = new ProbeView({ id: 2, typeKey: "marine", playerId: 0 }, { geometry: shared });
    const watch = new DisposeWatch();
    watch.watch(shared);
    a.dispose();
    expect(b.mesh.geometry).toBe(shared);
    expect(b.releaseCount).toBe(0);
  });
});
