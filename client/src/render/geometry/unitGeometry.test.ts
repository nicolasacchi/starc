/**
 * The unit builders, checked against the roster they have to satisfy.
 *
 * The server resolves movement and collision against `size.radius` and
 * `size.height` in shared/game-data.json; these tests re-derive what the
 * builders promise and measure what they actually produce, for every unit in
 * the roster rather than a sample — a single unit that renders as a hole or
 * sinks through the floor is a bug a player sees, and a sample would miss it.
 *
 * Defects found while writing these are pinned, not fixed, and each pin says
 * which one it is.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { GAME, entityDef, isAirUnit } from "@shared/gameData";
import type { UnitDef } from "@shared/protocol";
import {
  airHoverLift,
  assertGeometryCoverage,
  buildAnyGeometry,
  selfCheckGeometryCoverage,
  unitGeometry,
} from "./unitGeometry";
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
  it("has 29 roster units and one builder result for each", () => {
    expect(UNIT_KEYS).toHaveLength(29);
    expect(ALL).toHaveLength(29);
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
    let maxGlow = 0;
    for (let i = 0; i < c.count; i++) {
      expect(c.getW(i)).toBeGreaterThanOrEqual(0);
      expect(c.getW(i)).toBeLessThanOrEqual(1);
      maxGlow = Math.max(maxGlow, c.getW(i));
    }
    expect(maxGlow).toBeGreaterThan(0);
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
  // `assemble` calls fitFootprint(body, radius, height - lift) with the
  // defaults: maxOvershoot 1.12, fillRadius 0.8, fillHeight 0.86. The reach
  // is measured from the origin while fitFootprint measures it from the
  // model's centre, so an off-centre hull can sit a little outside 1.12.
  it("keeps every ground unit inside 1.16x its collision radius", () => {
    for (const m of ALL) {
      if (isAirUnit(m.key)) continue;
      expect(m.reach / m.def.size.radius).toBeLessThanOrEqual(1.16);
    }
  });

  it("tops out within 1% of the roster height for ground units", () => {
    for (const m of ALL) {
      if (isAirUnit(m.key)) continue;
      expect(m.maxY / m.def.size.height).toBeLessThanOrEqual(1.01);
    }
  });

  it("never collapses a unit to a speck — the fill radius floor holds", () => {
    for (const m of ALL) {
      expect(m.reach / m.def.size.radius).toBeGreaterThan(0.5);
      expect(m.maxY / m.def.size.height).toBeGreaterThan(0.7);
    }
  });

  it("pins the one unit that breaks the 1.12 overshoot budget: high_templar", () => {
    // KNOWN DEFECT: the psionic blades are built off-centre, so the model
    // reaches 0.577 m against a 0.5 m collision circle — 15.4% over, and the
    // one unit the project's own selfCheckGeometryCoverage flags for it.
    const m = byKey.get("high_templar");
    if (!m) throw new Error("high_templar not measured");
    expect(m.reach).toBeCloseTo(0.577, 2);
    expect(m.reach / m.def.size.radius).toBeGreaterThan(1.13);
  });

  it("pins the one unit taller than its roster height: phoenix", () => {
    // KNOWN DEFECT: fitFootprint's fillHeight branch scales about the model's
    // own bottom, so a hull already hovering at y = 0.7 is grown 1.53x and
    // ends at 2.899 m for a 2.5 m roster height (16% over).
    const m = byKey.get("phoenix");
    if (!m) throw new Error("phoenix not measured");
    expect(m.maxY).toBeCloseTo(2.899, 2);
    expect(m.maxY).toBeGreaterThan(m.def.size.height);
  });
});

describe("base at y = 0 and the hover lift", () => {
  const GROUND_MIN_Y = 0.02;

  it("floats air hulls by exactly the documented hover lift", () => {
    for (const m of ALL) {
      if (!isAirUnit(m.key)) continue;
      expect(m.minY).toBeCloseTo(airHoverLift(m.def.size.height), 3);
    }
  });

  it("pins the ground units that sink below the ground plane", () => {
    // KNOWN DEFECT: treadedBlock embeds beveledBox, which is centred on the
    // origin, so tracked hulls and every greebled building block start half
    // buried. fitFootprint's height fit then scales the whole model about the
    // origin, deepening the sink. The project's self-check calls these
    // "origin below ground"; the deepest is the command centre at -0.52 m.
    const sunk: Record<string, number> = {
      scv: -0.176,
      siege_tank: -0.242,
      thor: -0.06,
      drone: -0.022,
      ultralisk: -0.078,
      queen: -0.024,
      roach: -0.025,
      lurker: -0.044,
    };
    for (const [key, minY] of Object.entries(sunk)) {
      expect(byKey.get(key)?.minY).toBeCloseTo(minY, 3);
    }
  });

  it("sinks no ground unit further than the command centre does", () => {
    const ground = ALL.filter((m) => !isAirUnit(m.key));
    const worst = ground.reduce((a, b) => (a.minY < b.minY ? a : b));
    expect(worst.minY).toBeGreaterThan(-0.53);
  });

  it("pins the two ground units that hover instead of standing", () => {
    // KNOWN DEFECT: raven and infestor fly in the fiction and the art, but
    // the roster says movement "ground", so `assemble` adds no hover lift and
    // no ground contact either — they hang 5 cm and 26 cm in the air.
    expect(byKey.get("infestor")?.minY).toBeCloseTo(0.052, 3);
    expect(byKey.get("raven")?.minY).toBeCloseTo(0.262, 3);
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
    expect(meanZ(key)).toBeGreaterThan(0.04);
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

  it("pins the 25 roster keys the project's own self-check fails today", () => {
    // KNOWN DEFECT SET: 23 models with an origin below the ground plane (see
    // the "sinks below ground" pins), high_templar over its collision radius,
    // and phoenix over its roster height. assertGeometryCoverage() therefore
    // throws today; this list is the bug list.
    const failing = selfCheckGeometryCoverage()
      .filter((c) => !c.ok)
      .map((c) => `${c.key}: ${c.reason.split("(")[0]?.trim()}`);
    expect(failing).toEqual([
      "high_templar: footprint exceeds collision radius",
      "phoenix: taller than roster height",
      "gateway: origin below ground",
      "forge: origin below ground",
      "cybernetics_core: origin below ground",
      "twilight_council: origin below ground",
      "robotics_facility: origin below ground",
      "scv: origin below ground",
      "siege_tank: origin below ground",
      "thor: origin below ground",
      "command_center: origin below ground",
      "supply_depot: origin below ground",
      "refinery: origin below ground",
      "barracks: origin below ground",
      "engineering_bay: origin below ground",
      "factory: origin below ground",
      "starport: origin below ground",
      "bunker: origin below ground",
      "drone: origin below ground",
      "ultralisk: origin below ground",
      "queen: origin below ground",
      "roach: origin below ground",
      "lurker: origin below ground",
      "overlord: origin below ground",
      "spine_crawler: origin below ground",
    ]);
  });

  it("assertGeometryCoverage throws on the first failing key", () => {
    // KNOWN DEFECT: 25 of 57 keys fail, so the boot-time assert would abort
    // the game. It is not wired into boot today.
    expect(() => assertGeometryCoverage()).toThrow(/assertGeometryCoverage\(\): high_templar/);
  });
});
