/**
 * The building builders, checked against the collision circles the server
 * collides against.
 *
 * A structure that is drawn larger than its `size.radius` is a structure the
 * player can see their units walk through; one that is drawn sunk into the
 * ground reads as a bug even though it collides correctly. Both are measured
 * here for every building in the roster, not a sample.
 *
 * Each describe block states the contract it enforces. Where one used to pin
 * a defect, it now states the contract and records what the defect measured,
 * so the regression is legible without running anything.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { GAME, entityDef } from "@shared/gameData";
import type { BuildingDef } from "@shared/protocol";
import { buildingGeometry, buildBuildingGeometry } from "./buildingGeometry";
import { clearGeometryCache, releaseGeometryKey } from "./geometryCache";

const BUILDING_KEYS = Object.keys(GAME.units).filter((k) => entityDef(k).kind === "building");

interface Measured {
  key: string;
  def: BuildingDef;
  geometry: THREE.BufferGeometry;
  minY: number;
  maxY: number;
  reach: number;
  triangles: number;
}

function measure(key: string): Measured {
  const def = entityDef(key) as BuildingDef;
  const geometry = buildBuildingGeometry(key);
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

const ALL: Measured[] = BUILDING_KEYS.map(measure);
const byKey = new Map(ALL.map((m) => [m.key, m]));

afterEach(() => {
  clearGeometryCache();
});

describe("roster coverage", () => {
  it("has 27 roster buildings and one builder result for each", () => {
    expect(BUILDING_KEYS).toHaveLength(27);
    expect(ALL).toHaveLength(27);
  });

  it.each(BUILDING_KEYS)("%s builds a renderable, vertex-coloured buffer", (key) => {
    const m = byKey.get(key);
    if (!m) throw new Error(`unmeasured key ${key}`);
    const pos = m.geometry.getAttribute("position");
    expect(m.triangles).toBeGreaterThan(0);
    expect(m.geometry.index).toBeNull();
    expect(m.geometry.getAttribute("uv")?.count).toBe(pos.count);
    expect(m.geometry.getAttribute("normal")?.count).toBe(pos.count);
    // A colour-count mismatch is what makes a merged hull render untextured.
    expect(m.geometry.getAttribute("color")?.count).toBe(pos.count);
    expect(m.geometry.getAttribute("color")?.itemSize).toBe(4);
    expect(m.geometry.boundingBox).not.toBeNull();
    m.geometry.computeBoundingSphere();
    expect(m.geometry.boundingSphere?.radius).toBeGreaterThan(0);
  });

  it.each(BUILDING_KEYS)("%s contains no NaN or infinite coordinates", (key) => {
    const p = byKey.get(key)?.geometry.getAttribute("position");
    if (!p) throw new Error(`unmeasured key ${key}`);
    for (let i = 0; i < p.array.length; i++) {
      expect(Number.isFinite(p.array[i] as number)).toBe(true);
    }
  });

  it("is byte-identical when rebuilt — greebles are seeded, not random", () => {
    for (const key of ["command_center", "hatchery", "bunker", "spire"]) {
      const a = buildBuildingGeometry(key);
      const b = buildBuildingGeometry(key);
      expect(Array.from(a.getAttribute("position").array as ArrayLike<number>)).toEqual(
        Array.from(b.getAttribute("position").array as ArrayLike<number>),
      );
    }
  });

  it("wears its clutter: the big hulls are the most detailed", () => {
    // command_center (r 2.5) and hatchery (r 3) are the two largest collision
    // circles in the roster; if the clutter budget stopped scaling they would
    // be the flattest-looking boxes in the game.
    expect(byKey.get("command_center")?.triangles).toBeGreaterThan(
      byKey.get("bunker")?.triangles ?? Number.MAX_SAFE_INTEGER,
    );
    expect(byKey.get("hatchery")?.triangles).toBeGreaterThan(
      byKey.get("bunker")?.triangles ?? Number.MAX_SAFE_INTEGER,
    );
  });
});

describe("fit to the collision circle", () => {
  // `buildBuildingGeometry` seats the model on y = 0, then calls
  // fitFootprint(geometry, radius, height, { maxOvershoot: 1.0,
  // fillHeight: 0.9 }): a building must match its circle exactly, so anything
  // past the radius is pulled in, and the reach is measured from the
  // collision centre so a mound built off centre cannot keep the offset.
  //
  // Before the fix three Zerg mounds were built off centre and kept the
  // offset through the fit — hatchery 3.092 m and lair 3.089 m against a 3 m
  // circle (3.1% over), spawning_pool 2.006 m against 2 m. The builders' own
  // maxOvershoot of 1.0 says those must match exactly.
  it("keeps every structure inside its collision radius", () => {
    for (const m of ALL) {
      expect(m.reach).toBeLessThanOrEqual(m.def.size.radius + 1e-3);
    }
  });

  it("tops out at or below the roster height", () => {
    for (const m of ALL) {
      expect(m.maxY).toBeLessThanOrEqual(m.def.size.height + 1e-3);
    }
  });

  it("never collapses a structure to a sliver", () => {
    for (const m of ALL) {
      expect(m.reach / m.def.size.radius).toBeGreaterThan(0.75);
      expect(m.maxY / m.def.size.height).toBeGreaterThan(0.7);
    }
  });
});

describe("base at y = 0", () => {
  // `hullBlock` wraps `greeble(beveledBox(...))`, and beveledBox used to be
  // centred on the origin rather than based at y = 0, so every block-built
  // structure started half buried; the height fit then scaled the whole model
  // about the origin, deepening the sink. The measured damage, deepest first:
  //
  //   command_center -0.524   factory      -0.330   gateway       -0.325
  //   supply_depot   -0.306   forge        -0.300   robotics      -0.300
  //   barracks       -0.275   engineering  -0.250   twilight      -0.240
  //   cybernetics    -0.220   refinery     -0.096   bunker        -0.098
  //   overlord       -0.072   starport     -0.052   spine_crawler -0.050
  //
  // Twenty-three of the 57 roster keys were below the ground plane, which is
  // what selfCheckGeometryCoverage reported as "origin below ground".
  it("stands every structure on the ground plane", () => {
    for (const m of ALL) {
      expect(m.minY).toBeCloseTo(0, 4);
    }
  });

  it("sinks nothing at all, whatever the builder hung where", () => {
    const worst = ALL.reduce((a, b) => (a.minY < b.minY ? a : b));
    expect(worst.minY).toBeGreaterThanOrEqual(0);
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

  it("puts the turret's gun on the +Z side of its collar", () => {
    expect(meanZ("turret")).toBeGreaterThan(0.15);
  });

  it.each(["bunker", "extractor", "photon_cannon"])("leaves %s facing-neutral", (key) => {
    expect(Math.abs(meanZ(key))).toBeLessThan(0.06);
  });
});

describe("entry points", () => {
  it("buildingGeometry serves a building key from the cache", () => {
    const a = buildingGeometry("bunker");
    const b = buildingGeometry("bunker");
    expect(b).toBe(a);
  });

  it("buildingGeometry also serves unit keys, so no roster key throws", () => {
    expect(buildingGeometry("zealot").getAttribute("position").count).toBeGreaterThan(0);
  });

  it("buildBuildingGeometry refuses a unit key", () => {
    expect(() => buildBuildingGeometry("marine")).toThrow(/no builder for roster building/);
  });

  it("refuses an unknown key", () => {
    expect(() => buildingGeometry("not_a_building")).toThrow(/unknown entity type/);
  });

  it("releases a cached structure on request", () => {
    buildingGeometry("turret");
    expect(releaseGeometryKey("turret")).toBe(true);
  });
});
