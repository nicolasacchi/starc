/**
 * Selection model — the StarCraft rules, not the Chromium ones.
 *
 * Coordinates: a snapshot entity carries `{x, y, z}` where `z` is terrain
 * height and `y` is the second ground axis (PROTOCOL.md §5). The render layer
 * works in `{x, z}` ground space. `groundPoint` is the one place that mapping
 * happens, so nothing else has to remember it.
 */
import { attackOf, hasEntityDef, isBuilding } from "@shared/gameData";
import type { ProtocolEntity } from "@shared/protocol";

/** StarCraft never keeps more than 100 entities selected. */
export const MAX_SELECTION = 100;

/**
 * Drag-select is capped by distance from the anchor: a unit further than this
 * (world metres) from the entity the drag started on is not picked up.
 */
export const DRAG_SELECT_RADIUS = 50;

/** Two clicks on the same entity inside this window are a double-click. */
export const DOUBLE_CLICK_MS = 400;

export interface WorldPoint {
  x: number;
  z: number;
}

/** Axis-aligned ground rectangle; corners are normalised on use. */
export interface WorldRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface SelectionResult {
  /** The selection after the change, ascending by id. */
  ids: number[];
  /** How many entities matched before the ceiling was applied. */
  total: number;
  /** `total` minus how many made it in. */
  overflow: number;
}

export interface RectSelectOptions {
  myPlayerId: number;
  /** Keep the current selection and add to it (shift-drag). */
  additive: boolean;
  /** Pick enemy combat units instead of friendly ones (ctrl-drag). */
  requiresAttackable: boolean;
  /** StarCraft's drag-select distance cap, in world metres from `centre`. */
  maxRangeFromCentre: number;
  /** Supplies the world size so a drag leaving the map cannot select the void. */
  terrain?: { readonly size: number };
  /** The anchor the distance cap is measured from; defaults to the rect centre. */
  centre?: WorldPoint;
  /** Overrides {@link MAX_SELECTION}. */
  limit?: number;
}

export interface SameTypeOptions {
  myPlayerId: number;
  additive: boolean;
  /** Frustum test; entities outside the viewport are not picked up. */
  isVisible?: (x: number, z: number) => boolean;
  limit?: number;
}

/** Protocol ground plane: `x` east, `y` north, `z` up. */
export function groundPoint(e: ProtocolEntity): WorldPoint {
  return { x: e.x, z: e.y };
}

/** World rectangle with `min`/`max` applied and the map bounds respected. */
export function normaliseRect(rect: WorldRect, worldSize?: number): WorldRect {
  let x0 = Math.min(rect.x0, rect.x1);
  let x1 = Math.max(rect.x0, rect.x1);
  let z0 = Math.min(rect.z0, rect.z1);
  let z1 = Math.max(rect.z0, rect.z1);
  if (worldSize !== undefined && worldSize > 0) {
    x0 = clamp(x0, 0, worldSize);
    x1 = clamp(x1, 0, worldSize);
    z0 = clamp(z0, 0, worldSize);
    z1 = clamp(z1, 0, worldSize);
  }
  return { x0, z0, x1, z1 };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** An enemy is only a legal selection target when it is a combat unit. */
function isAttackableUnit(e: ProtocolEntity): boolean {
  if (!hasEntityDef(e.ty)) return false;
  if (isBuilding(e.ty)) return false;
  return attackOf(e.ty) !== null;
}

export class SelectionManager {
  /**
   * The live selection. Mutate through the methods below — writing to the set
   * directly will not bump {@link version}, which is what change detection
   * (and the renderer) rely on.
   */
  readonly selected = new Set<number>();

  /** The entity under the last left-click, or null when the click hit ground. */
  lastClickedId: number | null = null;

  /** Bumped on every mutation; compare against the previous frame's value. */
  version = 0;

  /** Entities dropped by the ceiling in the most recent bulk change. */
  lastOverflow = 0;

  private lastClickTime = Number.NEGATIVE_INFINITY;
  private readonly max: number;

  constructor(opts: { max?: number } = {}) {
    this.max = opts.max ?? MAX_SELECTION;
  }

  get size(): number {
    return this.selected.size;
  }

  has(id: number): boolean {
    return this.selected.has(id);
  }

  /** Ascending by id — the renderer draws rings in a stable order. */
  selectedIds(): number[] {
    return [...this.selected].sort((a, b) => a - b);
  }

  /** Replaces the selection. Returns the ids that hit the ceiling. */
  set(ids: Iterable<number>): number[] {
    this.selected.clear();
    return this.add(ids);
  }

  /** Adds to the selection, keeping insertion order under the ceiling. */
  add(ids: Iterable<number>): number[] {
    const dropped: number[] = [];
    for (const id of ids) {
      if (!this.selected.has(id) && this.selected.size >= this.max) {
        dropped.push(id);
        continue;
      }
      this.selected.add(id);
    }
    this.touch(dropped.length);
    return dropped;
  }

  remove(ids: Iterable<number>): void {
    let changed = false;
    for (const id of ids) changed = this.selected.delete(id) || changed;
    if (changed) this.touch(0);
  }

  toggle(id: number): void {
    if (this.selected.has(id)) this.remove([id]);
    else this.add([id]);
  }

  clear(): void {
    if (this.selected.size === 0) return;
    this.selected.clear();
    this.touch(0);
  }

  /**
   * Records a click and reports whether it completed a double-click on the
   * same entity. `timeMs` comes from the caller's clock, so this stays pure.
   */
  noteClick(id: number | null, timeMs: number): boolean {
    const isDouble =
      id !== null && id === this.lastClickedId && timeMs - this.lastClickTime <= DOUBLE_CLICK_MS;
    this.lastClickedId = id;
    this.lastClickTime = timeMs;
    return isDouble;
  }

  /**
   * Drag-box select. Friendly by default, enemy combat units when
   * `requiresAttackable`, and everything subject to the StarCraft distance cap
   * from `centre` (the entity the drag started on).
   */
  selectInRect(
    corners: WorldRect,
    entities: ProtocolEntity[],
    opts: RectSelectOptions,
  ): SelectionResult {
    const rect = normaliseRect(corners, opts.terrain?.size);
    const centre = opts.centre ?? { x: (rect.x0 + rect.x1) / 2, z: (rect.z0 + rect.z1) / 2 };
    const capped = opts.maxRangeFromCentre > 0;
    const limit = opts.limit ?? this.max;

    const picked: number[] = [];
    for (const e of entities) {
      if (e.st === "dead") continue;
      const p = groundPoint(e);
      if (p.x < rect.x0 || p.x > rect.x1 || p.z < rect.z0 || p.z > rect.z1) continue;
      if (opts.requiresAttackable) {
        if (e.pl === opts.myPlayerId || !isAttackableUnit(e)) continue;
      } else if (e.pl !== opts.myPlayerId) {
        continue;
      }
      if (capped && Math.hypot(centre.x - p.x, centre.z - p.z) > opts.maxRangeFromCentre) continue;
      picked.push(e.id);
    }
    return this.apply(picked, opts.additive, limit);
  }

  /** Double-click: every visible entity of the anchor's type, on our side. */
  selectSameType(
    anchorId: number,
    entities: ProtocolEntity[],
    opts: SameTypeOptions,
  ): SelectionResult {
    const anchor = entities.find((e) => e.id === anchorId);
    if (!anchor) return { ids: this.selectedIds(), total: 0, overflow: 0 };

    const picked: number[] = [];
    for (const e of entities) {
      if (e.st === "dead" || e.ty !== anchor.ty || e.pl !== opts.myPlayerId) continue;
      if (opts.isVisible && !opts.isVisible(e.x, e.y)) continue;
      picked.push(e.id);
    }
    return this.apply(picked, opts.additive, opts.limit ?? this.max);
  }

  private apply(picked: number[], additive: boolean, limit: number): SelectionResult {
    if (!additive) this.selected.clear();
    const ceiling = Math.min(limit, this.max);
    let room = Math.max(0, ceiling - this.selected.size);
    const dropped: number[] = [];
    for (const id of picked) {
      if (this.selected.has(id)) continue;
      if (room === 0) {
        dropped.push(id);
        continue;
      }
      this.selected.add(id);
      room--;
    }
    this.touch(dropped.length);
    return { ids: this.selectedIds(), total: picked.length, overflow: dropped.length };
  }

  private touch(overflow: number): void {
    this.lastOverflow = overflow;
    this.version++;
  }
}
