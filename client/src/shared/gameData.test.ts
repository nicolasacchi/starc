/**
 * Contract tests for the shared roster. These run in the client but assert
 * invariants the SERVER also depends on, so a roster change that would pass
 * the UI but break the simulation is caught here.
 */
import { describe, expect, it } from "vitest";
import { GAME } from "./gameData";
import {
  RACES,
  attackOf,
  abilitiesOf,
  buildingKeys,
  canAttackAir,
  entityDef,
  hasEntityDef,
  hasMap,
  isAirUnit,
  mapDef,
  raceColor,
  raceColorInt,
  raceData,
  startingBuilding,
  startingUnit,
  unitKeys,
} from "./gameData";
import type { Race } from "./protocol";

describe("shared game data", () => {
  it("defines exactly three races", () => {
    expect(GAME.races).toHaveLength(3);
    expect(RACES).toEqual(["terran", "zerg", "protoss"]);
  });

  it("gives every race ten units and nine buildings", () => {
    for (const race of RACES) {
      expect(unitKeys(race), race).toHaveLength(10);
      expect(buildingKeys(race), race).toHaveLength(9);
    }
  });

  it("has a unique key for every entity across all races", () => {
    const keys = RACES.flatMap((r) => [...unitKeys(r), ...buildingKeys(r)]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(GAME.units)).toHaveLength(keys.length);
  });

  it("resolves every produces, required_buildings and spawn reference", () => {
    for (const race of RACES) {
      const own = new Set([...unitKeys(race), ...buildingKeys(race)]);
      for (const key of own) {
        const def = entityDef(key);
        for (const ref of [...def.produces, ...(def.required_buildings ?? [])]) {
          expect(own.has(ref), `${race}.${key} -> ${ref}`).toBe(true);
        }
        for (const ability of abilitiesOf(key)) {
          if (ability.spawn) expect(own.has(ability.spawn), `${key}.${ability.key}`).toBe(true);
        }
      }
    }
  });

  it("gives every unit a single-character unique hotkey within its race", () => {
    for (const race of RACES) {
      const hotkeys = [...raceData(race).units, ...raceData(race).buildings]
        .map((e) => e.hotkey)
        .filter((h): h is string => Boolean(h));
      expect(new Set(hotkeys).size, `${race} duplicate hotkey`).toBe(hotkeys.length);
      for (const h of hotkeys) expect(h).toMatch(/^[A-Z]$/);
    }
  });

  it("keeps unit supply in 1..3", () => {
    for (const race of RACES) {
      for (const unit of raceData(race).units) {
        expect(unit.cost.supply, unit.key).toBeGreaterThanOrEqual(1);
        expect(unit.cost.supply, unit.key).toBeLessThanOrEqual(3);
      }
    }
  });

  it("gives exactly one harvesting unit per race with valid stats", () => {
    for (const race of RACES) {
      const harvesters = raceData(race).units.filter((u) => u.harvest);
      expect(harvesters, race).toHaveLength(1);
      const h = harvesters[0].harvest!;
      expect(h.capacity).toBeGreaterThan(0);
      expect(h.rate).toBeGreaterThan(0);
      expect(h.refund_pct).toBeGreaterThan(0);
      expect(h.refund_pct).toBeLessThanOrEqual(1);
    }
  });

  it("uses zero projectile speed for contact weapons and 20..100 for the rest", () => {
    for (const key of Object.keys(GAME.units)) {
      const attack = attackOf(key);
      if (!attack) continue;
      const contact = attack.weapon === "melee" || attack.weapon === "claw";
      if (contact) {
        expect(attack.projectile_speed, key).toBe(0);
        expect(attack.range, key).toBeLessThan(2);
      } else {
        expect(attack.projectile_speed, key).toBeGreaterThanOrEqual(20);
        expect(attack.projectile_speed, key).toBeLessThanOrEqual(100);
      }
      expect(attack.damage, key).toBeGreaterThan(0);
      expect(attack.cooldown, key).toBeGreaterThan(0);
      expect(attack.targets.length, key).toBeGreaterThan(0);
    }
  });

  it("never gives a ground-only weapon the air target, and vice versa", () => {
    for (const key of Object.keys(GAME.units)) {
      const attack = attackOf(key);
      if (!attack) continue;
      // canAttackAir must be derived from targets, never guessed from stats.
      expect(canAttackAir(key), key).toBe(attack.targets.includes("air"));
    }
  });

  it("declares mobility explicitly for every unit", () => {
    for (const race of RACES) {
      for (const unit of raceData(race).units) {
        expect(["ground", "air"], `${race}.${unit.key}`).toContain(unit.movement);
        expect(isAirUnit(unit.key), unit.key).toBe(unit.movement === "air");
      }
    }
    for (const race of RACES) {
      for (const key of buildingKeys(race)) expect(isAirUnit(key), key).toBe(false);
    }
  });

  it("lets air units attack, without requiring them to hit other air units", () => {
    // Guardians fly but can only shoot ground in StarCraft 1, so mobility and
    // weapon targets are genuinely independent. What must hold is that an
    // air unit is never a non-combatant with no way to fight.
    for (const race of RACES) {
      for (const unit of raceData(race).units.filter((u) => u.movement === "air")) {
        expect(attackOf(unit.key), unit.key).not.toBeNull();
        expect(attackOf(unit.key)!.targets.length, unit.key).toBeGreaterThan(0);
        expect(attackOf(unit.key)!.damage, unit.key).toBeGreaterThan(0);
      }
    }
  });

  it("names a real starting unit and building for every race", () => {
    for (const race of RACES) {
      const unit = startingUnit(race);
      const building = startingBuilding(race);
      expect(unitKeys(race), `${race} worker`).toContain(unit);
      expect(buildingKeys(race), `${race} base`).toContain(building);
      const def = entityDef(building);
      expect(def.cost.supply_provided ?? 0).toBeGreaterThan(0);
    }
  });

  it("exposes every map with a consistent playable area", () => {
    expect(GAME.maps.length).toBeGreaterThan(0);
    for (const m of GAME.maps) {
      expect(m.size, m.id).toBeGreaterThan(0);
      expect(m.max_players, m.id).toBeGreaterThanOrEqual(2);
      expect(m.max_players, m.id).toBeLessThanOrEqual(8);
      expect(m.start_positions.length, m.id).toBeGreaterThanOrEqual(2);
      expect(m.start_positions.length, m.id).toBeLessThanOrEqual(m.max_players);
      for (const p of m.start_positions) {
        expect(p.x, m.id).toBeGreaterThanOrEqual(0);
        expect(p.x, m.id).toBeLessThanOrEqual(m.size);
        expect(p.z, m.id).toBeGreaterThanOrEqual(0);
      }
      expect(m.lighting.time_of_day, m.id).toBeGreaterThanOrEqual(0);
      expect(m.lighting.time_of_day, m.id).toBeLessThanOrEqual(1);
    }
  });

  it("gives every start position a mineral cluster within harvesting range", () => {
    // A player who cannot reach minerals cannot open economically, so this is
    // a balance invariant rather than a formality.
    for (const m of GAME.maps) {
      for (const start of m.start_positions) {
        const nearest = Math.min(
          ...m.mineral_clusters.map((c) => Math.hypot(c.x - start.x, c.z - start.z)),
        );
        expect(nearest, `${m.id} start (${start.x}, ${start.z})`).toBeLessThan(20);
      }
    }
  });

  it("parses every race colour as an integer for the renderer", () => {
    for (const race of RACES) {
      expect(raceColor(race), race).toMatch(/^#[0-9a-f]{6}$/i);
      expect(raceColorInt(race), race).toBeGreaterThan(0);
    }
  });

  it("has positive build times, hp and sizes everywhere", () => {
    for (const key of Object.keys(GAME.units)) {
      const def = entityDef(key);
      expect(def.build_time, key).toBeGreaterThan(0);
      expect(def.hp, key).toBeGreaterThan(0);
      expect(def.size.radius, key).toBeGreaterThan(0);
      expect(def.size.height, key).toBeGreaterThan(0);
      expect(def.sight, key).toBeGreaterThan(0);
    }
  });

  it("exposes a buildable set for every starting worker", () => {
    for (const race of RACES) {
      const worker = startingUnit(race);
      const base = startingBuilding(race);
      expect(entityDef(base).produces.length, `${race} base produces`).toBeGreaterThan(0);
      expect(hasEntityDef(worker)).toBe(true);
    }
  });

  it("rejects an unknown key or map rather than returning undefined", () => {
    expect(hasEntityDef("not_a_unit")).toBe(false);
    expect(() => entityDef("not_a_unit")).toThrow();
    expect(hasMap("not_a_map")).toBe(false);
    expect(() => mapDef("not_a_map")).toThrow();
  });

  it("pins the protocol constants the server also uses", () => {
    expect(GAME.tick_ms).toBe(50);
    expect(GAME.snapshot_hz).toBe(10);
    expect(GAME.world_size).toBe(256);
    expect(GAME.max_supply).toBe(200);
  });
});
