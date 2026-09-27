/**
 * Minimap: a top-down render of the match.
 *
 * ASSETS: 100% procedural. The terrain colour + hill-shade bake is computed
 * from the `HeightField` at roughly one pixel per metre and uploaded through a
 * runtime canvas (`OffscreenCanvas`/`HTMLCanvasElement`) when one exists, or
 * through a `DataTexture` built from the same pixels when it does not (so a
 * headless test gets an identical image). No image file, no model, no network.
 *
 * Layers, back to front: terrain bake and static markers (both once per map) →
 * live unit blips → selection highlight → camera frustum quad. Everything is
 * composited into one preallocated pixel buffer, so an update allocates
 * nothing, and the texture is re-uploaded on a fixed cadence rather than every
 * frame.
 */
import * as THREE from "three";

import type { MapDef } from "@shared/protocol";
import type { QualitySettings } from "@render/core/quality";
import type { EntityView, Relation } from "@render/entities/entityView";
import { heightField } from "@render/terrain/heightfield";
import type { HeightField } from "@render/terrain/heightfield";

/** Upper bound on texture pixels per side. */
const RESOLUTION = 320;
/** Re-upload cadence in seconds; 20 Hz is indistinguishable on a minimap. */
const UPLOAD_INTERVAL = 1 / 20;
/** Blip radius in pixels, small unit to large structure. */
const BLIP_MIN = 1.2;
const BLIP_MAX = 3.4;
const LIGHT_DIR: readonly [number, number, number] = [-0.55, 0.72, -0.42];

interface BiomeRamp {
  shore: readonly [number, number, number];
  low: readonly [number, number, number];
  mid: readonly [number, number, number];
  high: readonly [number, number, number];
  peak: readonly [number, number, number];
  rock: readonly [number, number, number];
}

const BIOME_RAMP: Record<string, BiomeRamp> = {
  grassland: {
    shore: [196, 184, 132], low: [96, 132, 66], mid: [74, 112, 56],
    high: [92, 116, 74], peak: [140, 146, 140], rock: [110, 108, 100],
  },
  rocky: {
    shore: [150, 140, 122], low: [92, 88, 82], mid: [110, 104, 96],
    high: [126, 120, 110], peak: [162, 158, 150], rock: [84, 80, 76],
  },
  badlands: {
    shore: [176, 132, 86], low: [138, 84, 52], mid: [158, 96, 56],
    high: [124, 76, 50], peak: [186, 152, 108], rock: [96, 62, 44],
  },
  island: {
    shore: [222, 214, 172], low: [86, 132, 74], mid: [70, 112, 62],
    high: [104, 122, 96], peak: [168, 170, 162], rock: [116, 112, 104],
  },
};

const DEFAULT_RAMP = BIOME_RAMP.grassland;

const BLIP_COLOR: Record<Relation, readonly [number, number, number]> = {
  own: [120, 255, 140],
  ally: [110, 200, 255],
  enemy: [255, 90, 80],
};

type Pixels = Uint8ClampedArray;

function makeCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas | null {
  if (typeof OffscreenCanvas !== "undefined") {
    try {
      return new OffscreenCanvas(width, height);
    } catch {
      // Fall through to the DOM path.
    }
  }
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}

function blendPixel(px: Pixels, res: number, x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (x < 0 || y < 0 || x >= res || y >= res) return;
  const p = (y * res + x) * 4;
  px[p] += (r - px[p]) * a;
  px[p + 1] += (g - px[p + 1]) * a;
  px[p + 2] += (b - px[p + 2]) * a;
  px[p + 3] = 255;
}

function fillDisc(px: Pixels, res: number, cx: number, cy: number, radius: number, r: number, g: number, b: number, a: number): void {
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(res - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(res - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      // A pixel of soft edge keeps single-pixel blips from shimmering.
      blendPixel(px, res, x, y, r, g, b, a * Math.min(1, (radius - Math.sqrt(d2)) * 1.4));
    }
  }
}

function strokeDisc(px: Pixels, res: number, cx: number, cy: number, radius: number, r: number, g: number, b: number, a: number): void {
  const x0 = Math.max(0, Math.floor(cx - radius - 1));
  const x1 = Math.min(res - 1, Math.ceil(cx + radius + 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const y1 = Math.min(res - 1, Math.ceil(cy + radius + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius) > 0.9) continue;
      blendPixel(px, res, x, y, r, g, b, a);
    }
  }
}

function strokeSegment(px: Pixels, res: number, x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, a: number): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
  if (steps <= 0) {
    blendPixel(px, res, Math.round(x0), Math.round(y0), r, g, b, a);
    return;
  }
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    blendPixel(px, res, Math.round(x0 + dx * t), Math.round(y0 + dy * t), r, g, b, a);
  }
}

/** Samples the five-stop biome ramp at `t` in [0,1]. */
function mixRamp(ramp: BiomeRamp, t: number, out: { r: number; g: number; b: number }): void {
  const clamped = Math.max(0, Math.min(0.9999, t)) * 4;
  const i = Math.floor(clamped);
  const f = clamped - i;
  const a = i === 0 ? ramp.shore : i === 1 ? ramp.low : i === 2 ? ramp.mid : i === 3 ? ramp.high : ramp.peak;
  const b = i === 0 ? ramp.low : i === 1 ? ramp.mid : i === 2 ? ramp.high : i === 3 ? ramp.peak : ramp.peak;
  out.r = a[0] + (b[0] - a[0]) * f;
  out.g = a[1] + (b[1] - a[1]) * f;
  out.b = a[2] + (b[2] - a[2]) * f;
}

export class Minimap {
  /** Composite texture: terrain, markers, blips and the camera quad. */
  readonly texture: THREE.Texture;
  /** Backing canvas when one exists — handy for a DOM overlay. */
  readonly canvas: HTMLCanvasElement | OffscreenCanvas | null;
  /** World metres covered by the whole texture. */
  readonly worldSize: number;
  /** Texture resolution per side. */
  readonly resolution: number;

  private readonly map: MapDef;
  private readonly terrain: HeightField;
  private readonly basePixels: Pixels;
  private readonly framePixels: Pixels;
  private readonly ramp: BiomeRamp;
  private readonly sun: THREE.Color;
  private readonly scratchColor = { r: 0, g: 0, b: 0 };
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly groundPlane = new THREE.Plane();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly hit = new THREE.Vector3();
  /** Flat `[x0,y0,x1,y1,...]` screen-space quad of the camera footprint. */
  private readonly cameraQuad = new Float32Array(8);
  private sinceUpload = UPLOAD_INTERVAL;
  private disposed = false;

  constructor(map: MapDef, _settings: QualitySettings, resolution = RESOLUTION) {
    this.map = map;
    this.terrain = heightField(map);
    this.resolution = Math.max(64, Math.min(resolution, map.size * 2));
    this.worldSize = map.size;
    this.ramp = BIOME_RAMP[map.biome] ?? DEFAULT_RAMP;
    this.basePixels = new Uint8ClampedArray(this.resolution * this.resolution * 4);
    this.framePixels = new Uint8ClampedArray(this.resolution * this.resolution * 4);
    this.sun = new THREE.Color(map.lighting.sun_color, THREE.SRGBColorSpace);

    this.bakeTerrain();
    this.drawStaticMarkers();
    this.framePixels.set(this.basePixels);

    this.canvas = makeCanvas(this.resolution, this.resolution);
    if (this.canvas !== null) {
      const ctx = this.canvas.getContext("2d") as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
      if (ctx !== null) {
        const texture = new THREE.CanvasTexture(this.canvas as HTMLCanvasElement);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        this.texture = texture;
        this.upload(ctx);
        return;
      }
    }
    const texture = new THREE.DataTexture(this.framePixels, this.resolution, this.resolution, THREE.RGBAFormat);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    this.texture = texture;
  }

  /** Bakes terrain colour, hill-shade, water and cliffs into the static layer. */
  private bakeTerrain(): void {
    const res = this.resolution;
    const px = this.basePixels;
    const scale = this.worldSize / res;
    const ll = Math.hypot(LIGHT_DIR[0], LIGHT_DIR[1], LIGHT_DIR[2]);
    const ramp = this.ramp;
    const sunR = 0.55 + 0.45 * this.sun.r;
    const sunG = 0.55 + 0.45 * this.sun.g;
    const sunB = 0.55 + 0.45 * this.sun.b;

    for (let j = 0; j < res; j++) {
      const z = (j + 0.5) * scale;
      for (let i = 0; i < res; i++) {
        const x = (i + 0.5) * scale;
        const h = this.terrain.sample(x, z);
        const p = (j * res + i) * 4;
        if (h <= 0) {
          // Water: darker with depth, with a bright shoreline band.
          const depth = Math.min(1, -h / 4);
          const shore = h > -0.35 ? 1 : 0;
          px[p] = 18 + (1 - depth) * 26 + shore * 70;
          px[p + 1] = 44 + (1 - depth) * 40 + shore * 60;
          px[p + 2] = 78 + (1 - depth) * 44 + shore * 30;
          px[p + 3] = 255;
          continue;
        }
        mixRamp(ramp, Math.min(1, h / 7), this.scratchColor);
        // Slope from central differences, then a lambert term for relief.
        const nx = this.terrain.sample(x - scale, z) - this.terrain.sample(x + scale, z);
        const nz = this.terrain.sample(x, z - scale) - this.terrain.sample(x, z + scale);
        const ny = 2 * scale;
        const nl = Math.hypot(nx, ny, nz) || 1;
        const lambert = Math.max(
          0.15,
          ((nx / nl) * LIGHT_DIR[0] + (ny / nl) * LIGHT_DIR[1] + (nz / nl) * LIGHT_DIR[2]) / ll,
        );
        const slope = 1 - ny / nl;
        let r = this.scratchColor.r;
        let g = this.scratchColor.g;
        let b = this.scratchColor.b;
        if (slope > 0.28) {
          // Steep faces expose rock regardless of altitude.
          const k = Math.min(1, (slope - 0.28) * 3.2);
          r += (ramp.rock[0] - r) * k;
          g += (ramp.rock[1] - g) * k;
          b += (ramp.rock[2] - b) * k;
        }
        const shade = 0.45 + 0.75 * lambert;
        px[p] = r * shade * sunR;
        px[p + 1] = g * shade * sunG;
        px[p + 2] = b * shade * sunB;
        px[p + 3] = 255;
      }
    }
  }

  /** Mineral fields, expansion candidates and start positions. */
  private drawStaticMarkers(): void {
    const res = this.resolution;
    const px = this.basePixels;
    const toPx = res / this.worldSize;
    for (const cluster of this.map.mineral_clusters) {
      const r = cluster.rich === true ? 230 : 150;
      const g = cluster.rich === true ? 200 : 235;
      const b = cluster.rich === true ? 70 : 130;
      const count = Math.max(1, Math.min(6, cluster.count));
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + cluster.x;
        const spread = 1.4 + i * 0.9;
        fillDisc(
          px, res,
          (cluster.x + Math.cos(a) * spread) * toPx,
          (cluster.z + Math.sin(a) * spread) * toPx,
          1.5, r, g, b, 0.85,
        );
      }
    }
    for (const spot of this.map.expansion_candidates) {
      strokeDisc(px, res, spot.x * toPx, spot.z * toPx, 3.5, 200, 210, 230, 0.3);
    }
    for (const start of this.map.start_positions) {
      strokeDisc(px, res, start.x * toPx, start.z * toPx, 3, 235, 235, 235, 0.55);
      fillDisc(px, res, start.x * toPx, start.z * toPx, 1.4, 235, 235, 235, 0.5);
    }
  }

  private upload(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): void {
    const image = ctx.createImageData(this.resolution, this.resolution);
    image.data.set(this.framePixels);
    ctx.putImageData(image, 0, 0);
  }

  /**
   * Explicit camera footprint, for callers without a `THREE.Camera` (headless
   * tests, or a minimap pinned to a unit instead of the viewport).
   */
  setCamera(x: number, z: number, yaw: number, fovRadians: number, distance: number): void {
    const toPx = this.resolution / this.worldSize;
    const forward = Math.tan(fovRadians * 0.5) * Math.max(4, distance);
    const side = forward * 1.4;
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    const fx = s * forward;
    const fz = c * forward;
    const rx = c * side;
    const rz = -s * side;
    const cx = x * toPx;
    const cy = z * toPx;
    this.cameraQuad[0] = cx + fx - rx;
    this.cameraQuad[1] = cy + fz - rz;
    this.cameraQuad[2] = cx + fx + rx;
    this.cameraQuad[3] = cy + fz + rz;
    this.cameraQuad[4] = cx - fx + rx;
    this.cameraQuad[5] = cy - fz + rz;
    this.cameraQuad[6] = cx - fx - rx;
    this.cameraQuad[7] = cy - fz - rz;
    this.sinceUpload = UPLOAD_INTERVAL;
  }

  /** Redraws blips, selection and the camera quad, then re-uploads. */
  update(
    entities: readonly EntityView[],
    selection: ReadonlySet<number>,
    camera: THREE.Camera | null,
    deltaSeconds: number,
  ): void {
    if (this.disposed) return;
    this.sinceUpload += Math.max(deltaSeconds, 0);
    if (this.sinceUpload < UPLOAD_INTERVAL) return;
    this.sinceUpload = 0;

    const px = this.framePixels;
    px.set(this.basePixels);
    const res = this.resolution;
    const toPx = res / this.worldSize;

    for (let i = 0; i < entities.length; i++) {
      const view = entities[i];
      if (!view.visible) continue;
      if (view.kind === "building" && view.hp <= 0) continue;
      const cx = view.group.position.x * toPx;
      const cy = view.group.position.z * toPx;
      const color = BLIP_COLOR[view.relation];
      const radius = Math.min(
        BLIP_MAX,
        Math.max(BLIP_MIN, view.radius * 2.1 + (view.kind === "building" ? 1.4 : 0)),
      );
      fillDisc(px, res, cx, cy, radius, color[0], color[1], color[2], 0.95);
      if (selection.has(view.id)) {
        strokeDisc(px, res, cx, cy, radius + 1.6, 255, 255, 255, 0.9);
      }
    }

    if (camera !== null) this.projectFrustum(camera);
    this.drawCameraQuad(px);
    this.flush();
  }

  /** Intersects the four view-frustum corners with the camera's ground plane. */
  private projectFrustum(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    const origin = this.hit.setFromMatrixPosition(camera.matrixWorld);
    const groundY = this.terrain.sample(origin.x, origin.z) + 0.5;
    this.groundPlane.set(this.up, -groundY);
    const toPx = this.resolution / this.worldSize;
    for (let corner = 0; corner < 4; corner++) {
      this.ndc.set(corner === 1 || corner === 2 ? 1 : -1, corner >= 2 ? 1 : -1);
      this.raycaster.setFromCamera(this.ndc, camera);
      this.raycaster.ray.intersectPlane(this.groundPlane, this.hit);
      this.cameraQuad[corner * 2] = this.hit.x * toPx;
      this.cameraQuad[corner * 2 + 1] = this.hit.z * toPx;
    }
  }

  private drawCameraQuad(px: Pixels): void {
    const q = this.cameraQuad;
    for (let i = 0; i < 4; i++) {
      const a = i * 2;
      const b = ((i + 1) % 4) * 2;
      strokeSegment(px, this.resolution, q[a], q[a + 1], q[b], q[b + 1], 255, 255, 255, 0.85);
    }
  }

  private flush(): void {
    if (this.canvas !== null) {
      const ctx = this.canvas.getContext("2d") as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
      if (ctx !== null) {
        this.upload(ctx);
        this.texture.needsUpdate = true;
        return;
      }
    }
    this.texture.needsUpdate = true;
  }

  /**
   * Converts a client-space point over the minimap rect into world ground
   * coordinates. Returns false when the point lies outside the rect.
   */
  hitTest(
    clientX: number,
    clientY: number,
    rect: { left: number; top: number; width: number; height: number },
    out: { x: number; z: number },
  ): boolean {
    if (rect.width <= 0 || rect.height <= 0) return false;
    const u = (clientX - rect.left) / rect.width;
    const v = (clientY - rect.top) / rect.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) return false;
    out.x = u * this.worldSize;
    out.z = v * this.worldSize;
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.texture.dispose();
  }
}
