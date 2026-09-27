/**
 * Terrain height field — the client half of shared/TERRAIN.md.
 *
 * The server's `Starc::Sim::Terrain` implements the identical algorithm; unit
 * Z in every snapshot is authoritative, but the rendered ground must line up
 * with it or units visibly float. Do not "improve" this function.
 */
import type { MapDef } from "@shared/protocol";

const OCTAVES = 5;
const BASE_FREQ = 1 / 48;
const LACUNARITY = 2.0;
const GAIN = 0.5;
const MAX_RELIEF = 6.0;
const WATER_LEVEL = 0.0;
export const AIR_ALTITUDE = 6.0;
const BORDER_FALLOFF = 16.0;

function lattice(ix: number, iz: number, seed: number): number {
  // Exact 32-bit modular arithmetic. `Math.imul` returns the low 32 bits of a
  // product as a signed int, which is precisely what Ruby's `& 0xFFFFFFFF`
  // does. Plain `*` would overflow Float64's 2^53 exact range at
  // 4.29e9 * 1.27e9 = 5.5e18 and silently round, desyncing the two
  // implementations by ~1e-6 — enough to make units visibly float.
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 2654435761)) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = lattice(ix, iz, seed);
  const b = lattice(ix + 1, iz, seed);
  const c = lattice(ix, iz + 1, seed);
  const d = lattice(ix + 1, iz + 1, seed);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uz);
}

/** Raw fBm in [0,1) — the "shade" field before elevation is applied. */
function fbm(x: number, z: number, seed: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = BASE_FREQ;
  for (let o = 0; o < OCTAVES; o++) {
    sum += amp * valueNoise(x * f, z * f, seed);
    norm += amp;
    amp *= GAIN;
    f *= LACUNARITY;
  }
  return sum / norm;
}

/** Height at a single integer lattice point, before grid interpolation. */
function rawHeight(ix: number, iz: number, map: MapDef): number {
  const h = fbm(ix, iz, map.terrain_seed);
  const half = map.size / 2;
  const dx = Math.max(0, Math.abs(ix - half) - (half - BORDER_FALLOFF));
  const dz = Math.max(0, Math.abs(iz - half) - (half - BORDER_FALLOFF));
  const edge = Math.min(1, Math.sqrt(dx * dx + dz * dz) / BORDER_FALLOFF);
  return h * map.elevation * MAX_RELIEF * (1 - edge);
}

/**
 * Metre-resolution height field for one map. The grid is built once (O(size^2)
 * fBm calls) and every later query is a bilinear fetch.
 */
export class HeightField {
  readonly size: number;
  readonly grid: Float64Array;

  constructor(readonly map: MapDef) {
    this.size = map.size;
    const n = map.size + 1;
    this.grid = new Float64Array(n * n);
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        this.grid[iz * n + ix] = rawHeight(ix, iz, map);
      }
    }
  }

  /** Bilinearly interpolated height, clamped to the map bounds. */
  sample(x: number, z: number): number {
    const n = this.size + 1;
    const cx = Math.min(Math.max(x, 0), this.size);
    const cz = Math.min(Math.max(z, 0), this.size);
    const ix = Math.min(Math.floor(cx), this.size - 1);
    const iz = Math.min(Math.floor(cz), this.size - 1);
    const fx = cx - ix;
    const fz = cz - iz;
    const g = this.grid;
    const h00 = g[iz * n + ix];
    const h10 = g[iz * n + ix + 1];
    const h01 = g[(iz + 1) * n + ix];
    const h11 = g[(iz + 1) * n + ix + 1];
    return lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz);
  }

  passable(x: number, z: number): boolean {
    return this.sample(x, z) > WATER_LEVEL;
  }

  /** Surface normal from central differences — used for slope shading. */
  normal(x: number, z: number, eps = 1): { x: number; y: number; z: number } {
    const hl = this.sample(x - eps, z);
    const hr = this.sample(x + eps, z);
    const hd = this.sample(x, z - eps);
    const hu = this.sample(x, z + eps);
    const nx = hl - hr;
    const nz = hd - hu;
    const ny = 2 * eps;
    const len = Math.hypot(nx, ny, nz) || 1;
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  /** 0 = flat, 1 = vertical. Cheap slope term for splat weighting. */
  slope(x: number, z: number, eps = 1): number {
    const n = this.normal(x, z, eps);
    return 1 - n.y;
  }
}

/** Cached per map id — the field is immutable and expensive to build. */
const cache = new Map<string, HeightField>();

export function heightField(map: MapDef): HeightField {
  let field = cache.get(map.id);
  if (!field) {
    field = new HeightField(map);
    cache.set(map.id, field);
  }
  return field;
}
