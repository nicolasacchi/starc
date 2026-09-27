#!/usr/bin/env bun
/**
 * Validates shared/data/race-*.json against shared/schema.json and the
 * cross-file invariants the simulation relies on. Exits non-zero on failure
 * so it can gate CI.
 */
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "shared", "data");

export type Attack = {
  damage: number;
  range: number;
  cooldown: number;
  weapon: string;
  projectile_speed: number;
  targets: string[];
  splash?: { radius: number; damage_pct: number } | null;
} | { weapon: "none" };

export type ResourceCost = {
  minerals: number;
  vespene: number;
  supply: number;
  supply_provided?: number;
};

export type Ability = {
  key: string;
  name: string;
  cooldown: number;
  effect: string;
  magnitude?: number;
  radius?: number;
  duration_s?: number;
  target?: string;
  cost?: number;
  spawn?: string;
};

export type GameUnit = {
  key: string;
  name: string;
  kind: "unit";
  hotkey?: string;
  tier?: number;
  cost: ResourceCost;
  build_time: number;
  hp: number;
  armor: number;
  shield?: number;
  shield_regen?: number;
  sight: number;
  speed: number;
  size: { radius: number; height: number };
  attack: Attack;
  harvest?: { capacity: number; rate: number; refund_pct: number } | null;
  abilities: Ability[];
  produces: string[];
  required_buildings?: string[];
  vision?: number;
};

export type GameBuilding = {
  key: string;
  name: string;
  kind: "building";
  hotkey?: string;
  tier?: number;
  cost: ResourceCost;
  build_time: number;
  hp: number;
  armor: number;
  sight: number;
  size: { radius: number; height: number };
  abilities: Ability[];
  produces: string[];
  required_buildings?: string[];
  vision?: number;
  defense?: {
    range: number;
    cooldown: number;
    damage: number;
    weapon?: string;
    targets: string[];
    missile_splash?: number;
  } | null;
};

export type RaceData = {
  race: string;
  label: string;
  color: string;
  units: GameUnit[];
  buildings: GameBuilding[];
};

const errors: string[] = [];

export function loadRaces(): RaceData[] {
  const schema = JSON.parse(readFileSync(join(ROOT, "shared", "schema.json"), "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  return readdirSync(DATA_DIR)
    .filter((f) => f.startsWith("race-") && f.endsWith(".json"))
    .sort()
    .map((file) => {
      const data: RaceData = JSON.parse(readFileSync(join(DATA_DIR, file), "utf8"));
      if (!validate(data)) {
        for (const e of validate.errors ?? []) {
          errors.push(`${file} ${e.instancePath || "/"} ${e.message}`);
        }
      }
      return data;
    });
}

export function checkInvariants(races: RaceData[]): void {
  const allKeys = new Set<string>();
  const allHotkeys = new Set<string>();
  const expect = { units: 10, buildings: 9 };

  for (const race of races) {
    const n = race.race;
    if (race.units.length !== expect.units) {
      errors.push(`${n}: expected ${expect.units} units, got ${race.units.length}`);
    }
    if (race.buildings.length !== expect.buildings) {
      errors.push(`${n}: expected ${expect.buildings} buildings, got ${race.buildings.length}`);
    }
    if (!/^#[0-9a-f]{6}$/i.test(race.color)) errors.push(`${n}: color must be #rrggbb, got ${race.color}`);

    const own = new Set<string>([...race.units, ...race.buildings].map((e) => e.key));

    for (const e of [...race.units, ...race.buildings]) {
      if (allKeys.has(e.key)) errors.push(`${n}: duplicate key "${e.key}" across races`);
      allKeys.add(e.key);

      if (e.hotkey) {
        if (allHotkeys.has(e.key)) errors.push(`${n}: duplicate hotkey "${e.hotkey}" on ${e.key}`);
        allHotkeys.add(e.key);
      }
      for (const ref of [...e.produces, ...(e.required_buildings ?? [])]) {
        if (!own.has(ref)) errors.push(`${n}.${e.key}: unresolved reference "${ref}"`);
      }
      for (const ab of e.abilities ?? []) {
        if (ab.spawn && !own.has(ab.spawn)) errors.push(`${n}.${e.key}.${ab.key}: unresolved spawn "${ab.spawn}"`);
        if (ab.cooldown < 0) errors.push(`${n}.${e.key}.${ab.key}: negative cooldown`);
      }
      if (e.kind === "unit") {
        if (e.cost.supply < 1 || e.cost.supply > 3) {
          errors.push(`${n}.${e.key}: unit supply must be 1..3, got ${e.cost.supply}`);
        }
        const atk = e.attack;
        if ("damage" in atk) {
          // `melee` and `claw` are instant-contact weapons; everything else flies.
          const contact = atk.weapon === "melee" || atk.weapon === "claw";
          if (contact && atk.projectile_speed !== 0) {
            errors.push(`${n}.${e.key}: ${atk.weapon} must have projectile_speed 0`);
          }
          if (!contact && (atk.projectile_speed < 20 || atk.projectile_speed > 100)) {
            errors.push(`${n}.${e.key}: projectile_speed ${atk.projectile_speed} outside 20..100`);
          }
          if (!atk.targets.includes("structure") && !atk.targets.includes("air")) {
            errors.push(`${n}.${e.key}: attack must target at least one of structure/air`);
          }
        }
        if (e.harvest && (e.harvest.capacity < 1 || e.harvest.rate <= 0)) {
          errors.push(`${n}.${e.key}: invalid harvest block`);
        }
      }
      if (e.hp <= 0) errors.push(`${n}.${e.key}: hp must be > 0`);
      if (e.size.radius <= 0 || e.size.height <= 0) errors.push(`${n}.${e.key}: size must be > 0`);
    }

    // Exactly one worker that can harvest.
    const harvesters = race.units.filter((u) => u.harvest);
    if (harvesters.length !== 1) {
      errors.push(`${n}: expected exactly 1 harvesting unit, got ${harvesters.length}`);
    }
  }

  if (races.length !== 3) errors.push(`expected 3 races, got ${races.length}`);
}

export function buildGameData(): Record<string, unknown> {
  const races = loadRaces();
  checkInvariants(races);
  if (errors.length) {
    for (const e of errors) console.error("  ✗ " + e);
    throw new Error(`game data validation failed with ${errors.length} error(s)`);
  }

  const mapsFile = join(DATA_DIR, "maps.json");
  if (!existsSync(mapsFile)) throw new Error("shared/data/maps.json missing");
  const maps = JSON.parse(readFileSync(mapsFile, "utf8"));

  const units: Record<string, GameUnit | GameBuilding> = {};
  const raceIndex: Record<string, string[]> = {};
  for (const race of races) {
    raceIndex[race.race] = [];
    for (const e of [...race.units, ...race.buildings]) {
      units[e.key] = e;
      raceIndex[race.race].push(e.key);
    }
  }

  return {
    version: 1,
    tick_ms: 50,
    snapshot_hz: 10,
    world_size: 256,
    max_supply: 200,
    base_supply: 10,
    supply_increment: 8,
    starting_resources: { minerals: 50, vespene: 0 },
    starting_units: { terran: "scv", zerg: "drone", protoss: "probe" },
    starting_buildings: { terran: "command_center", zerg: "hatchery", protoss: "nexus" },
    races,
    units,
    race_index: raceIndex,
    maps: maps.maps,
  };
}

if (import.meta.main) {
  try {
    const data = buildGameData();
    const count = Object.keys(data.units as Record<string, unknown>).length;
    console.log(`✓ game data valid — ${(data.races as unknown[]).length} races, ${count} entities, ${(data.maps as unknown[]).length} maps`);
  } catch (err) {
    console.error("✗ " + (err as Error).message);
    process.exit(1);
  }
}
