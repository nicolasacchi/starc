/**
 * Sky dome — owns the sky mesh and the single source of truth for where the
 * sun is.
 *
 * PROVENANCE OF ASSETS: none. The dome is a `SphereGeometry` and the shader in
 * skyMaterial.ts is pure maths; there is no cubemap, no HDR and no PNG.
 *
 * `time_of_day` is 0 at midnight and 0.5 at noon, which is the convention
 * `core/scene.ts` already uses for the fog colour. The sun therefore rises in
 * the east (+X) at t = 0.25, is overhead at t = 0.5 and sets in the west at
 * t = 0.75, travelling along a great circle tilted 24 degrees off the vertical
 * so it does not pass exactly through the zenith — the same reason real sun
 * paths are not straight overhead except at the tropics.
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
import {
  createSkyMaterial,
  sunDiscIntensity,
  sunTransmittance,
  type SkyMaterialHandle,
  type SkyUniforms,
} from "@render/sky/skyMaterial";

/** Degrees the sun's arc is tilted off the vertical, radians. */
const SUN_ARC_TILT = 0.42;

/** Radius in metres. Must exceed the map's half-diagonal by a wide margin. */
const DOME_RADIUS = 800;

/** How hazy each biome's air is. Badlands is a dust storm; the isle is clear. */
const TURBIDITY: Record<string, number> = {
  grassland: 2.8,
  rocky: 3.4,
  badlands: 6.5,
  island: 2.0,
};

const MOON_TINT = new THREE.Color(0.62, 0.72, 1.0);

/** Sun direction for a time of day, midnight at 0, noon at 0.5. */
export function sunDirectionFor(timeOfDay: number, out = new THREE.Vector3()): THREE.Vector3 {
  const theta = (timeOfDay - 0.25) * Math.PI * 2;
  const horizontal = Math.cos(theta);
  return out
    .set(
      horizontal * Math.cos(SUN_ARC_TILT),
      Math.sin(theta),
      horizontal * Math.sin(SUN_ARC_TILT),
    )
    .normalize();
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
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
  private daylight = 1;

  constructor(scene: THREE.Scene, map: MapDef, settings: QualitySettings) {
    this.turbidity = TURBIDITY[map.biome] ?? 2.8;
    this.timeOfDay = THREE.MathUtils.clamp(map.lighting?.time_of_day ?? 0.5, 0, 1);
    // A gibbous moon, different on every map but stable for the match.
    this.moonPhase = 0.55 + 0.42 * Math.abs(Math.sin((map.terrain_seed ?? 1) * 0.0173));

    this.handle = createSkyMaterial({
      turbidity: this.turbidity,
      // The star field's galactic band costs a 3D fBm; the low preset drops it
      // rather than the stars themselves.
      luminance: 0.04,
    });
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
   * The key light's colour: the map's own sun hue, pushed through the same
   * atmospheric extinction the sky shader uses, dimmed towards the horizon and
   * handed over to moonlight at night. It carries the hue and a gentle dimming
   * only — the brightness that goes with it is `sunIntensity()`.
   */
  sunColor(): THREE.Color {
    return this.sunLight;
  }

  /**
   * Key light brightness relative to full noon: 1 overhead, 0 at night (where
   * the moon takes over at a few percent). Pair with `sunColor()`.
   */
  sunIntensity(): number {
    return Math.max(this.daylight * sunDiscIntensity(this.sunDir.y), this.night * 0.05);
  }

  /** 0 by day, 1 at night. Also cross-fades the star field and airglow. */
  nightAmount(): number {
    return this.night;
  }

  /** 0..1 through the day. Anything but 0.5 is a sunrise or a sunset. */
  timeOfDayValue(): number {
    return this.timeOfDay;
  }

  /** Re-derives the sun, moon, colours and night blend from the time of day. */
  setTimeOfDay(timeOfDay: number): void {
    this.timeOfDay = ((timeOfDay % 1) + 1) % 1;
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
    sunDirectionFor(this.timeOfDay, this.sunDir);
    // A full moon is exactly anti-solar; a thinner one lags by its phase.
    sunDirectionFor(this.timeOfDay + this.moonPhase * 0.5, this.moonDir);

    const elevation = this.sunDir.y;
    this.night = smoothstep(0.06, -0.12, elevation);
    this.daylight = smoothstep(-0.04, 0.20, elevation);

    sunTransmittance(elevation, this.turbidity, this.sunLight).multiply(this.sunHue);
    // Keep a floor so the disc never turns black just before it sets, then
    // hand the light over to the moon once the sky does.
    this.sunLight.multiplyScalar(0.25 + 0.75 * this.daylight);
    this.sunLight.lerp(MOON_TINT, this.night * 0.85);

    this.uniforms.uSunDirection.value.copy(this.sunDir);
    this.uniforms.uMoonDirection.value.copy(this.moonDir);
    this.uniforms.uSunDiscColor.value.copy(this.sunHue).multiplyScalar(1 / Math.max(this.sunHue.r, this.sunHue.g, this.sunHue.b, 1e-3));
    this.uniforms.uNight.value = this.night;
  }
}
