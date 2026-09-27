/**
 * Building view: construction, production, rally and damage states.
 *
 * ASSETS: 100% procedural, no files of any kind. The shell comes from
 * `buildingGeometry(typeKey)` (shared ref-counted cache) and `materialFor`
 * (shared material library); scaffolding, dust, smoke, the progress bar, the
 * production ring and the rally flag are built here from shared unit
 * primitives plus a runtime radial-gradient `DataTexture` and two inline GLSL
 * shaders. Nothing is fetched.
 *
 * States handled here:
 *  * **under construction** — the shell rises out of the ground as progress
 *    goes 0→1, scaffolding fades out with it, dust puffs cycle at the base and
 *    a billboarded progress bar sits over the site.
 *  * **complete, producing** — the full shell plus a ground ring that fills
 *    clockwise with `prog`.
 *  * **rally set** — a flag at the rally point. NOTE: the sim tracks
 *    `rally_x`/`rally_z` but `to_snapshot_hash` does not put them on the wire,
 *    so the flag is driven by {@link BuildingView.setRallyPoint} from whichever
 *    layer knows the player's rally; it stays hidden otherwise.
 *  * **damaged** — below 50% HP smoke starts, below 25% a scorch decal and
 *    heavier smoke appear. A damaged building always shows its health bar.
 */
import * as THREE from "three";

import type { MapDef, OrderKind, Race } from "@shared/protocol";
import type { QualitySettings } from "@render/core/quality";
import { RACES, entityDef } from "@shared/gameData";
import { materialFor } from "@render/materials/materialLibrary";
import { buildingGeometry } from "@render/geometry/buildingGeometry";
import { heightField } from "@render/terrain/heightfield";
import type { HeightField } from "@render/terrain/heightfield";
import { AbstractEntityView } from "@render/entities/entityView";
import type { EntityViewOptions, SelectionState } from "@render/entities/entityView";

/** Puffs per emitter; cheap enough for a whole base, dense enough to read. */
const DUST_COUNT = 10;
const SMOKE_COUNT = 10;
const RING_RADIUS = 0.86;
const SMOKE_HP_STAGE = 0.5;
const CRITICAL_HP_STAGE = 0.25;

/**
 * Buildings whose merged geometry already ships a permanent mast, radar dish
 * or flare stack. Adding corner scaffolding around those would read as a
 * second, meaningless pole, so construction on them shows the rising shell,
 * dust and the progress bar only.
 */
const NO_SCAFFOLD: Record<string, true> = {
  command_center: true,
  starport: true,
  robotics_facility: true,
  refinery: true,
};

const PUFF_VERT = /* glsl */ `
attribute float aAlpha;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vUv = uv;
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const PUFF_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const RING_VERT = /* glsl */ `
varying vec2 vPos;
void main() {
  vPos = position.xy * 2.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RING_FRAG = /* glsl */ `
uniform float uProgress;
uniform vec3 uColor;
varying vec2 vPos;
void main() {
  float r = length(vPos);
  float aa = 0.012;
  float band = smoothstep(${RING_RADIUS} - aa, ${RING_RADIUS} + aa, r)
             * (1.0 - smoothstep(1.0 - aa, 1.0 + aa, r));
  if (band < 0.01) discard;
  // Start at twelve o'clock and sweep clockwise.
  float t = fract(atan(vPos.x, vPos.y) * 0.15915494);
  if (t > uProgress) discard;
  gl_FragColor = vec4(uColor, 0.92);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ */
/* Shared, process-lifetime assets                                     */
/* ------------------------------------------------------------------ */

let sharedCube: THREE.BoxGeometry | null = null;
let sharedQuad: THREE.PlaneGeometry | null = null;
let sharedPuffTexture: THREE.DataTexture | null = null;
let sharedBarBackMaterial: THREE.MeshBasicMaterial | null = null;
let sharedBarFillMaterial: THREE.MeshBasicMaterial | null = null;
let sharedScorchMaterial: THREE.MeshBasicMaterial | null = null;
let sharedPoleMaterial: THREE.MeshStandardMaterial | null = null;
/** One rally-flag material per race; three for the whole process. */
const flagMaterials: Partial<Record<Race, THREE.MeshBasicMaterial>> = {};

/** Releases the primitives, textures and materials every building view shares. */
export function disposeBuildingViewShared(): void {
  sharedCube?.dispose();
  sharedCube = null;
  sharedQuad?.dispose();
  sharedQuad = null;
  sharedPuffTexture?.dispose();
  sharedPuffTexture = null;
  sharedBarBackMaterial?.dispose();
  sharedBarBackMaterial = null;
  sharedBarFillMaterial?.dispose();
  sharedBarFillMaterial = null;
  sharedScorchMaterial?.dispose();
  sharedScorchMaterial = null;
  sharedPoleMaterial?.dispose();
  sharedPoleMaterial = null;
  for (const race of RACES) {
    flagMaterials[race]?.dispose();
    delete flagMaterials[race];
  }
}

function cube(): THREE.BoxGeometry {
  if (sharedCube === null) sharedCube = new THREE.BoxGeometry(1, 1, 1);
  return sharedCube;
}

function quad(): THREE.PlaneGeometry {
  if (sharedQuad === null) sharedQuad = new THREE.PlaneGeometry(1, 1);
  return sharedQuad;
}

/** Soft round puff, reused for construction dust and damage smoke. */
function puffTexture(): THREE.DataTexture {
  if (sharedPuffTexture === null) {
    const size = 64;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5) / size - 0.5;
        const dy = (y + 0.5) / size - 0.5;
        const d = Math.min(1, Math.hypot(dx, dy) * 2);
        const p = (y * size + x) * 4;
        const a = Math.round((1 - d) * (1 - d) * 255);
        data[p] = 255;
        data[p + 1] = 255;
        data[p + 2] = 255;
        data[p + 3] = a;
      }
    }
    sharedPuffTexture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    sharedPuffTexture.minFilter = THREE.LinearFilter;
    sharedPuffTexture.magFilter = THREE.LinearFilter;
    sharedPuffTexture.needsUpdate = true;
  }
  return sharedPuffTexture;
}

function barBackMaterial(): THREE.MeshBasicMaterial {
  if (sharedBarBackMaterial === null) {
    sharedBarBackMaterial = new THREE.MeshBasicMaterial({
      color: 0x0a0d12, transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false,
    });
  }
  return sharedBarBackMaterial;
}

function barFillMaterial(): THREE.MeshBasicMaterial {
  if (sharedBarFillMaterial === null) {
    sharedBarFillMaterial = new THREE.MeshBasicMaterial({
      color: 0x63e08a, transparent: true, depthWrite: false, toneMapped: false,
    });
  }
  return sharedBarFillMaterial;
}

function scorchMaterial(): THREE.MeshBasicMaterial {
  if (sharedScorchMaterial === null) {
    sharedScorchMaterial = new THREE.MeshBasicMaterial({
      map: puffTexture(),
      color: 0x120c08,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      toneMapped: false,
    });
  }
  return sharedScorchMaterial;
}

function poleMaterial(): THREE.MeshStandardMaterial {
  if (sharedPoleMaterial === null) {
    sharedPoleMaterial = new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: 0.7, metalness: 0.4 });
  }
  return sharedPoleMaterial;
}

function flagMaterial(race: Race): THREE.MeshBasicMaterial {
  // One material per race: three in the whole process.
  if (flagMaterials[race] === undefined) {
    const color = race === "terran" ? 0x4ad66a : race === "zerg" ? 0xd03a30 : 0xf5e05a;
    flagMaterials[race] = new THREE.MeshBasicMaterial({
      color, side: THREE.DoubleSide, transparent: true, opacity: 0.92, toneMapped: false,
    });
  }
  return flagMaterials[race] as THREE.MeshBasicMaterial;
}

/** One instanced puff emitter (construction dust or damage smoke). */
interface PuffField {
  mesh: THREE.InstancedMesh;
  material: THREE.ShaderMaterial;
  alphaData: Float32Array;
  alphaAttribute: THREE.InstancedBufferAttribute;
}

function makePuffField(count: number, color: number): PuffField {
  const geometry = quad();
  const alphaData = new Float32Array(count);
  const alphaAttribute = new THREE.InstancedBufferAttribute(alphaData, 1);
  alphaAttribute.setUsage(THREE.DynamicDrawUsage);
  // A clone so each field owns its own aAlpha stream; the texture is shared.
  const owned = geometry.clone();
  owned.setAttribute("aAlpha", alphaAttribute);
  const material = new THREE.ShaderMaterial({
    vertexShader: PUFF_VERT,
    fragmentShader: PUFF_FRAG,
    uniforms: {
      uMap: { value: puffTexture() },
      uColor: { value: new THREE.Color(color, THREE.SRGBColorSpace) },
    },
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(owned, material, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = count;
  mesh.renderOrder = 12;
  return { mesh, material, alphaData, alphaAttribute };
}

export class BuildingView extends AbstractEntityView {
  private readonly terrain: HeightField;
  private readonly model: THREE.Group;
  private readonly scaffold: THREE.Group;
  /** False for buildings whose geometry already carries a mast or dish. */
  private readonly hasScaffold: boolean;
  private readonly dust: PuffField;
  private readonly smoke: PuffField;
  private readonly barHolder: THREE.Group;
  private readonly barBack: THREE.Mesh;
  private readonly barFill: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private readonly ringGeometry: THREE.PlaneGeometry;
  private readonly ringMaterial: THREE.ShaderMaterial;
  private readonly rally: THREE.Group;
  private readonly flag: THREE.Mesh;
  private readonly scorch: THREE.Mesh;

  private readonly puffDummy = new THREE.Object3D();
  private readonly groupQuat = new THREE.Quaternion();
  private camera: THREE.Camera | null = null;
  private progress = 1;
  private rallyX = 0;
  private rallyZ = 0;
  private rallySet = false;
  private elapsed = 0;
  private cameraQuat = new THREE.Quaternion();

  constructor(options: EntityViewOptions, map: MapDef, settings: QualitySettings) {
    super(options);
    const def = entityDef(options.typeKey);
    this.terrain = heightField(map);

    const model = new THREE.Group();
    model.name = "model";
    const shell = new THREE.Mesh(buildingGeometry(def.key), materialFor(def.key, this.race));
    shell.castShadow = true;
    shell.receiveShadow = true;
    model.add(shell);
    this.model = model;

    // Scaffolding: four corner poles and two rails, scaled to the footprint.
    // Skipped where the merged geometry already ships a permanent mast.
    this.hasScaffold = NO_SCAFFOLD[def.key] !== true;
    const scaffold = new THREE.Group();
    const poleHeight = this.height * 1.05;
    const inset = this.radius * 0.85;
    const poleThickness = Math.max(0.06, this.radius * 0.07);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const pole = new THREE.Mesh(cube(), poleMaterial());
        pole.scale.set(poleThickness, poleHeight, poleThickness);
        pole.position.set(sx * inset, poleHeight * 0.5, sz * inset);
        scaffold.add(pole);
      }
    }
    for (const sz of [-1, 1]) {
      const rail = new THREE.Mesh(cube(), poleMaterial());
      rail.scale.set(inset * 2, poleThickness, poleThickness);
      rail.position.set(0, poleHeight * 0.75, sz * inset);
      scaffold.add(rail);
    }
    this.scaffold = scaffold;

    this.dust = makePuffField(DUST_COUNT, 0xbfae90);
    this.smoke = makePuffField(SMOKE_COUNT, 0x2a2724);

    // Construction progress bar: a billboarded plate + left-aligned fill.
    const barHolder = new THREE.Group();
    const barWidth = Math.max(2, this.radius * 2.2);
    const barHeight = barWidth * 0.12;
    const barBack = new THREE.Mesh(quad(), barBackMaterial());
    barBack.scale.set(barWidth, barHeight, 1);
    const barFill = new THREE.Mesh(quad(), barFillMaterial());
    barFill.scale.set(barWidth, barHeight * 0.72, 1);
    barHolder.add(barBack, barFill);
    barHolder.position.set(0, this.height + 0.6, 0);
    this.barHolder = barHolder;
    this.barBack = barBack;
    this.barFill = barFill;

    const ringGeometry = quad().clone();
    const ringMaterial = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      uniforms: {
        uProgress: { value: 0 },
        uColor: { value: new THREE.Color(0x63e08a, THREE.SRGBColorSpace) },
      },
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.scale.setScalar(Math.max(this.radius * 1.8, 1.4));
    ring.position.y = 0.08;
    ring.visible = false;
    ring.renderOrder = 15;
    this.ring = ring;
    this.ringGeometry = ringGeometry;
    this.ringMaterial = ringMaterial;

    // Rally flag: pole + banner, positioned in the building's local frame.
    const rally = new THREE.Group();
    const pole = new THREE.Mesh(cube(), poleMaterial());
    pole.scale.set(0.07, 1.8, 0.07);
    pole.position.y = 0.9;
    const flag = new THREE.Mesh(quad(), flagMaterial(this.race));
    flag.scale.set(0.7, 0.42, 1);
    flag.position.set(0.36, 1.55, 0);
    rally.add(pole, flag);
    rally.visible = false;
    this.rally = rally;
    this.flag = flag;

    const scorch = new THREE.Mesh(quad(), scorchMaterial());
    scorch.rotation.x = -Math.PI / 2;
    scorch.scale.setScalar(this.radius * 2.4);
    scorch.position.y = 0.05;
    scorch.visible = false;
    scorch.renderOrder = 3;
    this.scorch = scorch;

    this.group.add(model, scaffold, this.dust.mesh, this.smoke.mesh, barHolder, ring, rally, scorch);

    // Cheap presets drop the puff counts: two emitters per building is still
    // readable, and it is a third of the transparent overdraw.
    if (!settings.postFx) {
      this.dust.mesh.count = Math.floor(DUST_COUNT / 2);
      this.smoke.mesh.count = Math.floor(SMOKE_COUNT / 2);
    }
    this.scaffold.visible = false;
    this.barHolder.visible = false;
    this.dust.mesh.visible = false;
    this.smoke.mesh.visible = false;
  }

  /** The camera is stable for the life of the match; set it once. */
  setViewCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  /**
   * Rally marker. The wire protocol carries no rally state, so the caller that
   * issued the order (the UI) drives this; `null` hides the flag.
   */
  setRallyPoint(x: number | null, z = 0): void {
    this.rallySet = x !== null;
    if (x !== null) {
      this.rallyX = x;
      this.rallyZ = z;
    }
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
    if (!visible) this.hudAnchor.visible = false;
  }

  /**
   * `progress` is the snapshot's `prog`: build progress while the shell is
   * going up, training progress once it is complete. The sim only sends `prog`
   * while it is strictly between 0 and 1, so 0 means "finished or not started".
   */
  override setOrder(_order: OrderKind, _targetX: number, _targetZ: number, progress: number): void {
    this.progress = Math.max(0, Math.min(1, progress));
  }

  override update(deltaSeconds: number): void {
    if (this.disposed) return;
    const dt = Math.min(Math.max(deltaSeconds, 0), 0.1);
    this.elapsed += dt;

    // The sim only sends `prog` while it is strictly between 0 and 1, so a
    // missing value means the shell is finished.
    const building = this.state === "building";
    const underConstruction = building || (this.progress > 0 && this.progress < 1);
    const eased = underConstruction ? Math.pow(this.progress, 0.65) : 1;

    this.model.scale.set(1, Math.max(0.02, eased), 1);
    this.model.position.y = -(1 - eased) * this.height;

    this.scaffold.visible = underConstruction && this.hasScaffold;
    if (this.scaffold.visible) {
      const fade = Math.max(0.05, 1 - this.progress);
      this.scaffold.scale.setScalar(0.6 + 0.4 * (1 - fade));
    }

    // Billboarded construction bar.
    this.barHolder.visible = underConstruction;
    if (underConstruction && this.camera !== null) {
      // Billboard against the world camera, undoing the group's own yaw so the
      // bar stays flat to the screen even if the shell is rotated.
      this.camera.getWorldQuaternion(this.cameraQuat);
      this.group.getWorldQuaternion(this.groupQuat);
      this.barHolder.quaternion.copy(this.groupQuat).invert().multiply(this.cameraQuat);
      const width = this.barBack.scale.x;
      const fillWidth = width * eased;
      this.barFill.scale.x = fillWidth;
      this.barFill.position.x = -(width - fillWidth) * 0.5;
    }

    // Production / training ring, only on a finished building.
    const producing = !underConstruction && this.state === "training" && this.progress > 0;
    this.ring.visible = producing;
    if (producing) this.ringMaterial.uniforms.uProgress.value = this.progress;

    // Rally flag, in the building's local frame.
    this.rally.visible = this.rallySet && !underConstruction;
    if (this.rally.visible) {
      const dx = this.rallyX - this.group.position.x;
      const dz = this.rallyZ - this.group.position.z;
      const c = Math.cos(-this.angle);
      const s = Math.sin(-this.angle);
      this.rally.position.set(dx * c - dz * s, this.terrain.sample(this.rallyX, this.rallyZ) - this.group.position.y, dx * s + dz * c);
      this.flag.rotation.y = Math.sin(this.elapsed * 3 + this.id) * 0.35;
    }

    // Damage: smoke below half, scorch plus heavier smoke below a quarter.
    const fraction = this.hpMax > 0 ? this.hp / this.hpMax : 1;
    const smoking = fraction < SMOKE_HP_STAGE && this.hp > 0;
    const critical = fraction < CRITICAL_HP_STAGE && this.hp > 0;
    this.smoke.mesh.visible = smoking;
    this.scorch.visible = critical;
    if (smoking) this.animatePuffs(this.smoke, this.height, critical ? 1.8 : 1, 0.35);
    if (underConstruction) this.animatePuffs(this.dust, this.height * 0.5, 0.9, 0.3);
  }

  /** Cycles one emitter: puffs rise, spread, thin out and wrap. */
  private animatePuffs(field: PuffField, reach: number, rate: number, spread: number): void {
    const count = field.mesh.count;
    const matrices = field.mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const t = (this.elapsed * rate * 0.5 + i / count) % 1;
      const dummy = this.puffDummy;
      const angle = i * 2.399963 + this.id;
      const radius = (0.25 + t * spread) * this.radius;
      dummy.position.set(
        Math.cos(angle) * radius,
        t * reach,
        Math.sin(angle) * radius,
      );
      const scale = this.radius * (0.4 + t * 1.5);
      dummy.scale.setScalar(scale);
      dummy.quaternion.identity();
      dummy.updateMatrix();
      const o = i * 16;
      matrices.set(dummy.matrix.elements, o);
      field.alphaData[i] = Math.sin(t * Math.PI) * 0.75;
    }
    field.mesh.instanceMatrix.needsUpdate = true;
    field.alphaAttribute.needsUpdate = true;
  }

  /** A damaged building always shows its bar; a healthy one only when picked. */
  private refreshHudAnchor(): void {
    this.hudAnchor.visible = this.visible && (this.selected || this.hp < this.hpMax);
  }

  protected override releaseResources(): void {
    this.group.clear();
    // Per-building shader materials and the ring's cloned geometry are owned
    // here; the puff quads are clones of the shared plane and are disposed
    // with their field.
    this.dust.material.dispose();
    this.dust.mesh.geometry.dispose();
    this.dust.mesh.dispose();
    this.smoke.material.dispose();
    this.smoke.mesh.geometry.dispose();
    this.smoke.mesh.dispose();
    this.ringGeometry.dispose();
    this.ringMaterial.dispose();
  }
}
