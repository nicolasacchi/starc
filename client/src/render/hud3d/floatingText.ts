/**
 * Floating combat text: damage numbers and callouts.
 *
 * ASSETS: 100% procedural. The glyphs come from a 5x7 bitmap font written out
 * in this file — no font file, no webfont, no network. At startup the glyph
 * masks are rasterised into a 128x64 atlas and uploaded either through a
 * runtime canvas (`OffscreenCanvas`/`HTMLCanvasElement` + `putImageData`) or,
 * when no DOM exists, straight into a `DataTexture` from the same pixels.
 * Both paths produce an identical atlas, so headless tests behave the same.
 *
 * Every live string is drawn as a run of instanced quads from a fixed pool:
 * one `InstancedMesh`, per-instance UV rect, colour and alpha. Nothing is
 * allocated per frame — the pool, the attribute arrays and the billboard math
 * are all preallocated.
 */
import * as THREE from "three";

import type { QualitySettings } from "@render/core/quality";

const GLYPH_W = 5;
const GLYPH_H = 7;
const CELL = 8;
const ATLAS_COLS = 16;
const ATLAS_ROWS = 8;
const ATLAS_W = ATLAS_COLS * CELL;
const ATLAS_H = ATLAS_ROWS * CELL;
/** First code point in the atlas; ASCII order. */
const FIRST_CHAR = 32;
const LAST_CHAR = 126;
const ADVANCE = 0.82;

/**
 * 5x7 bitmap font, rows top to bottom, `#` = lit pixel. Covers ASCII 32..126;
 * anything outside falls back to a filled box so a callout is never blank.
 */
const GLYPHS: Record<string, string> = {
  " ": ".....|.....|.....|.....|.....|.....|.....",
  "!": "..#..|..#..|..#..|..#..|..#..|.....|..#..",
  '"': ".#.#.|.#.#.|.....|.....|.....|.....|.....",
  "#": ".#.#.|.#.#.|#####|.#.#.|#####|.#.#.|.#.#.",
  "$": "..#..|.####|#.#..|.###.|..#.#|####.|..#..",
  "%": "##...|##..#|...#.|..#..|.#...|#..##|...##",
  "&": ".##..|#..#.|#.#..|.#...|#.#.#|#..#.|.##.#",
  "'": "..#..|..#..|.....|.....|.....|.....|.....",
  "(": "...#.|..#..|.#...|.#...|.#...|..#..|...#.",
  ")": ".#...|..#..|...#.|...#.|...#.|..#..|.#...",
  "*": ".....|#.#.#|.###.|#####|.###.|#.#.#|.....",
  "+": ".....|..#..|..#..|#####|..#..|..#..|.....",
  ",": ".....|.....|.....|.....|..##.|..#..|.#...",
  "-": ".....|.....|.....|#####|.....|.....|.....",
  ".": ".....|.....|.....|.....|.....|.##..|.##..",
  "/": "....#|...#.|...#.|..#..|.#...|.#...|#....",
  "0": ".###.|#...#|#..##|#.#.#|##..#|#...#|.###.",
  "1": "..#..|.##..|..#..|..#..|..#..|..#..|.###.",
  "2": ".###.|#...#|....#|...#.|..#..|.#...|#####",
  "3": "#####|...#.|..##.|....#|....#|#...#|.###.",
  "4": "...#.|..##.|.#.#.|#..#.|#####|...#.|...#.",
  "5": "#####|#....|####.|....#|....#|#...#|.###.",
  "6": ".###.|#...#|#....|####.|#...#|#...#|.###.",
  "7": "#####|....#|...#.|..#..|.#...|.#...|.#...",
  "8": ".###.|#...#|#...#|.###.|#...#|#...#|.###.",
  "9": ".###.|#...#|#...#|.####|....#|#...#|.###.",
  ":": ".....|.##..|.##..|.....|.##..|.##..|.....",
  ";": ".....|.##..|.##..|.....|.##..|..#..|.#...",
  "<": "...#.|..#..|.#...|#....|.#...|..#..|...#.",
  "=": ".....|.....|#####|.....|#####|.....|.....",
  ">": ".#...|..#..|...#.|....#|...#.|..#..|.#...",
  "?": ".###.|#...#|....#|...#.|..#..|.....|..#..",
  "@": ".###.|#...#|....#|#.###|#.#.#|#.###|.###.",
  "A": ".###.|#...#|#...#|#####|#...#|#...#|#...#",
  "B": "####.|#...#|#...#|####.|#...#|#...#|####.",
  "C": ".###.|#...#|#....|#....|#....|#...#|.###.",
  "D": "###..|#..#.|#...#|#...#|#...#|#..#.|###..",
  "E": "#####|#....|#....|####.|#....|#....|#####",
  "F": "#####|#....|#....|####.|#....|#....|#....",
  "G": ".###.|#...#|#....|#.###|#...#|#...#|.####",
  "H": "#...#|#...#|#...#|#####|#...#|#...#|#...#",
  "I": ".###.|..#..|..#..|..#..|..#..|..#..|.###.",
  "J": "..###|...#.|...#.|...#.|...#.|#..#.|.##..",
  "K": "#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#",
  "L": "#....|#....|#....|#....|#....|#....|#####",
  "M": "#...#|##.##|#.#.#|#...#|#...#|#...#|#...#",
  "N": "#...#|##..#|#.#.#|#..##|#...#|#...#|#...#",
  "O": ".###.|#...#|#...#|#...#|#...#|#...#|.###.",
  "P": "####.|#...#|#...#|####.|#....|#....|#....",
  "Q": ".###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#",
  "R": "####.|#...#|#...#|####.|#.#..|#..#.|#...#",
  "S": ".####|#....|#....|.###.|....#|....#|####.",
  "T": "#####|..#..|..#..|..#..|..#..|..#..|..#..",
  "U": "#...#|#...#|#...#|#...#|#...#|#...#|.###.",
  "V": "#...#|#...#|#...#|#...#|#...#|.#.#.|..#..",
  "W": "#...#|#...#|#...#|#...#|#.#.#|##.##|#...#",
  "X": "#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#",
  "Y": "#...#|#...#|.#.#.|..#..|..#..|..#..|..#..",
  "Z": "#####|....#|...#.|..#..|.#...|#....|#####",
  "[": ".###.|.#...|.#...|.#...|.#...|.#...|.###.",
  "\\": "#....|#....|.#...|..#..|...#.|...#.|....#",
  "]": ".###.|...#.|...#.|...#.|...#.|...#.|.###.",
  "^": "..#..|.#.#.|#...#|.....|.....|.....|.....",
  "_": ".....|.....|.....|.....|.....|.....|#####",
  "`": ".#...|..#..|.....|.....|.....|.....|.....",
  "a": ".....|.....|.###.|....#|.####|#...#|.####",
  "b": "#....|#....|####.|#...#|#...#|#...#|####.",
  "c": ".....|.....|.###.|#....|#....|#...#|.###.",
  "d": "....#|....#|.####|#...#|#...#|#...#|.####",
  "e": ".....|.....|.###.|#...#|#####|#....|.###.",
  "f": "..##.|.#..#|.####|.#...|.#...|.#...|.#...",
  "g": ".....|.####|#...#|#...#|.####|....#|.###.",
  "h": "#....|#....|####.|#...#|#...#|#...#|#...#",
  "i": "..#..|.....|.##..|..#..|..#..|..#..|.###.",
  "j": "...#.|.....|..##.|...#.|...#.|#..#.|.##..",
  "k": "#....|#....|#..#.|#.#..|##...|#.#..|#..#.",
  "l": ".##..|..#..|..#..|..#..|..#..|..#..|.###.",
  "m": ".....|.....|##.#.|#.#.#|#.#.#|#...#|#...#",
  "n": ".....|.....|####.|#...#|#...#|#...#|#...#",
  "o": ".....|.....|.###.|#...#|#...#|#...#|.###.",
  "p": ".....|####.|#...#|#...#|####.|#....|#....",
  "q": ".....|.####|#...#|#...#|.####|....#|....#",
  "r": ".....|.....|#.##.|##..#|#....|#....|#....",
  "s": ".....|.....|.####|#....|.###.|....#|####.",
  "t": ".#...|.#...|####.|.#...|.#...|.#..#|..##.",
  "u": ".....|.....|#...#|#...#|#...#|#..##|.##.#",
  "v": ".....|.....|#...#|#...#|#...#|.#.#.|..#..",
  "w": ".....|.....|#...#|#...#|#.#.#|#.#.#|.#.#.",
  "x": ".....|.....|#...#|.#.#.|..#..|.#.#.|#...#",
  "y": ".....|#...#|#...#|#...#|.####|....#|.###.",
  "z": ".....|.....|#####|...#.|..#..|.#...|#####",
  "{": "...##|..#..|..#..|.#...|..#..|..#..|...##",
  "|": "..#..|..#..|..#..|..#..|..#..|..#..|..#..",
  "}": "##...|..#..|..#..|...#.|..#..|..#..|##...",
  "~": ".....|.....|.#...|#.#.#|...#.|.....|.....",
};

/** Fallback box for anything outside the covered range. */
const MISSING = "#####|#...#|#...#|#...#|#...#|#...#|#####";

const TEXT_VERT = /* glsl */ `
attribute vec4 aUv;
attribute float aAlpha;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vUv = aUv.xy + uv * aUv.zw;
  vColor = instanceColor;
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const TEXT_FRAG = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 tex = texture2D(uAtlas, vUv);
  if (tex.a < 0.02) discard;
  // Red channel separates the glyph core (1.0) from its dark outline (0.3).
  float core = step(0.6, tex.r);
  vec3 rgb = mix(vec3(0.02, 0.02, 0.03), vColor, core);
  gl_FragColor = vec4(rgb, tex.a * vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export type CalloutTone = "info" | "warn" | "error";

export interface FloatingTextOptions {
  /** World height of one character cell. */
  size?: number;
  lifeSeconds?: number;
  color?: number;
  /** Vertical rise over the whole lifetime, metres. */
  rise?: number;
}

interface TextEntry {
  text: string;
  x: number;
  y: number;
  z: number;
  age: number;
  life: number;
  size: number;
  rise: number;
  r: number;
  g: number;
  b: number;
  active: boolean;
}

const TONE_COLOR: Record<CalloutTone, number> = {
  info: 0x9fe8ff,
  warn: 0xffd24a,
  error: 0xff6a5a,
};

/** Damage text colour by magnitude; crits are gold and larger. */
function damageColor(amount: number, crit: boolean): number {
  if (crit) return 0xffd447;
  if (amount >= 40) return 0xff8a3c;
  if (amount >= 18) return 0xffe9a8;
  return 0xffffff;
}

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

/**
 * Rasterises the bitmap font into an atlas. Returns the pixels too, so the
 * headless `DataTexture` path uploads exactly the same image.
 */
function buildAtlasPixels(): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(ATLAS_W * ATLAS_H * 4);
  // One scratch cell, reused for every glyph.
  const cell = new Uint8Array(CELL * CELL);

  for (let code = FIRST_CHAR; code <= LAST_CHAR; code++) {
    const char = String.fromCharCode(code);
    const rows = (GLYPHS[char] ?? MISSING).split("|");
    cell.fill(0);
    for (let y = 0; y < GLYPH_H; y++) {
      const row = rows[y] ?? ".....";
      for (let x = 0; x < GLYPH_W; x++) {
        if (row.charCodeAt(x) === 35 /* '#' */) cell[y * CELL + x] = 1;
      }
    }
    // Outline pass: any empty cell touching a lit one becomes the dark rim.
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        if (cell[y * CELL + x] === 1) continue;
        let touching = false;
        for (let dy = -1; dy <= 1 && !touching; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= GLYPH_W || ny >= GLYPH_H) continue;
            if (cell[ny * CELL + nx] === 1) {
              touching = true;
              break;
            }
          }
        }
        if (touching) cell[y * CELL + x] = 2;
      }
    }

    const col = code - FIRST_CHAR;
    const ox = (col % ATLAS_COLS) * CELL;
    const oy = Math.floor(col / ATLAS_COLS) * CELL;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const v = cell[y * CELL + x];
        if (v === 0) continue;
        const p = ((oy + y) * ATLAS_W + (ox + x)) * 4;
        pixels[p] = v === 1 ? 255 : 90;
        pixels[p + 1] = 255;
        pixels[p + 2] = 255;
        pixels[p + 3] = 255;
      }
    }
  }
  return pixels;
}

function buildAtlasTexture(): THREE.Texture {
  const pixels = buildAtlasPixels();
  const canvas = makeCanvas(ATLAS_W, ATLAS_H);
  if (canvas !== null) {
    const ctx = canvas.getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (ctx !== null) {
      const image = ctx.createImageData(ATLAS_W, ATLAS_H);
      image.data.set(pixels);
      ctx.putImageData(image, 0, 0);
      const texture = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
      texture.flipY = false;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
      return texture;
    }
  }
  const data = new THREE.DataTexture(pixels, ATLAS_W, ATLAS_H, THREE.RGBAFormat);
  data.flipY = false;
  data.minFilter = THREE.LinearMipmapLinearFilter;
  data.magFilter = THREE.LinearFilter;
  data.generateMipmaps = true;
  data.needsUpdate = true;
  return data;
}

export class FloatingText {
  /** Root added to the scene. */
  readonly group = new THREE.Group();

  private readonly atlas: THREE.Texture;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.InstancedMesh;
  private readonly matrixData: Float32Array;
  private readonly uvData: Float32Array;
  private readonly alphaData: Float32Array;
  private readonly colorData: Float32Array;
  private readonly uvAttribute: THREE.InstancedBufferAttribute;
  private readonly alphaAttribute: THREE.InstancedBufferAttribute;
  private readonly colorAttribute: THREE.InstancedBufferAttribute;
  private readonly colorScratch = new THREE.Color();

  private readonly pool: TextEntry[];
  private readonly free: number[];
  private disposed = false;

  /**
   * `capacity` counts *character quads*, not strings: one callout of 20
   * characters consumes 20 slots.
   */
  constructor(settings: QualitySettings, capacity = 512) {
    this.atlas = buildAtlasTexture();
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.uvData = new Float32Array(capacity * 4);
    this.alphaData = new Float32Array(capacity);
    this.uvAttribute = new THREE.InstancedBufferAttribute(this.uvData, 4);
    this.uvAttribute.setUsage(THREE.DynamicDrawUsage);
    this.alphaAttribute = new THREE.InstancedBufferAttribute(this.alphaData, 1);
    this.alphaAttribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("aUv", this.uvAttribute);
    this.geometry.setAttribute("aAlpha", this.alphaAttribute);

    this.material = new THREE.ShaderMaterial({
      vertexShader: TEXT_VERT,
      fragmentShader: TEXT_FRAG,
      uniforms: { uAtlas: { value: this.atlas } },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    this.matrixData = this.mesh.instanceMatrix.array as Float32Array;
    this.colorData = new Float32Array(capacity * 3);
    this.colorAttribute = new THREE.InstancedBufferAttribute(this.colorData, 3);
    this.colorAttribute.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = this.colorAttribute;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 60;
    this.group.add(this.mesh);

    this.pool = [];
    this.free = [];
    // Half the budget on low presets: damage numbers are the least critical
    // information on screen, so they are the first thing to be trimmed.
    const entries = Math.floor(settings.postFx ? capacity / 8 : capacity / 12);
    for (let i = 0; i < entries; i++) {
      this.pool.push({
        text: "", x: 0, y: 0, z: 0, age: 0, life: 1, size: 0.6, rise: 1.4,
        r: 1, g: 1, b: 1, active: false,
      });
      this.free.push(i);
    }
  }

  /** Number of live strings, for tests and the debug overlay. */
  get activeCount(): number {
    return this.pool.length - this.free.length;
  }

  /** Damage number. Crits are larger and gold. */
  spawnDamage(amount: number, x: number, y: number, z: number, crit: boolean): void {
    const text = String(Math.max(0, Math.round(amount)));
    this.push(text, x, y, z, {
      size: crit ? 1.15 : amount >= 40 ? 0.85 : 0.62,
      lifeSeconds: crit ? 1.25 : 0.95,
      color: damageColor(amount, crit),
      rise: crit ? 2.2 : 1.5,
    });
  }

  /** Callout such as "UNDER ATTACK" or "NOT ENOUGH MINERALS". */
  spawnCallout(text: string, x: number, y: number, z: number, tone: CalloutTone = "info"): void {
    this.push(text, x, y, z, {
      size: 0.75,
      lifeSeconds: 2.4,
      color: TONE_COLOR[tone],
      rise: 2.6,
    });
  }

  private push(text: string, x: number, y: number, z: number, options: FloatingTextOptions): void {
    if (this.disposed || this.free.length === 0) return;
    const index = this.free.pop();
    if (index === undefined) return;
    const entry = this.pool[index];
    entry.text = text.toUpperCase();
    entry.x = x;
    entry.y = y;
    entry.z = z;
    entry.age = 0;
    entry.life = options.lifeSeconds ?? 1.2;
    entry.size = options.size ?? 0.7;
    entry.rise = options.rise ?? 1.5;
    this.colorScratch.set(options.color ?? 0xffffff, THREE.SRGBColorSpace);
    entry.r = this.colorScratch.r;
    entry.g = this.colorScratch.g;
    entry.b = this.colorScratch.b;
    entry.active = true;
  }

  /** Advances every live string and rebuilds the instance buffers. */
  update(camera: THREE.Camera, deltaSeconds: number): void {
    if (this.disposed) return;
    const dt = Math.min(Math.max(deltaSeconds, 0), 0.25);

    camera.updateMatrixWorld();
    const m = camera.matrixWorld.elements;
    const rx = m[0];
    const ry = m[1];
    const rz = m[2];
    const ux = m[4];
    const uy = m[5];
    const uz = m[6];
    const camX = m[12];
    const camY = m[13];
    const camZ = m[14];

    let n = 0;
    const cap = this.alphaData.length;

    for (let i = 0; i < this.pool.length; i++) {
      const entry = this.pool[i];
      if (!entry.active) continue;
      entry.age += dt;
      if (entry.age >= entry.life) {
        entry.active = false;
        this.free.push(i);
        continue;
      }
      const t = entry.age / entry.life;
      // Rise, ease out; drift gently toward the viewer so the number is never
      // buried behind the unit it belongs to.
      const rise = entry.rise * (1 - (1 - t) * (1 - t));
      const drift = Math.min(t * 6, 1) * 0.5;
      const dx = camX - entry.x;
      const dy = camY - entry.y;
      const dz = camZ - entry.z;
      const dl = Math.hypot(dx, dy, dz) || 1;
      const px = entry.x + (dx / dl) * drift;
      const py = entry.y + rise + (dy / dl) * drift;
      const pz = entry.z + (dz / dl) * drift;
      // Pop in fast, fade out slow.
      const alpha = Math.min(1, t * 8) * (1 - t * t);

      const len = entry.text.length;
      const cellSize = entry.size * (0.85 + 0.35 * (1 - t));
      const totalWidth = cellSize * ADVANCE * (len - 1);
      for (let c = 0; c < len && n < cap; c++) {
        const code = entry.text.charCodeAt(c) - FIRST_CHAR;
        const col = ((code >= 0 ? code : 0) % ATLAS_COLS);
        const row = Math.floor((code >= 0 ? code : 0) / ATLAS_COLS);
        const u0 = (col * CELL) / ATLAS_W;
        const v0 = (row * CELL) / ATLAS_H;
        const o4 = n * 4;
        this.uvData[o4] = u0;
        this.uvData[o4 + 1] = v0;
        this.uvData[o4 + 2] = CELL / ATLAS_W;
        this.uvData[o4 + 3] = CELL / ATLAS_H;
        this.alphaData[n] = alpha;
        const c3 = n * 3;
        this.colorData[c3] = entry.r;
        this.colorData[c3 + 1] = entry.g;
        this.colorData[c3 + 2] = entry.b;

        // Centre the run, then step along the camera right axis.
        const offset = -totalWidth * 0.5 + c * cellSize * ADVANCE;
        const ox = px + rx * offset;
        const oy = py + ry * offset;
        const oz = pz + rz * offset;
        const o = n * 16;
        this.matrixData[o] = rx * cellSize;
        this.matrixData[o + 1] = ry * cellSize;
        this.matrixData[o + 2] = rz * cellSize;
        this.matrixData[o + 3] = 0;
        this.matrixData[o + 4] = ux * cellSize;
        this.matrixData[o + 5] = uy * cellSize;
        this.matrixData[o + 6] = uz * cellSize;
        this.matrixData[o + 7] = 0;
        this.matrixData[o + 8] = 0;
        this.matrixData[o + 9] = 0;
        this.matrixData[o + 10] = 1;
        this.matrixData[o + 11] = 0;
        this.matrixData[o + 12] = ox;
        this.matrixData[o + 13] = oy;
        this.matrixData[o + 14] = oz;
        this.matrixData[o + 15] = 1;
        n++;
      }
    }

    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.colorAttribute.needsUpdate = true;
      this.uvAttribute.needsUpdate = true;
      this.alphaAttribute.needsUpdate = true;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.atlas.dispose();
    this.mesh.instanceColor = null;
    this.pool.length = 0;
    this.free.length = 0;
    this.group.removeFromParent();
  }
}
