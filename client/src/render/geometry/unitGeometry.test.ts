/**
 * The unit builders, checked against the roster they have to satisfy.
 *
 * The server resolves movement and collision against `size.radius` and
 * `size.height` in shared/game-data.json; these tests re-derive what the
 * builders promise and measure what they actually produce, for every unit in
 * the roster rather than a sample — a single unit that renders as a hole or
 * sinks through the floor is a bug a player sees, and a sample would miss it.
 *
 * Every key is measured against the roster rather than a sample, and each
 * describe block names the contract it enforces: what the geometry is fitted
 * to, where its base sits, and which way it faces. Where a block used to
 * pin a defect, it now states the contract and records the damage in a
 * comment table, so the regression is legible without running anything.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { GAME, entityDef, isAirUnit } from "@shared/gameData";
import type { UnitDef } from "@shared/protocol";
import {
  airHoverLift,
  assertGeometryCoverage,
  buildAnyGeometry,
  checkGeometry,
  selfCheckGeometryCoverage,
  unitGeometry,
} from "./unitGeometry";
import { setPartColor, taperedBox } from "./shapes";
import { clearGeometryCache, releaseGeometryKey } from "./geometryCache";

const UNIT_KEYS = Object.keys(GAME.units).filter((k) => entityDef(k).kind === "unit");

/** Builds each unit once and measures it; the shared fixture for the suite. */
interface Measured {
  key: string;
  def: UnitDef;
  geometry: THREE.BufferGeometry;
  minY: number;
  maxY: number;
  reach: number;
  triangles: number;
}

function measure(key: string): Measured {
  const def = entityDef(key) as UnitDef;
  const geometry = buildAnyGeometry(key);
  geometry.computeBoundingBox();
  const b = geometry.boundingBox;
  if (!b) throw new Error(`${key}: no bounding box`);
  return {
    key,
    def,
    geometry,
    minY: b.min.y,
    maxY: b.max.y,
    reach: Math.max(Math.abs(b.min.x), b.max.x, Math.abs(b.min.z), b.max.z),
    triangles: geometry.getAttribute("position").count / 3,
  };
}

const ALL: Measured[] = UNIT_KEYS.map(measure);
const byKey = new Map(ALL.map((m) => [m.key, m]));

afterEach(() => {
  clearGeometryCache();
});

describe("roster coverage", () => {
  it("has 30 roster units and one builder result for each", () => {
    expect(UNIT_KEYS).toHaveLength(30);
    expect(ALL).toHaveLength(30);
  });

  it.each(UNIT_KEYS)("%s builds a renderable, vertex-coloured buffer", (key) => {
    const m = byKey.get(key);
    if (!m) throw new Error(`unmeasured key ${key}`);
    const g = m.geometry;
    const pos = g.getAttribute("position");
    expect(pos.count).toBeGreaterThan(0);
    expect(m.triangles).toBeGreaterThan(0);
    expect(g.index).toBeNull();
    expect(g.getAttribute("uv")?.count).toBe(pos.count);
    expect(g.getAttribute("normal")?.count).toBe(pos.count);
    // The material reads the per-vertex colour; a mismatch means an unlit
    // or wrongly tinted model.
    expect(g.getAttribute("color")?.count).toBe(pos.count);
    expect(g.getAttribute("color")?.itemSize).toBe(4);
    expect(g.boundingBox).not.toBeNull();
    g.computeBoundingSphere();
    expect(g.boundingSphere?.radius).toBeGreaterThan(0);
  });

  it.each(UNIT_KEYS)("%s contains no NaN or infinite coordinates", (key) => {
    const p = byKey.get(key)?.geometry.getAttribute("position");
    if (!p) throw new Error(`unmeasured key ${key}`);
    for (let i = 0; i < p.array.length; i++) {
      expect(Number.isFinite(p.array[i] as number)).toBe(true);
    }
  });

  it.each(UNIT_KEYS)("%s keeps its emissive mask inside [0, 1]", (key) => {
    const c = byKey.get(key)?.geometry.getAttribute("color");
    if (!c) throw new Error(`unmeasured key ${key}`);
    for (let i = 0; i < c.count; i++) {
      expect(c.getW(i)).toBeGreaterThanOrEqual(0);
      expect(c.getW(i)).toBeLessThanOrEqual(1);
    }
  });

  it("gives at least one unit an emissive core, or the energy tone is dead", () => {
    // A `glow` in the alpha slot is what the material reads as emissive; if
    // every alpha were 0 the energy palette would render as dead grey.
    const withGlow = ALL.filter((m) => {
      const c = m.geometry.getAttribute("color");
      for (let i = 0; i < c.count; i++) if (c.getW(i) > 0) return true;
      return false;
    });
    expect(withGlow.length).toBeGreaterThan(10);
  });

  it("is byte-identical when rebuilt — the cache and the server must agree", () => {
    for (const key of ["marine", "zealot", "siege_tank", "zergling", "battlecruiser"]) {
      const a = buildAnyGeometry(key);
      const b = buildAnyGeometry(key);
      expect(Array.from(a.getAttribute("position").array as ArrayLike<number>)).toEqual(
        Array.from(b.getAttribute("position").array as ArrayLike<number>),
      );
      expect(Array.from(a.getAttribute("color").array as ArrayLike<number>)).toEqual(
        Array.from(b.getAttribute("color").array as ArrayLike<number>),
      );
    }
  });
});

describe("fit to the collision footprint", () => {
  // `assemble` seats the model on the ground, then calls
  // fitFootprint(body, radius, height - lift) with the defaults:
  // maxOvershoot 1.12, fillRadius 0.8, fillHeight 0.86. The reach is
  // measured from the collision centre and the scale is taken about it, so
  // an off-centre hull is caught rather than kept.
  //
  // Before the fix, measured against the roster: high_templar reached
  // 0.577 m against its 0.5 m circle (15.4% over) and phoenix topped out at
  // 2.899 m against a 2.5 m roster height (16% over), because the fit
  // measured the reach from the model's own middle and grew a hull about its
  // own bottom. Both are now inside budget.
  it("keeps every ground unit inside 1.12x its collision radius", () => {
    for (const m of ALL) {
      if (isAirUnit(m.key)) continue;
      expect(m.reach / m.def.size.radius).toBeLessThanOrEqual(1.12);
    }
  });

  it("tops out within the roster height for every unit", () => {
    for (const m of ALL) {
      expect(m.maxY).toBeLessThanOrEqual(m.def.size.height + 1e-3);
    }
  });

  it("never collapses a unit to a speck — the fill radius floor holds", () => {
    for (const m of ALL) {
      expect(m.reach / m.def.size.radius).toBeGreaterThan(0.5);
      expect(m.maxY / m.def.size.height).toBeGreaterThan(0.7);
    }
  });

  it("pulls the high templar back inside its 0.5 m circle", () => {
    // The psionic blades are built off centre, so measuring the reach from
    // the model's own middle let them keep 15% of overhang.
    const m = byKey.get("high_templar");
    if (!m) throw new Error("high_templar not measured");
    expect(m.reach).toBeCloseTo(m.def.size.radius, 3);
  });

  it("keeps the phoenix inside its 2.5 m roster height", () => {
    const m = byKey.get("phoenix");
    if (!m) throw new Error("phoenix not measured");
    expect(m.maxY).toBeLessThanOrEqual(m.def.size.height);
  });
});

describe("base at y = 0 and the hover lift", () => {
  // A ground unit stands on the ground and an air hull floats exactly one
  // airHoverLift above it. Before the fix, `treadedBlock` embedded a
  // centre-origin beveledBox and the hover lift was only a height budget, so
  // the two air hulls and the two ground fliers were all wrong:
  //
  //   below the ground plane    hovering, though movement is "ground"
  //   command_center -0.524     raven    +0.262
  //   factory        -0.330     infestor +0.052
  //   supply_depot   -0.306
  //
  //   below its own hover lift   far above its own hover lift
  //   carrier       +0.167       guardian +1.236
  //   battlecruiser +0.178       phoenix  +1.050
  it("stands every ground unit on the ground plane", () => {
    for (const m of ALL) {
      if (isAirUnit(m.key)) continue;
      expect(m.minY).toBeCloseTo(0, 4);
    }
  });

  it("floats every air hull clear of the ground by exactly its hover lift", () => {
    for (const m of ALL) {
      if (!isAirUnit(m.key)) continue;
      expect(m.minY).toBeCloseTo(airHoverLift(m.def.size.height), 4);
      expect(m.minY).toBeGreaterThan(0);
    }
  });

  it("airHoverLift is clamped and monotone in the roster height", () => {
    expect(airHoverLift(0)).toBe(0.12);
    expect(airHoverLift(1)).toBeCloseTo(0.14, 5);
    expect(airHoverLift(50)).toBe(0.45);
    let previous = 0;
    for (let h = 0; h <= 12; h += 0.5) {
      const lift = airHoverLift(h);
      expect(lift).toBeGreaterThanOrEqual(previous);
      previous = lift;
    }
  });
});

describe("forward is +Z", () => {
  /** Mean vertex z: where the model's mass actually sits along its facing. */
  const meanZ = (key: string): number => {
    const p = byKey.get(key)?.geometry.getAttribute("position");
    if (!p) throw new Error(`unmeasured key ${key}`);
    let sum = 0;
    for (let i = 0; i < p.count; i++) sum += p.getZ(i);
    return sum / p.count;
  };

  it.each([
    "probe",
    "zealot",
    "stalker",
    "high_templar",
    "marine",
    "firebat",
    "siege_tank",
    "thor",
    "reaper",
    "ghost",
    "medic",
    "hydralisk",
    "ultralisk",
    "lurker",
  ])("weighs %s forward of the origin, where its weapon is", (key) => {
    // A small positive margin catches a model built back-to-front without
    // pinning how far forward a given silhouette happens to lean: the zealot
    // holds its twin blades at the hip and sits just inside 0.04.
    expect(meanZ(key)).toBeGreaterThan(0.02);
  });

  it.each(["zergling", "adept", "sentry", "archon", "roach", "infestor", "guardian", "phoenix"])(
    "leaves %s facing-neutral, with no accidental forward bias",
    (key) => {
      expect(Math.abs(meanZ(key))).toBeLessThan(0.06);
    },
  );

  it("carries the Siege Tank's barrel on the +Z side of its hull", () => {
    const m = byKey.get("siege_tank");
    if (!m) throw new Error("siege_tank not measured");
    m.geometry.computeBoundingBox();
    const b = m.geometry.boundingBox;
    if (!b) throw new Error("no box");
    // The turret barrel overhangs the hull front; the back is the engine deck.
    expect(b.max.z).toBeGreaterThan(Math.abs(b.min.z));
  });
});

describe("entry points", () => {
  it("unitGeometry serves a unit key from the cache", () => {
    const a = unitGeometry("marine");
    const b = unitGeometry("marine");
    expect(b).toBe(a);
  });

  it("unitGeometry also serves building keys, so no roster key throws", () => {
    expect(unitGeometry("bunker").getAttribute("position").count).toBeGreaterThan(0);
  });

  it("buildAnyGeometry dispatches a building key to the building builders", () => {
    const g = buildAnyGeometry("turret");
    expect(g.getAttribute("position").count).toBe(buildAnyGeometry("turret").getAttribute("position").count);
  });

  it("refuses an unknown key instead of rendering a placeholder", () => {
    expect(() => unitGeometry("not_a_unit")).toThrow(/unknown entity type/);
    expect(() => buildAnyGeometry("not_a_unit")).toThrow(/unknown entity type/);
  });

  it("releases a cached unit geometry on request", () => {
    unitGeometry("zealot");
    expect(releaseGeometryKey("zealot")).toBe(true);
  });
});

describe("selfCheckGeometryCoverage", () => {
  it("reports one check per roster key, with kind, radius, height and triangle count", () => {
    const checks = selfCheckGeometryCoverage();
    expect(checks).toHaveLength(57);
    for (const check of checks) {
      const def = entityDef(check.key);
      expect(check.kind).toBe(def.kind);
      expect(check.radius).toBe(def.size.radius);
      expect(check.height).toBe(def.size.height);
      expect(check.triangles).toBeGreaterThan(0);
      expect(typeof check.reason).toBe("string");
    }
  });

  it("measures what it asserts, for every key", () => {
    for (const check of selfCheckGeometryCoverage()) {
      expect(check.reach).toBeGreaterThan(0);
      expect(check.top).toBeGreaterThan(check.base);
      const def = entityDef(check.key);
      const lift = def.kind === "unit" && isAirUnit(check.key) ? airHoverLift(def.size.height) : 0;
      expect(check.expectedBase).toBeCloseTo(lift, 9);
    }
  });

  it("finds no failing key: every roster model now meets the contract", () => {
    // 25 of 57 keys failed this check before the fix — 23 models with an
    // origin below the ground plane (the command centre 52 cm under, the
    // full table in buildingGeometry.test.ts), high_templar 15.4% over its
    // collision circle and phoenix 16% over its roster height.
    const failing = selfCheckGeometryCoverage()
      .filter((c) => !c.ok)
      .map((c) => `${c.key}: ${c.reason}`);
    expect(failing).toEqual([]);
  });

  it("assertGeometryCoverage does not throw on any roster key", () => {
    // This is the boot-time assert. It aborted the game while the defects
    // above were live, which is why it was not wired into boot; it is now.
    expect(() => assertGeometryCoverage()).not.toThrow();
  });

  // The contract the walk above applies, exercised against models built to
  // break it: a check that can only ever pass proves nothing.
  describe("checkGeometry", () => {
    const marine = entityDef("marine") as UnitDef;
    const carrier = entityDef("carrier") as UnitDef;
    /** A well-formed marine hull, to be broken one way at a time. */
    const model = (): THREE.BufferGeometry => {
      const g = taperedBox(0.8, 1.8, 0.8, 1);
      setPartColor(g, { r: 1, g: 1, b: 1 });
      return g;
    };

    it("passes a model that meets it and reports what it measured", () => {
      const { reason, measurement } = checkGeometry(marine, model());
      expect(reason).toBe("");
      expect(measurement.base).toBeCloseTo(0, 6);
      expect(measurement.top).toBeCloseTo(1.8, 6);
      expect(measurement.reach).toBeCloseTo(0.4, 6);
      expect(measurement.triangles).toBe(12);
    });

    it("rejects a model that starts below the ground plane", () => {
      expect(checkGeometry(marine, model().translate(0, -0.1, 0)).reason).toMatch(
        /^base is -0.100, not the ground plane$/,
      );
    });

    it("rejects a ground model that hovers", () => {
      expect(checkGeometry(marine, model().translate(0, 0.1, 0)).reason).toMatch(
        /^base is 0.100, not the ground plane$/,
      );
    });

    it("rejects an air hull that does not clear the ground by its lift", () => {
      expect(checkGeometry(carrier, model().translate(0, 0.1, 0)).reason).toMatch(
        /^hover clearance is 0.100, not the 0.450 lift$/,
      );
    });

    it("rejects a model wider than its collision circle", () => {
      expect(checkGeometry(marine, model().scale(2, 1, 2)).reason).toMatch(
        /exceeds collision radius 0.5/,
      );
    });

    it("rejects a model taller than its roster height", () => {
      expect(checkGeometry(marine, model().scale(1, 1.2, 1)).reason).toMatch(
        /taller than roster height 1.8/,
      );
    });

    it("rejects an unrenderable buffer", () => {
      expect(checkGeometry(marine, new THREE.BufferGeometry()).reason).toBe("empty geometry");
      const noColour = model();
      noColour.deleteAttribute("color");
      expect(checkGeometry(marine, noColour).reason).toMatch(/vertex colour attribute/);
      const noUv = model();
      noUv.deleteAttribute("uv");
      expect(checkGeometry(marine, noUv).reason).toBe("uv attribute missing");
    });
  });
});
