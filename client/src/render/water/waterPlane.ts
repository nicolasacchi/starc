/**
 * Water plane — a camera-centred polar grid at the water line.
 *
 * PROVENANCE OF ASSETS: none. The geometry is generated here; the material is
 * waterMaterial.ts, which builds its own textures procedurally.
 *
 * A polar grid rather than a uniform one because the water is a huge, nearly
 * flat sheet: a uniform grid fine enough for the metre-scale chop at the
 * camera's feet would be tens of millions of triangles at the horizon, while a
 * polar grid puts 0.2 m triangles under the camera and 8 m ones 200 m out for
 * 28k triangles total. The grid is re-centred on the camera every frame, and
 * because the wave phase is a function of world position, moving the grid moves
 * the tessellation and not the surface — there is nothing to swim.
 *
 * It is lifted three centimetres above the terrain's zero plane so it is never
 * coplanar with the flat map border; see WATER_SURFACE_LIFT.
 */
import * as THREE from "three";
import type { MapDef } from "@shared/protocol";
import type { QualitySettings } from "@render/core/quality";
import { TERRAIN_WATER_LEVEL } from "@render/terrain/terrainMaterial";
import { createWaterMaterial, WATER_SURFACE_LIFT, type WaterMaterialHandle } from "@render/water/waterMaterial";
import type { SkySource } from "@render/sky/skyMaterial";

/** How far the water reaches past the camera, in metres. */
const WATER_RADIUS = 900;
/** Concentric rings. */
const RINGS = 110;
/** Segments per ring. */
const SEGMENTS = 128;
/**
 * The refractive copy is rendered at half the drawing buffer: it is about to be
 * offset and absorbed, so full resolution buys nothing and costs a second full
 * scene pass at 4x the pixels.
 */
const REFRACTION_SCALE = 0.5;

/**
 * A polar grid, radius distributed as the square of the ring index: fine under
 * the camera, coarse at the horizon, 28k triangles for the whole sea.
 */
function buildPolarGrid(): THREE.BufferGeometry {
  const vertexCount = (RINGS + 1) * (SEGMENTS + 1);
  const positions = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(RINGS * SEGMENTS * 6);

  let v = 0;
  for (let i = 0; i <= RINGS; i++) {
    const radius = WATER_RADIUS * Math.pow(i / RINGS, 2);
    for (let j = 0; j <= SEGMENTS; j++) {
      const angle = (j / SEGMENTS) * Math.PI * 2;
      positions[v * 3] = Math.cos(angle) * radius;
      positions[v * 3 + 1] = 0;
      positions[v * 3 + 2] = Math.sin(angle) * radius;
      v++;
    }
  }

  const stride = SEGMENTS + 1;
  let k = 0;
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEGMENTS; j++) {
      const inner = i * stride + j;
      const outer = (i + 1) * stride + j;
      const innerNext = inner + 1;
      const outerNext = outer + 1;
      // Counter-clockwise seen from above, so the surface faces the sky.
      indices[k++] = inner;
      indices[k++] = outerNext;
      indices[k++] = outer;
      indices[k++] = inner;
      indices[k++] = innerNext;
      indices[k++] = outerNext;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.name = "water.grid";
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

export interface WaterPlane {
  readonly mesh: THREE.Mesh;
  readonly material: WaterMaterialHandle;
  /**
   * Advances the waves and re-centres the grid. Pass `capture` to also refresh
   * the refracted-seabed texture; it is skipped entirely when the preset has no
   * post effects, which is where the render target would have been paid for.
   */
  update(
    elapsedSeconds: number,
    cameraPosition: THREE.Vector3,
    capture?: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.Camera },
  ): void;
  dispose(): void;
}

export function createWaterPlane(
  scene: THREE.Scene,
  map: MapDef,
  settings: QualitySettings,
  sky?: SkySource,
): WaterPlane {
  const handle = createWaterMaterial(map, settings, sky);
  const geometry = buildPolarGrid();
  const mesh = new THREE.Mesh(geometry, handle.material);
  mesh.name = `water.${map.id}`;
  mesh.position.set(map.size * 0.5, TERRAIN_WATER_LEVEL + WATER_SURFACE_LIFT, map.size * 0.5);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  scene.add(mesh);

  // The refractive copy is only ever built when the preset pays for post
  // effects; on low there is no second scene pass at all.
  const refract = settings.postFx;
  let target: THREE.WebGLRenderTarget | null = null;
  const bufferSize = new THREE.Vector2();

  const ensureTarget = (): THREE.WebGLRenderTarget => {
    const w = Math.max(2, Math.floor(bufferSize.x * REFRACTION_SCALE));
    const h = Math.max(2, Math.floor(bufferSize.y * REFRACTION_SCALE));
    if (!target || target.width !== w || target.height !== h) {
      target?.dispose();
      target = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
        stencilBuffer: false,
        type: THREE.HalfFloatType,
      });
      target.texture.name = "water.refraction";
    }
    return target;
  };

  return {
    mesh,
    material: handle,
    update(elapsedSeconds, cameraPosition, capture): void {
      mesh.position.set(cameraPosition.x, TERRAIN_WATER_LEVEL + WATER_SURFACE_LIFT, cameraPosition.z);
      if (capture && refract) {
        capture.renderer.getDrawingBufferSize(bufferSize);
        handle.setFrame(elapsedSeconds, bufferSize.x, bufferSize.y);
        // Taken with the water hidden, so what it holds is the world behind
        // the water: terrain, seabed, units, buildings.
        const copy = ensureTarget();
        mesh.visible = false;
        const previous = capture.renderer.getRenderTarget();
        capture.renderer.setRenderTarget(copy);
        capture.renderer.render(capture.scene, capture.camera);
        capture.renderer.setRenderTarget(previous);
        mesh.visible = true;
        handle.setRefractionTexture(copy.texture);
        return;
      }
      handle.setFrame(elapsedSeconds, 1, 1);
    },
    dispose(): void {
      scene.remove(mesh);
      geometry.dispose();
      handle.dispose();
      target?.dispose();
      target = null;
    },
  };
}
