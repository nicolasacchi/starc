/**
 * Splat coverage, measured from the shader's own text.
 *
 * The 4-layer splat in `terrainMaterial.ts` has no unit of its own — it is a
 * dozen lines of GLSL inside a template literal, so the only way to know what
 * the ground actually looks like is to evaluate it. `GLSL_SPLAT_WEIGHTS` is
 * pure arithmetic (no texture fetches), so a small GLSL-subset interpreter
 * runs it over the real field texture of every shipped map: the numbers below
 * are the weights the GPU computes, not a re-derivation of them.
 *
 * What is being defended:
 *  - the four weights sum to 1 and stay in [0, 1] everywhere (a splat that does
 *    not normalise either brightens or darkens the ground as the camera moves);
 *  - each layer actually gets ground. A layer that is everywhere ~0 is not a
 *    layer, and the four layer textures, normals and tints are the per-pixel
 *    cost of a layer that is never seen.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { GLSL_SPLAT_WEIGHTS, createTerrainMaterial } from "./terrainMaterial";
import type { TerrainMaterialHandle } from "./terrainMaterial";
import { settingsFor } from "@render/core/quality";
import { GAME } from "@shared/gameData";
import type { MapDef } from "@shared/protocol";

/* ------------------------------------------------------------------ */
/* A GLSL-subset evaluator, enough for the weight block                */
/* ------------------------------------------------------------------ */

type Scalar = number;
type Vec = { x: number; y: number; z: number; w: number };
type Value = Scalar | Vec;

const SWIZZLE: Record<string, keyof Vec> = {
  x: "x", y: "y", z: "z", w: "w",
  r: "x", g: "y", b: "z", a: "w",
};

const fract = (x: number): number => x - Math.floor(x);
const num = (v: Value): number => (typeof v === "number" ? v : v.x);
const swizzle = (v: Value, s: string): number => {
  const c = SWIZZLE[s];
  if (!c) throw new Error(`unsupported swizzle .${s}`);
  if (typeof v === "number") {
    if (s === "x" || s === "r") return v;
    throw new Error(`cannot swizzle .${s} from a float`);
  }
  return v[c];
};

/** `sc_hash12` from render/core/shaderChunks.ts. */
function hash12(px: number, pz: number): number {
  const x = fract(px * 0.1031);
  const y = fract(pz * 0.1031);
  const z = fract(px * 0.1031);
  const d = x * (y + 33.33) + y * (z + 33.33) + z * (x + 33.33);
  return fract((x + d + (y + d)) * (z + d));
}

/** `sc_vnoise2` from render/core/shaderChunks.ts. */
function vnoise2(px: number, pz: number): number {
  const ix = Math.floor(px);
  const iz = Math.floor(pz);
  const fx = px - ix;
  const fz = pz - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash12(ix, iz);
  const b = hash12(ix + 1, iz);
  const c = hash12(ix, iz + 1);
  const d = hash12(ix + 1, iz + 1);
  const top = a + (b - a) * ux;
  const bot = c + (d - c) * ux;
  return top + (bot - top) * uz;
}

/** `sc_fbm2(p, octaves, lacunarity, gain)`. */
function fbm2(x: number, z: number, octaves: number, gain: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise2(x, z);
    norm += amp;
    x *= 2;
    z *= 2;
    amp *= gain;
  }
  return norm > 0 ? sum / norm : 0;
}

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

const CALLS: Record<string, (...a: number[]) => number> = {
  smoothstep,
  mix: (a, b, t) => a + (b - a) * t,
  clamp: (x, lo, hi) => Math.min(Math.max(x, lo), hi),
  max: (a, b) => Math.max(a, b),
  min: (a, b) => Math.min(a, b),
  abs: Math.abs,
  step: (edge, x) => (x < edge ? 0 : 1),
  pow: (a, b) => Math.pow(a, b),
};

type Scope = Record<string, Value>;

class ExprParser {
  private i = 0;
  constructor(private readonly src: string, private readonly scope: Scope) {}

  parse(): Value {
    const v = this.add();
    if (this.i < this.src.length) {
      throw new Error(`trailing "${this.src.slice(this.i)}" in ${this.src}`);
    }
    return v;
  }

  private skip(): void {
    while (this.i < this.src.length && this.src[this.i] === " ") this.i++;
  }

  private peek(): string {
    this.skip();
    return this.src[this.i] ?? "";
  }

  private eat(ch: string): boolean {
    if (this.peek() === ch) {
      this.i++;
      return true;
    }
    return false;
  }

  private add(): Value {
    let v = this.mul();
    for (;;) {
      const c = this.peek();
      if (c === "+") {
        this.i++;
        v = this.addScalar(v, this.mul());
      } else if (c === "-") {
        this.i++;
        v = this.addScalar(v, this.negate(this.mul()));
      } else return v;
    }
  }

  private negate(v: Value): Value {
    return typeof v === "number" ? -v : { x: -v.x, y: -v.y, z: -v.z, w: -v.w };
  }

  private addScalar(a: Value, b: Value): Value {
    if (typeof a === "number" && typeof b === "number") return a + b;
    const va = typeof a === "number" ? { x: a, y: a, z: a, w: a } : a;
    const vb = typeof b === "number" ? { x: b, y: b, z: b, w: b } : b;
    return { x: va.x + vb.x, y: va.y + vb.y, z: va.z + vb.z, w: va.w + vb.w };
  }

  private mul(): Value {
    let v = this.primary();
    for (;;) {
      const c = this.peek();
      if (c === "*") {
        this.i++;
        v = this.times(v, this.primary());
      } else if (c === "/") {
        this.i++;
        v = this.div(v, this.primary());
      } else return v;
    }
  }

  private times(a: Value, b: Value): Value {
    if (typeof a === "number" && typeof b === "number") return a * b;
    const va = typeof a === "number" ? { x: a, y: a, z: a, w: a } : a;
    const vb = typeof b === "number" ? { x: b, y: b, z: b, w: b } : b;
    return { x: va.x * vb.x, y: va.y * vb.y, z: va.z * vb.z, w: va.w * vb.w };
  }

  private div(a: Value, b: Value): Value {
    if (typeof a === "number" && typeof b === "number") return a / b;
    const va = typeof a === "number" ? { x: a, y: a, z: a, w: a } : a;
    const vb = typeof b === "number" ? { x: b, y: b, z: b, w: b } : b;
    return { x: va.x / vb.x, y: va.y / vb.y, z: va.z / vb.z, w: va.w / vb.w };
  }

  private primary(): Value {
    const c = this.peek();
    if (c === "(") {
      this.i++;
      const v = this.add();
      if (!this.eat(")")) throw new Error(`unclosed ( in ${this.src}`);
      return v;
    }
    if (c === "-") {
      this.i++;
      return this.negate(this.primary());
    }
    if (c === "+") {
      this.i++;
      return this.primary();
    }
    if (c >= "0" && c <= "9") return this.number();
    if (c === ".") return this.number();
    if (/[A-Za-z_]/.test(c)) return this.identifier();
    throw new Error(`unexpected "${c}" in ${this.src}`);
  }

  private number(): number {
    this.skip();
    const m = /^[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/.exec(this.src.slice(this.i));
    if (!m) throw new Error(`not a number in ${this.src}`);
    this.i += m[0].length;
    return Number(m[0]);
  }

  private identifier(): Value {
    this.skip();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.i));
    if (!m) throw new Error(`not an identifier in ${this.src}`);
    const name = m[0];
    this.i += name.length;
    if (this.eat("(")) {
      const args: number[] = [];
      for (;;) {
        args.push(num(this.add()));
        if (this.eat(",")) continue;
        if (this.eat(")")) break;
        throw new Error(`bad call to ${name}`);
      }
      if (name === "vec2") return { x: args[0], y: args[1], z: 0, w: 0 };
      if (name === "vec3") return { x: args[0], y: args[1], z: args[2], w: 0 };
      if (name === "vec4") return { x: args[0], y: args[1], z: args[2], w: args[3] };
      const fn = CALLS[name];
      if (!fn) throw new Error(`unsupported GLSL call ${name}`);
      return fn(...args);
    }
    if (this.eat(".")) {
      const s = /^[A-Za-z]/.exec(this.src.slice(this.i));
      if (!s) throw new Error(`bad swizzle in ${this.src}`);
      this.i += s[0].length;
      const v = this.lookup(name);
      return swizzle(v, s[0]);
    }
    return this.lookup(name);
  }

  private lookup(name: string): Value {
    const v = this.scope[name];
    if (v === undefined) throw new Error(`unknown identifier ${name}`);
    return v;
  }
}

const parseExpr = (src: string, scope: Scope): Value =>
  new ExprParser(src.replace(/\s+/g, " ").trim(), scope).parse();

/** Runs the weight block, returning `[rock, grass, dirt, snow]`. */
function splatWeights(scope: Scope): [number, number, number, number] {
  const src = GLSL_SPLAT_WEIGHTS.replace(/\/\/[^\n]*/g, "");
  for (const statement of src.split(";")) {
    const line = statement.trim();
    if (line === "") continue;
    const assign =
      /^(?:(?:float|vec2|vec3|vec4|int)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(\/\*=|\/=|\*=)\s*([\s\S]+)$/.exec(line) ??
      /^(?:(?:float|vec2|vec3|vec4|int)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(=)\s*([\s\S]+)$/.exec(line);
    if (!assign) throw new Error(`unsupported statement: ${line}`);
    const [, name, op, expr] = assign;
    if (op === "=") {
      scope[name] = parseExpr(expr, scope);
      continue;
    }
    const lhs = scope[name];
    const rhs = parseExpr(expr, scope);
    if (typeof lhs === "number" && typeof rhs === "number") {
      scope[name] = op === "*=" ? lhs * rhs : lhs / rhs;
    } else {
      const l = typeof lhs === "number" ? { x: lhs, y: lhs, z: lhs, w: lhs } : lhs;
      const r = typeof rhs === "number" ? { x: rhs, y: rhs, z: rhs, w: rhs } : rhs;
      scope[name] =
        op === "*="
          ? { x: l.x * r.x, y: l.y * r.y, z: l.z * r.z, w: l.w * r.w }
          : { x: l.x / r.x, y: l.y / r.y, z: l.z / r.z, w: l.w / r.w };
    }
  }
  const w4 = scope.scW4;
  if (typeof w4 === "number") throw new Error("scW4 is not a vec4");
  return [w4.x, w4.y, w4.z, w4.w];
}

/* ------------------------------------------------------------------ */
/* Sampling                                                            */
/* ------------------------------------------------------------------ */

interface GroundSample {
  x: number;
  z: number;
  height: number;
  slope: number;
  macro: number;
}

const LAYERS = ["rock", "grass", "dirt", "snow"] as const;

/** Reads the packed field texture the shader samples. */
function fieldSamples(handle: TerrainMaterialHandle, stride: number): GroundSample[] {
  const data = handle.fieldTexture.image.data as Uint16Array;
  const n = (handle.fieldTexture.image.width as number) - 1;
  const out: GroundSample[] = [];
  for (let j = 0; j < n; j += stride) {
    for (let i = 0; i < n; i += stride) {
      const o = (j * n + i) * 4;
      out.push({
        x: i,
        z: j,
        height: THREE.DataUtils.fromHalfFloat(data[o]),
        slope: THREE.DataUtils.fromHalfFloat(data[o + 3]),
        macro: THREE.DataUtils.fromHalfFloat(data[o + 2]),
      });
    }
  }
  return out;
}


/**
 * Weights for one ground sample at one camera distance, following the shader:
 * the blended splat mask, then the exported weight block.
 */
function weightsAt(s: GroundSample, u: Uniforms, camDist: number): [number, number, number, number] {
  const maskFade = 1 - smoothstep(u.maskNear, u.maskFar, camDist);
  const fine = fbm2(s.x * 0.21, s.z * 0.21, 3, 0.5);
  // GLSL_MAP_FRAGMENT: mix(0.5, scMacro * 0.72 + scFine * 0.28, scMaskFade)
  const blended = s.macro * 0.72 + fine * 0.28;
  const mask = Math.min(Math.max(0.5 + (blended - 0.5) * maskFade, 0), 1);
  return splatWeights({
    scField: { x: s.height, y: 0, z: s.macro, w: s.slope },
    scH: s.height,
    scMask: mask,
    uSnowLine: u.snowLine,
    uRelief: u.relief,
    uWaterLevel: u.water,
    uRockLine: u.rockLine,
    uRockBand: u.rockBand,
    uShoreAmount: u.shoreAmount,
  });
}

/** The subset of the material's uniforms the weight block reads. */
interface Uniforms {
  maskNear: number;
  maskFar: number;
  water: number;
  relief: number;
  snowLine: number;
  rockLine: number;
  rockBand: number;
  shoreAmount: number;
}

function uniformsOf(handle: TerrainMaterialHandle): Uniforms {
  const u = handle.uniforms;
  return {
    maskNear: u.uMaskNear.value as number,
    maskFar: u.uMaskFar.value as number,
    water: u.uWaterLevel.value as number,
    relief: u.uRelief.value as number,
    snowLine: u.uSnowLine.value as number,
    rockLine: u.uRockLine.value as number,
    rockBand: u.uRockBand.value as number,
    shoreAmount: u.uShoreAmount.value as number,
  };
}

/**
 * Per-map coverage: the mean weight each layer gets over the map, and the
 * fraction of samples where it is the largest layer. One entry per camera
 * distance, because the mask's own fade is a function of distance and a splat
 * that collapses only when the camera pulls back is still collapsed.
 */
interface Coverage {
  map: string;
  biome: string;
  camDist: number;
  mean: Record<(typeof LAYERS)[number], number>;
  dominant: Record<(typeof LAYERS)[number], number>;
  minSum: number;
  maxSum: number;
  min: number;
  max: number;
}

const CAMERA_DISTANCES = [40, 150, 400, 900];
/** The RTS rig stands ~70 m up, so the ground under the focus point is ~150 m away. */
const RIG_VIEW_DISTANCE = 150;

function measure(map: MapDef, stride = 3, camDistances: readonly number[] = CAMERA_DISTANCES): Coverage[] {
  const handle = createTerrainMaterial(map, settingsFor("high"));
  const u = uniformsOf(handle);
  const samples = fieldSamples(handle, stride);
  const out: Coverage[] = [];
  for (const camDist of camDistances) {
    const mean: Record<string, number> = { rock: 0, grass: 0, dirt: 0, snow: 0 };
    const dominant: Record<string, number> = { rock: 0, grass: 0, dirt: 0, snow: 0 };
    let minSum = Infinity;
    let maxSum = -Infinity;
    let min = Infinity;
    let max = -Infinity;
    for (const s of samples) {
      const w = weightsAt(s, u, camDist);
      const sum = w[0] + w[1] + w[2] + w[3];
      minSum = Math.min(minSum, sum);
      maxSum = Math.max(maxSum, sum);
      for (let k = 0; k < 4; k++) {
        mean[LAYERS[k]] += w[k];
        min = Math.min(min, w[k]);
        max = Math.max(max, w[k]);
      }
      let best = 0;
      for (let k = 1; k < 4; k++) if (w[k] > w[best]) best = k;
      dominant[LAYERS[best]]++;
    }
    const n = samples.length;
    for (const l of LAYERS) {
      mean[l] /= n;
      dominant[l] /= n;
    }
    out.push({
      map: map.id,
      biome: map.biome,
      camDist,
      mean: mean as Coverage["mean"],
      dominant: dominant as Coverage["dominant"],
      minSum,
      maxSum,
      min,
      max,
    });
  }
  handle.dispose();
  return out;
}

const ALL_MAPS: Coverage[] = GAME.maps.flatMap((m) => measure(m));
const coverageOf = (mapId: string): Coverage => {
  const found = ALL_MAPS.find((c) => c.map === mapId);
  if (!found) throw new Error(`no coverage measured for ${mapId}`);
  return found;
};

describe("terrain splat weights", () => {
  it("sum to one and stay within [0,1] on every map, at every distance", () => {
    for (const c of ALL_MAPS) {
      const where = `${c.map} at ${c.camDist} m`;
      expect(c.minSum, where).toBeGreaterThan(0.9999);
      expect(c.maxSum, where).toBeLessThan(1.0001);
      expect(c.min, where).toBeGreaterThanOrEqual(0);
      expect(c.max, where).toBeLessThanOrEqual(1);
    }
  });

  it("give every layer ground, on every map", () => {
    for (const c of ALL_MAPS) {
      const where = `${c.map} at ${c.camDist} m`;
      for (const l of LAYERS) {
        // A layer that averages a percent of the albedo is not a layer: it is
        // four textures, four normal maps and four tints per pixel for nothing.
        // Dirt is the smallest by design — it is the shoreline band.
        expect(c.mean[l], `${where}: ${l} mean weight`).toBeGreaterThan(0.02);
        // ...and it has to win somewhere, or the layer is only ever a tint on
        // top of another one.
        expect(c.dominant[l], `${where}: ${l} is the largest layer`).toBeGreaterThan(0.005);
      }
    }
  });

  it("order rock coverage the way the maps describe themselves", () => {
    const rock = (id: string): number => coverageOf(id).mean.rock;
    // Chokepoint is "a ring of impassable rock with four gates"; Altaior is
    // "rolling green hills"; Shattered Isle is islands and shallow water. A
    // fixed metres-per-metre slope threshold made the ordering exactly
    // backwards, because it tracked each map's authored `elevation`.
    expect(rock("chokepoint")).toBeGreaterThan(rock("altaior"));
    expect(rock("altaior")).toBeGreaterThan(rock("shattered_isle"));
    expect(rock("cataclysm")).toBeGreaterThan(rock("altaior"));
  });

  it("does not let a map's authored elevation decide its surface", () => {
    // Same seed, same biome, same size — twice the relief. The rock budget is a
    // covered-area fraction of the map's own grade distribution, so the coverage
    // must not move. With the old fixed metres-per-metre slope channel, this
    // same pair measured 0.257 and 0.599: rock coverage was a function of how
    // high the map's `elevation` was, not of what the terrain looked like.
    const base = GAME.maps.find((m) => m.id === "altaior");
    if (!base) throw new Error("altaior missing from the roster");
    const doubled: MapDef = { ...base, id: "altaior-double-elevation", elevation: base.elevation * 2 };
    const [a] = measure(doubled, 3, [RIG_VIEW_DISTANCE]);
    const before = coverageOf("altaior");
    for (const l of LAYERS) {
      expect(a.mean[l], `${l} coverage moved with elevation`).toBeCloseTo(before.mean[l], 2);
    }
  });
});
