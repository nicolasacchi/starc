/**
 * Building geometry — every structure in the roster, generated in code.
 *
 * 100% procedural: no model, mesh or image file is imported. Each building is
 * assembled from the primitives in `./shapes` into one merged, vertex-coloured
 * BufferGeometry. The footprint is not decorative: the server resolves
 * collisions against `size.radius`, so every structure is fitted to that
 * radius and to `size.height`, and the same builder gives the model its
 * language per race — Terran gets riveted hulls, hazard bands and landing
 * struts, Protoss gets faceted gold architecture with energy nodes, Zerg gets
 * bulbous carapace mounds crowned with spines.
 *
 * Conventions: origin at the base centre, y = 0 on the ground, model faces +Z.
 *
 * This module and `unitGeometry.ts` reference each other so that neither entry
 * point throws for any of the 57 roster keys; the calls happen at build time,
 * after both modules have finished evaluating.
 */
import * as THREE from "three";
import { entityDef } from "@shared/gameData";
import type { BuildingDef } from "@shared/protocol";
import { TONES } from "@render/materials/palette";
import {
  PartList,
  beveledBox,
  chamferedCylinder,
  cone,
  fitFootprint,
  greeble,
  hexPrism,
  mulberry32,
  octahedron,
  panelLineOverlay,
  sphereLowPoly,
  taperedBox,
  torusSegment,
  truncatedPyramid,
  wingShape,
} from "./shapes";
import type { PartTone } from "./shapes";
import { buildAnyGeometry } from "./unitGeometry";
import { geometryCache } from "./geometryCache";

interface Build {
  def: BuildingDef;
  /** Collision radius in metres; the visual is fitted to it. */
  radius: number;
  /** Silhouette height in metres. */
  height: number;
  parts: PartList;
}

type BuildingBuilder = (b: Build) => void;

/* ------------------------------------------------------------------ */
/* Shared assemblies                                                   */
/* ------------------------------------------------------------------ */

/** Deterministic clutter budget: bigger hulls wear more greebles. */
function clutter(w: number, d: number): { count: number; scale: number } {
  return {
    count: Math.round(Math.min(30, Math.max(4, w * d * 1.6))),
    scale: Math.min(0.34, Math.max(0.08, Math.min(w, d) * 0.09)),
  };
}

interface BlockOptions {
  y: number;
  w: number;
  h: number;
  d: number;
  seed: number;
  tone?: PartTone;
  bevel?: number;
}

/** A bevelled, greebled hull block — the basic mass of every structure. */
function hullBlock(b: Build, o: BlockOptions): void {
  const budget = clutter(o.w, o.d);
  const core = greeble(
    beveledBox(o.w, o.h, o.d, o.bevel ?? Math.min(0.14, Math.min(o.w, o.d, o.h) * 0.1)),
    budget.count,
    budget.scale,
    o.seed,
  );
  b.parts.add(core, o.tone ?? TONES.hull, { y: o.y });
}

/** Recessed doorway with a lit lintel — reads as "enter here" at RTS zoom. */
function doorway(b: Build, y: number, w: number, h: number, face: number, tone: PartTone = TONES.deep): void {
  b.parts.add(taperedBox(w, h, face * 0.25, 1), tone, { y, z: face });
  b.parts.add(taperedBox(w * 1.2, h * 0.1, face * 0.32, 1), TONES.accent, { y: y + h, z: face });
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(w * 0.1, h, face * 0.32, 1), TONES.plate, { x: side * w * 0.55, y, z: face });
  }
}

/**
 * Elevated landing platform: a hazard-edged slab whose top face sits at
 * `top`, carried on splayed struts. Whatever is built next starts at `top`.
 */
function landingPad(b: Build, top: number, w: number, d: number, tone: PartTone = TONES.dark): void {
  const slab = Math.max(0.06, top * 0.14);
  b.parts.add(taperedBox(w, slab, d, 0.92), tone, { y: top - slab });
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(w, 0.03, d * 0.05, 1), TONES.accent, { y: top, z: side * d * 0.47 });
    b.parts.add(taperedBox(w * 0.06, 0.03, d, 1), TONES.accent, { x: w * 0.3, y: top });
    b.parts.add(taperedBox(w * 0.06, 0.03, d, 1), TONES.accent, { x: -w * 0.3, y: top });
  }
  struts(b, 4, Math.min(w, d) * 0.44, top - slab, w * 0.045);
}

/** Angled landing struts, feet on the ground at `ring`, tops under `top`. */
function struts(b: Build, count: number, ring: number, top: number, w: number, tone: PartTone = TONES.plate): void {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.PI * 0.25;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    const run = ring * 0.55;
    const length = Math.hypot(run, Math.max(top, 1e-3));
    const tilt = Math.atan2(run, Math.max(top, 1e-3));
    b.parts.add(taperedBox(w, length, w, 0.7), tone, {
      x: cx * ring,
      z: cz * ring,
      rx: cz * tilt,
      rz: -cx * tilt,
    });
    b.parts.add(taperedBox(w * 2.2, w * 0.8, w * 2.2, 0.8), TONES.deep, {
      x: cx * ring,
      z: cz * ring,
    });
  }
}

/** Ring of chitin spines — the Zerg crown. */
function spines(b: Build, count: number, ring: number, y: number, len: number, w: number, seed: number): void {
  const rnd = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    b.parts.add(cone(w, len * (0.6 + rnd() * 0.7), 5), TONES.trim, {
      x: cx * ring,
      y,
      z: cz * ring,
      rx: cz * 0.5,
      rz: -cx * 0.5,
    });
  }
}

/** Organic dome with a few lobes — the base of every Zerg structure. */
function mound(b: Build, r: number, h: number, lobes: number, seed: number, tone: PartTone = TONES.hull): void {
  b.parts.add(sphereLowPoly(r, 9, 5), tone, { sy: h / (r * 2) });
  const rnd = mulberry32(seed);
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + rnd() * 0.7;
    const rr = r * (0.3 + rnd() * 0.2);
    b.parts.add(sphereLowPoly(rr, 7, 4), TONES.plate, {
      x: Math.cos(a) * r * 0.32,
      z: Math.sin(a) * r * 0.32,
      y: h * 0.04,
      sy: (h * (0.3 + rnd() * 0.35)) / (rr * 2),
    });
  }
}

/** Curved organic tubes leaning out of a mound. */
function tendrils(b: Build, count: number, ring: number, y: number, len: number, r: number, seed: number): void {
  const rnd = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rnd() * 0.4;
    b.parts.add(cone(r, len * (0.7 + rnd() * 0.6), 5, r * 0.4), TONES.deep, {
      x: Math.cos(a) * ring,
      y,
      z: Math.sin(a) * ring,
      rx: Math.sin(a) * 0.8,
      rz: -Math.cos(a) * 0.8,
    });
  }
}

/** Glowing node: power core, thruster or energy sphere. */
function glowNode(b: Build, y: number, r: number, tone: PartTone = TONES.energy): void {
  b.parts.add(sphereLowPoly(r, 8, 6), tone, { y });
}

/** Pipe run between two heights on a given face. */
function pipeStack(b: Build, x: number, y: number, z: number, h: number, r: number, count = 3): void {
  for (let i = 0; i < count; i++) {
    b.parts.add(chamferedCylinder(r, r, h, 8), TONES.plate, { x: x + (i - (count - 1) / 2) * r * 2.6, y, z });
    b.parts.add(chamferedCylinder(r * 1.25, r * 1.25, r * 0.6, 8), TONES.accent, {
      x: x + (i - (count - 1) / 2) * r * 2.6,
      y: y + h - r * 0.6,
      z,
    });
  }
}

/** Protoss wing plate used as architectural decoration. */
function wingPlate(b: Build, x: number, y: number, z: number, span: number, chord: number, tilt: number): void {
  for (const side of [1, -1]) {
    b.parts.add(wingShape(span, chord, chord * 0.14), TONES.accent, {
      x: side * x,
      y,
      z,
      ry: side > 0 ? -0.3 : Math.PI + 0.3,
      rz: side * tilt,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Protoss buildings                                                   */
/* ------------------------------------------------------------------ */

const nexus: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(hexPrism(r, h * 0.16), TONES.deep);
  b.parts.add(hexPrism(r * 0.82, h * 0.3), TONES.hull, { y: h * 0.16 });
  hullBlock(b, { y: h * 0.46, w: r * 0.9, h: h * 0.24, d: r * 0.9, seed: 11, tone: TONES.hull });
  b.parts.add(hexPrism(r * 0.42, h * 0.16), TONES.plate, { y: h * 0.6 });
  glowNode(b, h * 0.76, r * 0.14);
  wingPlate(b, r * 0.36, h * 0.62, -r * 0.3, r * 0.5, r * 0.4, 0.35);
  b.parts.add(truncatedPyramid(r * 0.5, r * 0.9, r * 0.34, r * 0.5, h * 0.1), TONES.accent, {
    y: 0,
    z: r * 0.55,
  });
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.1, h * 0.34, r * 0.1, 0.6), TONES.energy, {
      x: side * r * 0.6,
      y: h * 0.46,
      z: r * 0.42,
    });
  }
};

const pylon: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(hexPrism(r * 0.85, h * 0.1), TONES.deep);
  b.parts.add(hexPrism(r * 0.4, h * 0.55), TONES.hull, { y: h * 0.1 });
  b.parts.add(taperedBox(r * 0.14, h * 0.2, r * 0.14, 0.5), TONES.plate, { y: h * 0.65 });
  glowNode(b, h * 0.66, r * 0.44);
  for (let i = 0; i < 3; i++) {
    b.parts.add(torusSegment(r * (0.5 - i * 0.06), r * 0.07, Math.PI * 2, 12, 5), TONES.accent, {
      y: h * (0.5 + i * 0.12),
    });
  }
  b.parts.add(cone(r * 0.12, h * 0.1, 6), TONES.trim, { y: h * 0.86 });
};

const assimilator: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(truncatedPyramid(r * 1.6, r * 1.6, r * 1.1, r * 1.1, h * 0.4), TONES.hull);
  hullBlock(b, { y: h * 0.4, w: r * 0.9, h: h * 0.3, d: r * 0.9, seed: 22 });
  b.parts.add(chamferedCylinder(r * 0.42, r * 0.5, h * 0.24, 10), TONES.plate, { y: h * 0.7 });
  b.parts.add(torusSegment(r * 0.34, r * 0.08, Math.PI * 2, 12, 5), TONES.energy, { y: h * 0.86 });
  pipeStack(b, 0, h * 0.12, -r * 0.42, h * 0.5, r * 0.1, 2);
};

const gateway: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(hexPrism(r, h * 0.12), TONES.deep);
  hullBlock(b, { y: h * 0.12, w: r * 1.6, h: h * 0.5, d: r * 1.3, seed: 33 });
  doorway(b, h * 0.12, r * 0.7, h * 0.34, r * 0.62);
  wingPlate(b, r * 0.3, h * 0.66, -r * 0.2, r * 0.55, r * 0.45, 0.5);
  b.parts.add(taperedBox(r * 0.5, h * 0.2, r * 0.5, 0.6), TONES.plate, { y: h * 0.62 });
  glowNode(b, h * 0.74, r * 0.16, TONES.energyDim);
  b.parts.add(taperedBox(r * 0.1, h * 0.24, r * 0.1, 0.5), TONES.accent, { x: r * 0.62, y: h * 0.62, z: r * 0.4 });
  b.parts.add(taperedBox(r * 0.1, h * 0.24, r * 0.1, 0.5), TONES.accent, { x: -r * 0.62, y: h * 0.62, z: r * 0.4 });
};

const forge: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(hexPrism(r * 0.95, h * 0.1), TONES.deep);
  hullBlock(b, { y: h * 0.1, w: r * 1.5, h: h * 0.5, d: r * 1.4, seed: 44 });
  doorway(b, h * 0.1, r * 0.5, h * 0.3, r * 0.66);
  pipeStack(b, 0, h * 0.6, -r * 0.4, h * 0.36, r * 0.1, 3);
  glowNode(b, h * 0.66, r * 0.18, TONES.energyDim);
  b.parts.add(panelLineOverlay(r * 1.2, 0, r * 1.1, { lines: 3, thickness: 0.04 }), TONES.plate, { y: h * 0.6 });
};

const photonCannon: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(hexPrism(r, h * 0.1), TONES.deep);
  b.parts.add(hexPrism(r * 0.55, h * 0.55), TONES.hull, { y: h * 0.1 });
  b.parts.add(torusSegment(r * 0.45, r * 0.08, Math.PI * 2, 12, 5), TONES.accent, { y: h * 0.5 });
  b.parts.add(taperedBox(r * 0.5, h * 0.14, r * 0.5, 0.7), TONES.plate, { y: h * 0.65 });
  glowNode(b, h * 0.6, r * 0.3);
  b.parts.add(octahedron(r * 0.36), TONES.energy, { y: h * 0.78 });
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.1, h * 0.2, r * 0.1, 0.4), TONES.trim, { x: side * r * 0.42, y: h * 0.7 });
  }
};

const cyberneticsCore: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(hexPrism(r, h * 0.1), TONES.deep);
  hullBlock(b, { y: h * 0.1, w: r * 1.5, h: h * 0.42, d: r * 1.4, seed: 55 });
  b.parts.add(taperedBox(r * 1.1, h * 0.24, r * 1.0, 0.7), TONES.hull, { y: h * 0.52 });
  b.parts.add(taperedBox(r * 0.9, h * 0.12, r * 0.12, 1), TONES.energy, { y: h * 0.56, z: r * 0.5 });
  doorway(b, h * 0.1, r * 0.5, h * 0.28, r * 0.66);
  b.parts.add(taperedBox(r * 0.12, h * 0.2, r * 0.12, 0.4), TONES.accent, { y: h * 0.76, z: -r * 0.3 });
  glowNode(b, h * 0.72, r * 0.14, TONES.energyDim);
};

const twilightCouncil: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(hexPrism(r, h * 0.1), TONES.deep);
  hullBlock(b, { y: h * 0.1, w: r * 1.1, h: h * 0.44, d: r * 1.4, seed: 66 });
  for (const side of [1, -1]) {
    b.parts.add(hexPrism(r * 0.34, h * 0.52), TONES.hull, { x: side * r * 0.6, y: h * 0.1 });
    b.parts.add(torusSegment(r * 0.26, r * 0.06, Math.PI * 2, 10, 5), TONES.energy, {
      x: side * r * 0.6,
      y: h * 0.48,
    });
  }
  doorway(b, h * 0.1, r * 0.5, h * 0.3, r * 0.66);
  b.parts.add(taperedBox(r * 0.7, h * 0.1, r * 0.4, 0.6), TONES.accent, { y: h * 0.6, z: r * 0.4 });
  glowNode(b, h * 0.68, r * 0.16);
};

const roboticsFacility: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(hexPrism(r, h * 0.1), TONES.deep);
  hullBlock(b, { y: h * 0.1, w: r * 1.5, h: h * 0.5, d: r * 1.4, seed: 77 });
  doorway(b, h * 0.1, r * 0.66, h * 0.36, r * 0.66);
  b.parts.add(taperedBox(r * 0.9, h * 0.12, r * 0.7, 0.7), TONES.plate, { y: h * 0.6, z: r * 0.2 });
  b.parts.add(chamferedCylinder(r * 0.3, r * 0.2, r * 0.2, 10), TONES.accent, { y: h * 0.72, z: -r * 0.3, rx: 0.5 });
  b.parts.add(taperedBox(r * 0.1, h * 0.26, r * 0.1, 0.3), TONES.trim, { y: h * 0.6, z: -r * 0.5 });
  glowNode(b, h * 0.72, r * 0.12, TONES.energyDim);
};

/* ------------------------------------------------------------------ */
/* Terran buildings                                                    */
/* ------------------------------------------------------------------ */

const commandCenter: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  // Landed structure: stepped plinth, hull, roof pad on struts, command wheel.
  const plinth = h * 0.28;
  hullBlock(b, { y: 0, w: r * 1.7, h: plinth, d: r * 1.7, seed: 101, tone: TONES.deep });
  hullBlock(b, { y: plinth, w: r * 1.25, h: h * 0.34, d: r * 1.05, seed: 102 });
  landingPad(b, plinth + h * 0.34, r * 1.1, r * 0.8, TONES.plate);
  doorway(b, plinth, r * 0.5, h * 0.26, r * 0.5);
  b.parts.add(chamferedCylinder(r * 0.34, r * 0.38, h * 0.14, 12), TONES.plate, { y: h * 0.9 });
  b.parts.add(torusSegment(r * 0.26, r * 0.05, Math.PI * 2, 14, 6), TONES.accent, { y: h * 0.94 });
  b.parts.add(taperedBox(r * 0.07, h * 0.2, r * 0.07, 0.3), TONES.plate, { x: r * 0.55, y: h * 0.9, z: -r * 0.28 });
  glowNode(b, h * 0.9, r * 0.07, TONES.energyDim);
  pipeStack(b, 0, plinth, -r * 0.48, h * 0.3, r * 0.09, 2);
};

const supplyDepot: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  const base = h * 0.34;
  hullBlock(b, { y: 0, w: r * 1.5, h: base, d: r * 1.3, seed: 111, tone: TONES.deep });
  landingPad(b, base + h * 0.36, r * 1.05, r * 0.8, TONES.plate);
  pipeStack(b, 0, base, -r * 0.45, h * 0.34, r * 0.08, 2);
  glowNode(b, base + h * 0.3, r * 0.08, TONES.energyDim);
};

const refinery: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(taperedBox(r * 1.7, h * 0.16, r * 1.7, 0.95), TONES.deep);
  hullBlock(b, { y: h * 0.16, w: r * 1.3, h: h * 0.4, d: r * 1.2, seed: 121 });
  b.parts.add(chamferedCylinder(r * 0.55, r * 0.58, h * 0.36, 12), TONES.plate, {
    x: r * 0.35,
    y: h * 0.5,
    z: -r * 0.2,
  });
  b.parts.add(torusSegment(r * 0.46, r * 0.06, Math.PI * 2, 14, 6), TONES.accent, {
    x: r * 0.35,
    y: h * 0.62,
    z: -r * 0.2,
  });
  pipeStack(b, 0, h * 0.16, r * 0.5, h * 0.5, r * 0.1, 3);
  b.parts.add(cone(r * 0.12, h * 0.2, 6), TONES.energyDim, { x: -r * 0.48, y: h * 0.7 });
  doorway(b, h * 0.16, r * 0.4, h * 0.24, r * 0.56);
};

const barracks: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(taperedBox(r * 1.6, h * 0.1, r * 1.5, 0.96), TONES.deep);
  hullBlock(b, { y: h * 0.1, w: r * 1.4, h: h * 0.45, d: r * 1.4, seed: 131 });
  b.parts.add(truncatedPyramid(r * 1.4, r * 1.4, r * 1.0, r * 1.0, h * 0.2), TONES.plate, { y: h * 0.55 });
  doorway(b, h * 0.1, r * 0.55, h * 0.32, r * 0.66);
  b.parts.add(panelLineOverlay(r * 1.1, 0, r * 1.0, { lines: 2, thickness: 0.04 }), TONES.dark, { y: h * 0.75 });
  b.parts.add(taperedBox(r * 0.12, h * 0.14, r * 0.12, 0.5), TONES.accent, { x: r * 0.55, y: h * 0.75, z: -r * 0.5 });
};

const engineeringBay: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(taperedBox(r * 1.5, h * 0.1, r * 1.4, 0.96), TONES.deep);
  hullBlock(b, { y: h * 0.1, w: r * 1.3, h: h * 0.45, d: r * 1.2, seed: 141 });
  b.parts.add(taperedBox(r * 0.9, h * 0.1, r * 0.7, 0.7), TONES.plate, { y: h * 0.55, z: r * 0.2 });
  pipeStack(b, 0, h * 0.1, -r * 0.5, h * 0.55, r * 0.1, 3);
  b.parts.add(torusSegment(r * 0.36, r * 0.07, Math.PI * 2, 12, 5), TONES.accent, { y: h * 0.62, z: r * 0.2 });
  doorway(b, h * 0.1, r * 0.4, h * 0.26, r * 0.58);
};

const factory: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(taperedBox(r * 1.7, h * 0.1, r * 1.5, 0.96), TONES.deep);
  hullBlock(b, { y: h * 0.1, w: r * 1.5, h: h * 0.5, d: r * 1.3, seed: 151 });
  b.parts.add(truncatedPyramid(r * 1.5, r * 1.3, r * 1.1, r * 0.9, h * 0.16), TONES.plate, { y: h * 0.6 });
  doorway(b, h * 0.1, r * 0.72, h * 0.4, r * 0.62);
  pipeStack(b, 0, h * 0.7, -r * 0.45, h * 0.26, r * 0.1, 2);
  b.parts.add(panelLineOverlay(r * 1.2, 0, r * 1.0, { lines: 3, thickness: 0.045 }), TONES.dark, { y: h * 0.76 });
  for (const side of [1, -1]) {
    b.parts.add(taperedBox(r * 0.14, h * 0.12, r * 0.14, 0.6), TONES.accent, { x: side * r * 0.62, y: h * 0.76, z: r * 0.4 });
  }
};

const starport: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  landingPad(b, h * 0.4, r * 1.45, r * 1.85, TONES.dark);
  b.parts.add(taperedBox(r * 1.1, h * 0.26, r * 0.9, 0.9), TONES.deep, { y: h * 0.4, z: -r * 0.25 });
  doorway(b, h * 0.4, r * 0.5, h * 0.3, r * 0.28);
  b.parts.add(chamferedCylinder(r * 0.3, r * 0.34, h * 0.18, 10), TONES.plate, {
    x: r * 0.36,
    y: h * 0.6,
    z: -r * 0.25,
  });
  b.parts.add(chamferedCylinder(r * 0.28, r * 0.06, r * 0.14, 10), TONES.accent, {
    x: r * 0.36,
    y: h * 0.78,
    z: -r * 0.25,
    rx: 0.6,
  });
  b.parts.add(torusSegment(r * 0.24, r * 0.05, Math.PI * 2, 12, 5), TONES.energy, {
    y: h * 0.46,
    z: -r * 0.25,
  });
  pipeStack(b, 0, h * 0.4, r * 0.32, h * 0.26, r * 0.09, 2);
};

const bunker: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(taperedBox(r * 1.7, h * 0.18, r * 1.6, 0.9), TONES.deep);
  hullBlock(b, { y: h * 0.18, w: r * 1.4, h: h * 0.5, d: r * 1.4, seed: 161, tone: TONES.plate });
  b.parts.add(truncatedPyramid(r * 1.4, r * 1.4, r * 0.9, r * 0.9, h * 0.2), TONES.hull, { y: h * 0.68 });
  b.parts.add(taperedBox(r * 0.7, h * 0.1, r * 0.2, 1), TONES.energyDim, { y: h * 0.5, z: r * 0.7 });
  b.parts.add(taperedBox(r * 0.16, h * 0.14, r * 0.16, 0.5), TONES.accent, { x: -r * 0.4, y: h * 0.88 });
  b.parts.add(taperedBox(r * 0.16, h * 0.14, r * 0.16, 0.5), TONES.accent, { x: r * 0.4, y: h * 0.88 });
};

const turret: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(chamferedCylinder(r, r * 0.92, h * 0.22, 10), TONES.deep);
  b.parts.add(chamferedCylinder(r * 0.62, r * 0.7, h * 0.4, 8), TONES.hull, { y: h * 0.22 });
  b.parts.add(torusSegment(r * 0.5, r * 0.07, Math.PI * 2, 12, 5), TONES.plate, { y: h * 0.5 });
  b.parts.add(beveledBox(r * 0.9, h * 0.22, r * 0.8, r * 0.08), TONES.hull, { y: h * 0.6 });
  for (const side of [1, -1]) {
    b.parts.add(chamferedCylinder(r * 0.09, r * 0.1, r * 0.7, 6), TONES.dark, {
      x: side * r * 0.2,
      y: h * 0.68,
      z: r * 0.2,
      rx: Math.PI * 0.5,
    });
    b.parts.add(chamferedCylinder(r * 0.13, r * 0.13, r * 0.1, 6), TONES.accent, {
      x: side * r * 0.2,
      y: h * 0.68,
      z: r * 0.85,
      rx: Math.PI * 0.5,
    });
  }
  b.parts.add(taperedBox(r * 0.5, h * 0.08, r * 0.4, 0.7), TONES.plate, { y: h * 0.82, z: -r * 0.1 });
};

/* ------------------------------------------------------------------ */
/* Zerg buildings                                                      */
/* ------------------------------------------------------------------ */

const hatchery: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  mound(b, r, h * 0.72, 5, 201);
  spines(b, 6, r * 0.72, h * 0.42, r * 0.3, r * 0.09, 202);
  tendrils(b, 4, r * 0.66, h * 0.2, r * 0.42, r * 0.09, 203);
  b.parts.add(truncatedPyramid(r * 0.6, r * 0.9, r * 0.44, r * 0.6, h * 0.12), TONES.plate, { z: r * 0.5 });
  b.parts.add(taperedBox(r * 0.5, h * 0.14, r * 0.2, 1), TONES.energyDim, { y: h * 0.16, z: r * 0.8 });
  glowNode(b, h * 0.66, r * 0.16, TONES.energyDim);
};

const overlord: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
    b.parts.add(taperedBox(r * 0.22, h * 0.42, r * 0.24, 0.5), TONES.dark, {
      x: Math.cos(a) * r * 0.55,
      z: Math.sin(a) * r * 0.55,
      rx: Math.sin(a) * 0.3,
      rz: -Math.cos(a) * 0.3,
    });
    b.parts.add(taperedBox(r * 0.3, h * 0.08, r * 0.36, 0.8), TONES.deep, {
      x: Math.cos(a) * r * 0.72,
      z: Math.sin(a) * r * 0.72,
    });
  }
  b.parts.add(sphereLowPoly(r * 0.72, 9, 5), TONES.hull, { y: h * 0.36, sy: 0.55 });
  b.parts.add(taperedBox(r * 0.6, h * 0.2, r * 0.7, 0.7), TONES.plate, { y: h * 0.4, z: r * 0.5 });
  tendrils(b, 3, r * 0.5, h * 0.42, r * 0.4, r * 0.08, 204);
  glowNode(b, h * 0.44, r * 0.14, TONES.energyDim);
  b.parts.add(taperedBox(r * 0.24, h * 0.1, r * 0.2, 1), TONES.energyDim, { y: h * 0.5, z: r * 0.66 });
};

const extractor: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  mound(b, r * 0.95, h * 0.55, 4, 211, TONES.plate);
  b.parts.add(cone(r * 0.34, h * 0.5, 7, r * 0.2), TONES.hull, { y: h * 0.4, z: -r * 0.1 });
  b.parts.add(torusSegment(r * 0.3, r * 0.07, Math.PI * 2, 12, 5), TONES.energy, { y: h * 0.78, z: -r * 0.1 });
  spines(b, 4, r * 0.6, h * 0.3, r * 0.26, r * 0.08, 212);
  b.parts.add(taperedBox(r * 0.5, h * 0.08, r * 0.5, 0.8), TONES.deep, { y: h * 0.08, z: r * 0.55 });
};

const spawningPool: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(chamferedCylinder(r, r * 0.94, h * 0.18, 14), TONES.hull);
  b.parts.add(chamferedCylinder(r * 0.7, r * 0.7, h * 0.06, 14), TONES.energyDim, { y: h * 0.12 });
  b.parts.add(sphereLowPoly(r * 0.6, 9, 4), TONES.hull, { y: h * 0.18, sy: (h * 0.46) / (r * 1.2) });
  b.parts.add(sphereLowPoly(r * 0.34, 8, 4), TONES.plate, {
    y: h * 0.26,
    z: -r * 0.34,
    sy: (h * 0.34) / (r * 0.68),
  });
  spines(b, 5, r * 0.58, h * 0.34, r * 0.24, r * 0.08, 221);
  tendrils(b, 4, r * 0.72, h * 0.08, r * 0.32, r * 0.07, 222);
};

const hydraliskDen: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  mound(b, r * 0.9, h * 0.6, 4, 231);
  b.parts.add(torusSegment(r * 0.5, r * 0.14, Math.PI, 10, 6), TONES.plate, { z: r * 0.1 });
  b.parts.add(cone(r * 0.14, h * 0.42, 6, r * 0.05), TONES.energyDim, {
    x: -r * 0.3,
    y: h * 0.2,
    z: r * 0.1,
    rz: 0.5,
  });
  b.parts.add(cone(r * 0.14, h * 0.42, 6, r * 0.05), TONES.energyDim, {
    x: r * 0.3,
    y: h * 0.2,
    z: r * 0.1,
    rz: -0.5,
  });
  spines(b, 5, r * 0.6, h * 0.42, r * 0.26, r * 0.08, 232);
};

const roachWarren: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  mound(b, r * 0.92, h * 0.62, 5, 241);
  b.parts.add(chamferedCylinder(r * 0.34, r * 0.28, h * 0.1, 10), TONES.deep, { y: h * 0.04, z: r * 0.42 });
  for (const side of [1, -1]) {
    b.parts.add(cone(r * 0.16, h * 0.34, 6, r * 0.06), TONES.plate, {
      x: side * r * 0.5,
      y: h * 0.28,
      z: r * 0.2,
      rx: 0.2,
      rz: -side * 0.4,
    });
  }
  spines(b, 6, r * 0.58, h * 0.44, r * 0.24, r * 0.08, 242);
  tendrils(b, 3, r * 0.7, h * 0.12, r * 0.3, r * 0.07, 243);
};

const spire: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  mound(b, r * 0.9, h * 0.28, 4, 251);
  b.parts.add(cone(r * 0.6, h * 0.66, 7, r * 0.3), TONES.hull, { y: h * 0.24 });
  spines(b, 5, r * 0.48, h * 0.4, r * 0.34, r * 0.1, 252);
  b.parts.add(torusSegment(r * 0.34, r * 0.07, Math.PI * 2, 12, 5), TONES.energy, { y: h * 0.58 });
  glowNode(b, h * 0.66, r * 0.2);
  tendrils(b, 4, r * 0.6, h * 0.1, r * 0.4, r * 0.08, 253);
};

const lair: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  mound(b, r, h * 0.78, 6, 261);
  spines(b, 8, r * 0.74, h * 0.4, r * 0.36, r * 0.1, 262);
  spines(b, 4, r * 0.5, h * 0.62, r * 0.3, r * 0.08, 263);
  tendrils(b, 6, r * 0.68, h * 0.18, r * 0.48, r * 0.1, 264);
  b.parts.add(truncatedPyramid(r * 0.6, r * 0.9, r * 0.44, r * 0.6, h * 0.12), TONES.plate, { z: r * 0.52 });
  b.parts.add(taperedBox(r * 0.55, h * 0.16, r * 0.22, 1), TONES.energyDim, { y: h * 0.18, z: r * 0.82 });
  glowNode(b, h * 0.8, r * 0.2);
};

const spineCrawler: BuildingBuilder = (b) => {
  const r = b.radius;
  const h = b.height;
  b.parts.add(sphereLowPoly(r * 0.85, 9, 4), TONES.hull, { y: h * 0.3, sy: (h * 0.6) / (r * 1.7) });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
    b.parts.add(taperedBox(r * 0.2, h * 0.34, r * 0.2, 0.4), TONES.dark, {
      x: Math.cos(a) * r * 0.6,
      z: Math.sin(a) * r * 0.6,
      rx: Math.sin(a) * 0.3,
      rz: -Math.cos(a) * 0.3,
    });
    b.parts.add(taperedBox(r * 0.24, h * 0.06, r * 0.3, 0.8), TONES.deep, {
      x: Math.cos(a) * r * 0.76,
      z: Math.sin(a) * r * 0.76,
    });
  }
  b.parts.add(taperedBox(r * 0.6, h * 0.14, r * 0.5, 0.8), TONES.plate, { y: h * 0.28, z: r * 0.4 });
  spines(b, 5, r * 0.5, h * 0.6, r * 0.28, r * 0.08, 271);
  b.parts.add(cone(r * 0.12, r * 0.4, 5), TONES.energyDim, { y: h * 0.32, z: r * 0.55, rx: 1.27 });
};

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

const BUILDING_BUILDERS: Record<string, BuildingBuilder> = {
  nexus,
  pylon,
  assimilator,
  gateway,
  forge,
  photon_cannon: photonCannon,
  cybernetics_core: cyberneticsCore,
  twilight_council: twilightCouncil,
  robotics_facility: roboticsFacility,
  command_center: commandCenter,
  supply_depot: supplyDepot,
  refinery,
  barracks,
  engineering_bay: engineeringBay,
  factory,
  starport,
  bunker,
  turret,
  hatchery,
  overlord,
  extractor,
  spawning_pool: spawningPool,
  hydralisk_den: hydraliskDen,
  roach_warren: roachWarren,
  spire,
  lair,
  spine_crawler: spineCrawler,
};

/**
 * The shared, reference-counted structure geometry for `typeKey`. Unit keys
 * are dispatched to the unit builders, so this never throws for any of the 57
 * roster keys.
 */
export function buildingGeometry(typeKey: string): THREE.BufferGeometry {
  return geometryCache.acquire(typeKey, buildAnyGeometry);
}

/** Uncached builder for a structure key; throws for unit keys. */
export function buildBuildingGeometry(typeKey: string): THREE.BufferGeometry {
  const def = entityDef(typeKey);
  const builder = BUILDING_BUILDERS[def.key];
  if (!builder || def.kind !== "building") {
    throw new Error(`buildingGeometry(): no builder for roster building "${def.key}"`);
  }
  const build: Build = {
    def,
    radius: def.size.radius,
    height: def.size.height,
    parts: new PartList(),
  };
  builder(build);
  const geometry = build.parts.merge();
  // Buildings must match their collision circle exactly, so anything poking
  // past the radius is pulled in rather than merely trimmed.
  fitFootprint(geometry, def.size.radius, def.size.height, {
    maxOvershoot: 1.0,
    fillHeight: 0.9,
  });
  return geometry;
}
