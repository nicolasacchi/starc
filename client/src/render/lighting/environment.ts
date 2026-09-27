/**
 * Image-based lighting without an HDRI file.
 *
 * A small cube map is rendered once from a procedural sky — the same zenith /
 * horizon / ground model the lighting rig evaluates, plus a sun disc — and then
 * run through `PMREMGenerator` so every PBR material in the scene gets correct
 * rough and mirror reflections. Everything is generated at runtime; the network
 * is never touched.
 *
 * The build is deferred to the first `update()` so the probe can be constructed
 * in a context with no WebGL (tests, a menu scene) and simply does nothing
 * there. A failed build latches off rather than retrying every frame.
 */
import * as THREE from "three";
import type { MapDef } from "@shared/protocol";
import type { QualitySettings } from "@render/core/quality";
import type { LightingRig } from "./lighting";

/** Never rebuild more often than this, however fast the clock moves. */
const REBUILD_INTERVAL = 0.25;
/** Radians of sun travel that force a rebuild. */
const SUN_MOVEMENT_EPSILON = 0.01;

const SKY_VERT = /* glsl */ `
varying vec3 vDirection;
void main() {
  vDirection = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColour;
uniform vec3 uSunDirection;
uniform float uSunSize;
uniform float uSunPower;
uniform float uNight;
varying vec3 vDirection;

void main() {
  vec3 dir = normalize( vDirection );
  float height = dir.y;

  vec3 sky = mix( uHorizon, uZenith, pow( clamp( height, 0.0, 1.0 ), 0.55 ) );
  vec3 colour = mix( sky, uGround, smoothstep( 0.0, -0.22, height ) );

  // Sun (or moon) disc plus the two-lobe glow that sells a low sun.
  float cosAngle = dot( dir, uSunDirection );
  float disc = smoothstep( uSunSize, uSunSize + 0.004, cosAngle );
  float glow = pow( max( cosAngle, 0.0 ), 160.0 ) * 0.9 + pow( max( cosAngle, 0.0 ), 6.0 ) * 0.05;
  float power = uSunPower * mix( 0.15, 1.0, 1.0 - uNight );
  colour += uSunColour * ( disc * 26.0 + glow ) * power;

  // Stars, fading in with the night, from a cheap hash of the direction.
  float stars = step( 0.9975, hash13( floor( dir * 420.0 ) ) ) * uNight;
  colour += vec3( 0.8, 0.85, 1.0 ) * stars * 1.5;

  gl_FragColor = vec4( colour, 1.0 );
}
`;

/** Cheap 3D hash; the sky cube only needs a few thousand invocations. */
const SKY_HASH = /* glsl */ `
float hash13( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.yzx + 33.33 );
  return fract( ( p.x + p.y ) * p.z );
}
`;

const SKY_FRAG_WITH_HASH = SKY_FRAG.replace(
  "varying vec3 vDirection;",
  `${SKY_HASH}\nvarying vec3 vDirection;`,
);

/**
 * A procedural sky cube feeding `scene.environment`.
 *
 * Regenerate whenever the clock moves enough to matter, throttled so a
 * time-lapse does not rebuild the probe on every frame.
 */
export class EnvironmentProbe {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly rig: LightingRig;
  private readonly cubeTarget: THREE.WebGLCubeRenderTarget;
  private readonly cubeCamera: THREE.CubeCamera;
  private readonly skyScene: THREE.Scene;
  private readonly material: THREE.ShaderMaterial;
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly boxGeometry: THREE.BufferGeometry;
  private readonly uniforms: {
    uZenith: { value: THREE.Color };
    uHorizon: { value: THREE.Color };
    uGround: { value: THREE.Color };
    uSunColour: { value: THREE.Color };
    uSunDirection: { value: THREE.Vector3 };
    uSunSize: { value: number };
    uSunPower: { value: number };
    uNight: { value: number };
  };
  private environment: THREE.Texture | null = null;
  private environmentTarget: THREE.WebGLRenderTarget | null = null;
  private lastTimeOfDay = Number.NaN;
  private lastSun = new THREE.Vector3(0, -1, 0);
  private sinceRebuild = REBUILD_INTERVAL;
  private failed = false;
  private disposed = false;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    map: MapDef,
    settings: QualitySettings,
    rig: LightingRig,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.rig = rig;

    const size = settings.postFx ? 256 : 128;
    this.cubeTarget = new THREE.WebGLCubeRenderTarget(size, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.cubeTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.cubeTarget.texture.name = "procedural-sky";

    this.uniforms = {
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uGround: { value: new THREE.Color() },
      uSunColour: { value: new THREE.Color() },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uSunSize: { value: Math.cos(0.02) },
      uSunPower: { value: 1 },
      uNight: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG_WITH_HASH,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });

    this.boxGeometry = new THREE.BoxGeometry(2, 2, 2);
    this.skyScene = new THREE.Scene();
    this.skyScene.add(new THREE.Mesh(this.boxGeometry, this.material));

    this.cubeCamera = new THREE.CubeCamera(0.1, 10, this.cubeTarget);
    this.cubeCamera.position.set(map.size * 0.5, 2, map.size * 0.5);
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  /** Forces the next `update()` to rebuild regardless of the clock. */
  invalidate(): void {
    this.sinceRebuild = REBUILD_INTERVAL;
  }

  /**
   * Rebuilds the probe when the sky has moved enough to be worth it. Safe to
   * call every frame; it is a no-op on a static clock.
   */
  update(deltaSeconds: number): void {
    if (this.disposed || this.failed) return;
    this.sinceRebuild += deltaSeconds;
    if (this.sinceRebuild < REBUILD_INTERVAL) return;

    const timeOfDay = this.rig.timeOfDay;
    const sun = this.rig.state.direction;
    if (timeOfDay === this.lastTimeOfDay && sun.distanceTo(this.lastSun) < SUN_MOVEMENT_EPSILON) return;

    this.rebuild(timeOfDay, sun);
  }

  /** The current environment texture, or null before the first build. */
  get texture(): THREE.Texture | null {
    return this.environment;
  }

  dispose(): void {
    this.disposed = true;
    if (this.environment) {
      this.scene.environment = null;
      this.environment = null;
    }
    this.environmentTarget?.dispose();
    this.environmentTarget = null;
    this.pmrem.dispose();
    this.cubeTarget.dispose();
    this.boxGeometry.dispose();
    this.material.dispose();
    this.skyScene.clear();
  }

  private rebuild(timeOfDay: number, sun: THREE.Vector3): void {
    const state = this.rig.state;
    this.uniforms.uZenith.value.copy(state.skyZenith);
    this.uniforms.uHorizon.value.copy(state.skyHorizon);
    this.uniforms.uGround.value.copy(state.ground);
    this.uniforms.uSunColour.value.copy(state.color);
    this.uniforms.uSunDirection.value.copy(sun);
    this.uniforms.uSunSize.value = Math.cos(0.021 + 0.02 * state.night);
    this.uniforms.uSunPower.value = Math.min(2.5, state.intensity * 0.55);
    this.uniforms.uNight.value = state.night;

    try {
      this.cubeCamera.update(this.renderer, this.skyScene);
      const filtered = this.pmrem.fromCubemap(this.cubeTarget.texture);
      this.environmentTarget?.dispose();
      this.environmentTarget = filtered;
      this.environment = filtered.texture;
      this.scene.environment = this.environment;
      this.scene.environmentIntensity = 0.3 + 0.4 * (1 - state.night);
    } catch {
      // No usable WebGL context (headless test, lost device): leave the scene
      // unlit by the environment rather than throwing on every frame.
      this.failed = true;
      return;
    }

    this.lastTimeOfDay = timeOfDay;
    this.lastSun.copy(sun);
    this.sinceRebuild = 0;
  }
}
