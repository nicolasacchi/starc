/**
 * Explosions: a layered composition, pooled.
 *
 * Every blast is the same five layers at different scales — a fireball that
 * expands and burns out, a ground-aligned shockwave ring, sparks, rising smoke
 * and physical debris that bounces off the terrain — plus a scorch mark for the
 * ones that leave one. `explode` is the most frequently called effect in the
 * game, so all five are fixed pools: five hundred explosions in a row allocate
 * exactly as much as one.
 *
 * The fireball, ring and smoke advance on the GPU from a birth stamp; only the
 * debris is stepped on the CPU, because it has to know where the ground is.
 * Every texture is generated in JavaScript; nothing is loaded.
 */
import * as THREE from "three";
import type { QualitySettings } from "@render/core/quality";
import type { HeightField } from "@render/terrain/heightfield";
import { ParticleSystem, instancedQuad } from "./particleSystem";
import { DecalSystem } from "./decals";

/** Blast sizes, matched to what dies in them. */
export type ExplosionKind = "small" | "medium" | "large" | "nuke";

interface KindSpec {
  /** Fireball radius as a multiple of the blast radius. */
  fireball: number;
  /** How long the fireball burns, seconds. */
  fireballLife: number;
  /** Shockwave radius as a multiple of the blast radius. */
  ring: number;
  ringLife: number;
  sparks: number;
  smoke: number;
  smokeRise: number;
  debris: number;
  /** Debris launch speed, m/s. */
  debrisSpeed: number;
  /** Light thrown into the smoke, 0..1. */
  flash: number;
  /** Leaves a scorch mark this big. */
  scorch: number;
  /** Extra columns of rising smoke, as for a nuclear detonation. */
  columns: number;
}

const KINDS: Readonly<Record<ExplosionKind, KindSpec>> = {
  small: {
    fireball: 0.85, fireballLife: 0.42, ring: 1.5, ringLife: 0.5,
    sparks: 14, smoke: 5, smokeRise: 1, debris: 6, debrisSpeed: 9,
    flash: 0.5, scorch: 0, columns: 0,
  },
  medium: {
    fireball: 1.15, fireballLife: 0.72, ring: 2.1, ringLife: 0.75,
    sparks: 26, smoke: 11, smokeRise: 1.4, debris: 14, debrisSpeed: 13,
    flash: 0.8, scorch: 0.8, columns: 0,
  },
  large: {
    fireball: 1.5, fireballLife: 1.25, ring: 2.6, ringLife: 1.1,
    sparks: 44, smoke: 22, smokeRise: 1.8, debris: 26, debrisSpeed: 17,
    flash: 1, scorch: 1.6, columns: 0,
  },
  nuke: {
    fireball: 1.9, fireballLife: 2.1, ring: 3.4, ringLife: 2.2,
    sparks: 90, smoke: 60, smokeRise: 2.6, debris: 48, debrisSpeed: 26,
    flash: 1, scorch: 2.6, columns: 5,
  },
};

const FIREBALL_FRAG_NOISE = /* glsl */ `
float hash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float noise2( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( hash12( i ), hash12( i + vec2( 1.0, 0.0 ) ), f.x ),
    mix( hash12( i + vec2( 0.0, 1.0 ) ), hash12( i + vec2( 1.0, 1.0 ) ), f.x ),
    f.y
  );
}
`;

const FIREBALL_VERT = /* glsl */ `
attribute vec3 aCentre;
attribute vec4 aParams;
attribute vec3 aColor;

uniform float uTime;

varying vec2 vUv;
varying vec3 vColor;
varying float vAge;
varying float vSeed;

void main() {
  float age = uTime - aParams.x;
  float life = aParams.y;
  vUv = uv;
  vColor = aColor;
  vAge = 0.0;
  vSeed = aParams.w;

  if ( life <= 0.0 || age < 0.0 || age > life ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    return;
  }

  float t = age / life;
  vAge = t;
  // Fast out, then a slow settle: the shape of a real fireball's silhouette.
  float grow = 1.0 - pow( 1.0 - t, 3.0 );
  float radius = aParams.z * ( 0.22 + 0.95 * grow );

  vec4 view = modelViewMatrix * vec4( aCentre, 1.0 );
  view.xy += position.xy * radius * 2.0;
  gl_Position = projectionMatrix * view;
}
`;

const FIREBALL_FRAG = /* glsl */ `
${FIREBALL_FRAG_NOISE}
uniform float uTime;

varying vec2 vUv;
varying vec3 vColor;
varying float vAge;
varying float vSeed;

void main() {
  float t = clamp( vAge, 0.0, 1.0 );
  vec2 uv = vUv;

  // Turbulence: the surface boils as the ball expands, and boils faster early.
  float boil = uTime * 3.4 + vSeed * 17.0;
  float n = noise2( uv * 4.0 + vec2( boil, -boil * 0.6 ) ) * 0.6
          + noise2( uv * 9.0 - vec2( boil * 1.7, boil ) ) * 0.4;

  float d = length( uv - 0.5 ) * 2.0;
  float mask = 1.0 - smoothstep( 0.15, 1.05, d + ( n - 0.5 ) * 0.75 );
  if ( mask < 0.01 ) discard;

  // White hot at birth, the weapon's own colour through the body, embers last.
  vec3 colour = mix( vec3( 1.0, 0.96, 0.82 ), vColor, smoothstep( 0.02, 0.42, t ) );
  colour = mix( colour, vec3( 0.22, 0.06, 0.02 ), smoothstep( 0.45, 1.0, t ) );
  colour *= 0.75 + 0.6 * n;

  float alpha = mask * pow( 1.0 - t, 1.25 );
  gl_FragColor = vec4( colour * alpha, alpha );
}
`;

const RING_VERT = /* glsl */ `
attribute vec3 aCentre;
attribute vec4 aParams;
attribute vec3 aColor;

uniform float uTime;

varying vec2 vUv;
varying vec3 vColor;
varying float vAge;
varying float vSeed;

void main() {
  float age = uTime - aParams.x;
  float life = aParams.y;
  vUv = uv;
  vColor = aColor;
  vAge = 0.0;
  vSeed = aParams.w;

  if ( life <= 0.0 || age < 0.0 || age > life ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    return;
  }

  float t = age / life;
  vAge = t;
  float radius = aParams.z * ( 0.12 + 1.9 * pow( t, 0.55 ) );
  vec3 world = aCentre + vec3( position.x, 0.0, position.z ) * radius;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( world, 1.0 );
}
`;

const RING_FRAG = /* glsl */ `
${FIREBALL_FRAG_NOISE}
varying vec2 vUv;
varying vec3 vColor;
varying float vAge;
varying float vSeed;

void main() {
  float t = clamp( vAge, 0.0, 1.0 );
  vec2 p = vUv - 0.5;
  float d = length( p ) * 2.0;
  float angle = atan( p.y, p.x );

  // The front is distorted by an angular standing wave, which is what stops a
  // shockwave reading as a clean, obviously circular decal.
  float warp = 0.055 * sin( angle * 7.0 + vSeed * 9.0 ) + 0.045 * sin( angle * 13.0 - vSeed * 4.0 );
  float front = 0.92 + warp;

  float band = 1.0 - smoothstep( 0.0, 0.16, abs( d - front ) );
  float inner = ( 1.0 - smoothstep( 0.0, front, d ) ) * 0.35;
  float dust = noise2( p * 9.0 + vSeed * 31.0 ) * band;

  vec3 colour = mix( vec3( 1.0 ), vColor, 0.35 ) * ( 0.6 + 0.8 * band );
  colour = mix( vec3( 0.35, 0.31, 0.28 ), colour, clamp( band + dust, 0.0, 1.0 ) );

  float alpha = ( band * ( 0.55 + 0.45 * dust ) + inner * ( 1.0 - t ) ) * pow( 1.0 - t, 1.6 );
  if ( alpha < 0.006 ) discard;

  gl_FragColor = vec4( colour * alpha, alpha );
}
`;

const _up = new THREE.Vector3(0, 1, 0);
const _scratch = new THREE.Vector3();
const _scratchB = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
const _quaternion = new THREE.Quaternion();
const _color = new THREE.Color();

/** One physical chunk in flight or at rest. */
interface Chunk {
  active: boolean;
  life: number;
  age: number;
  size: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  spin: number;
  tint: number;
  settled: boolean;
}

/**
 * Pooled explosions for one map.
 */
export class ExplosionSystem {
  /** Root of the explosion draw calls; already added to the scene. */
  readonly group = new THREE.Group();
  /** Scorch and blood marks left behind; the grid is not driven from here. */
  readonly decals: DecalSystem;
  /** Explosions the fireball and ring pools hold. */
  readonly capacity: number;
  /** Chunks of debris the system simulates. */
  readonly debrisCapacity: number;

  private readonly terrain: HeightField;
  private readonly particles: ParticleSystem;
  private readonly ballGeometry: THREE.InstancedBufferGeometry;
  private readonly ballMaterial: THREE.ShaderMaterial;
  private readonly ringGeometry: THREE.InstancedBufferGeometry;
  private readonly ringMaterial: THREE.ShaderMaterial;
  private readonly debris: THREE.InstancedMesh;
  private readonly debrisGeometry: THREE.BoxGeometry;

  private readonly ballCentres: Float32Array;
  private readonly ballParams: Float32Array;
  private readonly ballColors: Float32Array;
  private readonly ballBuffers: THREE.InstancedBufferAttribute[] = [];
  private readonly ringCentres: Float32Array;
  private readonly ringParams: Float32Array;
  private readonly ringColors: Float32Array;
  private readonly ringBuffers: THREE.InstancedBufferAttribute[] = [];
  private readonly chunks: Chunk[] = [];

  private ballHead = 0;
  private ballSpawned = 0;
  private ringHead = 0;
  private ringSpawned = 0;
  private chunkHead = 0;
  private time = 0;

  constructor(scene: THREE.Scene, settings: QualitySettings, terrain: HeightField) {
    this.terrain = terrain;
    this.capacity = settings.postFx ? 64 : 32;
    this.debrisCapacity = settings.postFx ? 192 : 64;
    this.group.name = "explosions";

    this.particles = new ParticleSystem(scene, {
      ...settings,
      particleBudget: Math.max(384, Math.round(settings.particleBudget * 0.5)),
    });
    this.decals = new DecalSystem(scene, terrain.map, settings, terrain);

    this.ballGeometry = instancedQuad();
    this.ballCentres = new Float32Array(this.capacity * 3);
    this.ballParams = new Float32Array(this.capacity * 4);
    this.ballColors = new Float32Array(this.capacity * 3);
    this.ballGeometry.setAttribute("aCentre", this.attribute(this.ballCentres, 3, this.ballBuffers));
    this.ballGeometry.setAttribute("aParams", this.attribute(this.ballParams, 4, this.ballBuffers));
    this.ballGeometry.setAttribute("aColor", this.attribute(this.ballColors, 3, this.ballBuffers));
    this.ballGeometry.instanceCount = 0;

    this.ballMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: FIREBALL_VERT,
      fragmentShader: FIREBALL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const ballMesh = new THREE.Mesh(this.ballGeometry, this.ballMaterial);
    ballMesh.frustumCulled = false;
    ballMesh.renderOrder = 10;
    ballMesh.name = "explosion-fireballs";
    this.group.add(ballMesh);

    this.ringGeometry = instancedQuad();
    this.ringCentres = new Float32Array(this.capacity * 3);
    this.ringParams = new Float32Array(this.capacity * 4);
    this.ringColors = new Float32Array(this.capacity * 3);
    this.ringGeometry.setAttribute("aCentre", this.attribute(this.ringCentres, 3, this.ringBuffers));
    this.ringGeometry.setAttribute("aParams", this.attribute(this.ringParams, 4, this.ringBuffers));
    this.ringGeometry.setAttribute("aColor", this.attribute(this.ringColors, 3, this.ringBuffers));
    this.ringGeometry.instanceCount = 0;

    this.ringMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: RING_VERT,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const ringMesh = new THREE.Mesh(this.ringGeometry, this.ringMaterial);
    ringMesh.frustumCulled = false;
    ringMesh.renderOrder = 4;
    ringMesh.name = "explosion-shockwaves";
    this.group.add(ringMesh);

    this.debrisGeometry = new THREE.BoxGeometry(1, 0.72, 1.35);
    const white = new Float32Array(this.debrisGeometry.getAttribute("position").count * 3);
    white.fill(1);
    this.debrisGeometry.setAttribute("color", new THREE.BufferAttribute(white, 3));
    this.debris = new THREE.InstancedMesh(
      this.debrisGeometry,
      new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }),
      this.debrisCapacity,
    );
    this.debris.name = "explosion-debris";
    this.debris.frustumCulled = false;
    this.debris.count = 0;
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.debris);

    for (let i = 0; i < this.debrisCapacity; i++) {
      this.chunks.push({
        active: false, life: 0, age: 0, size: 0.2,
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, spin: 0, tint: 0, settled: false,
      });
    }

    scene.add(this.group);
  }

  /** Fireballs alive or fading, upper bound. */
  get liveCount(): number {
    return Math.min(this.ballSpawned, this.capacity);
  }

  /**
   * Detonates at `position`. `radius` is the blast radius in metres; `kind`
   * chooses the character of the blast — a marine's death is a pop, a
   * building's is a wall, a nuclear strike is a column.
   */
  explode(position: THREE.Vector3, radius: number, kind: ExplosionKind): void {
    const spec = KINDS[kind];
    const scale = Math.max(0.4, radius);
    const groundY = this.terrain.sample(position.x, position.z);
    const centreY = position.y > groundY ? position.y : groundY;

    _scratch.set(position.x, centreY + scale * spec.fireball * 0.55, position.z);
    this.writeBall(_scratch, scale * spec.fireball, spec.fireballLife, 0xff7a22);
    this.writeBall(
      _scratch.setY(centreY + scale * spec.fireball * 0.4),
      scale * spec.fireball * 0.7,
      spec.fireballLife * 0.55,
      0xffe9b0,
    );

    _scratch.set(position.x, groundY + 0.12, position.z);
    this.writeRing(_scratch, scale * spec.ring, spec.ringLife, 0xd8c8a8);

    this.particles.burst("spark", _scratch.setY(centreY + scale * 0.3), {
      count: spec.sparks,
      radius: scale * 0.25,
      speed: spec.debrisSpeed * 0.9,
      life: 0.55,
      size: scale * 0.06 + 0.06,
      sizeEnd: 0.02,
      upBias: 0.5,
    });
    this.particles.burst("flame", _scratch.setY(centreY + scale * 0.35), {
      count: Math.round(spec.sparks * 0.7),
      radius: scale * 0.4,
      speed: scale * 1.6,
      life: 0.5,
      size: scale * 0.4,
      sizeEnd: scale * 0.1,
      upBias: 1.4,
    });
    this.particles.burst("smoke", _scratch.setY(centreY + scale * 0.4), {
      count: spec.smoke,
      radius: scale * 0.5,
      speed: scale * 1.1,
      life: spec.ringLife + 1.4,
      size: scale * 0.5,
      sizeEnd: scale * 1.7,
      upBias: spec.smokeRise,
      // A brighter blast lights its own smoke from inside.
      brightness: 0.45 + spec.flash * 0.5,
      turbulence: scale * 0.12,
    });
    this.particles.burst("dust", _scratch.setY(groundY + 0.2), {
      count: Math.round(spec.smoke * 0.6),
      radius: scale * 0.7,
      speed: scale * 3.2,
      life: 1.1,
      size: scale * 0.45,
      sizeEnd: scale * 1.4,
      upBias: 0.25,
    });

    for (let c = 0; c < spec.columns; c++) {
      this.particles.burst("smoke", _scratch.setY(centreY + scale * 0.5), {
        count: Math.round(spec.smoke * 0.5),
        radius: scale * 0.9,
        speed: scale * 2.4,
        life: 3.4,
        size: scale * 0.7,
        sizeEnd: scale * 2.6,
        upBias: 3.2,
        turbulence: scale * 0.2,
      });
    }

    this.launchDebris(position, groundY, spec, scale);
    if (spec.scorch > 0) this.decals.scorch(position.x, position.z, scale * spec.scorch);
  }

  /** Steps the debris only; the other layers run on the GPU. */
  update(deltaSeconds: number): void {
    this.time += deltaSeconds;
    this.ballMaterial.uniforms.uTime.value = this.time;
    this.ringMaterial.uniforms.uTime.value = this.time;
    this.particles.update(deltaSeconds);
    this.decals.update(deltaSeconds);

    let live = 0;
    for (const chunk of this.chunks) {
      if (!chunk.active) continue;
      chunk.age += deltaSeconds;
      if (chunk.age >= chunk.life) {
        chunk.active = false;
        continue;
      }

      if (!chunk.settled) {
        chunk.vy -= 26 * deltaSeconds;
        chunk.x += chunk.vx * deltaSeconds;
        chunk.y += chunk.vy * deltaSeconds;
        chunk.z += chunk.vz * deltaSeconds;
        const ground = this.terrain.sample(chunk.x, chunk.z) + chunk.size * 0.4;
        if (chunk.y <= ground) {
          chunk.y = ground;
          if (Math.abs(chunk.vy) < 2.2) {
            // Settled chunks stop integrating entirely; they just sit there.
            chunk.settled = true;
            chunk.vx = 0;
            chunk.vy = 0;
            chunk.vz = 0;
          } else {
            chunk.vy = -chunk.vy * 0.34;
            chunk.vx *= 0.62;
            chunk.vz *= 0.62;
            chunk.spin *= 0.5;
          }
        }
      }

      // Chunks shrink into the dirt over the last third of their life.
      const remaining = 1 - chunk.age / chunk.life;
      const fade = remaining < 0.34 ? remaining / 0.34 : 1;
      _scratchB.set(chunk.x, chunk.y, chunk.z);
      _quaternion.setFromAxisAngle(_up, chunk.spin * chunk.age);
      _scratch.set(chunk.size * fade, chunk.size * fade, chunk.size * fade);
      _matrix.compose(_scratchB, _quaternion, _scratch);
      this.debris.setMatrixAt(live, _matrix);
      this.debris.setColorAt(live, _color.setHex(chunk.tint));
      live++;
    }

    this.debris.count = live;
    if (live === 0) return;
    this.debris.instanceMatrix.needsUpdate = true;
    if (this.debris.instanceColor) this.debris.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.ballGeometry.dispose();
    this.ballMaterial.dispose();
    this.ringGeometry.dispose();
    this.ringMaterial.dispose();
    this.debrisGeometry.dispose();
    (this.debris.material as THREE.Material).dispose();
    this.debris.dispose();
    this.particles.dispose();
    this.decals.dispose();
  }

  private launchDebris(position: THREE.Vector3, groundY: number, spec: KindSpec, scale: number): void {
    for (let i = 0; i < spec.debris; i++) {
      const index = this.chunkHead;
      this.chunkHead = index + 1 === this.debrisCapacity ? 0 : index + 1;
      const chunk = this.chunks[index];

      const angle = Math.random() * Math.PI * 2;
      const lift = 0.35 + Math.random() * 0.65;
      const speed = spec.debrisSpeed * (0.5 + Math.random() * 0.8);

      chunk.active = true;
      chunk.age = 0;
      chunk.life = 2.2 + Math.random() * 1.8;
      chunk.size = scale * (0.05 + Math.random() * 0.09) + 0.05;
      chunk.x = position.x;
      chunk.y = Math.max(position.y, groundY) + chunk.size;
      chunk.z = position.z;
      chunk.vx = Math.cos(angle) * speed * (1 - lift);
      chunk.vy = speed * lift;
      chunk.vz = Math.sin(angle) * speed * (1 - lift);
      chunk.spin = (Math.random() * 2 - 1) * 9;
      chunk.settled = false;
      chunk.tint = Math.random() < 0.5 ? 0x3a352e : 0x555049;
    }
  }

  private writeBall(at: THREE.Vector3, size: number, life: number, colour: number): void {
    const index = this.ballHead;
    this.ballHead = index + 1 === this.capacity ? 0 : index + 1;
    if (this.ballSpawned < this.capacity) this.ballSpawned++;

    const i3 = index * 3;
    const i4 = index * 4;
    this.ballCentres[i3] = at.x;
    this.ballCentres[i3 + 1] = at.y;
    this.ballCentres[i3 + 2] = at.z;
    this.ballParams[i4] = this.time;
    this.ballParams[i4 + 1] = life;
    this.ballParams[i4 + 2] = size;
    this.ballParams[i4 + 3] = Math.random();

    _color.setHex(colour);
    this.ballColors[i3] = _color.r;
    this.ballColors[i3 + 1] = _color.g;
    this.ballColors[i3 + 2] = _color.b;

    const count = Math.min(this.ballSpawned, this.capacity);
    if (count > this.ballGeometry.instanceCount) this.ballGeometry.instanceCount = count;
    for (const attribute of this.ballBuffers) {
      attribute.addUpdateRange(index * attribute.itemSize, attribute.itemSize);
      // addUpdateRange only records the span; needsUpdate is what makes the
      // renderer upload it.
      attribute.needsUpdate = true;
    }
  }

  private writeRing(at: THREE.Vector3, size: number, life: number, colour: number): void {
    const index = this.ringHead;
    this.ringHead = index + 1 === this.capacity ? 0 : index + 1;
    if (this.ringSpawned < this.capacity) this.ringSpawned++;

    const i3 = index * 3;
    const i4 = index * 4;
    this.ringCentres[i3] = at.x;
    this.ringCentres[i3 + 1] = at.y;
    this.ringCentres[i3 + 2] = at.z;
    this.ringParams[i4] = this.time;
    this.ringParams[i4 + 1] = life;
    this.ringParams[i4 + 2] = size;
    this.ringParams[i4 + 3] = Math.random() * 10;

    _color.setHex(colour);
    this.ringColors[i3] = _color.r;
    this.ringColors[i3 + 1] = _color.g;
    this.ringColors[i3 + 2] = _color.b;

    const count = Math.min(this.ringSpawned, this.capacity);
    if (count > this.ringGeometry.instanceCount) this.ringGeometry.instanceCount = count;
    for (const attribute of this.ringBuffers) {
      attribute.addUpdateRange(index * attribute.itemSize, attribute.itemSize);
      // addUpdateRange only records the span; needsUpdate is what makes the
      // renderer upload it.
      attribute.needsUpdate = true;
    }
  }

  private attribute(
    array: Float32Array,
    size: number,
    registry: THREE.InstancedBufferAttribute[],
  ): THREE.InstancedBufferAttribute {
    const attribute = new THREE.InstancedBufferAttribute(array, size);
    attribute.setUsage(THREE.DynamicDrawUsage);
    registry.push(attribute);
    return attribute;
  }
}
