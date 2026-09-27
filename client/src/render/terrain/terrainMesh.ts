/**
 * Terrain geometry — a CDLOD geometry clipmap on a single mesh.
 *
 * The whole surface is one `BufferGeometry` holding one centre block plus `N`
 * concentric square rings, each level twice the cell size and twice the extent
 * of the one inside it. All levels share a single snapped origin, so re-centring
 * on the camera is one `position.set` — no vertex is ever touched on the CPU
 * after boot. Displacement happens in the vertex shader by sampling the packed
 * height field (see terrainMaterial.ts), so the 145k-vertex buffer costs one
 * texture fetch per vertex rather than a 145k-iteration JS loop.
 *
 * WHY THERE ARE NO SEAMS: every level is the same `2n × 2n` grid at twice the
 * cell size of the level inside it, and the solid centre block is built at
 * that same `2n` size, so each level's outer edge lands exactly on the inner
 * edge of the level around it with no annulus left uncovered. Each level's
 * outer band is then morphed onto its parent grid (twice its own cell size) in
 * the vertex shader, so at the end of the band the two surfaces meet on
 * shared vertices sampling the same texels of the same height field — no gap,
 * no overlap, no stitching skirt. Because the snap origin is a whole number of
 * the coarsest cell, every level's grid is aligned to the others, so the morph
 * needs no per-level uniform.
 */
import * as THREE from "three";
import type { MapDef } from "@shared/protocol";
import type { QualitySettings } from "@render/core/quality";
import { heightField } from "@render/terrain/heightfield";
import {
  createTerrainMaterial,
  createTerrainDepthMaterial,
  type TerrainMaterialHandle,
} from "@render/terrain/terrainMaterial";

/**
 * How far from the camera the terrain must still be drawn, in metres. The
 * client renders fog at `map.fog_density × FOG_DENSITY_SCALE` (see
 * core/scene.ts), which puts grassland at 95% extinction near 400 m, so the
 * clipmap has to reach past that or the world ends in a visible edge.
 */
const COVER_RADIUS = 480;

/**
 * Total clipmap cells across all levels; 200k cells ≈ 400k triangles. The
 * centre block is `2n × 2n` (see buildLevel) so that it exactly fills the hole
 * of ring 1, which is why this is larger than the ring-only accounting it
 * replaced — the old shape was cheap because it left an annulus of missing
 * ground around the focus point.
 */
const CELL_BUDGET = 200_000;

/** Rings a preset may add on top of its own `terrainLodRings` for coverage. */
const MAX_RINGS = 4;

export interface ClipmapConfig {
  /** Finest cell size in metres. Matches the height field's own lattice. */
  readonly cell0: number;
  /** Cells per level side — the clipmap's one resolution knob. */
  readonly levelCells: number;
  /** Concentric rings around the centre block. */
  readonly ringCount: number;
  readonly coverRadius: number;
}

/**
 * Resolves a preset to a clipmap shape. Resolution comes from
 * `settings.terrainLodRings` (2, 3, 4, 5 on the four presets); the ring count
 * is then trimmed until the level fits `CELL_BUDGET`, added back while the
 * budget allows to reach `COVER_RADIUS`, and only then is the centre block
 * coarsened as a last resort.
 *
 * Order matters. A ring costs `3·cells²` cells and doubles the covered
 * radius; a coarser `levelCells` doubles the radius too but throws away the
 * metre-resolution centre that the height field's own lattice is built on. So
 * rings first, and the fallback that coarsens the centre is only reached on a
 * preset that cannot afford another ring at all.
 */
export function resolveClipmap(settings: QualitySettings): ClipmapConfig {
  const rings = settings.terrainLodRings;
  let levelCells = rings >= 5 ? 144 : rings >= 4 ? 128 : rings >= 3 ? 96 : 64;
  // The solid centre block is `2n × 2n` and every ring is `(2n)² − n²`.
  const cellsFor = (count: number): number => levelCells * levelCells * (4 + 3 * count);
  let ringCount = Math.min(3, Math.max(1, rings));
  while (ringCount > 1 && cellsFor(ringCount) > CELL_BUDGET) ringCount--;
  // Coverage next, cheapest way first: one more ring rather than a coarser
  // centre block.
  while (ringCount < MAX_RINGS && levelCells * Math.pow(2, ringCount) < COVER_RADIUS) {
    if (cellsFor(ringCount + 1) > CELL_BUDGET) break;
    ringCount++;
  }
  // Last resort, and the loop that always terminates: `levelCells * 2^ringCount`
  // grows with every step.
  while (levelCells * Math.pow(2, ringCount) < COVER_RADIUS) levelCells += 2;
  return { cell0: 1, levelCells, ringCount, coverRadius: COVER_RADIUS };
}

interface LevelGeometry {
  positions: Float32Array;
  levels: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
}

/**
 * One clipmap level as a local-space grid. Every level is a `2·n × 2·n` grid
 * of `n`-cell blocks; level 0 keeps all of it, and every other level drops the
 * central `n × n` block, which is exactly the extent of the level inside it.
 * Building level 0 at the same `2n` size is what makes it fill ring 1's hole
 * rather than stop half way and leave an annulus of missing ground.
 */
function buildLevel(level: number, n: number, cell0: number, hollow: boolean): LevelGeometry {
  const cells = n * 2;
  const cell = cell0 * Math.pow(2, level);
  const verts = cells + 1;
  const hole = n * 0.5; // the inner level's half extent, in this level's cells
  const inHole = (i: number, j: number): boolean =>
    hollow && i >= hole && i < hole * 3 && j >= hole && j < hole * 3;

  const used = new Uint8Array(verts * verts);
  let cellCount = 0;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      if (inHole(i, j)) continue;
      cellCount++;
      used[j * verts + i] = 1;
      used[j * verts + i + 1] = 1;
      used[(j + 1) * verts + i] = 1;
      used[(j + 1) * verts + i + 1] = 1;
    }
  }

  const remap = new Int32Array(verts * verts);
  let vertexCount = 0;
  for (let k = 0; k < used.length; k++) {
    if (used[k] === 1) remap[k] = vertexCount++;
  }

  const half = (cells * cell) / 2;
  const positions = new Float32Array(vertexCount * 3);
  const levels = new Float32Array(vertexCount);
  for (let j = 0; j < verts; j++) {
    for (let i = 0; i < verts; i++) {
      const r = remap[j * verts + i];
      if (r < 0) continue;
      positions[r * 3] = -half + i * cell;
      positions[r * 3 + 1] = 0;
      positions[r * 3 + 2] = -half + j * cell;
      levels[r] = level;
    }
  }

  // Winding is counter-clockwise seen from +Y so the surface faces the sky.
  const indices = new Uint32Array(cellCount * 6);
  let w = 0;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      if (inHole(i, j)) continue;
      const a = remap[j * verts + i];
      const b = remap[j * verts + i + 1];
      const c = remap[(j + 1) * verts + i + 1];
      const d = remap[(j + 1) * verts + i];
      indices[w++] = a;
      indices[w++] = c;
      indices[w++] = b;
      indices[w++] = a;
      indices[w++] = d;
      indices[w++] = c;
    }
  }

  return { positions, levels, indices, vertexCount };
}

/** All levels of a clipmap concatenated into one geometry. */
export function createClipmapGeometry(config: ClipmapConfig): THREE.BufferGeometry {
  const n = config.levelCells;
  const levels: LevelGeometry[] = [];
  for (let level = 0; level <= config.ringCount; level++) {
    levels.push(buildLevel(level, n, config.cell0, level > 0));
  }

  let vertexTotal = 0;
  let indexTotal = 0;
  for (const l of levels) {
    vertexTotal += l.vertexCount;
    indexTotal += l.indices.length;
  }

  const positions = new Float32Array(vertexTotal * 3);
  const levelAttr = new Float32Array(vertexTotal);
  const indices = new Uint32Array(indexTotal);
  let vOff = 0;
  let iOff = 0;
  for (const l of levels) {
    positions.set(l.positions, vOff * 3);
    levelAttr.set(l.levels, vOff);
    for (let i = 0; i < l.indices.length; i++) indices[iOff + i] = l.indices[i] + vOff;
    vOff += l.vertexCount;
    iOff += l.indices.length;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.name = "terrain.clipmap";
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aLevel", new THREE.BufferAttribute(levelAttr, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

export interface Terrain {
  readonly mesh: THREE.Mesh;
  readonly config: ClipmapConfig;
  /** Re-centres the clipmap on the camera target. Snapped, so it is a no-op until it moves. */
  update(cameraTargetX: number, cameraTargetZ: number): void;
  dispose(): void;
}

export function buildTerrain(scene: THREE.Scene, map: MapDef, settings: QualitySettings): Terrain {
  const config = resolveClipmap(settings);
  const geometry = createClipmapGeometry(config);
  const handle: TerrainMaterialHandle = createTerrainMaterial(map, settings, {
    cell0: config.cell0,
    ringCount: config.ringCount,
    levelCells: config.levelCells,
  });

  const mesh = new THREE.Mesh(geometry, handle.material);
  mesh.name = `terrain.${map.id}`;
  mesh.receiveShadow = true;
  mesh.castShadow = settings.shadowMapSize > 0;
  // The shadow pass runs a different material, so the vertex displacement and
  // the clipmap morph have to be injected there too or the terrain would cast
  // the shadow of a flat plane.
  const depthMaterial = createTerrainDepthMaterial(map, handle);
  mesh.customDepthMaterial = depthMaterial;
  mesh.raycast = makeHeightFieldRaycast(map, mesh);
  scene.add(mesh);

  // Every level's grid has to stay nested on the shared origin, or the CDLOD
  // morph in the vertex shader lands a level's outer band between its parent's
  // vertices instead of on them. The coarsest cell is the binding constraint.
  const snap = config.cell0 * Math.pow(2, config.ringCount);
  let snapX = Number.NaN;
  let snapZ = Number.NaN;

  // Start centred on the map so the very first frame is already correct,
  // before the render loop has called update() even once.
  const recentre = (cameraTargetX: number, cameraTargetZ: number): void => {
    const x = Math.floor(cameraTargetX / snap) * snap;
    const z = Math.floor(cameraTargetZ / snap) * snap;
    if (x === snapX && z === snapZ) return;
    snapX = x;
    snapZ = z;
    mesh.position.set(x, 0, z);
  };
  recentre(map.size * 0.5, map.size * 0.5);

  return {
    mesh,
    config,
    update(cameraTargetX: number, cameraTargetZ: number): void {
      recentre(cameraTargetX, cameraTargetZ);
    },
    dispose(): void {
      scene.remove(mesh);
      mesh.customDepthMaterial = undefined;
      geometry.dispose();
      depthMaterial.dispose();
      handle.dispose();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Picking                                                            */
/* ------------------------------------------------------------------ */

const hitPoint = new THREE.Vector3();
const hitNormal = new THREE.Vector3();

/**
 * The clipmap has no CPU-side geometry — the surface only exists once the
 * vertex shader has run — so `Mesh.raycast` would test a flat plane and report
 * the wrong point for every ground click and every box-select corner. This
 * marches the authoritative height field instead, which is both exact and
 * cheaper than 300k triangles.
 */
function makeHeightFieldRaycast(map: MapDef, mesh: THREE.Mesh): THREE.Mesh["raycast"] {
  const field = heightField(map);
  let maxHeight = 0;
  for (let i = 0; i < field.grid.length; i++) {
    if (field.grid[i] > maxHeight) maxHeight = field.grid[i];
  }

  return (raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void => {
    const { origin, direction } = raycaster.ray;
    if (direction.y > -1e-6 && origin.y > maxHeight) return;

    const limit = Math.min(raycaster.far, 4000);
    let t = 0;
    if (origin.y > maxHeight) t = (maxHeight - origin.y) / direction.y;
    if (t > limit) return;

    let previous = origin.y + direction.y * t - field.sample(origin.x + direction.x * t, origin.z + direction.z * t);
    // Step grows with distance: a fixed 0.5 m step would need thousands of
    // samples to reach the far side of the map.
    while (t < limit) {
      const next = t + Math.max(0.5, t * 0.02);
      const px = origin.x + direction.x * next;
      const py = origin.y + direction.y * next;
      const pz = origin.z + direction.z * next;
      const above = py - field.sample(px, pz);
      if (above <= 0 && previous > 0) {
        let lo = t;
        let hi = next;
        for (let i = 0; i < 24; i++) {
          const mid = (lo + hi) * 0.5;
          const d =
            origin.y + direction.y * mid - field.sample(origin.x + direction.x * mid, origin.z + direction.z * mid);
          if (d > 0) lo = mid;
          else hi = mid;
        }
        const h = (lo + hi) * 0.5;
        hitPoint.set(origin.x + direction.x * h, origin.y + direction.y * h, origin.z + direction.z * h);
        const n = field.normal(hitPoint.x, hitPoint.z);
        hitNormal.set(n.x, n.y, n.z);
        intersects.push({ point: hitPoint.clone(), normal: hitNormal.clone(), distance: h, object: mesh });
        return;
      }
      t = next;
      previous = above;
    }
  };
}

