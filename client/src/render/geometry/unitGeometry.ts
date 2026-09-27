/**
 * Unit geometry — every mobile entity in the roster, generated in code.
 *
 * 100% procedural: no model, mesh or image file is imported. Each unit is
 * assembled from the primitives in `./shapes` into one merged, vertex-coloured
 * BufferGeometry, tuned for silhouette-first readability at RTS zoom: a
 * Marine is a compact humanoid with a rifle, a Siege Tank is a hull + turret +
 * barrel, a Zergling is a low quadruped, a Battlecruiser is a big flying hull.
 * Nothing about the shape comes from a hard-coded stat — the footprint comes
 * from `size.radius` / `size.height` in shared/game-data.json, and
 * `movement === "air"` decides whether the model hovers and gets a shadow
 * decal.
 *
 * Conventions (enforced by `fitFootprint` and the self-check below):
 *  - origin at the base centre, y = 0 is the ground contact plane;
 *  - the model faces +Z;
 *  - horizontal extent stays inside the collision radius, and the silhouette
 *    tops out at the roster height, so what you see is what the server blocks.
 *
 * This module and `buildingGeometry.ts` reference each other: each is the
 * other's fallback for a key of the wrong kind, so neither entry point throws
 * for any of the 57 roster keys. Both only call each other at build time,
 * after both modules have finished evaluating.
 */
import * as THREE from "three";
import { GAME, entityDef } from "@shared/gameData";
import type { Race, UnitDef } from "@shared/protocol";
import { TONES, raceOfEntity } from "@render/materials/palette";
import {
  PartList,
  beveledBox,
  capsule,
  chamferedCylinder,
  cone,
  fitFootprint,
  greeble,
  hexPrism,
  mergeGroups,
  mulberry32,
  octahedron,
  panelLineOverlay,
  setPartColor,
  sphereLowPoly,
  taperedBox,
  torusSegment,
  treadedBlock,
  truncatedPyramid,
  wingShape,
} from "./shapes";
import type { PartTone } from "./shapes";
import { buildingGeometry } from "./buildingGeometry";

/** Material group holding the hovering hull of an air unit. */
export const AIR_BODY_GROUP = 0;
/** Material group holding the ground shadow decal of an air unit. */
export const AIR_SHADOW_GROUP = 1;

interface Build {
  def: UnitDef;
  key: string;
  race: Race;
  /** Collision radius in metres; the visual is fitted to it. */
  radius: number;
  /** Silhouette height in metres. */
  height: number;
  air: boolean;
  parts: PartList;
}

type UnitBuilder = (b: Build) => void;

/* ------------------------------------------------------------------ */
/* Shared assemblies                                                   */
/* ------------------------------------------------------------------ */

/** Two planted legs with boots — the base of every biped silhouette. */
function legs(b: Build, top: number, spread: number, width: number, depth: number): void {
  const thigh = top * 0.56;
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(width, thigh, depth, 0.85), TONES.dark, { x: side * spread });
    b.parts.add(
      taperedBox(width * 1.12, top - thigh * 0.9, depth * 1.08, 0.9),
      TONES.plate,
      { x: side * spread * 0.94, y: thigh * 0.9 },
    );
    b.parts.add(taperedBox(width * 1.6, top * 0.13, depth * 2, 0.85), TONES.deep, {
      x: side * spread * 0.94,
      z: depth * 0.4,
    });
  }
}

function torsoBox(
  b: Build,
  y: number,
  h: number,
  w: number,
  d: number,
  taper = 0.82,
  tone: PartTone = TONES.hull,
): void {
  b.parts.add(taperedBox(w, h, d, taper), tone, { y });
}

type HeadStyle = "helmet" | "visor" | "hood" | "crest" | "beak" | "gem" | "mandible" | "none";

function head(b: Build, y: number, size: number, style: HeadStyle): void {
  switch (style) {
    case "helmet":
      b.parts.add(taperedBox(size * 1.5, size * 1.35, size * 1.5, 0.68), TONES.plate, { y });
      b.parts.add(taperedBox(size * 1.25, size * 0.3, size * 0.34, 1), TONES.deep, {
        y: y + size * 0.5,
        z: size * 0.62,
      });
      break;
    case "visor":
      b.parts.add(taperedBox(size * 1.4, size * 1.2, size * 1.4, 0.8), TONES.hull, { y });
      b.parts.add(taperedBox(size * 1.15, size * 0.3, size * 0.3, 1), TONES.energy, {
        y: y + size * 0.6,
        z: size * 0.58,
      });
      break;
    case "hood":
      b.parts.add(taperedBox(size * 1.5, size * 1.5, size * 1.4, 0.55), TONES.dark, { y });
      b.parts.add(taperedBox(size * 0.8, size * 0.7, size * 0.3, 1), TONES.energyDim, {
        y: y + size * 0.5,
        z: size * 0.6,
      });
      break;
    case "crest":
      b.parts.add(taperedBox(size * 1.3, size * 1.1, size * 1.3, 0.7), TONES.hull, { y });
      b.parts.add(taperedBox(size * 0.4, size * 1.5, size * 1.1, 0.2), TONES.accent, {
        y: y + size * 0.9,
        z: size * 0.1,
      });
      break;
    case "beak":
      b.parts.add(taperedBox(size * 1.2, size * 1.1, size * 1.9, 0.35), TONES.plate, { y });
      b.parts.add(taperedBox(size * 0.7, size * 0.5, size * 1.1, 0.2), TONES.trim, {
        y: y + size * 0.35,
        z: size * 0.9,
      });
      break;
    case "gem":
      b.parts.add(octahedron(size * 0.95), TONES.energy, { y: y + size * 0.5 });
      break;
    case "mandible":
      for (const side of [1, -1]) {
        b.parts.add(taperedBox(size * 0.3, size * 0.3, size * 1.3, 0.2), TONES.trim, {
          x: side * size * 0.35,
          y: y + size * 0.3,
          z: size * 0.5,
          rx: -0.35,
        });
      }
      b.parts.add(taperedBox(size * 0.8, size * 0.6, size * 0.7, 0.7), TONES.deep, { y });
      break;
    case "none":
      break;
  }
}

/** Shoulders and upper arms, hanging slightly forward. */
function arms(
  b: Build,
  y: number,
  span: number,
  length: number,
  width: number,
  forward = 0,
  tone: PartTone = TONES.plate,
): void {
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(width, length, width, 0.8), tone, {
      x: side * span,
      y,
      z: forward,
      rx: forward > 0 ? -0.5 : 0,
    });
    b.parts.add(taperedBox(width * 0.9, length * 0.45, width * 0.9, 0.9), TONES.dark, {
      x: side * span,
      y: y - length * 0.5,
      z: forward + (forward > 0 ? length * 0.3 : 0),
    });
  }
}

type WeaponStyle = "rifle" | "shotgun" | "cannon" | "blade" | "staff" | "claw" | "none";

function weapon(
  b: Build,
  style: WeaponStyle,
  o: { x: number; y: number; z: number; len: number; r: number },
): void {
  switch (style) {
    case "rifle":
      b.parts.add(taperedBox(o.r * 1.5, o.r * 1.5, o.len * 0.55, 0.9), TONES.deep, {
        x: o.x,
        y: o.y,
        z: o.z,
      });
      b.parts.add(chamferedCylinder(o.r * 0.42, o.r * 0.42, o.len * 0.6, 6), TONES.dark, {
        x: o.x,
        y: o.y + o.r * 0.3,
        z: o.z + o.len * 0.5,
        rx: Math.PI * 0.5,
      });
      b.parts.add(taperedBox(o.r * 0.5, o.r * 1.6, o.r * 0.9, 0.8), TONES.dark, {
        x: o.x,
        y: o.y - o.r * 1.1,
        z: o.z + o.len * 0.1,
      });
      break;
    case "shotgun":
      b.parts.add(taperedBox(o.r * 1.8, o.r * 1.5, o.len * 0.5, 0.9), TONES.deep, {
        x: o.x,
        y: o.y,
        z: o.z,
      });
      for (const side of [1, -1]) {
        b.parts.add(chamferedCylinder(o.r * 0.4, o.r * 0.4, o.len * 0.65, 6), TONES.dark, {
          x: o.x + side * o.r * 0.5,
          y: o.y + o.r * 0.2,
          z: o.z + o.len * 0.35,
          rx: Math.PI * 0.5,
        });
      }
      break;
    case "cannon":
      b.parts.add(taperedBox(o.r * 2.2, o.r * 1.7, o.len * 0.5, 0.85), TONES.plate, {
        x: o.x,
        y: o.y,
        z: o.z,
      });
      b.parts.add(chamferedCylinder(o.r * 0.7, o.r * 0.8, o.len, 8), TONES.dark, {
        x: o.x,
        y: o.y,
        z: o.z + o.len * 0.4,
        rx: Math.PI * 0.5,
      });
      b.parts.add(chamferedCylinder(o.r * 0.95, o.r * 0.95, o.r * 0.5, 8), TONES.accent, {
        x: o.x,
        y: o.y,
        z: o.z + o.len * 1.25,
        rx: Math.PI * 0.5,
      });
      break;
    case "blade":
      b.parts.add(taperedBox(o.r * 0.45, o.r * 0.9, o.len, 0.25), TONES.energy, {
        x: o.x,
        y: o.y,
        z: o.z,
      });
      b.parts.add(taperedBox(o.r * 0.7, o.r * 0.7, o.r * 0.7, 1), TONES.trim, {
        x: o.x,
        y: o.y,
        z: o.z,
      });
      break;
    case "staff":
      b.parts.add(chamferedCylinder(o.r * 0.28, o.r * 0.28, o.len, 6), TONES.deep, {
        x: o.x,
        y: o.y - o.len * 0.5,
        z: o.z,
      });
      b.parts.add(sphereLowPoly(o.r * 0.85, 8, 5), TONES.energy, {
        x: o.x,
        y: y0(o.y, o.len),
        z: o.z,
      });
      break;
    case "claw":
      for (const side of [1, -1]) {
        b.parts.add(cone(o.r * 0.4, o.len, 5), TONES.trim, {
          x: o.x + side * o.r * 0.6,
          y: o.y,
          z: o.z,
          rx: Math.PI * 0.5,
          ry: side * 0.2,
        });
      }
      break;
    case "none":
      break;
  }
}

function y0(y: number, len: number): number {
  return y + len * 0.5;
}

/** Shoulder pads — the angular Protoss read. */
function pauldron(b: Build, y: number, x: number, size: number): void {
  for (const side of [1, -1]) {
    b.parts.add(truncatedPyramid(size * 1.2, size * 1.6, size * 0.5, size * 0.9, size * 0.9), TONES.accent, {
      x: side * x,
      y,
    });
  }
}

/** Ring of jointed insect legs, splayed outward and up. */
function insectLegs(
  b: Build,
  count: number,
  ring: number,
  y: number,
  len: number,
  w: number,
  tone: PartTone = TONES.dark,
): void {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.PI * 0.25;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    b.parts.add(taperedBox(w, len, w, 0.5), tone, {
      x: cx * ring * 0.55,
      y: y - len * 0.55,
      z: cz * ring * 0.55,
      rx: cz * 0.5,
      rz: -cx * 0.5,
    });
    b.parts.add(taperedBox(w * 0.8, len * 0.55, w * 0.8, 0.4), TONES.deep, {
      x: cx * ring,
      y: 0,
      z: cz * ring,
      rx: cz * 0.9,
      rz: -cx * 0.9,
    });
  }
}

/** Zerg carapace dome. */
function carapace(b: Build, y: number, r: number, h: number, tone: PartTone = TONES.hull): void {
  b.parts.add(sphereLowPoly(r, 8, 5), tone, { y, sy: h / (r * 2) });
}

/** Ring of chitin spikes around a carapace — the Zerg silhouette. */
function spines(
  b: Build,
  count: number,
  ring: number,
  y: number,
  len: number,
  w: number,
  seed: number,
): void {
  const rnd = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    const length = len * (0.65 + rnd() * 0.6);
    b.parts.add(cone(w, length, 5), TONES.trim, {
      x: cx * ring,
      y,
      z: cz * ring,
      rx: cz * 0.45,
      rz: -cx * 0.45,
    });
  }
}

function wings(
  b: Build,
  span: number,
  chord: number,
  y: number,
  z: number,
  x: number,
  tilt: number,
  tone: PartTone = TONES.plate,
): void {
  for (const side of [1, -1]) {
    b.parts.add(wingShape(span, chord, chord * 0.16), tone, {
      x: side * x,
      y,
      z,
      ry: side > 0 ? -0.25 : Math.PI + 0.25,
      rz: side * tilt,
    });
  }
}

/** Engine pod with a hot intake, used at the back of every air hull. */
function nacelles(
  b: Build,
  count: number,
  spread: number,
  y: number,
  z: number,
  r: number,
  len: number,
): void {
  for (let i = 0; i < count; i++) {
    const spread2 = count === 1 ? 0 : (i / (count - 1) - 0.5) * 2 * spread;
    for (const side of count === 1 ? [1] : [1, -1]) {
      if (count > 2 && i % 2 === 1) continue;
      const x = count === 1 ? 0 : side * spread2;
      b.parts.add(taperedBox(r * 2.4, r * 2, len, 0.7), TONES.plate, { x, y, z });
      b.parts.add(chamferedCylinder(r * 0.9, r * 0.75, r * 0.5, 8), TONES.energy, {
        x,
        y: y + r * 0.75,
        z: z - len * 0.15,
      });
    }
  }
}

/** Tracked hull: treads on both flanks, bevelled body on top. */
function trackedHull(b: Build, w: number, h: number, d: number, treads: number): void {
  b.parts.add(treadedBlock(w, h, d, treads), TONES.hull, { y: h * 0.06 });
  b.parts.add(panelLineOverlay(w * 0.8, h * 0.06, d * 0.7, { lines: 2, thickness: 0.035 }), TONES.plate, {
    y: h * 1.0,
  });
}

/** Turret ring, housing and barrel(s) aimed down +Z. */
function turret(
  b: Build,
  y: number,
  r: number,
  h: number,
  barrel: number,
  len: number,
  barrels = 1,
): void {
  b.parts.add(hexPrism(r, h * 0.5, ), TONES.deep, { y });
  b.parts.add(taperedBox(r * 2, h * 0.5, r * 1.7, 0.75), TONES.hull, { y: y + h * 0.5 });
  for (let i = 0; i < barrels; i++) {
    const off = barrels === 1 ? 0 : (i / (barrels - 1) - 0.5) * r * 1.1;
    b.parts.add(chamferedCylinder(barrel, barrel * 1.1, len, 8), TONES.dark, {
      x: off,
      y: y + h * 0.75,
      z: r * 0.5,
      rx: Math.PI * 0.5,
    });
    b.parts.add(chamferedCylinder(barrel * 1.35, barrel * 1.35, barrel * 0.8, 8), TONES.accent, {
      x: off,
      y: y + h * 0.75,
      z: r * 0.5 + len * 0.92,
      rx: Math.PI * 0.5,
    });
  }
}

/** Glowing core, thruster bell or power node. */
function glowCore(b: Build, y: number, r: number, tone: PartTone = TONES.energy): void {
  b.parts.add(sphereLowPoly(r, 8, 6), tone, { y });
}

/** Canopy / sensor glass. */
function cockpit(b: Build, y: number, w: number, h: number, d: number): void {
  b.parts.add(taperedBox(w, h, d, 0.5), TONES.glass, { y });
}

/* ------------------------------------------------------------------ */
/* Protoss                                                             */
/* ------------------------------------------------------------------ */

const probe: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  torsoBox(b, h * 0.42, h * 0.3, r * 1.5, r * 1.3, 0.75, TONES.hull);
  b.parts.add(taperedBox(r * 1.2, h * 0.12, r * 1.1, 0.6), TONES.accent, { y: h * 0.7 });
  head(b, h * 0.76, r * 0.4, "gem");
  for (let i = 0; i < 4; i++) {
    const a = Math.PI * 0.25 + (i / 4) * Math.PI * 2;
    const cx = Math.cos(a) * r * 0.5;
    const cz = Math.sin(a) * r * 0.5;
    b.parts.add(taperedBox(r * 0.2, h * 0.5, r * 0.2, 0.4), TONES.plate, {
      x: cx,
      z: cz,
      rz: -cx * 0.9,
      rx: cz * 0.9,
    });
  }
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.28, r * 0.28, r * 0.8, 0.6), TONES.plate, {
      x: side * r * 0.7,
      y: h * 0.5,
      z: r * 0.3,
    });
    b.parts.add(chamferedCylinder(r * 0.16, r * 0.2, r * 0.4, 6), TONES.energy, {
      x: side * r * 0.7,
      y: h * 0.5,
      z: r * 0.7,
      rx: Math.PI * 0.5,
    });
  }
};

const zealot: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  legs(b, h * 0.44, r * 0.3, r * 0.34, r * 0.4);
  torsoBox(b, h * 0.42, h * 0.4, r * 1.35, r * 0.9, 0.78);
  torsoBox(b, h * 0.74, h * 0.1, r * 1.1, r * 0.8, 1, TONES.accent);
  head(b, h * 0.82, r * 0.36, "crest");
  pauldron(b, h * 0.78, r * 0.78, r * 0.42);
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.3, h * 0.3, r * 0.3, 0.6), TONES.plate, {
      x: side * r * 0.8,
      y: h * 0.45,
    });
    weapon(b, "blade", {
      x: side * r * 0.86,
      y: h * 0.5,
      z: r * 0.35,
      len: r * 1.15,
      r,
    });
  }
};

const stalker: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  legs(b, h * 0.5, r * 0.26, r * 0.26, r * 0.32);
  torsoBox(b, h * 0.48, h * 0.34, r * 0.9, r * 0.7, 0.7);
  head(b, h * 0.8, r * 0.32, "visor");
  pauldron(b, h * 0.76, r * 0.6, r * 0.3);
  b.parts.add(taperedBox(r * 0.7, h * 0.3, r * 0.5, 0.6), TONES.trim, { y: h * 0.36, z: -r * 0.35 });
  arms(b, h * 0.6, r * 0.5, h * 0.26, r * 0.22, r * 0.15);
  weapon(b, "rifle", { x: 0, y: h * 0.6, z: r * 0.35, len: r * 1.1, r });
};

const sentry: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    b.parts.add(taperedBox(r * 0.22, h * 0.62, r * 0.22, 0.5), TONES.dark, {
      x: cx * r * 0.4,
      z: cz * r * 0.4,
      rz: -cx * 0.35,
      rx: cz * 0.35,
    });
  }
  torsoBox(b, h * 0.6, h * 0.26, r * 1.1, r * 0.9, 0.8);
  glowCore(b, h * 0.86, r * 0.55);
  b.parts.add(torusSegment(r * 0.62, r * 0.1, Math.PI * 2, 14, 6), TONES.accent, { y: h * 0.84 });
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.18, r * 0.18, r * 1.1, 0.4), TONES.trim, {
      x: side * r * 0.5,
      y: h * 0.72,
      z: r * 0.5,
      rx: -0.3,
    });
  }
};

const highTemplar: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(cone(r * 1.15, h * 0.5, 8), TONES.dark);
  torsoBox(b, h * 0.44, h * 0.36, r * 1.1, r * 0.85, 0.85);
  torsoBox(b, h * 0.74, h * 0.08, r * 0.9, r * 0.7, 1, TONES.accent);
  head(b, h * 0.8, r * 0.34, "hood");
  arms(b, h * 0.62, r * 0.62, h * 0.24, r * 0.22, r * 0.1);
  weapon(b, "staff", { x: r * 0.6, y: h * 0.34, z: r * 0.3, len: h * 0.55, r });
  glowCore(b, h * 0.5, r * 0.3, TONES.energyDim);
};

const darkTemplar: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(cone(r * 1.1, h * 0.46, 8), TONES.deep);
  torsoBox(b, h * 0.4, h * 0.38, r * 1.05, r * 0.8, 0.85, TONES.dark);
  head(b, h * 0.78, r * 0.33, "hood");
  arms(b, h * 0.6, r * 0.58, h * 0.26, r * 0.2, r * 0.12, TONES.deep);
  weapon(b, "blade", { x: r * 0.6, y: h * 0.48, z: r * 0.3, len: r * 1.05, r });
  glowCore(b, h * 0.55, r * 0.42);
};

const adept: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  legs(b, h * 0.4, r * 0.3, r * 0.3, r * 0.36);
  torsoBox(b, h * 0.38, h * 0.32, r * 1.0, r * 0.75, 0.7);
  head(b, h * 0.7, r * 0.3, "visor");
  torsoBox(b, h * 0.66, h * 0.1, r * 0.8, r * 0.6, 1, TONES.accent);
  b.parts.add(taperedBox(r * 0.2, h * 0.34, r * 0.2, 0.6), TONES.plate, {
    x: r * 0.55,
    y: h * 0.36,
    rx: -0.4,
  });
  weapon(b, "blade", { x: r * 0.62, y: h * 0.52, z: r * 0.25, len: r * 0.85, r });
  glowCore(b, h * 0.44, r * 0.28, TONES.energyDim);
};

const archon: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  legs(b, h * 0.42, r * 0.34, r * 0.36, r * 0.44);
  torsoBox(b, h * 0.4, h * 0.34, r * 1.5, r * 1.1, 0.85, TONES.energyDim);
  glowCore(b, h * 0.58, r * 0.45);
  torsoBox(b, h * 0.72, h * 0.12, r * 1.1, r * 0.8, 0.8, TONES.trim);
  head(b, h * 0.8, r * 0.3, "gem");
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.44, h * 0.42, r * 0.44, 0.6), TONES.energyDim, {
      x: side * r * 0.85,
      y: h * 0.42,
    });
    b.parts.add(taperedBox(r * 0.5, r * 0.5, r * 0.5, 0.8), TONES.trim, {
      x: side * r * 0.9,
      y: h * 0.34,
    });
  }
};

const carrier: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(taperedBox(r * 1.1, h * 0.16, r * 1.7, 0.85), TONES.hull, { y: h * 0.2 });
  torsoBox(b, h * 0.34, h * 0.18, r * 0.7, r * 0.9, 0.8, TONES.plate);
  cockpit(b, h * 0.5, r * 0.5, h * 0.08, r * 0.4);
  b.parts.add(cone(r * 0.5, h * 0.22, 6, r * 0.16), TONES.hull, { y: h * 0.2, z: r * 0.95, rx: Math.PI * 0.5 });
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.3, h * 0.12, r * 1.3, 0.7), TONES.plate, {
      x: side * r * 0.7,
      y: h * 0.34,
    });
    for (const fwd of [0.45, -0.45]) {
      b.parts.add(chamferedCylinder(r * 0.26, r * 0.26, h * 0.06, 8), TONES.deep, {
        x: side * r * 0.7,
        y: h * 0.4,
        z: r * fwd,
        rx: Math.PI * 0.5,
      });
      b.parts.add(chamferedCylinder(r * 0.2, r * 0.2, h * 0.02, 8), TONES.energy, {
        x: side * r * 0.7,
        y: h * 0.4,
        z: r * fwd + h * 0.055,
        rx: Math.PI * 0.5,
      });
    }
  }
  nacelles(b, 2, r * 0.55, h * 0.3, -r * 0.75, r * 0.17, r * 0.5);
  glowCore(b, h * 0.42, r * 0.16, TONES.energyDim);
};

const phoenix: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(capsule(r * 0.42, h * 0.2, 4, 8), TONES.hull, { y: h * 0.32 });
  glowCore(b, h * 0.52, r * 0.5);
  wings(b, r * 1.05, r * 0.9, h * 0.46, 0, r * 0.2, 0.45);
  for (const side of [1, -1]) {
    b.parts.add(cone(r * 0.16, h * 0.4, 6, r * 0.05), TONES.energy, {
      x: side * r * 0.3,
      y: h * 0.34,
      z: -r * 0.4,
      rx: -0.5,
    });
    b.parts.add(taperedBox(r * 0.14, r * 0.14, r * 0.7, 0.6), TONES.trim, {
      x: side * r * 0.45,
      y: h * 0.3,
      z: -r * 0.15,
    });
  }
  b.parts.add(torusSegment(r * 0.5, r * 0.09, Math.PI * 2, 14, 6), TONES.accent, { y: h * 0.26 });
};

/* ------------------------------------------------------------------ */
/* Terran                                                              */
/* ------------------------------------------------------------------ */

const scv: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  trackedHull(b, r * 1.7, h * 0.3, r * 1.5, 4);
  torsoBox(b, h * 0.34, h * 0.34, r * 1.15, r * 1.1, 0.8);
  cockpit(b, h * 0.6, r * 0.8, h * 0.2, r * 0.8);
  b.parts.add(taperedBox(r * 0.3, h * 0.3, r * 0.3, 0.6), TONES.plate, { x: r * 0.6, y: h * 0.35, z: r * 0.3, rx: -0.7 });
  b.parts.add(cone(r * 0.3, r * 0.5, 6, r * 0.1), TONES.trim, { x: r * 0.6, y: h * 0.28, z: r * 0.65, rx: Math.PI * 0.5 });
  b.parts.add(chamferedCylinder(r * 0.16, r * 0.16, r * 0.5, 6), TONES.accent, { y: h * 0.5, z: -r * 0.6, rx: Math.PI * 0.5 });
};

const marine: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  legs(b, h * 0.46, r * 0.3, r * 0.32, r * 0.4);
  torsoBox(b, h * 0.42, h * 0.34, r * 1.4, r * 0.9, 0.82);
  torsoBox(b, h * 0.7, h * 0.1, r * 1.2, r * 0.85, 1, TONES.accent);
  b.parts.add(taperedBox(r * 0.7, h * 0.2, r * 0.4, 0.7), TONES.dark, { y: h * 0.46, z: -r * 0.5 });
  head(b, h * 0.78, r * 0.34, "helmet");
  arms(b, h * 0.6, r * 0.5, h * 0.24, r * 0.22, r * 0.2);
  weapon(b, "rifle", { x: 0, y: h * 0.6, z: r * 0.42, len: r * 0.95, r });
};

const firebat: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  legs(b, h * 0.44, r * 0.34, r * 0.44, r * 0.5);
  torsoBox(b, h * 0.4, h * 0.36, r * 1.6, r * 1.05, 0.85);
  head(b, h * 0.78, r * 0.32, "helmet");
  b.parts.add(taperedBox(r * 1.1, h * 0.24, r * 0.5, 0.7), TONES.deep, { y: h * 0.5, z: -r * 0.55 });
  for (const side of [1, -1]) {
    b.parts.add(chamferedCylinder(r * 0.18, r * 0.2, h * 0.16, 6), TONES.energy, {
      x: side * r * 0.34,
      y: h * 0.72,
      z: -r * 0.6,
    });
    weapon(b, "cannon", {
      x: side * r * 0.9,
      y: h * 0.76,
      z: r * 0.2,
      len: r * 0.7,
      r: r * 0.5,
    });
  }
  torsoBox(b, h * 0.72, h * 0.08, r * 1.2, r * 0.9, 1, TONES.accent);
};

const siegeTank: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  trackedHull(b, r * 1.9, h * 0.36, r * 1.6, 6);
  turret(b, h * 0.4, r * 0.6, h * 0.5, r * 0.1, r * 0.95);
  b.parts.add(panelLineOverlay(r * 1.1, h * 0.06, r * 0.9, { lines: 2, thickness: 0.03 }), TONES.plate, {
    y: h * 0.92,
  });
  b.parts.add(taperedBox(r * 0.4, h * 0.14, r * 0.4, 0.8), TONES.deep, { y: h * 0.5, z: -r * 0.5 });
};

const thor: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.3, h * 0.4, r * 0.35, 0.7), TONES.dark, {
      x: side * r * 0.42,
      rx: 0.35,
    });
    b.parts.add(taperedBox(r * 0.28, h * 0.36, r * 0.3, 0.6), TONES.plate, {
      x: side * r * 0.5,
      y: h * 0.3,
      rx: -0.5,
    });
    b.parts.add(taperedBox(r * 0.5, h * 0.1, r * 0.9, 0.9), TONES.deep, {
      x: side * r * 0.55,
      z: r * 0.15,
    });
  }
  torsoBox(b, h * 0.5, h * 0.3, r * 1.2, r * 0.95, 0.8);
  cockpit(b, h * 0.52, r * 0.5, h * 0.1, r * 0.5);
  torsoBox(b, h * 0.78, h * 0.1, r * 0.9, r * 0.7, 0.8, TONES.accent);
  weapon(b, "cannon", { x: r * 0.85, y: h * 0.52, z: r * 0.3, len: r * 0.9, r: r * 0.55 });
  b.parts.add(taperedBox(r * 0.4, r * 0.4, r * 0.5, 0.8), TONES.trim, { x: -r * 0.8, y: h * 0.4, z: r * 0.3 });
  b.parts.add(taperedBox(r * 0.2, h * 0.2, r * 0.2, 0.6), TONES.energy, { y: h * 0.9 });
};

const reaper: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  legs(b, h * 0.48, r * 0.26, r * 0.26, r * 0.34);
  torsoBox(b, h * 0.44, h * 0.32, r * 1.05, r * 0.7, 0.75);
  head(b, h * 0.78, r * 0.3, "visor");
  b.parts.add(taperedBox(r * 0.6, h * 0.2, r * 0.4, 0.7), TONES.deep, { y: h * 0.48, z: -r * 0.45 });
  for (const side of [1, -1]) {
    b.parts.add(chamferedCylinder(r * 0.13, r * 0.15, h * 0.1, 6), TONES.energy, {
      x: side * r * 0.24,
      y: h * 0.68,
      z: -r * 0.5,
    });
  }
  arms(b, h * 0.6, r * 0.42, h * 0.22, r * 0.18, r * 0.18);
  weapon(b, "shotgun", { x: 0, y: h * 0.6, z: r * 0.35, len: r * 0.8, r });
};

const ghost: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  legs(b, h * 0.48, r * 0.24, r * 0.24, r * 0.32);
  torsoBox(b, h * 0.44, h * 0.34, r * 0.95, r * 0.65, 0.7, TONES.deep);
  head(b, h * 0.8, r * 0.3, "hood");
  b.parts.add(taperedBox(r * 0.5, h * 0.22, r * 0.35, 0.6), TONES.dark, { y: h * 0.48, z: -r * 0.4 });
  arms(b, h * 0.6, r * 0.4, h * 0.22, r * 0.16, r * 0.2, TONES.dark);
  weapon(b, "rifle", { x: 0, y: h * 0.62, z: r * 0.3, len: r * 0.95, r: r * 0.85 });
  b.parts.add(taperedBox(r * 0.2, r * 0.2, r * 0.2, 1), TONES.energyDim, { y: h * 0.92, z: -r * 0.2 });
};

const battlecruiser: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(taperedBox(r * 0.9, h * 0.24, r * 1.8, 0.7), TONES.hull, { y: h * 0.18 });
  b.parts.add(cone(r * 0.6, h * 0.2, 6, r * 0.18), TONES.hull, { y: h * 0.2, z: r * 1.0, rx: Math.PI * 0.5 });
  torsoBox(b, h * 0.4, h * 0.22, r * 0.55, r * 0.7, 0.8, TONES.plate);
  cockpit(b, h * 0.6, r * 0.42, h * 0.08, r * 0.4);
  b.parts.add(taperedBox(r * 0.16, h * 0.16, r * 0.2, 0.4), TONES.accent, { y: h * 0.62, z: -r * 0.15 });
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.3, h * 0.14, r * 0.8, 0.6), TONES.plate, {
      x: side * r * 0.55,
      y: h * 0.3,
    });
    b.parts.add(taperedBox(r * 0.12, h * 0.2, r * 0.5, 0.4), TONES.deep, {
      x: side * r * 0.85,
      y: h * 0.22,
      z: -r * 0.2,
    });
  }
  nacelles(b, 2, r * 0.6, h * 0.28, -r * 0.85, r * 0.16, r * 0.42);
  wings(b, r * 0.5, r * 0.6, h * 0.3, r * 0.1, r * 0.5, 0.1);
};

const raven: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(capsule(r * 0.42, r * 0.5, 3, 8), TONES.hull, { y: h * 0.42, ry: Math.PI * 0.5 });
  cockpit(b, h * 0.5, r * 0.5, h * 0.14, r * 0.7);
  wings(b, r * 0.95, r * 0.7, h * 0.45, r * 0.1, r * 0.35, 0.2);
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.12, h * 0.3, r * 0.3, 0.4), TONES.plate, {
      x: side * r * 0.5,
      y: h * 0.3,
      z: -r * 0.35,
      rx: 0.3,
    });
    b.parts.add(chamferedCylinder(r * 0.12, r * 0.14, h * 0.12, 6), TONES.energy, {
      x: side * r * 0.3,
      y: h * 0.3,
      z: -r * 0.5,
      rx: -0.3,
    });
  }
  b.parts.add(chamferedCylinder(r * 0.24, r * 0.2, r * 0.3, 8), TONES.deep, { y: h * 0.22, z: r * 0.35 });
  b.parts.add(chamferedCylinder(r * 0.09, r * 0.09, r * 0.5, 6), TONES.accent, { y: h * 0.2, z: r * 0.5, rx: Math.PI * 0.5 });
};

const medic: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  legs(b, h * 0.46, r * 0.28, r * 0.3, r * 0.38);
  torsoBox(b, h * 0.42, h * 0.34, r * 1.25, r * 0.85, 0.82);
  head(b, h * 0.78, r * 0.32, "helmet");
  b.parts.add(taperedBox(r * 0.65, h * 0.22, r * 0.4, 0.8), TONES.trim, { y: h * 0.46, z: -r * 0.45 });
  for (const side of [1, -1]) {
    b.parts.add(chamferedCylinder(r * 0.14, r * 0.14, h * 0.16, 6), TONES.accent, {
      x: side * r * 0.22,
      y: h * 0.5,
      z: -r * 0.45,
    });
  }
  arms(b, h * 0.62, r * 0.46, h * 0.22, r * 0.2, r * 0.28);
  for (const side of [1, -1]) {
    b.parts.add(chamferedCylinder(r * 0.22, r * 0.26, r * 0.2, 8), TONES.energy, {
      x: side * r * 0.36,
      y: h * 0.64,
      z: r * 0.5,
      rx: Math.PI * 0.5,
    });
  }
};

/* ------------------------------------------------------------------ */
/* Zerg                                                                */
/* ------------------------------------------------------------------ */

const drone: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  carapace(b, h * 0.42, r * 0.85, h * 0.55);
  torsoBox(b, h * 0.34, h * 0.22, r * 0.9, r * 1.3, 0.6);
  head(b, h * 0.36, r * 0.3, "mandible");
  insectLegs(b, 4, r * 0.85, h * 0.45, h * 0.5, r * 0.16);
  for (const side of [1, -1]) {
    weapon(b, "claw", { x: side * r * 0.55, y: h * 0.3, z: r * 0.7, len: r * 0.5, r });
  }
  b.parts.add(cone(r * 0.2, r * 0.5, 5), TONES.trim, { y: h * 0.72, z: -r * 0.4, rx: -0.9 });
};

const zergling: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  carapace(b, h * 0.45, r * 0.95, h * 0.6, TONES.hull);
  b.parts.add(taperedBox(r * 0.8, h * 0.4, r * 0.9, 0.7), TONES.plate, { y: h * 0.28, z: r * 0.35 });
  head(b, h * 0.32, r * 0.34, "mandible");
  insectLegs(b, 4, r * 0.95, h * 0.45, h * 0.55, r * 0.14);
  for (const side of [1, -1]) {
    b.parts.add(cone(r * 0.12, r * 0.55, 4), TONES.trim, {
      x: side * r * 0.25,
      y: h * 0.62,
      z: -r * 0.7,
      rx: 0.9,
    });
  }
};

const hydralisk: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.24, h * 0.45, r * 0.28, 0.6), TONES.dark, {
      x: side * r * 0.34,
      rx: side * 0.0,
    });
    b.parts.add(taperedBox(r * 0.3, h * 0.12, r * 0.5, 0.8), TONES.deep, { x: side * r * 0.4, z: r * 0.1 });
  }
  carapace(b, h * 0.5, r * 0.7, h * 0.4, TONES.hull);
  torsoBox(b, h * 0.42, h * 0.3, r * 0.8, r * 1.1, 0.6, TONES.plate);
  head(b, h * 0.46, r * 0.3, "beak");
  for (const side of [1, -1]) {
    b.parts.add(cone(r * 0.16, r * 1.15, 5), TONES.energyDim, {
      x: side * r * 0.34,
      y: h * 0.6,
      z: r * 0.5,
      rx: -1.35,
    });
  }
  spines(b, 3, r * 0.5, h * 0.72, r * 0.35, r * 0.09, 771);
};

const ultralisk: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  insectLegs(b, 4, r * 0.9, h * 0.5, h * 0.55, r * 0.24);
  carapace(b, h * 0.52, r * 0.95, h * 0.5, TONES.hull);
  torsoBox(b, h * 0.4, h * 0.4, r * 0.9, r * 1.35, 0.75, TONES.plate);
  head(b, h * 0.4, r * 0.34, "mandible");
  for (const side of [1, -1]) {
    b.parts.add(cone(r * 0.22, r * 1.5, 6, r * 0.05), TONES.trim, {
      x: side * r * 0.45,
      y: h * 0.22,
      z: r * 0.8,
      rx: -1.3,
    });
  }
  spines(b, 5, r * 0.7, h * 0.72, r * 0.5, r * 0.13, 4242);
};

const queen: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.22, h * 0.42, r * 0.26, 0.6), TONES.dark, { x: side * r * 0.3, rx: 0.25 });
    b.parts.add(taperedBox(r * 0.3, h * 0.1, r * 0.5, 0.8), TONES.deep, { x: side * r * 0.35, z: r * 0.15 });
  }
  torsoBox(b, h * 0.44, h * 0.36, r * 0.7, r * 0.9, 0.65, TONES.hull);
  head(b, h * 0.78, r * 0.3, "crest");
  b.parts.add(sphereLowPoly(r * 0.42, 8, 5), TONES.energyDim, { y: h * 0.5, z: -r * 0.45 });
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.12, h * 0.34, r * 0.5, 0.4), TONES.plate, {
      x: side * r * 0.5,
      y: h * 0.5,
      z: -r * 0.3,
      rz: side * 0.6,
    });
  }
  b.parts.add(cone(r * 0.14, r * 0.6, 5), TONES.energy, { y: h * 0.34, z: r * 0.6, rx: -1.2 });
};

const roach: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  insectLegs(b, 6, r * 0.9, h * 0.45, h * 0.5, r * 0.12);
  carapace(b, h * 0.45, r * 0.95, h * 0.55, TONES.hull);
  head(b, h * 0.3, r * 0.26, "beak");
  b.parts.add(cone(r * 0.18, r * 0.55, 5), TONES.energyDim, { y: h * 0.36, z: r * 0.7, rx: -1.35 });
  spines(b, 4, r * 0.6, h * 0.62, r * 0.32, r * 0.1, 991);
};

const lurker: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  insectLegs(b, 4, r * 0.8, h * 0.4, h * 0.42, r * 0.16);
  carapace(b, h * 0.5, r * 0.85, h * 0.5, TONES.hull);
  b.parts.add(taperedBox(r * 0.7, h * 0.3, r * 0.8, 0.7), TONES.plate, { y: h * 0.25, z: r * 0.3 });
  for (const side of [1, -1]) {
    b.parts.add(cone(r * 0.2, r * 0.95, 5, r * 0.06), TONES.energyDim, {
      x: side * r * 0.42,
      y: h * 0.2,
      z: r * 0.6,
      rx: -1.45,
    });
  }
  spines(b, 4, r * 0.55, h * 0.62, r * 0.3, r * 0.1, 313);
};

const infestor: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(capsule(r * 0.55, h * 0.25, 4, 8), TONES.hull, { y: h * 0.35 });
  glowCore(b, h * 0.72, r * 0.45, TONES.energyDim);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    b.parts.add(taperedBox(r * 0.12, h * 0.45, r * 0.12, 0.3), TONES.dark, {
      x: Math.cos(a) * r * 0.3,
      y: h * 0.05,
      z: Math.sin(a) * r * 0.3,
      rz: -Math.cos(a) * 0.5,
      rx: Math.sin(a) * 0.5,
    });
  }
  b.parts.add(cone(r * 0.16, r * 0.7, 5), TONES.energy, { y: h * 0.55, z: r * 0.55, rx: -1.3 });
};

const corruptor: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(sphereLowPoly(r * 0.7, 8, 5), TONES.hull, { y: h * 0.45, sy: 0.55 });
  b.parts.add(taperedBox(r * 0.5, h * 0.2, r * 1.1, 0.6), TONES.plate, { y: h * 0.5, z: r * 0.35 });
  wings(b, r * 0.95, r * 0.8, h * 0.55, 0, r * 0.25, 0.3, TONES.hull);
  for (const side of [1, -1]) {
    b.parts.add(chamferedCylinder(r * 0.16, r * 0.18, r * 0.45, 6), TONES.energy, {
      x: side * r * 0.4,
      y: h * 0.42,
      z: -r * 0.6,
      rx: Math.PI * 0.5,
    });
  }
  b.parts.add(cone(r * 0.18, h * 0.5, 6, r * 0.05), TONES.energyDim, { y: h * 0.2, z: r * 0.3, rx: -0.3 });
};

const guardian: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(sphereLowPoly(r * 0.62, 8, 5), TONES.hull, { y: h * 0.6, sy: 0.7 });
  b.parts.add(taperedBox(r * 0.5, h * 0.2, r * 0.9, 0.6), TONES.plate, { y: h * 0.6, z: r * 0.4 });
  for (const side of [1, -1]) {
    b.parts.add(sphereLowPoly(r * 0.34, 6, 4), TONES.plate, { x: side * r * 0.7, y: h * 0.62, sz: 1.2 });
    b.parts.add(cone(r * 0.2, r * 0.8, 5, r * 0.06), TONES.trim, {
      x: side * r * 0.85,
      y: h * 0.5,
      z: r * 0.45,
      rx: -1.4,
    });
    b.parts.add(chamferedCylinder(r * 0.14, r * 0.16, r * 0.4, 6), TONES.energy, {
      x: side * r * 0.3,
      y: h * 0.55,
      z: -r * 0.5,
      rx: Math.PI * 0.5,
    });
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    b.parts.add(cone(r * 0.12, h * 0.35, 5, r * 0.04), TONES.energyDim, {
      x: Math.cos(a) * r * 0.35,
      y: h * 0.3,
      z: Math.sin(a) * r * 0.35,
      rx: Math.sin(a) * 0.6,
      rz: -Math.cos(a) * 0.6,
    });
  }
  spines(b, 3, r * 0.45, h * 0.85, r * 0.28, r * 0.1, 55);
};

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

const UNIT_BUILDERS: Record<string, UnitBuilder> = {
  // Protoss
  probe,
  zealot,
  stalker,
  sentry,
  high_templar: highTemplar,
  dark_templar: darkTemplar,
  adept,
  archon,
  carrier,
  phoenix,
  // Terran
  scv,
  marine,
  firebat,
  siege_tank: siegeTank,
  thor,
  reaper,
  ghost,
  battlecruiser: battlecruiser,
  raven,
  medic,
  // Zerg
  drone,
  zergling,
  hydralisk,
  ultralisk,
  queen,
  roach,
  lurker,
  infestor,
  corruptor,
  guardian,
};

/** How far a hovering hull floats above its shadow decal, in metres. */
export function airHoverLift(height: number): number {
  return Math.min(0.45, Math.max(0.12, height * 0.14));
}

/**
 * Builds the unit for `typeKey`. Building keys are delegated to
 * `buildingGeometry`, so this never throws for any of the 57 roster keys;
 * an unknown key is a hard error, because silently rendering a placeholder
 * would hide a data/roster mismatch.
 */
export function unitGeometry(typeKey: string): THREE.BufferGeometry {
  const def = entityDef(typeKey);
  if (def.kind === "building") return buildingGeometry(typeKey);
  return assemble(def);
}

function assemble(def: UnitDef): THREE.BufferGeometry {
  const builder = UNIT_BUILDERS[def.key];
  if (!builder) throw new Error(`unitGeometry(): no builder for roster unit "${def.key}"`);
  const build: Build = {
    def,
    key: def.key,
    race: raceOfEntity(def.key),
    radius: def.size.radius,
    height: def.size.height,
    air: def.movement === "air",
    parts: new PartList("body"),
  };
  builder(build);
  const body = build.parts.merge();
  fitFootprint(body, def.size.radius, def.size.height);
  if (!build.air) return body;
  body.translate(0, airHoverLift(def.size.height), 0);
  return withShadowDecal(body, def.size.radius);
}

/** Flat dark disc on the ground under a hovering hull. */
function withShadowDecal(body: THREE.BufferGeometry, radius: number): THREE.BufferGeometry {
  const decal = chamferedCylinder(radius * 1.05, radius * 1.05, 0.02, 14);
  decal.translate(0, 0.01, 0);
  setPartColor(decal, { r: 0.12, g: 0.12, b: 0.14, glow: 0 });
  return mergeGroups([body, decal]);
}

/* ------------------------------------------------------------------ */
/* Self-check                                                          */
/* ------------------------------------------------------------------ */

export interface GeometryCheck {
  key: string;
  kind: "unit" | "building";
  ok: boolean;
  reason: string;
  triangles: number;
  radius: number;
  height: number;
}

/**
 * Walks every key in the roster and rebuilds its geometry, checking that it
 * is non-empty, coloured, base-centred and inside the collision footprint.
 * Development aid: call it from a test or a boot-time assert, never per frame.
 */
export function selfCheckGeometryCoverage(): GeometryCheck[] {
  const results: GeometryCheck[] = [];
  for (const key of Object.keys(GAME.units)) {
    const def = entityDef(key);
    const radius = def.size.radius;
    const height = def.size.height;
    let geometry: THREE.BufferGeometry | null = null;
    let reason = "ok";
    let triangles = 0;
    try {
      geometry = unitGeometry(key);
      triangles = (geometry.getAttribute("position").count / 3) | 0;
      const position = geometry.getAttribute("position");
      const colour = geometry.getAttribute("color");
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      if (triangles === 0) reason = "empty geometry";
      else if (position.count !== colour.count) reason = "colour attribute missing";
      else if (!box) reason = "no bounding box";
      else if (box.min.y < -0.02) reason = `origin below ground (${box.min.y.toFixed(3)})`;
      else if (Math.max(box.max.x, -box.min.x, box.max.z, -box.min.z) > radius * 1.13) {
        reason = `footprint exceeds collision radius ${radius}`;
      } else if (box.max.y > height * 1.06) reason = `taller than roster height ${height}`;
      else if (!geometry.getAttribute("uv")) reason = "uv attribute missing";
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    } finally {
      geometry?.dispose();
    }
    results.push({
      key,
      kind: def.kind,
      ok: reason === "ok",
      reason,
      triangles,
      radius,
      height,
    });
  }
  return results;
}

/** Throws on the first roster key whose geometry fails the self-check. */
export function assertGeometryCoverage(): void {
  for (const check of selfCheckGeometryCoverage()) {
    if (!check.ok) {
      throw new Error(`assertGeometryCoverage(): ${check.key} — ${check.reason}`);
    }
  }
}

/** Greebled detail count helper shared with the building builders. */
export function detailBudget(radius: number, height: number): { count: number; scale: number } {
  const area = radius * height;
  return { count: Math.round(Math.min(26, Math.max(3, area * 2.2))), scale: Math.min(0.5, Math.max(0.1, radius * 0.16)) };
}

/** Exposed so callers can greeble a hull without importing the toolkit. */
export { greeble };
