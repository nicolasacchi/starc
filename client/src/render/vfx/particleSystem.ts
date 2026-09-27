/**
 * GPU particle system.
 *
 * One fixed pool of `settings.particleBudget` particles lives in a single
 * instanced buffer. Spawning writes a particle's spawn time, velocity, life
 * and colour once; from then on the *vertex shader* integrates it — spawn time
 * plus velocity plus gravity plus linear drag, closed form, no per-frame CPU
 * loop. `update()` only advances a clock uniform, so a ten thousand particle
 * burst costs ten thousand writes at the moment it happens and nothing at all
 * afterwards.
 *
 * Particles die by leaving the pool's time window, not by being removed: the
 * vertex shader collapses anything outside its lifetime to a degenerate
 * triangle, so the draw call size never has to change.
 *
 * Additive and alpha-blended particles share the pool and are drawn by two
 * meshes over the same geometry, each discarding the other's mode in the vertex
 * stage. The whole system is two draw calls.
 *
 * This module also hosts the vfx slice's procedural asset helpers (quad
 * geometry and sprite textures) so the other effects do not each grow their own
 * copy. Nothing is fetched: every texture is generated into a typed array.
 */
import * as THREE from "three";
import type { QualitySettings } from "@render/core/quality";

/** How a particle is composited. */
export type ParticleMode = "additive" | "alpha";

/** Shape of the size-over-life curve. */
export type SizeCurve = "linear" | "grow" | "shrink" | "ease-in" | "ease-out" | "pulse";

/** Ready-made emission presets for {@link ParticleSystem.burst}. */
export type BurstKind =
  | "spark"
  | "smoke"
  | "dust"
  | "blood"
  | "flame"
  | "debris"
  | "energy"
  | "mist";

export interface ParticleSpawn {
  position: THREE.Vector3;
  /** Units per second at birth; defaults to zero. */
  velocity?: THREE.Vector3;
  color: THREE.ColorRepresentation;
  /** Colour the particle fades towards; defaults to `color`. */
  colorEnd?: THREE.ColorRepresentation;
  /** Radius in metres at birth. */
  size: number;
  /** Radius at death; defaults to `size`. */
  sizeEnd?: number;
  sizeCurve?: SizeCurve;
  /** Seconds. */
  life: number;
  /** Downward acceleration, m/s². */
  gravity?: number;
  /** Linear drag coefficient, 1/s. */
  drag?: number;
  /** Radians per second of billboard spin. */
  spin?: number;
  mode?: ParticleMode;
  /** Amplitude of the cheap per-particle wobble, in metres. */
  turbulence?: number;
  /** Fade-out curve: 1 linear, higher holds longer. */
  fade?: number;
  /** Multiplies the composited alpha. */
  brightness?: number;
}

export interface BurstOptions {
  count?: number;
  speed?: number;
  speedVariance?: number;
  /** Emission sphere radius, in metres. */
  radius?: number;
  /** Cone axis; omit for an omnidirectional burst. */
  direction?: THREE.Vector3;
  /** Cone half-angle, radians. */
  spread?: number;
  /** Extra bias along +Y, added after the cone. */
  upBias?: number;
  /** Velocity every particle inherits (a moving vehicle, a shockwave). */
  inherit?: THREE.Vector3;
  life?: number;
  lifeVariance?: number;
  size?: number;
  sizeEnd?: number;
  sizeCurve?: SizeCurve;
  color?: THREE.ColorRepresentation;
  colorEnd?: THREE.ColorRepresentation;
  gravity?: number;
  drag?: number;
  spin?: number;
  mode?: ParticleMode;
  turbulence?: number;
  fade?: number;
  brightness?: number;
}

/** Size-curve exponents, packed into the per-particle `aShape.x` attribute. */
const CURVE_POWER: Readonly<Record<SizeCurve, number>> = {
  linear: 1,
  grow: 0.55,
  shrink: 2.2,
  "ease-in": 2,
  "ease-out": 0.35,
  pulse: 0.6,
};

interface BurstPreset {
  speed: number;
  speedVariance: number;
  radius: number;
  spread: number;
  upBias: number;
  life: number;
  lifeVariance: number;
  size: number;
  sizeEnd: number;
  sizeCurve: SizeCurve;
  color: number;
  colorEnd: number | null;
  gravity: number;
  drag: number;
  spin: number;
  mode: ParticleMode;
  turbulence: number;
  fade: number;
  brightness: number;
}

const PRESETS: Readonly<Record<BurstKind, BurstPreset>> = {
  spark: {
    speed: 14, speedVariance: 0.6, radius: 0.1, spread: Math.PI, upBias: 0.2,
    life: 0.55, lifeVariance: 0.4, size: 0.16, sizeEnd: 0.02, sizeCurve: "shrink",
    color: 0xffd9a0, colorEnd: 0xff5522, gravity: 16, drag: 1.2, spin: 0,
    mode: "additive", turbulence: 0, fade: 1.4, brightness: 1.6,
  },
  smoke: {
    speed: 2.2, speedVariance: 0.5, radius: 0.6, spread: Math.PI, upBias: 1.4,
    life: 2.4, lifeVariance: 0.35, size: 1.1, sizeEnd: 3.4, sizeCurve: "grow",
    color: 0x2a2724, colorEnd: 0x585450, gravity: -1.2, drag: 1.6, spin: 0.5,
    mode: "alpha", turbulence: 0.25, fade: 1.6, brightness: 0.55,
  },
  dust: {
    speed: 3.4, speedVariance: 0.6, radius: 0.8, spread: Math.PI, upBias: 0.6,
    life: 1.5, lifeVariance: 0.4, size: 0.9, sizeEnd: 2.6, sizeCurve: "grow",
    color: 0x9a8a70, colorEnd: 0x6b6154, gravity: 2.5, drag: 2.4, spin: 0.3,
    mode: "alpha", turbulence: 0.3, fade: 1.8, brightness: 0.5,
  },
  blood: {
    speed: 7, speedVariance: 0.7, radius: 0.2, spread: Math.PI, upBias: 0.4,
    life: 0.8, lifeVariance: 0.5, size: 0.22, sizeEnd: 0.5, sizeCurve: "ease-out",
    color: 0x8c1414, colorEnd: 0x3a0808, gravity: 22, drag: 0.6, spin: 0,
    mode: "alpha", turbulence: 0, fade: 1.2, brightness: 0.95,
  },
  flame: {
    speed: 4, speedVariance: 0.5, radius: 0.35, spread: Math.PI, upBias: 1.8,
    life: 0.6, lifeVariance: 0.4, size: 0.7, sizeEnd: 0.1, sizeCurve: "ease-out",
    color: 0xffd27a, colorEnd: 0xd03208, gravity: -6, drag: 2.2, spin: 0,
    mode: "additive", turbulence: 0.12, fade: 1.5, brightness: 1.35,
  },
  debris: {
    speed: 11, speedVariance: 0.7, radius: 0.15, spread: Math.PI, upBias: 0.5,
    life: 1.2, lifeVariance: 0.5, size: 0.18, sizeEnd: 0.18, sizeCurve: "linear",
    color: 0x8a8378, colorEnd: 0x4a463f, gravity: 24, drag: 0.5, spin: 6,
    mode: "alpha", turbulence: 0, fade: 2.5, brightness: 0.9,
  },
  energy: {
    speed: 9, speedVariance: 0.4, radius: 0.05, spread: 0.5, upBias: 0,
    life: 0.35, lifeVariance: 0.3, size: 0.3, sizeEnd: 0.05, sizeCurve: "shrink",
    color: 0xffffff, colorEnd: 0x66ccff, gravity: 0, drag: 3, spin: 0,
    mode: "additive", turbulence: 0, fade: 1, brightness: 1.8,
  },
  mist: {
    speed: 1.1, speedVariance: 0.7, radius: 1.2, spread: Math.PI, upBias: 0.2,
    life: 3.2, lifeVariance: 0.4, size: 1.6, sizeEnd: 4.2, sizeCurve: "grow",
    color: 0x8fa8b8, colorEnd: 0x5d6a72, gravity: -0.4, drag: 1.1, spin: 0.2,
    mode: "alpha", turbulence: 0.4, fade: 1.8, brightness: 0.4,
  },
};

const _color = new THREE.Color();
const _colorEnd = new THREE.Color();
const _axis = new THREE.Vector3();
const _basisA = new THREE.Vector3();
const _basisB = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _offset = new THREE.Vector3();

/**
 * A unit quad drawn once per instance. The caller attaches its own instanced
 * attributes; the shared geometry only carries the corner, its UVs and a
 * normal for anything that wants to light the result.
 */
export function instancedQuad(): THREE.InstancedBufferGeometry {
  const plane = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = plane.index;
  geometry.setAttribute("position", plane.getAttribute("position"));
  geometry.setAttribute("uv", plane.getAttribute("uv"));
  geometry.setAttribute("normal", plane.getAttribute("normal"));
  plane.dispose();
  return geometry;
}

/**
 * Soft round sprite, alpha falling off as `(1 - d)^power`. Additive particles
 * want a tight core, alpha particles a broad one.
 */
export function softSpriteTexture(power = 2, size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const d = Math.min(1, Math.hypot(dx, dy) * 2);
      const a = Math.pow(1 - d, power);
      const o = (y * size + x) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
    }
  }
  return finishTexture(data, size, size, "soft-sprite");
}

function hash2(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/** Lumpy smoke puff: radial falloff modulated by two octaves of value noise. */
export function puffSpriteTexture(size = 96): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const dx = u - 0.5;
      const dy = v - 0.5;
      const d = Math.min(1, Math.hypot(dx, dy) * 2);
      const n = valueNoise(u * 5, v * 5, 1.7) * 0.65 + valueNoise(u * 11, v * 11, 4.3) * 0.35;
      const edge = 1 - d * d;
      const a = edge * edge * (0.35 + 0.85 * n) * (n > 0.22 ? 1 : n / 0.22);
      const o = (y * size + x) * 4;
      // A little internal shading so the puff is not a flat disc.
      const shade = 200 + Math.round(55 * n);
      data[o] = shade;
      data[o + 1] = shade;
      data[o + 2] = shade;
      data[o + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
    }
  }
  return finishTexture(data, size, size, "puff-sprite");
}

function finishTexture(data: Uint8Array, width: number, height: number, name: string): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.name = name;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

const PARTICLE_VERT = /* glsl */ `
attribute vec3 aOrigin;
attribute vec3 aVelocity;
attribute vec3 aColor;
attribute vec3 aColorEnd;
attribute vec4 aParams;
attribute vec4 aMotion;
attribute vec4 aShape;

uniform float uTime;
uniform float uMode;

varying vec2 vUv;
varying vec3 vColour;
varying float vAlpha;
varying float vViewDistance;

void main() {
  float spawn = aParams.x;
  float life = aParams.y;
  float age = uTime - spawn;
  vUv = uv;
  vColour = aColor;
  vAlpha = 0.0;
  vViewDistance = 0.0;

  // Dead, not yet born, or owned by the other blend mode: collapse the quad
  // behind the near plane so it costs a vertex and nothing else.
  if ( life <= 0.0 || age < 0.0 || age > life || abs( aMotion.w - uMode ) > 0.5 ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    return;
  }

  float t = age / life;
  float gravity = aMotion.x;
  float drag = aMotion.y;

  // Closed-form ballistic motion with linear drag: with drag the velocity
  // decays exponentially, without it the particle free-falls.
  vec3 accel = vec3( 0.0, -gravity, 0.0 );
  vec3 world;
  if ( drag > 0.0001 ) {
    float decay = ( 1.0 - exp( -drag * age ) ) / drag;
    world = aOrigin + ( aVelocity + accel / drag ) * decay - ( accel / drag ) * age;
  } else {
    world = aOrigin + aVelocity * age + 0.5 * accel * age * age;
  }

  float wobble = aShape.y;
  if ( wobble > 0.0 ) {
    float seed = dot( aOrigin, vec3( 12.9898, 78.233, 37.719 ) );
    world += wobble * vec3(
      sin( age * 2.1 + seed ),
      sin( age * 1.7 + seed * 1.3 ) * 0.6,
      cos( age * 2.4 + seed * 0.7 )
    );
  }

  float size = mix( aParams.z, aParams.w, pow( t, aShape.x ) );
  float spin = aMotion.z * age;
  float cs = cos( spin );
  float sn = sin( spin );
  vec2 corner = mat2( cs, -sn, sn, cs ) * position.xy * size;

  vec4 view = modelViewMatrix * vec4( world, 1.0 );
  vViewDistance = -view.z;
  view.xy += corner;
  gl_Position = projectionMatrix * view;

  vColour = mix( aColor, aColorEnd, t );
  vAlpha = smoothstep( 0.0, 0.08, t ) * pow( 1.0 - t, aShape.z ) * aShape.w;
}
`;

const PARTICLE_FRAG = /* glsl */ `
uniform sampler2D uSprite;
#ifdef SOFT_DEPTH
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform vec2 uCameraPlanes;
uniform float uSoftness;
#endif

varying vec2 vUv;
varying vec3 vColour;
varying float vAlpha;
varying float vViewDistance;

#ifdef SOFT_DEPTH
float viewDistanceAt( vec2 uv ) {
  float depth = texture2D( uDepth, uv ).x;
  return -( uCameraPlanes.x * uCameraPlanes.y ) /
    ( ( uCameraPlanes.y - uCameraPlanes.x ) * depth - uCameraPlanes.y );
}
#endif

void main() {
  vec4 sprite = texture2D( uSprite, vUv );
  float alpha = sprite.a * vAlpha;
  if ( alpha < 0.004 ) discard;

  #ifdef SOFT_DEPTH
  // Fade where the particle intersects solid geometry, so puffs do not cut a
  // hard line into the terrain they are sitting on.
  float scene = viewDistanceAt( gl_FragCoord.xy / uResolution );
  alpha *= clamp( ( scene - vViewDistance ) / uSoftness, 0.0, 1.0 );
  if ( alpha < 0.004 ) discard;
  #endif

  gl_FragColor = vec4( vColour * sprite.rgb, alpha );
}
`;

/**
 * A fixed pool of GPU-advanced particles drawn in two instanced passes.
 *
 * The pool is a ring buffer: spawning past the budget recycles the oldest
 * particle rather than growing anything, so an effects-heavy match costs the
 * same as a quiet one.
 */
export class ParticleSystem {
  /** Root of the two draw passes; already added to the scene. */
  readonly group = new THREE.Group();
  /** Number of particles the pool can hold. */
  readonly capacity: number;

  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly additive: THREE.ShaderMaterial;
  private readonly alphaBlend: THREE.ShaderMaterial;
  private readonly coreTexture: THREE.DataTexture;
  private readonly puffTexture: THREE.DataTexture;
  private readonly origins: Float32Array;
  private readonly velocities: Float32Array;
  private readonly colors: Float32Array;
  private readonly colorEnds: Float32Array;
  private readonly params: Float32Array;
  private readonly motion: Float32Array;
  private readonly shapes: Float32Array;
  private readonly buffers: THREE.InstancedBufferAttribute[] = [];
  private dirtyLo = Number.POSITIVE_INFINITY;
  private dirtyHi = -1;
  private head = 0;
  private spawned = 0;
  private time = 0;

  constructor(scene: THREE.Scene, settings: QualitySettings) {
    this.capacity = Math.max(256, Math.round(settings.particleBudget));
    this.group.name = "particles";

    this.geometry = instancedQuad();
    this.origins = new Float32Array(this.capacity * 3);
    this.velocities = new Float32Array(this.capacity * 3);
    this.colors = new Float32Array(this.capacity * 3);
    this.colorEnds = new Float32Array(this.capacity * 3);
    this.params = new Float32Array(this.capacity * 4);
    this.motion = new Float32Array(this.capacity * 4);
    this.shapes = new Float32Array(this.capacity * 4);

    this.geometry.setAttribute("aOrigin", this.attribute(this.origins, 3));
    this.geometry.setAttribute("aVelocity", this.attribute(this.velocities, 3));
    this.geometry.setAttribute("aColor", this.attribute(this.colors, 3));
    this.geometry.setAttribute("aColorEnd", this.attribute(this.colorEnds, 3));
    this.geometry.setAttribute("aParams", this.attribute(this.params, 4));
    this.geometry.setAttribute("aMotion", this.attribute(this.motion, 4));
    this.geometry.setAttribute("aShape", this.attribute(this.shapes, 4));
    this.geometry.instanceCount = 0;

    this.coreTexture = softSpriteTexture(2.4);
    this.puffTexture = puffSpriteTexture();

    this.additive = this.makeMaterial(0, this.coreTexture, THREE.AdditiveBlending);
    this.alphaBlend = this.makeMaterial(1, this.puffTexture, THREE.NormalBlending);

    const additiveMesh = new THREE.Mesh(this.geometry, this.additive);
    additiveMesh.frustumCulled = false;
    additiveMesh.renderOrder = 6;
    additiveMesh.name = "particles-additive";

    const alphaMesh = new THREE.Mesh(this.geometry, this.alphaBlend);
    alphaMesh.frustumCulled = false;
    alphaMesh.renderOrder = 5;
    alphaMesh.name = "particles-alpha";

    this.group.add(alphaMesh, additiveMesh);
    scene.add(this.group);
  }

  /** Particles currently inside the pool's time window, upper bound. */
  get liveCount(): number {
    return Math.min(this.spawned, this.capacity);
  }

  /** Seconds since the system was created; the pool's clock. */
  get clock(): number {
    return this.time;
  }

  /**
   * Hands the scene's depth buffer to the particles so they can fade where
   * they intersect solid geometry. Pass null to switch the cost back off.
   * `cameraPlanes` is the view camera's (near, far).
   */
  setDepthTexture(
    texture: THREE.DepthTexture | null,
    width: number,
    height: number,
    cameraPlanes: THREE.Vector2,
    softness = 0.6,
  ): void {
    for (const material of [this.additive, this.alphaBlend]) {
      const soft = texture !== null;
      const defines = material.defines ?? {};
      if (soft === (defines.SOFT_DEPTH === 1)) continue;
      if (soft) defines.SOFT_DEPTH = 1;
      else delete defines.SOFT_DEPTH;
      material.defines = defines;
      material.needsUpdate = true;
    }
    for (const material of [this.additive, this.alphaBlend]) {
      const uniforms = material.uniforms;
      uniforms.uDepth.value = texture;
      uniforms.uResolution.value.set(width, height);
      uniforms.uCameraPlanes.value.copy(cameraPlanes);
      uniforms.uSoftness.value = softness;
    }
  }

  /** Spawns one particle. */
  spawn(options: ParticleSpawn): void {
    if (!(options.life > 0)) return;
    const index = this.head;
    this.head = index + 1 === this.capacity ? 0 : index + 1;
    if (this.spawned < this.capacity) this.spawned++;

    const i3 = index * 3;
    const i4 = index * 4;

    this.origins[i3] = options.position.x;
    this.origins[i3 + 1] = options.position.y;
    this.origins[i3 + 2] = options.position.z;

    if (options.velocity) {
      this.velocities[i3] = options.velocity.x;
      this.velocities[i3 + 1] = options.velocity.y;
      this.velocities[i3 + 2] = options.velocity.z;
    } else {
      this.velocities[i3] = 0;
      this.velocities[i3 + 1] = 0;
      this.velocities[i3 + 2] = 0;
    }

    _color.set(options.color);
    _colorEnd.set(options.colorEnd ?? options.color);
    this.colors[i3] = _color.r;
    this.colors[i3 + 1] = _color.g;
    this.colors[i3 + 2] = _color.b;
    this.colorEnds[i3] = _colorEnd.r;
    this.colorEnds[i3 + 1] = _colorEnd.g;
    this.colorEnds[i3 + 2] = _colorEnd.b;
    this.motion[i4] = options.gravity ?? 0;
    this.motion[i4 + 1] = options.drag ?? 0;
    this.motion[i4 + 2] = options.spin ?? 0;
    this.motion[i4 + 3] = options.mode === "alpha" ? 1 : 0;

    this.shapes[i4] = CURVE_POWER[options.sizeCurve ?? "linear"];
    this.shapes[i4 + 1] = options.turbulence ?? 0;
    this.shapes[i4 + 2] = options.fade ?? 1.5;
    this.shapes[i4 + 3] = options.brightness ?? 1;

    const count = Math.min(this.spawned, this.capacity);
    if (count > this.geometry.instanceCount) this.geometry.instanceCount = count;
    if (index < this.dirtyLo) this.dirtyLo = index;
    if (index > this.dirtyHi) this.dirtyHi = index;
  }

  /**
   * Emits `count` particles of a preset kind. Options override the preset
   * field by field, so `"spark"` with a different colour is still a spark.
   */
  burst(kind: BurstKind, position: THREE.Vector3, options: BurstOptions = {}): void {
    const preset = PRESETS[kind];
    const count = Math.max(0, Math.round(options.count ?? 12));
    if (count === 0) return;

    const speed = options.speed ?? preset.speed;
    const speedVariance = options.speedVariance ?? preset.speedVariance;
    const radius = options.radius ?? preset.radius;
    const spread = options.spread ?? preset.spread;
    const upBias = options.upBias ?? preset.upBias;
    const life = options.life ?? preset.life;
    const lifeVariance = options.lifeVariance ?? preset.lifeVariance;
    const size = options.size ?? preset.size;
    const sizeEnd = options.sizeEnd ?? preset.sizeEnd;
    const curve = options.sizeCurve ?? preset.sizeCurve;
    const gravity = options.gravity ?? preset.gravity;
    const drag = options.drag ?? preset.drag;
    const spin = options.spin ?? preset.spin;
    const mode = options.mode ?? preset.mode;
    const turbulence = options.turbulence ?? preset.turbulence;
    const fade = options.fade ?? preset.fade;
    const brightness = options.brightness ?? preset.brightness;
    const color = options.color ?? preset.color;
    const colorEnd = options.colorEnd ?? preset.colorEnd;

    // A cone wider than a half turn is just an omnidirectional burst, so the
    // basis around the axis is only built when it can actually aim something.
    const axis = options.direction;
    const conical = axis !== undefined && spread < Math.PI * 0.95;
    if (axis && conical) {
      _axis.copy(axis);
      if (_axis.lengthSq() < 1e-8) _axis.set(0, 1, 0);
      _axis.normalize();
      _basisA.set(0, 1, 0);
      if (Math.abs(_axis.y) > 0.95) _basisA.set(1, 0, 0);
      _basisA.crossVectors(_basisA, _axis).normalize();
      _basisB.crossVectors(_axis, _basisA).normalize();
    }

    for (let n = 0; n < count; n++) {
      const z = 1 - 2 * Math.random();
      const phi = Math.random() * Math.PI * 2;
      const planar = Math.sqrt(Math.max(0, 1 - z * z));

      if (conical && axis) {
        const angle = spread * Math.sqrt(Math.random());
        const lateral = Math.sin(angle);
        _direction
          .copy(_axis)
          .multiplyScalar(Math.cos(angle))
          .addScaledVector(_basisA, planar * lateral * Math.cos(phi))
          .addScaledVector(_basisB, planar * lateral * Math.sin(phi))
          .normalize();
      } else {
        _direction.set(planar * Math.cos(phi), z, planar * Math.sin(phi));
      }
      _direction.y += upBias;
      _direction.normalize();

      const magnitude = speed * (1 + (Math.random() * 2 - 1) * speedVariance);
      _offset.set(
        (Math.random() * 2 - 1) * radius,
        (Math.random() * 2 - 1) * radius,
        (Math.random() * 2 - 1) * radius,
      );
      if (options.inherit) _offset.add(options.inherit);

      this.spawn({
        position: _offset.add(position),
        velocity: _direction.multiplyScalar(magnitude),
        color,
        colorEnd: colorEnd ?? color,
        size: size * (0.75 + Math.random() * 0.5),
        sizeEnd: sizeEnd * (0.75 + Math.random() * 0.5),
        sizeCurve: curve,
        life: life * (1 + (Math.random() * 2 - 1) * lifeVariance),
        gravity,
        drag,
        spin: spin * (Math.random() * 2 - 1),
        mode,
        turbulence,
        fade,
        brightness,
      });
    }
  }

  /**
   * Advances the pool clock and uploads whatever the frame's spawns touched.
   * Nothing here scales with the number of live particles.
   */
  update(deltaSeconds: number): void {
    this.time += deltaSeconds;
    this.additive.uniforms.uTime.value = this.time;
    this.alphaBlend.uniforms.uTime.value = this.time;

    if (this.dirtyHi < this.dirtyLo) return;
    const first = this.dirtyLo;
    const count = this.dirtyHi - first + 1;
    for (const attribute of this.buffers) {
      attribute.addUpdateRange(first * attribute.itemSize, count * attribute.itemSize);
    }
    this.dirtyLo = Number.POSITIVE_INFINITY;
    this.dirtyHi = -1;
  }

  /** Empties the pool. */
  clear(): void {
    this.head = 0;
    this.spawned = 0;
    this.geometry.instanceCount = 0;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.additive.dispose();
    this.alphaBlend.dispose();
    this.coreTexture.dispose();
    this.puffTexture.dispose();
  }

  private attribute(array: Float32Array, size: number): THREE.InstancedBufferAttribute {
    const attribute = new THREE.InstancedBufferAttribute(array, size);
    attribute.setUsage(THREE.DynamicDrawUsage);
    this.buffers.push(attribute);
    return attribute;
  }

  private makeMaterial(mode: number, sprite: THREE.DataTexture, blending: THREE.Blending): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uMode: { value: mode },
        uSprite: { value: sprite },
        uDepth: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uCameraPlanes: { value: new THREE.Vector2(0.1, 1000) },
        uSoftness: { value: 0.6 },
      },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending,
      toneMapped: false,
    });
  }
}
