/**
 * Pointer + keyboard for the game viewport. This is the layer that turns a
 * player's hand into protocol commands; it owns no state the server owns.
 *
 * Conventions:
 *  - Ground space is `{x, z}` (render space). A protocol entity's `y` is that
 *    `z`, and its `z` is the height — `groundPoint` does the translation.
 *  - The selection box is stored as one fixed world corner plus the cursor's
 *    live client position, and re-projected on every read. Panning the camera
 *    mid-drag therefore moves the box with the world instead of smearing it.
 *  - Nothing here reaches for `window`, `document` or a timer at construction
 *    time; `attach()` is the only phase that touches the host, and it takes an
 *    injectable element so a plain object can stand in for a canvas.
 */
import {
  attackOf,
  entityDef,
  GAME,
  hasEntityDef,
  isAirUnit,
  isBuilding,
  RACES,
} from "@shared/gameData";
import type { Command, MapMineralCluster, ProtocolEntity, Race } from "@shared/protocol";
import { CONTROL_GROUP_COUNT, ControlGroups } from "./controlGroups";
import { CAMERA_ACTIONS, HotkeyManager } from "./hotkeys";
import type { HotkeyAction, HotkeyContext } from "./hotkeys";
import { OrderQueue, orderCommand } from "./orderQueue";
import type { QueuedOrder } from "./orderQueue";
import { DRAG_SELECT_RADIUS, SelectionManager, groundPoint } from "./selection";
import type { WorldPoint, WorldRect } from "./selection";

export type InputMode = "normal" | "placing" | "dragging_camera" | "box_select";

/** The slice of a DOM element the controller needs; a plain object qualifies. */
export interface InputElement {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: unknown,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: unknown,
  ): void;
  getBoundingClientRect?(): { left: number; top: number; width: number; height: number };
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
  ownerDocument?: { defaultView?: InputElement | null } | null;
}

export interface InputScene {
  /** Projects a client point onto the ground; false when it misses the world. */
  screenToGround(clientX: number, clientY: number, out: { x: number; z: number }): boolean;
  /** Frustum test, for "on screen" selection. Omit to mean "everything". */
  isVisible?(x: number, z: number): boolean;
}

export interface InputTerrain {
  readonly size: number;
  passable?(x: number, z: number): boolean;
  sample?(x: number, z: number): number;
}

export type CameraIntent =
  /** Ground metres to pan this frame; the caller feeds them to the camera. */
  | { kind: "pan"; dx: number; dz: number }
  /** Signed zoom delta, positive zooms in. */
  | { kind: "zoom"; steps: number }
  | { kind: "rotate"; radians: number }
  | { kind: "focus"; x: number; z: number; height: number };

export interface PlacementGhost {
  unitType: string;
  x: number;
  z: number;
  height: number;
  radius: number;
  valid: boolean;
  /** Why it is invalid, or null: bounds, terrain, blocked, resources, worker. */
  reason: string | null;
}

export interface InputControllerOptions {
  element: InputElement;
  scene: InputScene;
  terrain: InputTerrain;
  getEntities: () => ProtocolEntity[];
  myPlayerId: number;
  send: (commands: Command[]) => void;
  onSelectionChange?: (ids: number[], overflow: number) => void;
  onCameraIntent?: (intent: CameraIntent) => void;
  onPlacementChange?: (ghost: PlacementGhost | null) => void;
  /** True while a text box owns the keyboard; every key is swallowed. */
  chatOpen?: () => boolean;
  /** Mineral clusters from the map, for the right-click harvest gesture. */
  mineralFields?: readonly MapMineralCluster[];
  /** Clock for click and group timing; defaults to `Date.now`. */
  now?: () => number;
  /** Frame scheduler; must behave like `requestAnimationFrame` (async). */
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

/** Movement of the cursor in client pixels before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 5;
/** Distance from the viewport edge at which the camera starts scrolling. */
const EDGE_SCROLL_PX = 24;
const EDGE_SCROLL_METRES_PER_SEC = 45;
const CAMERA_SPEED_METRES_PER_SEC = 45;
/** One tap of a pan key covers this much time, so a tap moves visibly. */
const CAMERA_TAP_SECONDS = 1 / 12;
const ZOOM_STEP = 0.12;
const ZOOM_REPEAT_SECONDS = 0.18;
const ROTATE_STEP = 0.4;
const ROTATE_PER_PIXEL = 0.005;
/** Two entities closer than this belong to the same selection sector. */
const SUBGROUP_RADIUS = 5;
/** Right-clicking within this of a mineral cluster orders a harvest. */
const MINERAL_FIELD_RADIUS = 3;
/** Buildings snap to this grid, in world metres. */
const PLACEMENT_GRID = 0.5;

interface DragState {
  button: number;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  /** World point under the press, captured once. */
  world: WorldPoint | null;
  target: ProtocolEntity | null;
  shift: boolean;
  ctrl: boolean;
  moved: boolean;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

export class InputController {
  readonly selection = new SelectionManager();
  readonly groups = new ControlGroups(CONTROL_GROUP_COUNT);
  readonly orders = new OrderQueue();
  readonly hotkeys: HotkeyManager;

  private readonly opts: InputControllerOptions;
  private readonly element: InputElement;
  private playerId: number;
  private modeState: InputMode = "normal";
  private attached = false;
  private disposed = false;
  private pointerTarget: InputElement | null = null;
  private keyboardTarget: InputElement | null = null;
  private drag: DragState | null = null;
  private lastClient: { x: number; y: number } | null = null;
  private pointerGround: WorldPoint | null = null;
  private pendingPlacement: string | null = null;
  private ghost: PlacementGhost | null = null;
  private heldCamera = new Set<HotkeyAction>();
  private lastPatrol: WorldPoint | null = null;
  private previousOrder: WorldPoint | null = null;
  private subgroupIndex = 0;
  private zoomAccumulator = 0;
  private lastStepAt: number | null = null;
  private scheduled = false;
  private frameHandle = 0;
  private race: Race | null = null;

  constructor(opts: InputControllerOptions) {
    this.opts = opts;
    this.element = opts.element;
    this.playerId = opts.myPlayerId;
    this.hotkeys = new HotkeyManager((action, ctx) => this.onHotkey(action, ctx), {
      now: opts.now,
      ignore: (event) => opts.chatOpen?.() === true,
    });
  }

  get mode(): InputMode {
    return this.modeState;
  }

  /** The ground point under the cursor, or null when it is off the map. */
  get pointer(): WorldPoint | null {
    return this.pointerGround;
  }

  /**
   * The live selection rectangle in world space, or null when no drag is in
   * progress. Re-projects the cursor corner on every read, so a camera that
   * moves while the button is held does not stretch the box.
   */
  get box(): WorldRect | null {
    const corners = this.boxCorners();
    if (!corners) return null;
    return {
      x0: corners.a.x,
      z0: corners.a.z,
      x1: corners.b.x,
      z1: corners.b.z,
    };
  }

  /** The pending placement ghost, or null when not placing. */
  get placement(): PlacementGhost | null {
    return this.ghost;
  }

  /** The app learns the player id from `game:start`, not from the constructor. */
  setMyPlayerId(id: number): void {
    this.playerId = id;
  }

  /** Roster letters follow the player's race; the app sets it on match start. */
  setRace(race: Race | null): void {
    this.race = race;
    this.hotkeys.setRace(race);
  }

  setMode(mode: InputMode): void {
    if (mode === this.modeState) return;
    this.modeState = mode;
    if (mode !== "box_select") this.drag = null;
  }

  /**
   * Starts building a ghost that follows the cursor. The train hotkeys are
   * suppressed while it is up — a letter confirms the placement instead.
   */
  beginPlacement(unitType: string): void {
    if (!hasEntityDef(unitType) || !isBuilding(unitType)) return;
    this.pendingPlacement = unitType;
    this.modeState = "placing";
    this.drag = null;
    this.hotkeys.setPlacementMode(true);
    this.updateGhost(this.pointerGround ?? this.lastGroundPoint());
  }

  cancelPlacement(): void {
    this.pendingPlacement = null;
    this.ghost = null;
    this.hotkeys.setPlacementMode(false);
    if (this.modeState === "placing") this.modeState = "normal";
    this.opts.onPlacementChange?.(null);
  }

  /** Binds DOM listeners. The keyboard target defaults to the view's window. */
  attach(target?: InputElement): void {
    if (this.disposed || this.attached) return;
    this.attached = true;
    this.pointerTarget = target ?? this.element;
    this.keyboardTarget = this.resolveKeyboardTarget(target);
    const surface = this.pointerTarget;
    surface.addEventListener("pointerdown", this.onPointerDown);
    surface.addEventListener("pointermove", this.onPointerMove);
    surface.addEventListener("pointerup", this.onPointerUp);
    surface.addEventListener("pointercancel", this.onPointerUp);
    surface.addEventListener("wheel", this.onWheel, { passive: false });
    surface.addEventListener("contextmenu", this.onContextMenu);
    const keys = this.keyboardTarget;
    if (keys && keys !== surface) {
      keys.addEventListener("keydown", this.onKeyDown);
      keys.addEventListener("keyup", this.onKeyUp);
    } else {
      surface.addEventListener("keydown", this.onKeyDown);
      surface.addEventListener("keyup", this.onKeyUp);
    }
    this.startLoop();
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    const surface = this.pointerTarget;
    if (surface) {
      surface.removeEventListener("pointerdown", this.onPointerDown);
      surface.removeEventListener("pointermove", this.onPointerMove);
      surface.removeEventListener("pointerup", this.onPointerUp);
      surface.removeEventListener("pointercancel", this.onPointerUp);
      surface.removeEventListener("wheel", this.onWheel);
      surface.removeEventListener("contextmenu", this.onContextMenu);
    }
    if (this.keyboardTarget && this.keyboardTarget !== surface) {
      this.keyboardTarget.removeEventListener("keydown", this.onKeyDown);
      this.keyboardTarget.removeEventListener("keyup", this.onKeyUp);
    }
    this.pointerTarget = null;
    this.keyboardTarget = null;
    this.stopLoop();
    this.drag = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    this.cancelPlacement();
    this.hotkeys.dispose();
    this.orders.clearAll();
    this.heldCamera.clear();
    this.selection.clear();
  }

  /**
   * Advances the held-key camera and the edge scroller. The internal frame loop
   * calls this; a host with its own loop can call it directly instead.
   */
  step(dtSeconds: number): void {
    if (this.disposed || dtSeconds <= 0) return;
    let sx = 0;
    let sy = 0;
    if (this.heldCamera.has("camera_left")) sx -= 1;
    if (this.heldCamera.has("camera_right")) sx += 1;
    if (this.heldCamera.has("camera_up")) sy += 1;
    if (this.heldCamera.has("camera_down")) sy -= 1;
    const distance = CAMERA_SPEED_METRES_PER_SEC * dtSeconds;
    if (sx !== 0 || sy !== 0) this.panOnScreen(sx * distance, sy * distance);

    const edge = this.edgeScrollVector();
    if (edge) {
      const step = EDGE_SCROLL_METRES_PER_SEC * dtSeconds;
      this.panOnScreen(edge.x * step, edge.y * step);
    }

    this.zoomAccumulator += dtSeconds;
    if (this.zoomAccumulator >= ZOOM_REPEAT_SECONDS) {
      const repeat = this.zoomAccumulator;
      this.zoomAccumulator = 0;
      if (this.heldCamera.has("zoom_in")) this.intent({ kind: "zoom", steps: ZOOM_STEP * repeat });
      else if (this.heldCamera.has("zoom_out")) {
        this.intent({ kind: "zoom", steps: -ZOOM_STEP * repeat });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Hotkeys                                                             */
  /* ------------------------------------------------------------------ */

  private onHotkey(action: HotkeyAction, ctx: HotkeyContext): boolean {
    if (action.startsWith("build:")) return this.onBuildHotkey(action.slice(6), ctx.count);

    if (CAMERA_ACTIONS.has(action)) {
      if (ctx.phase === "up") {
        this.heldCamera.delete(action);
        return true;
      }
      if (!this.heldCamera.has(action)) {
        this.heldCamera.add(action);
        this.cameraStep(action);
      }
      return true;
    }

    switch (action) {
      case "select_army":
        return this.selectArmy();
      case "stop":
        return this.sendOrder(this.orderUnits(), { c: "stop" });
      case "hold":
        return this.sendOrder(this.orderUnits(), { c: "hold" });
      case "patrol":
        return this.issuePatrol();
      case "assign_group":
        if (ctx.group === null) return false;
        this.groups.assign(ctx.group, this.selection.selectedIds());
        return true;
      case "add_to_group":
        if (ctx.group === null) return false;
        this.groups.addToGroup(ctx.group, this.selection.selectedIds());
        return true;
      case "recall_group":
        return this.recallGroup(ctx.group);
      case "centre_group":
        return this.centreGroup(ctx.group);
      case "cancel":
        if (this.pendingPlacement) {
          this.cancelPlacement();
          return true;
        }
        if (this.selection.size === 0) return false;
        this.clearSelection();
        return true;
      case "cycle_subgroup":
        return this.cycleSubgroup();
      case "placement_key":
        return this.confirmPlacement();
      default:
        return false;
    }
  }

  /**
   * Buildings open a placement ghost (as in StarCraft); units train from a
   * selected producer, and a race's own worker — which nothing produces — falls
   * back to selecting every worker of that type. Returning false lets the same
   * key fall through to its next binding, e.g. camera pan.
   */
  private onBuildHotkey(entityKey: string, count: number): boolean {
    this.ensureRace();
    if (!hasEntityDef(entityKey)) return false;
    const def = entityDef(entityKey);
    if (def.kind === "building") {
      this.beginPlacement(entityKey);
      return true;
    }
    const producer = this.orderBuildings().find((b) => entityDef(b.ty).produces.includes(entityKey));
    if (producer) {
      this.push([{ c: "train", building_id: producer.id, unit_type: entityKey, count }]);
      return true;
    }
    if (def.harvest) return this.selectWorkers(entityKey);
    return false;
  }

  /**
   * The roster letters are per-race and the app may not know the race yet, so
   * it is read off the first snapshot that contains one of our own entities.
   */
  private ensureRace(): void {
    if (this.race) return;
    const own = this.getEntities().filter((e) => e.pl === this.playerId && hasEntityDef(e.ty));
    for (const race of RACES) {
      const roster = GAME.race_index[race];
      if (roster && own.some((e) => roster.includes(e.ty))) {
        this.setRace(race);
        return;
      }
    }
  }

  private selectArmy(): boolean {
    const ids: number[] = [];
    for (const e of this.getEntities()) {
      if (e.pl !== this.playerId || e.st === "dead") continue;
      if (!hasEntityDef(e.ty) || isBuilding(e.ty) || attackOf(e.ty) === null) continue;
      ids.push(e.id);
    }
    if (ids.length === 0) return false;
    this.setSelection(ids, false);
    return true;
  }

  private selectWorkers(entityKey: string): boolean {
    const ids = this.getEntities()
      .filter((e) => e.pl === this.playerId && e.st !== "dead" && e.ty === entityKey)
      .map((e) => e.id);
    if (ids.length === 0) return false;
    this.setSelection(ids, false);
    return true;
  }

  private recallGroup(group: number | null): boolean {
    if (group === null) return false;
    const ids = this.groups.recall(group).filter((id) => this.isAliveOwn(id));
    if (ids.length === 0) return false;
    this.setSelection(ids, false);
    this.groups.markCentred(group);
    return true;
  }

  /** Double-tapped group: put the camera on the squad's centre of mass. */
  private centreGroup(group: number | null): boolean {
    if (group === null) return false;
    const ids = this.groups.recall(group).filter((id) => this.isAliveOwn(id));
    if (ids.length === 0) return false;
    let x = 0;
    let z = 0;
    for (const id of ids) {
      const p = this.groundOf(id);
      if (!p) continue;
      x += p.x;
      z += p.z;
    }
    this.groups.markCentred(group);
    this.intent({
      kind: "focus",
      x: x / ids.length,
      z: z / ids.length,
      height: this.terrainHeight(x / ids.length, z / ids.length),
    });
    return true;
  }

  /**
   * Tab moves between selection sectors: connected clumps of the current
   * selection, the way StarCraft lets you attack a base piece by piece.
   */
  private cycleSubgroup(): boolean {
    const ids = this.selection.selectedIds().filter((id) => this.isAliveOwn(id));
    if (ids.length < 2) return false;
    const sectors = this.selectionSectors(ids);
    if (sectors.length < 2) return false;
    this.subgroupIndex = (this.subgroupIndex + 1) % sectors.length;
    this.setSelection(sectors[this.subgroupIndex], false);
    return true;
  }

  private selectionSectors(ids: number[]): number[][] {
    const points = ids.map((id) => this.groundOf(id) ?? { x: 0, z: 0 });
    const sector = new Array<number>(ids.length).fill(-1);
    const reach = SUBGROUP_RADIUS * SUBGROUP_RADIUS;
    for (let i = 0; i < ids.length; i++) {
      if (sector[i] >= 0) continue;
      const stack = [i];
      sector[i] = i;
      while (stack.length > 0) {
        const current = stack.pop() as number;
        for (let j = 0; j < ids.length; j++) {
          if (sector[j] >= 0) continue;
          const dx = points[current].x - points[j].x;
          const dz = points[current].z - points[j].z;
          if (dx * dx + dz * dz > reach) continue;
          sector[j] = i;
          stack.push(j);
        }
      }
    }
    const sectors: number[][] = [];
    for (let i = 0; i < ids.length; i++) {
      const key = sector[i];
      if (sectors[key] === undefined) sectors[key] = [];
      sectors[key].push(ids[i]);
    }
    return sectors.filter((s) => s !== undefined);
  }

  private cameraStep(action: HotkeyAction): void {
    if (action === "zoom_in") {
      this.intent({ kind: "zoom", steps: ZOOM_STEP });
      return;
    }
    if (action === "zoom_out") {
      this.intent({ kind: "zoom", steps: -ZOOM_STEP });
      return;
    }
    if (action === "camera_rotate_left") {
      this.intent({ kind: "rotate", radians: -ROTATE_STEP });
      return;
    }
    if (action === "camera_rotate_right") {
      this.intent({ kind: "rotate", radians: ROTATE_STEP });
      return;
    }
    const distance = CAMERA_SPEED_METRES_PER_SEC * CAMERA_TAP_SECONDS;
    const sx = action === "camera_left" ? -1 : action === "camera_right" ? 1 : 0;
    const sy = action === "camera_up" ? 1 : action === "camera_down" ? -1 : 0;
    this.panOnScreen(sx * distance, sy * distance);
  }

  /* ------------------------------------------------------------------ */
  /* Pointer                                                             */
  /* ------------------------------------------------------------------ */

  private readonly onPointerDown = (event: Event): void => {
    if (this.disposed) return;
    const e = event as PointerEvent;
    this.lastClient = { x: e.clientX, y: e.clientY };
    this.pointerGround = this.groundAt(e.clientX, e.clientY);

    if (this.pendingPlacement) {
      if (e.button === 2) {
        this.cancelPlacement();
        return;
      }
      if (e.button === 0) {
        this.confirmPlacement();
        return;
      }
      return;
    }

    if (e.button === 1) {
      this.drag = this.startDrag(e);
      this.modeState = "dragging_camera";
      e.preventDefault();
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;

    this.drag = this.startDrag(e);
    if (e.button !== 0) return;

    const hit = this.drag.target;
    if (hit && hit.pl === this.playerId) {
      if (e.shiftKey) this.selection.toggle(hit.id);
      else this.selection.set([hit.id]);
      this.afterSelectionChange();
      return;
    }
    if (hit) {
      // Left-pressing an enemy is an attack order for the current selection.
      this.issueAttack(hit, e.shiftKey);
    }
  };

  private readonly onPointerMove = (event: Event): void => {
    if (this.disposed) return;
    const e = event as PointerEvent;
    this.lastClient = { x: e.clientX, y: e.clientY };
    this.pointerGround = this.groundAt(e.clientX, e.clientY);

    if (this.pendingPlacement) {
      this.updateGhost(this.pointerGround);
      return;
    }

    const drag = this.drag;
    if (!drag) return;
    const dx = e.clientX - drag.clientX;
    const dy = e.clientY - drag.clientY;
    drag.clientX = e.clientX;
    drag.clientY = e.clientY;

    if (!drag.moved) {
      const travelled = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (travelled < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      if (drag.button === 1) this.modeState = "dragging_camera";
      else if (drag.button === 0) this.modeState = "box_select";
    }

    if (drag.button === 1) {
      this.intent({ kind: "rotate", radians: dx * ROTATE_PER_PIXEL });
      return;
    }
    if (drag.button === 2) {
      this.panOnPixels(-dx, -dy);
      return;
    }
  };

  private readonly onPointerUp = (event: Event): void => {
    if (this.disposed) return;
    const e = event as PointerEvent;
    this.lastClient = { x: e.clientX, y: e.clientY };
    this.pointerGround = this.groundAt(e.clientX, e.clientY);
    const drag = this.drag;
    this.drag = null;
    if (!drag) {
      if (this.modeState !== "placing") this.modeState = "normal";
      return;
    }
    if (drag.button === 0) {
      if (drag.moved) this.finishBoxSelect(drag);
      else this.finishClick(drag);
    } else if (drag.button === 2 && !drag.moved) {
      this.contextOrder(e.shiftKey);
    }
    if (this.modeState !== "placing") this.modeState = "normal";
  };

  private readonly onWheel = (event: Event): void => {
    if (this.disposed) return;
    const e = event as WheelEvent;
    e.preventDefault();
    this.intent({ kind: "zoom", steps: e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP });
  };

  private readonly onContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  private readonly onKeyDown = (event: Event): void => {
    if (this.disposed) return;
    if (this.hotkeys.handle(event as KeyboardEvent)) event.preventDefault();
  };

  private readonly onKeyUp = (event: Event): void => {
    if (this.disposed) return;
    this.hotkeys.handle(event as KeyboardEvent);
  };

  private startDrag(e: PointerEvent): DragState {
    const point = this.groundAt(e.clientX, e.clientY);
    return {
      button: e.button,
      startX: e.clientX,
      startY: e.clientY,
      clientX: e.clientX,
      clientY: e.clientY,
      world: point,
      target: point ? this.entityAt(point) : null,
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      moved: false,
    };
  }

  /** A press that never became a drag. */
  private finishClick(drag: DragState): void {
    const target = drag.target && this.isAlive(drag.target.id) ? drag.target : null;
    const isDouble = this.selection.noteClick(target?.id ?? null, this.clock());
    if (target) {
      if (isDouble && target.pl === this.playerId) {
        const result = this.selection.selectSameType(target.id, this.getEntities(), {
          myPlayerId: this.playerId,
          additive: drag.shift,
          isVisible: this.opts.scene.isVisible,
        });
        this.afterSelectionChange(result.overflow);
      }
      return;
    }
    // Clicked bare ground: order the current selection there, then drop it.
    if (drag.world) this.issueGroundOrder(drag.world, drag.shift);
    this.clearSelection();
  }

  private finishBoxSelect(drag: DragState): void {
    const corners = this.boxCorners();
    if (!corners) return;
    const anchor = drag.target && drag.target.pl === this.playerId ? groundPoint(drag.target) : undefined;
    const result = this.selection.selectInRect(
      { x0: corners.a.x, z0: corners.a.z, x1: corners.b.x, z1: corners.b.z },
      this.getEntities(),
      {
        myPlayerId: this.playerId,
        additive: drag.shift,
        requiresAttackable: drag.ctrl,
        maxRangeFromCentre: DRAG_SELECT_RADIUS,
        terrain: this.opts.terrain,
        centre: anchor,
      },
    );
    this.afterSelectionChange(result.overflow);
  }

  /**
   * The rectangle is one world corner fixed at press time plus the cursor's
   * live position, re-projected now — that is what makes it survive the
   * camera moving under a held button.
   */
  private boxCorners(): { a: WorldPoint; b: WorldPoint } | null {
    const drag = this.drag;
    if (!drag || drag.button !== 0 || !drag.moved || !drag.world) return null;
    const b = this.groundAt(drag.clientX, drag.clientY);
    if (!b) return null;
    return { a: drag.world, b };
  }

  /** Right-click: the only context menu StarCraft has. */
  private contextOrder(queued: boolean): void {
    const point = this.pointerGround;
    if (!point) return;
    const hit = this.entityAt(point);

    if (hit && hit.pl !== this.playerId) {
      this.issueAttack(hit, queued);
      return;
    }
    if (hit && hasEntityDef(hit.ty) && isBuilding(hit.ty)) {
      const buildings = this.orderBuildings();
      if (buildings.length === 0) return;
      this.push(
        buildings.map((b) => ({
          c: "rally" as const,
          building_id: b.id,
          x: round2(point.x),
          y: round2(point.z),
        })),
      );
      return;
    }
    if (this.nearMineralField(point)) {
      this.issueHarvest();
      return;
    }
    this.issueGroundOrder(point, false, queued);
  }

  private issueGroundOrder(point: WorldPoint, attackMove: boolean, queued = false): boolean {
    const units = this.orderUnits();
    if (units.length === 0) return false;
    this.previousOrder = this.lastPatrol;
    this.lastPatrol = point;
    // The wire protocol has no attack-move: ORDER_MOVE is the only order the
    // server can act on, so Shift+left-click sends a move and the intent is
    // carried by the caller, not the wire.
    void attackMove;
    return this.sendOrder(
      units,
      { c: "move", x: round2(point.x), y: round2(point.z) },
      queued,
    );
  }

  private issueAttack(target: ProtocolEntity, queued: boolean): boolean {
    const attackers = this.orderUnits().filter((u) => this.canTarget(u, target));
    if (attackers.length === 0) return false;
    return this.sendOrder(attackers, { c: "attack", target_id: target.id }, queued);
  }

  private issuePatrol(): boolean {
    const units = this.orderUnits();
    if (units.length === 0 || !this.lastPatrol) return false;
    const to = this.lastPatrol;
    const from = this.previousOrder ?? { x: to.x + 6, z: to.z };
    return this.sendOrder(units, {
      c: "patrol",
      x: round2(from.x),
      y: round2(from.z),
      x2: round2(to.x),
      y2: round2(to.z),
    });
  }

  private issueHarvest(): boolean {
    const workers = this.orderUnits().filter((u) => hasEntityDef(u.ty) && entityDef(u.ty).harvest);
    if (workers.length === 0) return false;
    this.push(workers.map((w) => ({ c: "harvest" as const, worker_id: w.id })));
    return true;
  }

  /**
   * Queues an order behind whatever the entity is already doing. The server
   * keeps the authoritative queue; this mirror exists so a seventh queued
   * order is not sent and so the HUD can show what is pending.
   */
  private sendOrder(units: ProtocolEntity[], order: QueuedOrder, queued = false): boolean {
    const commands: Command[] = [];
    for (const unit of units) {
      if (queued && this.orders.isFull(unit.id)) continue;
      if (!queued) this.orders.clear(unit.id);
      if (this.orders.push(unit.id, order) === "rejected") continue;
      commands.push(orderCommand(unit.id, order, queued));
    }
    this.push(commands);
    return commands.length > 0;
  }

  /* ------------------------------------------------------------------ */
  /* Placement                                                           */
  /* ------------------------------------------------------------------ */

  private updateGhost(point: WorldPoint | null): void {
    const unitType = this.pendingPlacement;
    if (!unitType || !point) {
      this.ghost = null;
      this.opts.onPlacementChange?.(null);
      return;
    }
    const def = entityDef(unitType);
    const x = Math.round(point.x / PLACEMENT_GRID) * PLACEMENT_GRID;
    const z = Math.round(point.z / PLACEMENT_GRID) * PLACEMENT_GRID;
    const size = this.opts.terrain;
    let reason: string | null = null;
    if (x < 0 || z < 0 || x > size.size || z > size.size) reason = "bounds";
    else if (size.passable && !size.passable(x, z)) reason = "terrain";
    else if (this.blockedAt(x, z, def.size.radius)) reason = "blocked";

    const worker = this.placementWorker();
    if (!reason && worker === null) reason = "worker";
    if (!reason && (worker?.res ?? 0) < def.cost.minerals) reason = "resources";

    this.ghost = {
      unitType,
      x,
      z,
      height: this.terrainHeight(x, z),
      radius: def.size.radius,
      valid: reason === null,
      reason,
    };
    this.opts.onPlacementChange?.(this.ghost);
  }

  private confirmPlacement(): boolean {
    const ghost = this.ghost;
    if (!ghost || !ghost.valid) return false;
    const worker = this.placementWorker();
    if (worker === null) return false;
    this.push([
      {
        c: "build",
        worker_id: worker,
        unit_type: ghost.unitType,
        x: round2(ghost.x),
        y: round2(ghost.z),
      },
    ]);
    this.cancelPlacement();
    return true;
  }

  private placementWorker(): ProtocolEntity | null {
    for (const e of this.orderUnits()) {
      if (hasEntityDef(e.ty) && entityDef(e.ty).harvest) return e;
    }
    return null;
  }

  /** Only structures block a footprint; units get out of the way. */
  private blockedAt(x: number, z: number, radius: number): boolean {
    for (const e of this.getEntities()) {
      if (e.st === "dead" || !hasEntityDef(e.ty)) continue;
      const def = entityDef(e.ty);
      if (def.kind !== "building") continue;
      const p = groundPoint(e);
      if (Math.hypot(p.x - x, p.z - z) < radius + def.size.radius) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Camera                                                              */
  /* ------------------------------------------------------------------ */

  private intent(value: CameraIntent): void {
    this.opts.onCameraIntent?.(value);
  }

  /** Pans by ground metres along the screen basis, so WASD stays screen-true. */
  private panOnScreen(sx: number, sy: number): void {
    if (sx === 0 && sy === 0) return;
    const basis = this.viewBasis();
    this.intent({ kind: "pan", dx: sx * basis.rx + sy * basis.ux, dz: sx * basis.rz + sy * basis.uz });
  }

  private panOnPixels(dx: number, dy: number): void {
    const basis = this.viewBasis();
    if (basis.mpp === 0) return;
    this.intent({ kind: "pan", dx: -dx * basis.mpp * basis.rx + dy * basis.mpp * basis.ux, dz: -dx * basis.mpp * basis.rz + dy * basis.mpp * basis.uz });
  }

  /**
   * Screen basis derived from the scene's own projection: two ground samples
   * give the world direction of screen-right and screen-down, which also
   * yields the metres-per-pixel a drag pan needs. No camera state is required.
   */
  private viewBasis(): { rx: number; rz: number; ux: number; uz: number; mpp: number } {
    const rect = this.viewportRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const reach = 12;
    const left = this.groundAt(cx - reach, cy);
    const right = this.groundAt(cx + reach, cy);
    const up = this.groundAt(cx, cy - reach);
    const down = this.groundAt(cx, cy + reach);
    if (!left || !right || !up || !down) return { rx: 1, rz: 0, ux: 0, uz: -1, mpp: 0 };
    const rx = (right.x - left.x) / (2 * reach);
    const rz = (right.z - left.z) / (2 * reach);
    const ux = (up.x - down.x) / (2 * reach);
    const uz = (up.z - down.z) / (2 * reach);
    return { rx, rz, ux, uz, mpp: Math.hypot(rx, rz) };
  }

  private edgeScrollVector(): { x: number; y: number } | null {
    const client = this.lastClient;
    if (!client || this.drag) return null;
    const rect = this.viewportRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const left = client.x - rect.left;
    const right = rect.width - left;
    const top = client.y - rect.top;
    const bottom = rect.height - top;
    let x = 0;
    let y = 0;
    if (left < EDGE_SCROLL_PX) x = -1;
    else if (right < EDGE_SCROLL_PX) x = 1;
    if (top < EDGE_SCROLL_PX) y = 1;
    else if (bottom < EDGE_SCROLL_PX) y = -1;
    return x === 0 && y === 0 ? null : { x, y };
  }

  private viewportRect(): { left: number; top: number; width: number; height: number } {
    const rect = this.element.getBoundingClientRect?.();
    if (!rect) return { left: 0, top: 0, width: 0, height: 0 };
    return rect;
  }

  private startLoop(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.lastStepAt = null;
    this.frameHandle = this.requestFrame(this.frame);
  }

  private stopLoop(): void {
    if (!this.scheduled) return;
    this.scheduled = false;
    this.cancelFrame(this.frameHandle);
    this.frameHandle = 0;
  }

  private readonly frame = (): void => {
    if (this.disposed || !this.scheduled) return;
    const now = this.clock();
    const previous = this.lastStepAt;
    this.lastStepAt = now;
    // A frame scheduler that calls back synchronously would otherwise recurse
    // forever; no time has passed, so there is nothing to advance.
    if (previous !== null && now - previous <= 0) {
      this.scheduled = false;
      return;
    }
    this.step(previous === null ? 0 : (now - previous) / 1000);
    this.frameHandle = this.requestFrame(this.frame);
  };

  private requestFrame(callback: () => void): number {
    if (this.opts.requestFrame) return this.opts.requestFrame(callback);
    const raf = (globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number })
      .requestAnimationFrame;
    return raf ? raf(() => callback()) : 0;
  }

  private cancelFrame(handle: number): void {
    if (this.opts.cancelFrame) {
      this.opts.cancelFrame(handle);
      return;
    }
    const caf = (globalThis as { cancelAnimationFrame?: (handle: number) => void })
      .cancelAnimationFrame;
    if (caf) caf(handle);
  }

  /* ------------------------------------------------------------------ */
  /* Entity and selection helpers                                        */
  /* ------------------------------------------------------------------ */

  private getEntities(): ProtocolEntity[] {
    return this.opts.getEntities();
  }

  private setSelection(ids: number[], additive: boolean): void {
    if (additive) this.selection.add(ids);
    else this.selection.set(ids);
    this.afterSelectionChange();
  }

  private clearSelection(): void {
    if (this.selection.size === 0) return;
    this.selection.clear();
    this.afterSelectionChange();
  }

  private afterSelectionChange(overflow?: number): void {
    this.opts.onSelectionChange?.(
      this.selection.selectedIds(),
      overflow ?? this.selection.lastOverflow,
    );
  }

  private entityAt(point: WorldPoint): ProtocolEntity | null {
    let best: ProtocolEntity | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const e of this.getEntities()) {
      if (e.st === "dead" || !hasEntityDef(e.ty)) continue;
      const p = groundPoint(e);
      const gap = Math.hypot(p.x - point.x, p.z - point.z);
      if (gap > entityDef(e.ty).size.radius || gap >= bestDistance) continue;
      best = e;
      bestDistance = gap;
    }
    return best;
  }

  /** Selected entities we own, alive, and that take field orders. */
  private orderUnits(): ProtocolEntity[] {
    return this.selectedOwn().filter((e) => hasEntityDef(e.ty) && !isBuilding(e.ty));
  }

  private orderBuildings(): ProtocolEntity[] {
    return this.selectedOwn().filter((e) => hasEntityDef(e.ty) && isBuilding(e.ty));
  }

  private selectedOwn(): ProtocolEntity[] {
    const byId = new Map<number, ProtocolEntity>();
    for (const e of this.getEntities()) byId.set(e.id, e);
    const out: ProtocolEntity[] = [];
    for (const id of this.selection.selectedIds()) {
      const e = byId.get(id);
      if (e && e.pl === this.playerId && e.st !== "dead") out.push(e);
    }
    return out;
  }

  private canTarget(attacker: ProtocolEntity, target: ProtocolEntity): boolean {
    const weapon = hasEntityDef(attacker.ty) ? attackOf(attacker.ty) : null;
    if (!weapon || !hasEntityDef(target.ty)) return false;
    const klass = isBuilding(target.ty)
      ? "structure"
      : isAirUnit(target.ty)
        ? "air"
        : "ground";
    return weapon.targets.includes(klass);
  }

  private isAliveOwn(id: number): boolean {
    return this.getEntities().some(
      (e) => e.id === id && e.st !== "dead" && e.pl === this.playerId,
    );
  }

  private isAliveOwn(id: number): boolean {
    return this.getEntities().some(
      (e) => e.id === id && e.st !== "dead" && e.pl === this.playerId,
    );
  }

  private groundOf(id: number): WorldPoint | null {
    const e = this.getEntities().find((candidate) => candidate.id === id);
    return e && e.st !== "dead" ? groundPoint(e) : null;
  }

  private lastGroundPoint(): WorldPoint | null {
    return this.lastClient ? this.groundAt(this.lastClient.x, this.lastClient.y) : null;
  }

  private nearMineralField(point: WorldPoint): boolean {
    const clusters = this.opts.mineralFields;
    if (!clusters) return false;
    return clusters.some(
      (c) => Math.hypot(c.x - point.x, c.y - point.z) <= MINERAL_FIELD_RADIUS,
    );
  }

  private groundAt(clientX: number, clientY: number): WorldPoint | null {
    const out = { x: 0, z: 0 };
    return this.opts.scene.screenToGround(clientX, clientY, out) ? out : null;
  }

  private terrainHeight(x: number, z: number): number {
    return this.opts.terrain.sample?.(x, z) ?? 0;
  }

  private resolveKeyboardTarget(target?: InputElement): InputElement {
    return this.element.ownerDocument?.defaultView ?? target ?? this.element;
  }

  private clock(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private push(commands: Command[]): void {
    if (commands.length > 0) this.opts.send(commands);
  }
}

