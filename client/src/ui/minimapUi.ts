/**
 * DOM minimap: its own 2D canvas, fed with blips by the game layer.
 *
 * It deliberately does not read the 3D scene — the host pushes blips, the
 * camera rectangle and the map definition, and this widget answers with world
 * coordinates, a unit selection, or nothing at all. Click, right-click (an
 * order point) and drag-box-select are all handled here.
 */
import { GAME } from "@shared/gameData";
import type { MapDef } from "@shared/protocol";
import type { MinimapBlip } from "./uiTypes";
import { Teardown, clear, docOf, el, listen } from "./uiTypes";

export interface MinimapUiOptions {
  /** A world point was addressed on the minimap (right-click = order point). */
  onWorldPoint(x: number, z: number, rightClick: boolean): void;
  /** Units addressed by a click or a drag box. */
  onSelectUnits?(ids: number[]): void;
  /** CSS size of the square, px. Default 224. */
  size?: number;
  /** CSS size while expanded, px. Default 360. */
  expandedSize?: number;
  /** Fallback world extent when no map is set, metres. */
  worldSize?: number;
}

interface ResolvedOptions {
  onWorldPoint(x: number, z: number, rightClick: boolean): void;
  onSelectUnits?: (ids: number[]) => void;
  size: number;
  expandedSize: number;
  worldSize: number;
}

interface DragBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const DRAG_THRESHOLD = 5;
const COLOR = {
  void: "#050a0f",
  grid: "#12212c",
  mineral: "#ffb648",
  expansion: "#8d7a4a",
  start: "#5f7f92",
  viewport: "#3fd8ff",
  selected: "#ffffff",
  own: "#3fd8ff",
  ally: "#4d7dff",
  enemy: "#ff5f56",
  neutral: "#7f97a8",
  box: "rgba(63, 216, 255, 0.16)",
  boxLine: "rgba(63, 216, 255, 0.7)",
} as const;

export class MinimapUi {
  private readonly teardown = new Teardown();
  private readonly opts: ResolvedOptions;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private map: MapDef | null = null;
  private blips: readonly MinimapBlip[] = [];
  private viewport: { x: number; z: number; w: number; h: number } | null = null;
  private drag: DragBox | null = null;
  private dragging = false;
  private expanded = false;
  private showUnits = true;
  private showBuildings = true;
  private cssSize: number;

  constructor(options: MinimapUiOptions) {
    this.opts = {
      onWorldPoint: options.onWorldPoint,
      onSelectUnits: options.onSelectUnits,
      size: options.size ?? 224,
      expandedSize: options.expandedSize ?? 360,
      worldSize: options.worldSize ?? GAME.world_size,
    };
    this.cssSize = this.opts.size;
  }

  mount(root: HTMLElement): void {
    const doc = docOf(root);
    const host = el(doc, "div", "minimap");
    const canvas = el(doc, "canvas", "minimap__canvas");
    const controls = el(doc, "div", "minimap__controls");
    controls.append(
      this.toggle(doc, "U", "units", () => {
        this.showUnits = !this.showUnits;
        this.redraw();
      }),
      this.toggle(doc, "B", "buildings", () => {
        this.showBuildings = !this.showBuildings;
        this.redraw();
      }),
    );
    const expand = el(doc, "button", "minimap__expand", "⤢");
    expand.type = "button";
    expand.title = "Enlarge the minimap";
    expand.setAttribute("aria-label", "Enlarge the minimap");
    listen(
      expand,
      "click",
      () => {
        this.expanded = !this.expanded;
        host.classList.toggle("is-expanded", this.expanded);
        this.cssSize = this.expanded ? this.opts.expandedSize : this.opts.size;
        this.resize();
      },
      this.teardown,
    );
    controls.append(expand);
    host.append(canvas, controls);

    clear(root);
    root.append(host);
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.wirePointer(canvas);
    this.resize();
    this.teardown.add(() => {
      if (host.parentNode !== null) host.parentNode.removeChild(host);
      this.canvas = null;
      this.ctx = null;
    });
  }

  setMap(map: MapDef | null): void {
    this.map = map;
    this.redraw();
  }

  setBlips(blips: readonly MinimapBlip[]): void {
    this.blips = blips;
    this.redraw();
  }

  setViewport(rect: { x: number; z: number; w: number; h: number } | null): void {
    this.viewport = rect;
    this.redraw();
  }

  /** Resizes the backing store to the CSS box. Safe to call on window resize. */
  resize(): void {
    const canvas = this.canvas;
    if (canvas === null) return;
    const ratio = this.pixelRatio();
    const extent = Math.round(this.cssSize * ratio);
    if (canvas.width !== extent || canvas.height !== extent) {
      canvas.width = extent;
      canvas.height = extent;
      canvas.style.width = `${this.cssSize}px`;
      canvas.style.height = `${this.cssSize}px`;
    }
    this.redraw();
  }

  redraw(): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const scale = this.cssSize;
    const ratio = this.pixelRatio();
    ctx.save();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, scale, scale);
    ctx.fillStyle = COLOR.void;
    ctx.fillRect(0, 0, scale, scale);
    this.drawGrid(ctx, scale);
    this.drawMap(ctx, scale);
    if (this.viewport !== null) this.drawViewport(ctx, scale);
    this.drawBlips(ctx, scale);
    if (this.dragging && this.drag !== null) this.drawDrag(ctx);
    ctx.restore();
  }

  dispose(): void {
    this.teardown.dispose();
  }

  /* ------------------------------------------------------------------ */

  private toggle(doc: Document, key: string, subject: string, onToggle: () => void): HTMLButtonElement {
    const node = el(doc, "button", "minimap__toggle is-on", key);
    node.type = "button";
    node.title = `Show ${subject}`;
    listen(
      node,
      "click",
      () => {
        node.classList.toggle("is-on");
        onToggle();
      },
      this.teardown,
    );
    return node;
  }

  private pixelRatio(): number {
    const raw = typeof globalThis.devicePixelRatio === "number" ? globalThis.devicePixelRatio : 1;
    return Math.min(Math.max(raw, 1), 3);
  }

  /** World extent in metres covered by the widget. */
  private extent(): number {
    return this.map !== null && this.map.size > 0 ? this.map.size : this.opts.worldSize;
  }

  private toCanvas(x: number, z: number, scale: number): { x: number; y: number } {
    const extent = this.extent();
    return { x: (x / extent) * scale, y: (z / extent) * scale };
  }

  private toWorld(px: number, py: number, scale: number): { x: number; z: number } {
    const extent = this.extent();
    return { x: (px / scale) * extent, z: (py / scale) * extent };
  }

  /** Pointer position normalised to the widget's own `cssSize` space. */
  private pointerPosition(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const canvas = this.canvas;
    const scale = this.cssSize;
    if (canvas === null) return { x: 0, y: 0 };
    const box = canvas.getBoundingClientRect();
    const width = box.width > 0 ? box.width : scale;
    const height = box.height > 0 ? box.height : scale;
    return { x: ((ev.clientX - box.left) / width) * scale, y: ((ev.clientY - box.top) / height) * scale };
  }

  private wirePointer(canvas: HTMLCanvasElement): void {
    listen(
      canvas,
      "pointerdown",
      (ev) => {
        const event = ev as PointerEvent;
        if (event.button !== 0 && event.button !== 2) return;
        if (typeof canvas.setPointerCapture === "function") canvas.setPointerCapture(event.pointerId);
        const pos = this.pointerPosition(event);
        this.drag = { x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y };
        this.dragging = false;
        this.redraw();
      },
      this.teardown,
    );
    listen(
      canvas,
      "pointermove",
      (ev) => {
        const box = this.drag;
        if (box === null) return;
        const pos = this.pointerPosition(ev as PointerEvent);
        box.x1 = pos.x;
        box.y1 = pos.y;
        if (!this.dragging && Math.hypot(pos.x - box.x0, pos.y - box.y0) >= DRAG_THRESHOLD) this.dragging = true;
        if (this.dragging) this.redraw();
      },
      this.teardown,
    );
    listen(
      canvas,
      "pointerup",
      (ev) => {
        const box = this.drag;
        this.drag = null;
        if (box === null) return;
        const event = ev as PointerEvent;
        const pos = this.pointerPosition(event);
        if (this.dragging) {
          this.dragging = false;
          this.selectInBox(box, pos);
        } else {
          this.pointerAction(pos, event.button === 2);
        }
        this.redraw();
      },
      this.teardown,
    );
    listen(
      canvas,
      "pointercancel",
      () => {
        this.drag = null;
        this.dragging = false;
        this.redraw();
      },
      this.teardown,
    );
    listen(
      canvas,
      "contextmenu",
      (ev) => {
        ev.preventDefault();
        const pos = this.pointerPosition(ev as MouseEvent);
        const world = this.toWorld(pos.x, pos.y, this.cssSize);
        this.opts.onWorldPoint(world.x, world.z, true);
      },
      this.teardown,
    );
  }

  /** A click: a friendly blip selects, everything else addresses the world. */
  private pointerAction(pos: { x: number; y: number }, rightClick: boolean): void {
    if (!rightClick) {
      const hit = this.blipAt(pos.x, pos.y);
      const friendly = hit !== null && (hit.relation === "own" || hit.relation === "ally");
      if (friendly && hit !== null && this.opts.onSelectUnits !== undefined) {
        this.opts.onSelectUnits([hit.id]);
        return;
      }
    }
    const world = this.toWorld(pos.x, pos.y, this.cssSize);
    this.opts.onWorldPoint(world.x, world.z, rightClick);
  }

  private blipAt(px: number, py: number): MinimapBlip | null {
    let best: MinimapBlip | null = null;
    let bestDist = 8;
    for (const blip of this.visibleBlips()) {
      const point = this.toCanvas(blip.x, blip.z, this.cssSize);
      const dist = Math.hypot(point.x - px, point.y - py);
      if (dist < bestDist) {
        bestDist = dist;
        best = blip;
      }
    }
    return best;
  }

  private selectInBox(box: DragBox, pos: { x: number; y: number }): void {
    if (this.opts.onSelectUnits === undefined) return;
    const minX = Math.min(box.x0, pos.x);
    const maxX = Math.max(box.x0, pos.x);
    const minY = Math.min(box.y0, pos.y);
    const maxY = Math.max(box.y0, pos.y);
    const ids: number[] = [];
    for (const blip of this.visibleBlips()) {
      if (blip.relation !== "own" && blip.relation !== "ally") continue;
      const point = this.toCanvas(blip.x, blip.z, this.cssSize);
      if (point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY) ids.push(blip.id);
    }
    this.opts.onSelectUnits(ids);
  }

  private visibleBlips(): readonly MinimapBlip[] {
    return this.blips.filter((blip) => (blip.kind === "unit" ? this.showUnits : this.showBuildings));
  }

  /* Drawing ------------------------------------------------------------ */

  private drawGrid(ctx: CanvasRenderingContext2D, scale: number): void {
    ctx.strokeStyle = COLOR.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i += 1) {
      const at = Math.round((scale * i) / 4) + 0.5;
      ctx.moveTo(at, 0);
      ctx.lineTo(at, scale);
      ctx.moveTo(0, at);
      ctx.lineTo(scale, at);
    }
    ctx.stroke();
  }

  private drawMap(ctx: CanvasRenderingContext2D, scale: number): void {
    const map = this.map;
    if (map === null) return;
    for (const cluster of map.mineral_clusters) {
      const point = this.toCanvas(cluster.x, cluster.z, scale);
      const rich = cluster.rich === true;
      ctx.fillStyle = rich ? COLOR.mineral : COLOR.expansion;
      ctx.globalAlpha = rich ? 0.95 : 0.7;
      ctx.beginPath();
      ctx.arc(point.x, point.y, rich ? 2.2 : 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = COLOR.start;
    ctx.lineWidth = 1.2;
    for (const start of map.start_positions) {
      const point = this.toCanvas(start.x, start.z, scale);
      ctx.beginPath();
      ctx.moveTo(point.x, point.y - 4);
      ctx.lineTo(point.x + 4, point.y);
      ctx.lineTo(point.x, point.y + 4);
      ctx.lineTo(point.x - 4, point.y);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(63, 216, 255, 0.25)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, scale - 1, scale - 1);
  }

  private drawViewport(ctx: CanvasRenderingContext2D, scale: number): void {
    const view = this.viewport;
    if (view === null) return;
    const topLeft = this.toCanvas(view.x, view.z, scale);
    const width = (view.w / this.extent()) * scale;
    const height = (view.h / this.extent()) * scale;
    ctx.strokeStyle = COLOR.viewport;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(topLeft.x + 0.5, topLeft.y + 0.5, width, height);
  }

  private drawBlips(ctx: CanvasRenderingContext2D, scale: number): void {
    for (const blip of this.visibleBlips()) {
      const point = this.toCanvas(blip.x, blip.z, scale);
      const building = blip.kind === "building";
      const size = building ? 3.4 : 2;
      ctx.fillStyle = COLOR[blip.relation];
      if (building) {
        ctx.fillRect(point.x - size, point.y - size, size * 2, size * 2);
      } else {
        ctx.beginPath();
        ctx.arc(point.x, point.y, size, 0, Math.PI * 2);
        ctx.fill();
      }
      if (blip.selected === true) {
        ctx.strokeStyle = COLOR.selected;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(point.x, point.y, size + 2.4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  private drawDrag(ctx: CanvasRenderingContext2D): void {
    const box = this.drag;
    if (box === null) return;
    const x = Math.min(box.x0, box.x1);
    const y = Math.min(box.y0, box.y1);
    const width = Math.abs(box.x1 - box.x0);
    const height = Math.abs(box.y1 - box.y0);
    ctx.fillStyle = COLOR.box;
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = COLOR.boxLine;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, width, height);
  }
}
