/**
 * Procedural textures for STARC — generated at runtime, on the CPU, from a
 * seed. This module imports no image, font or data file of any kind: every
 * texture below is a THREE.DataTexture filled with noise the moment the game
 * asks for it, so the client works with the network unplugged.
 *
 * Every generator is deterministic (same arguments → identical bytes) and
 * memoised by its parameter key, so the 57 entity materials share a handful
 * of GPU textures instead of one per model. `disposeTextures()` frees them all.
 *
 * Colour spaces follow the three.js contract: albedo, emissive and ramp maps
 * are sRGB; normal, roughness and raw noise maps are linear data.
 */
import * as THREE from "three";

/* ------------------------------------------------------------------ */
/* Deterministic noise                                                 */
/* ------------------------------------------------------------------ */

function hash2(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2654435761) % 4294967296;
  if (h < 0) h += 4294967296;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) % 4294967296;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise2(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const ux = smooth(x - ix);
  const uy = smooth(y - iy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  const top = a + (b - a) * ux;
  const bottom = c + (d - c) * ux;
  return top + (bottom - top) * uy;
}

function fbm2(x: number, y: number, seed: number, octaves: number, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2(x * freq, y * freq, seed + o * 101);
    norm += amp;
    amp *= gain;
    freq *= 2;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ */
/* Cache plumbing                                                      */
/* ------------------------------------------------------------------ */

const textures = new Map<string, THREE.DataTexture>();

function build(
  key: string,
  size: number,
  bytes: Uint8Array,
  colorSpace: THREE.ColorSpace,
): THREE.DataTexture {
  const texture = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat);
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  texture.name = key;
  textures.set(key, texture);
  return texture;
}

function cached(
  key: string,
  size: number,
  colorSpace: THREE.ColorSpace,
  fill: (bytes: Uint8Array, size: number) => void,
): THREE.DataTexture {
  const hit = textures.get(key);
  if (hit) return hit;
  const bytes = new Uint8Array(size * size * 4);
  fill(bytes, size);
  return build(key, size, bytes, colorSpace);
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

function setPixel(bytes: Uint8Array, index: number, r: number, g: number, b: number, a = 255): void {
  bytes[index] = clamp255(r);
  bytes[index + 1] = clamp255(g);
  bytes[index + 2] = clamp255(b);
  bytes[index + 3] = clamp255(a);
}

/* ------------------------------------------------------------------ */
/* Texture generators                                                  */
/* ------------------------------------------------------------------ */

export interface NoiseOptions {
  seed?: number;
  /** fBm octaves; more is smoother but slower to build. */
  octaves?: number;
}

/**
 * Raw linear noise in four channels: fine grain, medium fBm, ridged noise and
 * a flat white channel. Used as a roughness/AO modulator and as the height
 * source for `normalFromHeight`.
 */
export function noiseTexture(size = 128, opts: NoiseOptions = {}): THREE.DataTexture {
  const seed = opts.seed ?? 1337;
  const octaves = opts.octaves ?? 4;
  return cached(`noise:${size}:${seed}:${octaves}`, size, THREE.NoColorSpace, (bytes, n) => {
    const inv = 1 / n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = x * inv * 8;
        const v = y * inv * 8;
        const fine = valueNoise2(u * 4, v * 4, seed);
        const mid = fbm2(u, v, seed, octaves);
        const ridge = 1 - Math.abs(2 * fbm2(u * 0.5, v * 0.5, seed + 77, 3) - 1);
        const i = (y * n + x) * 4;
        setPixel(bytes, i, fine * 255, mid * 255, ridge * 255, 255);
      }
    }
  });
}

export interface PanelOptions extends NoiseOptions {
  /** Panels across the tile. */
  panels?: number;
  /** 0 = clean, 1 = battle-worn. */
  wear?: number;
  /** Rivet dots on the panel grid. */
  rivets?: boolean;
}

/** Riveted armour plating: panel seams, per-panel shade, grunge and streaks. */
export function metalPanelTexture(size = 256, opts: PanelOptions = {}): THREE.DataTexture {
  const seed = opts.seed ?? 4211;
  const panels = Math.max(1, Math.round(opts.panels ?? 4));
  const wear = opts.wear ?? 0.5;
  const rivets = opts.rivets ?? true;
  return cached(`panel:${size}:${seed}:${panels}:${wear}:${rivets ? 1 : 0}`, size, THREE.SRGBColorSpace, (bytes, n) => {
    const cell = n / panels;
    const shade = new Float32Array(panels * panels);
    for (let i = 0; i < shade.length; i++) shade[i] = (hash2(i % panels, (i / panels) | 0, seed) - 0.5) * 0.16;
    const inv = 1 / n;
    const seam = Math.max(1.2, n / 160);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const cx = Math.floor(x / cell);
        const cy = Math.floor(y / cell);
        const localX = x - cx * cell;
        const localY = y - cy * cell;
        const distEdge = Math.min(localX, cell - localX, localY, cell - localY);
        const seamDark = distEdge < seam ? 0.62 + 0.3 * (distEdge / seam) : 1;
        const u = x * inv;
        const v = y * inv;
        const grunge = fbm2(u * 6, v * 6, seed + 5, 4);
        const streak = fbm2(u * 2, v * 40, seed + 9, 2);
        let lum = 0.55 + (shade[cy * panels + cx] ?? 0);
        lum *= seamDark;
        lum *= 0.9 + grunge * 0.2 - wear * streak * 0.12;
        let rivet = 1;
        if (rivets) {
          const rx = Math.abs(localX - cell * 0.12);
          const ry = Math.abs(localY - cell * 0.12);
          const r = Math.hypot(rx, ry);
          const dot = Math.max(0, 1 - r / (cell * 0.09));
          rivet = 1 + dot * 0.45;
        }
        const base = lum * rivet;
        setPixel(
          bytes,
          (y * n + x) * 4,
          base * 232,
          base * 238,
          base * 250,
          255,
        );
      }
    }
  });
}

export interface ChitinOptions extends NoiseOptions {
  /** Plate scale; smaller reads as finer chitin. */
  cells?: number;
  /** Depth of the pores between plates. */
  pores?: number;
}

/** Zerg carapace: overlapping chitin plates, ridges and pores. */
export function chitinTexture(size = 256, opts: ChitinOptions = {}): THREE.DataTexture {
  const seed = opts.seed ?? 9091;
  const cells = Math.max(1, Math.round(opts.cells ?? 6));
  const pores = opts.pores ?? 0.5;
  return cached(`chitin:${size}:${seed}:${cells}:${pores}`, size, THREE.SRGBColorSpace, (bytes, n) => {
    const inv = 1 / n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = x * inv;
        const v = y * inv;
        const base = fbm2(u * cells, v * cells, seed, 4);
        const ridged = 1 - Math.abs(2 * fbm2(u * cells * 0.5, v * cells * 0.5, seed + 31, 3) - 1);
        const plate = Math.pow(ridged, 1.6);
        const pore = valueNoise2(u * 64, v * 64, seed + 12);
        const pit = pores > 0 ? (pore < 0.18 ? pores * 0.55 : 0) : 0;
        const lum = 0.3 + base * 0.35 + plate * 0.35 - pit;
        const tint = 0.35 + plate * 0.5;
        setPixel(
          bytes,
          (y * n + x) * 4,
          lum * 255 * (0.75 + tint * 0.45),
          lum * 255 * (0.42 + tint * 0.25),
          lum * 255 * (0.4 + tint * 0.3),
          255,
        );
      }
    }
  });
}

export interface EnergyOptions extends NoiseOptions {
  /** Plasma cell scale. */
  cells?: number;
  /** Brightness of the veins between cells. */
  veins?: number;
}

/**
 * Plasma field used for shields, beams and Protoss energy. Dark between the
 * cells, hot along the veins; the material scrolls it with a `uTime` uniform.
 */
export function energyFieldTexture(size = 256, opts: EnergyOptions = {}): THREE.DataTexture {
  const seed = opts.seed ?? 5150;
  const cells = Math.max(1, Math.round(opts.cells ?? 5));
  const veins = opts.veins ?? 1;
  return cached(`energy:${size}:${seed}:${cells}:${veins}`, size, THREE.SRGBColorSpace, (bytes, n) => {
    const inv = 1 / n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = x * inv;
        const v = y * inv;
        const warp = fbm2(u * 3, v * 3, seed, 3);
        const field = fbm2(u * cells + warp * 0.8, v * cells - warp * 0.8, seed + 4, 4);
        const line = Math.pow(1 - Math.abs(2 * field - 1), 3.2);
        const hot = Math.pow(Math.max(0, field - 0.55) * 2.2, 2);
        const lum = Math.min(1, 0.06 + line * 0.75 * veins + hot * 0.6);
        setPixel(
          bytes,
          (y * n + x) * 4,
          lum * 190 + hot * 65,
          lum * 225 + hot * 30,
          255 * Math.min(1, 0.12 + lum * 0.95),
          255,
        );
      }
    }
  });
}

export interface RockOptions extends NoiseOptions {
  /** Strata contrast. */
  layers?: number;
}

/** Weathered rock: layered fBm with cracks and a little lichen mottling. */
export function rockTexture(size = 256, opts: RockOptions = {}): THREE.DataTexture {
  const seed = opts.seed ?? 7702;
  const layers = opts.layers ?? 0.6;
  return cached(`rock:${size}:${seed}:${layers}`, size, THREE.SRGBColorSpace, (bytes, n) => {
    const inv = 1 / n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = x * inv;
        const v = y * inv;
        const strata = fbm2(u * 2.5, v * 9, seed, 5);
        const grain = fbm2(u * 12, v * 12, seed + 21, 4);
        const crack = Math.pow(1 - Math.abs(2 * fbm2(u * 5, v * 5, seed + 44, 3) - 1), 8);
        let lum = 0.42 + strata * layers * 0.35 + grain * 0.18 - crack * 0.3;
        lum = lum < 0.06 ? 0.06 : lum;
        const warm = 0.94 + grain * 0.12;
        setPixel(bytes, (y * n + x) * 4, lum * 255 * warm, lum * 250, lum * 240, 255);
      }
    }
  });
}

export interface StripeOptions extends NoiseOptions {
  /** Band count across the tile. */
  bands?: number;
  /** Band slope; 0 = horizontal-free stripes along X, 1 = fully diagonal. */
  skew?: number;
  /** 0 = hard edge, 1 = soft gradient between bands. */
  feather?: number;
  contrast?: number;
}

/** Even stripes, used for team markings and hazard trim. */
export function stripeTexture(size = 64, opts: StripeOptions = {}): THREE.DataTexture {
  const seed = opts.seed ?? 3141;
  const bands = Math.max(1, Math.round(opts.bands ?? 4));
  const skew = opts.skew ?? 0;
  const feather = opts.feather ?? 0.12;
  const contrast = opts.contrast ?? 0.5;
  return cached(`stripe:${size}:${seed}:${bands}:${skew}:${feather}:${contrast}`, size, THREE.SRGBColorSpace, (bytes, n) => {
    const inv = 1 / n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = x * inv;
        const v = y * inv;
        const t = (u + v * skew) * bands;
        const phase = t - Math.floor(t);
        const edge = Math.min(phase, 1 - phase);
        const soft = feather <= 0 ? (edge > 0 ? 1 : 0) : Math.min(1, edge / feather);
        const grunge = 0.9 + fbm2(u * 8, v * 8, seed, 3) * 0.2;
        const lum = (0.5 + (phase < 0.5 ? contrast : -contrast) * soft) * grunge;
        setPixel(bytes, (y * n + x) * 4, lum * 255, lum * 255, lum * 250, 255);
      }
    }
  });
}

export interface HazardOptions extends NoiseOptions {
  bands?: number;
  /** Stripe direction; 1 is the classic 45-degree caution stripe. */
  skew?: number;
  first?: number;
  second?: number;
}

/** Diagonal caution stripes for landing pads, hatches and moving parts. */
export function hazardStripeTexture(size = 64, opts: HazardOptions = {}): THREE.DataTexture {
  const seed = opts.seed ?? 2718;
  const bands = Math.max(1, Math.round(opts.bands ?? 6));
  const skew = opts.skew ?? 1;
  const a = new THREE.Color(opts.first ?? 0xf0b429);
  const b = new THREE.Color(opts.second ?? 0x141414);
  return cached(`hazard:${size}:${seed}:${bands}:${skew}:${a.getHex()}:${b.getHex()}`, size, THREE.SRGBColorSpace, (bytes, n) => {
    const inv = 1 / n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = x * inv;
        const v = y * inv;
        const t = (u * bands + v * bands * skew) % 1;
        const grunge = 0.86 + fbm2(u * 10, v * 10, seed, 3) * 0.24;
        const mixT = t < 0.5 ? 1 : 0;
        const r = (a.r * mixT + b.r * (1 - mixT)) * grunge;
        const g = (a.g * mixT + b.g * (1 - mixT)) * grunge;
        const bl = (a.b * mixT + b.b * (1 - mixT)) * grunge;
        setPixel(
          bytes,
          (y * n + x) * 4,
          Math.sqrt(r) * 255,
          Math.sqrt(g) * 255,
          Math.sqrt(bl) * 255,
          255,
        );
      }
    }
  });
}

/** A gradient stop: offset in 0..1 paired with an sRGB hex colour. */
export type GradientStop = readonly [number, number];

export interface GradientRampOptions {
  /** Ramp runs top-to-bottom instead of bottom-to-top. */
  flip?: boolean;
  size?: number;
}

/**
 * Vertical colour ramp sampled from the given stops, as a 1×N (tiled) sRGB
 * DataTexture. Two stops make a plain fade, more make a multi-stage ramp.
 */
export function gradientRamp(
  stops: readonly GradientStop[],
  size = 128,
  opts: GradientRampOptions = {},
): THREE.DataTexture {
  if (stops.length === 0) throw new Error("gradientRamp(): at least one stop is required");
  const key = `ramp:${size}:${opts.flip ? 1 : 0}:${stops.map((s) => `${s[0]}:${s[1]}`).join(",")}`;
  return cached(key, size, THREE.SRGBColorSpace, (bytes, n) => {
    const sorted = [...stops].sort((p, q) => p[0] - q[0]).map((s) => ({
      at: s[0],
      color: new THREE.Color(s[1]),
    }));
    const last = sorted.length - 1;
    for (let y = 0; y < n; y++) {
      const t = opts.flip ? y / (n - 1) : 1 - y / (n - 1);
      let lo = sorted[0] as { at: number; color: THREE.Color };
      let hi = sorted[last] as { at: number; color: THREE.Color };
      for (let i = 0; i < last; i++) {
        const from = sorted[i] as { at: number; color: THREE.Color };
        const to = sorted[i + 1] as { at: number; color: THREE.Color };
        if (t >= from.at && t <= to.at) {
          lo = from;
          hi = to;
          break;
        }
      }
      const k = Math.min(1, Math.max(0, (t - lo.at) / Math.max(1e-6, hi.at - lo.at)));
      const r = (lo.color.r + (hi.color.r - lo.color.r) * k) * 255;
      const g = (lo.color.g + (hi.color.g - lo.color.g) * k) * 255;
      const b = (lo.color.b + (hi.color.b - lo.color.b) * k) * 255;
      for (let x = 0; x < n; x++) setPixel(bytes, (y * n + x) * 4, r, g, b, 255);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Normals                                                             */
/* ------------------------------------------------------------------ */

/**
 * Builds a tangent-space normal map from a height field by central
 * differences. Not memoised: the height data belongs to the caller, and
 * caching on `size` alone would hand back the wrong field. The returned
 * texture is owned by the caller and must be disposed with it.
 */
export function normalFromHeight(
  height: ArrayLike<number>,
  size: number,
  strength = 2,
): THREE.DataTexture {
  const bytes = new Uint8Array(size * size * 4);
  const at = (x: number, y: number): number =>
    height[((y + size) % size) * size + ((x + size) % size)] as number;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(-dx, -dy, 1);
      setPixel(
        bytes,
        (y * size + x) * 4,
        (-dx / len * 0.5 + 0.5) * 255,
        (-dy / len * 0.5 + 0.5) * 255,
        (1 / len * 0.5 + 0.5) * 255,
        255,
      );
    }
  }
  const texture = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.name = "normal";
  texture.needsUpdate = true;
  return texture;
}

/**
 * Normal map derived from the shared noise field, memoised like the rest.
 * Cheaper than shipping a second art set for every surface family.
 */
export function noiseNormalTexture(size = 128, strength = 1.6, seed = 1337): THREE.DataTexture {
  const key = `noiseNormal:${size}:${strength}:${seed}`;
  const hit = textures.get(key);
  if (hit) return hit;
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      height[y * size + x] = fbm2((x / size) * 8, (y / size) * 8, seed, 4);
    }
  }
  const texture = normalFromHeight(height, size, strength);
  texture.name = key;
  textures.set(key, texture);
  return texture;
}

/* ------------------------------------------------------------------ */
/* Housekeeping                                                        */
/* ------------------------------------------------------------------ */

/** Every generated texture still alive in the cache. */
export function textureKeys(): string[] {
  return [...textures.keys()];
}

/** Clamps anisotropy on the cached textures once the renderer is known. */
export function setTextureAnisotropy(maxAnisotropy: number): void {
  const level = Math.max(1, Math.min(16, maxAnisotropy));
  for (const texture of textures.values()) texture.anisotropy = level;
}

/** Disposes every cached texture and empties the cache. */
export function disposeTextures(): void {
  for (const texture of textures.values()) texture.dispose();
  textures.clear();
}
