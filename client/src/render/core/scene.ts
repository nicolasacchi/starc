/**
 * Scene construction and teardown.
 *
 * The scene owns three things the rest of the renderer builds on: the fog the
 * world fades into, the scaffold lighting every mesh registers against, and a
 * disposal walk. `lighting.ts` refines the scaffold (sun, shadows, biome
 * bounce); it reads the named lights off `scene.userData.lights` so it can tune
 * them without re-deriving the setup.
 *
 * Nothing is loaded: no HDR environment, no skybox texture — the sky dome
 * (sky module) paints the background, which is why `scene.background` stays
 * null.
 */
import * as THREE from "three";
import type { MapDef } from "@shared/protocol";
import type { QualitySettings } from "./quality";

/** Key under which the scaffold lights are published for `lighting.ts`. */
export const LIGHTS_KEY = "lights";

export interface SceneLightScaffold {
  /** Key light — placed by `lighting.ts` from the map's sun colour. */
  sun: THREE.DirectionalLight;
  /** Sky/ground bounce, re-tinted per biome by `lighting.ts`. */
  hemisphere: THREE.HemisphereLight;
  /** Flat floor so nothing is ever fully black before the bounce light lands. */
  ambient: THREE.AmbientLight;
}

/**
 * Fog colour for a map's time of day: warm and bright at the horizon near the
 * sun, cold and dense at midnight. The map's own sun colour is mixed in so the
 * fog and the key light never disagree.
 */
export function fogColorFor(map: MapDef): THREE.Color {
  const timeOfDay = THREE.MathUtils.clamp(map.lighting?.time_of_day ?? 0.5, 0, 1);
  const sun = new THREE.Color(map.lighting?.sun_color ?? "#ffffff");
  // time 0.5 (noon) -> pale white-blue; 0/1 (midnight) -> deep indigo.
  const night = new THREE.Color(0x0a0f1e);
  const day = new THREE.Color(0x9fb4c8);
  const dusk = new THREE.Color(0x6a4a52);
  const solar = Math.abs(timeOfDay - 0.5) * 2; // 0 at noon, 1 at either horizon
  const base = night.clone().lerp(day, 1 - solar);
  if (solar > 0) base.lerp(dusk, (solar - 0.5) * 2 * 0.6);
  return base.lerp(sun, 0.35);
}

/**
 * Builds the scene for a map: exponential fog plus the light scaffold.
 *
 * `scene.background` is deliberately null — the sky dome renders first and owns
 * the visible background, and a scene background would both fight it and block
 * the dome from writing its gradient.
 */
export function createScene(map: MapDef, settings: QualitySettings): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = null;

  const fog = new THREE.FogExp2(fogColorFor(map).getHex(), Math.max(0, map.lighting?.fog_density ?? 0.012));
  scene.fog = fog;

  const sunColor = new THREE.Color(map.lighting?.sun_color ?? "#fff2d0");
  const sun = new THREE.DirectionalLight(sunColor, settings.shadowMapSize > 0 ? 2.6 : 2.0);
  sun.position.set(map.size * 0.5 + 80, 120, map.size * 0.5 - 40);
  sun.target.position.set(map.size * 0.5, 0, map.size * 0.5);
  scene.add(sun);
  scene.add(sun.target);

  const hemisphere = new THREE.HemisphereLight(0x9fc4ff, 0x4a3b2c, 0.85);
  scene.add(hemisphere);

  const ambient = new THREE.AmbientLight(0xffffff, 0.25);
  scene.add(ambient);

  const lights: SceneLightScaffold = { sun, hemisphere, ambient };
  scene.userData[LIGHTS_KEY] = lights;
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
