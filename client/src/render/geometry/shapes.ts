/**
 * Procedural geometry toolkit for STARC.
 *
 * 100% procedural: this module imports no model, mesh, font or image file. Every
 * shape is generated from code and handed back as a fresh THREE.BufferGeometry
 * that the caller owns and must dispose.
 *
 * Conventions shared by every function here (the unit/building builders rely on
 * them, so they are not negotiable):
 *  - units are metres, matching `size` in shared/game-data.json;
 *  - the origin sits at the BASE CENTRE: y = 0 is the ground contact plane and
 *    the shape grows towards +Y;
 *  - the shape faces +Z, which is the heading the simulation uses;
 *  - geometry is non-indexed triangle soup with one normal per face, which is
 *    what produces the faceted low-poly read at RTS zoom and lets parts with
 *    different origins merge into one buffer without welding.
 *
 * UVs are planar-projected per triangle from the face's dominant axis and
 * scaled so that `UV_METRES` world metres map to one texture tile; revolved
 * shapes use cylindrical UVs instead so panels do not smear on curves.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** Immutable 3D point. */
export type V3 = readonly [number, number, number];
/** Mutable 3D point used while building buffers. */
export type P3 = [number, number, number];
type V2 = readonly [number, number];

/** World metres covered by one texture tile. */
export const UV_METRES = 0.5;

/* ------------------------------------------------------------------ */
/* Vector helpers                                                      */
/* ------------------------------------------------------------------ */

function sub3(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross3(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot3(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalOf(a: V3, b: V3, c: V3): V3 {
  return cross3(sub3(b, a), sub3(c, a));
}

/** Deterministic PRNG so every generated asset is identical run to run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Triangle soup builder                                               */
/* ------------------------------------------------------------------ */

/** Planar-projection UVs, picking the plane perpendicular to the face normal. */
function projectUV(a: V3, b: V3, c: V3, uvScale: number): [V2, V2, V2] {
  const n = normalOf(a, b, c);
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  let pu: (p: V3) => number;
  let pv: (p: V3) => number;
  if (ax >= ay && ax >= az) {
    pu = (p) => p[2];
    pv = (p) => p[1];
  } else if (ay >= az) {
    pu = (p) => p[0];
    pv = (p) => p[2];
  } else {
    pu = (p) => p[0];
    pv = (p) => p[1];
  }
  return [
    [pu(a) * uvScale, pv(a) * uvScale],
    [pu(b) * uvScale, pv(b) * uvScale],
    [pu(c) * uvScale, pv(c) * uvScale],
  ];
}

/**
 * Accumulates triangles. Every shape in this module is built through it, so
 * attribute layout is identical everywhere and `mergeGeometries` never bails.
 */
export class TriSoup {
  private readonly positions: number[] = [];
  private readonly uvs: number[] = [];

  /** Raw triangle, caller guarantees the winding. */
  tri(a: V3, b: V3, c: V3, uvScale = UV_METRES): this {
    this.positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    const [ua, ub, uc] = projectUV(a, b, c, uvScale);
    this.uvs.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
    return this;
  }

  /** Raw quad, split into two triangles, caller guarantees the winding. */
  quad(a: V3, b: V3, c: V3, d: V3, uvScale = UV_METRES): this {
    this.tri(a, b, c, uvScale);
    this.tri(a, c, d, uvScale);
    return this;
  }

  /** Triangle whose winding is fixed up so its normal agrees with `outward`. */
  triOut(a: V3, b: V3, c: V3, outward: V3, uvScale = UV_METRES): this {
    if (dot3(normalOf(a, b, c), outward) < 0) this.tri(a, c, b, uvScale);
    else this.tri(a, b, c, uvScale);
    return this;
  }

  /** Quad whose winding is fixed up so its normal agrees with `outward`. */
  quadOut(a: V3, b: V3, c: V3, d: V3, outward: V3, uvScale = UV_METRES): this {
    if (dot3(normalOf(a, b, c), outward) < 0) this.quad(a, d, c, b, uvScale);
    else this.quad(a, b, c, d, uvScale);
    return this;
  }

  /** Quad with explicit UVs (used where planar projection would smear). */
  quadUV(
    a: V3,
    b: V3,
    c: V3,
    d: V3,
    uva: V2,
    uvb: V2,
    uvc: V2,
    uvd: V2,
    outward: V3,
  ): this {
    if (dot3(normalOf(a, b, c), outward) < 0) this.quadUVRaw(a, d, c, b, uva, uvd, uvc, uvb);
    else this.quadUVRaw(a, b, c, d, uva, uvb, uvc, uvd);
    return this;
  }

  private quadUVRaw(
    a: V3,
    b: V3,
    c: V3,
    d: V3,
    uva: V2,
    uvb: V2,
    uvc: V2,
    uvd: V2,
  ): void {
    this.positions.push(
      a[0], a[1], a[2],
      b[0], b[1], b[2],
      c[0], c[1], c[2],
      a[0], a[1], a[2],
      c[0], c[1], c[2],
      d[0], d[1], d[2],
    );
    this.uvs.push(
      uva[0], uva[1],
      uvb[0], uvb[1],
      uvc[0], uvc[1],
      uva[0], uva[1],
      uvc[0], uvc[1],
      uvd[0], uvd[1],
    );
  }

  /** Finish the buffer. Normals are per-face, so the result is flat shaded. */
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uvs, 2));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/* ------------------------------------------------------------------ */
/* Transforms                                                          */
/* ------------------------------------------------------------------ */

export interface PartTransform {
  x?: number;
  y?: number;
  z?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  s?: number;
  sx?: number;
  sy?: number;
  sz?: number;
}

const scratchMatrix = new THREE.Matrix4();
const scratchQuat = new THREE.Quaternion();
const scratchEuler = new THREE.Euler(0, 0, 0, "YXZ");
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3();

/**
 * Applies scale-then-rotate-then-translate in place. Negative determinants
 * (mirroring a wing, a leg) flip the triangle winding back so the mirrored
 * copy is lit like the original instead of turning inside out.
 */
export function transformGeometry(
  geometry: THREE.BufferGeometry,
  t: PartTransform,
): THREE.BufferGeometry {
  const s = t.s ?? 1;
  scratchScale.set(t.sx ?? s, t.sy ?? s, t.sz ?? s);
  scratchEuler.set(t.rx ?? 0, t.ry ?? 0, t.rz ?? 0, "YXZ");
  scratchQuat.setFromEuler(scratchEuler);
  scratchPos.set(t.x ?? 0, t.y ?? 0, t.z ?? 0);
  scratchMatrix.compose(scratchPos, scratchQuat, scratchScale);
  geometry.applyMatrix4(scratchMatrix);
  if (scratchMatrix.determinant() < 0) flipWinding(geometry);
  return geometry;
}

function flipWinding(geometry: THREE.BufferGeometry): void {
  swapTriangleVertices(geometry.getAttribute("position"), 3);
  const uv = geometry.getAttribute("uv");
  if (uv) swapTriangleVertices(uv, 2);
  geometry.computeVertexNormals();
}

function swapTriangleVertices(
  attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  components: number,
): void {
  // An interleaved attribute has no array of its own: read and write through
  // the shared buffer at this attribute's offset and stride.
  const interleaved = attr instanceof THREE.InterleavedBufferAttribute;
  const data = interleaved ? attr.data.array : attr.array;
  const stride = interleaved ? attr.data.stride : attr.itemSize;
  const offset = interleaved ? attr.offset : 0;
  for (let i = 0; i + 2 < attr.count; i += 3) {
    for (let k = 0; k < components; k++) {
      const a = offset + (i + 1) * stride + k;
      const b = offset + (i + 2) * stride + k;
      const swap = data[a] as number;
      data[a] = data[b] as number;
      data[b] = swap;
    }
  }
  attr.needsUpdate = true;
}

/* ------------------------------------------------------------------ */
/* Part assembly                                                       */
/* ------------------------------------------------------------------ */

/**
 * Per-part surface tone. The rgb triple is a multiplier applied on top of the
 * material's race colour (so the race tints the whole model) and `glow` is an
 * emissive mask in the alpha slot, consumed by the material library.
 */
export interface PartTone {
  r: number;
  g: number;
  b: number;
  glow?: number;
}

/** Writes a flat tone into a 4-component colour attribute. */
export function setPartColor(
  geometry: THREE.BufferGeometry,
  tone: PartTone,
): THREE.BufferGeometry {
  const pos = geometry.getAttribute("position");
  const count = pos.count;
  const arr = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    arr[i * 4] = tone.r;
    arr[i * 4 + 1] = tone.g;
    arr[i * 4 + 2] = tone.b;
    arr[i * 4 + 3] = tone.glow ?? 0;
  }
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(arr, 4));
  return geometry;
}

/**
 * Collects tinted parts and merges them into a single non-indexed buffer.
 * Every part carries the same attribute set (position, uv, normal, colour),
 * which is what lets the merge succeed and the mesh render in one call.
 */
export class PartList {
  private readonly parts: THREE.BufferGeometry[] = [];

  add(
    geometry: THREE.BufferGeometry,
    tone: PartTone,
    transform?: PartTransform,
  ): this {
    if (transform) transformGeometry(geometry, transform);
    setPartColor(geometry, tone);
    this.parts.push(geometry);
    return this;
  }

  get partCount(): number {
    return this.parts.length;
  }

  merge(): THREE.BufferGeometry {
    if (this.parts.length === 0) throw new Error("PartList.merge(): no parts were added");
    if (this.parts.length === 1) {
      const only = this.parts[0] as THREE.BufferGeometry;
      only.computeBoundingBox();
      only.computeBoundingSphere();
      return only;
    }
    const merged = mergeGeometries(this.parts, false);
    if (!merged) throw new Error("PartList.merge(): geometry merge failed");
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }
}

/* ------------------------------------------------------------------ */
/* Revolved profiles                                                   */
/* ------------------------------------------------------------------ */

function revolve(
  profile: readonly V2[],
  segments: number,
  capBottom: boolean,
  capTop: boolean,
  uvScale: number,
): THREE.BufferGeometry {
  const s = new TriSoup();
  const n = Math.max(3, Math.round(segments));
  const step = (Math.PI * 2) / n;
  for (let j = 0; j < profile.length - 1; j++) {
    const [r0, y0] = profile[j] as V2;
    const [r1, y1] = profile[j + 1] as V2;
    const rRef = Math.max(r0, r1, 1e-4);
    for (let i = 0; i < n; i++) {
      const a0 = i * step;
      const a1 = (i + 1) * step;
      const am = a0 + step * 0.5;
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);
      const u0 = a0 * rRef * uvScale;
      const u1 = a1 * rRef * uvScale;
      const v0 = y0 * uvScale;
      const v1 = y1 * uvScale;
      s.quadUV(
        [r0 * c0, y0, r0 * s0],
        [r0 * c1, y0, r0 * s1],
        [r1 * c1, y1, r1 * s1],
        [r1 * c0, y1, r1 * s0],
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
        [Math.cos(am), 0, Math.sin(am)],
      );
    }
  }
  const first = profile[0] as V2;
  const last = profile[profile.length - 1] as V2;
  if (capBottom && first[0] > 1e-5) capDisc(s, first[0], first[1], n, -1, uvScale);
  if (capTop && last[0] > 1e-5) capDisc(s, last[0], last[1], n, 1, uvScale);
  return s.geometry();
}

function capDisc(
  s: TriSoup,
  radius: number,
  y: number,
  segments: number,
  dir: 1 | -1,
  uvScale: number,
): void {
  const step = (Math.PI * 2) / segments;
  for (let i = 0; i < segments; i++) {
    const a0 = i * step;
    const a1 = (i + 1) * step;
    s.triOut(
      [0, y, 0],
      [radius * Math.cos(a0), y, radius * Math.sin(a0)],
      [radius * Math.cos(a1), y, radius * Math.sin(a1)],
      [0, dir, 0],
      uvScale,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Primitive shapes                                                    */
/* ------------------------------------------------------------------ */

/** Box whose top face is scaled in X and Z; the classic mech hull shape. */
export function taperedBox(
  w: number,
  h: number,
  d: number,
  topScale = 0.8,
  uvScale = UV_METRES,
): THREE.BufferGeometry {
  const s = new TriSoup();
  const hw = w / 2;
  const hd = d / 2;
  const tw = hw * topScale;
  const td = hd * topScale;
  const bot: V3[] = [
    [-hw, 0, -hd],
    [hw, 0, -hd],
    [hw, 0, hd],
    [-hw, 0, hd],
  ];
  const top: V3[] = [
    [-tw, h, -td],
    [tw, h, -td],
    [tw, h, td],
    [-tw, h, td],
  ];
  s.quadOut(bot[0], bot[1], bot[2], bot[3], [0, -1, 0], uvScale);
  s.quadOut(top[0], top[1], top[2], top[3], [0, 1, 0], uvScale);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    s.quadOut(bot[i], bot[j], top[j], top[i], [bot[i][0] + bot[j][0], 0, bot[i][2] + bot[j][2]], uvScale);
  }
  return s.geometry();
}

/**
 * Box with flat 45-degree chamfers on all twelve edges and eight corners.
 * Built as six inset faces, twelve edge quads and eight corner triangles.
 */
export function beveledBox(
  w: number,
  h: number,
  d: number,
  bevel = 0.05,
  uvScale = UV_METRES,
): THREE.BufferGeometry {
  const half: P3 = [w / 2, h / 2, d / 2];
  const b = Math.max(1e-4, Math.min(bevel, half[0] * 0.49, half[1] * 0.49, half[2] * 0.49));
  const s = new TriSoup();
  for (let f = 0; f < 3; f++) {
    const u = (f + 1) % 3;
    const v = (f + 2) % 3;
    const eu = half[u] - b;
    const ev = half[v] - b;
    const corners: V2[] = [
      [eu, ev],
      [-eu, ev],
      [-eu, -ev],
      [eu, -ev],
    ];
    for (const sign of [1, -1]) {
      const pts: V3[] = corners.map((corner) => {
        const p: P3 = [0, 0, 0];
        p[f] = sign * half[f];
        p[u] = corner[0];
        p[v] = corner[1];
        return p;
      });
      const out: P3 = [0, 0, 0];
      out[f] = sign;
      s.quadOut(pts[0], pts[1], pts[2], pts[3], out, uvScale);
    }
  }
  for (let a = 0; a < 3; a++) {
    for (let c = a + 1; c < 3; c++) {
      const free = 3 - a - c;
      const ef = half[free] - b;
      for (const sa of [1, -1]) {
        for (const sc of [1, -1]) {
          const p0: P3 = [0, 0, 0];
          p0[a] = sa * half[a];
          p0[c] = sc * (half[c] - b);
          p0[free] = ef;
          const p1: P3 = [p0[0], p0[1], p0[2]];
          p1[free] = -ef;
          const p2: P3 = [0, 0, 0];
          p2[a] = sa * (half[a] - b);
          p2[c] = sc * half[c];
          p2[free] = -ef;
          const p3: P3 = [p2[0], p2[1], p2[2]];
          p3[free] = ef;
          const out: P3 = [0, 0, 0];
          out[a] = sa;
          out[c] = sc;
          s.quadOut(p0, p1, p2, p3, out, uvScale);
        }
      }
    }
  }
  for (const sx of [1, -1]) {
    for (const sy of [1, -1]) {
      for (const sz of [1, -1]) {
        s.triOut(
          [sx * half[0], sy * (half[1] - b), sz * (half[2] - b)],
          [sx * (half[0] - b), sy * half[1], sz * (half[2] - b)],
          [sx * (half[0] - b), sy * (half[1] - b), sz * half[2]],
          [sx, sy, sz],
          uvScale,
        );
      }
    }
  }
  return s.geometry();
}

/** Cylinder with chamfered top and bottom rims, base at y = 0. */
export function chamferedCylinder(
  rTop: number,
  rBottom: number,
  h: number,
  segments = 12,
  uvScale = UV_METRES,
): THREE.BufferGeometry {
  const rim = Math.max(1e-3, Math.min(h * 0.16, Math.min(rTop, rBottom) * 0.55));
  const profile: V2[] = [
    [rBottom, 0],
    [rBottom, rim],
    [rTop, h - rim],
    [rTop, h],
  ];
  return revolve(profile, segments, true, true, uvScale);
}

/** Rectangular frustum standing on its base. */
export function truncatedPyramid(
  wBottom: number,
  dBottom: number,
  wTop: number,
  dTop: number,
  h: number,
  uvScale = UV_METRES,
): THREE.BufferGeometry {
  const s = new TriSoup();
  const bw = wBottom / 2;
  const bd = dBottom / 2;
  const tw = wTop / 2;
  const td = dTop / 2;
  const bot: V3[] = [
    [-bw, 0, -bd],
    [bw, 0, -bd],
    [bw, 0, bd],
    [-bw, 0, bd],
  ];
  const top: V3[] = [
    [-tw, h, -td],
    [tw, h, -td],
    [tw, h, td],
    [-tw, h, td],
  ];
  s.quadOut(bot[0], bot[1], bot[2], bot[3], [0, -1, 0], uvScale);
  s.quadOut(top[0], top[1], top[2], top[3], [0, 1, 0], uvScale);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    s.quadOut(bot[i], bot[j], top[j], top[i], [bot[i][0] + bot[j][0], 0, bot[i][2] + bot[j][2]], uvScale);
  }
  return s.geometry();
}

/** Hexagonal pillar with a chamfered top ring — the Protoss building base. */
export function hexPrism(radius: number, height: number, uvScale = UV_METRES): THREE.BufferGeometry {
  const top = radius * 0.94;
  return chamferedCylinder(top, radius, height, 6, uvScale);
}

/** Sharp gem: a bipyramid resting on its lower point, apex at 2 * radius. */
export function octahedron(radius: number, uvScale = UV_METRES): THREE.BufferGeometry {
  const s = new TriSoup();
  const r = radius * 0.7071;
  const eq: V3[] = [
    [r, radius, 0],
    [0, radius, r],
    [-r, radius, 0],
    [0, radius, -r],
  ];
  const apex: V3 = [0, radius * 2, 0];
  const foot: V3 = [0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    s.triOut(eq[i], eq[j], apex, [eq[i][0] + eq[j][0], 1, eq[i][2] + eq[j][2]], uvScale);
    s.triOut(eq[j], eq[i], foot, [eq[i][0] + eq[j][0], -1, eq[i][2] + eq[j][2]], uvScale);
  }
  return s.geometry();
}

/** Cone standing on its base, optionally truncated at the tip. */
export function cone(
  radius: number,
  height: number,
  segments = 8,
  tipRadius = 0,
  uvScale = UV_METRES,
): THREE.BufferGeometry {
  const profile: V2[] = [
    [radius, 0],
    [tipRadius, height],
  ];
  return revolve(profile, segments, true, tipRadius > 1e-5, uvScale);
}

/**
 * Open or closed ring lying in the XZ plane, resting on the ground
 * (centre height = radius + tube). Used for pylon rings and turret collars.
 */
export function torusSegment(
  radius: number,
  tube: number,
  arc = Math.PI * 2,
  tubularSegments = 16,
  radialSegments = 8,
  uvScale = UV_METRES,
): THREE.BufferGeometry {
  const s = new TriSoup();
  const steps = Math.max(2, Math.round(tubularSegments));
  const rSteps = Math.max(3, Math.round(radialSegments));
  const closed = arc >= Math.PI * 2 - 1e-6;
  const centreY = radius + tube;
  const point = (ti: number, ri: number): V3 => {
    const theta = arc * (ti / steps);
    const phi = (Math.PI * 2 * ri) / rSteps;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    const cr = Math.cos(phi) * tube;
    const cy = Math.sin(phi) * tube;
    return [ct * (radius + cr), centreY + cy, st * (radius + cr)];
  };
  for (let ti = 0; ti < steps; ti++) {
    for (let ri = 0; ri < rSteps; ri++) {
      const a = point(ti, ri);
      const b = point(ti, ri + 1);
      const c = point(ti + 1, ri + 1);
      const d = point(ti + 1, ri);
      const mid: P3 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2 - centreY, (a[2] + c[2]) / 2];
      s.quadOut(a, b, c, d, mid, uvScale);
    }
  }
  if (!closed) {
    for (const end of [0, steps]) {
      const theta = arc * (end / steps);
      const centre: V3 = [Math.cos(theta) * radius, centreY, Math.sin(theta) * radius];
      const outward: V3 =
        end === 0
          ? [Math.sin(theta), 0, -Math.cos(theta)]
          : [-Math.sin(theta), 0, Math.cos(theta)];
      for (let ri = 0; ri < rSteps; ri++) {
        s.triOut(centre, point(end, ri), point(end, ri + 1), outward, uvScale);
      }
    }
  }
  return s.geometry();
}

/** Faceted sphere resting on the ground: y runs 0 .. 2 * radius. */
export function sphereLowPoly(
  radius: number,
  widthSegments = 8,
  heightSegments = 6,
  uvScale = UV_METRES,
): THREE.BufferGeometry {
  const hs = Math.max(2, Math.round(heightSegments));
  const profile: V2[] = [];
  for (let i = 0; i <= hs; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / hs;
    profile.push([Math.cos(a) * radius, radius + Math.sin(a) * radius]);
  }
  return revolve(profile, widthSegments, false, false, uvScale);
}

/** Upright capsule: total height is `length + 2 * radius`, base at y = 0. */
export function capsule(
  radius: number,
  length: number,
  capSegments = 4,
  radialSegments = 10,
  uvScale = UV_METRES,
): THREE.BufferGeometry {
  const cs = Math.max(2, Math.round(capSegments));
  const profile: V2[] = [];
  for (let i = 0; i <= cs; i++) {
    const a = -Math.PI / 2 + (Math.PI * 0.5 * i) / cs;
    profile.push([Math.cos(a) * radius, radius + Math.sin(a) * radius]);
  }
  const straight = Math.max(0, length);
  profile.push([0, radius + straight]);
  for (let i = 0; i <= cs; i++) {
    const a = (Math.PI * 0.5 * i) / cs;
    profile.push([Math.cos(a) * radius, radius + straight + Math.sin(a) * radius]);
  }
  return revolve(profile, radialSegments, false, false, uvScale);
}

/**
 * Swept, tapered wing extending along +X from the origin, chord along Z,
 * thickness along Y. Mirrored copies make a full airframe.
 */
export function wingShape(span: number, chord: number, thickness: number): THREE.BufferGeometry {
  const s = new TriSoup();
  const dihedral = span * 0.08;
  const outline: V2[] = [
    [0, chord * 0.5],
    [span, chord * 0.16],
    [span, -chord * 0.22],
    [0, -chord * 0.5],
  ];
  const top: V3[] = [];
  const bottom: V3[] = [];
  for (const [x, z] of outline) {
    const t = (thickness / 2) * (1 - 0.7 * Math.min(1, x / Math.max(span, 1e-4)));
    const y = dihedral * Math.min(1, x / Math.max(span, 1e-4));
    top.push([x, y + t, z]);
    bottom.push([x, y - t, z]);
  }
  s.quadOut(top[0], top[1], top[2], top[3], [0, 1, 0]);
  s.quadOut(bottom[3], bottom[2], bottom[1], bottom[0], [0, -1, 0]);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const outward: P3 = [
      top[i][0] + top[j][0] + bottom[i][0] + bottom[j][0],
      0,
      top[i][2] + top[j][2] + bottom[i][2] + bottom[j][2],
    ];
    s.quadOut(top[i], top[j], bottom[j], bottom[i], outward);
  }
  return s.geometry();
}

/**
 * Armoured hull block wearing its tracks: a bevelled body plus tread ridges
 * down both flanks and rounded end rollers, so vehicles read as tracked.
 */
export function treadedBlock(
  w: number,
  h: number,
  d: number,
  treads = 6,
  uvScale = UV_METRES,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(beveledBox(w * 0.86, h, d, Math.min(0.05, h * 0.25), uvScale));
  const ridgeH = h * 0.78;
  const ridgeY = h * 0.11;
  const count = Math.max(2, Math.round(treads));
  const step = d / count;
  for (const side of [1, -1]) {
    for (let i = 0; i < count; i++) {
      const ridge = taperedBox(w * 0.14, ridgeH, step * 0.62, 0.8, uvScale);
      ridge.translate(side * w * 0.45, ridgeY, -d / 2 + step * (i + 0.5));
      parts.push(ridge);
    }
    // End rollers sit so their disc is tangent to the ground plane.
    const roller = chamferedCylinder(h * 0.3, h * 0.3, w * 0.1, 8, uvScale);
    roller.rotateZ(side * -Math.PI * 0.5);
    roller.translate(side * w * 0.5, h * 0.3, d * 0.36);
    parts.push(roller);
    const rollerBack = chamferedCylinder(h * 0.3, h * 0.3, w * 0.1, 8, uvScale);
    rollerBack.rotateZ(side * -Math.PI * 0.5);
    rollerBack.translate(side * w * 0.5, h * 0.3, -d * 0.36);
    parts.push(rollerBack);
  }
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error("treadedBlock(): merge failed");
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Deterministic surface clutter: `count` small blocks scattered over the top
 * and flanks of `base`. SC1 structures are covered in this, and it is what
 * stops a boxy building from reading as an untextured cube at RTS zoom.
 */
export function greeble(
  base: THREE.BufferGeometry,
  count: number,
  scale: number,
  seed: number,
): THREE.BufferGeometry {
  base.computeBoundingBox();
  const bb = base.boundingBox;
  if (!bb) throw new Error("greeble(): base has no bounding box");
  const minX = bb.min.x;
  const maxX = bb.max.x;
  const minY = bb.min.y;
  const maxY = bb.max.y;
  const minZ = bb.min.z;
  const maxZ = bb.max.z;
  const hasColor = base.getAttribute("color") !== undefined;
  let avg: P3 = [1, 1, 1];
  if (hasColor) {
    const col = base.getAttribute("color") as THREE.BufferAttribute;
    const n = Math.max(1, col.count);
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < n; i++) {
      r += col.getX(i);
      g += col.getY(i);
      b += col.getZ(i);
    }
    avg = [r / n / 0.82, g / n / 0.82, b / n / 0.82];
  }
  const rnd = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [base];
  const total = Math.max(0, Math.round(count));
  const spanY = maxY - minY;
  const tone: PartTone = { r: avg[0] * 0.82, g: avg[1] * 0.82, b: avg[2] * 0.82 };
  for (let i = 0; i < total; i++) {
    // `proud` is how far the block stands off the surface, `wA`/`wB` are the
    // two in-plane extents and `tall` is its vertical extent.
    const proud = (0.18 + rnd() * 0.55) * scale;
    const wA = (0.3 + rnd() * 0.85) * scale;
    const wB = (0.3 + rnd() * 0.85) * scale;
    if (rnd() < 0.45) {
      const footprint = Math.max(wA, wB);
      const px = minX + footprint * 0.5 + rnd() * Math.max(0, maxX - minX - footprint);
      const pz = minZ + footprint * 0.5 + rnd() * Math.max(0, maxZ - minZ - footprint);
      const box = taperedBox(wA, proud, wB, 0.72);
      box.translate(px, maxY, pz);
      if (hasColor) setPartColor(box, tone);
      parts.push(box);
      continue;
    }
    const faceX = rnd() < 0.5;
    const dir = rnd() < 0.5 ? 1 : -1;
    const tall = Math.min(proud, Math.max(spanY * 0.5, 1e-3));
    const yLow = minY + rnd() * Math.max(0, spanY - tall);
    let box: THREE.BufferGeometry;
    let x: number;
    let z: number;
    if (faceX) {
      // Rotating about Z puts the block's local +Y on ±X and its local X on ±Y.
      box = taperedBox(tall, proud, wB, 0.7);
      box.rotateZ(dir * -Math.PI * 0.5);
      x = dir > 0 ? maxX : minX;
      z = minZ + wB * 0.5 + rnd() * Math.max(0, maxZ - minZ - wB);
    } else {
      // Rotating about X puts the block's local +Y on ±Z and its local Z on ±Y.
      box = taperedBox(wA, proud, tall, 0.7);
      box.rotateX(dir * Math.PI * 0.5);
      x = minX + wA * 0.5 + rnd() * Math.max(0, maxX - minX - wA);
      z = dir > 0 ? maxZ : minZ;
    }
    const yBase = (faceX ? dir > 0 : dir < 0) ? yLow : yLow + tall;
    box.translate(x, yBase, z);
    if (hasColor) setPartColor(box, tone);
    parts.push(box);
  }
  if (parts.length === 1) return base;
  const merged = mergeGeometries(parts, false);
  if (!merged) return base;
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

export interface PanelLineOptions {
  /** Strips per axis on the top face. */
  lines?: number;
  /** Strip width in metres. */
  thickness?: number;
  /** How far the strips stand proud of the surface. */
  proud?: number;
  /** Wrap a seam band around the four walls instead of the top only. */
  sides?: boolean;
  /** Height of the wall seam band. */
  bandHeight?: number;
  /** Height at which the wall band sits, as a fraction of h. */
  bandAt?: number;
}

/**
 * Raised panel seams for a box of the given size. Kept as its own geometry so
 * callers can lay it over a hull with a single extra tinted part.
 */
export function panelLineOverlay(
  w: number,
  h: number,
  d: number,
  opts: PanelLineOptions = {},
): THREE.BufferGeometry {
  const lines = Math.max(0, Math.round(opts.lines ?? 3));
  const t = opts.thickness ?? 0.03;
  const proud = opts.proud ?? 0.012;
  const parts: THREE.BufferGeometry[] = [];
  if (lines > 0) {
    for (const side of [1, -1]) {
      const railX = taperedBox(t, proud, d - t, 1);
      railX.translate(side * (w / 2 - t / 2), h, 0);
      parts.push(railX);
      const railZ = taperedBox(w - t, proud, t, 1);
      railZ.translate(0, h, side * (d / 2 - t / 2));
      parts.push(railZ);
    }
    for (let i = 1; i < lines; i++) {
      const f = i / lines;
      const railA = taperedBox(t, proud, d - t, 1);
      railA.translate(-w / 2 + f * w, h, 0);
      parts.push(railA);
      const railB = taperedBox(w - t, proud, t, 1);
      railB.translate(0, h, -d / 2 + f * d);
      parts.push(railB);
    }
  }
  if (opts.sides) {
    const bandH = opts.bandHeight ?? h * 0.16;
    const at = (opts.bandAt ?? 0.55) * h;
    const front = taperedBox(w, bandH, t, 1);
    front.translate(0, at, d / 2 - t / 2);
    const back = taperedBox(w, bandH, t, 1);
    back.translate(0, at, -d / 2 + t / 2);
    const right = taperedBox(t, bandH, d, 1);
    right.translate(w / 2 - t / 2, at, 0);
    const left = taperedBox(t, bandH, d, 1);
    left.translate(-w / 2 + t / 2, at, 0);
    parts.push(front, back, right, left);
  }
  if (parts.length === 0) {
    throw new Error("panelLineOverlay(): nothing to draw, lines must be > 0 or sides enabled");
  }
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error("panelLineOverlay(): merge failed");
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/* ------------------------------------------------------------------ */
/* Footprint fitting                                                   */
/* ------------------------------------------------------------------ */

export interface FitOptions {
  /**
   * How far a model may poke past the collision radius before it is shrunk to
   * match. Weapon barrels legitimately overshoot; hulls must not.
   */
  maxOvershoot?: number;
  /** Minimum fraction of the roster height the model should reach. */
  fillHeight?: number;
  /** Grow a model that only fills this fraction of the radius. */
  fillRadius?: number;
}

/**
 * Squeezes a model onto the roster's `size` so the visual footprint and the
 * server's collision circle agree: horizontal extent lands on `radius` and the
 * silhouette tops out at `height`, both measured from the base-centre origin.
 */
export function fitFootprint(
  geometry: THREE.BufferGeometry,
  radius: number,
  height: number,
  opts: FitOptions = {},
): THREE.BufferGeometry {
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  if (!bb) return geometry;
  const overshoot = opts.maxOvershoot ?? 1.12;
  const fillRadius = opts.fillRadius ?? 0.8;
  const fillHeight = opts.fillHeight ?? 0.86;
  const halfX = (bb.max.x - bb.min.x) / 2;
  const halfZ = (bb.max.z - bb.min.z) / 2;
  const reach = Math.max(halfX, halfZ);
  const cx = (bb.max.x + bb.min.x) / 2;
  const cz = (bb.max.z + bb.min.z) / 2;
  let sx = 1;
  if (reach > radius * overshoot) sx = radius / Math.max(reach, 1e-5);
  else if (reach < radius * fillRadius) sx = (radius * fillRadius) / Math.max(reach, 1e-5);
  const top = bb.max.y;
  const bottom = bb.min.y;
  const span = Math.max(1e-5, top - bottom);
  let sy = 1;
  if (top > height) sy = height / top;
  else if (span < height * fillHeight) sy = (height * fillHeight) / span;
  if (sx !== 1 || sy !== 1) {
    geometry.scale(sx, sy, sx);
    geometry.translate(-cx * (sx - 1), -bottom * (sy - 1), -cz * (sx - 1));
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
