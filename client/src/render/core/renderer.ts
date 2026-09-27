/**
 * WebGL renderer factory.
 *
 * One place decides context attributes, tone mapping, shadow filtering and the
 * pixel-ratio ceiling, so the low preset really is a different renderer and not
 * just fewer lights. No textures or models are loaded here — every asset in the
 * client is generated procedurally at runtime.
 */
import * as THREE from "three";
import type { QualityPreset } from "./quality";
import { settingsFor } from "./quality";

/** Tone-mapped exposure for the whole client; art-directed, not physical. */
export const TONE_MAPPING_EXPOSURE = 1.05;

/**
 * Creates the renderer for a preset. `antialias` is off below `high` — the
 * post chain runs SMAA instead, which is far cheaper than 4x MSAA at 1440p on
 * integrated parts, and the two together would cost twice for nothing.
 */
export function createRenderer(canvas: HTMLCanvasElement, preset: QualityPreset): THREE.WebGLRenderer {
  const settings = settingsFor(preset);
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: preset === "high" || preset === "ultra",
    alpha: false,
    stencil: false,
    depth: true,
    powerPreference: "high-performance",
    // Never let the driver pick a low-power context: the RTS renders every frame.
    failIfMajorPerformanceCaveat: false,
    preserveDrawingBuffer: false,
  });

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = true;

  renderer.shadowMap.enabled = settings.shadowMapSize > 0;
  // PCFShadowMap, not PCFSoftShadowMap. In three 0.186 `shadowMapTypeDefines`
  // only defines PCF and VSM, so PCFSoftShadowMap emits no define at all and
  // the shader falls through to the single-tap BASIC path: hard shadows, and
  // `shadow.radius` ignored. PCF is a 5-tap Vogel disk with hardware PCF (20
  // effective taps) and per-pixel interleaved-gradient rotation, driven by
  // `shadow.radius` — which is both softer and cheaper to control.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = true;

  renderer.info.autoReset = true;
  syncRendererSize(renderer, canvas, settings);
  return renderer;
}

/**
 * Applies the drawing-buffer size for the current `devicePixelRatio`, capped by
 * the preset. Call on boot, on resize, and whenever the window moves between
 * displays — a browser zoom or a monitor switch changes the ratio without a
 * resize event ever firing.
 */

export function syncRendererSize(
  renderer: THREE.WebGLRenderer,
  canvas: HTMLCanvasElement,
  settings: { pixelRatioCap: number },
): void {
  // Node and some headless contexts have no `devicePixelRatio`; fall back to 1.
  const dpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
  renderer.setPixelRatio(Math.min(dpr, settings.pixelRatioCap));
  renderer.setSize(canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height, false);
}
