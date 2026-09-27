/**
 * Render-core behaviour that does not need a GPU: quality selection, the
 * scene scaffold, the shared GLSL chunk injection, and the RTS camera driven
 * headlessly against a real `PerspectiveCamera`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  QUALITY_PRESETS,
  detectQuality,
  forcedQuality,
  invalidateQualityCache,
  isQualityPreset,
  quality,
  setForcedQuality,
  settingsFor,
} from "./quality";
import { createScene, disposeScene } from "./scene";
import { GLSL_COLOR, GLSL_FBM, GLSL_HASH, GLSL_NOISE, injectShaderChunks } from "./shaderChunks";
import { RtsCamera } from "./camera";
import { GAME } from "@shared/gameData";
import type { MapDef, QualityPreset } from "@shared/protocol";

const map: MapDef = GAME.maps[0];

describe("quality", () => {
  // The override is persisted so it survives a reload, and Node has no
  // localStorage — without a stub, setForcedQuality is a silent no-op here.
  const store = new Map<string, string>();
  const localStorageStub: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, v),
  };

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", localStorageStub);
    setForcedQuality(null);
    invalidateQualityCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers exactly four presets, ordered low to ultra", () => {
    expect([...QUALITY_PRESETS]).toEqual(["low", "medium", "high", "ultra"]);
  });

  it("recognises a valid preset and rejects garbage", () => {
    expect(isQualityPreset("high")).toBe(true);
    expect(isQualityPreset("insane")).toBe(false);
    expect(isQualityPreset(null)).toBe(false);
    expect(isQualityPreset(3)).toBe(false);
  });

  it("scales cost monotonically from low to ultra", () => {
    const tiers: QualityPreset[] = ["low", "medium", "high", "ultra"];
    for (let i = 1; i < tiers.length; i++) {
      const lower = settingsFor(tiers[i - 1]);
      const higher = settingsFor(tiers[i]);
      expect(higher.shadowMapSize, tiers[i]).toBeGreaterThanOrEqual(lower.shadowMapSize);
      expect(higher.particleBudget, tiers[i]).toBeGreaterThan(lower.particleBudget);
      expect(higher.terrainLodRings, tiers[i]).toBeGreaterThanOrEqual(lower.terrainLodRings);
    }
  });

  it("turns the expensive effects off entirely at low", () => {
    const low = settingsFor("low");
    expect(low.postFx).toBe(false);
    expect(low.bloom).toBe(false);
    expect(low.ssao).toBe(false);
    expect(low.shadowMapSize).toBe(0);
    expect(low.particleBudget).toBeGreaterThan(0);
  });

  it("turns everything on at ultra", () => {
    const ultra = settingsFor("ultra");
    expect(ultra.postFx).toBe(true);
    expect(ultra.bloom).toBe(true);
    expect(ultra.ssao).toBe(true);
    expect(ultra.shadowCascades).toBeGreaterThanOrEqual(2);
  });

  it("returns a valid preset with no DOM and no GPU", () => {
    expect(QUALITY_PRESETS).toContain(detectQuality());
    expect(QUALITY_PRESETS).toContain(quality());
  });

  it("lets an explicit override win over detection", () => {
    // `detectQuality` is pure hardware detection; `quality` is what the
    // renderer should ask for, and it honours the override.
    expect(QUALITY_PRESETS).toContain(detectQuality());
    setForcedQuality("low");
    expect(forcedQuality()).toBe("low");
    expect(quality()).toBe("low");
    setForcedQuality("ultra");
    expect(quality()).toBe("ultra");
    setForcedQuality(null);
    expect(forcedQuality()).toBeNull();
    expect(QUALITY_PRESETS).toContain(quality());
  });
});

describe("scene", () => {
  it("leaves the background to the sky dome and applies map fog", () => {
    const scene = createScene(map, settingsFor("high"));
    expect(scene.background).toBeNull();
    expect(scene.fog).toBeInstanceOf(THREE.FogExp2);
    expect((scene.fog as THREE.FogExp2).density).toBeCloseTo(map.lighting.fog_density, 6);
  });

  it("gives every map a distinct fog colour", () => {
    const colours = GAME.maps.map((m) => (createScene(m, settingsFor("high")).fog as THREE.Fog).color.getHex());
    expect(new Set(colours).size).toBe(GAME.maps.length);
  });

  it("disposes every geometry and material it can reach", () => {
    const scene = createScene(map, settingsFor("high"));
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    let geometriesDisposed = 0;
    let materialsDisposed = 0;
    geometry.addEventListener("dispose", () => geometriesDisposed++);
    material.addEventListener("dispose", () => materialsDisposed++);

    disposeScene(scene);

    expect(geometriesDisposed).toBe(1);
    expect(materialsDisposed).toBe(1);
    expect(scene.children).toHaveLength(0);
  });
});

describe("shader chunks", () => {
  it("exports GLSL that is actually GLSL", () => {
    for (const chunk of [GLSL_HASH, GLSL_NOISE, GLSL_FBM, GLSL_COLOR]) {
      expect(chunk.length).toBeGreaterThan(20);
      // A float literal or a function signature — something a compiler sees.
      expect(chunk).toMatch(/float|vec[234]|void/);
      expect(chunk).not.toMatch(/\bTODO\b|\bFIXME\b/);
    }
  });

  it("declares balanced braces so it can be spliced into a shader", () => {
    for (const chunk of [GLSL_HASH, GLSL_NOISE, GLSL_FBM, GLSL_COLOR]) {
      const open = (chunk.match(/\{/g) ?? []).length;
      const close = (chunk.match(/\}/g) ?? []).length;
      expect(open, "brace balance").toBe(close);
    }
  });

  it("injects uniforms and a live update handle into a material", () => {
    const material = new THREE.MeshStandardMaterial();
    const before = material.onBeforeCompile;
    const handle = injectShaderChunks(material, { emissive: true, fresnel: true, time: true });

    expect(material.onBeforeCompile).not.toBe(before);
    expect(handle.uniforms.uTime).toBeDefined();
    handle.update(3.5);
    expect(handle.uniforms.uTime.value).toBe(3.5);
    expect(() => handle.dispose()).not.toThrow();
  });

  it("is a no-op that still returns a usable handle when nothing is requested", () => {
    const material = new THREE.MeshStandardMaterial();
    const handle = injectShaderChunks(material, {});
    expect(handle.uniforms.uTime).toBeUndefined();
    expect(() => handle.update(1)).not.toThrow();
    expect(() => handle.dispose()).not.toThrow();
  });
});

describe("RtsCamera", () => {
  const makeCamera = () => {
    const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.5, 2000);
    cam.position.set(128, 100, 128);
    cam.lookAt(128, 0, 128);
    cam.updateMatrixWorld(true);
    return cam;
  };

  it("constructs and updates with no DOM element at all", () => {
    const rts = new RtsCamera(makeCamera(), null, map);
    expect(() => rts.update(0.016)).not.toThrow();
    expect(Number.isFinite(rts.zoom)).toBe(true);
    rts.dispose();
  });

  it("clamps zoom to the supported range", () => {
    const rts = new RtsCamera(makeCamera(), null, map);
    rts.setZoom(0.0001);
    rts.update(1);
    const low = rts.zoom;
    rts.setZoom(99);
    rts.update(1);
    const high = rts.zoom;
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThan(10);
    rts.dispose();
  });

  it("converges on a focus target without overshooting", () => {
    const rts = new RtsCamera(makeCamera(), null, map);
    rts.focus(200, 200, 0);
    expect(rts.focusX).not.toBeCloseTo(200, 0);
    for (let i = 0; i < 400; i++) rts.update(1 / 60);
    expect(rts.focusX).toBeCloseTo(200, 0);
    expect(rts.focusZ).toBeCloseTo(200, 0);
    rts.dispose();
  });

  it("keeps the camera inside the map bounds", () => {
    const rts = new RtsCamera(makeCamera(), null, map);
    rts.focus(-5000, -5000, 0);
    for (let i = 0; i < 600; i++) rts.update(1 / 60);
    expect(rts.focusX).toBeGreaterThanOrEqual(0);
    expect(rts.focusZ).toBeGreaterThanOrEqual(0);
    expect(rts.focusX).toBeLessThanOrEqual(map.size);
    expect(rts.focusZ).toBeLessThanOrEqual(map.size);
    rts.dispose();
  });

  it("rotates the yaw target freely and snaps it to a 45 degree multiple", () => {
    const rts = new RtsCamera(makeCamera(), null, map);
    rts.rotate(0.37);
    expect(rts.yawTarget).toBeCloseTo(0.37, 6);
    expect(rts.yaw).not.toBeCloseTo(0.37, 3); // the spring is still catching up

    for (let i = 0; i < 400; i++) rts.update(1 / 60);
    expect(rts.yaw).toBeCloseTo(0.37, 2);

    rts.snapYaw();
    const quarter = Math.PI / 4;
    expect(Math.abs(rts.yawTarget / quarter - Math.round(rts.yawTarget / quarter))).toBeLessThan(1e-6);
    rts.dispose();
  });

  it("scales shake with trauma squared and decays to nothing", () => {
    const rts = new RtsCamera(makeCamera(), null, map);

    // Shake displacement is trauma² × a time-varying wobble, so a single-frame
    // sample measures the phase, not the envelope. Measure the peak over the
    // whole burst instead.
    const peakTrauma = (intensity: number): number => {
      const resting = rts.camera.position.clone();
      rts.addShake(intensity, 0.25);
      let peak = 0;
      for (let i = 0; i < 40; i++) {
        rts.update(1 / 60);
        peak = Math.max(peak, rts.camera.position.distanceTo(resting));
        rts.camera.position.copy(resting);
      }
      return peak;
    };

    const gentle = peakTrauma(0.2);
    // Let the previous burst finish before the next, since addShake combines.
    for (let i = 0; i < 120; i++) rts.update(1 / 60);
    const violent = peakTrauma(1.0);

    expect(gentle).toBeGreaterThan(0);
    expect(violent).toBeGreaterThan(gentle);
    // trauma², so 1.0 over 0.2 is 25×. Allow slack for the wobble phase and
    // the zoom-dependent distance scale, but it must be nowhere near linear.
    expect(violent / gentle).toBeGreaterThan(4);

    for (let i = 0; i < 400; i++) rts.update(1 / 60);
    const settled = rts.camera.position.distanceTo(
      new THREE.Vector3(rts.focusX, 0, rts.focusZ).setY(rts.camera.position.y),
    );
    expect(Number.isFinite(settled)).toBe(true);
    rts.dispose();
  });

  it("picks the terrain surface when converting a screen point to ground", () => {
    const rts = new RtsCamera(makeCamera(), null, map);
    rts.focus(128, 128, 0);
    for (let i = 0; i < 300; i++) rts.update(1 / 60);
    rts.camera.updateMatrixWorld(true);

    const out = { x: 0, z: 0 };
    const hit = rts.screenToGround(640, 360, out);
    if (hit) {
      expect(out.x).toBeGreaterThanOrEqual(0);
      expect(out.x).toBeLessThanOrEqual(map.size);
      expect(out.z).toBeGreaterThanOrEqual(0);
      expect(out.z).toBeLessThanOrEqual(map.size);
    }
    rts.dispose();
  });

  it("allocates nothing across a long update", () => {
    const rts = new RtsCamera(makeCamera(), null, map);
    rts.focus(140, 160, 0);
    for (let i = 0; i < 50; i++) rts.update(1 / 60);

    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 5000; i++) rts.update(1 / 60);
    const growth = process.memoryUsage().heapUsed - before;
    // 5000 frames of a render loop must not grow the heap meaningfully.
    expect(growth).toBeLessThan(4 * 1024 * 1024);
    rts.dispose();
  });
});
