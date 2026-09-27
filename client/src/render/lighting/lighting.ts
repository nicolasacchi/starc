/**
 * Key sun, sky bounce and fill for one map's time of day.
 *
 * Every colour here is evaluated in JavaScript from a blackbody (kelvin → RGB)
 * curve plus a small sky model: no LUT, no HDRI, no texture, nothing fetched.
 * `map.lighting.time_of_day` is the single input — 0 is sunrise, 0.5 is noon,
 * 1 is sunset, and anything outside [0,1] continues into the night arc, so a
 * match can animate the clock forward without a special case.
 *
 * The key light is a plain {@link THREE.DirectionalLight} until a
 * {@link ShadowSystem} adopts the key slot (see `adoptKeyLight`), because
 * cascaded shadows have to live on the light that actually illuminates the
 * scene: three multiplies a light's shadow term into that same light's
 * contribution, so a second "shadow only" light would darken nothing.
 */
import * as THREE from "three";
import type { MapDef } from "@shared/protocol";
import type { QualitySettings } from "@render/core/quality";

/** Distance the key light is parked at; only its direction matters. */
const KEY_DISTANCE = 120;
/** Peak solar elevation, radians. A RTS sun stays well off the zenith so
 *  units keep readable, directional shadows. */
const MAX_SUN_ELEVATION = (52 * Math.PI) / 180;
const MAX_MOON_ELEVATION = (42 * Math.PI) / 180;
/** Length of the dawn/dusk crossfade, in `time_of_day` units. */
const TWILIGHT = 0.08;

const SUN_MIN_KELVIN = 1750;
const SUN_MAX_KELVIN = 6600;
const DAY_INTENSITY = 3.4;

const MOON_INTENSITY = 0.34;

/** Seconds of scene time the bounce lights take to come up at match start. */
const LIGHT_FADE_SECONDS = 0.75;

/**
 * Everything the rest of the renderer needs to know about the sky at the
 * current clock: the key light, and the two colours the hemisphere light and
 * the environment probe share so bounce light matches the visible sky.
 */
export interface SunState {
  /** Unit vector pointing from the scene *towards* the light. */
  direction: THREE.Vector3;
  /** Key light colour, already in the renderer's working colour space. */
  color: THREE.Color;
  /** Physical key light strength. */
  intensity: number;
  /** −1 (below the horizon) … 1 (overhead). */
  altitude: number;
  /** 0 = full day, 1 = deep night. */
  night: number;
  /** Zenith and horizon sky colours, shared with the sky dome and the IBL probe. */
  skyZenith: THREE.Color;
  skyHorizon: THREE.Color;
  /** Colour the ground bounces back up into the hemisphere light. */
  ground: THREE.Color;
}

export function createSunState(): SunState {
  return {
    direction: new THREE.Vector3(0, 1, 0),
    color: new THREE.Color(1, 1, 1),
    intensity: 0,
    altitude: 0,
    night: 1,
    skyZenith: new THREE.Color(0, 0, 0),
    skyHorizon: new THREE.Color(0, 0, 0),
    ground: new THREE.Color(0, 0, 0),
  };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function smoothstep01(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** Positive modulo, so the clock can be driven far past any map's start value. */
function wrapPhase(t: number): number {
  const p = t % 2;
  return p < 0 ? p + 2 : p;
}

/**
 * Tanner Helland's blackbody approximation, sRGB in / sRGB out. Written into
 * `out` in the renderer's working (linear) colour space.
 */
function kelvinToColor(kelvin: number, out: THREE.Color): THREE.Color {
  const t = clamp01((Math.min(Math.max(kelvin, 1000), 40000) - 1000) / 39000) * 39 + 1;
  let r: number;
  let g: number;
  let b: number;

  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }

  return out.setRGB(clamp01(r / 255), clamp01(g / 255), clamp01(b / 255), THREE.SRGBColorSpace);
}

/**
 * Ground bounce per biome, so a badlands map does not bounce grass-green light
 * into the underside of every unit. Unknown biomes fall back to neutral soil.
 */
const BIOME_BOUNCE: Readonly<Record<string, number>> = {
  grassland: 0x3f4a2b,
  rocky: 0x4c4740,
  badlands: 0x5c2f1f,
  island: 0x6d6448,
  desert: 0x7a6440,
  volcanic: 0x4a2320,
  urban: 0x43444a,
};

const ZENITH_DAWN = 0x1d2c4d;
const ZENITH_NOON = 0x4f8ad4;
const ZENITH_NIGHT = 0x04060e;
const HORIZON_NIGHT = 0x0c1226;
const MOON_TINT = 0x93a9d8;

const _temp = new THREE.Color();
const _dayColor = new THREE.Color();
const _nightColor = new THREE.Color();
const _dayZenith = new THREE.Color();
const _nightZenith = new THREE.Color();
const _horizon = new THREE.Color();

/**
 * Evaluates the whole sky model for a clock reading into `out`.
 *
 * The day arc and the night arc are both evaluated and cross-faded, so dawn and
 * dusk are continuous rather than a hard swap between an orange sun and a blue
 * moon. The day arc is allowed to run slightly past its ends (negative
 * `dayT`), which is what gives pre-dawn twilight instead of a pop.
 */
export function sunStateFor(timeOfDay: number, out: SunState, mapTint?: THREE.Color, groundTint?: THREE.Color): SunState {
  const phase = wrapPhase(timeOfDay);
  const dayT = phase <= 1 ? phase : phase - 2;
  const nightT = phase <= 1 ? 0 : phase - 1;

  // 1 while the sun is up, 0 while the moon is up, smoothly in between.
  const dayWeight = Math.max(
    1 - smoothstep01((phase - 1) / TWILIGHT),
    smoothstep01((phase - (2 - TWILIGHT)) / TWILIGHT),
  );

  const dayHeight = Math.sin(Math.PI * dayT);
  const dayUp = Math.max(0, dayHeight);
  const elevation = dayHeight * MAX_SUN_ELEVATION;
  const azimuth = (dayT - 0.5) * 2.0 + 0.55;

  // Warm at the horizon, neutral overhead. |2t-1| is 0 at noon and 1 at either
  // horizon, so the exponent controls how fast the ramp cools off.
  const warmth = Math.pow(Math.abs(2 * dayT - 1), 1.2);
  const kelvin = SUN_MIN_KELVIN + (SUN_MAX_KELVIN - SUN_MIN_KELVIN) * (1 - warmth);
  kelvinToColor(kelvin, _dayColor);
  if (mapTint) _dayColor.lerp(mapTint, 0.3);

  const dayIntensity = DAY_INTENSITY * (0.06 + 0.94 * Math.sqrt(dayUp));
  _dayZenith.setHex(ZENITH_DAWN).lerp(_temp.setHex(ZENITH_NOON), dayUp);

  const nightHeight = Math.max(0, Math.sin(Math.PI * nightT));
  const nightIntensity = 0.1 + MOON_INTENSITY * Math.sqrt(nightHeight);
  _nightColor.setHex(MOON_TINT);
  _nightZenith.setHex(ZENITH_NIGHT);

  const w = clamp01(dayWeight);
  out.direction
    .set(Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth))
    .normalize();
  if (w < 1) {
    const nightAzimuth = azimuth + Math.PI;
    _temp
      .set(
        Math.cos(nightHeight * MAX_MOON_ELEVATION) * Math.cos(nightAzimuth),
        Math.sin(nightHeight * MAX_MOON_ELEVATION),
        Math.cos(nightHeight * MAX_MOON_ELEVATION) * Math.sin(nightAzimuth),
      )
      .normalize();
    out.direction.lerp(_temp, 1 - w).normalize();
  }

  out.color.copy(_nightColor).lerp(_dayColor, w);
  out.intensity = nightIntensity + (dayIntensity - nightIntensity) * w;
  out.altitude = dayHeight * (2 * w - 1);
  out.night = 1 - w;

  out.skyZenith.copy(_nightZenith).lerp(_dayZenith, w);
  _horizon.setHex(HORIZON_NIGHT);
  // The horizon is the sun's own colour washed towards the zenith — that is
  // what makes low sun bleed orange across the whole skyline.
  _horizon.lerp(out.skyZenith, 0.25);
  _temp.copy(out.color).lerp(out.skyZenith, 0.6);
  out.skyHorizon.copy(_horizon).lerp(_temp, w);

  if (groundTint) {
    _temp.copy(groundTint).multiplyScalar(0.16 + 0.84 * w);
  } else {
    _temp.setRGB(0.1 * w, 0.1 * w, 0.1 * w);
  }
  out.ground.copy(_temp);

  return out;
}

/** Parks a key light so that light travels along `-dir` through `focus`. */
function placeKeyLight(light: THREE.Light, dir: THREE.Vector3, focus: THREE.Vector3): void {
  if ((light as THREE.DirectionalLight).isDirectionalLight === true) {
    const directional = light as THREE.DirectionalLight;
    directional.target.position.copy(focus);
    directional.target.updateMatrixWorld();
    directional.position.copy(focus).addScaledVector(dir, KEY_DISTANCE);
  } else {
    light.position.copy(dir).multiplyScalar(KEY_DISTANCE);
  }
}

/** Frees a light's shadow map; lights themselves hold no GPU resources. */
function disposeShadow(light: THREE.Light): void {
  const shadowed = light as THREE.DirectionalLight;
  shadowed.shadow?.dispose();
}

/**
 * The lighting rig for one map: one key light, a sky/ground hemisphere bounce
 * and a subtle opposing fill. Cheap enough to update every frame.
 */
export class LightingRig {

  /** The map's key light before a {@link ShadowSystem} adopts the slot. */
  readonly sun: THREE.DirectionalLight;
  /** Sky above / ground below bounce. */
  readonly hemisphere: THREE.HemisphereLight;
  /** A dim hemisphere facing away from the sun; keeps shadowed sides readable. */
  readonly fill: THREE.HemisphereLight;
  /** Point the key light converges on — normally the camera's focus. */
  readonly target: THREE.Object3D;
  /** Live sky model, rewritten by {@link update} and {@link setTimeOfDay}. */
  readonly state: SunState = createSunState();

  private readonly scene: THREE.Scene;
  private readonly mapTint: THREE.Color;
  private readonly groundTint: THREE.Color;
  private readonly focus = new THREE.Vector3();
  private keyLight: THREE.Light;
  private clock: number;
  private fog: THREE.FogExp2 | null = null;
  private lightFade = 0;

  constructor(scene: THREE.Scene, map: MapDef, settings: QualitySettings) {
    this.scene = scene;
    this.mapTint = new THREE.Color().setStyle(map.lighting.sun_color, THREE.SRGBColorSpace);
    this.groundTint = new THREE.Color().setHex(BIOME_BOUNCE[map.biome] ?? 0x3c3c34, THREE.SRGBColorSpace);
    this.clock = map.lighting.time_of_day;

    this.target = new THREE.Object3D();
    scene.add(this.target);

    this.sun = new THREE.DirectionalLight(0xffffff, 0);
    this.sun.target = this.target;
    this.sun.name = "key-sun";
    this.keyLight = this.sun;
    scene.add(this.sun);

    this.hemisphere = new THREE.HemisphereLight(0x8899bb, 0x2a2a22, 0);
    this.hemisphere.name = "sky-bounce";
    scene.add(this.hemisphere);

    this.fill = new THREE.HemisphereLight(0x667799, 0x101014, 0);
    this.fill.name = "fill";
    scene.add(this.fill);

    if (scene.fog instanceof THREE.FogExp2) this.fog = scene.fog;

    // The low preset drops the bounce lights rather than the key: without a
    // sun the scene is unreadable, without a fill it is merely moodier.
    if (settings.postFx === false) {
      this.fill.intensity = 0;
      this.fill.visible = false;
    }

    // Published so the shadow system and the environment probe can find the
    // key light without every caller having to thread the rig through.
    scene.userData[RIG_KEY] = this;
    this.setTimeOfDay(this.clock);
  }

  /** Unit vector from the scene towards the key light. */
  get sunDirection(): THREE.Vector3 {
    return this.state.direction;
  }

  /** Key light colour (linear working space). */
  get sunColor(): THREE.Color {
    return this.state.color;
  }

  /** Key light strength. */
  get sunIntensity(): number {
    return this.state.intensity;
  }

  /** 0 at midday, 1 in deep night. */
  get night(): number {
    return this.state.night;
  }

  /** The clock this rig was last evaluated at. */
  get timeOfDay(): number {
    return this.clock;
  }

  /**
   * Hands the key-light slot to a cascaded sun. The rig keeps driving the
   * light's colour, intensity and direction, so a shadow system can swap in a
   * light that carries shadow cascades without the two disagreeing.
   */
  adoptKeyLight(light: THREE.Light): void {
    if (this.keyLight === light) return;
    this.scene.remove(this.keyLight);
    this.keyLight = light;
    this.scene.add(light);
    this.applyKey();
  }

  /** Puts the rig's own directional light back and drops the adopted one. */
  restoreKeyLight(): void {
    if (this.keyLight === this.sun) return;
    const adopted = this.keyLight;
    this.keyLight = this.sun;
    this.scene.remove(adopted);
    this.scene.add(this.sun);
    this.applyKey();
  }

  /** Moves the point the key light converges on (usually the camera focus). */
  setFocus(x: number, z: number, y: number): void {
    this.focus.set(x, y, z);
    this.applyKey();
  }

  /** Jumps the clock. Continuous across the dawn/dusk crossfade. */
  setTimeOfDay(timeOfDay: number): void {
    this.clock = timeOfDay;
    this.evaluate();
  }

  /** Advances the rig. `elapsed` is seconds since the match started. */
  update(elapsed: number): void {
    // The bounce lights fade up over the first moments of a match, so the very
    // first frames are not lit by whatever the last clock reading left behind.
    this.lightFade = clamp01(elapsed / LIGHT_FADE_SECONDS);
    this.evaluate();
  }

  private evaluate(): void {
    const state = sunStateFor(this.clock, this.state, this.mapTint, this.groundTint);
    this.applyKey();

    const day = 1 - state.night;
    this.hemisphere.color.copy(state.skyHorizon);
    this.hemisphere.groundColor.copy(state.ground);
    this.hemisphere.intensity = (0.12 + 0.42 * day) * this.lightFade;

    this.fill.color.copy(state.skyZenith).lerp(state.skyHorizon, 0.5);
    this.fill.groundColor.copy(state.ground).multiplyScalar(0.4);
    this.fill.intensity = (0.08 + 0.2 * day) * this.lightFade;
    this.fill.position.set(-state.direction.x, 0.5, -state.direction.z).normalize().multiplyScalar(50);

    if (this.fog) this.fog.color.copy(state.skyHorizon).lerp(state.skyZenith, 0.35);
  }

  private applyKey(): void {
    const light = this.keyLight;
    light.color.copy(this.state.color);
    light.intensity = this.state.intensity;
    placeKeyLight(light, this.state.direction, this.focus);
  }

  dispose(): void {
    this.scene.remove(this.sun);
    this.scene.remove(this.hemisphere);
    this.scene.remove(this.fill);
    this.scene.remove(this.target);
    this.scene.remove(this.keyLight);
    disposeShadow(this.sun);
    if (this.keyLight !== this.sun) disposeShadow(this.keyLight);
    if (this.scene.userData[RIG_KEY] === this) delete this.scene.userData[RIG_KEY];
  }
}

/** Where the rig publishes itself on the scene. */
const RIG_KEY = "lightingRig";

/**
 * The lighting rig for a scene, if one has been constructed. The shadow system
 * and the environment probe use this so a caller only has to hand them the
 * scene; pass the rig explicitly if it is not the one on that scene.
 */
export function lightingRigFor(scene: THREE.Scene): LightingRig | null {
  const rig = scene.userData[RIG_KEY];
  return rig instanceof LightingRig ? rig : null;
}
