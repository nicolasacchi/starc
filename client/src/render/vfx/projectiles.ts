/**
 * Bullets, cannons, missiles, plasma and beam bolts.
 *
 * Every shot is one instance in a single pooled draw: the vertex shader walks
 * it along its own velocity vector from a birth stamp, stretches the billboard
 * along that velocity into a tracer, and adds the arc a missile flies. Nothing
 * about a projectile is stepped on the CPU except the two things a GPU cannot
 * know — when it lands, and how much smoke it drags behind it — and those are
 * driven by a small preallocated table, not by the render loop.
 *
 * Muzzle flashes, impact sparks and missile smoke come from a private particle
 * system, so shots look the same whether or not anything else is emitting.
 * Every sprite is generated in JavaScript; nothing is loaded.
 */
import * as THREE from "three";
import type { Race } from "@shared/protocol";
import { raceColorInt } from "@shared/gameData";
import type { QualitySettings } from "@render/core/quality";
import type { HeightField } from "@render/terrain/heightfield";
import { ParticleSystem, instancedQuad, softSpriteTexture } from "./particleSystem";

/** The shots a weapon can throw. */
export type ProjectileKind = "bullet" | "cannon" | "shell" | "missile" | "plasma" | "claw" | "beam";

interface KindSpec {
  /** Billboard half-width, metres. */
  size: number;
  /** Seconds of travel the tracer is stretched over. */
  stretch: number;
  colour: number;
  brightness: number;
  /** Peak height of the missile's arc as a fraction of the shot's range. */
  arc: number;
  /** Size pulsing, 0..1; plasma breathes, a bullet does not. */
  pulse: number;
  /** Smoke puffs emitted per second of flight. */
  smoke: number;
  /** Impact sparks thrown on landing. */
  sparks: number;
}

const KINDS: Readonly<Record<ProjectileKind, KindSpec>> = {
  bullet: { size: 0.055, stretch: 0.018, colour: 0xfff0b0, brightness: 1.5, arc: 0, pulse: 0, smoke: 0, sparks: 2 },
  cannon: { size: 0.15, stretch: 0.04, colour: 0xffc266, brightness: 1.4, arc: 0, pulse: 0, smoke: 8, sparks: 6 },
  missile: { size: 0.17, stretch: 0.06, colour: 0xd8d8d8, brightness: 1.1, arc: 0.16, pulse: 0, smoke: 26, sparks: 4 },
  plasma: { size: 0.3, stretch: 0.022, colour: 0x7fd8ff, brightness: 2.2, arc: 0, pulse: 0.35, smoke: 0, sparks: 10 },
  // Siege shell: slow, fat, and trailing smoke the whole way in.
  shell: { size: 0.26, stretch: 0.05, colour: 0xffa040, brightness: 1.5, arc: 0.08, pulse: 0, smoke: 20, sparks: 10 },
  // Zerg claw: a short acid-green arc that sprays on impact.
  claw: { size: 0.14, stretch: 0.03, colour: 0xa8e04a, brightness: 1.6, arc: 0.12, pulse: 0.2, smoke: 0, sparks: 5 },
  beam: { size: 0.22, stretch: 0.55, colour: 0xffffff, brightness: 2.6, arc: 0, pulse: 0.1, smoke: 0, sparks: 3 },
};

const PROJECTILE_VERT = /* glsl */ `
attribute vec3 aFrom;
attribute vec3 aDir;
attribute vec4 aMotion;
attribute vec4 aColor;
attribute vec2 aArc;

uniform float uTime;

varying vec2 vUv;
varying vec3 vColor;
varying float vFade;
varying float vHead;

void main() {
  float age = uTime - aArc.x;
  float life = aMotion.y;
  vUv = uv;
  vColor = aColor.rgb;
  vFade = 0.0;
  vHead = 0.0;

  if ( life <= 0.0 || age < 0.0 || age > life ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    return;
  }

  float t = age / life;
  vFade = smoothstep( 0.0, 0.04, t ) * ( 1.0 - smoothstep( 0.82, 1.0, t ) );
  vHead = uv.x;

  vec3 world = aFrom + aDir * ( aMotion.x * age );
  float arc = aArc.y;
  if ( arc > 0.0 ) {
    world.y += sin( t * 3.14159265 ) * arc;
  }

  float size = aMotion.z * ( 1.0 + sin( age * 42.0 ) * aMotion.w );
  // The tracer spans a slice of the flight path, so it stretches with speed:
  // a rifle round is a hair, a siege cannon is a streak down the field.
  float halfLength = max( size * 2.0, aMotion.x * aColor.w * 0.5 );

  vec3 toCamera = cameraPosition - world;
  vec3 side = cross( aDir, toCamera );
  float sideLength = length( side );
  side = sideLength > 0.0001 ? side / sideLength : vec3( 1.0, 0.0, 0.0 );

  // Taper the tail so the tracer reads as a streak, not a rectangle.
  float taper = 0.35 + 0.65 * sin( uv.x * 3.14159265 );
  vec3 corner =
    aDir * ( ( uv.x - 0.5 ) * 2.0 * halfLength * taper ) +
    side * ( ( uv.y - 0.5 ) * 2.0 * size );

  gl_Position = projectionMatrix * modelViewMatrix * vec4( world + corner, 1.0 );
}
`;

const PROJECTILE_FRAG = /* glsl */ `
uniform sampler2D uSprite;

varying vec2 vUv;
varying vec3 vColor;
varying float vFade;
varying float vHead;

void main() {
  vec4 sprite = texture2D( uSprite, vUv );
  // Bright at the head, gone at the tail: a tracer, not a capsule.
  float along = pow( clamp( vHead, 0.0, 1.0 ), 1.6 );
  float alpha = sprite.a * vFade * along;
  if ( alpha < 0.004 ) discard;
  gl_FragColor = vec4( vColor * ( 0.6 + 0.8 * along ) * sprite.rgb, alpha );
}
`;

const FLASH_VERT = /* glsl */ `
attribute vec3 aCentre;
attribute vec4 aParams;
attribute vec3 aColor;

uniform float uTime;

varying vec2 vUv;
varying vec3 vColor;
varying float vFade;

void main() {
  float age = uTime - aParams.x;
  float life = aParams.y;
  vUv = uv;
  vColor = aColor;
  vFade = 0.0;
  if ( life <= 0.0 || age < 0.0 || age > life ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    return;
  }
  float t = age / life;
  vFade = pow( 1.0 - t, 2.2 );
  vec4 view = modelViewMatrix * vec4( aCentre, 1.0 );
  view.xy += position.xy * aParams.z * ( 0.5 + 1.1 * t );
  gl_Position = projectionMatrix * view;
}
`;

const FLASH_FRAG = /* glsl */ `
uniform sampler2D uSprite;

varying vec2 vUv;
varying vec3 vColor;
varying float vFade;

void main() {
  vec4 sprite = texture2D( uSprite, vUv );
  float alpha = sprite.a * vFade;
  if ( alpha < 0.004 ) discard;
  gl_FragColor = vec4( vColor * sprite.rgb, alpha );
}
`;

/** One live shot, mirrored on the CPU for trails and impacts. */
interface Shot {
  birth: number;
  life: number;
  speed: number;
  smoke: number;
  sparks: number;
  smokeClock: number;
  impacted: boolean;
  x: number;
  y: number;
  z: number;
  tx: number;
  ty: number;
  tz: number;
}

const _direction = new THREE.Vector3();
const _color = new THREE.Color();
const _race = new THREE.Color();
const _inherit = new THREE.Vector3();
const _at = new THREE.Vector3();

/**
 * Pooled projectiles with stretched tracers, muzzle flashes, missile smoke and
 * impact sparks.
 */
export class ProjectileSystem {
  /** Root of the projectile draw calls; already added to the scene. */
  readonly group = new THREE.Group();
  /** Shots the pool holds before it starts recycling. */
  readonly capacity: number;

  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly flashGeometry: THREE.InstancedBufferGeometry;
  private readonly flashMaterial: THREE.ShaderMaterial;
  private readonly sprite: THREE.DataTexture;
  private readonly particles: ParticleSystem;

  private readonly from: Float32Array;
  private readonly dirs: Float32Array;
  private readonly motion: Float32Array;
  private readonly colors: Float32Array;
  private readonly arcs: Float32Array;
  private readonly flashCentres: Float32Array;
  private readonly flashParams: Float32Array;
  private readonly flashColors: Float32Array;
  private readonly buffers: THREE.InstancedBufferAttribute[] = [];
  private readonly flashBuffers: THREE.InstancedBufferAttribute[] = [];
  private readonly shots: Shot[] = [];
  private readonly terrain: HeightField;

  private readonly flashCapacity: number;

  private head = 0;
  private spawned = 0;
  private flashHead = 0;
  private flashSpawned = 0;
  private time = 0;
  private nextId = 1;

  constructor(scene: THREE.Scene, settings: QualitySettings, terrain: HeightField) {
    this.terrain = terrain;
    this.capacity = settings.postFx ? 384 : 160;
    this.flashCapacity = settings.postFx ? 96 : 32;
    this.group.name = "projectiles";
    this.sprite = softSpriteTexture(1.6, 64);

    this.particles = new ParticleSystem(scene, {
      ...settings,
      particleBudget: Math.max(256, Math.round(settings.particleBudget * 0.35)),
    });

    this.geometry = instancedQuad();
    this.from = new Float32Array(this.capacity * 3);
    this.dirs = new Float32Array(this.capacity * 3);
    this.motion = new Float32Array(this.capacity * 4);
    this.colors = new Float32Array(this.capacity * 4);
    this.arcs = new Float32Array(this.capacity * 2);
    this.geometry.setAttribute("aFrom", this.attribute(this.from, 3, this.buffers));
    this.geometry.setAttribute("aDir", this.attribute(this.dirs, 3, this.buffers));
    this.geometry.setAttribute("aMotion", this.attribute(this.motion, 4, this.buffers));
    this.geometry.setAttribute("aColor", this.attribute(this.colors, 4, this.buffers));
    this.geometry.setAttribute("aArc", this.attribute(this.arcs, 2, this.buffers));
    this.geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uSprite: { value: this.sprite } },
      vertexShader: PROJECTILE_VERT,
      fragmentShader: PROJECTILE_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });

    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 7;
    mesh.name = "projectiles";
    this.group.add(mesh);

    this.flashGeometry = instancedQuad();
    this.flashCentres = new Float32Array(this.flashCapacity * 3);
    this.flashParams = new Float32Array(this.flashCapacity * 4);
    this.flashColors = new Float32Array(this.flashCapacity * 3);
    this.flashGeometry.setAttribute("aCentre", this.attribute(this.flashCentres, 3, this.flashBuffers));
    this.flashGeometry.setAttribute("aParams", this.attribute(this.flashParams, 4, this.flashBuffers));
    this.flashGeometry.setAttribute("aColor", this.attribute(this.flashColors, 3, this.flashBuffers));
    this.flashGeometry.instanceCount = 0;

    this.flashMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uSprite: { value: this.sprite } },
      vertexShader: FLASH_VERT,
      fragmentShader: FLASH_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });

    const flashMesh = new THREE.Mesh(this.flashGeometry, this.flashMaterial);
    flashMesh.frustumCulled = false;
    flashMesh.renderOrder = 8;
    flashMesh.name = "muzzle-flashes";
    this.group.add(flashMesh);

    for (let i = 0; i < this.capacity; i++) {
      this.shots.push({
        birth: -1, life: 0, speed: 0, smoke: 0, sparks: 0, smokeClock: 0,
        impacted: true, x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0,
      });
    }

    scene.add(this.group);
  }

  /** Shots the pool holds. */
  get shotCount(): number {
    return Math.min(this.spawned, this.capacity);
  }

  /**
   * Fires one shot. Returns its id, or 0 when the pool is not accepting work.
   * The tracer is the flight path itself, so `speed` is what sells the weapon:
   * a rifle round is a hair, a siege cannon is a streak.
   */
  fire(kind: ProjectileKind, from: THREE.Vector3, to: THREE.Vector3, speed: number, race: Race): number {
    const spec = KINDS[kind];
    if (!(speed > 0)) return 0;

    _direction.subVectors(to, from);
    const range = _direction.length();
    if (range < 0.01) return 0;
    _direction.multiplyScalar(1 / range);

    const index = this.head;
    this.head = index + 1 === this.capacity ? 0 : index + 1;
    if (this.spawned < this.capacity) this.spawned++;

    // The tracer covers `stretch` seconds of flight, so it is a real streak and
    // not a fixed-length sprite that would swallow a slow shot whole.
    const travel = range / speed;
    const life = travel + Math.min(0.25, spec.stretch);
    const i3 = index * 3;
    const i4 = index * 4;

    this.from[i3] = from.x;
    this.from[i3 + 1] = from.y;
    this.from[i3 + 2] = from.z;
    this.dirs[i3] = _direction.x;
    this.dirs[i3 + 1] = _direction.y;
    this.dirs[i3 + 2] = _direction.z;

    this.motion[i4] = speed;
    this.motion[i4 + 1] = life;
    this.motion[i4 + 2] = spec.size;
    this.motion[i4 + 3] = spec.pulse;

    _color.setHex(spec.colour).lerp(_race.setHex(raceColorInt(race)), 0.4).multiplyScalar(spec.brightness);
    this.colors[i4] = _color.r;
    this.colors[i4 + 1] = _color.g;
    this.colors[i4 + 2] = _color.b;
    this.colors[i4 + 3] = spec.stretch;

    this.arcs[index * 2] = this.time;
    this.arcs[index * 2 + 1] = spec.arc * range;

    const count = Math.min(this.spawned, this.capacity);
    if (count > this.geometry.instanceCount) this.geometry.instanceCount = count;
    for (const attribute of this.buffers) {
      attribute.addUpdateRange(index * attribute.itemSize, attribute.itemSize);
      // addUpdateRange only records the span; needsUpdate is what makes the
      // renderer upload it.
      attribute.needsUpdate = true;
    }

    const shot = this.shots[index];
    shot.birth = this.time;
    shot.life = life;
    shot.speed = speed;
    shot.smoke = spec.smoke;
    shot.sparks = spec.sparks;
    shot.smokeClock = 0;
    shot.impacted = false;
    shot.x = from.x;
    shot.y = from.y;
    shot.z = from.z;
    shot.tx = to.x;
    shot.ty = to.y;
    shot.tz = to.z;

    this.flash(from, spec.size * (kind === "plasma" ? 9 : 7), spec.colour, 0.09);
    if (kind === "cannon" || kind === "missile") {
      this.particles.burst("smoke", from, {
        count: 3,
        radius: spec.size * 2,
        speed: 3,
        life: 0.9,
        size: spec.size * 2.4,
        sizeEnd: spec.size * 6,
        inherit: _inherit.copy(_direction).multiplyScalar(speed * 0.12),
      });
    }
    return this.nextId++;
  }

  /**
   * Advances the tracers and drives the one thing the GPU cannot know about:
   * when each shot lands, so its trail stops and its impact plays.
   */
  update(deltaSeconds: number): void {
    this.time += deltaSeconds;
    this.material.uniforms.uTime.value = this.time;
    this.flashMaterial.uniforms.uTime.value = this.time;
    this.particles.update(deltaSeconds);

    const live = Math.min(this.spawned, this.capacity);
    for (let index = 0; index < live; index++) {
      const shot = this.shots[index];
      const age = this.time - shot.birth;
      if (age < 0 || age > shot.life) continue;

      const progress = age / shot.life;
      _at.set(
        shot.x + (shot.tx - shot.x) * progress,
        shot.y + (shot.ty - shot.y) * progress,
        shot.z + (shot.tz - shot.z) * progress,
      );

      if (shot.smoke > 0) {
        shot.smokeClock += deltaSeconds * shot.smoke;
        while (shot.smokeClock >= 1) {
          shot.smokeClock -= 1;
          this.particles.burst("smoke", _at, { count: 1, radius: 0.1, speed: 0.5, life: 1.1, size: 0.28, sizeEnd: 1.5 });
        }
      }

      if (!shot.impacted && age >= shot.life - 0.02) {
        shot.impacted = true;
        this.impact(_at, shot.sparks);
      }
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.flashGeometry.dispose();
    this.flashMaterial.dispose();
    this.sprite.dispose();
    this.particles.dispose();
  }

  private impact(at: THREE.Vector3, sparks: number): void {
    if (sparks > 0) {
      this.particles.burst("spark", at, { count: sparks, speed: 9, radius: 0.15, life: 0.35, size: 0.14, sizeEnd: 0.02 });
    }
    // Kick the dust up off whatever the shot actually hit rather than off the
    // point the tracer happened to end at.
    _at.set(at.x, Math.max(this.terrain.sample(at.x, at.z), at.y) + 0.1, at.z);
    this.particles.burst("dust", _at, { count: 3, radius: 0.3, speed: 2.4, life: 0.8, size: 0.4, sizeEnd: 1.4 });
    this.flash(at, 1.4, 0xffd9a0, 0.16);
  }

  private flash(at: THREE.Vector3, size: number, colour: THREE.ColorRepresentation, duration: number): void {
    const index = this.flashHead;
    this.flashHead = index + 1 === this.flashCapacity ? 0 : index + 1;
    if (this.flashSpawned < this.flashCapacity) this.flashSpawned++;

    const i3 = index * 3;
    const i4 = index * 4;
    this.flashCentres[i3] = at.x;
    this.flashCentres[i3 + 1] = at.y;
    this.flashCentres[i3 + 2] = at.z;
    this.flashParams[i4] = this.time;
    this.flashParams[i4 + 1] = duration;
    this.flashParams[i4 + 2] = size;

    _color.set(colour);
    this.flashColors[i3] = _color.r;
    this.flashColors[i3 + 1] = _color.g;
    this.flashColors[i3 + 2] = _color.b;

    const count = Math.min(this.flashSpawned, this.flashCapacity);
    if (count > this.flashGeometry.instanceCount) this.flashGeometry.instanceCount = count;
    for (const attribute of this.flashBuffers) {
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

