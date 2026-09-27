/**
 * Ground decals: scorch marks, blood splatter and the build placement grid.
 *
 * Decals conform to the terrain instead of hovering over it: each one samples
 * the height field at its four corners and the vertex shader reconstructs the
 * same bilinear surface `HeightField.sample` returns, so a scorch mark wraps
 * over a ridge rather than clipping through it. The surface normal falls out of
 * the screen-space derivatives of that reconstruction, which is what lets a
 * decal take the sun's direction without storing a normal per instance.
 *
 * Everything is a pooled, instanced quad — one draw call for every mark on the
 * map — plus a placement grid that is a single mesh toggled on and off. The
 * atlas is generated in JavaScript, so no image is loaded.
 */
import * as THREE from "three";
import type { MapDef, Race } from "@shared/protocol";
import type { QualitySettings } from "@render/core/quality";
import { heightField, type HeightField } from "@render/terrain/heightfield";

/** Marks a decal can leave. */
export type DecalKind = "scorch" | "blood";

/** Seconds a mark survives — long enough to still be there when you look back. */
const DECAL_LIFE = 20;
/** Lifts a mark off the ground far enough to beat z-fighting. */
const DECAL_LIFT = 0.04;

const DECAL_VERT = /* glsl */ `
attribute vec3 aCentre;
attribute vec3 aRight;
attribute vec3 aUp;
attribute vec4 aCorner;
attribute vec4 aParams;
attribute vec3 aTint;
attribute float aRadius;

uniform float uTime;

varying vec2 vUv;
varying vec3 vTint;
varying vec3 vWorld;
varying float vAge;
varying float vLife;
varying float vAtlasOffset;

void main() {
  float age = uTime - aParams.x;
  float life = aParams.y;
  vUv = uv;
  vTint = aTint;
  vWorld = aCentre;
  vAge = 0.0;
  vLife = 1.0;
  vAtlasOffset = aParams.z;

  if ( life <= 0.0 || age < 0.0 || age > life ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    return;
  }

  // A mark creeps outward very slightly as it burns in, then holds.
  float radius = aRadius * ( 0.94 + 0.06 * clamp( age / 0.35, 0.0, 1.0 ) );
  vec2 q = uv * 2.0 - 1.0;
  vec3 world = aCentre + aRight * ( q.x * radius ) + aUp * ( q.y * radius );

  // The same bilinear surface HeightField.sample returns for the four corners,
  // so the quad lies exactly on the terrain between them.
  world.y += mix(
    mix( aCorner.x, aCorner.y, uv.x ),
    mix( aCorner.z, aCorner.w, uv.x ),
    uv.y
  );

  vAge = age;
  vLife = life;
  vWorld = world;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( world, 1.0 );
}
`;

const DECAL_FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uLightDirection;

varying vec2 vUv;
varying vec3 vTint;
varying vec3 vWorld;
varying float vAge;
varying float vLife;
varying float vAtlasOffset;

void main() {
  float t = clamp( vAge / max( vLife, 0.0001 ), 0.0, 1.0 );
  vec4 tex = texture2D( uAtlas, vec2( vUv.x, vAtlasOffset + vUv.y * 0.5 ) );
  if ( tex.a < 0.01 ) discard;

  // Screen-space derivatives of the reconstructed surface give the true terrain
  // normal, so a mark on a slope shades like the slope it sits on.
  vec3 normal = normalize( cross( dFdx( vWorld ), dFdy( vWorld ) ) );
  float lambert = 0.6 + 0.4 * abs( dot( normal, uLightDirection ) );

  // Fast burn-in, long hold, then a slow fade out over the mark's life.
  float fade = smoothstep( 0.0, 0.05, t ) * ( 1.0 - smoothstep( 0.55, 1.0, t ) );
  float alpha = tex.a * fade;
  if ( alpha < 0.004 ) discard;

  gl_FragColor = vec4( vTint * tex.rgb * lambert, alpha );
}
`;

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

function fbm(u: number, v: number, seed: number): number {
  return valueNoise(u * 6, v * 6, seed) * 0.6 + valueNoise(u * 15, v * 15, seed + 3.1) * 0.4;
}

function smoothstep01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

function finishTexture(data: Uint8Array, size: number, anisotropy: number, name: string): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.name = name;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = Math.max(1, anisotropy);
  texture.needsUpdate = true;
  return texture;
}

/**
 * One atlas: scorch in the top half, blood in the bottom. Both are radial
 * falloffs pushed around by noise, so no two marks look stamped from one mould.
 */
function decalAtlas(size: number, anisotropy: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const half = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const dx = u - 0.5;
      const dy = v - 0.5;
      const d = Math.min(1, Math.hypot(dx, dy) * 2);
      const angle = Math.atan2(dy, dx);
      const n = fbm(u * 2.4, v * 2.4, 1.9);

      if (y < half) {
        // Scorch: a charred core, a ragged ring, and a faint warm halo.
        const edge = d / (0.72 + 0.28 * n + 0.1 * Math.sin(angle * 5 + n * 6));
        const char = 1 - smoothstep01(edge / 0.55);
        const alpha = (1 - smoothstep01((edge - 0.15) / 0.85)) * (0.75 + 0.25 * n);
        const shade = (0.7 + 0.3 * n) * 255;
        data[o] = Math.round(Math.min(255, (0.16 + 0.5 * (1 - char)) * shade));
        data[o + 1] = Math.round(Math.min(255, (0.13 + 0.22 * (1 - char)) * shade));
        data[o + 2] = Math.round(Math.min(255, (0.12 + 0.1 * (1 - char)) * shade));
        data[o + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
      } else {
        // Blood: a central pool with satellite spatter.
        const pool = 1 - smoothstep01((d / (0.45 + 0.35 * (0.5 + 0.5 * n)) - 0.2) / 0.8);
        const speck = valueNoise(u * 26, v * 26, 7.3) > 0.72 ? (1 - smoothstep01((d - 0.35) / 0.6)) * 0.9 : 0;
        data[o] = 120;
        data[o + 1] = 18;
        data[o + 2] = 18;
        data[o + 3] = Math.round(Math.max(0, Math.min(1, Math.min(1, pool + speck))) * 235);
      }
    }
  }

  return finishTexture(data, size, anisotropy, "decal-atlas");
}

/** Build grid: a bordered cell lattice. */
function gridTexture(size: number, anisotropy: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const cells = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const cellU = Math.abs(((u * cells) % 1) - 0.5);
      const cellV = Math.abs(((v * cells) % 1) - 0.5);
      const line = 1 - smoothstep01((Math.min(cellU, cellV) - 0.42) / 0.06);
      const border = 1 - smoothstep01((Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2 - 0.9) / 0.08);
      const shade = 200 + Math.round(55 * line);
      const o = (y * size + x) * 4;
      data[o] = shade;
      data[o + 1] = shade;
      data[o + 2] = shade;
      data[o + 3] = Math.round(Math.min(1, line * 0.45 + border) * 255);
    }
  }
  return finishTexture(data, size, anisotropy, "build-grid");
}

const TINTS: Readonly<Record<DecalKind, number>> = { scorch: 0xffffff, blood: 0xd8b0b0 };
const ATLAS_OFFSET: Readonly<Record<DecalKind, number>> = { scorch: 0.5, blood: 0 };
/** Zerg ichor, for `splatter`. */
const ICHOR_TINT = 0x9fd05a;

/**
 * Pooled ground marks plus the placement grid.
 *
 * Marks live in a ring buffer, so a hundred dead marines leave exactly as many
 * objects as one does. Fading is evaluated in the shader from a birth stamp, so
 * `update()` is a uniform write.
 */
export class DecalSystem {
  /** Direction decals shade against; point this at the sun. */
  readonly sunDirection = new THREE.Vector3(0.35, 0.85, 0.4);
  /** Root of the decal draw calls; already added to the scene. */
  readonly group = new THREE.Group();
  /** The build placement grid; visible only between show and hide. */
  readonly grid: THREE.Mesh;
  /** Marks the pool holds before it starts recycling. */
  readonly capacity: number;

  private readonly terrain: HeightField;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly gridMaterial: THREE.MeshBasicMaterial;
  private readonly atlas: THREE.DataTexture;
  private readonly gridMap: THREE.DataTexture;
  private readonly centres: Float32Array;
  private readonly rights: Float32Array;
  private readonly ups: Float32Array;
  private readonly corners: Float32Array;
  private readonly params: Float32Array;
  private readonly tints: Float32Array;
  private readonly radii: Float32Array;
  private readonly buffers: THREE.InstancedBufferAttribute[] = [];
  private dirtyLo = Number.POSITIVE_INFINITY;
  private dirtyHi = -1;
  private head = 0;
  private spawned = 0;
  private time = 0;

  constructor(scene: THREE.Scene, map: MapDef, settings: QualitySettings, terrain?: HeightField) {
    this.terrain = terrain ?? heightField(map);
    this.capacity = settings.postFx ? 256 : 128;
    this.group.name = "decals";

    const plane = new THREE.PlaneGeometry(1, 1, 1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = plane.index;
    this.geometry.setAttribute("position", plane.getAttribute("position"));
    this.geometry.setAttribute("uv", plane.getAttribute("uv"));
    plane.dispose();

    this.centres = new Float32Array(this.capacity * 3);
    this.rights = new Float32Array(this.capacity * 3);
    this.ups = new Float32Array(this.capacity * 3);
    this.corners = new Float32Array(this.capacity * 4);
    this.params = new Float32Array(this.capacity * 4);
    this.tints = new Float32Array(this.capacity * 3);
    this.radii = new Float32Array(this.capacity);

    this.geometry.setAttribute("aCentre", this.attribute(this.centres, 3));
    this.geometry.setAttribute("aRight", this.attribute(this.rights, 3));
    this.geometry.setAttribute("aUp", this.attribute(this.ups, 3));
    this.geometry.setAttribute("aCorner", this.attribute(this.corners, 4));
    this.geometry.setAttribute("aParams", this.attribute(this.params, 4));
    this.geometry.setAttribute("aTint", this.attribute(this.tints, 3));
    this.geometry.setAttribute("aRadius", this.attribute(this.radii, 1));
    this.geometry.instanceCount = 0;

    const anisotropy = settings.anisotropy;
    this.atlas = decalAtlas(128, anisotropy);
    this.gridMap = gridTexture(128, anisotropy);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAtlas: { value: this.atlas },
        uLightDirection: { value: this.sunDirection },
      },
      vertexShader: DECAL_VERT,
      fragmentShader: DECAL_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -12,
      toneMapped: false,
    });

    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.name = "decals";
    this.group.add(mesh);

    this.gridMaterial = new THREE.MeshBasicMaterial({
      map: this.gridMap,
      color: 0x66ff88,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -8,
      polygonOffsetUnits: -16,
    });

    const gridGeometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    gridGeometry.rotateX(-Math.PI / 2);
    this.grid = new THREE.Mesh(gridGeometry, this.gridMaterial);
    this.grid.name = "build-grid";
    this.grid.visible = false;
    this.grid.renderOrder = 3;
    this.group.add(this.grid);

    scene.add(this.group);
  }

  /** Marks currently inside their lifetime, upper bound. */
  get liveCount(): number {
    return Math.min(this.spawned, this.capacity);
  }

  /** A charred mark, as left by fire or a collapsing building. */
  scorch(position: THREE.Vector3, radius: number, yaw = Math.random() * Math.PI): void {
    this.place("scorch", position.x, position.z, radius, yaw);
  }

  /**
   * Blood and ichor. Zerg ichor is green and thicker than the red the other
   * two races leave behind, so the race picks the tint.
   */
  splatter(
    position: THREE.Vector3,
    radius: number,
    kind: DecalKind | Race,
    yaw = Math.random() * Math.PI,
  ): void {
    this.place("blood", position.x, position.z, radius, yaw, kind === "zerg");
  }

  /**
   * Shows the build placement grid. `valid` tints it green or red; calling it
   * again with a new position moves the same mesh, it never allocates.
   */
  showGrid(x: number, z: number, radius: number, yaw: number, valid: boolean): void {
    this.grid.position.set(x, this.terrain.sample(x, z) + DECAL_LIFT + 0.02, z);
    this.grid.rotation.set(0, yaw, 0);
    this.grid.scale.set(radius * 2, 1, radius * 2);
    this.gridMaterial.color.setHex(valid ? 0x66ff88 : 0xff5544);
    this.grid.visible = true;
  }

  hideGrid(): void {
    this.grid.visible = false;
  }

  update(deltaSeconds: number): void {
    this.time += deltaSeconds;
    this.material.uniforms.uTime.value = this.time;

    if (this.dirtyHi < this.dirtyLo) return;
    const first = this.dirtyLo;
    const count = this.dirtyHi - first + 1;
    for (const attribute of this.buffers) {
      attribute.addUpdateRange(first * attribute.itemSize, count * attribute.itemSize);
      // addUpdateRange only records the span; needsUpdate is what makes the
      // renderer upload it.
      attribute.needsUpdate = true;
    }
    this.dirtyLo = Number.POSITIVE_INFINITY;
    this.dirtyHi = -1;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.atlas.dispose();
    this.grid.geometry.dispose();
    this.gridMaterial.dispose();
    this.gridMap.dispose();
  }

  private place(kind: DecalKind, x: number, z: number, radius: number, yaw: number, ichor = false): void {
    if (!(radius > 0)) return;
    const index = this.head;
    this.head = index + 1 === this.capacity ? 0 : index + 1;
    if (this.spawned < this.capacity) this.spawned++;

    const i3 = index * 3;
    const i4 = index * 4;
    const size = Math.max(0.25, radius);

    // A rotated square footprint; its corners are what the shader rebuilds the
    // terrain height from. `right` and `up` here are ground-plane directions.
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const rx = cos * size;
    const rz = -sin * size;
    const ux = sin * size;
    const uz = cos * size;

    this.centres[i3] = x;
    this.centres[i3 + 1] = 0;
    this.centres[i3 + 2] = z;
    this.rights[i3] = rx;
    this.rights[i3 + 1] = 0;
    this.rights[i3 + 2] = rz;
    this.ups[i3] = ux;
    this.ups[i3 + 1] = 0;
    this.ups[i3 + 2] = uz;

    this.corners[i4] = this.terrain.sample(x - rx - ux, z - rz - uz) + DECAL_LIFT;
    this.corners[i4 + 1] = this.terrain.sample(x + rx - ux, z + rz - uz) + DECAL_LIFT;
    this.corners[i4 + 2] = this.terrain.sample(x - rx + ux, z - rz + uz) + DECAL_LIFT;
    this.corners[i4 + 3] = this.terrain.sample(x + rx + ux, z + rz + uz) + DECAL_LIFT;

    this.params[i4] = this.time;
    this.params[i4 + 1] = DECAL_LIFE;
    this.params[i4 + 2] = ATLAS_OFFSET[kind];

    const tint = ichor ? ICHOR_TINT : TINTS[kind];
    this.tints[i3] = ((tint >> 16) & 0xff) / 255;
    this.tints[i3 + 1] = ((tint >> 8) & 0xff) / 255;
    this.tints[i3 + 2] = (tint & 0xff) / 255;
    this.radii[index] = size;

    const count = Math.min(this.spawned, this.capacity);
    if (count > this.geometry.instanceCount) this.geometry.instanceCount = count;
    if (index < this.dirtyLo) this.dirtyLo = index;
    if (index > this.dirtyHi) this.dirtyHi = index;
  }

  private attribute(array: Float32Array, size: number): THREE.InstancedBufferAttribute {
    const attribute = new THREE.InstancedBufferAttribute(array, size);
    attribute.setUsage(THREE.DynamicDrawUsage);
    this.buffers.push(attribute);
    return attribute;
  }
}
