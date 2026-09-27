/**
 * Quality presets — the single switchboard every other render module reads.
 *
 * A preset is resolved once at boot from the GPU string, the CPU core count,
 * `navigator.deviceMemory` and the viewport size, and can be forced by the user
 * through `?quality=high` or `localStorage["starc.quality"]`. Nothing here
 * touches the network and no texture is loaded: detection is pure feature
 * probing, and it must never throw (a headless Vitest run has no `navigator`,
 * no `localStorage`, and usually no `WEBGL_debug_renderer_info`).
 */

export type QualityPreset = "low" | "medium" | "high" | "ultra";

export interface QualitySettings {
  shadowMapSize: number;
  postFx: boolean;
  bloom: boolean;
  ssao: boolean;
  motionBlur: boolean;
  anisotropy: number;
  particleBudget: number;
  pixelRatioCap: number;
  terrainLodRings: number;
  shadowCascades: number;
}

/** Every preset, lowest to highest — used by the graphics options menu. */
export const QUALITY_PRESETS: readonly QualityPreset[] = ["low", "medium", "high", "ultra"];

const DEFAULT_PRESET: QualityPreset = "medium";

const STORAGE_KEY = "starc.quality";

export function isQualityPreset(value: unknown): value is QualityPreset {
  return typeof value === "string" && (QUALITY_PRESETS as readonly string[]).includes(value);
}

const SETTINGS: Record<QualityPreset, QualitySettings> = {
  low: {
    shadowMapSize: 0,
    postFx: false,
    bloom: false,
    ssao: false,
    motionBlur: false,
    anisotropy: 1,
    particleBudget: 1024,
    pixelRatioCap: 1,
    terrainLodRings: 2,
    shadowCascades: 1,
  },
  medium: {
    shadowMapSize: 1024,
    postFx: true,
    bloom: true,
    ssao: false,
    motionBlur: false,
    anisotropy: 4,
    particleBudget: 8192,
    pixelRatioCap: 1.25,
    terrainLodRings: 3,
    shadowCascades: 1,
  },
  high: {
    shadowMapSize: 2048,
    postFx: true,
    bloom: true,
    ssao: true,
    motionBlur: true,
    anisotropy: 8,
    particleBudget: 32768,
    pixelRatioCap: 1.5,
    terrainLodRings: 4,
    shadowCascades: 2,
  },
  ultra: {
    shadowMapSize: 4096,
    postFx: true,
    bloom: true,
    ssao: true,
    motionBlur: true,
    anisotropy: 16,
    particleBudget: 200000,
    pixelRatioCap: 2,
    terrainLodRings: 5,
    shadowCascades: 4,
  },
};

/** Immutable settings for a preset. Treat the result as read-only. */
export function settingsFor(preset: QualityPreset): QualitySettings {
  return { ...SETTINGS[preset] ?? SETTINGS[DEFAULT_PRESET] };
}

/* ------------------------------------------------------------------ */
/* Environment probing (never throws)                                  */
/* ------------------------------------------------------------------ */

function safe<T>(fn: () => T, fallback: T): T {
  try {
    const value = fn();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function storage(): Storage | null {
  return safe(() => {
    const ls = globalThis.localStorage;
    return ls ?? null;
  }, null);
}

/**
 * The unmasked GPU string, or "" when the browser refuses the extension (Safari
 * before 17, hardened privacy settings, WebGL disabled). Never throws.
 */
export function gpuRendererString(): string {
  return safe(() => {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("gl")) as WebGLRenderingContext | null;
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL: number } | null;
    if (!ext) return "";
    const name = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as unknown;
    return typeof name === "string" ? name : "";
  }, "");
}

/** The user-forced preset from `?quality=` or localStorage, else null. */
export function forcedQuality(): QualityPreset | null {
  const fromUrl = safe(() => {
    if (typeof location === "undefined" || typeof location.search !== "string") return null;
    const value = new URLSearchParams(location.search).get("quality");
    return isQualityPreset(value) ? value : null;
  }, null);
  if (fromUrl) return fromUrl;
  const fromStorage = safe(() => storage()?.getItem(STORAGE_KEY) ?? null, null);
  return isQualityPreset(fromStorage) ? fromStorage : null;
}

/** Persists a user override so the next boot keeps it. Never throws. */
export function setForcedQuality(preset: QualityPreset | null): void {
  try {
    const ls = storage();
    if (!ls) return;
    if (preset === null) ls.removeItem(STORAGE_KEY);
    else ls.setItem(STORAGE_KEY, preset);
  } catch {
    // Private-mode Safari throws on setItem; the override is only a nicety.
  }
  invalidateQualityCache();
}

const WEAK_GPU = /swiftshader|llvmpipe|softwarerasterizer|software|mesa offscreen|virgl|basic render/i;
const INTEGRATED_GPU = /intel|uhd graphics|hd graphics|iris|apple m[1-9]\b|mali|adreno [1-5]\d\d|powervr|videocore/i;
const STRONG_GPU = /rtx|radeon rx|geforce (gtx 1[0679]|rtx)|apple m[2-9]\b|arc a\d|adreno \(tm\) 6\d\d|adreno \(tm\) 7\d\d/i;

function gpuTier(gpu: string): number | null {
  if (!gpu) return null;
  if (WEAK_GPU.test(gpu)) return -1; // software rasteriser
  if (STRONG_GPU.test(gpu)) return 3; // ultra
  if (INTEGRATED_GPU.test(gpu)) return 1; // medium
  return 2; // unknown discrete — high
}

/**
 * Picks a preset from the machine. Heaviest signal first (the GPU string), then
 * cores, then device memory, then viewport size. Always returns a valid preset.
 */
export function detectQuality(): QualityPreset {
  const forced = forcedQuality();
  if (forced) return forced;

  const scores: number[] = [];
  const gpu = gpuTier(gpuRendererString());
  if (gpu !== null) scores.push(gpu);

  const cores = safe(() => navigator.hardwareConcurrency, 0);
  if (typeof cores === "number" && cores > 0) {
    if (cores <= 2) scores.push(0);
    else if (cores <= 4) scores.push(1);
    else if (cores <= 8) scores.push(2);
    else scores.push(3);
  }

  const memory = safe(() => (navigator as Navigator & { deviceMemory?: number }).deviceMemory, 0);
  if (typeof memory === "number" && memory > 0) {
    if (memory <= 2) scores.push(0);
    else if (memory <= 4) scores.push(1);
    else if (memory <= 8) scores.push(2);
    else scores.push(3);
  }

  const pixels = safe(() => {
    const w = typeof window === "undefined" ? 0 : window.innerWidth;
    const h = typeof window === "undefined" ? 0 : window.innerHeight;
    return w * h * Math.min(window.devicePixelRatio || 1, 3);
  }, 0);
  if (pixels > 0) {
    if (pixels > 6_000_000) scores.push(3);
    else if (pixels > 2_600_000) scores.push(2);
    else if (pixels > 900_000) scores.push(1);
  }

  if (scores.length === 0) return DEFAULT_PRESET;
  // Average the signals: a fast GPU on a 2-core laptop is still not "ultra".
  const total = scores.reduce((a, b) => a + b, 0);
  const avg = total / scores.length;
  const tier = Math.round(avg);
  return QUALITY_PRESETS[Math.min(Math.max(tier, 0), QUALITY_PRESETS.length - 1)];
}

/** Detect once and memoise; the machine does not change mid-session. */
let cached: QualityPreset | null = null;
let cachedForced: QualityPreset | null = null;

export function quality(): QualityPreset {
  const forced = forcedQuality();
  if (forced !== cachedForced) {
    cachedForced = forced;
    cached = null;
  }
  if (cached === null) cached = detectQuality();
  return cached;
}

/** Drops the memoised detection (tests, and the settings menu after a change). */
export function invalidateQualityCache(): void {
  cached = null;
  cachedForced = null;
}
