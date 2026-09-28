/**
 * Race palettes for STARC.
 *
 * Every colour in the game is derived here from one number that already exists
 * in the roster — `race.color` in shared/game-data.json — so the three races
 * stay in sync with the data instead of hard-coding hexes in two places. No
 * image, gradient file or palette lookup PNG is loaded: the palettes are pure
 * THREE.Color arithmetic, expanded into base / dark / accent / emissive tones
 * plus one tint per surface kind.
 */
import * as THREE from "three";
import { GAME, RACES, raceColorInt } from "@shared/gameData";
import type { Race } from "@shared/protocol";
import type { PartTone } from "@render/geometry/shapes";

/** Surface families the material library knows how to shade. */
export type SurfaceKind = "metal" | "organic" | "energy" | "crystal" | "rock" | "glass";

export interface SurfacePBR {
  metalness: number;
  roughness: number;
  emissiveIntensity: number;
  opacity: number;
  transparent: boolean;
}

/** PBR triple (metalness / roughness / emissive intensity) per surface type. */
export const SURFACE_PBR: Readonly<Record<SurfaceKind, SurfacePBR>> = {
  metal: { metalness: 0.88, roughness: 0.44, emissiveIntensity: 0.04, opacity: 1, transparent: false },
  organic: { metalness: 0.04, roughness: 0.74, emissiveIntensity: 0.02, opacity: 1, transparent: false },
  energy: { metalness: 0, roughness: 0.16, emissiveIntensity: 2.6, opacity: 0.55, transparent: true },
  crystal: { metalness: 0.08, roughness: 0.08, emissiveIntensity: 1.7, opacity: 0.82, transparent: true },
  rock: { metalness: 0, roughness: 0.95, emissiveIntensity: 0, opacity: 1, transparent: false },
  glass: { metalness: 0.18, roughness: 0.06, emissiveIntensity: 0.25, opacity: 0.34, transparent: true },
};

/** Named tones every race palette provides. */
export type ToneName =
  | "base"
  | "dark"
  | "deep"
  | "accent"
  | "emissive"
  | "highlight"
  | "metal"
  | "organic"
  | "energy"
  | "crystal"
  | "rock"
  | "glass";

export interface RacePalette {
  race: Race;
  /** `race.color` straight out of the roster, as 0xRRGGBB. */
  source: number;
  /** Working-space (linear) colours, ready for a material. */
  colors: Readonly<Record<ToneName, THREE.Color>>;
  /** The same colours as 0xRRGGBB, for UI swatches and tint maths. */
  hex: Readonly<Record<ToneName, number>>;
}

/**
 * Per-part tone multipliers. RGB is applied on top of the material's race
 * colour so one mesh reads as gunmetal hull / amber trim / hot emissive no
 * matter which race owns it; `glow` is the emissive mask written into the
 * vertex colour's alpha slot.
 */
export const TONES = {
  hull: { r: 1, g: 1, b: 1 },
  plate: { r: 0.78, g: 0.78, b: 0.82 },
  dark: { r: 0.5, g: 0.5, b: 0.56 },
  deep: { r: 0.26, g: 0.26, b: 0.3 },
  light: { r: 1.32, g: 1.32, b: 1.3 },
  accent: { r: 1.55, g: 1.2, b: 0.7 },
  trim: { r: 1.3, g: 1.4, b: 1.5 },
  glass: { r: 1.1, g: 1.25, b: 1.45, glow: 0.15 },
  energy: { r: 1, g: 1, b: 1, glow: 1 },
  energyDim: { r: 1, g: 1, b: 1, glow: 0.4 },
} as const satisfies Record<string, PartTone>;

/** Blends two sRGB hexes into a working-space colour. */
function mix(a: number, b: number, t: number): THREE.Color {
  return new THREE.Color(a).lerp(new THREE.Color(b), t);
}

/* ------------------------------------------------------------------ */
/* Per-race recipes                                                    */
/* ------------------------------------------------------------------ */

type ToneSet = Readonly<Record<ToneName, THREE.Color>>;

function terranTones(source: number): ToneSet {
  const base = mix(0x3d454e, source, 0.22);
  const dark = base.clone().multiplyScalar(0.55);
  return {
    base,
    dark,
    // `deep` is derived from `dark` rather than from its own constant, so the
    // shadow ramp cannot invert on a race whose source colour is bright.
    // Terran's amber is bright enough that mixing it into a near-black made
    // `deep` read *lighter* than `dark`, which is visible on any panel using it.
    deep: mix(dark.getHex(), 0x0a0c0f, 0.55),
    accent: mix(source, 0xffe0a8, 0.12),
    emissive: mix(source, 0xffe9c0, 0.45),
    highlight: mix(source, 0xffffff, 0.6),
    metal: mix(0x3d454e, source, 0.22),
    organic: mix(0x6a5c48, source, 0.25),
    energy: mix(source, 0xfff0d8, 0.5),
    crystal: mix(0x7ec8ff, 0xffffff, 0.25),
    rock: mix(0x6a6a63, 0x3a3a36, 0.3),
    glass: mix(0x9fd0e8, 0xffffff, 0.4),
  };
}

function zergTones(source: number): ToneSet {
  const base = mix(0x3a1c26, source, 0.55);
  const dark = mix(0x3a1c26, source, 0.25);
  return {
    base,
    dark,
    deep: mix(dark.getHex(), 0x0d0609, 0.6),
    accent: mix(source, 0xff5a3c, 0.45),
    emissive: mix(0xff6a3a, source, 0.3),
    highlight: mix(source, 0xffb08a, 0.55),
    metal: mix(0x4a3a30, source, 0.3),
    organic: mix(0x3a1c26, source, 0.55),
    energy: mix(0xff7a4a, 0xffe0c0, 0.3),
    crystal: mix(0x9be07a, 0xffffff, 0.2),
    rock: mix(0x5a4a44, 0x2a2220, 0.35),
    glass: mix(0xc0a0d8, 0xffffff, 0.35),
  };
}

function protossTones(source: number): ToneSet {
  const base = mix(0xb08c3a, source, 0.55);
  const dark = mix(0xb08c3a, source, 0.25);
  return {
    base,
    dark,
    deep: mix(dark.getHex(), 0x0d0b05, 0.65),
    accent: mix(source, 0xfff6c0, 0.35),
    emissive: mix(0xffffff, source, 0.35),
    highlight: mix(0xffffff, source, 0.2),
    metal: mix(0xb08c3a, source, 0.55),
    organic: mix(0x9a7a5a, source, 0.4),
    energy: mix(0xbfe9ff, 0xffffff, 0.5),
    crystal: mix(0x8fd8ff, 0xffffff, 0.3),
    rock: mix(0x6a6a63, source, 0.2),
    glass: mix(0xd8f0ff, 0xffffff, 0.4),
  };
}

const RECIPES: Record<Race, (source: number) => ToneSet> = {
  terran: terranTones,
  zerg: zergTones,
  protoss: protossTones,
};

const TONE_NAMES: readonly ToneName[] = [
  "base",
  "dark",
  "deep",
  "accent",
  "emissive",
  "highlight",
  "metal",
  "organic",
  "energy",
  "crystal",
  "rock",
  "glass",
];

const palettes = new Map<Race, RacePalette>();

/** Memoised palette for a race. Always returns the same instance. */
export function racePalette(race: Race): RacePalette {
  const cached = palettes.get(race);
  if (cached) return cached;
  const sourceHex = raceColorInt(race);
  const built = RECIPES[race](sourceHex);
  const hex = {} as Record<ToneName, number>;
  for (const name of TONE_NAMES) {
    hex[name] = built[name].getHex(THREE.SRGBColorSpace);
  }
  const palette: RacePalette = { race, source: sourceHex, colors: built, hex };
  palettes.set(race, palette);
  return palette;
}

/** Palette entry as a 0xRRGGBB int (UI swatches, tint maths, team colours). */
export function paletteHex(race: Race, tone: ToneName): number {
  return racePalette(race).hex[tone];
}

/** Forgets the memoised palettes; they hold no GPU resources. */
export function clearPaletteCache(): void {
  palettes.clear();
}

/* ------------------------------------------------------------------ */
/* Entity → race                                                       */
/* ------------------------------------------------------------------ */

/** Built once from `race_index` in the roster: every entity key → its race. */
const ENTITY_RACE: ReadonlyMap<string, Race> = new Map(
  RACES.flatMap((race) => (GAME.race_index[race] ?? []).map((key): [string, Race] => [key, race])),
);

/**
 * Which race owns an entity type. Read from `race_index` in
 * shared/game-data.json, so it is right for all 57 keys without a hand-kept
 * list; an unknown key falls back to Terran rather than throwing mid-frame.
 */
export function raceOfEntity(key: string): Race {
  return ENTITY_RACE.get(key) ?? "terran";
}

/** Palette for an entity type, without the caller resolving the race first. */
export function paletteOfEntity(key: string): RacePalette {
  return racePalette(raceOfEntity(key));
}
