/**
 * Sky dome — owns the sky mesh and the single source of truth for where the
 * sun is.
 *
 * PROVENANCE OF ASSETS: none. The dome is a `SphereGeometry` and the shader in
 * skyMaterial.ts is pure maths; there is no cubemap, no HDR and no PNG.
 *
 * The sun here is NOT this module's own model. It is `sunStateFor` — the same
 * function the key light in `lighting/lighting.ts` is driven from, so the disc
 * painted in the sky, the direction the shadows fall in and the colour the
 * fog fades to can never disagree. That model reads `time_of_day` as 0 at
 * sunrise, 0.5 at noon and 1 at sunset, and keeps going past 1 into the night
 * arc, so a clock reading past sunset is night on the ground and in the sky
 * at the same time. A second, independent sun model is exactly what this
 * replaces: the dome used to put the sun below the horizon for a map whose
 * key light was still 30 degrees up, and every horizon read wrong.
 *
 * The dome is drawn as a direction field rather than a position: the vertex
 * shader uses the sphere's LOCAL position as the view direction, which makes
 * the sky infinitely far away and parallax-free no matter where the dome's
 * object sits, as long as the sphere is big enough to contain the camera. At
 * 800 m radius and a 256 m map that always holds, so there is nothing to keep
 * in sync per frame and no way for the painted sun to drift away from the
 * light `sunDirection()` hands out.
 */
import * as THREE from "three";
import type { MapDef } from "@shared/protocol";
import type { QualitySettings } from "@render/core/quality";
import { createSunState, sunStateFor } from "@render/lighting/lighting";
import {
  createSkyMaterial,
  type SkyMaterialHandle,
  type SkyUniforms,
} from "@render/sky/skyMaterial";

/** Radius in metres. Must exceed the map's half-diagonal by a wide margin. */
const DOME_RADIUS = 800;

/** How hazy each biome's air is. Badlands is a dust storm; the isle is clear. */
const TURBIDITY: Record<string, number> = {
  grassland: 2.6,
  rocky: 2.4,
  badlands: 4.2,
  island: 2.0,
};

const MOON_TINT = new THREE.Color(0.62, 0.72, 1.0);

/**
 * The phase at which the rig's night arc ends: 2 minus the 0.08 of twilight
 * `lighting.ts` blends over before dawn. Past it the model has begun handing
 * the direction back to the sun, so a disc read there would be a sunrise
 * point rather than a moon.
 */
const MOON_ARC_END = 1.92;

const sunState = createSunState();
const moonState = createSunState();
const mapTint = new THREE.Color();
const groundTint = new THREE.Color().setHex(0x3c3c34, THREE.SRGBColorSpace);

/**
 * Sun direction for a time of day, straight from the rig's model: 0 is
 * sunrise, 0.5 is noon, 1 is sunset, and anything past 1 continues into the
 * night arc with the moon up instead.
 */
export function sunDirectionFor(timeOfDay: number, out = new THREE.Vector3()): THREE.Vector3 {
  sunStateFor(timeOfDay, sunState);
  return out.copy(sunState.direction);
}

export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly uniforms: SkyUniforms;

  private readonly handle: SkyMaterialHandle;
  private readonly sunDir = new THREE.Vector3(0, 1, 0);
  private readonly moonDir = new THREE.Vector3(0, -1, 0);
  private readonly sunHue = new THREE.Color(1, 1, 1);
  private readonly sunLight = new THREE.Color(1, 1, 1);
  private readonly turbidity: number;
  /** The moon's synodic phase, 0 new .. 1 full. Fixed per map. */
  private readonly moonPhase: number;
  private timeOfDay: number;
  private night = 0;
  private intensity = 1;

  constructor(scene: THREE.Scene, map: MapDef, settings: QualitySettings) {
    this.turbidity = TURBIDITY[map.biome] ?? 2.8;
    // Not clamped: past 1 the rig's model continues into the night arc, which
    // is how a map or a scripted clock reaches midnight.
    this.timeOfDay = map.lighting?.time_of_day ?? 0.5;
    // A gibbous moon, different on every map but stable for the match.
    this.moonPhase = 0.55 + 0.42 * Math.abs(Math.sin((map.terrain_seed ?? 1) * 0.0173));
    mapTint.setStyle(map.lighting?.sun_color ?? "#ffffff", THREE.SRGBColorSpace);

    // The exposure is the sky material's own calibrated default; the dome only
    // supplies what actually varies per map.
    this.handle = createSkyMaterial({ turbidity: this.turbidity });
    this.uniforms = this.handle.uniforms;
    this.uniforms.uMoonPhase.value = this.moonPhase;
    this.uniforms.uStarIntensity.value = settings.terrainLodRings >= 3 ? 1 : 0.8;

    const geometry = new THREE.SphereGeometry(DOME_RADIUS, 96, 48);
    this.mesh = new THREE.Mesh(geometry, this.handle.material);
    this.mesh.name = `sky.${map.id}`;
    this.mesh.position.set(map.size * 0.5, 0, map.size * 0.5);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    scene.add(this.mesh);

    this.sunHue.set(map.lighting?.sun_color ?? "#ffffff");
    this.refresh();
  }

  /**
   * Unit vector towards the sun in world space, or towards the moon once the
   * sun is down. Shared instance — read it, do not mutate it.
   */
  sunDirection(): THREE.Vector3 {
    return this.sunDir;
  }

  /**
   * The key light's colour, straight from the rig's sun model: blackbody at
   * this sun's elevation, pulled towards the map's own hue, handed over to
   * moonlight once the sun is down. It carries the hue only — the brightness
   * that goes with it is `sunIntensity()`.
   */
  sunColor(): THREE.Color {
    return this.sunLight;
  }

  /**
   * Key light brightness relative to full noon: 1 overhead, 0 at night (where
   * the moon takes over at a few percent). Pair with `sunColor()`.
   */
  sunIntensity(): number {
    return this.intensity;
  }

  /** 0 by day, 1 at night. Also cross-fades the star field and airglow. */
  nightAmount(): number {
    return this.night;
  }

  /** Through the day: 0 sunrise, 0.5 noon, 1 sunset, 1.5 midnight. */
  timeOfDayValue(): number {
    return this.timeOfDay;
  }

  /**
   * Re-derives the sun, moon, colours and night blend from the time of day.
   * Values are not wrapped: past 1 the clock is in the night arc.
   */
  setTimeOfDay(timeOfDay: number): void {
    this.timeOfDay = timeOfDay;
    this.refresh();
  }

  /**
   * Per-frame: the clock for the star scintillation, and the optional
   * re-centring. The dome's shader does not need the camera, so passing one is
   * purely an optimisation for when the camera leaves the map.
   */
  update(elapsedSeconds: number, cameraPosition?: THREE.Vector3): void {
    this.uniforms.uTime.value = elapsedSeconds;
    if (!cameraPosition) return;
    this.mesh.position.set(cameraPosition.x, 0, cameraPosition.z);
    this.mesh.updateMatrix();
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.handle.dispose();
  }

  private refresh(): void {
    // One model, three consumers: the disc painted here, the key light in
    // lighting.ts and the fog colour all read this same evaluation.
    sunStateFor(this.timeOfDay, sunState, mapTint, groundTint);
    this.sunDir.copy(sunState.direction);
    this.night = sunState.night;
    this.intensity = Math.max(sunState.intensity, this.night * 0.05);

    // A full moon is exactly anti-solar and a gibbous one trails it, so the
    // disc belongs on the key light's own direction: `sunStateFor` is the
    // moon once the sun is down, and the dome's header rule — one model, no
    // second sun — means the disc is that moon and not a fresh evaluation.
    // The lag is a CLOCK offset, so it is taken along the model's night arc
    // rather than across it: the reading is kept inside the two-unit cycle,
    // which is what puts it on the night arc (a reading that ran past 1 would
    // sample the day arc and paint the disc at the sunrise point, half a turn
    // from the moonlight), and is held at the phase where that arc ends,
    // because a lagging moon that has run off the end of it has set.
    const lag = (this.moonPhase - 0.5) * 0.2;
    const cycle = this.timeOfDay - 2 * Math.floor(this.timeOfDay / 2);
    sunStateFor(Math.min(cycle + lag, MOON_ARC_END), moonState, mapTint, groundTint);
    this.moonDir.copy(moonState.direction);

    this.sunLight.copy(sunState.color);
    this.sunLight.lerp(MOON_TINT, this.night * 0.85);

    this.uniforms.uSunDirection.value.copy(this.sunDir);
    this.uniforms.uMoonDirection.value.copy(this.moonDir);
    this.uniforms.uSunDiscColor.value.copy(this.sunHue).multiplyScalar(1 / Math.max(this.sunHue.r, this.sunHue.g, this.sunHue.b, 1e-3));
    this.uniforms.uNight.value = this.night;
  }
}
