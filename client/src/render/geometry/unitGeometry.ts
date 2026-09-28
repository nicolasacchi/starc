/**
 * Unit geometry — every mobile entity in the roster, generated in code.
 *
 * 100% procedural: no model, mesh or image file is imported. Each unit is
 * assembled from the primitives in `./shapes` into one merged, vertex-coloured
 * BufferGeometry, tuned for silhouette-first readability at RTS zoom: a
 * Marine is a compact humanoid with a rifle, a Siege Tank is a hull + turret +
 * barrel, a Zergling is a low quadruped, a Battlecruiser is a big flying hull.
 * Nothing about the shape is hard-coded from a stat — the footprint comes from
 * `size.radius` / `size.height` in shared/game-data.json, and
 * `movement === "air"` decides whether the model hovers and gets a shadow
 * decal.
 *
 * Conventions (enforced by `assemble` and `checkGeometry`):
 *  - y = 0 is the ground contact plane: a ground unit's base sits on it and
 *    an air hull's base sits exactly one `airHoverLift` above it;
 *  - the model faces +Z;
 *  - horizontal extent stays inside the collision radius and the silhouette
 *    tops out at the roster height, so what you see is what the server blocks.
 *
 * `unitGeometry` hands back the shared, reference-counted buffer from
 * `geometryCache` (ask once per entity type; release when done), so a hundred
 * Marines are one buffer. `buildAnyGeometry` is the uncached builder, used by
 * the self-check and by anything that wants a throwaway copy.
 *
 * This module and `buildingGeometry.ts` reference each other: each is the
 * other's fallback for a key of the wrong kind, so neither entry point throws
 * for any of the 57 roster keys. They only call each other at build time,
 * after both modules have finished evaluating.
 */
import * as THREE from "three";
import { GAME, entityDef } from "@shared/gameData";
import type { EntityDef, UnitDef } from "@shared/protocol";
import { TONES } from "@render/materials/palette";
import {
  PartList,
  capsule,
  chamferedCylinder,
  cone,
  fitFootprint,
  hexPrism,
  mulberry32,
  octahedron,
  panelLineOverlay,
  sphereLowPoly,
  taperedBox,
  torusSegment,
  treadedBlock,
  truncatedPyramid,
  wingShape,
} from "./shapes";
import type { PartTone } from "./shapes";
import { buildBuildingGeometry } from "./buildingGeometry";
import { geometryCache } from "./geometryCache";

/** Horns, spines and gun muzzles that point forward and slightly up. */
const FORWARD_TILT = 1.27;

interface Build {
  def: UnitDef;
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
    b.parts.add(taperedBox(width * 1.12, top - thigh * 0.9, depth * 1.08, 0.9), TONES.plate, {
      x: side * spread * 0.94,
      y: thigh * 0.9,
    });
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

/**
 * Shoulders and arms hanging from `shoulderY`, angled forward when `forward`
 * is set so the model reads as holding something out in front.
 */
function arms(
  b: Build,
  shoulderY: number,
  span: number,
  length: number,
  width: number,
  forward = 0,
  tone: PartTone = TONES.plate,
): void {
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(width, length, width, 0.8), tone, {
      x: side * span,
      y: shoulderY - length,
      z: forward,
      rx: forward > 0 ? 0.5 : 0.08,
    });
    b.parts.add(taperedBox(width * 0.95, length * 0.5, width * 0.95, 0.9), TONES.dark, {
      x: side * span * 1.05,
      y: shoulderY - length * 1.5,
      z: forward * 1.6,
    });
  }
}

type WeaponStyle = "rifle" | "shotgun" | "cannon" | "blade" | "staff" | "claw" | "none";

/**
 * Mounts a weapon at (x, y, z) pointing down +Z. `len` is the total forward
 * reach, so callers can keep barrels inside the collision radius.
 */
function weapon(
  b: Build,
  style: WeaponStyle,
  o: { x: number; y: number; z: number; len: number; r: number },
): void {
  switch (style) {
    case "rifle":
      b.parts.add(taperedBox(o.r * 1.5, o.r * 1.5, o.len * 0.55, 0.9), TONES.deep, { x: o.x, y: o.y, z: o.z });
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
      b.parts.add(taperedBox(o.r * 1.8, o.r * 1.5, o.len * 0.5, 0.9), TONES.deep, { x: o.x, y: o.y, z: o.z });
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
      b.parts.add(chamferedCylinder(o.r * 0.7, o.r * 0.8, o.len * 0.75, 8), TONES.dark, {
        x: o.x,
        y: o.y,
        z: o.z + o.len * 0.35,
        rx: Math.PI * 0.5,
      });
      b.parts.add(chamferedCylinder(o.r * 1.35, o.r * 1.35, o.r * 0.7, 8), TONES.accent, {
        x: o.x,
        y: o.y,
        z: o.z + o.len,
        rx: Math.PI * 0.5,
      });
      break;
    case "blade":
      b.parts.add(taperedBox(o.r * 0.45, o.r * 0.9, o.len, 0.25), TONES.energy, {
        x: o.x,
        y: o.y,
        z: o.z,
      });
      b.parts.add(taperedBox(o.r * 0.7, o.r * 0.7, o.r * 0.7, 1), TONES.trim, { x: o.x, y: o.y, z: o.z });
      break;
    case "staff":
      b.parts.add(chamferedCylinder(o.r * 0.28, o.r * 0.28, o.len * 0.9, 6), TONES.deep, {
        x: o.x,
        y: o.y,
        z: o.z,
      });
      b.parts.add(sphereLowPoly(o.r * 0.85, 8, 5), TONES.energy, {
        x: o.x,
        y: o.y + o.len * 0.9,
        z: o.z,
      });
      break;
    case "claw":
      for (const side of [1, -1]) {
        b.parts.add(cone(o.r * 0.4, o.len, 5), TONES.trim, {
          x: o.x + side * o.r * 0.6,
          y: o.y,
          z: o.z,
          rx: FORWARD_TILT,
          ry: side * 0.2,
        });
      }
      break;
    case "none":
      break;
  }
}

/** Shoulder pads — the angular Protoss read. */
function pauldron(b: Build, y: number, x: number, size: number): void {
  for (const side of [1, -1]) {
    b.parts.add(
      truncatedPyramid(size * 1.2, size * 1.6, size * 0.5, size * 0.9, size * 0.9),
      TONES.accent,
      { x: side * x, y },
    );
  }
}

/**
 * Ring of jointed insect legs. Each leg is one segment running from the
 * ground at `ring` up to the body at height `y`, so the horizontal footprint
 * is exactly `ring` whatever the unit's height.
 */
function insectLegs(b: Build, count: number, ring: number, y: number, w: number): void {
  const rise = Math.max(y, 1e-3);
  const run = ring * 0.5;
  const length = Math.hypot(run, rise);
  const tilt = Math.atan2(run, rise);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.PI * 0.25;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    b.parts.add(taperedBox(w, length, w, 0.45), TONES.dark, {
      x: cx * ring,
      z: cz * ring,
      rx: cz * tilt,
      rz: -cx * tilt,
    });
    b.parts.add(taperedBox(w * 1.2, w * 0.8, w * 1.2, 0.8), TONES.deep, {
      x: cx * ring,
      z: cz * ring,
    });
  }
}

/** Zerg carapace dome. */
function carapace(b: Build, y: number, r: number, h: number, tone: PartTone = TONES.hull): void {
  b.parts.add(sphereLowPoly(r, 8, 5), tone, { y, sy: h / (r * 2) });
}

/** Ring of chitin spikes around a carapace — the Zerg silhouette. */
function spines(b: Build, count: number, ring: number, y: number, len: number, w: number, seed: number): void {
  const rnd = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    b.parts.add(cone(w, len * (0.65 + rnd() * 0.6), 5), TONES.trim, {
      x: cx * ring,
      y,
      z: cz * ring,
      rx: cz * 0.45,
      rz: -cx * 0.45,
    });
  }
}

function wings(b: Build, span: number, chord: number, y: number, x: number, tilt: number, tone: PartTone = TONES.plate): void {
  for (const side of [1, -1]) {
    b.parts.add(wingShape(span, chord, chord * 0.16), tone, {
      x: side * x,
      y,
      ry: side > 0 ? -0.25 : Math.PI + 0.25,
      rz: side * tilt,
    });
  }
}

/**
 * Engine pods. `z` is the rear face, so pods hang off the back of a hull and
 * their hot intakes face away from the nose.
 */
function nacelles(b: Build, count: number, spread: number, y: number, z: number, r: number, len: number): void {
  for (let i = 0; i < count; i++) {
    if (count > 2 && i % 2 === 1) continue;
    const x = count === 1 ? 0 : (i % 2 === 0 ? -spread : spread);
    b.parts.add(taperedBox(r * 2.4, r * 2, len, 0.7), TONES.plate, { x, y, z: z + len });
    b.parts.add(chamferedCylinder(r * 0.9, r * 0.75, r * 0.5, 8), TONES.energy, {
      x,
      y: y + r * 0.75,
      z: z + len * 0.15,
    });
  }
}

/** Tracked hull: treads on both flanks, bevelled body on top. */
function trackedHull(b: Build, w: number, h: number, d: number, treads: number): void {
  b.parts.add(treadedBlock(w, h, d, treads), TONES.hull, { y: h * 0.08 });
  b.parts.add(panelLineOverlay(w * 0.8, 0, d * 0.7, { lines: 2, thickness: 0.035 }), TONES.plate, { y: h });
}

/** Turret ring, housing and barrel(s) aimed down +Z. */
function turret(b: Build, y: number, r: number, h: number, barrel: number, len: number, barrels = 1): void {
  b.parts.add(hexPrism(r, h * 0.5), TONES.deep, { y });
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
  torsoBox(b, h * 0.42, h * 0.3, r * 1.5, r * 1.3, 0.75);
  torsoBox(b, h * 0.7, h * 0.12, r * 1.2, r * 1.1, 0.6, TONES.accent);
  head(b, h * 0.6, r * 0.4, "gem");
  for (let i = 0; i < 4; i++) {
    const a = Math.PI * 0.25 + (i / 4) * Math.PI * 2;
    const cx = Math.cos(a) * r * 0.45;
    const cz = Math.sin(a) * r * 0.45;
    b.parts.add(taperedBox(r * 0.18, h * 0.5, r * 0.18, 0.4), TONES.plate, {
      x: cx,
      z: cz,
      rz: -Math.cos(a) * 0.3,
      rx: Math.sin(a) * 0.3,
    });
  }
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.26, r * 0.26, r * 0.6, 0.6), TONES.plate, {
      x: side * r * 0.62,
      y: h * 0.5,
      z: r * 0.25,
    });
    b.parts.add(chamferedCylinder(r * 0.14, r * 0.18, r * 0.35, 6), TONES.energy, {
      x: side * r * 0.62,
      y: h * 0.5,
      z: r * 0.5,
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
  head(b, h * 0.82, r * 0.34, "crest");
  pauldron(b, h * 0.78, r * 0.72, r * 0.4);
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.28, h * 0.3, r * 0.28, 0.6), TONES.plate, {
      x: side * r * 0.72,
      y: h * 0.45,
    });
    weapon(b, "blade", { x: side * r * 0.8, y: h * 0.5, z: r * 0.3, len: r * 1.1, r });
  }
};

const stalker: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  legs(b, h * 0.5, r * 0.26, r * 0.26, r * 0.32);
  torsoBox(b, h * 0.48, h * 0.34, r * 0.9, r * 0.7, 0.7);
  head(b, h * 0.8, r * 0.3, "visor");
  pauldron(b, h * 0.76, r * 0.56, r * 0.28);
  b.parts.add(taperedBox(r * 0.66, h * 0.3, r * 0.46, 0.6), TONES.trim, { y: h * 0.36, z: -r * 0.32 });
  arms(b, h * 0.74, r * 0.48, h * 0.24, r * 0.2, r * 0.12);
  weapon(b, "rifle", { x: 0, y: h * 0.58, z: r * 0.32, len: r * 0.55, r });
};

const sentry: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  insectLegs(b, 3, r * 0.6, h * 0.55, r * 0.14);
  torsoBox(b, h * 0.6, h * 0.26, r * 1.1, r * 0.9, 0.8);
  glowCore(b, h * 0.84, r * 0.5);
  b.parts.add(torusSegment(r * 0.55, r * 0.1, Math.PI * 2, 14, 6), TONES.accent, { y: h * 0.7 });
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.16, r * 0.16, r * 0.9, 0.4), TONES.trim, {
      x: side * r * 0.45,
      y: h * 0.66,
      z: r * 0.35,
      rx: -0.3,
    });
  }
};

const highTemplar: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(cone(r * 1.05, h * 0.5, 8), TONES.dark);
  torsoBox(b, h * 0.44, h * 0.36, r * 1.05, r * 0.8, 0.85);
  torsoBox(b, h * 0.74, h * 0.08, r * 0.85, r * 0.66, 1, TONES.accent);
  head(b, h * 0.78, r * 0.32, "hood");
  arms(b, h * 0.74, r * 0.56, h * 0.22, r * 0.2, r * 0.08);
  weapon(b, "staff", { x: r * 0.55, y: h * 0.2, z: r * 0.3, len: h * 0.5, r });
  glowCore(b, h * 0.46, r * 0.26, TONES.energyDim);
};

const darkTemplar: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(cone(r * 1.0, h * 0.46, 8), TONES.deep);
  torsoBox(b, h * 0.4, h * 0.38, r * 1.0, r * 0.76, 0.85, TONES.dark);
  head(b, h * 0.76, r * 0.31, "hood");
  arms(b, h * 0.72, r * 0.52, h * 0.24, r * 0.18, r * 0.1, TONES.deep);
  weapon(b, "blade", { x: r * 0.55, y: h * 0.44, z: r * 0.3, len: r * 0.95, r });
  glowCore(b, h * 0.52, r * 0.36);
};

const adept: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  legs(b, h * 0.4, r * 0.3, r * 0.3, r * 0.36);
  torsoBox(b, h * 0.38, h * 0.32, r * 0.98, r * 0.72, 0.7);
  torsoBox(b, h * 0.66, h * 0.1, r * 0.78, r * 0.58, 1, TONES.accent);
  head(b, h * 0.7, r * 0.28, "visor");
  b.parts.add(taperedBox(r * 0.2, h * 0.32, r * 0.2, 0.6), TONES.plate, {
    x: r * 0.5,
    y: h * 0.3,
    rx: -0.4,
  });
  weapon(b, "blade", { x: r * 0.56, y: h * 0.46, z: r * 0.24, len: r * 0.8, r });
  glowCore(b, h * 0.4, r * 0.24, TONES.energyDim);
};

const archon: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  legs(b, h * 0.42, r * 0.32, r * 0.34, r * 0.42);
  torsoBox(b, h * 0.4, h * 0.34, r * 1.5, r * 1.1, 0.85, TONES.energyDim);
  torsoBox(b, h * 0.72, h * 0.12, r * 1.1, r * 0.8, 0.8, TONES.trim);
  glowCore(b, h * 0.56, r * 0.42);
  head(b, h * 0.78, r * 0.28, "gem");
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.42, h * 0.42, r * 0.42, 0.6), TONES.energyDim, {
      x: side * r * 0.8,
      y: h * 0.42,
    });
    b.parts.add(taperedBox(r * 0.5, r * 0.5, r * 0.5, 0.8), TONES.trim, {
      x: side * r * 0.84,
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
  b.parts.add(cone(r * 0.5, h * 0.1, 6, r * 0.16), TONES.hull, {
    y: h * 0.2,
    z: r * 0.6,
    rx: Math.PI * 0.5,
  });
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.3, h * 0.12, r * 1.3, 0.7), TONES.plate, {
      x: side * r * 0.68,
      y: h * 0.34,
    });
    for (const fwd of [0.45, -0.45]) {
      b.parts.add(chamferedCylinder(r * 0.24, r * 0.24, h * 0.05, 8), TONES.deep, {
        x: side * r * 0.68,
        y: h * 0.4,
        z: r * fwd,
        rx: Math.PI * 0.5,
      });
      b.parts.add(chamferedCylinder(r * 0.18, r * 0.18, h * 0.02, 8), TONES.energy, {
        x: side * r * 0.68,
        y: h * 0.4,
        z: r * fwd + h * 0.05,
        rx: Math.PI * 0.5,
      });
    }
  }
  nacelles(b, 2, r * 0.5, h * 0.3, -r * 0.95, r * 0.16, r * 0.4);
  glowCore(b, h * 0.42, r * 0.14, TONES.energyDim);
};

const phoenix: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(capsule(r * 0.4, h * 0.18, 4, 8), TONES.hull, { y: h * 0.3 });
  glowCore(b, h * 0.5, r * 0.44);
  wings(b, r * 0.8, r * 0.8, h * 0.46, r * 0.15, 0.45);
  for (const side of [1, -1]) {
    b.parts.add(cone(r * 0.14, h * 0.34, 6, r * 0.05), TONES.energy, {
      x: side * r * 0.28,
      y: h * 0.3,
      z: -r * 0.3,
      rx: -0.5,
    });
    b.parts.add(taperedBox(r * 0.12, r * 0.12, r * 0.6, 0.6), TONES.trim, {
      x: side * r * 0.42,
      y: h * 0.28,
      z: -r * 0.1,
    });
  }
  b.parts.add(torusSegment(r * 0.45, r * 0.08, Math.PI * 2, 14, 6), TONES.accent, { y: h * 0.22 });
};

/* ------------------------------------------------------------------ */
/* Terran                                                              */
/* ------------------------------------------------------------------ */

const scv: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  trackedHull(b, r * 1.7, h * 0.3, r * 1.5, 4);
  torsoBox(b, h * 0.34, h * 0.34, r * 1.1, r * 1.05, 0.8);
  cockpit(b, h * 0.62, r * 0.76, h * 0.18, r * 0.76);
  b.parts.add(taperedBox(r * 0.26, h * 0.28, r * 0.26, 0.6), TONES.plate, {
    x: r * 0.55,
    y: h * 0.36,
    z: r * 0.28,
    rx: -0.7,
  });
  b.parts.add(cone(r * 0.26, r * 0.4, 6, r * 0.08), TONES.trim, {
    x: r * 0.55,
    y: h * 0.3,
    z: r * 0.5,
    rx: FORWARD_TILT,
  });
  b.parts.add(chamferedCylinder(r * 0.14, r * 0.14, r * 0.4, 6), TONES.accent, {
    y: h * 0.5,
    z: -r * 0.55,
    rx: Math.PI * 0.5,
  });
};

const marine: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  legs(b, h * 0.46, r * 0.3, r * 0.32, r * 0.4);
  torsoBox(b, h * 0.42, h * 0.34, r * 1.4, r * 0.9, 0.82);
  torsoBox(b, h * 0.7, h * 0.1, r * 1.2, r * 0.85, 1, TONES.accent);
  b.parts.add(taperedBox(r * 0.66, h * 0.2, r * 0.36, 0.7), TONES.dark, { y: h * 0.46, z: -r * 0.48 });
  head(b, h * 0.76, r * 0.32, "helmet");
  arms(b, h * 0.72, r * 0.48, h * 0.22, r * 0.2, r * 0.14);
  weapon(b, "rifle", { x: 0, y: h * 0.62, z: r * 0.3, len: r * 0.5, r });
};

const firebat: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  legs(b, h * 0.44, r * 0.32, r * 0.42, r * 0.48);
  torsoBox(b, h * 0.4, h * 0.36, r * 1.6, r * 1.05, 0.85);
  torsoBox(b, h * 0.72, h * 0.08, r * 1.2, r * 0.9, 1, TONES.accent);
  head(b, h * 0.76, r * 0.3, "helmet");
  b.parts.add(taperedBox(r * 1.05, h * 0.24, r * 0.46, 0.7), TONES.deep, { y: h * 0.5, z: -r * 0.52 });
  for (const side of [1, -1]) {
    b.parts.add(chamferedCylinder(r * 0.16, r * 0.18, h * 0.14, 6), TONES.energy, {
      x: side * r * 0.3,
      y: h * 0.74,
      z: -r * 0.56,
    });
    weapon(b, "cannon", {
      x: side * r * 0.7,
      y: h * 0.76,
      z: r * 0.15,
      len: r * 0.35,
      r: r * 0.35,
    });
  }
};

const siegeTank: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  trackedHull(b, r * 1.9, h * 0.36, r * 1.6, 6);
  turret(b, h * 0.4, r * 0.6, h * 0.5, r * 0.1, r * 0.7);
  b.parts.add(panelLineOverlay(r * 1.05, 0, r * 0.85, { lines: 2, thickness: 0.03 }), TONES.plate, {
    y: h * 0.66,
  });
  b.parts.add(taperedBox(r * 0.36, h * 0.14, r * 0.36, 0.8), TONES.deep, { y: h * 0.52, z: -r * 0.45 });
};

const thor: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.28, h * 0.4, r * 0.32, 0.7), TONES.dark, { x: side * r * 0.4, rx: 0.35 });
    b.parts.add(taperedBox(r * 0.26, h * 0.34, r * 0.28, 0.6), TONES.plate, {
      x: side * r * 0.46,
      y: h * 0.3,
      rx: -0.5,
    });
    b.parts.add(taperedBox(r * 0.46, h * 0.1, r * 0.8, 0.9), TONES.deep, {
      x: side * r * 0.5,
      z: r * 0.12,
    });
  }
  torsoBox(b, h * 0.5, h * 0.3, r * 1.15, r * 0.9, 0.8);
  torsoBox(b, h * 0.78, h * 0.1, r * 0.85, r * 0.66, 0.8, TONES.accent);
  cockpit(b, h * 0.52, r * 0.46, h * 0.1, r * 0.46);
  weapon(b, "cannon", { x: r * 0.6, y: h * 0.52, z: r * 0.28, len: r * 0.45, r: r * 0.32 });
  b.parts.add(taperedBox(r * 0.36, r * 0.36, r * 0.45, 0.8), TONES.trim, {
    x: -r * 0.72,
    y: h * 0.38,
    z: r * 0.28,
  });
  b.parts.add(taperedBox(r * 0.16, h * 0.16, r * 0.16, 0.6), TONES.energy, { y: h * 0.88 });
};

const reaper: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  legs(b, h * 0.48, r * 0.26, r * 0.26, r * 0.34);
  torsoBox(b, h * 0.44, h * 0.32, r * 1.0, r * 0.68, 0.75);
  head(b, h * 0.76, r * 0.28, "visor");
  b.parts.add(taperedBox(r * 0.55, h * 0.2, r * 0.36, 0.7), TONES.deep, { y: h * 0.48, z: -r * 0.42 });
  for (const side of [1, -1]) {
    b.parts.add(chamferedCylinder(r * 0.12, r * 0.14, h * 0.09, 6), TONES.energy, {
      x: side * r * 0.22,
      y: h * 0.68,
      z: -r * 0.46,
    });
  }
  arms(b, h * 0.72, r * 0.4, h * 0.2, r * 0.16, r * 0.12);
  weapon(b, "shotgun", { x: 0, y: h * 0.62, z: r * 0.25, len: r * 0.6, r });
};

const ghost: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  legs(b, h * 0.48, r * 0.24, r * 0.24, r * 0.32);
  torsoBox(b, h * 0.44, h * 0.34, r * 0.92, r * 0.62, 0.7, TONES.deep);
  head(b, h * 0.78, r * 0.28, "hood");
  b.parts.add(taperedBox(r * 0.46, h * 0.22, r * 0.32, 0.6), TONES.dark, { y: h * 0.48, z: -r * 0.36 });
  arms(b, h * 0.74, r * 0.38, h * 0.2, r * 0.15, r * 0.12, TONES.dark);
  weapon(b, "rifle", { x: 0, y: h * 0.62, z: r * 0.25, len: r * 0.5, r: r * 0.85 });
  b.parts.add(taperedBox(r * 0.16, r * 0.16, r * 0.16, 1), TONES.energyDim, { y: h * 0.9, z: -r * 0.18 });
};

const battlecruiser: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(taperedBox(r * 0.9, h * 0.24, r * 1.8, 0.7), TONES.hull, { y: h * 0.18 });
  b.parts.add(cone(r * 0.55, h * 0.15, 6, r * 0.16), TONES.hull, {
    y: h * 0.2,
    z: r * 0.6,
    rx: FORWARD_TILT,
  });
  torsoBox(b, h * 0.4, h * 0.22, r * 0.55, r * 0.7, 0.8, TONES.plate);
  cockpit(b, h * 0.6, r * 0.4, h * 0.08, r * 0.38);
  b.parts.add(taperedBox(r * 0.14, h * 0.16, r * 0.18, 0.4), TONES.accent, { y: h * 0.62, z: -r * 0.12 });
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.28, h * 0.14, r * 0.8, 0.6), TONES.plate, {
      x: side * r * 0.5,
      y: h * 0.3,
    });
    b.parts.add(taperedBox(r * 0.12, h * 0.2, r * 0.5, 0.4), TONES.deep, {
      x: side * r * 0.8,
      y: h * 0.22,
      z: -r * 0.2,
    });
  }
  nacelles(b, 2, r * 0.55, h * 0.28, -r * 0.95, r * 0.15, r * 0.3);
  wings(b, r * 0.45, r * 0.5, h * 0.3, r * 0.45, 0.1);
};

const raven: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(capsule(r * 0.4, r * 0.5, 3, 8), TONES.hull, {
    y: h * 0.42,
    z: -r * 0.5,
    rx: Math.PI * 0.5,
  });
  cockpit(b, h * 0.46, r * 0.46, h * 0.13, r * 0.62);
  wings(b, r * 0.6, r * 0.6, h * 0.42, r * 0.28, 0.2);
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.1, h * 0.26, r * 0.26, 0.4), TONES.plate, {
      x: side * r * 0.45,
      y: h * 0.32,
      z: -r * 0.28,
      rx: 0.3,
    });
    b.parts.add(chamferedCylinder(r * 0.1, r * 0.12, h * 0.1, 6), TONES.energy, {
      x: side * r * 0.26,
      y: h * 0.3,
      z: -r * 0.42,
      rx: -0.3,
    });
  }
  b.parts.add(chamferedCylinder(r * 0.2, r * 0.17, r * 0.26, 8), TONES.deep, { y: h * 0.24, z: r * 0.3 });
  b.parts.add(chamferedCylinder(r * 0.08, r * 0.08, r * 0.4, 6), TONES.accent, {
    y: h * 0.22,
    z: r * 0.42,
    rx: FORWARD_TILT,
  });
};

const medic: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  legs(b, h * 0.46, r * 0.28, r * 0.3, r * 0.38);
  torsoBox(b, h * 0.42, h * 0.34, r * 1.25, r * 0.85, 0.82);
  head(b, h * 0.76, r * 0.3, "helmet");
  b.parts.add(taperedBox(r * 0.6, h * 0.22, r * 0.36, 0.8), TONES.trim, { y: h * 0.46, z: -r * 0.42 });
  for (const side of [1, -1]) {
    b.parts.add(chamferedCylinder(r * 0.12, r * 0.12, h * 0.14, 6), TONES.accent, {
      x: side * r * 0.2,
      y: h * 0.5,
      z: -r * 0.42,
    });
  }
  arms(b, h * 0.72, r * 0.44, h * 0.2, r * 0.18, r * 0.2);
  for (const side of [1, -1]) {
    b.parts.add(chamferedCylinder(r * 0.18, r * 0.22, r * 0.18, 8), TONES.energy, {
      x: side * r * 0.32,
      y: h * 0.62,
      z: r * 0.4,
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
  carapace(b, h * 0.42, r * 0.8, h * 0.55);
  torsoBox(b, h * 0.34, h * 0.22, r * 0.9, r * 1.2, 0.6);
  head(b, h * 0.36, r * 0.3, "mandible");
  insectLegs(b, 4, r * 0.85, h * 0.5, r * 0.16);
  for (const side of [1, -1]) {
    weapon(b, "claw", { x: side * r * 0.5, y: h * 0.3, z: r * 0.5, len: r * 0.4, r });
  }
  b.parts.add(cone(r * 0.18, r * 0.45, 5), TONES.trim, { y: h * 0.7, z: -r * 0.35, rx: -0.9 });
};

const zergling: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  carapace(b, h * 0.45, r * 0.9, h * 0.6);
  b.parts.add(taperedBox(r * 0.8, h * 0.4, r * 0.9, 0.7), TONES.plate, { y: h * 0.28, z: r * 0.35 });
  head(b, h * 0.32, r * 0.34, "mandible");
  insectLegs(b, 4, r * 0.9, h * 0.5, r * 0.14);
  for (const side of [1, -1]) {
    b.parts.add(cone(r * 0.1, r * 0.4, 4), TONES.trim, {
      x: side * r * 0.22,
      y: h * 0.6,
      z: -r * 0.6,
      rx: -0.9,
    });
  }
};

const hydralisk: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.24, h * 0.45, r * 0.28, 0.6), TONES.dark, { x: side * r * 0.32 });
    b.parts.add(taperedBox(r * 0.3, h * 0.12, r * 0.5, 0.8), TONES.deep, { x: side * r * 0.38, z: r * 0.1 });
  }
  carapace(b, h * 0.5, r * 0.66, h * 0.4);
  torsoBox(b, h * 0.42, h * 0.3, r * 0.8, r * 1.05, 0.6, TONES.plate);
  head(b, h * 0.46, r * 0.3, "beak");
  for (const side of [1, -1]) {
    b.parts.add(cone(r * 0.15, r * 0.7, 5), TONES.energyDim, {
      x: side * r * 0.32,
      y: h * 0.6,
      z: r * 0.3,
      rx: FORWARD_TILT,
    });
  }
  spines(b, 3, r * 0.5, h * 0.72, r * 0.3, r * 0.09, 771);
};

const ultralisk: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  insectLegs(b, 4, r * 0.85, h * 0.5, r * 0.24);
  carapace(b, h * 0.52, r * 0.9, h * 0.5);
  torsoBox(b, h * 0.4, h * 0.4, r * 0.9, r * 1.3, 0.75, TONES.plate);
  head(b, h * 0.4, r * 0.34, "mandible");
  for (const side of [1, -1]) {
    b.parts.add(cone(r * 0.2, r * 0.6, 6, r * 0.05), TONES.trim, {
      x: side * r * 0.45,
      y: h * 0.22,
      z: r * 0.4,
      rx: FORWARD_TILT,
    });
  }
  spines(b, 5, r * 0.7, h * 0.72, r * 0.45, r * 0.13, 4242);
};

const queen: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.2, h * 0.42, r * 0.24, 0.6), TONES.dark, { x: side * r * 0.28, rx: 0.25 });
    b.parts.add(taperedBox(r * 0.28, h * 0.1, r * 0.46, 0.8), TONES.deep, { x: side * r * 0.32, z: r * 0.12 });
  }
  torsoBox(b, h * 0.44, h * 0.36, r * 0.68, r * 0.86, 0.65);
  head(b, h * 0.78, r * 0.3, "crest");
  b.parts.add(sphereLowPoly(r * 0.36, 8, 5), TONES.energyDim, { y: h * 0.5, z: -r * 0.4 });
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.1, h * 0.3, r * 0.42, 0.4), TONES.plate, {
      x: side * r * 0.44,
      y: h * 0.5,
      z: -r * 0.26,
      rz: side * 0.6,
    });
  }
  b.parts.add(cone(r * 0.12, r * 0.5, 5), TONES.energy, { y: h * 0.34, z: r * 0.35, rx: FORWARD_TILT });
};

const roach: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  insectLegs(b, 6, r * 0.85, h * 0.45, r * 0.12);
  carapace(b, h * 0.45, r * 0.9, h * 0.55);
  head(b, h * 0.3, r * 0.26, "beak");
  b.parts.add(cone(r * 0.16, r * 0.4, 5), TONES.energyDim, { y: h * 0.36, z: r * 0.45, rx: FORWARD_TILT });
  spines(b, 4, r * 0.6, h * 0.62, r * 0.3, r * 0.1, 991);
};

const lurker: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  insectLegs(b, 4, r * 0.8, h * 0.4, r * 0.16);
  carapace(b, h * 0.5, r * 0.8, h * 0.5);
  b.parts.add(taperedBox(r * 0.7, h * 0.3, r * 0.8, 0.7), TONES.plate, { y: h * 0.25, z: r * 0.28 });
  for (const side of [1, -1]) {
    b.parts.add(cone(r * 0.18, r * 0.5, 5, r * 0.05), TONES.energyDim, {
      x: side * r * 0.4,
      y: h * 0.2,
      z: r * 0.4,
      rx: FORWARD_TILT,
    });
  }
  spines(b, 4, r * 0.55, h * 0.62, r * 0.28, r * 0.1, 313);
};

const infestor: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(capsule(r * 0.5, h * 0.22, 4, 8), TONES.hull, { y: h * 0.35 });
  glowCore(b, h * 0.7, r * 0.4, TONES.energyDim);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    b.parts.add(taperedBox(r * 0.11, h * 0.4, r * 0.11, 0.3), TONES.dark, {
      x: Math.cos(a) * r * 0.28,
      y: h * 0.05,
      z: Math.sin(a) * r * 0.28,
      rz: -Math.cos(a) * 0.5,
      rx: Math.sin(a) * 0.5,
    });
  }
  b.parts.add(cone(r * 0.14, r * 0.5, 5), TONES.energy, { y: h * 0.5, z: r * 0.35, rx: FORWARD_TILT });
};

const corruptor: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(sphereLowPoly(r * 0.65, 8, 5), TONES.hull, { y: h * 0.45, sy: 0.55 });
  b.parts.add(taperedBox(r * 0.48, h * 0.2, r * 1.0, 0.6), TONES.plate, { y: h * 0.5, z: r * 0.32 });
  wings(b, r * 0.7, r * 0.7, h * 0.55, r * 0.2, 0.3, TONES.hull);
  for (const side of [1, -1]) {
    b.parts.add(chamferedCylinder(r * 0.14, r * 0.16, r * 0.35, 6), TONES.energy, {
      x: side * r * 0.36,
      y: h * 0.42,
      z: -r * 0.55,
      rx: Math.PI * 0.5,
    });
  }
  b.parts.add(cone(r * 0.16, h * 0.3, 6, r * 0.05), TONES.energyDim, {
    y: h * 0.24,
    z: r * 0.28,
    rx: FORWARD_TILT,
  });
};

const guardian: UnitBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(sphereLowPoly(r * 0.58, 8, 5), TONES.hull, { y: h * 0.6, sy: 0.7 });
  b.parts.add(taperedBox(r * 0.48, h * 0.2, r * 0.85, 0.6), TONES.plate, { y: h * 0.6, z: r * 0.35 });
  for (const side of [1, -1]) {
    b.parts.add(sphereLowPoly(r * 0.3, 6, 4), TONES.plate, { x: side * r * 0.68, y: h * 0.62, sz: 1.2 });
    b.parts.add(cone(r * 0.18, r * 0.5, 5, r * 0.06), TONES.trim, {
      x: side * r * 0.82,
      y: h * 0.5,
      z: r * 0.35,
      rx: FORWARD_TILT,
    });
    b.parts.add(chamferedCylinder(r * 0.12, r * 0.14, r * 0.32, 6), TONES.energy, {
      x: side * r * 0.28,
      y: h * 0.55,
      z: -r * 0.45,
      rx: Math.PI * 0.5,
    });
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    b.parts.add(cone(r * 0.1, h * 0.3, 5, r * 0.04), TONES.energyDim, {
      x: Math.cos(a) * r * 0.3,
      y: h * 0.3,
      z: Math.sin(a) * r * 0.3,
      rx: Math.sin(a) * 0.6,
      rz: -Math.cos(a) * 0.6,
    });
  }
  spines(b, 3, r * 0.42, h * 0.85, r * 0.25, r * 0.1, 55);
};

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

const UNIT_BUILDERS: Record<string, UnitBuilder> = {
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

/** How far a hovering hull floats above its ground contact, in metres. */
export function airHoverLift(height: number): number {
  return Math.min(0.45, Math.max(0.12, height * 0.14));
}

/**
 * The shared, reference-counted unit geometry for `typeKey`. Building keys
 * are dispatched to the building builders, so this never throws for any of
 * the 57 roster keys; an unknown key is a hard error, because quietly
 * rendering a placeholder would hide a roster/mesh mismatch.
 */
export function unitGeometry(typeKey: string): THREE.BufferGeometry {
  return geometryCache.acquire(typeKey, buildAnyGeometry);
}

/** Uncached builder for any roster key. `unitGeometry` wraps this in the cache. */
export function buildAnyGeometry(typeKey: string): THREE.BufferGeometry {
  const def = entityDef(typeKey);
  return def.kind === "building" ? buildBuildingGeometry(typeKey) : assemble(def);
}

function assemble(def: UnitDef): THREE.BufferGeometry {
  const builder = UNIT_BUILDERS[def.key];
  if (!builder) throw new Error(`unitGeometry(): no builder for roster unit "${def.key}"`);
  const build: Build = {
    def,
    radius: def.size.radius,
    height: def.size.height,
    air: def.movement === "air",
    parts: new PartList(),
  };
  builder(build);
  // Air hulls float: the clearance comes out of the height budget, so the
  // silhouette still tops out at the roster height.
  const lift = build.air ? airHoverLift(def.size.height) : 0;
  const body = build.parts.merge();
  // Seat the model before the fit: a ground unit stands on the ground plane
  // and an air hull starts one lift above it, whatever height the builder
  // happened to hang its lowest part at. The fit then measures the silhouette
  // from the ground plane, which is where the roster measures it from too.
  body.computeBoundingBox();
  const base = body.boundingBox?.min.y ?? 0;
  if (base !== 0) body.translate(0, -base, 0);
  fitFootprint(body, def.size.radius, def.size.height - lift);
  if (lift > 0) body.translate(0, lift, 0);
  return body;
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
  /** Furthest vertex from the origin in the XZ plane, in metres. */
  reach: number;
  /** Lowest vertex, in metres: 0 for ground models, the hover lift for air. */
  base: number;
  /** The y the model is contractually seated at. */
  expectedBase: number;
  /** Highest vertex, in metres. */
  top: number;
}

/** Slack allowed on every fitted dimension, in metres. */
export const FIT_TOLERANCE = 1e-3;

/**
 * The `maxOvershoot` each builder hands `fitFootprint`: a building must match
 * its collision circle exactly, a unit may let a weapon barrel poke past it.
 * The self-check asserts the same budget the builders were given.
 */
export function footprintOvershoot(kind: "unit" | "building"): number {
  return kind === "building" ? 1.0 : 1.12;
}

/** What the check measured, whether the model passed or not. */
export interface GeometryMeasurement {
  triangles: number;
  reach: number;
  base: number;
  top: number;
}

/**
 * The single geometry contract every roster key has to satisfy: a rendered,
 * vertex-coloured, UV'd buffer that sits on the ground (or one hover lift
 * above it, for an air hull), stays inside the collision circle's documented
 * overshoot, and does not out-top its roster height. Returns the measurement
 * it took and an empty string when the model passes, or the reason it does
 * not. Split out from the walk below so a deliberately broken model can be
 * checked against the same rules the roster is.
 */
export function checkGeometry(
  def: EntityDef,
  geometry: THREE.BufferGeometry,
): { measurement: GeometryMeasurement; reason: string } {
  const position = geometry.getAttribute("position");
  const triangles = position ? (position.count / 3) | 0 : 0;
  const measurement: GeometryMeasurement = { triangles, reach: 0, base: 0, top: 0 };
  if (triangles === 0) return { measurement, reason: "empty geometry" };
  if (geometry.getAttribute("color")?.count !== position.count) {
    return { measurement, reason: "vertex colour attribute does not match the position attribute" };
  }
  if (!geometry.getAttribute("uv")) return { measurement, reason: "uv attribute missing" };
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return { measurement, reason: "no bounding box" };
  measurement.reach = Math.max(box.max.x, -box.min.x, box.max.z, -box.min.z);
  measurement.base = box.min.y;
  measurement.top = box.max.y;
  const lift = def.kind === "unit" && def.movement === "air" ? airHoverLift(def.size.height) : 0;
  if (Math.abs(measurement.base - lift) > FIT_TOLERANCE) {
    return {
      measurement,
      reason:
        lift > 0
          ? `hover clearance is ${measurement.base.toFixed(3)}, not the ${lift.toFixed(3)} lift`
          : `base is ${measurement.base.toFixed(3)}, not the ground plane`,
    };
  }
  if (measurement.reach > def.size.radius * footprintOvershoot(def.kind) + FIT_TOLERANCE) {
    return {
      measurement,
      reason: `footprint ${measurement.reach.toFixed(3)} exceeds collision radius ${def.size.radius}`,
    };
  }
  if (measurement.top > def.size.height + FIT_TOLERANCE) {
    return {
      measurement,
      reason: `taller than roster height ${def.size.height} (${measurement.top.toFixed(3)})`,
    };
  }
  return { measurement, reason: "" };
}

/**
 * Walks every key in the roster and rebuilds its geometry, checking that it is
 * non-empty, coloured, seated at the y the roster implies and inside the
 * collision footprint. Development aid: run it from a test or a boot-time
 * assert, never per frame.
 */
export function selfCheckGeometryCoverage(): GeometryCheck[] {
  const results: GeometryCheck[] = [];
  for (const key of Object.keys(GAME.units)) {
    const def = entityDef(key);
    const height = def.size.height;
    const lift = def.kind === "unit" && def.movement === "air" ? airHoverLift(height) : 0;
    let geometry: THREE.BufferGeometry | null = null;
    let reason = "ok";
    let measurement: GeometryMeasurement = { triangles: 0, reach: 0, base: 0, top: 0 };
    try {
      geometry = buildAnyGeometry(key);
      const checked = checkGeometry(def, geometry);
      measurement = checked.measurement;
      reason = checked.reason === "" ? "ok" : checked.reason;
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
      triangles: measurement.triangles,
      radius: def.size.radius,
      height,
      reach: measurement.reach,
      base: measurement.base,
      expectedBase: lift,
      top: measurement.top,
    });
  }
  return results;
}

/** Throws on the first roster key whose geometry fails the self-check. */
export function assertGeometryCoverage(): void {
  for (const check of selfCheckGeometryCoverage()) {
    if (!check.ok) throw new Error(`assertGeometryCoverage(): ${check.key} — ${check.reason}`);
  }
}
