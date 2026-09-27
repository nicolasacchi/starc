/**
 * SceneManager — the single owner of the `THREE.Scene` and the only module
 * that knows about every other renderer module.
 *
 * It builds the stack in dependency order (renderer → scene → camera →
 * terrain → sky → water → lighting → shadows → environment → vfx → hud3d →
 * minimap), feeds views from network snapshots, and exposes one surface to
 * the game layer.
 *
 * ## Coordinate mapping
 * The wire uses the three.js axes: the ground plane is `x`/`z` and `y` is the
 * server's authoritative height, which is never recomputed from the client
 * height field. Every snapshot entity is read through {@link readWorld}; the
 * height field is only used for ground decals, VFX grounding and picking.
 *
 * ## Interpolation
 * `applySnapshot` keeps the two most recent snapshots. `update()` advances a
 * phase from 0 to 1 across one snapshot interval, and positions every entity
 * by blending the pair at that phase — so the picture is always one snapshot
 * behind the newest data, never a jump. A snapshot that arrives late lets the
 * phase run past 1 into a capped extrapolation instead of stalling.
 *
 * ## Headless
 * With no canvas, or a canvas that cannot give a WebGL context, every GL
 * subsystem is skipped: the manager still constructs, still diffs snapshots,
 * still interpolates and still animates, and `render()` is a no-op. That is
 * what makes the interpolation testable under `environment: "node"`.
 *
 * ASSETS: this module builds no assets of its own; every texture, geometry and
 * material comes from the procedural modules it owns.
 */
import * as THREE from "three";

import type { Command, GameEvent, MapDef, ProtocolEntity, Race } from "@shared/protocol";
import { SNAPSHOT_HZ } from "@shared/protocol";
import { attackOf, hasEntityDef, isBuilding } from "@shared/gameData";
import type { QualityPreset, QualitySettings } from "@render/core/quality";
import { detectQuality, settingsFor } from "@render/core/quality";
import { createRenderer } from "@render/core/renderer";
import { createScene, disposeScene } from "@render/core/scene";
import { PostFXPipeline } from "@render/core/postfx";
import { RtsCamera } from "@render/core/camera";
import { buildTerrain, type Terrain } from "@render/terrain/terrainMesh";
import { SkyDome } from "@render/sky/skyDome";
import { createWaterPlane, type WaterPlane } from "@render/water/waterPlane";
import { LightingRig } from "@render/lighting/lighting";
import { ShadowSystem } from "@render/lighting/shadows";
import { EnvironmentProbe } from "@render/lighting/environment";
import { ParticleSystem } from "@render/vfx/particleSystem";
import { ExplosionSystem } from "@render/vfx/explosions";
import { ProjectileSystem } from "@render/vfx/projectiles";
import { BeamSystem } from "@render/vfx/beams";
import { DecalSystem } from "@render/vfx/decals";
import type { ProjectileKind } from "@render/vfx/projectiles";
import { clearGeometryCache } from "@render/geometry/geometryCache";
import { disposeMaterials } from "@render/materials/materialLibrary";
import { heightField } from "@render/terrain/heightfield";
import type { HeightField } from "@render/terrain/heightfield";
import { HealthBars } from "@render/hud3d/healthBars";
import { SelectionRings } from "@render/hud3d/selectionRings";
import { FloatingText } from "@render/hud3d/floatingText";
import { Minimap } from "@render/hud3d/minimap";
import { UnitView, UnitBatchRenderer, disposeUnitViewShared } from "@render/entities/unitView";
import { BuildingView, disposeBuildingViewShared } from "@render/entities/buildingView";
import type { EntityView, Relation, SelectionState } from "@render/entities/entityView";

/** What the game layer pushes in. `events` is optional; pass them to play. */
export interface SceneSnapshot {
  tick: number;
  entities: readonly ProtocolEntity[];
  events?: readonly GameEvent[];
}

/** Snapshot period, from the shared protocol. */
const SNAPSHOT_INTERVAL = 1 / SNAPSHOT_HZ;
/** How far past the newest snapshot the phase may extrapolate, in intervals. */
const MAX_EXTRAPOLATION = 0.35;
/** Units nearer than this keep their full rig; further ones are batched. */
const LOD_DISTANCE = 62;
const LOD_DISTANCE_SQ = LOD_DISTANCE * LOD_DISTANCE;

/** Wire weapon name → projectile visual. */
const PROJECTILE_BY_WEAPON: Record<string, ProjectileKind> = {
  bullet: "bullet",
  cannon: "cannon",
  shell: "shell",
  missile: "missile",
  plasma: "plasma",
  claw: "claw",
};

/** Hot white tracer for instant-fire weapons. */
const TRACER_COLOR = new THREE.Color().setHex(0xfff0c0, THREE.SRGBColorSpace);

/** Wire `sel` code → relation. The sim sends 0 for the viewer's own units. */
function relationFromSel(sel: ProtocolEntity["sel"]): Relation {
  if (sel === 2) return "ally";
  if (sel === 3) return "enemy";
  return "own";
}

/** A world-space point, filled in place so the frame loop never allocates. */
interface WorldPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Wire axes are now the three.js axes: the ground plane is `x`/`z` and `y` is
 * the server's authoritative height, so the mapping is the identity. This
 * helper stays as the single place to read a `ProtocolEntity`'s position, so
 * a future protocol change has exactly one edit to make.
 */
function readWorld(entity: ProtocolEntity, out: WorldPoint): void {
  out.x = entity.x;
  out.y = entity.y;
  out.z = entity.z;
}

function wrapAngle(a: number): number {
  let v = a;
  while (v > Math.PI) v -= TAU;
  while (v < -Math.PI) v += TAU;
  return v;
}

const TAU = Math.PI * 2;

/** Explosion size class, chosen from the entity's own footprint. */
function explosionRadius(view: EntityView | null): number {
  if (view === null) return 2.5;
  return Math.max(1.5, view.radius * 2.2);
}

export class SceneManager {
  /** The RTS camera rig; drive pan/zoom/rotate/focus on this. */
  readonly camera: RtsCamera;
  /** Minimap surface for the UI panel. */
  readonly minimap: Minimap;

  /** The player this client controls. Set it before the first snapshot. */
  myPlayerId: number;
  /** Where `issueMove` sends its command. The game layer owns the socket. */
  onCommand: ((command: Command) => void) | null = null;

  private readonly canvas: HTMLCanvasElement | null;
  private readonly map: MapDef;
  private readonly terrain: HeightField;
  private settings: QualitySettings;
  private preset: QualityPreset;
  private readonly glReady: boolean;

  private scene: THREE.Scene;
  private perspective: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer | null = null;
  private postfx: PostFXPipeline | null = null;
  private terrainHandle: Terrain | null = null;
  private sky: SkyDome | null = null;
  private water: WaterPlane | null = null;
  private lighting: LightingRig | null = null;
  private shadows: ShadowSystem | null = null;
  private environment: EnvironmentProbe | null = null;
  private particles: ParticleSystem | null = null;
  private explosions: ExplosionSystem | null = null;
  private projectiles: ProjectileSystem | null = null;
  private beams: BeamSystem | null = null;
  private decals: DecalSystem | null = null;
  private healthBars: HealthBars | null = null;
  private rings: SelectionRings | null = null;
  private text: FloatingText | null = null;
  private batch: UnitBatchRenderer | null = null;

  /** The view registry: entity id → view. */
  private readonly views = new Map<number, EntityView>();
  /** Reused every frame; never reallocated. */
  private activeViews: EntityView[] = [];
  private older = new Map<number, ProtocolEntity>();
  private newer = new Map<number, ProtocolEntity>();
  private readonly selection = new Set<number>();
  private selectionRelation: Relation = "own";
  private phase = 0;
  private elapsed = 0;
  private disposed = false;

  private readonly scratchVector = new THREE.Vector3();
  private readonly groundOut = { x: 0, z: 0 };
  private readonly eventFrom = new THREE.Vector3();
  private readonly eventTo = new THREE.Vector3();
  private readonly worldTo: WorldPoint = { x: 0, y: 0, z: 0 };
  private readonly worldFrom: WorldPoint = { x: 0, y: 0, z: 0 };
  private lastFrameSeconds = 1 / 60;
  private canvasWidth = 0;
  private canvasHeight = 0;

  constructor(
    canvas: HTMLCanvasElement | null,
    map: MapDef,
    settings: QualitySettings,
    myPlayerId = 0,
    preset: QualityPreset = detectQuality(),
  ) {
    this.canvas = canvas;
    this.map = map;
    this.settings = settings;
    this.preset = preset;
    this.myPlayerId = myPlayerId;
    this.terrain = heightField(map);
    this.glReady = SceneManager.webglAvailable(canvas);

    // 60° vertical: `RtsCamera.PITCH` is 24°, so the top of the frame sits 6°
    // above the horizontal — a ~10% sky band. A narrower FOV would either
    // bury the horizon again or force the pitch so steep the ground stops
    // reading as ground. The far plane clears the 800 m sky dome.
    this.perspective = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 1400);
    this.perspective.position.set(map.size / 2, 60, map.size / 2 + 60);
    this.camera = new RtsCamera(this.perspective, canvas, map);
    this.camera.focus(map.size / 2, map.size / 2, 0);

    this.scene = createScene(map, settings);
    this.minimap = new Minimap(map, settings);
    this.buildGraphics();
  }

  /**
   * True when a throwaway probe canvas can get a WebGL2 context. A detached
   * probe is used so the real canvas keeps the attributes `createRenderer`
   * asks for, and the context is handed straight back.
   */
  private static webglAvailable(canvas: HTMLCanvasElement | null): boolean {
    if (canvas === null || typeof canvas.getContext !== "function") return false;
    const doc = canvas.ownerDocument;
    if (doc === null || typeof doc.createElement !== "function") return false;
    try {
      const probe = doc.createElement("canvas");
      probe.width = 1;
      probe.height = 1;
      const ctx = probe.getContext("webgl2") as WebGL2RenderingContext | null;
      if (ctx === null) return false;
      ctx.getExtension("WEBGL_lose_context")?.loseContext();
      return true;
    } catch {
      return false;
    }
  }

  /** Builds every GL subsystem in dependency order. */
  private buildGraphics(): void {
    const settings = this.settings;
    if (this.glReady && this.canvas !== null) {
      this.renderer = createRenderer(this.canvas, this.preset);
      this.resizeRenderer();
    }

    this.terrainHandle = buildTerrain(this.scene, this.map, settings);
    this.sky = new SkyDome(this.scene, this.map, settings);
    this.water = createWaterPlane(this.scene, this.map, settings);
    this.lighting = new LightingRig(this.scene, this.map, settings);
    this.shadows = new ShadowSystem(this.scene, settings);
    this.environment = this.renderer === null
      ? null
      : new EnvironmentProbe(this.scene, this.renderer, settings);
    this.particles = new ParticleSystem(this.scene, settings);
    this.explosions = new ExplosionSystem(this.scene, settings, this.terrain);
    this.projectiles = new ProjectileSystem(this.scene, settings, this.terrain);
    this.beams = new BeamSystem(this.scene, settings);
    this.decals = new DecalSystem(this.scene, this.map, settings, this.terrain);

    this.healthBars = new HealthBars(settings);
    this.rings = new SelectionRings(this.map, settings);
    this.text = new FloatingText(settings);
    this.batch = new UnitBatchRenderer(settings);
    this.scene.add(
      this.healthBars.group,
      this.rings.group,
      this.text.group,
      this.batch.group,
    );

    if (this.renderer !== null) {
      this.postfx = new PostFXPipeline(this.renderer, this.scene, this.perspective, settings);
    }

    // Re-parent any view that survived a quality change into the new roots.
    for (const view of this.views.values()) {
      this.scene.add(view.group);
      if (view instanceof BuildingView) view.setViewCamera(this.perspective);
    }
    this.rebuildActiveList();
  }

  /** Tears down the GL subsystems; the view registry is left intact. */
  private releaseGraphics(): void {
    this.postfx?.dispose();
    this.postfx = null;
    this.batch?.dispose();
    this.batch = null;
    this.healthBars?.dispose();
    this.healthBars = null;
    this.rings?.dispose();
    this.rings = null;
    this.text?.dispose();
    this.text = null;
    this.decals?.dispose();
    this.decals = null;
    this.beams?.dispose();
    this.beams = null;
    this.projectiles?.dispose();
    this.projectiles = null;
    this.explosions?.dispose();
    this.explosions = null;
    this.particles?.dispose();
    this.particles = null;
    this.environment?.dispose();
    this.environment = null;
    this.shadows?.dispose();
    this.shadows = null;
    this.lighting?.dispose();
    this.lighting = null;
    this.water?.dispose();
    this.water = null;
    this.sky?.dispose();
    this.sky = null;
    this.terrainHandle?.dispose();
    this.terrainHandle = null;
    this.renderer?.dispose();
    this.renderer = null;
  }

  private resizeRenderer(): void {
    if (this.renderer === null || this.canvas === null) return;
    const width = Math.max(1, this.canvas.clientWidth || this.canvas.width || 1);
    const height = Math.max(1, this.canvas.clientHeight || this.canvas.height || 1);
    if (width === this.canvasWidth && height === this.canvasHeight) return;
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.perspective.aspect = width / height;
    this.perspective.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.postfx?.setSize(width, height);
  }

  /* ---------------------------------------------------------------- */
  /* Game layer surface                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Feeds one network snapshot. Interpolation is internal: hand over the raw
   * 10 Hz `ProtocolEntity[]` exactly as it arrived.
   */
  applySnapshot(snapshot: SceneSnapshot): void {
    if (this.disposed) return;
    if (snapshot.events !== undefined) this.playEvents(snapshot.events);

    // Events run before the diff so a `death` still finds its view.
    this.older = this.newer;
    this.newer = new Map<number, ProtocolEntity>();
    this.phase = 0;
    const live = this.newer;
    for (const entity of snapshot.entities) live.set(entity.id, entity);

    // Create what is new.
    for (const entity of snapshot.entities) {
      if (!hasEntityDef(entity.ty)) continue;
      let view = this.views.get(entity.id);
      if (view === undefined) {
        view = this.createView(entity);
        this.views.set(entity.id, view);
        this.scene.add(view.group);
      }
      this.pushState(view, entity);
    }

    // Destroy what is gone. The sim drops dead entities from the world, so
    // absence from the snapshot is authoritative.
    for (const id of this.views.keys()) {
      if (live.has(id)) continue;
      const view = this.views.get(id);
      if (view === undefined) continue;
      view.dispose();
      this.views.delete(id);
      this.selection.delete(id);
    }

    this.rebuildActiveList();
  }

  /** Emits a move order for the given entities. */
  issueMove(entityIds: readonly number[], x: number, z: number): void {
    if (this.disposed || entityIds.length === 0) return;
    const ids = [...entityIds];
    const command: Command = { c: "move", ids, x, z };
    this.onCommand?.(command);
  }

  /** Translates one round of match events into recoil, VFX and floating text. */
  playEvents(events: readonly GameEvent[]): void {
    if (this.disposed) return;
    for (const event of events) {
      switch (event.e) {
        case "shot": {
          // The event carries both ends of the shot, so an instant weapon
          // draws its tracer here; the muzzle kick rides on the shooter's rig.
          this.views.get(event.id)?.onShot?.();
          this.eventFrom.set(event.x, event.y, event.z);
          this.eventTo.set(event.tx, event.ty, event.tz);
          this.beams?.beam(this.eventFrom, this.eventTo, 0.05, TRACER_COLOR, 0.08);
          break;
        }
        case "hit": {
          const target = this.views.get(event.tid);
          this.healthBars?.notifyDamage(event.tid);
          if (target === undefined) break;
          this.scratchVector.copy(target.group.position);
          this.scratchVector.y += target.height * 0.7;
          this.text?.spawnDamage(event.dmg, this.scratchVector.x, this.scratchVector.y, this.scratchVector.z, event.crit);
          const attacker = this.views.get(event.id);
          this.particles?.burst("spark", this.scratchVector, event.crit ? 10 : 4);
          if (attacker !== undefined && attacker.race === "zerg") {
            this.decals?.splatter(this.scratchVector, target.radius * 0.8, "zerg");
          }
          break;
        }
        case "death": {
          const view = this.views.get(event.id) ?? null;
          this.scratchVector.set(event.x, event.y, event.z);
          this.scratchVector.y = Math.max(this.scratchVector.y, this.terrain.sample(event.x, event.z));
          const radius = explosionRadius(view);
          this.explosions?.explode(this.scratchVector, radius, view !== null && view.radius > 1.4 ? "medium" : "small");
          this.particles?.burst("debris", this.scratchVector, 12);
          if (view !== null && view.kind === "building") this.decals?.scorch(this.scratchVector, radius);
          break;
        }
        case "built": {
          this.scratchVector.set(event.x, event.y, event.z);
          this.particles?.burst("dust", this.scratchVector, 16);
          this.text?.spawnCallout("READY", this.scratchVector.x, this.scratchVector.y + 2, this.scratchVector.z, "info");
          break;
        }
        case "proj": {
          const shooter = this.views.get(event.id);
          const attack = shooter === undefined ? null : attackOf(shooter.typeKey);
          const race: Race = shooter?.race ?? "terran";
          this.eventFrom.set(event.x, event.y, event.z);
          this.eventTo.set(event.tx, event.ty, event.tz);
          this.projectiles?.fire(
            PROJECTILE_BY_WEAPON[attack?.weapon ?? "bullet"] ?? "bullet",
            this.eventFrom,
            this.eventTo,
            attack?.projectile_speed ?? 40,
            race,
          );
          break;
        }
        case "ability": {
          this.scratchVector.set(event.x, event.y, event.z);
          this.particles?.burst("plasma", this.scratchVector, 14);
          break;
        }
        case "res": {
          this.scratchVector.set(event.x, this.terrain.sample(event.x, event.z) + 1, event.z);
          this.text?.spawnCallout(`+${event.amount}`, this.scratchVector.x, this.scratchVector.y, this.scratchVector.z, "info");
          break;
        }
        case "alert": {
          this.alertAnchor(this.scratchVector);
          this.text?.spawnCallout(event.text, this.scratchVector.x, this.scratchVector.y, this.scratchVector.z, "warn");
          break;
        }
      }
    }
  }

  /** Global alerts have no position: show them in front of the camera. */
  private alertAnchor(out: THREE.Vector3): void {
    if (this.canvas !== null && this.canvas.clientWidth > 0) {
      const rect = this.canvas.getBoundingClientRect();
      if (this.screenToGround(rect.left + rect.width / 2, rect.top + rect.height * 0.35, this.groundOut)) {
        out.set(this.groundOut.x, this.terrain.sample(this.groundOut.x, this.groundOut.z) + 3, this.groundOut.z);
        return;
      }
    }
    out.set(this.map.size / 2, 4, this.map.size / 2);
  }

  /** Sets the player's selection. `relation` colours the whole set. */
  setSelection(ids: readonly number[], relation: Relation): void {
    if (this.disposed) return;
    this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.selectionRelation = relation;
    for (const view of this.views.values()) this.applySelection(view);
  }

  /** Advances interpolation, animation, camera, world systems and the HUD. */
  update(deltaSeconds: number): void {
    if (this.disposed) return;
    const dt = Math.min(Math.max(deltaSeconds, 0), 0.25);
    this.elapsed += dt;
    this.lastFrameSeconds = dt;
    this.phase = Math.min(1 + MAX_EXTRAPOLATION, this.phase + dt / SNAPSHOT_INTERVAL);

    this.camera.update(dt);
    this.placeViews();

    this.batch?.begin(this.perspective);
    for (const view of this.activeViews) {
      view.update(dt);
      if (!(view instanceof UnitView)) continue;
      const dx = view.group.position.x - this.perspective.position.x;
      const dy = view.group.position.y - this.perspective.position.y;
      const dz = view.group.position.z - this.perspective.position.z;
      view.setLod(dx * dx + dy * dy + dz * dz, LOD_DISTANCE_SQ);
      if (view.isBatched && this.batch !== null && !this.batch.add(view)) view.forceRig();
    }
    this.batch?.end();

    this.sky?.update(this.elapsed);
    this.water?.update(this.elapsed, this.perspective.position);
    this.lighting?.update(this.elapsed);
    this.shadows?.update(this.perspective, this.terrain);
    this.environment?.update();
    this.particles?.update(dt);
    this.explosions?.update(dt);
    this.projectiles?.update(dt);
    this.beams?.update(dt);
    this.decals?.update(dt);
    this.terrainHandle?.update(this.perspective.position.x, this.perspective.position.z);

    this.healthBars?.update(this.perspective, this.activeViews, dt);
    this.rings?.update(this.activeViews, dt);
    this.text?.update(this.perspective, dt);
    this.minimap.update(this.activeViews, this.selection, this.perspective, dt);
  }

  /** Draws one frame. No-op without a WebGL context. */
  render(): void {
    if (this.disposed || this.renderer === null) return;
    this.resizeRenderer();
    if (this.postfx !== null) {
      this.postfx.render(this.lastFrameSeconds);
      return;
    }
    this.renderer.render(this.scene, this.perspective);
  }

  /** Rebuilds the GL stack for a new preset; views and the minimap survive. */
  setQuality(preset: QualityPreset): void {
    if (this.disposed || preset === this.preset) return;
    this.releaseGraphics();
    this.preset = preset;
    this.settings = settingsFor(preset);
    this.buildGraphics();
  }

  /** World-space ground point under a screen position, for picking. */
  screenToGround(clientX: number, clientY: number, out: { x: number; z: number }): boolean {
    return this.camera.screenToGround(clientX, clientY, out);
  }

  /** True when a ground point is inside the camera frustum. */
  isVisible(x: number, z: number): boolean {
    this.scratchVector.set(x, this.terrain.sample(x, z), z);
    this.scratchVector.project(this.perspective);
    if (this.scratchVector.z < -1 || this.scratchVector.z > 1) return false;
    return Math.abs(this.scratchVector.x) <= 1 && Math.abs(this.scratchVector.y) <= 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseGraphics();
    for (const view of this.views.values()) view.dispose();
    this.views.clear();
    this.activeViews = [];
    this.older.clear();
    this.newer.clear();
    this.selection.clear();
    this.minimap.dispose();
    this.camera.dispose();
    disposeScene(this.scene);
    disposeUnitViewShared();
    disposeBuildingViewShared();
    clearGeometryCache();
    disposeMaterials();
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  private createView(entity: ProtocolEntity): EntityView {
    const options = { id: entity.id, typeKey: entity.ty, playerId: entity.pl };
    if (isBuilding(entity.ty)) {
      const view = new BuildingView(options, this.map, this.settings);
      view.setViewCamera(this.perspective);
      return view;
    }
    return new UnitView(options, this.map);
  }

  /** Pushes the non-positional part of a snapshot entity into its view. */
  private pushState(view: EntityView, entity: ProtocolEntity): void {
    view.setHp(entity.hp, entity.hp_max, entity.mp, entity.mp_max);
    view.setEntityState(entity.st);
    view.setVisible(entity.st !== "dead" && entity.hp > 0);
    view.setOrder?.(entity.ord ?? 0, entity.ox ?? entity.x, entity.oz ?? entity.z, entity.prog ?? 0);
    this.applySelection(view);
  }

  private applySelection(view: EntityView): void {
    const sample = this.newer.get(view.id);
    const selected = this.selection.has(view.id);
    const state: SelectionState = {
      selected,
      primary: selected && this.selection.size === 1,
      relation: selected ? this.selectionRelation : relationFromSel(sample?.sel),
    };
    view.setSelectionState(state);
  }

  /** Blends the snapshot pair into world transforms for every live view. */
  private placeViews(): void {
    const phase = this.phase;
    const extrapolate = phase > 1 ? (phase - 1) * SNAPSHOT_INTERVAL : 0;
    for (const view of this.activeViews) {
      const current = this.newer.get(view.id);
      if (current === undefined) continue;
      const previous = this.older.get(view.id);
      readWorld(current, this.worldTo);
      if (previous === undefined) {
        view.setTransform(this.worldTo.x, this.worldTo.y, this.worldTo.z, current.ang);
        continue;
      }
      readWorld(previous, this.worldFrom);
      const to = this.worldTo;
      const from = this.worldFrom;
      const blend = phase <= 1 ? phase : 1;
      // Velocity from the pair, used only while extrapolating a late snapshot.
      const vx = (to.x - from.x) * extrapolate;
      const vy = (to.y - from.y) * extrapolate;
      const vz = (to.z - from.z) * extrapolate;
      const angle = previous.ang + wrapAngle(current.ang - previous.ang) * blend;
      view.setTransform(
        from.x + (to.x - from.x) * blend + vx,
        from.y + (to.y - from.y) * blend + vy,
        from.z + (to.z - from.z) * blend + vz,
        angle,
      );
    }
  }

  /** Rebuilds the reused per-frame view list; runs on snapshot changes only. */
  private rebuildActiveList(): void {
    const list: EntityView[] = [];
    for (const view of this.views.values()) {
      if (view.visible) list.push(view);
    }
    this.activeViews = list;
  }
}
