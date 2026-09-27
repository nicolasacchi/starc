/**
 * Unit view: a fully procedural animation rig driven by entity state.
 *
 * ASSETS: 100% procedural, no files of any kind. The model is
 * `unitGeometry(typeKey)` — one merged, ref-counted `BufferGeometry` per unit
 * type that already contains the legs, torso, head, weapon and wings at the
 * roster's own `size.radius` / `size.height` — skinned by `materialFor(
 * typeKey, race)` from the shared material library. The only geometry this
 * module builds is the soft ground-shadow quad under air units, from a shared
 * unit plane and a runtime radial-gradient `DataTexture`. Nothing is fetched,
 * so the module works with an empty network.
 *
 * ## Where the animation lives
 * The merged geometry is the silhouette, so nothing is attached to it. Every
 * state is animated on the chassis that carries it:
 *
 *  * **idle** — a slow breathing rise/fall plus a hair of roll.
 *  * **moving** — a stride bounce at twice the step rate, a sway roll and a
 *    lean into the direction of travel. The walk phase is advanced by the
 *    distance the unit actually covered, not by time, so a unit that speeds
 *    up, gets knocked back or is teleported by interpolation keeps its feet in
 *    sync with the ground. Ground units also seat themselves on
 *    `heightField.sample` and tilt to the slope.
 *  * **attacking** — a recoil kick backwards along the facing, proportional to
 *    the unit's weapon damage, returned by a spring.
 *  * **air** — a hover cycle, a bank into turns, and a blob shadow that tracks
 *    the ground while the hull keeps its authoritative altitude.
 *
 * ## Which path a unit takes
 * `SceneManager` picks per frame, and the choice is explicit:
 *
 *  * **Rig path** — an individual `THREE.Group` per unit (this class) whenever
 *    the unit is selected, hurt, moving, attacking, or inside the LOD radius.
 *    It is the only path that can walk, lean, recoil, hover or bank.
 *  * **Batch path** — {@link UnitBatchRenderer} packs every remaining unit
 *    into one `InstancedMesh` per typeKey, i.e. per (typeKey, idle) bucket,
 *    because only undamaged idle unselected units are eligible. One draw call
 *    per unit type, and every instance is frustum culled on the CPU.
 *
 * That split is what makes 300+ units viable: a battle line is mostly idle
 * standing units, so it collapses to a handful of draw calls, while the units
 * the player is actually watching keep their animation.
 *
 * ## No per-frame allocation
 * `update()` only writes numbers into existing objects. The shadow quad is
 * built once in the constructor; the shared plane and shadow texture live for
 * the process and are released by `disposeUnitViewShared()`.
 */
import * as THREE from "three";

import type { MapDef } from "@shared/protocol";
import { attackOf, entityDef } from "@shared/gameData";
import type { QualitySettings } from "@render/core/quality";
import { materialFor } from "@render/materials/materialLibrary";
import { unitGeometry } from "@render/geometry/unitGeometry";
import { heightField } from "@render/terrain/heightfield";
import type { HeightField } from "@render/terrain/heightfield";
import { AbstractEntityView } from "@render/entities/entityView";
import type { EntityViewOptions, SelectionState } from "@render/entities/entityView";

const TAU = Math.PI * 2;
/** Below this speed (m/s) a unit counts as standing still. */
const MOVE_EPSILON = 0.25;
/** Ground metres travelled per full stride cycle, per metre of radius. */
const STRIDE_PER_RADIUS = 2.6;
/** Weapon-recoil spring, in s^-1. */
const RECOIL_STIFFNESS = 150;
const RECOIL_DAMPING = 17;

interface Rig {
  chassis: THREE.Group;
  body: THREE.Mesh;
  shadow: THREE.Mesh | null;
  shadowHolder: THREE.Group;
}

/* ------------------------------------------------------------------ */
/* Shared, process-lifetime assets                                     */
/* ------------------------------------------------------------------ */

let sharedShadowPlane: THREE.PlaneGeometry | null = null;
let sharedShadowMaterial: THREE.MeshBasicMaterial | null = null;
let sharedShadowTexture: THREE.DataTexture | null = null;

/** Releases the shadow assets shared by every air unit's rig. */
export function disposeUnitViewShared(): void {
  sharedShadowPlane?.dispose();
  sharedShadowPlane = null;
  sharedShadowMaterial?.dispose();
  sharedShadowMaterial = null;
  sharedShadowTexture?.dispose();
  sharedShadowTexture = null;
}

/** Soft radial blob used as the ground shadow under air units. */
function shadowAssets(): { geometry: THREE.PlaneGeometry; material: THREE.MeshBasicMaterial } {
  if (sharedShadowPlane === null) {
    sharedShadowPlane = new THREE.PlaneGeometry(1, 1);
  }
  if (sharedShadowMaterial === null) {
    if (sharedShadowTexture === null) {
      const size = 64;
      const data = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx = (x + 0.5) / size - 0.5;
          const dy = (y + 0.5) / size - 0.5;
          const d = Math.min(1, Math.hypot(dx, dy) * 2);
          const p = (y * size + x) * 4;
          data[p] = 0;
          data[p + 1] = 0;
          data[p + 2] = 0;
          data[p + 3] = Math.round((1 - d) * (1 - d) * 255);
        }
      }
      sharedShadowTexture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
      sharedShadowTexture.minFilter = THREE.LinearFilter;
      sharedShadowTexture.magFilter = THREE.LinearFilter;
      sharedShadowTexture.needsUpdate = true;
    }
    sharedShadowMaterial = new THREE.MeshBasicMaterial({
      map: sharedShadowTexture,
      color: 0x000000,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      toneMapped: false,
    });
  }
  return { geometry: sharedShadowPlane, material: sharedShadowMaterial };
}

function wrapAngle(a: number): number {
  let v = a;
  while (v > Math.PI) v -= TAU;
  while (v < -Math.PI) v += TAU;
  return v;
}

export class UnitView extends AbstractEntityView {
  /** The rig, exposed for the batch renderer and for tests. */
  readonly rig: Rig;

  private readonly terrain: HeightField;
  private readonly legStride: number;
  private readonly bobPhase: number;
  private readonly recoilKick: number;

  private lastX = 0;
  private lastZ = 0;
  private lastYaw = 0;
  private walkPhase = 0;
  private elapsed = 0;
  private recoil = 0;
  private recoilVelocity = 0;
  private bank = 0;
  private batched = false;

  constructor(options: EntityViewOptions, map: MapDef) {
    super(options);
    const def = entityDef(options.typeKey);
    this.terrain = heightField(map);
    this.legStride = Math.max(0.5, this.radius * STRIDE_PER_RADIUS);
    // A stable per-entity phase stops a whole army bobbing in lockstep.
    this.bobPhase = (options.id % 97) * 0.37;
    const attack = attackOf(def.key);
    this.recoilKick = attack === null ? 0.5 : 0.5 + Math.min(4, attack.damage * 0.12);

    const chassis = new THREE.Group();
    chassis.name = "chassis";
    const body = new THREE.Mesh(unitGeometry(def.key), materialFor(def.key, this.race));
    body.castShadow = true;
    body.receiveShadow = true;
    chassis.add(body);

    const shadowHolder = new THREE.Group();
    let shadow: THREE.Mesh | null = null;
    if (this.isAir) {
      const assets = shadowAssets();
      shadow = new THREE.Mesh(assets.geometry, assets.material);
      shadow.rotation.x = -Math.PI / 2;
      shadow.scale.setScalar(this.radius * 5);
      shadow.renderOrder = 2;
      shadowHolder.add(shadow);
    }

    this.group.add(chassis, shadowHolder);
    this.rig = { chassis, body, shadow, shadowHolder };
  }

  /** True while the view is drawn through the shared instanced batch. */
  get isBatched(): boolean {
    return this.batched;
  }

  /**
   * Chooses between the rig and the instanced batch. Only undamaged, idle,
   * unselected units beyond the LOD radius are cheap enough to batch.
   */
  setLod(cameraDistanceSq: number, lodDistanceSq: number): void {
    this.applyBatch(
      cameraDistanceSq > lodDistanceSq &&
        !this.selected &&
        this.hp >= this.hpMax &&
        this.state === "idle" &&
        this.visible,
    );
  }

  /** Pulls a view back onto its rig, e.g. when its batch bucket is full. */
  forceRig(): void {
    this.applyBatch(false);
  }

  private applyBatch(batched: boolean): void {
    if (batched === this.batched) return;
    this.batched = batched;
    this.rig.chassis.visible = !batched;
    this.rig.shadowHolder.visible = !batched && this.isAir;
  }

  /** Called by `SceneManager` for every `shot` event fired by this unit. */
  onShot(): void {
    this.recoilVelocity -= this.recoilKick;
  }

  override setHp(hp: number, max: number, shield: number, maxShield: number): void {
    super.setHp(hp, max, shield, maxShield);
    this.refreshHudAnchor();
  }

  override setSelectionState(state: SelectionState): void {
    super.setSelectionState(state);
    this.refreshHudAnchor();
  }

  override setVisible(visible: boolean): void {
    super.setVisible(visible);
    if (!visible) {
      this.batched = false;
      this.hudAnchor.visible = false;
    }
  }

  /** Per-frame procedural animation. Allocation free. */
  override update(deltaSeconds: number): void {
    if (this.disposed) return;
    const dt = Math.min(Math.max(deltaSeconds, 0), 0.1);
    this.elapsed += dt;

    const px = this.group.position.x;
    const py = this.group.position.y;
    const pz = this.group.position.z;
    const dx = px - this.lastX;
    const dz = pz - this.lastZ;
    const travelled = Math.hypot(dx, dz);
    this.lastX = px;
    this.lastZ = pz;
    const speed = dt > 0 ? travelled / dt : 0;
    const moving = speed > MOVE_EPSILON;
    const speedFactor = Math.min(1, speed / 6);

    // Walk phase is driven by distance, not time, so a unit that speeds up or
    // is knocked back keeps its gait in sync with the ground.
    if (travelled > 0) this.walkPhase = (this.walkPhase + (travelled / this.legStride) * TAU) % TAU;
    const step = this.walkPhase * 2;

    const yawDelta = wrapAngle(this.angle - this.lastYaw);
    this.lastYaw = this.angle;
    const turnRate = dt > 0 ? yawDelta / dt : 0;
    // Smoothed roll: air units bank into a turn, ground units lean out of one
    // instead of tipping over.
    this.bank += (Math.max(-1, Math.min(1, turnRate * 0.22)) - this.bank) * Math.min(1, dt * 6);

    // Ground under the unit. The snapshot's Y stays authoritative for the
    // root; this only seats the rig on the terrain and tilts it to the slope.
    const groundY = this.terrain.sample(px, pz);
    const seat = Math.max(-0.6, Math.min(0.6, groundY - py)) * 0.6;
    const slopeX = this.terrain.sample(px - 0.5, pz) - this.terrain.sample(px + 0.5, pz);
    const slopeZ = this.terrain.sample(px, pz - 0.5) - this.terrain.sample(px, pz + 0.5);
    const conform = this.isAir ? 0 : 0.45;

    const chassis = this.rig.chassis;
    let bob: number;
    let sway: number;
    if (this.isAir) {
      // Hover: a slow vertical cycle plus a lateral drift, never settling.
      bob = 0.18 + Math.sin(this.elapsed * 2.1 + this.bobPhase) * 0.14;
      sway = Math.sin(this.elapsed * 1.3 + this.bobPhase * 1.7) * 0.04;
    } else if (moving) {
      // Two bounces per stride, the way a biped's mass actually moves.
      bob = (0.5 - 0.5 * Math.cos(step)) * this.height * 0.07 * speedFactor;
      sway = Math.sin(step) * 0.09 * speedFactor;
    } else {
      bob = Math.sin(this.elapsed * 1.5 + this.bobPhase) * this.height * 0.012;
      sway = 0;
    }
    chassis.position.y = (this.isAir ? 0 : seat) + bob;
    chassis.position.x = sway;

    const pitch = this.isAir
      ? speedFactor * 0.24
      : (moving ? speedFactor : 0) * 0.2 + Math.max(-0.4, Math.min(0.4, slopeZ * conform));
    const roll = this.isAir
      ? this.bank * 0.9
      : this.bank * 0.35 + sway * 0.6 + Math.max(-0.4, Math.min(0.4, -slopeX * conform));
    chassis.rotation.x += (pitch - chassis.rotation.x) * Math.min(1, dt * 10);
    chassis.rotation.z += (roll - chassis.rotation.z) * Math.min(1, dt * 10);

    // Weapon recoil: an impulse into a spring, kicked backwards along the
    // facing so the whole model reads as recoiling.
    if (this.recoil !== 0 || this.recoilVelocity !== 0) {
      this.recoilVelocity += (-RECOIL_STIFFNESS * this.recoil - RECOIL_DAMPING * this.recoilVelocity) * dt;
      this.recoil += this.recoilVelocity * dt;
      if (Math.abs(this.recoil) < 0.0005 && Math.abs(this.recoilVelocity) < 0.005) {
        this.recoil = 0;
        this.recoilVelocity = 0;
      }
    }
    chassis.position.z = -this.recoil * this.radius * 0.5;

    if (this.isAir && this.rig.shadow !== null) {
      // The blob stays on the ground while the hull keeps its authoritative
      // altitude; it spreads as the unit climbs.
      const altitude = Math.max(0.5, py - groundY);
      this.rig.shadow.position.set(0, groundY - py + 0.08, 0);
      this.rig.shadow.scale.setScalar(this.radius * 5 * (1 + altitude * 0.05));
    }
  }

  /** The shared HUD anchor is hidden when the unit is healthy and unselected. */
  private refreshHudAnchor(): void {
    this.hudAnchor.visible = this.visible && (this.selected || this.hp < this.hpMax);
  }

  protected override releaseResources(): void {
    // The model geometry belongs to the shared ref-counted cache and the
    // material to the shared library; the shadow plane and texture are the
    // process-lifetime set released by disposeUnitViewShared(). Teardown is
    // therefore just unlinking the children.
    this.group.clear();
  }
}

interface UnitBucket {
  mesh: THREE.InstancedMesh;
  count: number;
}

/**
 * The batch path: one `InstancedMesh` per typeKey for units that do not need
 * per-unit animation. Buckets are created on demand and kept for the session,
 * so a battle that mixes five types costs five draw calls.
 */
export class UnitBatchRenderer {
  /** Root added to the scene. */
  readonly group = new THREE.Group();

  private readonly buckets = new Map<string, UnitBucket>();
  private readonly frustum = new THREE.Frustum();
  private readonly projection = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly capacity: number;
  private readonly castShadows: boolean;
  private disposed = false;

  constructor(settings: QualitySettings, capacityPerType = 256) {
    this.capacity = Math.max(32, capacityPerType);
    // The cheap presets skip shadow casting for batched units: they are far
    // away, and their shadows would cost a second pass over every bucket.
    this.castShadows = settings.shadowMapSize > 0 && !settings.motionBlur;
    this.group.name = "unit-batch";
    this.group.frustumCulled = false;
  }

  /** Starts a new frame; call before any {@link add}. */
  begin(camera: THREE.Camera): void {
    if (this.disposed) return;
    this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projection);
    for (const bucket of this.buckets.values()) bucket.count = 0;
  }

  /**
   * Submits one batched unit. Returns false when the bucket is full, so the
   * caller can put the unit back on its rig rather than dropping it.
   */
  add(view: UnitView): boolean {
    if (this.disposed) return false;
    const bucket = this.bucketFor(view);
    if (bucket === null || bucket.count >= this.capacity) return false;

    const p = view.group.position;
    // CPU frustum cull: a sphere test per instance is far cheaper than
    // drawing an off-screen unit, and it keeps the batch cheap at 300+.
    this.sphere.center.copy(p);
    this.sphere.radius = view.radius * 1.6 + view.height * 0.5;
    if (!this.frustum.intersectsSphere(this.sphere)) return true;

    const m = bucket.mesh.instanceMatrix.array as Float32Array;
    const o = bucket.count * 16;
    // Yaw-only rotation written straight into the matrix, no Matrix4 needed.
    // Local +Z is forward, matching the rig's facing convention.
    const yaw = view.group.rotation.y;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    m[o] = c;
    m[o + 1] = 0;
    m[o + 2] = -s;
    m[o + 3] = 0;
    m[o + 4] = 0;
    m[o + 5] = 1;
    m[o + 6] = 0;
    m[o + 7] = 0;
    m[o + 8] = s;
    m[o + 9] = 0;
    m[o + 10] = c;
    m[o + 11] = 0;
    m[o + 12] = p.x;
    m[o + 13] = p.y;
    m[o + 14] = p.z;
    m[o + 15] = 1;
    bucket.count++;
    return true;
  }

  /** Uploads the instance lists. Call once after the last {@link add}. */
  end(): void {
    if (this.disposed) return;
    for (const bucket of this.buckets.values()) {
      bucket.mesh.count = bucket.count;
      bucket.mesh.visible = bucket.count > 0;
      if (bucket.count > 0) bucket.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private bucketFor(view: UnitView): UnitBucket | null {
    const key = view.typeKey;
    const existing = this.buckets.get(key);
    if (existing !== undefined) return existing;
    const mesh = new THREE.InstancedMesh(unitGeometry(key), materialFor(key, view.race), this.capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = this.castShadows;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.name = `batch:${key}`;
    const bucket: UnitBucket = { mesh, count: 0 };
    this.buckets.set(key, bucket);
    this.group.add(mesh);
    return bucket;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const bucket of this.buckets.values()) {
      this.group.remove(bucket.mesh);
      // The geometry belongs to the shared ref-counted cache and the material
      // to the shared library; an InstancedMesh only owns its buffers.
      bucket.mesh.dispose();
    }
    this.buckets.clear();
    this.group.removeFromParent();
  }
}
