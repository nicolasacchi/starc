/**
 * Instanced 3D health bars.
 *
 * ASSETS: 100% procedural. One unit quad is built from `THREE.PlaneGeometry`;
 * every material is a runtime `ShaderMaterial` with inline GLSL. No image,
 * font or model file is loaded or imported — the module works offline.
 *
 * Four instanced layers are drawn per bar, back to front:
 *   0 background  – dark plate so the bar reads against bright terrain
 *   1 trail ghost – a lighter bar that lags the real value, so the size of the
 *                   last hit stays visible while the ghost drains
 *   2 hp fill     – green → amber → red as the fraction drops
 *   3 shield      – blue segment stacked to the right of the HP fill
 *
 * Bars fade in when an entity is hurt and fade out ~2 s after the last damage,
 * so a clean screen stays clean. Everything is written straight into the
 * instance attribute arrays: nothing is allocated per frame, per bar.
 */
import * as THREE from "three";

import type { EntityView } from "@render/entities/entityView";
import type { QualitySettings } from "@render/core/quality";

/** Seconds a bar stays fully lit after the last damage event. */
const HOLD_SECONDS = 2.0;
/** How fast the trail ghost drains, in HP-fraction per second. */
const TRAIL_RATE = 0.55;
const FADE_IN_RATE = 7.0;
const FADE_OUT_RATE = 2.4;
/** Layer indices; also the draw order. */
const LAYER_BG = 0;
const LAYER_TRAIL = 1;
const LAYER_HP = 2;
const LAYER_SHIELD = 3;
const LAYER_COUNT = 4;

const BAR_VERT = /* glsl */ `
attribute float aAlpha;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vUv = uv;
  vColor = instanceColor;
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const BAR_FRAG = /* glsl */ `
uniform float uPlate;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  if (vAlpha <= 0.002) discard;
  vec3 rgb = vColor;
  float alpha = vAlpha;
  if (uPlate > 0.5) {
    vec2 d = abs(vUv - 0.5) * 2.0;
    float edge = max(d.x, d.y);
    if (edge > 1.0) discard;
    float rim = smoothstep(0.72, 0.94, edge);
    rgb = mix(rgb, rgb * 2.4 + 0.05, rim);
  } else {
    // Slight vertical falloff so fills do not read as flat stickers.
    alpha *= 0.8 + 0.2 * smoothstep(0.0, 0.6, vUv.y);
  }
  gl_FragColor = vec4(rgb, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** One instanced quad layer plus the CPU-side arrays it is fed from. */
interface BarLayer {
  mesh: THREE.InstancedMesh;
  geometry: THREE.PlaneGeometry;
  material: THREE.ShaderMaterial;
  alphaAttribute: THREE.InstancedBufferAttribute;
  alphaData: Float32Array;
  colorAttribute: THREE.InstancedBufferAttribute;
  colorData: Float32Array;
}

/** Per-entity animation memory for the fade + trail. */
interface BarState {
  /** Frame stamp of the last update in which this bar was fed. */
  stamp: number;
  hp: number;
  shield: number;
  /** Lagging copy of the hp fraction; always >= the real one. */
  trail: number;
  shieldTrail: number;
  alpha: number;
  sinceDamage: number;
}

function hpColor(fraction: number, out: THREE.Color): void {
  const f = Math.max(0, Math.min(1, fraction));
  // Red at zero, amber around half, green at full — continuous, so the bar
  // never jumps colour as a hit lands.
  const green = f <= 0.5 ? f * 1.6 : (f - 0.5) * 2;
  out.setRGB(1, green, 0.08, THREE.SRGBColorSpace);
}

function makeLayer(capacity: number, plate: boolean): BarLayer {
  const geometry = new THREE.PlaneGeometry(1, 1);

  const alphaData = new Float32Array(capacity);
  const alphaAttribute = new THREE.InstancedBufferAttribute(alphaData, 1);
  alphaAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("aAlpha", alphaAttribute);

  const material = new THREE.ShaderMaterial({
    vertexShader: BAR_VERT,
    fragmentShader: BAR_FRAG,
    uniforms: { uPlate: { value: plate ? 1 : 0 } },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  const colorData = new Float32Array(capacity * 3);
  const colorAttribute = new THREE.InstancedBufferAttribute(colorData, 3);
  colorAttribute.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = colorAttribute;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.renderOrder = plate ? 40 : 41;

  return { mesh, geometry, material, alphaAttribute, alphaData, colorAttribute, colorData };
}

export class HealthBars {
  /** Root added to the scene; every layer lives under it. */
  readonly group = new THREE.Group();

  private readonly capacity: number;
  private readonly layers: BarLayer[] = [];
  private readonly states = new Map<number, BarState>();
  private stamp = 0;
  private readonly colorScratch = new THREE.Color();
  private readonly maxDistance: number;
  private disposed = false;

  constructor(settings: QualitySettings, capacity = 768) {
    this.capacity = capacity;
    // A tight view distance on weak hardware is free visually: at low zoom the
    // camera only sees a small slice of the world anyway.
    this.maxDistance = settings.postFx ? 150 : 120;
    this.group.name = "health-bars";
    this.group.matrixAutoUpdate = false;
    for (let i = 0; i < LAYER_COUNT; i++) {
      const layer = makeLayer(capacity, i === LAYER_BG);
      this.layers.push(layer);
      this.group.add(layer.mesh);
    }
  }

  /** Marks a bar as freshly damaged so the next {@link update} lights it up. */
  notifyDamage(id: number): void {
    const state = this.states.get(id);
    if (state !== undefined) state.sinceDamage = 0;
  }

  /**
   * Rebuilds every bar for this frame. `views` is read in place — the caller
   * owns the array and may reuse it across frames.
   */
  update(camera: THREE.Camera, views: readonly EntityView[], deltaSeconds: number): void {
    if (this.disposed) return;
    const dt = Math.min(Math.max(deltaSeconds, 0), 0.25);
    this.stamp++;
    const stamp = this.stamp;

    camera.updateMatrixWorld();
    const m = camera.matrixWorld.elements;
    const rx = m[0];
    const ry = m[1];
    const rz = m[2];
    const ux = m[4];
    const uy = m[5];
    const uz = m[6];
    // Third basis column points out of the screen toward the viewer.
    const fx = m[8];
    const fy = m[9];
    const fz = m[10];
    const camX = m[12];
    const camY = m[13];
    const camZ = m[14];
    const maxD2 = this.maxDistance * this.maxDistance;

    const bg = this.layers[LAYER_BG];
    const trail = this.layers[LAYER_TRAIL];
    const hp = this.layers[LAYER_HP];
    const shield = this.layers[LAYER_SHIELD];
    const bgM = bg.mesh.instanceMatrix.array as Float32Array;
    const trailM = trail.mesh.instanceMatrix.array as Float32Array;
    const hpM = hp.mesh.instanceMatrix.array as Float32Array;
    const shieldM = shield.mesh.instanceMatrix.array as Float32Array;
    const bgA = bg.alphaData;
    const trailA = trail.alphaData;
    const hpA = hp.alphaData;
    const shieldA = shield.alphaData;
    const bgC = bg.colorData;
    const trailC = trail.colorData;
    const hpC = hp.colorData;
    const shieldC = shield.colorData;

    let n = 0;
    let trailN = 0;
    let hpN = 0;
    let shieldN = 0;

    for (let i = 0; i < views.length && n < this.capacity; i++) {
      const view = views[i];
      if (!view.visible || !view.hudAnchor.visible) continue;
      if (view.hpMax <= 0) continue;

      const px = view.group.position.x;
      const py = view.group.position.y;
      const pz = view.group.position.z;
      const ddx = px - camX;
      const ddy = py - camY;
      const ddz = pz - camZ;
      if (ddx * ddx + ddy * ddy + ddz * ddz > maxD2) continue;

      const rawHp = view.hp / view.hpMax;
      const hasShield = view.shieldMax > 0;
      const rawShield = hasShield ? view.shield / view.shieldMax : 0;
      const hurt = rawHp < 0.999 || rawShield < 0.999;

      let state = this.states.get(view.id);
      if (state === undefined) {
        state = {
          stamp,
          hp: rawHp,
          shield: rawShield,
          trail: rawHp,
          shieldTrail: rawShield,
          alpha: 0,
          sinceDamage: HOLD_SECONDS,
        };
        this.states.set(view.id, state);
      }
      state.stamp = stamp;

      if (rawHp < state.hp - 0.0005) state.sinceDamage = 0;
      else state.sinceDamage += dt;
      // Light smoothing so 10 Hz snapshots do not make the bar twitch; the
      // trail still lags the smoothed value, which is what the eye reads.
      const ease = Math.min(1, dt * 22);
      state.hp += (rawHp - state.hp) * ease;
      state.shield += (rawShield - state.shield) * ease;
      if (state.hp < state.trail) state.trail = Math.max(state.hp, state.trail - TRAIL_RATE * dt);
      else state.trail = state.hp;
      if (state.shield < state.shieldTrail) {
        state.shieldTrail = Math.max(state.shield, state.shieldTrail - TRAIL_RATE * dt);
      } else {
        state.shieldTrail = state.shield;
      }

      const wantVisible = hurt || state.sinceDamage < HOLD_SECONDS || view.selected;
      state.alpha += ((wantVisible ? 1 : 0) - state.alpha) * Math.min(1, (wantVisible ? FADE_IN_RATE : FADE_OUT_RATE) * dt);
      if (state.alpha < 0.004) {
        state.alpha = 0;
        if (!hurt) continue;
      }
      if (state.alpha === 0) continue;

      const w = Math.min(Math.max(view.radius * 2.6, 1.1), 4.5);
      const h = w * 0.13;
      const ax = px;
      const ay = py + view.hudAnchor.position.y;
      const az = pz;
      const f = state.hp;
      const alpha = state.alpha;

      // 0 — plate, full width.
      writeBarMatrix(bgM, n, rx, ry, rz, ux, uy, uz, fx, fy, fz, ax, ay, az, 0, w, h, 0);
      writeBarColor(bgC, n, 0.02, 0.03, 0.04);
      bgA[n] = 0.66 * alpha;

      // 1 — trail ghost, lagging to the left of the fill.
      if (state.trail > f + 0.002) {
        writeBarMatrix(trailM, trailN, rx, ry, rz, ux, uy, uz, fx, fy, fz, ax, ay, az, 0, w * state.trail, h * 0.6, 1);
        writeBarColor(trailC, trailN, 1, 0.93, 0.86);
        trailA[trailN] = 0.42 * alpha;
        trailN++;
      }

      // 2 — hp fill, left aligned inside the plate.
      if (f > 0.002) {
        writeBarMatrix(hpM, hpN, rx, ry, rz, ux, uy, uz, fx, fy, fz, ax, ay, az, w * (f - 1) * 0.5, w * f, h * 0.72, 2);
        hpColor(f, this.colorScratch);
        writeBarColor(hpC, hpN, this.colorScratch.r, this.colorScratch.g, this.colorScratch.b);
        hpA[hpN] = alpha;
        hpN++;
      }

      // 3 — shield, immediately to the right of the fill.
      if (hasShield && state.shield > 0.002) {
        const sw = w * Math.max(state.shield, state.shieldTrail);
        const shift = w * ((1 - f) - state.shield) * 0.5;
        writeBarMatrix(shieldM, shieldN, rx, ry, rz, ux, uy, uz, fx, fy, fz, ax, ay, az, shift, sw, h * 0.72, 3);
        writeBarColor(shieldC, shieldN, 0.28, 0.6, 1);
        shieldA[shieldN] = 0.85 * alpha;
        shieldN++;
      }
      n++;
    }

    commit(bg, n);
    commit(trail, trailN);
    commit(hp, hpN);
    commit(shield, shieldN);
    // Retire the memory of bars that were not fed this frame — the entity is
    // gone, or it is far outside the draw distance and will re-initialise when
    // it comes back. Swept in batches so the map does not grow forever.
    if ((this.stamp & 63) === 0) {
      for (const [id, state] of this.states) {
        if (state.stamp !== stamp) this.states.delete(id);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const layer of this.layers) {
      this.group.remove(layer.mesh);
      layer.mesh.dispose();
      layer.geometry.dispose();
      layer.material.dispose();
      layer.mesh.instanceColor = null;
    }
    this.layers.length = 0;
    this.states.clear();
    this.group.removeFromParent();
  }
}

function commit(layer: BarLayer, count: number): void {
  layer.mesh.count = count;
  layer.mesh.instanceMatrix.needsUpdate = true;
  layer.colorAttribute.needsUpdate = true;
  layer.alphaAttribute.needsUpdate = true;
  layer.mesh.visible = count > 0;
}

/**
 * Writes a camera-facing quad straight into an instanceMatrix array.
 * `shiftX` slides the quad along the camera right axis (used to left-align
 * fills and to place the shield segment); `depth` pushes it toward the viewer
 * so the coplanar layers cannot z-fight.
 */
function writeBarMatrix(
  out: Float32Array,
  index: number,
  rx: number, ry: number, rz: number,
  ux: number, uy: number, uz: number,
  fx: number, fy: number, fz: number,
  ax: number, ay: number, az: number,
  shiftX: number, width: number, height: number, depth: number,
): void {
  const o = index * 16;
  out[o] = rx * width;
  out[o + 1] = ry * width;
  out[o + 2] = rz * width;
  out[o + 3] = 0;
  out[o + 4] = ux * height;
  out[o + 5] = uy * height;
  out[o + 6] = uz * height;
  out[o + 7] = 0;
  out[o + 8] = fx * depth;
  out[o + 9] = fy * depth;
  out[o + 10] = fz * depth;
  out[o + 11] = 0;
  out[o + 12] = ax + rx * shiftX;
  out[o + 13] = ay + ry * shiftX;
  out[o + 14] = az + rz * shiftX;
  out[o + 15] = 1;
}

function writeBarColor(out: Float32Array, index: number, r: number, g: number, b: number): void {
  const o = index * 3;
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
}

