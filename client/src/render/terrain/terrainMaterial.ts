/**
 * Terrain surface material — procedural 4-layer splat on top of
 * `MeshStandardMaterial`.
 *
 * PROVENANCE OF ASSETS: there are none. Every texture in this file is a
 * `DataTexture` filled on the CPU at boot from the fBm defined in
 * `shared/TERRAIN.md` (the same lattice hash the height field and the server
 * simulation use, so the surface detail is coherent with the geometry rather
 * than unrelated noise). Nothing is fetched: the module works with the network
 * cable pulled.
 *
 * What is generated:
 *  - `field`  RGBA16F, (size+1)^2: R = height (m), G = curvature (m, concave
 *            positive), B = macro splat mask, A = slope (1 - n.y). Sampled by
 *            BOTH stages: the vertex stage displaces the clipmap, the fragment
 *            stage drives the splat, the wetness band and the macro AO.
 *  - 4 layer albedo maps (RGBA8, repeating): R fine detail, G macro mottle,
 *    B speckle, A crease occlusion. Tinted per biome by uniforms.
 *  - 4 layer normal maps (RGBA8, repeating) derived from the CPU-side gradient
 *    of each layer's noise field. Skipped on the low preset, where they would
 *    cost four extra samplers for detail that is one pixel wide anyway.
 *
 * Splat weighting is a per-pixel blend of height, slope and a two-octave noise
 * mask (the macro mask from the field texture plus an analytic fBm), so the
 * layer boundaries are organic instead of contour-banded. Detail strength,
 * mask amplitude and texture mip bias all fade with camera distance, which is
 * what keeps the far terrain from boiling.
 */
import * as THREE from "three";
import type { MapDef } from "@shared/protocol";
import type { QualitySettings } from "@render/core/quality";
import { heightField } from "@render/terrain/heightfield";
import { GLSL_HASH, GLSL_NOISE } from "@render/core/shaderChunks";

/** Metres. Must agree with `WATER_LEVEL` in shared/TERRAIN.md. */
export const TERRAIN_WATER_LEVEL = 0;

/* ------------------------------------------------------------------ */
/* Noise — the fBm of shared/TERRAIN.md, with a period so it tiles   */
/* ------------------------------------------------------------------ */

function lattice(ix: number, iz: number, seed: number): number {
  const m = 4294967296;
  let h = (ix * 374761393 + iz * 668265263 + seed * 2654435761) % m;
  if (h < 0) h += m;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) % m;
  h = h >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / m;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** `valueNoise` from TERRAIN.md, wrapped to a `period`-cell lattice. */
function tiledValueNoise(x: number, z: number, seed: number, period: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const wx = ((ix % period) + period) % period;
  const wz = ((iz % period) + period) % period;
  const wx1 = (wx + 1) % period;
  const wz1 = (wz + 1) % period;
  const a = lattice(wx, wz, seed);
  const b = lattice(wx1, wz, seed);
  const c = lattice(wx, wz1, seed);
  const d = lattice(wx1, wz1, seed);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uz);
}

/**
 * fBm over the unit square in `cells` lattice cells. Tiles exactly, because
 * every octave wraps on a power-of-two multiple of `cells`.
 */
function tiledFbm(u: number, v: number, seed: number, cells: number, octaves: number, gain: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let c = cells;
  for (let o = 0; o < octaves; o++) {
    sum += amp * tiledValueNoise(u * c, v * c, seed, c);
    norm += amp;
    amp *= gain;
    c *= 2;
  }
  return sum / norm;
}

/** Ridged variant — sharper crests, used for rock strata and creases. */
function tiledRidged(u: number, v: number, seed: number, cells: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let c = cells;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(tiledValueNoise(u * c, v * c, seed + o * 7919, c) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    c *= 2;
  }
  return sum / norm;
}

function clamp255(x: number): number {
  const v = Math.round(x * 255);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/* ------------------------------------------------------------------ */
/* Packed terrain field                                               */
/* ------------------------------------------------------------------ */

interface FieldEntry {
  texture: THREE.DataTexture;
  refs: number;
}

const fieldCache = new Map<string, FieldEntry>();

function buildFieldTexture(map: MapDef): FieldEntry {
  const field = heightField(map);
  const n = field.size + 1;
  const grid = field.grid;
  const data = new Uint16Array(n * n * 4);
  const half = THREE.DataUtils.toHalfFloat;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 4;
      const h = grid[j * n + i];
      const hl = grid[j * n + Math.max(0, i - 1)];
      const hr = grid[j * n + Math.min(n - 1, i + 1)];
      const hd = grid[Math.max(0, j - 1) * n + i];
      const hu = grid[Math.min(n - 1, j + 1) * n + i];
      // Concave positive: valleys and creases darken, ridges catch the light.
      const curvature = h - (hl + hr + hd + hu) * 0.25;
      const slope = 1 - 2 / Math.hypot(hl - hr, 2, hd - hu);
      const mask = tiledFbm(i / n, j / n, (map.terrain_seed ^ 0x51ed) >>> 0, 4, 4, 0.55);
      data[o] = half(h);
      data[o + 1] = half(curvature);
      data[o + 2] = half(mask);
      data[o + 3] = half(slope);
    }
  }

  const texture = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.name = `terrain.field.${map.id}`;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return { texture, refs: 0 };
}

/**
 * The shared height/curvature/mask/slope field. Reference counted because the
 * terrain material and the water plane both need it and must not dispose it out
 * from under each other.
 */
export function acquireTerrainFieldTexture(map: MapDef): THREE.DataTexture {
  let entry = fieldCache.get(map.id);
  if (!entry) {
    entry = buildFieldTexture(map);
    fieldCache.set(map.id, entry);
  }
  entry.refs++;
  return entry.texture;
}

/** Balances one `acquireTerrainFieldTexture`; disposes when the last one goes. */
export function releaseTerrainFieldTexture(map: MapDef): void {
  const entry = fieldCache.get(map.id);
  if (!entry) return;
  entry.refs--;
  if (entry.refs <= 0) {
    entry.texture.dispose();
    fieldCache.delete(map.id);
  }
}

/* ------------------------------------------------------------------ */
/* Per-biome palette                                                  */
/* ------------------------------------------------------------------ */

interface Palette {
  rock: string;
  grass: string;
  dirt: string;
  snow: string;
  grade: string;
  gradeAmount: number;
  snowAmount: number;
  aoStrength: number;
}

const PALETTES: Record<string, Palette> = {
  grassland: {
    rock: "#6b6a63",
    grass: "#6f8a45",
    dirt: "#8a6f4c",
    snow: "#dfe6ee",
    grade: "#cfe0a8",
    gradeAmount: 0.35,
    snowAmount: 0.22,
    aoStrength: 1.5,
  },
  rocky: {
    rock: "#7d7b78",
    grass: "#7c7a4e",
    dirt: "#8a6448",
    snow: "#e8eef4",
    grade: "#d6cfc4",
    gradeAmount: 0.3,
    snowAmount: 0.9,
    aoStrength: 1.9,
  },
  badlands: {
    rock: "#6e4535",
    grass: "#9a8340",
    dirt: "#a85c33",
    snow: "#cbc4bb",
    grade: "#ffb27a",
    gradeAmount: 0.45,
    snowAmount: 0.12,
    aoStrength: 1.6,
  },
  island: {
    rock: "#5c5f5e",
    grass: "#4f8a4a",
    dirt: "#c8b183",
    snow: "#f2f6fa",
    grade: "#bfe6d8",
    gradeAmount: 0.4,
    snowAmount: 0.85,
    aoStrength: 1.4,
  },
};

function paletteFor(map: MapDef): Palette {
  return PALETTES[map.biome] ?? PALETTES.grassland;
}

/* ------------------------------------------------------------------ */
/* Layer textures                                                     */
/* ------------------------------------------------------------------ */

interface LayerSpec {
  /** Lattice cells across one tile — also the tiling period. */
  cells: number;
  octaves: number;
  gain: number;
  /** Tangent normal amplitude. */
  normalStrength: number;
  /** Albedo detail contrast about the mean. */
  contrast: number;
  seedOffset: number;
}

const LAYERS: readonly LayerSpec[] = [
  { cells: 6, octaves: 5, gain: 0.55, normalStrength: 1.5, contrast: 0.5, seedOffset: 101 },
  { cells: 10, octaves: 4, gain: 0.5, normalStrength: 0.8, contrast: 0.34, seedOffset: 211 },
  { cells: 5, octaves: 5, gain: 0.6, normalStrength: 1.0, contrast: 0.42, seedOffset: 307 },
  { cells: 4, octaves: 4, gain: 0.5, normalStrength: 0.45, contrast: 0.18, seedOffset: 409 },
];

/** World metres per tile of each layer. Mirrored by the `scUv*` uniforms. */
export const LAYER_TILE_METRES: readonly number[] = [7, 5, 9, 11];

/**
 * Albedo detail map: R = fine detail, G = macro mottle, B = speckle,
 * A = crease occlusion. Stored around 0.5 so the shader reads it as
 * `value * 2.0` and gets a multiplier with mean 1.
 */
function buildLayerAlbedo(spec: LayerSpec, seed: number, size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const v = j / size;
      const o = (j * size + i) * 4;
      const fine = tiledFbm(u, v, seed, spec.cells, spec.octaves, spec.gain);
      const macro = tiledFbm(u, v, seed + 5501, Math.max(2, spec.cells >> 1), 3, 0.55);
      const speckle = tiledValueNoise(u * spec.cells * 4, v * spec.cells * 4, seed + 911, spec.cells * 4);
      const crease = tiledRidged(u, v, seed + 7717, spec.cells * 2, 3);
      data[o] = clamp255((1 + (fine - 0.5) * 2 * spec.contrast) * 0.5);
      data[o + 1] = clamp255(macro * 0.5 + 0.25);
      data[o + 2] = clamp255(speckle * 0.5 + 0.25);
      data[o + 3] = clamp255(crease);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Tangent-space normal map derived from the same noise field as the albedo. */
function buildLayerNormal(spec: LayerSpec, seed: number, size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      height[j * size + i] = tiledFbm(i / size, j / size, seed, spec.cells, spec.octaves, spec.gain);
    }
  }
  const at = (i: number, j: number): number =>
    height[(((j % size) + size) % size) * size + (((i % size) + size) % size)];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const o = (j * size + i) * 4;
      // Central differences wrapped on the tile, so the normal map has no seam.
      const dx = (at(i + 1, j) - at(i - 1, j)) * spec.normalStrength;
      const dy = (at(i, j + 1) - at(i, j - 1)) * spec.normalStrength;
      const len = Math.hypot(dx, dy, 1);
      data[o] = clamp255(-dx / len * 0.5 + 0.5);
      data[o + 1] = clamp255(-dy / len * 0.5 + 0.5);
      data[o + 2] = clamp255(1 / len * 0.5 + 0.5);
      data[o + 3] = clamp255(at(i, j));
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ */
/* GLSL                                                               */
/* ------------------------------------------------------------------ */

const GLSL_COMMON = /* glsl */ `
uniform sampler2D uField;
uniform float uFieldSpan;      // (map.size + 1)
uniform float uCell0;          // finest clipmap cell, metres
uniform float uRingCount;      // how many clipmap rings exist
uniform float uLevelHalf;      // clipmap level half extent in finest cells
uniform float uWaterLevel;
uniform float uSnowLine;
uniform float uSnowAmount;
uniform float uAoStrength;
uniform vec3 uTintRock;
uniform vec3 uTintGrass;
uniform vec3 uTintDirt;
uniform vec3 uTintSnow;
uniform vec3 uGrade;
uniform float uGradeAmount;
uniform float uDetailNear;
uniform float uDetailFar;
uniform float uMaskNear;
uniform float uMaskFar;
uniform float uNormalStrength;
uniform sampler2D uRockMap;
uniform sampler2D uGrassMap;
uniform sampler2D uDirtMap;
uniform sampler2D uSnowMap;
#ifdef TERRAIN_LAYER_NORMALS
uniform sampler2D uRockNormal;
uniform sampler2D uGrassNormal;
uniform sampler2D uDirtNormal;
uniform sampler2D uSnowNormal;
#endif

vec2 scFieldUV( vec2 wxz ) {
  return ( wxz + 0.5 ) / uFieldSpan;
}

float scHeightAt( vec2 wxz ) {
  return texture2D( uField, scFieldUV( wxz ) ).r;
}
`;

const GLSL_VERTEX_PARS = /* glsl */ `
${GLSL_COMMON}
${GLSL_HASH}
${GLSL_NOISE}
attribute float aLevel;
varying vec3 vTerrWorld;
varying vec3 vTerrNormal;
vec2 gClipmapXZ;
float gClipmapY;
float gClipmapCell;
float gClipmapMorph;
vec3 gTerrNormal;

// --- geometry clipmap: morph this level's outer band onto the parent grid ---
// Every level is centred on the same snapped origin (see terrainMesh.ts), so
// world XZ is already aligned to every level's grid: the CDLOD morph below
// needs no extra uniforms, and it lands the outermost ring of this level
// exactly on the innermost ring of the next one. No cracks, no stitch skirts.
void scClipmap( vec3 pos ) {
  vec2 origin = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xz;
  vec2 local = pos.xz + origin;
  float cell = uCell0 * exp2( aLevel );
  float halfExtent = uCell0 * uLevelHalf * exp2( aLevel );
  float morph = aLevel < uRingCount
    ? smoothstep( 0.66, 1.0, max( abs( local.x ), abs( local.y ) ) / halfExtent )
    : 0.0;
  vec2 grid = local / ( 2.0 * cell );
  vec2 morphed = ( floor( grid ) + mix( fract( grid ), vec2( 0.5 ), morph ) ) * ( 2.0 * cell );
  gClipmapXZ = morph > 0.0 ? morphed : local;
  gClipmapCell = cell;
  gClipmapMorph = morph;
  gClipmapY = scHeightAt( gClipmapXZ );
}
`;

const GLSL_VERTEX_NORMAL = /* glsl */ `
vec3 objectNormal = vec3( normal );
scClipmap( position );
float scEps = gClipmapCell * ( 1.0 + gClipmapMorph );
float scHL = scHeightAt( gClipmapXZ - vec2( scEps, 0.0 ) );
float scHR = scHeightAt( gClipmapXZ + vec2( scEps, 0.0 ) );
float scHD = scHeightAt( gClipmapXZ - vec2( 0.0, scEps ) );
float scHU = scHeightAt( gClipmapXZ + vec2( 0.0, scEps ) );
gTerrNormal = normalize( vec3( scHL - scHR, 2.0 * scEps, scHD - scHU ) );
objectNormal = gTerrNormal;
`;

const GLSL_VERTEX_BEGIN = /* glsl */ `
vec3 transformed = vec3( position.x, gClipmapY, position.z );
vTerrWorld = vec3( gClipmapXZ.x, gClipmapY, gClipmapXZ.y );
vTerrNormal = gTerrNormal;
`;

// The shadow pass runs its own material, so it needs the same displacement or
// the terrain would cast the shadow of a flat plane at y = 0.
const GLSL_DEPTH_BEGIN = /* glsl */ `
scClipmap( position );
vec3 transformed = vec3( position.x, gClipmapY, position.z );
`;

const GLSL_FRAGMENT_PARS = /* glsl */ `
${GLSL_COMMON}
${GLSL_HASH}
${GLSL_NOISE}
varying vec3 vTerrWorld;
varying vec3 vTerrNormal;

// One layer's albedo from a single fetch: R fine detail, G macro mottle,
// B speckle, A crease occlusion.
vec3 scLayerAlbedo( vec4 t, vec3 tint ) {
  float detail = t.r * 2.0;
  float mottle = 0.76 + 0.48 * t.g;
  float speckle = 0.93 + 0.14 * t.b;
  float crease = mix( 0.68, 1.06, t.a );
  return tint * detail * mottle * speckle * crease;
}
`;

/**
 * Replaces `<map_fragment>`. Everything declared here lands in `main()` before
 * `<roughnessmap_fragment>` and `<normal_fragment_maps>`, which is how the
 * staged splat weights, UVs and roughness reach the normal-map stage: all four
 * chunks are spliced at the same brace depth.
 */
const GLSL_MAP_FRAGMENT = /* glsl */ `
vec2 scW = vTerrWorld.xz;
vec4 scField = texture2D( uField, scFieldUV( scW ) );
float scH = scField.r;
float scCamDist = length( vViewPosition );
// Detail fades out with distance, and so does the mask: that is what stops the
// splat boundaries from crawling once a texel is thinner than a pixel.
float scDetail = 1.0 - smoothstep( uDetailNear, uDetailFar, scCamDist );
float scMaskFade = 1.0 - smoothstep( uMaskNear, uMaskFar, scCamDist );
float scBias = ( 1.0 - scDetail ) * 1.6;

float scMacro = scField.b;
float scFine = sc_fbm2( scW * 0.21, 3, 2.0, 0.5 );
float scMask = clamp( mix( 0.5, scMacro * 0.72 + scFine * 0.28, scMaskFade ), 0.0, 1.0 );

vec2 scUvRock = scW / ${LAYER_TILE_METRES[0]}.0;
vec2 scUvGrass = scW / ${LAYER_TILE_METRES[1]}.0;
vec2 scUvDirt = scW / ${LAYER_TILE_METRES[2]}.0;
vec2 scUvSnow = scW / ${LAYER_TILE_METRES[3]}.0;
vec4 scRock = texture2D( uRockMap, scUvRock, scBias );
vec4 scGrass = texture2D( uGrassMap, scUvGrass, scBias );
vec4 scDirt = texture2D( uDirtMap, scUvDirt, scBias );
vec4 scSnow = texture2D( uSnowMap, scUvSnow, scBias );

// --- splat weights: slope drives rock, height drives snow and the beach ---
float scSlope = scField.a + ( scMask - 0.5 ) * 0.30;
float scRockW = smoothstep( 0.16, 0.44, scSlope );
float scSnowW = uSnowAmount
  * smoothstep( uSnowLine - 1.0, uSnowLine + 2.2, scH + ( scMask - 0.5 ) * 2.2 )
  * ( 1.0 - smoothstep( 0.20, 0.46, scSlope ) );
float scDirtW = smoothstep( 2.4, 0.08, scH + ( scMask - 0.5 ) * 1.7 ) * ( 0.5 + 0.5 * scMask );
float scGrassW = 0.5 + 0.5 * scMask;
vec4 scW4 = vec4( scRockW, scGrassW, scDirtW, scSnowW );
scW4 *= scW4;                      // crisper transitions
scW4 /= max( scW4.x + scW4.y + scW4.z + scW4.w, 1e-4 );

vec3 scAlbedo =
    scLayerAlbedo( scRock, uTintRock ) * scW4.x
  + scLayerAlbedo( scGrass, uTintGrass ) * scW4.y
  + scLayerAlbedo( scDirt, uTintDirt ) * scW4.z
  + scLayerAlbedo( scSnow, uTintSnow ) * scW4.w;

// Macro colour grade: slow patches of tinted light, one hue per biome.
float scGradeN = sc_vnoise2( scW * 0.0075 );
scAlbedo *= mix( vec3( 1.0 ), uGrade, uGradeAmount * ( 0.35 + 0.65 * scGradeN ) );

// Curvature ambient occlusion — valleys and creases darken, ridges stay open.
float scAo = 1.0 - clamp( scField.g * uAoStrength, 0.0, 0.8 );
scAo *= 1.0 - 0.18 * smoothstep( 0.35, 0.8, scField.a );
scAlbedo *= scAo;

// Shoreline: below the water line plus a hand's width the ground is wet —
// darker, far smoother, and pulled a little toward the water colour.
float scWet = 1.0 - smoothstep( uWaterLevel, uWaterLevel + 0.35, scH );
scAlbedo *= mix( 1.0, 0.52, scWet );
scAlbedo = mix( scAlbedo, vec3( dot( scAlbedo, vec3( 0.299, 0.587, 0.114 ) ) ) * vec3( 0.72, 0.85, 0.92 ), scWet * 0.35 );

diffuseColor.rgb *= scAlbedo;
float scRoughness = clamp( mix( dot( scW4, vec4( 0.96, 0.88, 0.93, 0.5 ) ), 0.1, scWet ), 0.04, 1.0 );
`;

const GLSL_ROUGHNESS_FRAGMENT = /* glsl */ `
float roughnessFactor = scRoughness;
`;

const GLSL_NORMAL_MAPS = /* glsl */ `
{
  vec3 scN = normalize( vTerrNormal );
  // The terrain is a height field in XZ, so the tangent frame is the world axes
  // projected onto the surface: T points east, B = cross(N, T) points south,
  // which means the texture's +v axis is -B.
  vec3 scT = normalize( vec3( 1.0, 0.0, 0.0 ) - scN * scN.x );
  vec3 scB = cross( scN, scT );
  vec2 scP = vec2( 0.0 );

  #ifdef TERRAIN_LAYER_NORMALS
    vec3 scLn =
        ( texture2D( uRockNormal, scUvRock, scBias ).xyz * 2.0 - 1.0 ) * scW4.x
      + ( texture2D( uGrassNormal, scUvGrass, scBias ).xyz * 2.0 - 1.0 ) * scW4.y
      + ( texture2D( uDirtNormal, scUvDirt, scBias ).xyz * 2.0 - 1.0 ) * scW4.z
      + ( texture2D( uSnowNormal, scUvSnow, scBias ).xyz * 2.0 - 1.0 ) * scW4.w;
    scP += vec2( scLn.x, scLn.y ) * uNormalStrength * scDetail;
  #endif

  if ( scDetail > 0.01 ) {
    // Micro relief: the gradient of a two-octave fBm. This is the piece that
    // makes the ground read as ground when the camera is right on top of it.
    float scE = 0.45;
    float scD0 = sc_fbm2( scW * 0.9, 2, 2.0, 0.5 );
    float scDx = sc_fbm2( ( scW + vec2( scE, 0.0 ) ) * 0.9, 2, 2.0, 0.5 ) - scD0;
    float scDz = sc_fbm2( ( scW + vec2( 0.0, scE ) ) * 0.9, 2, 2.0, 0.5 ) - scD0;
    scP += vec2( -scDx, -scDz ) * ( 5.0 * scDetail );
  }

  // The splat mask is itself a height field, so its gradient is a real bump —
  // two extra fetches from a texture that is already bound for the splat.
  float scME = 2.5;
  float scMx = texture2D( uField, scFieldUV( scW + vec2( scME, 0.0 ) ) ).b - scField.b;
  float scMz = texture2D( uField, scFieldUV( scW + vec2( 0.0, scME ) ) ).b - scField.b;
  scP += vec2( -scMx, -scMz ) * ( 1.6 * scMaskFade );

  vec3 scWorldN = normalize( scN + scT * scP.x - scB * scP.y );
  normal = normalize( ( viewMatrix * vec4( scWorldN, 0.0 ) ).xyz );
}
`;

/* ------------------------------------------------------------------ */
/* Material                                                           */
/* ------------------------------------------------------------------ */

export interface TerrainMaterialHandle {
  readonly material: THREE.MeshStandardMaterial;
  /** The packed height/curvature/mask/slope field, shared with the water plane. */
  readonly fieldTexture: THREE.DataTexture;
  readonly uniforms: Readonly<Record<string, THREE.IUniform>>;
  dispose(): void;
}

export interface TerrainMaterialOptions {
  /** Finest clipmap cell size in metres. Defaults to 1 — the height field's. */
  cell0?: number;
  /** How many clipmap rings exist, so the outermost level does not morph. */
  ringCount?: number;
  /** Cells per clipmap level side; must match terrainMesh.ts. */
  levelCells?: number;
}

export function createTerrainMaterial(
  map: MapDef,
  settings: QualitySettings,
  options: TerrainMaterialOptions = {},
): TerrainMaterialHandle {
  const cell0 = options.cell0 ?? 1;
  const ringCount = options.ringCount ?? 5;
  const levelCells = options.levelCells ?? 96;
  const palette = paletteFor(map);

  const field = heightField(map);
  let maxHeight = 0;
  for (let i = 0; i < field.grid.length; i++) {
    if (field.grid[i] > maxHeight) maxHeight = field.grid[i];
  }

  const useLayerNormals = settings.anisotropy > 1;
  const texSize = settings.anisotropy >= 8 ? 256 : 128;

  const fieldTexture = acquireTerrainFieldTexture(map);
  const albedo: THREE.DataTexture[] = [];
  const normals: THREE.DataTexture[] = [];
  for (let i = 0; i < LAYERS.length; i++) {
    const seed = (map.terrain_seed ^ LAYERS[i].seedOffset) >>> 0;
    const a = buildLayerAlbedo(LAYERS[i], seed, texSize);
    a.name = `terrain.layer${i}.${map.id}`;
    a.anisotropy = settings.anisotropy;
    albedo.push(a);
    if (useLayerNormals) {
      const nrm = buildLayerNormal(LAYERS[i], seed, texSize);
      nrm.name = `terrain.layer${i}Normal.${map.id}`;
      nrm.anisotropy = settings.anisotropy;
      normals.push(nrm);
    }
  }

  const uniforms: Record<string, THREE.IUniform> = {
    uField: { value: fieldTexture },
    uFieldSpan: { value: map.size + 1 },
    uCell0: { value: cell0 },
    uRingCount: { value: ringCount },
    uLevelHalf: { value: levelCells * 0.5 },
    uWaterLevel: { value: TERRAIN_WATER_LEVEL },
    uSnowLine: { value: maxHeight * 0.62 },
    uSnowAmount: { value: palette.snowAmount },
    uAoStrength: { value: palette.aoStrength },
    uTintRock: { value: new THREE.Color(palette.rock) },
    uTintGrass: { value: new THREE.Color(palette.grass) },
    uTintDirt: { value: new THREE.Color(palette.dirt) },
    uTintSnow: { value: new THREE.Color(palette.snow) },
    uGrade: { value: new THREE.Color(palette.grade) },
    uGradeAmount: { value: palette.gradeAmount },
    uDetailNear: { value: 28 },
    uDetailFar: { value: 150 },
    uMaskNear: { value: 70 },
    uMaskFar: { value: 320 },
    uNormalStrength: { value: 0.85 },
    uRockMap: { value: albedo[0] },
    uGrassMap: { value: albedo[1] },
    uDirtMap: { value: albedo[2] },
    uSnowMap: { value: albedo[3] },
  };
  if (useLayerNormals) {
    uniforms.uRockNormal = { value: normals[0] };
    uniforms.uGrassNormal = { value: normals[1] };
    uniforms.uDirtNormal = { value: normals[2] };
    uniforms.uSnowNormal = { value: normals[3] };
  }

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0,
    dithering: true,
  });
  material.name = `terrain.${map.id}`;
  if (useLayerNormals) {
    material.defines = { ...(material.defines ?? {}), TERRAIN_LAYER_NORMALS: "" };
  }

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    // three's own <common> stays: the stock chunks below it use saturate(),
    // PI and the linear-space colour helpers, so mine are appended to it
    // rather than substituted for it.
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${GLSL_VERTEX_PARS}`)
      .replace("#include <beginnormal_vertex>", GLSL_VERTEX_NORMAL)
      .replace("#include <begin_vertex>", GLSL_VERTEX_BEGIN);

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${GLSL_FRAGMENT_PARS}`)
      .replace("#include <map_fragment>", GLSL_MAP_FRAGMENT)
      .replace("#include <roughnessmap_fragment>", GLSL_ROUGHNESS_FRAGMENT)
      .replace("#include <normal_fragment_maps>", GLSL_NORMAL_MAPS);
  };
  material.customProgramCacheKey = (): string => `terrain:${useLayerNormals ? 1 : 0}`;

  return {
    material,
    fieldTexture,
    uniforms,
    dispose(): void {
      material.onBeforeCompile = () => {};
      material.customProgramCacheKey = (): string => "";
      material.dispose();
      for (const t of albedo) t.dispose();
      for (const t of normals) t.dispose();
      releaseTerrainFieldTexture(map);
    },
  };
}

/**
 * The material three renders into the shadow map. It carries the same clipmap
 * morph and the same height-field displacement as the beauty pass, so
 * mountains shadow themselves correctly instead of projecting the shadow of a
 * flat plane. Assigned to `Mesh.customDepthMaterial` by terrainMesh.ts; the
 * caller owns disposing it.
 */
export function createTerrainDepthMaterial(map: MapDef, handle: TerrainMaterialHandle): THREE.MeshDepthMaterial {
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.name = `terrain.depth.${map.id}`;
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, handle.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${GLSL_VERTEX_PARS}`)
      .replace("#include <begin_vertex>", GLSL_DEPTH_BEGIN);
  };
  depth.customProgramCacheKey = (): string => "terrainDepth";
  return depth;
}
