/**
 * The procedural geometry toolkit, exercised as geometry rather than as code.
 *
 * Every assertion here names a defect it would catch: a `taperedBox` that has
 * stopped tapering, a `torusSegment` that has started capping its own seam, a
 * `greeble` whose "deterministic" clutter changes between frames (which would
 * show up as buildings that shimmer), a `fitFootprint` that leaves a model
 * standing half-buried. three.js builds and computes all of this without a GL
 * context, so the whole toolkit is verifiable in plain node.
 */
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  PartList,
  TriSoup,
  UV_METRES,
  beveledBox,
  capsule,
  chamferedCylinder,
  cone,
  fitFootprint,
  greeble,
  hexPrism,
  mulberry32,
  octahedron,
  panelLineOverlay,
  setPartColor,
  sphereLowPoly,
  taperedBox,
  torusSegment,
  treadedBlock,
  transformGeometry,
  truncatedPyramid,
  wingShape,
} from "./shapes";

/** Vertex count of a non-indexed geometry. */
function verts(g: THREE.BufferGeometry): number {
  return g.getAttribute("position").count;
}

/** Triangle count of a non-indexed geometry. */
function tris(g: THREE.BufferGeometry): number {
  return verts(g) / 3;
}

/** Forces a fresh bounding box and returns it. */
function boxOf(g: THREE.BufferGeometry): THREE.Box3 {
  g.computeBoundingBox();
  const b = g.boundingBox;
  if (!b) throw new Error("computeBoundingBox left the box null");
  return b;
}

/** X extent of the topmost ring of vertices. */
function topFaceSpan(g: THREE.BufferGeometry): number {
  const p = g.getAttribute("position");
  const top = boxOf(g).max.y;
  let span = 0;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > top - 1e-6) span = Math.max(span, Math.abs(p.getX(i)) * 2);
  }
  return span;
}

/** Largest horizontal distance from the origin, i.e. the collision footprint. */
function reachOf(g: THREE.BufferGeometry): number {
  const b = boxOf(g);
  return Math.max(Math.abs(b.min.x), b.max.x, Math.abs(b.min.z), b.max.z);
}

/** True when every coordinate is a finite number. */
function allFinite(g: THREE.BufferGeometry): boolean {
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count * p.itemSize; i++) {
    if (!Number.isFinite(p.array[i] as number)) return false;
  }
  return true;
}

/** Every attribute the merged pipeline needs, in a shape a merge can consume. */
function expectRenderable(g: THREE.BufferGeometry): void {
  expect(g).toBeInstanceOf(THREE.BufferGeometry);
  expect(verts(g)).toBeGreaterThan(0);
  expect(g.index).toBeNull();
  expect(g.getAttribute("uv")).toBeDefined();
  expect(g.getAttribute("normal")).toBeDefined();
  expect(allFinite(g)).toBe(true);
  expect(boxOf(g).isEmpty()).toBe(false);
  g.computeBoundingSphere();
  expect(g.boundingSphere).not.toBeNull();
  expect(g.boundingSphere?.radius).toBeGreaterThan(0);
}

describe("mulberry32", () => {
  it("is deterministic for a seed and diverges between seeds", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const c = mulberry32(12346);
    const first = [a(), a(), a(), a()];
    expect([b(), b(), b(), b()]).toEqual(first);
    expect([c(), c(), c(), c()]).not.toEqual(first);
  });

  it("stays inside [0, 1) and does not repeat within a short run", () => {
    const rnd = mulberry32(7);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const v = rnd();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      seen.add(v);
    }
    expect(seen.size).toBe(1000);
  });

  it("coerces the seed, so a negative seed still names a stable stream", () => {
    // `seed >>> 0` is what makes a seed reproducible across calls; if the
    // coercion were dropped, a negative seed would give a different asset.
    expect(mulberry32(-1)()).toBe(mulberry32(0xffffffff)());
  });
});

describe("TriSoup", () => {
  it("emits non-indexed position/uv/normal attributes with bounds", () => {
    const g = new TriSoup().quad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]).geometry();
    expect(verts(g)).toBe(6);
    expect(g.index).toBeNull();
    expectRenderable(g);
    expect(boxOf(g)).toEqual(new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 0)));
  });

  it("scales UVs by the requested metres-per-tile", () => {
    const readMaxU = (g: THREE.BufferGeometry): number => {
      const uv = g.getAttribute("uv");
      let max = -Infinity;
      for (let i = 0; i < uv.count; i++) max = Math.max(max, uv.getX(i));
      return max;
    };
    const plain = new TriSoup().quad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], 1).geometry();
    const scaled = new TriSoup().quad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], 4).geometry();
    expect(readMaxU(scaled)).toBeCloseTo(readMaxU(plain) * 4, 5);
  });

  it("triOut reverses the winding so the face points at `outward`", () => {
    // Wound counter-clockwise seen from -Y, so the raw normal points down.
    const a: [number, number, number] = [-1, 0, -1];
    const b: [number, number, number] = [1, 0, -1];
    const c: [number, number, number] = [1, 0, 1];
    const avgNormalY = (g: THREE.BufferGeometry): number => {
      const n = g.getAttribute("normal");
      let sum = 0;
      for (let i = 0; i < n.count; i++) sum += n.getY(i);
      return sum / n.count;
    };
    const up = new TriSoup().triOut(a, b, c, [0, 1, 0], 1).geometry();
    const down = new TriSoup().triOut(a, b, c, [0, -1, 0], 1).geometry();
    expect(avgNormalY(up)).toBeGreaterThan(0.9);
    expect(avgNormalY(down)).toBeLessThan(-0.9);
  });

  it("quadOut keeps its two triangles and quadUV accepts explicit corners", () => {
    const q = new TriSoup()
      .quadOut([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], 1)
      .geometry();
    expect(tris(q)).toBe(2);
    const uv = new TriSoup()
      .quadUV(
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0, 1],
      )
      .geometry();
    expect(tris(uv)).toBe(2);
    const a = uv.getAttribute("uv");
    expect([a.getX(0), a.getY(0)]).toEqual([0, 0]);
    expect([a.getX(2), a.getY(2)]).toEqual([1, 1]);
  });
});

describe("transformGeometry", () => {
  it("applies scale, then rotation, then translation", () => {
    const g = transformGeometry(taperedBox(1, 1, 1, 1), { x: 5, ry: Math.PI / 2, s: 2 });
    const b = boxOf(g);
    // A 1x1x1 box scaled by 2 and moved +5 in x spans x 4..6 whichever way
    // it is spun about Y, so this catches a dropped scale or a dropped offset.
    expect(b.min.x).toBeCloseTo(4, 5);
    expect(b.max.x).toBeCloseTo(6, 5);
  });

  it("honours per-axis scale", () => {
    const b = boxOf(transformGeometry(taperedBox(2, 2, 2, 1), { sx: 1, sy: 3, sz: 0.5 }));
    expect(b.max.x - b.min.x).toBeCloseTo(2, 5);
    expect(b.max.y - b.min.y).toBeCloseTo(6, 5);
    expect(b.max.z - b.min.z).toBeCloseTo(1, 5);
  });

  it("is a no-op for an empty transform", () => {
    const before = Array.from(taperedBox(1, 2, 3, 0.5).getAttribute("position").array as ArrayLike<number>);
    const g = transformGeometry(taperedBox(1, 2, 3, 0.5), {});
    expect(Array.from(g.getAttribute("position").array as ArrayLike<number>)).toEqual(before);
  });

  it("turns a +Y-built part to point down +Z (the weapon convention)", () => {
    // Every barrel in the roster is a +Y cylinder laid over with rx: +90 deg.
    // If the rotation order or sign changed, guns would point into the floor.
    const b = boxOf(transformGeometry(chamferedCylinder(0.2, 0.2, 1, 8), { rx: Math.PI / 2 }));
    expect(b.min.z).toBeCloseTo(0, 4);
    expect(b.max.z).toBeCloseTo(1, 4);
    expect(b.max.x - b.min.x).toBeCloseTo(0.4, 3);
  });

  it("flips triangle winding for a negative-determinant transform", () => {
    const plain = transformGeometry(taperedBox(1, 1, 1, 1), {});
    const mirrored = transformGeometry(taperedBox(1, 1, 1, 1), { sx: -1 });
    const plainPos = plain.getAttribute("position");
    const mirrorPos = mirrored.getAttribute("position");
    // Same vertex set, opposite vertex order: index 1 and 2 are swapped.
    expect(mirrorPos.getX(0)).toBeCloseTo(-plainPos.getX(0), 5);
    expect(mirrorPos.getX(1)).toBeCloseTo(-plainPos.getX(2), 5);
    expect(mirrorPos.getX(2)).toBeCloseTo(-plainPos.getX(1), 5);
    // ...and the normals were recomputed rather than left pointing inwards.
    const n = mirrored.getAttribute("normal");
    for (let i = 0; i < n.count; i++) {
      expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 4);
    }
  });

  it("mirrors an interleaved attribute in place when the determinant flips", () => {
    // The mirror path walks the raw buffer; with an interleaved position
    // attribute a wrong stride or offset silently scrambles the mesh.
    const src = taperedBox(1, 1, 1, 1);
    const g = new THREE.BufferGeometry();
    const posData = new Float32Array(src.getAttribute("position").array as ArrayLike<number>);
    g.setAttribute("position", new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(posData, 3), 3, 0));
    const uv = src.getAttribute("uv");
    const uvData = new Float32Array(uv.array as ArrayLike<number>);
    g.setAttribute("uv", new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(uvData, 2), 2, 0));
    transformGeometry(g, { sz: -1 });
    const p = src.getAttribute("position");
    const m = g.getAttribute("position");
    expect(m.getZ(1)).toBeCloseTo(-p.getZ(2), 5);
    expect(m.getZ(2)).toBeCloseTo(-p.getZ(1), 5);
    // The UV attribute was swapped alongside the position, not left stale.
    expect(g.getAttribute("uv").getX(1)).toBe(uv.getX(2));
  });
});

describe("setPartColor / PartList", () => {
  it("writes a flat 4-component tone with glow in alpha", () => {
    const g = setPartColor(taperedBox(1, 1, 1), { r: 0.5, g: 0.25, b: 0.125, glow: 0.75 });
    const c = g.getAttribute("color");
    expect(c.itemSize).toBe(4);
    expect(c.count).toBe(g.getAttribute("position").count);
    for (let i = 0; i < c.count; i++) {
      expect([c.getX(i), c.getY(i), c.getZ(i), c.getW(i)]).toEqual([0.5, 0.25, 0.125, 0.75]);
    }
  });

  it("defaults glow to 0 so unlit parts do not glow", () => {
    const c = setPartColor(taperedBox(1, 1, 1), { r: 1, g: 1, b: 1 }).getAttribute("color");
    expect(c.getW(0)).toBe(0);
  });

  it("counts parts and merges many into one buffer with matching colours", () => {
    const list = new PartList();
    expect(list.partCount).toBe(0);
    list.add(taperedBox(1, 1, 1), { r: 1, g: 0, b: 0 });
    list.add(octahedron(0.3), { r: 0, g: 1, b: 0, glow: 1 }, { y: 2 });
    expect(list.partCount).toBe(2);
    const merged = list.merge();
    expectRenderable(merged);
    expect(verts(merged)).toBe(verts(taperedBox(1, 1, 1)) + verts(octahedron(0.3)));
    expect(merged.getAttribute("color").count).toBe(verts(merged));
    expect(boxOf(merged).max.y).toBeGreaterThan(2);
  });

  it("returns a lone part untouched by the merge", () => {
    const only = taperedBox(1, 2, 3);
    expect(new PartList().add(only, { r: 1, g: 1, b: 1 }).merge()).toBe(only);
  });

  it("refuses to merge nothing rather than returning an empty buffer", () => {
    expect(() => new PartList().merge()).toThrow(/no parts were added/);
  });
});

describe("taperedBox", () => {
  it("is narrower at the top than at the base", () => {
    const g = taperedBox(2, 3, 4);
    const b = boxOf(g);
    const bottom = b.max.x - b.min.x;
    expect(bottom).toBeCloseTo(2, 5);
    expect(b.max.z - b.min.z).toBeCloseTo(4, 5);
    expect(topFaceSpan(g)).toBeCloseTo(2 * 0.8, 5);
    expect(topFaceSpan(g)).toBeLessThan(bottom);
  });

  it("honours an explicit topScale of 1 (a plain box) and 0.5", () => {
    expect(topFaceSpan(taperedBox(2, 1, 2, 1))).toBeCloseTo(2, 5);
    expect(topFaceSpan(taperedBox(2, 1, 2, 0.5))).toBeCloseTo(1, 5);
  });

  it("stands on y = 0 with its height above it", () => {
    const b = boxOf(taperedBox(1, 2.5, 1));
    expect(b.min.y).toBeCloseTo(0, 6);
    expect(b.max.y).toBeCloseTo(2.5, 6);
    expectRenderable(taperedBox(1, 2.5, 1));
  });
});

describe("beveledBox", () => {
  it("is six inset faces, twelve edge quads and eight corner triangles", () => {
    // 6*2 + 12*2 + 8 = 44 triangles. A chamfered box that silently drops its
    // corner triangles renders with a hole at every vertex.
    expect(tris(beveledBox(1, 1, 1))).toBe(44);
  });

  it("keeps the full outer dimensions and pulls the top face in", () => {
    const g = beveledBox(2, 2, 2, 0.2);
    const b = boxOf(g);
    expect(b.max.x).toBeCloseTo(1, 5);
    expect(b.max.y).toBeCloseTo(1, 5);
    expect(topFaceSpan(g)).toBeCloseTo(2 * (1 - 0.2), 5);
  });

  it("clamps a bevel larger than the box instead of inverting it", () => {
    const g = beveledBox(1, 1, 1, 5);
    expect(boxOf(g).max.x).toBeCloseTo(0.5, 5);
    expect(tris(g)).toBe(44);
  });

  it("is centred on the origin, not based at y = 0 like every other primitive", () => {
    // Documented divergence: `treadedBlock` embeds this box directly, so a
    // tracked hull starts out half-buried.
    const b = boxOf(beveledBox(2, 2, 2));
    expect(b.min.y).toBeCloseTo(-1, 5);
    expect(b.max.y).toBeCloseTo(1, 5);
  });
});

describe("chamferedCylinder / hexPrism", () => {
  it("stands on y = 0 and tops out at h", () => {
    const b = boxOf(chamferedCylinder(0.5, 1, 3));
    expect(b.min.y).toBeCloseTo(0, 5);
    expect(b.max.y).toBeCloseTo(3, 5);
  });

  it("carries the full radius of the wider rim", () => {
    expect(boxOf(chamferedCylinder(0.5, 1, 3)).max.x).toBeCloseTo(1, 5);
    expect(boxOf(chamferedCylinder(1, 0.5, 3)).max.z).toBeCloseTo(1, 5);
  });

  it("has more triangles than a plain cylinder of the same height", () => {
    expect(verts(chamferedCylinder(1, 1, 2, 12))).toBeGreaterThan(verts(cone(1, 2, 12, 1)));
  });

  it("leaves both rims at full radius — it does not actually chamfer them", () => {
    // KNOWN DEFECT: the name promises "chamfered top and bottom rims" but the
    // profile is [rBottom,0],[rBottom,rim],[rTop,h-rim],[rTop,h] — a straight
    // taper with a shortened wall. No vertex is ever pulled in, so a hull
    // that should read as a machined rim reads as a plain cone. Pinned.
    const g = chamferedCylinder(0.5, 1, 3, 24);
    const p = g.getAttribute("position");
    const radiusAt = (y: number): number => {
      let max = 0;
      for (let i = 0; i < p.count; i++) {
        if (Math.abs(p.getY(i) - y) < 0.05) max = Math.max(max, Math.hypot(p.getX(i), p.getZ(i)));
      }
      return max;
    };
    expect(radiusAt(0)).toBeCloseTo(1, 3);
    expect(radiusAt(3)).toBeCloseTo(0.5, 3);
    expect(radiusAt(0.275)).toBeCloseTo(1, 3);
    expect(radiusAt(2.725)).toBeCloseTo(0.5, 3);
  });

  it("tapers linearly between the two rim radii, with no intermediate rings", () => {
    // rim = min(h * 0.16, min(rTop, rBottom) * 0.55) = 0.275, so the wall is
    // a single straight run from (1, 0.275) to (0.5, 2.725) and every vertex
    // in between lies on that line.
    const g = chamferedCylinder(0.5, 1, 3, 24);
    const p = g.getAttribute("position");
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y < 0.01 || y > 2.99) continue; // the cap discs sit off the wall
      const expectedR = 1 + (0.5 - 1) * ((y - 0.275) / 2.45);
      expect(Math.hypot(p.getX(i), p.getZ(i))).toBeCloseTo(expectedR, 3);
    }
  });

  it("builds a hexPrism with six sides, slightly tapered at the top", () => {
    const hex = hexPrism(1, 4);
    expect(verts(hex)).toBe(verts(chamferedCylinder(1 * 0.94, 1, 4, 6)));
    const b = boxOf(hex);
    expect(b.min.y).toBeCloseTo(0, 5);
    expect(b.max.y).toBeCloseTo(4, 5);
  });
});

describe("truncatedPyramid", () => {
  it("stands on its base and narrows toward the top face", () => {
    const g = truncatedPyramid(4, 4, 2, 2, 3);
    const b = boxOf(g);
    expect(b.min.y).toBeCloseTo(0, 5);
    expect(b.max.y).toBeCloseTo(3, 5);
    expect(topFaceSpan(g)).toBeCloseTo(2, 5);
  });

  it("can flare outward (a wider top than base)", () => {
    expect(topFaceSpan(truncatedPyramid(1, 1, 3, 3, 1))).toBeCloseTo(3, 5);
  });
});

describe("octahedron", () => {
  it("is eight triangles resting on a point, apex at 2 * radius", () => {
    const g = octahedron(0.5);
    expect(tris(g)).toBe(8);
    const b = boxOf(g);
    expect(b.min.y).toBeCloseTo(0, 5);
    expect(b.max.y).toBeCloseTo(1, 5);
    // The equator is a square of diagonal `radius`, so its side is r*sqrt2.
    expect(b.max.x - b.min.x).toBeCloseTo(0.5 * Math.SQRT2, 3);
  });

  it("keeps only the two edge lengths of a regular octahedron", () => {
    const g = octahedron(2);
    const p = g.getAttribute("position");
    const lengths = new Set<number>();
    for (let i = 0; i < p.count; i += 3) {
      for (let k = 0; k < 3; k++) {
        const a = i + (k % 3);
        const b = i + ((k + 1) % 3);
        const d = Math.hypot(p.getX(a) - p.getX(b), p.getY(a) - p.getY(b), p.getZ(a) - p.getZ(b));
        lengths.add(Math.round(d * 1000) / 1000);
      }
    }
    // Equator edge = radius; apex edge = sqrt(radius^2 + (radius*0.7071)^2).
    expect(lengths.has(2)).toBe(true);
    expect(lengths.has(2.449)).toBe(true);
    expect(lengths.size).toBe(2);
  });
});

describe("cone", () => {
  it("stands on its base and comes to a tip (or a truncated one)", () => {
    const sharp = cone(1, 2, 8);
    const b = boxOf(sharp);
    expect(b.min.y).toBeCloseTo(0, 5);
    expect(b.max.y).toBeCloseTo(2, 5);
    const flat = cone(1, 2, 8, 0.4);
    expect(boxOf(flat).max.y).toBeCloseTo(2, 5);
    // A truncated tip keeps its cap disc: more triangles than a point.
    expect(tris(flat)).toBeGreaterThan(tris(sharp));
  });

  it("bases the widest ring on the requested radius", () => {
    expect(boxOf(cone(2, 1, 16)).max.x).toBeCloseTo(2, 3);
  });
});

describe("torusSegment", () => {
  it("is a closed ring for a full arc — no end caps", () => {
    expect(tris(torusSegment(1, 0.1, Math.PI * 2, 16, 8))).toBe(16 * 8 * 2);
  });

  it("caps both ends of an open arc, so an open ring has more triangles", () => {
    const open = torusSegment(1, 0.1, Math.PI, 16, 8);
    expect(tris(open)).toBe(16 * 8 * 2 + 2 * 8);
    expect(tris(open)).toBeGreaterThan(tris(torusSegment(1, 0.1, Math.PI * 2, 16, 8)));
  });

  it("joins a full ring seamlessly: the last column repeats the first", () => {
    const g = torusSegment(1, 0.25, Math.PI * 2, 12, 6);
    const at = (theta: number, phi: number): [number, number, number] => [
      Math.cos(theta) * (1 + Math.cos(phi) * 0.25),
      1.25 + Math.sin(phi) * 0.25,
      Math.sin(theta) * (1 + Math.cos(phi) * 0.25),
    ];
    const a = at(0, 0.4);
    const b = at(Math.PI * 2, 0.4);
    expect(a[0]).toBeCloseTo(b[0], 4);
    expect(a[2]).toBeCloseTo(b[2], 4);
    expect(verts(g)).toBeGreaterThan(0);
  });

  it("sits with its centre at radius + tube", () => {
    const b = boxOf(torusSegment(1, 0.25, Math.PI * 2, 16, 8));
    expect((b.min.y + b.max.y) / 2).toBeCloseTo(1.25, 5);
  });

  it("floats its ring at y = radius, not on the ground as the docstring claims", () => {
    // KNOWN DEFECT: the docstring says "resting on the ground (centre height =
    // radius + tube)". Only the centre height is right — the tube lifts the
    // whole ring, so an untransformed torus hovers one radius in the air.
    const b = boxOf(torusSegment(1, 0.25, Math.PI * 2, 16, 8));
    expect(b.min.y).toBeCloseTo(1, 5);
  });

  it("only sweeps the requested arc", () => {
    const b = boxOf(torusSegment(1, 0.05, Math.PI / 2, 16, 8));
    // theta 0..90 degrees keeps the ring in the +x/+z quadrant.
    expect(b.min.x).toBeGreaterThan(-1e-6);
    expect(b.min.z).toBeGreaterThan(-1e-6);
  });

  it("clamps silly segment counts instead of emitting an empty ring", () => {
    const g = torusSegment(1, 0.1, Math.PI * 2, 0, 0);
    expect(verts(g)).toBeGreaterThan(0);
    expect(allFinite(g)).toBe(true);
  });
});

describe("truncatedPyramid", () => {
  it("stands on its base and narrows toward the top face", () => {
    const g = truncatedPyramid(4, 4, 2, 2, 3);
    const b = boxOf(g);
    expect(b.min.y).toBeCloseTo(0, 5);
    expect(b.max.y).toBeCloseTo(3, 5);
    expect(topFaceSpan(g)).toBeCloseTo(2, 5);
  });

  it("can flare outward (a wider top than base)", () => {
    expect(topFaceSpan(truncatedPyramid(1, 1, 3, 3, 1))).toBeCloseTo(3, 5);
  });
});

describe("sphereLowPoly / capsule", () => {
  it("sits on the ground and spans 2 * radius", () => {
    const b = boxOf(sphereLowPoly(1.5));
    expect(b.min.y).toBeCloseTo(0, 5);
    expect(b.max.y).toBeCloseTo(3, 5);
  });

  it("gets rounder with more segments without changing its silhouette", () => {
    const coarse = sphereLowPoly(1, 6, 4);
    const fine = sphereLowPoly(1, 24, 16);
    expect(verts(fine)).toBeGreaterThan(verts(coarse));
    expect(boxOf(fine).max.y).toBeCloseTo(2, 5);
    expect(boxOf(fine).max.x - boxOf(fine).min.x).toBeCloseTo(2, 5);
  });

  it("capsule height is length + 2 * radius and starts at y = 0", () => {
    const b = boxOf(capsule(0.5, 2));
    expect(b.min.y).toBeCloseTo(0, 5);
    expect(b.max.y).toBeCloseTo(3, 5);
  });

  it("clamps a negative capsule length to zero", () => {
    const b = boxOf(capsule(0.5, -5));
    expect(b.min.y).toBeCloseTo(0, 5);
    expect(b.max.y).toBeCloseTo(1, 5);
  });
});

describe("wingShape", () => {
  it("extends span along +X from the origin and keeps chord along Z", () => {
    const b = boxOf(wingShape(4, 1, 0.2));
    expect(b.min.x).toBeCloseTo(0, 5);
    expect(b.max.x).toBeCloseTo(4, 5);
    expect(b.max.z - b.min.z).toBeCloseTo(1, 4);
  });

  it("is wider in span than in chord — the name's whole point", () => {
    const b = boxOf(wingShape(4, 1, 0.2));
    expect(b.max.x - b.min.x).toBeGreaterThan((b.max.z - b.min.z) * 2);
  });

  it("tapers and rises along the span (dihedral)", () => {
    const g = wingShape(4, 1, 0.4);
    const p = g.getAttribute("position");
    // Measure the local Y extent of a slab, so the dihedral rise is excluded.
    const slab = (lo: number, hi: number): { thickness: number; lowest: number } => {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        if (x >= lo && x <= hi) {
          min = Math.min(min, p.getY(i));
          max = Math.max(max, p.getY(i));
        }
      }
      return { thickness: max - min, lowest: min };
    };
    const root = slab(0, 0.2);
    const tip = slab(3.8, 4);
    expect(tip.thickness).toBeLessThan(root.thickness);
    expect(tip.lowest).toBeGreaterThan(root.lowest);
  });
});

describe("treadedBlock", () => {
  it("grows its tread ridges with the requested count", () => {
    expect(verts(treadedBlock(2, 1, 3, 2))).toBeLessThan(verts(treadedBlock(2, 1, 3, 8)));
  });

  it("clamps a negative tread count to the minimum of two", () => {
    expect(verts(treadedBlock(2, 1, 3, -5))).toBe(verts(treadedBlock(2, 1, 3, 2)));
  });

  it("wears tracks out to the hull ends and rollers past them", () => {
    const b = boxOf(treadedBlock(2, 1, 3, 4));
    expect(b.max.z).toBeCloseTo(1.5, 3);
    expect(b.max.x).toBeCloseTo(1.2, 2);
    // The end rollers are wider than the 0.86 * w bevelled body they carry.
    expect(b.max.x).toBeGreaterThan(1);
  });

  it("inherits beveledBox's centred origin, so half the hull sits below y = 0", () => {
    // This is the root of every sub-zero `min.y` in the roster (scv -0.18 m,
    // siege tank -0.24 m, command centre -0.52 m): the body box is centred and
    // nothing re-seats it before the footprint fit runs.
    expect(boxOf(treadedBlock(2, 1, 3, 4)).min.y).toBeCloseTo(-0.5, 3);
  });
});

describe("greeble", () => {
  const base = () => setPartColor(taperedBox(2, 2, 2, 1), { r: 0.8, g: 0.4, b: 0.2 });

  it("is deterministic: same seed, same vertices", () => {
    const a = greeble(base(), 12, 0.2, 99);
    const b = greeble(base(), 12, 0.2, 99);
    expect(Array.from(a.getAttribute("position").array as ArrayLike<number>)).toEqual(
      Array.from(b.getAttribute("position").array as ArrayLike<number>),
    );
  });

  it("differs between seeds", () => {
    const a = greeble(base(), 12, 0.2, 1);
    const c = greeble(base(), 12, 0.2, 2);
    expect(Array.from(a.getAttribute("position").array as ArrayLike<number>)).not.toEqual(
      Array.from(c.getAttribute("position").array as ArrayLike<number>),
    );
  });

  it("adds clutter in proportion to the count", () => {
    const none = greeble(base(), 0, 0.2, 5);
    expect(verts(none)).toBe(verts(base()));
    expect(verts(greeble(base(), 20, 0.2, 5))).toBeGreaterThan(verts(none));
  });

  it("treats a negative count as none rather than throwing", () => {
    expect(verts(greeble(base(), -4, 0.2, 5))).toBe(verts(base()));
  });

  it("stays attached to the base surface: nothing floats or sinks far", () => {
    const b = boxOf(greeble(base(), 40, 0.15, 3));
    expect(b.min.y).toBeGreaterThanOrEqual(-0.15);
    expect(b.max.y).toBeLessThanOrEqual(2 + 0.15);
  });

  it("tints the added blocks like the base so a merge keeps one palette", () => {
    const g = greeble(base(), 8, 0.2, 3);
    const c = g.getAttribute("color");
    expect(c.count).toBe(verts(g));
    expect(c.itemSize).toBe(4);
  });

  it("merges a plain (uncoloured) base without losing attributes", () => {
    const g = greeble(taperedBox(2, 2, 2, 1), 8, 0.2, 3);
    expectRenderable(g);
    expect(g.getAttribute("color")).toBeUndefined();
  });

  it("reports a base it cannot measure instead of scattering blocks into nowhere", () => {
    const bare = new THREE.BufferGeometry();
    bare.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    vi.spyOn(bare, "computeBoundingBox").mockImplementation(() => undefined);
    expect(() => greeble(bare, 4, 0.2, 1)).toThrow(/no bounding box/);
  });
});

describe("panelLineOverlay", () => {
  it("lays strips on the top face of the box it describes", () => {
    const b = boxOf(panelLineOverlay(4, 2, 4, { lines: 3 }));
    expect(b.min.y).toBeCloseTo(2, 5);
    expect(b.max.y).toBeGreaterThan(2);
  });

  it("adds strips with every extra line", () => {
    expect(verts(panelLineOverlay(4, 2, 4, { lines: 1 }))).toBeLessThan(
      verts(panelLineOverlay(4, 2, 4, { lines: 5 })),
    );
  });

  it("wraps a band down the walls when asked", () => {
    const top = boxOf(panelLineOverlay(4, 2, 4, { lines: 2 }));
    const banded = boxOf(panelLineOverlay(4, 2, 4, { lines: 2, sides: true }));
    expect(banded.min.y).toBeLessThan(top.min.y);
    expect(banded.min.y).toBeGreaterThan(0);
  });

  it("refuses to draw nothing rather than returning an empty overlay", () => {
    expect(() => panelLineOverlay(1, 1, 1, { lines: 0 })).toThrow(/nothing to draw/);
    expect(() => panelLineOverlay(1, 1, 1, { lines: 0, sides: false })).toThrow(/nothing to draw/);
  });
});

describe("fitFootprint", () => {
  it("shrinks a model that overshoots the collision radius", () => {
    const b = boxOf(fitFootprint(taperedBox(10, 10, 10, 1), 1, 10));
    expect(Math.max(b.max.x, b.max.z)).toBeCloseTo(1, 3);
    expect(b.max.y).toBeCloseTo(10, 3);
  });

  it("grows a model that is much smaller than the radius", () => {
    expect(reachOf(fitFootprint(taperedBox(0.1, 1, 0.1, 1), 2, 4))).toBeCloseTo(2 * 0.8, 3);
  });

  it("tops the silhouette out at the roster height", () => {
    expect(boxOf(fitFootprint(taperedBox(1, 100, 1, 1), 1, 2)).max.y).toBeCloseTo(2, 4);
  });

  it("leaves a model that already fits alone", () => {
    const src = taperedBox(1.8, 0.95, 1.8, 1);
    const before = Array.from(src.getAttribute("position").array as ArrayLike<number>);
    const g = fitFootprint(src, 1, 1);
    expect(Array.from(g.getAttribute("position").array as ArrayLike<number>)).toEqual(before);
  });

  it("keeps a based-at-zero model on the ground plane", () => {
    expect(boxOf(fitFootprint(taperedBox(10, 1, 10, 1), 1, 10)).min.y).toBeCloseTo(0, 5);
  });

  it("honours maxOvershoot: a weapon barrel may stick out this far", () => {
    expect(boxOf(fitFootprint(taperedBox(2, 1, 1, 1), 1, 10, { maxOvershoot: 2 })).max.x).toBeCloseTo(1, 3);
  });

  it("honours fillRadius: a small model is grown to this fraction", () => {
    const g = fitFootprint(taperedBox(0.1, 1, 0.1, 1), 2, 10, { fillRadius: 0.5, maxOvershoot: 10 });
    expect(boxOf(g).max.x).toBeCloseTo(1, 3);
  });

  it("honours fillHeight: a stubby model is grown to this fraction", () => {
    const g = fitFootprint(taperedBox(1.8, 0.2, 1.8, 1), 1, 1, { fillHeight: 0.95 });
    expect(boxOf(g).max.y).toBeCloseTo(0.95, 3);
  });

  it("collapses a degenerate footprint to a point instead of dividing by zero", () => {
    const g = fitFootprint(taperedBox(1, 1, 1), 0, 0);
    expect(boxOf(g).max.x).toBeCloseTo(0, 6);
    expect(allFinite(g)).toBe(true);
  });

  it("overshoots the height budget when it grows a model already off the ground", () => {
    // KNOWN DEFECT (the phoenix in the roster, 16% over its 2.5 m height):
    // the fillHeight branch scales about the model's own bottom instead of the
    // ground plane, so a hull floating at y = 0.7 is scaled 1.53x and ends at
    // y = 2.55 for a 2.15 m budget. Pinned here, not fixed.
    const g = fitFootprint(taperedBox(1, 1.21, 1, 1).translate(0, 0.7, 0), 0.75, 2.15);
    expect(boxOf(g).max.y).toBeCloseTo(2.549, 2);
  });

  it("returns the same geometry instance it was handed", () => {
    const src = taperedBox(1, 1, 1);
    expect(fitFootprint(src, 1, 1)).toBe(src);
  });
});

describe("UV_METRES", () => {
  it("is applied as a multiplier, so one UV unit spans 2 m, not 0.5 m", () => {
    // KNOWN DEFECT: the constant is documented as "world metres covered by
    // one texture tile" (0.5 m) but is used as a per-metre multiplier
    // (uv = position * 0.5), which puts the repeat at 1 / 0.5 = 2 m — the
    // procedural textures are stretched 4x finer... rather 4x coarser than
    // documented. Pinned, not fixed.
    expect(UV_METRES).toBeCloseTo(0.5, 6);
    const uv = taperedBox(2, 2, 2, 1, UV_METRES).getAttribute("uv");
    let max = -Infinity;
    for (let i = 0; i < uv.count; i++) max = Math.max(max, uv.getX(i), uv.getY(i));
    // The 2 m tall side face projects onto y: 2 m * 0.5 = 1 UV unit.
    expect(max).toBeCloseTo(1, 5);
  });
});

describe("degenerate inputs", () => {
  /**
   * Every primitive is expected to survive zero and negative dimensions with a
   * usable (if flat) buffer rather than throw or emit NaN. These are the
   * outcomes verified against the current implementation.
   */
  const degenerate: [string, () => THREE.BufferGeometry][] = [
    ["taperedBox zero width", () => taperedBox(0, 1, 1)],
    ["taperedBox zero height", () => taperedBox(1, 0, 1)],
    ["taperedBox negative width", () => taperedBox(-1, 1, 1)],
    ["taperedBox negative topScale", () => taperedBox(1, 1, 1, -1)],
    ["taperedBox zero topScale", () => taperedBox(1, 1, 1, 0)],
    ["beveledBox all zero", () => beveledBox(0, 0, 0)],
    ["beveledBox over-large bevel", () => beveledBox(1, 1, 1, 5)],
    ["chamferedCylinder all zero", () => chamferedCylinder(0, 0, 0)],
    ["chamferedCylinder zero segments", () => chamferedCylinder(1, 1, 1, 0)],
    ["truncatedPyramid all zero", () => truncatedPyramid(0, 0, 0, 0, 0)],
    ["hexPrism all zero", () => hexPrism(0, 0)],
    ["octahedron zero", () => octahedron(0)],
    ["octahedron negative", () => octahedron(-1)],
    ["cone zero height", () => cone(1, 0)],
    ["cone zero radius", () => cone(0, 1)],
    ["torusSegment all zero", () => torusSegment(0, 0, 0, 0, 0)],
    ["sphereLowPoly zero", () => sphereLowPoly(0)],
    ["capsule zero", () => capsule(0, 0)],
    ["capsule negative length", () => capsule(1, -5)],
    ["wingShape all zero", () => wingShape(0, 0, 0)],
    ["wingShape zero span", () => wingShape(0, 1, 0.1)],
    ["treadedBlock all zero", () => treadedBlock(0, 0, 0)],
    ["treadedBlock negative treads", () => treadedBlock(2, 1, 3, -5)],
    ["panelLineOverlay no lines", () => panelLineOverlay(1, 1, 1, { lines: 0 })],
  ];

  it.each(degenerate)("%s yields a finite, non-empty buffer (or throws clearly)", (_name, build) => {
    let g: THREE.BufferGeometry | null = null;
    let error: string | null = null;
    try {
      g = build();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (g) {
      expect(verts(g)).toBeGreaterThan(0);
      expect(allFinite(g)).toBe(true);
      g.computeBoundingSphere();
      expect(Number.isFinite(g.boundingSphere?.radius)).toBe(true);
    } else {
      // The only sanctioned failure names the parameter that was wrong.
      expect(error).toMatch(/panelLineOverlay/);
    }
  });

  it("a very large greeble count stays finite and adds exactly that many blocks", () => {
    const g = greeble(taperedBox(1, 1, 1), 500, 0.1, 1);
    expect(verts(g)).toBe(verts(taperedBox(1, 1, 1)) + 500 * 36);
    expect(allFinite(g)).toBe(true);
  });
});
