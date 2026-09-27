/**
 * Entity view contract — the bridge between a network `ProtocolEntity` and
 * something you can see.
 *
 * The renderer keeps a `Map<number, EntityView>`; the game layer feeds it
 * snapshots and the diffing (create / update / destroy) lives in
 * `SceneManager`. This module owns the shared bookkeeping every concrete view
 * repeats: identity, transform, vitals, selection and lifetime.
 *
 * ASSETS: none here — this file builds no geometry, material or texture.
 */
import * as THREE from "three";

import type { EntityDef, EntityState, OrderKind, Race } from "@shared/protocol";
import { GAME, entityDef, isAirUnit } from "@shared/gameData";

/**
 * typeKey -> owning race. Built once from the roster: the protocol's
 * `EntityDef` carries no race field, and nothing here may hard-code one.
 */
const RACE_OF: Record<string, Race> = {};
for (const race of GAME.races) {
  for (const unit of race.units) RACE_OF[unit.key] = race.race;
  for (const building of race.buildings) RACE_OF[building.key] = race.race;
}

/** How the local player relates to an entity. */
export type Relation = "own" | "ally" | "enemy";

export interface SelectionState {
  selected: boolean;
  primary: boolean;
  relation: Relation;
}

export interface EntityViewOptions {
  id: number;
  typeKey: string;
  playerId: number;
  /** Optional injection for tests; production always passes the real def. */
  def?: EntityDef;
}

/**
 * What the game layer pushes into a view. One call per snapshot per entity;
 * views never allocate in response to it.
 */
export interface EntityView {
  readonly id: number;
  readonly typeKey: string;
  readonly playerId: number;
  readonly race: Race;
  readonly kind: "unit" | "building";
  /** Collision radius, metres — straight from the roster, never hard-coded. */
  readonly radius: number;
  /** Model height, metres — straight from the roster. */
  readonly height: number;
  readonly isAir: boolean;
  readonly group: THREE.Group;
  /** Local-space anchor the shared HUD layers hang bars and rings from. */
  readonly hudAnchor: THREE.Object3D;

  /** Interpolated world transform. `angle` is a Y rotation in radians. */
  setTransform(x: number, y: number, z: number, angle: number): void;
  setHp(hp: number, max: number, shield: number, maxShield: number): void;
  setSelectionState(state: SelectionState): void;
  setVisible(visible: boolean): void;

  /** Simulation state, drives the procedural animation in the concrete view. */
  setEntityState(state: EntityState): void;
  /** Order + progress. Only buildings consume it; see {@link setOrder}. */
  setOrder?(order: OrderKind, targetX: number, targetZ: number, progress: number): void;
  /** Per-frame animation. Called once per view per frame by `SceneManager`. */
  update(deltaSeconds: number): void;
  /** Fired when this entity shoots, so the rig can recoil. */
  onShot?(): void;

  /** Current vitals, read by the HUD layers. */
  readonly hp: number;
  readonly hpMax: number;
  readonly shield: number;
  readonly shieldMax: number;
  readonly visible: boolean;
  readonly selected: boolean;
  readonly primary: boolean;
  readonly relation: Relation;
  readonly state: EntityState;

  dispose(): void;
}

/**
 * Shared implementation. Concrete views call `super(options)`, then build
 * their procedural rig as children of {@link group}.
 */
export abstract class AbstractEntityView implements EntityView {
  readonly id: number;
  readonly typeKey: string;
  readonly playerId: number;
  readonly race: Race;
  readonly kind: "unit" | "building";
  readonly radius: number;
  readonly height: number;
  readonly isAir: boolean;
  readonly group = new THREE.Group();
  readonly hudAnchor: THREE.Object3D;

  protected hp = 0;
  protected hpMax = 0;
  protected shield = 0;
  protected shieldMax = 0;
  protected visible = true;
  protected selected = false;
  protected primary = false;
  protected relation: Relation = "enemy";
  protected state: EntityState = "idle";
  protected disposed = false;

  /** Last transform written by {@link setTransform}. */
  protected readonly position = new THREE.Vector3();
  protected angle = 0;

  /** Rigs override this to release their own geometry/material clones. */
  protected abstract releaseResources(): void;

  constructor(options: EntityViewOptions) {
    const def = options.def ?? entityDef(options.typeKey);
    this.id = options.id;
    this.typeKey = def.key;
    this.playerId = options.playerId;
    this.race = RACE_OF[options.typeKey] ?? "terran";
    this.kind = def.kind;
    this.radius = def.size.radius;
    this.height = def.size.height;
    this.isAir = def.kind === "unit" ? isAirUnit(def.key) : false;

    this.group.name = `${def.kind}:${def.key}#${options.id}`;
    this.group.position.set(0, 0, 0);
    this.hudAnchor = new THREE.Object3D();
    // Anchor floats just above the model so the bar never intersects it.
    this.hudAnchor.position.set(0, this.height + Math.max(0.6, this.height * 0.22), 0);
    this.hudAnchor.visible = false;
    this.group.add(this.hudAnchor);
  }

  setTransform(x: number, y: number, z: number, angle: number): void {
    if (this.disposed) return;
    this.position.set(x, y, z);
    this.angle = angle;
    this.group.position.set(x, y, z);
    this.group.rotation.y = angle;
  }

  setHp(hp: number, max: number, shield: number, maxShield: number): void {
    this.hp = hp;
    this.hpMax = max;
    this.shield = shield;
    this.shieldMax = maxShield;
  }

  setSelectionState(state: SelectionState): void {
    this.selected = state.selected;
    this.primary = state.primary && state.selected;
    this.relation = state.relation;
    this.hudAnchor.visible = state.selected;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.group.visible = visible;
    if (!visible) this.hudAnchor.visible = false;
  }

  setEntityState(state: EntityState): void {
    this.state = state;
  }

  update(_deltaSeconds: number): void {
    // Concrete views drive their rigs; the base class has nothing to animate.
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseResources();
    this.group.removeFromParent();
    this.group.clear();
  }
}
