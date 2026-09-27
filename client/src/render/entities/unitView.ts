/**
 * Unit view: a fully procedural rig animated from entity state.
 *
 * ASSETS: 100% procedural, no files of any kind. The hull comes from
 * `unitGeometry(typeKey)` (the shared ref-counted geometry cache), the skin
 * from `materialFor(typeKey, race)` (the shared material library), and every
 * limb, weapon and the air shadow is built here from one shared unit cube, one
 * shared unit plane and a runtime-generated radial-gradient `DataTexture`.
 * Nothing is fetched, so the module works with an empty network.
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
import type { MapDef, Race } from "@shared/protocol";
import type { QualitySettings } from "@render/core/quality";
 * `update()` only writes numbers into existing objects. Limbs, weapons and
 * shadows are built once in the constructor; the shared cube, plane and shadow
 * texture live for the process and are released by
 * `disposeUnitViewShared()`.
 */
import * as THREE from "three";

import type { MapDef, Race } from "@shared/protocol";
import { attackOf, entityDef } from "@shared/gameData";
import { materialFor } from "@render/materials/materialLibrary";
import { unitGeometry } from "@render/geometry/unitGeometry";
import { heightField } from "@render/terrain/heightfield";
import type { HeightField } from "@render/terrain/heightfield";
import { AbstractEntityView } from "@render/entities/entityView";
import type { EntityViewOptions, SelectionState } from "@render/entities/entityView";

const TAU = Math.PI * 2;
/** Below this speed (m/s) a unit counts as standing still. */
const MOVE_EPSILON = 0.25;
/** Ground metres travelled per full leg cycle, per metre of radius. */
const STRIDE_PER_RADIUS = 2.6;
const WALK_SWING = 0.72;
/** Weapon-recoil spring, in s^-1. */
const RECOIL_STIFFNESS = 160;
const RECOIL_DAMPING = 18;

interface Limb {
  pivot: THREE.Object3D;
  /** Phase offset in the walk cycle so legs alternate instead of marching. */
  offset: number;
  restY: number;
}

interface Rig {
  chassis: THREE.Group;
  body: THREE.Mesh;
  limbs: Limb[];
  weapon: THREE.Group | null;
  wing: THREE.Object3D | null;
  shadow: THREE.Mesh | null;
  shadowHolder: THREE.Group;

/* ------------------------------------------------------------------ */
/* Shared, process-lifetime assets                                     */
/* ------------------------------------------------------------------ */

let sharedCube: THREE.BoxGeometry | null = null;
let sharedShadowPlane: THREE.PlaneGeometry | null = null;
let sharedShadowMaterial: THREE.MeshBasicMaterial | null = null;
let sharedShadowTexture: THREE.DataTexture | null = null;

/** Releases the cube and shadow assets shared by every unit view. */
export function disposeUnitViewShared(): void {
  sharedCube?.dispose();
  sharedCube = null;
  sharedShadowPlane?.dispose();
  sharedShadowPlane = null;
  sharedShadowMaterial?.dispose();
  sharedShadowMaterial = null;
  sharedShadowTexture?.dispose();
  sharedShadowTexture = null;
}

function cube(): THREE.BoxGeometry {
  if (sharedCube === null) {
    // Unit cube: every limb and weapon scales it, so one geometry serves all.
    sharedCube = new THREE.BoxGeometry(1, 1, 1);
  }
  return sharedCube;
}

/** Soft radial blob used as the fake ground shadow under air units. */
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

/** Limb count is a shape rule derived from the roster's collision radius. */
function limbCount(radius: number): number {
  return radius >= 0.65 ? 4 : 2;
}

function wrapAngle(a: number): number {
  let v = a;
  while (v > Math.PI) v -= TAU;
  while (v < -Math.PI) v += TAU;
  return v;
}

export class UnitView extends AbstractEntityView {
  /** The procedural rig, exposed for the batch renderer and for tests. */
  readonly rig: Rig;

  private readonly terrain: HeightField;
  private readonly legStride: number;
  private readonly bobPhase: number;
  private readonly recoilKick: number;

  private lastX = 0;
  private lastY = 0;
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
    const race: Race = this.race;
    const material = materialFor(def.key, race);
    this.terrain = heightField(map);
    this.legStride = Math.max(0.5, this.radius * STRIDE_PER_RADIUS);
    // A stable per-entity phase stops a whole army bobbing in lockstep.
    this.bobPhase = (options.id % 97) * 0.37;
    const attack = attackOf(def.key);
    this.recoilKick = attack === null ? 0.5 : 0.5 + Math.min(4, attack.damage * 0.12);

    const chassis = new THREE.Group();
    chassis.name = "chassis";

    const body = new THREE.Mesh(unitGeometry(def.key), material);
    body.castShadow = true;
    body.receiveShadow = true;
    chassis.add(body);

    const limbs: Limb[] = [];
    if (!this.isAir) {
      const count = limbCount(this.radius);
      const legHeight = this.height * 0.42;
      const legThickness = Math.max(0.08, this.radius * 0.22);
      for (let i = 0; i < count; i++) {
        const pivot = new THREE.Object3D();
        const side = i % 2 === 0 ? -1 : 1;
        const row = i < 2 ? -1 : 1;
        const restY = this.height * 0.5 - legHeight;
        pivot.position.set(side * this.radius * 0.72, restY, row * this.radius * 0.55);
        const leg = new THREE.Mesh(cube(), material);
        leg.scale.set(legThickness, legHeight, legThickness);
        leg.position.y = -legHeight * 0.5;
        leg.castShadow = true;
        pivot.add(leg);
        chassis.add(pivot);
        limbs.push({ pivot, offset: (i % 2) * Math.PI, restY });
      }
    }

    let weapon: THREE.Group | null = null;
    if (attack !== null && attack.weapon !== "none") {
      const heavy = attack.weapon === "cannon" || attack.weapon === "shell";
      weapon = new THREE.Group();
      const barrelLength = this.height * (heavy ? 0.55 : 0.34);
      const thickness = this.radius * (heavy ? 0.22 : 0.13);
      const barrel = new THREE.Mesh(cube(), material);
      barrel.scale.set(thickness, thickness, barrelLength);
      barrel.castShadow = true;
      weapon.add(barrel);
      if (attack.weapon === "missile") {
        const pod = new THREE.Mesh(cube(), material);
        pod.scale.set(thickness * 2.4, thickness * 1.6, thickness * 1.6);
        pod.position.set(this.radius * 0.45, this.height * 0.78, barrelLength * 0.35);
        weapon.add(pod);
      }
      if (attack.weapon === "claw") {
        for (const side of [-1, 1]) {
          const claw = new THREE.Mesh(cube(), material);
          claw.scale.set(thickness, thickness * 1.4, thickness * 2.6);
          claw.position.set(this.radius * 0.5 + side * this.radius * 0.3, this.height * 0.5, barrelLength * 0.4);
          claw.rotation.y = side * 0.3;
          weapon.add(claw);
        }
      }
      chassis.add(weapon);
    }

    let wing: THREE.Object3D | null = null;
    if (this.isAir) {
      wing = new THREE.Group();
      const span = Math.max(this.radius * 2.2, 1.2);
      for (const side of [-1, 1]) {
        const panel = new THREE.Mesh(cube(), material);
        panel.scale.set(span, this.height * 0.06, this.radius * 1.4);
        panel.position.set((side * span) / 2, this.height * 0.62, 0);
        panel.castShadow = true;
        wing.add(panel);
      }
      chassis.add(wing);
    }

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
    this.rig = { chassis, body, limbs, weapon, wing, shadow, shadowHolder };
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
    const wantsBatch =
      cameraDistanceSq > lodDistanceSq &&
      !this.selected &&
      this.hp >= this.hpMax &&
      this.state === "idle" &&
      this.visible;
    this.applyBatch(wantsBatch);
  }

  /** Pulls a view back onto its rig, e.g. when its batch bucket is full. */
  forceRig(): void {
    this.applyBatch(false);
  }

  private applyBatch(batched: boolean): void {
    if (batched === this.batched) return;
    this.batched = batched;
    this.rig.chassis.visible = !batched;
    this.shadowHolder.visible = !batched && this.isAir;
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
    this.lastY = py;
    this.lastZ = pz;
    const speed = dt > 0 ? travelled / dt : 0;
    const moving = speed > MOVE_EPSILON;
    const speedFactor = Math.min(1, speed / 6);

    // Walk phase is driven by distance, not time, so a unit that speeds up or
    // is knocked back keeps its feet in sync with the ground.
    if (travelled > 0) this.walkPhase = (this.walkPhase + (travelled / this.legStride) * TAU) % TAU;

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
    if (this.isAir) {
      // Hover: a slow vertical cycle, never settling to the deck.
      bob = 0.18 + Math.sin(this.elapsed * 2.1 + this.bobPhase) * 0.14;
    } else if (moving) {
      bob = Math.abs(Math.sin(this.walkPhase)) * this.height * 0.035 * speedFactor;
    } else {
      bob = Math.sin(this.elapsed * 1.5 + this.bobPhase) * this.height * 0.012;
    }
    chassis.position.y = (this.isAir ? 0 : seat) + bob;

    const pitch = this.isAir
      ? speedFactor * 0.24
      : moving * speedFactor * 0.2 + Math.max(-0.4, Math.min(0.4, slopeZ * conform));
    const roll = this.isAir
      ? this.bank * 0.9
      : this.bank * 0.35 + Math.max(-0.4, Math.min(0.4, -slopeX * conform));
    chassis.rotation.x += (pitch - chassis.rotation.x) * Math.min(1, dt * 10);
    chassis.rotation.z += (roll - chassis.rotation.z) * Math.min(1, dt * 10);

    // Legs swing about their pivots and reach for the ground on a slope.
    const swing = moving ? WALK_SWING * speedFactor : 0;
    for (let i = 0; i < this.rig.limbs.length; i++) {
      const limb = this.rig.limbs[i];
      if (limb === undefined) continue;
      const phase = this.walkPhase + limb.offset;
      const target = Math.sin(phase) * swing;
      const pivot = limb.pivot;
      pivot.rotation.x += (target - pivot.rotation.x) * Math.min(1, dt * 16);
      const lift = moving ? Math.max(0, Math.cos(phase)) * this.height * 0.05 * speedFactor : 0;
      const rest = limb.restY + lift;
      pivot.position.y += (rest - pivot.position.y) * Math.min(1, dt * 12);
    }

    // Weapon recoil: an impulse into a spring, so the kick reads as force.
    if (this.recoil !== 0 || this.recoilVelocity !== 0) {
      this.recoilVelocity += (-RECOIL_STIFFNESS * this.recoil - RECOIL_DAMPING * this.recoilVelocity) * dt;
      this.recoil += this.recoilVelocity * dt;
      if (Math.abs(this.recoil) < 0.0005 && Math.abs(this.recoilVelocity) < 0.005) {
        this.recoil = 0;
        this.recoilVelocity = 0;
      }
      if (this.rig.weapon !== null) this.rig.weapon.position.z = this.recoil * this.radius * 0.4;
    }

    if (this.isAir) {
      if (this.rig.wing !== null) {
        this.rig.wing.rotation.z = this.bank * 0.6;
        this.rig.wing.rotation.x = -this.bank * 0.25;
      }
      if (this.rig.shadow !== null) {
        // The blob stays on the ground while the hull keeps its authoritative
        // altitude; it spreads and fades as the unit climbs.
        const altitude = Math.max(0.5, py - groundY);
        this.rig.shadow.position.set(0, groundY - py + 0.08, 0);
        this.rig.shadow.scale.setScalar(this.radius * 5 * (1 + altitude * 0.05));
      }
    }
  }

  /** The shared HUD anchor is hidden when the unit is healthy and idle. */
  private refreshHudAnchor(): void {
    this.hudAnchor.visible = this.visible && (this.selected || this.hp < this.hpMax);
  }

  protected override releaseResources(): void {
    // Every geometry and material here is shared — the ref-counted cache, the
    // material library, or the process-lifetime set released by
    // disposeUnitViewShared() — so teardown is just unlinking the children.
    this.group.clear();
  private readonly capacity: number;
  private readonly castShadows: boolean;
  private disposed = false;

  constructor(settings: QualitySettings, capacityPerType = 256) {
    this.capacity = Math.max(32, capacityPerType);
    // The cheap presets skip shadow casting for batched units: they are far
    // away, and their shadows cost a whole extra pass over every bucket.
    this.castShadows = settings.shadowMapSize > 0 && !settings.motionBlur;
    this.group.name = "unit-batch";
    this.group.frustumCulled = false;
  }
  mesh: THREE.InstancedMesh;
  count: number;
  race: Race;
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
  private disposed = false;

  constructor(settings: QualitySettings, capacityPerType = 256) {
    this.capacity = Math.max(32, capacityPerType);
    this.group.name = "unit-batch";
    this.group.frustumCulled = false;
    void settings;
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
   * caller can put the unit back on its rig instead of dropping it.
   */
  add(view: UnitView): boolean {
    if (this.disposed) return false;
    const bucket = this.bucketFor(view);
    if (bucket === null || bucket.count >= this.capacity) return false;

    const p = view.group.position;
    // CPU frustum cull: a sphere test per instance is far cheaper than
    // drawing an off-screen unit, and it keeps the batch cheap at 300+.
    this.sphere.center.copy(p);
    mesh.castShadow = this.castShadows;
    if (!this.frustum.intersectsSphere(this.sphere)) return true;

    const m = bucket.mesh.instanceMatrix.array as Float32Array;
    const o = bucket.count * 16;
    // Yaw-only rotation written straight into the matrix, no Matrix4 needed.
    const c = Math.cos(view.angle);
    const s = Math.sin(view.angle);
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
    const mesh = new THREE.InstancedMesh(
      unitGeometry(key),
      materialFor(key, view.race),
      this.capacity,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.name = `batch:${key}`;
    this.buckets.set(key, { mesh, count: 0, race: view.race });
    this.group.add(mesh);
    return this.buckets.get(key) ?? null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const bucket of this.buckets.values()) {
      this.group.remove(bucket.mesh);
      // The geometry comes from the shared ref-counted cache and the material
      // from the shared library; neither is owned by an instance mesh.
      bucket.mesh.dispose();
    }
    this.buckets.clear();
    this.group.removeFromParent();
  }
}
