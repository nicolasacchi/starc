/**
 * Shared GLSL source chunks.
 *
 * Everything the render stack needs to compile is generated here as plain
 * strings — there is no network fetch, no loader plugin and no `.glsl` file.
 * Terrain, water, sky, units and VFX all splice the *same* strings into their
 * materials so the whole scene agrees on, say, what `fbm2` means and how a
 * colour is transferred to sRGB; otherwise every module drifting a little gives
 * a visible seam at the shoreline.
 *
 * Style rules for the chunks below:
 *  - no `texture2D`/`gl_FragColor`; they are valid in both GLSL ES 1.0 and 3.0,
 *  - no `precision` statements (three injects them),
 *  - no `#version` (three prepends it),
 *  - every function is `sc_`-prefixed so it cannot collide with three's chunks.
 */

import * as THREE from "three";

/* ------------------------------------------------------------------ */
/* Hashes — integer-flavoured, stable across GPUs                      */
/* ------------------------------------------------------------------ */

export const GLSL_HASH = /* glsl */ `
float sc_hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float sc_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float sc_hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 sc_hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 sc_hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
`;

/* ------------------------------------------------------------------ */
/* Value noise + fBm                                                    */
/* ------------------------------------------------------------------ */

export const GLSL_NOISE = /* glsl */ `
float sc_vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = sc_hash12(i);
  float b = sc_hash12(i + vec2(1.0, 0.0));
  float c = sc_hash12(i + vec2(0.0, 1.0));
  float d = sc_hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float sc_vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = sc_hash13(i);
  float n100 = sc_hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = sc_hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = sc_hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = sc_hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = sc_hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = sc_hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = sc_hash13(i + vec3(1.0, 1.0, 1.0));
  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);
  return mix(mix(nx00, nx10, u.y), mix(nx01, nx11, u.y), u.z);
}

float sc_fbm2(vec2 p, int octaves, float lacunarity, float gain) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * sc_vnoise2(p);
    norm += amp;
    p *= lacunarity;
    amp *= gain;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}

float sc_fbm2(vec2 p) {
  return sc_fbm2(p, 4, 2.0, 0.5);
}

float sc_fbm3(vec3 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * sc_vnoise3(p);
    norm += amp;
    p *= 2.0;
    amp *= 0.5;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}

// Ridged multifractal — mountain silhouettes, lava cracks, hull seams.
float sc_ridged2(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(sc_vnoise2(p) * 2.0 - 1.0);
    sum += amp * n * n;
    norm += amp;
    p *= 2.0;
    amp *= 0.5;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}
`;

/** Alias — several modules refer to the noise block as "fbm". */
export const GLSL_FBM = GLSL_NOISE;

/* ------------------------------------------------------------------ */
/* Colour transfer                                                     */
/* ------------------------------------------------------------------ */

export const GLSL_COLOR = /* glsl */ `
float sc_luminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec3 sc_acesFilm(vec3 x) {
  // Narkowicz's ACES fit — cheap, and close to the renderer's tone map.
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 sc_linearToSRGB(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

vec3 sc_srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow(max((c + 0.055) / 1.055, vec3(0.0)), vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}

vec3 sc_saturateColor(vec3 c, float amount) {
  return mix(vec3(sc_luminance(c)), c, amount);
}
`;

/* ------------------------------------------------------------------ */
/* Sky / sun shared uniform block                                       */
/* ------------------------------------------------------------------ */

/** Declarations only — the owning material supplies the uniform values. */
export const GLSL_SKY_UNIFORMS = /* glsl */ `
uniform vec3 uSkyTopColor;
uniform vec3 uSkyHorizonColor;
uniform vec3 uSkyGroundColor;
uniform vec3 uSunDirection;   // world space, pointing towards the sun
uniform vec3 uSunColor;
uniform float uTimeOfDay;     // 0 = midnight, 0.5 = noon
`;

export const GLSL_SKY_FUNCTIONS = /* glsl */ `
// Three-stop vertical gradient with a widened, brighter horizon band.
vec3 sc_skyGradient(vec3 dir) {
  float h = dir.y;
  vec3 upper = mix(uSkyTopColor, uSkyHorizonColor, smoothstep(0.0, 0.35, h));
  vec3 col = mix(uSkyGroundColor, upper, smoothstep(-0.12, 0.02, h));
  // Mie-ish forward scatter around the sun, strongest at the horizon.
  float sunAmount = max(dot(normalize(dir), normalize(uSunDirection)), 0.0);
  float horizonBand = exp(-abs(h) * 6.0);
  col += uSunColor * pow(sunAmount, 8.0) * 0.35 * horizonBand;
  col += uSunColor * pow(sunAmount, 64.0) * 0.6;
  return col;
}

vec3 sc_sunDisk(vec3 dir, float sharpness) {
  float d = max(dot(normalize(dir), normalize(uSunDirection)), 0.0);
  return uSunColor * pow(d, max(sharpness, 1.0));
}
`;

/* ------------------------------------------------------------------ */
/* Screen-space dithering                                               */
/* ------------------------------------------------------------------ */

export const GLSL_DITHER = /* glsl */ `
// Recursive Bayer construction, written without integer bit operations: GLSL
// ES 1.00 has no bit shifts, and three compiles most materials as 1.00 unless
// they opt into GLSL3. Pure float arithmetic costs three instructions more and
// works in both dialects.
float sc_bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x * 0.5 + a.y * a.y * 0.75);
}

float sc_bayer4(vec2 a) {
  return sc_bayer2(0.5 * a) * 0.25 + sc_bayer2(a);
}

// Ordered 8x8 threshold, centred on zero so it can be added directly.
float sc_dither8(vec2 fragCoord) {
  return sc_bayer4(0.5 * fragCoord) * 0.25 + sc_bayer2(fragCoord) - 0.5;
}

// Breaks up banding in the sky gradient and fog; amount is in display units.
vec3 sc_screenDither(vec3 color, vec2 fragCoord, float amount) {
  return color + sc_dither8(fragCoord) * amount;
}
`;

/* ------------------------------------------------------------------ */
/* Depth fade                                                          */
/* ------------------------------------------------------------------ */

export const GLSL_DEPTH_FADE = /* glsl */ `
// 0 at the near plane, 1 at the far plane.
float sc_linearizeDepth(float depth, float near, float far) {
  float z = depth * 2.0 - 1.0;
  return (2.0 * near * far) / (far + near - z * (far - near));
}

// Smooth window between two view-space distances — fades terrain detail,
// decals and shadow blobs out before they alias at the horizon.
float sc_depthFade(float viewDistance, float fadeStart, float fadeEnd) {
  return smoothstep(fadeStart, fadeEnd, viewDistance);
}
`;

/* ------------------------------------------------------------------ */
/* Material-surface helpers (spliced into standard materials)           */
/* ------------------------------------------------------------------ */

export const GLSL_PANEL_LINES = /* glsl */ `
// Rectangular panel grid; returns 1 on the seam, 0 on the plate.
float sc_panelLine(vec2 uv, float scale, float width) {
  vec2 g = abs(fract(uv * scale) - 0.5);
  float edge = min(g.x, g.y);
  return 1.0 - smoothstep(width, width * 2.5, edge);
}
`;

export const GLSL_FRESNEL = /* glsl */ `
float sc_fresnel(vec3 viewDir, vec3 normal, float power) {
  return pow(1.0 - clamp(dot(normalize(viewDir), normalize(normal)), 0.0, 1.0), max(power, 0.001));
}
`;

export const GLSL_EMISSIVE = /* glsl */ `
// Rim pulse used by shields and reactor glow; the caller supplies uTime.
vec3 sc_emissiveScan(vec3 base, vec3 emissive, float t) {
  return base + emissive * (0.65 + 0.35 * sin(t * 3.0));
}
`;

export const GLSL_DETAIL_NOISE = /* glsl */ `
float sc_detailNoise(vec3 worldPos, float scale) {
  return sc_vnoise3(worldPos * scale);
}
`;

/* ------------------------------------------------------------------ */
/* onBeforeCompile injector                                            */
/* ------------------------------------------------------------------ */

export interface ShaderChunkOptions {
  /** Panel-line grid in world space. */
  panel?: boolean;
  /** Rim term added to the emissive channel. */
  fresnel?: boolean;
  /** Pulsing emissive modulation (needs `uTime`). */
  emissive?: boolean;
  /** World-space value noise modulating the diffuse colour (needs `uTime`). */
  detail?: boolean;
  panelScale?: number;
  fresnelPower?: number;
  /** Emissive tint fed to the fresnel/rim and scan terms. */
  rimColor?: THREE.Color;
  /** Master multiplier for every injected effect. */
  strength?: number;
}

export interface ShaderChunkHandle {
  /** Live uniform objects — the compiled program reads these same references. */
  readonly uniforms: Record<string, THREE.IUniform>;
  /** Advances `uTime`. Call once per frame with seconds since start. */
  update(timeSeconds: number): void;
  /** Restores the material's original compile hook. Does not dispose the material. */
  dispose(): void;
}

const U_TIME = "uTime";
const U_CHUNK_SCALE = "uChunkScale";
const U_FRESNEL_POWER = "uFresnelPower";
const U_RIM_COLOR = "uRimColor";
const U_CHUNK_STRENGTH = "uChunkStrength";
const U_WORLD_POS = "scWorldPosition";

/**
 * Splices the surface chunks into any `onBeforeCompile`-capable material
 * (MeshStandardMaterial, MeshPhysicalMaterial, …) so terrain, water, sky and
 * unit hulls all animate identically. The handle owns `uTime`; the program and
 * the handle share one uniform object, so writing it per frame is enough — no
 * material recompile, no per-frame allocation.
 */
export function injectShaderChunks(material: THREE.Material, options: ShaderChunkOptions = {}): ShaderChunkHandle {
  const panel = options.panel === true;
  const fresnel = options.fresnel === true;
  const emissive = options.emissive === true;
  const detail = options.detail === true;
  const needsTime = emissive || detail;
  const needsWorldPos = detail || panel;

  const uniforms: Record<string, THREE.IUniform> = {
    [U_CHUNK_STRENGTH]: { value: options.strength ?? 1 },
    [U_CHUNK_SCALE]: { value: options.panelScale ?? 8 },
    [U_FRESNEL_POWER]: { value: options.fresnelPower ?? 3 },
    [U_RIM_COLOR]: { value: (options.rimColor ?? new THREE.Color(0x66ddff)).clone() },
  };
  if (needsTime || panel || fresnel) uniforms[U_TIME] = { value: 0 };

  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey?.();
  const keySuffix = `sc${panel ? "p" : ""}${fresnel ? "f" : ""}${emissive ? "e" : ""}${detail ? "d" : ""}`;

  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader as never, renderer);
    for (const [name, uniform] of Object.entries(uniforms)) shader.uniforms[name] = uniform;

    const declarations: string[] = [`uniform float ${U_CHUNK_STRENGTH};`, `uniform float ${U_CHUNK_SCALE};`];
    if (needsTime || panel || fresnel) declarations.push(`uniform float ${U_TIME};`);

    if (detail) {
      declarations.push(GLSL_HASH, GLSL_NOISE, GLSL_DETAIL_NOISE);
    }
    if (panel) declarations.push(GLSL_PANEL_LINES);
    if (fresnel) {
      declarations.push(GLSL_FRESNEL, `uniform float ${U_FRESNEL_POWER};`, `uniform vec3 ${U_RIM_COLOR};`);
    }
    if (emissive) declarations.push(GLSL_EMISSIVE, `uniform vec3 ${U_RIM_COLOR};`);

    // The helpers need the world position, so plumb a varying through both
    // stages whenever an effect actually consumes it.
    if (needsWorldPos) {
      declarations.push(`varying vec3 ${U_WORLD_POS};`);
      shader.vertexShader = shader.vertexShader
        .replace("void main() {", `varying vec3 ${U_WORLD_POS};\nvoid main() {`)
        .replace(
          "#include <worldpos_vertex>",
          `#include <worldpos_vertex>\n  ${U_WORLD_POS} = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
        );
    }

    // Everything is injected at one point: right after `emissivemap_fragment`,
    // the earliest place where diffuseColor, the shading `normal`, the
    // view vector and totalEmissiveRadiance all exist.
    const body: string[] = [];
    if (detail) {
      body.push(
        `  float scDetail = sc_detailNoise(${U_WORLD_POS}, ${U_CHUNK_SCALE}.value) - 0.5;`,
        `  diffuseColor.rgb *= 1.0 + scDetail * 0.25 * ${U_CHUNK_STRENGTH}.value;`,
      );
    }
    if (panel) {
      // Projecting on XZ stretches on near-vertical faces, but those are hidden
      // by the silhouette; a proper triplanar needs derivatives this material
      // does not guarantee.
      body.push(
        `  float scPanel = sc_panelLine(${U_WORLD_POS}.xz, ${U_CHUNK_SCALE}.value, 0.02);`,
        `  diffuseColor.rgb *= 1.0 - 0.35 * scPanel * ${U_CHUNK_STRENGTH}.value;`,
      );
    }
    if (fresnel) {
      body.push(
        `  float scRim = sc_fresnel(normalize(-vViewPosition), normal, ${U_FRESNEL_POWER}.value) * ${U_CHUNK_STRENGTH}.value;`,
        `  totalEmissiveRadiance += ${U_RIM_COLOR}.value * scRim * 1.5;`,
      );
    }
    if (emissive) {
      body.push(
        `  totalEmissiveRadiance = sc_emissiveScan(totalEmissiveRadiance, ${U_RIM_COLOR}.value, ${U_TIME}.value * ${U_CHUNK_STRENGTH}.value);`,
      );
    }

    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", `${declarations.join("\n")}\nvoid main() {`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n${body.join("\n")}`);
  };
  material.customProgramCacheKey = () => `${previousKey ?? ""}|${keySuffix}`;
  material.needsUpdate = true;

  return {
    uniforms,
    update(timeSeconds: number) {
      const time = uniforms[U_TIME];
      if (time) time.value = timeSeconds;
    },
    dispose() {
      material.onBeforeCompile = previous;
      material.needsUpdate = true;
    },
  };
}
