/**
 * Typed, indexed access to shared/game-data.json. The JSON is the single
 * source of truth for both the Rails simulation and this client; nothing here
 * duplicates a stat.
 */
import data from "@data";
import type {
  AbilityDef,
  AttackDef,
  BuildingDef,
  EntityDef,
  GameData,
  MapDef,
  Race,
  RaceData,
} from "./protocol";

export const GAME = data as unknown as GameData;

export const RACES: Race[] = ["terran", "zerg", "protoss"];

export function raceData(race: Race): RaceData {
  const found = GAME.races.find((r) => r.race === race);
  if (!found) throw new Error(`unknown race: ${race}`);
  return found;
}

export function entityDef(key: string): EntityDef {
  const def = GAME.units[key];
  if (!def) throw new Error(`unknown entity type: ${key}`);
  return def;
}

export function hasEntityDef(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(GAME.units, key);
}

export function unitKeys(race: Race): string[] {
  return raceData(race).units.map((u) => u.key);
}

export function buildingKeys(race: Race): string[] {
  return raceData(race).buildings.map((b) => b.key);
}
/** Air mobility is declared in the data, never inferred from stats. */
export function isAirUnit(key: string): boolean {
  const def = entityDef(key);
  return def.kind === "unit" && def.movement === "air";
}

export function entitiesOfRace(race: Race): EntityDef[] {
  return [...raceData(race).units, ...raceData(race).buildings];
}

/** Full attack block, or null for a non-combatant. */
export function attackOf(key: string): AttackDef | null {
  const def = entityDef(key);
  if (def.kind !== "unit") return null;
  const a = def.attack;
  return "damage" in a ? a : null;
}

export function canAttackAir(key: string): boolean {
  const a = attackOf(key);
  return a !== null && a.targets.includes("air");
}

export function abilitiesOf(key: string): AbilityDef[] {
  return entityDef(key).abilities ?? [];
}

export function ability(key: string, abilityKey: string): AbilityDef | null {
  return abilitiesOf(key).find((a) => a.key === abilityKey) ?? null;
}

export function startingUnit(race: Race): string {
  return GAME.starting_units[race];
}

export function startingBuilding(race: Race): string {
  return GAME.starting_buildings[race];
}

export function mapDef(id: string): MapDef {
  const m = GAME.maps.find((x) => x.id === id);
  if (!m) throw new Error(`unknown map: ${id}`);
  return m;
}

export function hasMap(id: string): boolean {
  return GAME.maps.some((m) => m.id === id);
}

/** Production options for a building, filtered to things this race can build. */
export function productionOptions(buildingKey: string): string[] {
  return entityDef(buildingKey).produces ?? [];
}

/** Units this race can build that require the given building. */
export function buildableWith(buildingKey: string, race: Race): EntityDef[] {
  const own = new Set(entitiesOfRace(race).map((e) => e.key));
  return entitiesOfRace(race).filter(
    (e) => e.kind === "unit" && (e.required_buildings ?? []).includes(buildingKey) && own.has(e.key),
  );
}

/** `0xRRGGBB` for a `#rrggbb` race colour. */
export function raceColorInt(race: Race): number {
  return parseInt(raceData(race).color.slice(1), 16);
}

export function raceColor(race: Race): string {
  return raceData(race).color;
}

export function isBuilding(key: string): key is BuildingDef["key"] {
  return entityDef(key).kind === "building";
}

/** Human label for an entity type, with race disambiguation for generic names. */
export function displayName(key: string): string {
  return entityDef(key).name;
}
