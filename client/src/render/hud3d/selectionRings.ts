/**
 * Ground selection rings.
 *
 * ASSETS: 100% procedural — one unit quad (`THREE.PlaneGeometry`) plus a
 * runtime `ShaderMaterial` that draws the ring, the dash pattern and the soft
 * inner glow in the fragment stage. No texture or model file is loaded.
 *
 * A single `InstancedMesh` covers every selected entity: each ring conforms to
 * the terrain normal under the unit, is coloured by relation (own = white,
 * ally = green, enemy = red), and the primary selection gets a slowly
 * rotating dashed pattern through a per-instance `aDash` flag.
 *
 * The world-space drag box for box-select is a separate single-instance helper
 * so the rectangle is drawn draped on the terrain while the pointer is down.
 */
import * as THREE from "three";

import type { MapDef } from "@shared/protocol";
import type { QualitySettings } from "@render/core/quality";
import type { EntityView, Relation } from "@render/entities/entityView";
import { heightField } from "@render/terrain/heightfield";
import type { HeightField } from "@render/terrain/heightfield";

const RING_INNER = 0.78;
const RING_LIFT = 0.05;
const DASH_TURNS_PER_SECOND = 0.16;
const DASH_COUNT = 28;

const RING_VERT = /* glsl */ `
attribute float aDash;
varying vec2 vPos;
varying vec3 vColor;
varying float vDash;
varying float vDist;
void main() {
  vPos = position.xy * 2.0;
  vColor = instanceColor;
  vDash = aDash;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const RING_FRAG = /* glsl */ `
uniform float uTime;
uniform float uInner;
uniform float uIntensity;
varying vec2 vPos;
varying vec3 vColor;
varying float vDash;
varying float vDist;
void main() {
  float r = length(vPos);
  // Derivative-free anti-aliasing: the edge widens with view distance instead
  // of sampling screen-space derivatives, so it works on every driver.
  float aa = 0.006 + vDist * 0.0009;
  float band = smoothstep(uInner - aa, uInner + aa, r)
             * (1.0 - smoothstep(1.0 - aa, 1.0 + aa, r));
  if (band <= 0.003) discard;
  // Soft interior wash so the selection also reads on dark terrain.
  float inner = (1.0 - smoothstep(uInner - 0.03, uInner, r)) * 0.18;
  float alpha = (band * (0.82 + 0.18 * sin(uTime * 6.0)) + inner) * uIntensity;

  if (vDash > 0.5) {
    // atan gives radians; scale to turns, then let uTime spin the pattern.
    float turns = atan(vPos.y, vPos.x) * 0.15915494 - uTime;
    float f = fract(turns * ${DASH_COUNT}.0);
    float e = aa * 2.0;
    float on = 1.0 - smoothstep(0.6 - e, 0.6 + e, f);
    alpha *= mix(0.14, 1.0, on);
  }
  gl_FragColor = vec4(vColor, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const RELATION_COLOR: Record<Relation, [number, number, number]> = {
  own: [1, 1, 1],
  ally: [0.32, 1, 0.4],
  enemy: [1, 0.26, 0.22],
};

interface RingLayer {
  mesh: THREE.InstancedMesh;
  geometry: THREE.PlaneGeometry;
  material: THREE.ShaderMaterial;
  dashData: Float32Array;
  dashAttribute: THREE.InstancedBufferAttribute;
  colorAttribute: THREE.InstancedBufferAttribute;
  colorData: Float32Array;
}

export class SelectionRings {
  /** Root added to the scene. */
  readonly group = new THREE.Group();

  private readonly terrain: HeightField;
  private readonly layer: RingLayer;
  private readonly dragFill: THREE.Mesh;
  private readonly dragLine: THREE.LineSegments;
  private elapsed = 0;
  private disposed = false;

  constructor(map: MapDef, settings: QualitySettings, capacity = 512) {
    this.terrain = heightField(map);

    const geometry = new THREE.PlaneGeometry(1, 1);
    const dashData = new Float32Array(capacity);
    const dashAttribute = new THREE.InstancedBufferAttribute(dashData, 1);
    dashAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aDash", dashAttribute);

    const material = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uInner: { value: RING_INNER },
        // Tone mapping dims UI colours on the post-FX path, so the cheap path
        // gets a small boost to keep rings equally readable either way.
        uIntensity: { value: settings.postFx ? 1.0 : 1.25 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
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
    mesh.renderOrder = 20;
    this.layer = { mesh, geometry, material, dashData, dashAttribute, colorAttribute, colorData };
    this.group.add(mesh);

    this.dragFill = makeDragFill();
    this.dragLine = makeDragOutline();
    this.group.add(this.dragFill, this.dragLine);
  }

  /**
   * Rebuilds the ring instances for this frame. `views` is read in place — the
   * caller owns the array and may reuse it.
   */
  update(views: readonly EntityView[], deltaSeconds: number): void {
    if (this.disposed) return;
    this.elapsed += Math.min(Math.max(deltaSeconds, 0), 0.25);
    this.layer.material.uniforms.uTime.value = this.elapsed * DASH_TURNS_PER_SECOND;

    const matrices = this.layer.mesh.instanceMatrix.array as Float32Array;
    const colors = this.layer.colorData;
    const dashes = this.layer.dashData;
    const cap = dashes.length;
    let n = 0;

    for (let i = 0; i < views.length && n < cap; i++) {
      const view = views[i];
      if (!view.selected || !view.visible) continue;
      const x = view.group.position.x;
      const z = view.group.position.z;
      // Rings are ground decals, so they read the height field directly; the
      // entity's own Y stays authoritative for the body above.
      const y = this.terrain.sample(x, z) + RING_LIFT;
      const r = Math.max(view.radius * 1.75, 0.85);

      // Terrain normal from four samples. `HeightField.normal` allocates an
      // object, and this runs once per selected unit per frame.
      const nx = this.terrain.sample(x - 0.5, z) - this.terrain.sample(x + 0.5, z);
      const ny = 1;
      const nz = this.terrain.sample(x, z - 0.5) - this.terrain.sample(x, z + 0.5);
      const nl = Math.hypot(nx, ny, nz) || 1;
      const ux = nx / nl;
      const uy = ny / nl;
      const uz = nz / nl;

      // Orthonormal basis with the quad lying flat on that normal.
      let rx: number;
      let ry: number;
      let rz: number;
      if (Math.abs(uz) < 0.9) {
        rx = uy; ry = -ux; rz = 0;
      } else {
        rx = 0; ry = uz; rz = -uy;
      }
      const rl = Math.hypot(rx, ry, rz) || 1;
      rx /= rl;
      ry /= rl;
      rz /= rl;
      const fx = ry * uz - rz * uy;
      const fy = rz * ux - rx * uz;
      const fz = rx * uy - ry * ux;

      const o = n * 16;
      matrices[o] = rx * r;
      matrices[o + 1] = ry * r;
      matrices[o + 2] = rz * r;
      matrices[o + 3] = 0;
      matrices[o + 4] = fx * r;
      matrices[o + 5] = fy * r;
      matrices[o + 6] = fz * r;
      matrices[o + 7] = 0;
      matrices[o + 8] = ux;
      matrices[o + 9] = uy;
      matrices[o + 10] = uz;
      matrices[o + 11] = 0;
      matrices[o + 12] = x;
      matrices[o + 13] = y;
      matrices[o + 14] = z;
      matrices[o + 15] = 1;

      const rgb = RELATION_COLOR[view.relation];
      const c = n * 3;
      colors[c] = rgb[0];
      colors[c + 1] = rgb[1];
      colors[c + 2] = rgb[2];
      dashes[n] = view.primary ? 1 : 0;
      n++;
    }

    this.layer.mesh.count = n;
    this.layer.mesh.visible = n > 0;
    if (n > 0) {
      this.layer.mesh.instanceMatrix.needsUpdate = true;
      this.layer.colorAttribute.needsUpdate = true;
      this.layer.dashAttribute.needsUpdate = true;
    }
  }

  /**
   * World-space drag rectangle for box-select. Corners are ground coordinates;
   * the box is lifted just clear of the highest corner so it stays readable
   * across a slope.
   */
  setDragBox(ax: number, az: number, bx: number, bz: number, active: boolean): void {
    if (this.disposed) return;
    if (!active) {
      this.dragFill.visible = false;
      this.dragLine.visible = false;
      return;
    }
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    const z0 = Math.min(az, bz);
    const z1 = Math.max(az, bz);
    const cx = (x0 + x1) * 0.5;
    const cz = (z0 + z1) * 0.5;
    const w = Math.max(x1 - x0, 0.01);
    const d = Math.max(z1 - z0, 0.01);
    const y =
      Math.max(
        this.terrain.sample(x0, z0),
        this.terrain.sample(x1, z0),
        this.terrain.sample(x0, z1),
        this.terrain.sample(x1, z1),
      ) + 0.12;

    this.dragFill.visible = true;
    this.dragLine.visible = true;
    this.dragFill.position.set(cx, y, cz);
    this.dragFill.rotation.set(-Math.PI / 2, 0, 0);
    this.dragFill.scale.set(w, d, 1);
    this.dragLine.position.set(cx, y + 0.05, cz);
    this.dragLine.scale.set(w, 1, d);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.layer.mesh.dispose();
    this.layer.geometry.dispose();
    this.layer.material.dispose();
    this.layer.mesh.instanceColor = null;
    this.group.remove(this.layer.mesh);
    const fillMaterial = this.dragFill.material as THREE.Material;
    this.dragFill.geometry.dispose();
    fillMaterial.dispose();
    const lineMaterial = this.dragLine.material as THREE.Material;
    this.dragLine.geometry.dispose();
    lineMaterial.dispose();
    this.group.remove(this.dragFill, this.dragLine);
    this.group.removeFromParent();
  }
}

function makeDragFill(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.MeshBasicMaterial({
    color: 0x66ff9c,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 19;
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}

/** The twelve edges of a unit box, scaled to the drag rectangle. */
function makeDragOutline(): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  const c = 0.5;
  const corners: ReadonlyArray<readonly [number, number, number]> = [
    [-c, -c, -c], [c, -c, -c], [c, -c, c], [-c, -c, c],
    [-c, c, -c], [c, c, -c], [c, c, c], [-c, c, c],
  ];
  const edgePairs: ReadonlyArray<readonly [number, number]> = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const positions = new Float32Array(edgePairs.length * 6);
  let o = 0;
  for (const [a, b] of edgePairs) {
    positions[o++] = corners[a][0];
    positions[o++] = corners[a][1];
    positions[o++] = corners[a][2];
    positions[o++] = corners[b][0];
    positions[o++] = corners[b][1];
    positions[o++] = corners[b][2];
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color: 0xaaffcc,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    toneMapped: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.renderOrder = 21;
  lines.frustumCulled = false;
  lines.visible = false;
  return lines;
}
