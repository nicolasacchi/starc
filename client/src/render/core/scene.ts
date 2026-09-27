/**
 * Scene construction and teardown.
 *
 * The scene owns two things the rest of the renderer builds on: the fog the
 * world fades into, and a disposal walk. Lighting is NOT set up here —
 * `lighting.ts` owns every light in the scene and derives all of them from the
 * map's time of day, so a second "scaffold" set would only double the key
 * light and wash the ground out.
 *
 * Nothing is loaded: no HDR environment, no skybox texture — the sky dome
 * (sky module) paints the background, which is why `scene.background` stays
 * null.
 */
import * as THREE from "three";
import type { MapDef } from "@shared/protocol";
import type { QualitySettings } from "./quality";
import { createSunState, sunStateFor } from "@render/lighting/lighting";

/**
 * Converts a map's authored `fog_density` into the coefficient this client
 * actually renders with.
 *
 * The authored numbers are FogExp2 coefficients written for a camera standing
 * on the ground. The RTS camera is ~70 m up, so the *nearest* ground in frame
 * is already 40–90 m away and the far field runs past 400 m; at the authored
 * 0.012 the extinction is 50% at 58 m and 99.9% at 200 m, which fogs the whole
 * playfield into a flat wash of fog colour and hides the horizon.
 *
 * Grassland then wants half extinction near 300 m and ~90% past 560 m, which
 * is just beyond where the clipmap's cover radius puts its outer edge: the far
 * field dissolves into the haze instead of ending at a visible rim, and the
 * mid-field keeps the landforms the haze is supposed to sit behind.
 */
export const FOG_DENSITY_SCALE = 0.23;

/**
 * Fog colour for a map's time of day, taken from the same sky evaluation the
 * lighting rig and the sky dome use, so the haze can never disagree with the
 * horizon behind it. `LightingRig` refreshes `scene.fog.color` from the same
 * state every frame; this is the value the scene starts life with, so a scene
 * with no rig is still fogged in the right colour.
 */
export function fogColorFor(map: MapDef): THREE.Color {
  const timeOfDay = THREE.MathUtils.clamp(map.lighting?.time_of_day ?? 0.5, 0, 1);
  const mapTint = new THREE.Color().setStyle(map.lighting?.sun_color ?? "#ffffff", THREE.SRGBColorSpace);
  const state = sunStateFor(timeOfDay, createSunState(), mapTint);
  return state.skyHorizon.clone().lerp(state.skyZenith, 0.35);
}

/**
 * Builds the scene for a map: exponential fog and nothing else.
 *
 * `scene.background` is deliberately null — the sky dome renders first and owns
 * the visible background, and a scene background would both fight it and block
 * the dome from writing its gradient.
 */
export function createScene(map: MapDef, settings: QualitySettings): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = null;

  const density = Math.max(0, map.lighting?.fog_density ?? 0.012) * FOG_DENSITY_SCALE;
  scene.fog = new THREE.FogExp2(fogColorFor(map).getHex(), density);

  scene.userData.mapId = map.id;
  scene.userData.settings = settings;
  return scene;
}

/**
 * Walks a scene and releases every GPU resource it owns: render targets, then
 * geometries, materials and every texture reachable from a material. Shared
 * geometries and materials are only disposed once — three has no refcount, so
 * the walk tracks what it has already seen and leaves foreign (still mounted)
 * resources for their owner to release.
 */
export function disposeScene(scene: THREE.Scene, options: { sharedResources?: Set<THREE.BufferGeometry | THREE.Material | THREE.Texture> } = {}): void {
  const seen = options.sharedResources ?? new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();

  scene.traverse((object) => {
    const mesh = object as Partial<THREE.Mesh> & THREE.Object3D;
    if (mesh.geometry && !seen.has(mesh.geometry)) {
      seen.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    const material = mesh.material;
    if (!material) return;
    const list = Array.isArray(material) ? material : [material];
    for (const entry of list) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      for (const value of Object.values(entry as unknown as Record<string, unknown>)) {
        if (value instanceof THREE.Texture && !seen.has(value)) {
          seen.add(value);
          value.dispose();
        }
      }
      entry.dispose();
    }
  });

  for (const child of [...scene.children]) scene.remove(child);
  scene.clear();
  scene.fog = null;
  scene.background = null;
  scene.userData = {};
}
