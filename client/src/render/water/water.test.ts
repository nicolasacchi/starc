/**
 * The water plane as the scene actually builds it.
 *
 * Both defects here were invisible from inside `waterMaterial.ts`: the shader
 * looked right in isolation while the uniform objects it evaluated came from
 * somewhere nobody wrote to, and the `USE_REFRACTION` branch was compiled in
 * with nothing ever driving `uRefractionMap`. So these tests go through
 * `SceneManager` — the only production caller — with the WebGL renderer stubbed,
 * and assert on the water mesh that ends up in the scene.
 */
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { SceneManager } from "@render/entities/sceneManager";
import { settingsFor } from "@render/core/quality";
import { GAME } from "@shared/gameData";
import type { MapDef } from "@shared/protocol";

/** A map with water, and the same map with none, for the "no sea" case. */
const WATER_MAP: MapDef = GAME.maps.find((m) => m.water) ?? GAME.maps[0];
const DRY_MAP: MapDef = GAME.maps.find((m) => !m.water) ?? GAME.maps[0];

/** What the stub renderer saw, so the tests can assert on real draws. */
interface RendererProbe {
  renderer: THREE.WebGLRenderer;
  /** One entry per `render` call: was the water mesh visible? */
  draws: { waterVisible: boolean; target: THREE.WebGLRenderTarget | null }[];
}

function makeCanvas(): HTMLCanvasElement {
  const probe = { getContext: () => ({ getExtension: () => ({ loseContext: () => undefined }) }) };
  return {
    width: 320,
    height: 200,
    clientWidth: 320,
    clientHeight: 200,
    ownerDocument: { createElement: () => probe },
    getContext: () => ({ getExtension: () => ({ loseContext: () => undefined }) }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HTMLCanvasElement;
}

function stubRenderer(): RendererProbe {
  const draws: RendererProbe["draws"] = [];
  let target: THREE.WebGLRenderTarget | null = null;
  const stub = {
    autoClear: true,
    autoClearColor: true,
    autoClearDepth: true,
    autoClearStencil: true,
    toneMapping: THREE.NoToneMapping,
    toneMappingExposure: 1,
    outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: false, type: THREE.PCFShadowMap, autoUpdate: false, needsUpdate: false },
    getPixelRatio: () => 1,
    getSize: (v: THREE.Vector2) => v.set(320, 200),
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(320, 200),
    setSize: () => undefined,
    setPixelRatio: () => undefined,
    dispose: () => undefined,
    setViewport: () => undefined,
    setScissor: () => undefined,
    setScissorTest: () => undefined,
    getScissor: (v: THREE.Vector4) => v.set(0, 0, 320, 200),
    getViewport: (v: THREE.Vector4) => v.set(0, 0, 320, 200),
    getContext: () => ({ getContextAttributes: () => ({ antialias: true }) }),
    getRenderTarget: () => target,
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => {
      target = t;
    },
    getClearColor: (c: THREE.Color) => c.setRGB(0, 0, 0),
    setClearColor: () => undefined,
    getClearAlpha: () => 1,
    setClearAlpha: () => undefined,
    clear: () => undefined,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    xr: { enabled: false, isPresenting: false },
    state: {
      buffers: {
        color: { setMask: () => undefined },
        depth: { setMask: () => undefined, setTest: () => undefined, setFunc: () => undefined },
        stencil: { setMask: () => undefined, setTest: () => undefined, setFunc: () => undefined },
      },
      setMaterial: () => undefined,
      reset: () => undefined,
    },
    capabilities: {
      isWebGL2: true,
      getMaxAnisotropy: () => 1,
      precision: "highp",
      logarithmicDepthBuffer: false,
      maxTextures: 8,
    },
    properties: { get: () => ({}) },
    info: {
      autoReset: true,
      reset: () => undefined,
      render: { calls: 0, triangles: 0, frame: 0 },
      memory: { geometries: 0, textures: 0 },
      programs: [] as unknown[],
    },
    compile: () => undefined,
    initTexture: () => undefined,
    getProgramCacheKey: () => "",
    render(scene: THREE.Scene): void {
      const water = scene.getObjectByName(`water.${WATER_MAP.id}`);
      draws.push({ waterVisible: water?.visible !== false, target });
    },
  };
  return { renderer: stub as unknown as THREE.WebGLRenderer, draws };
}

function waterOf(manager: SceneManager, map: MapDef = WATER_MAP): THREE.Mesh | null {
  const scene = (manager as unknown as { scene: THREE.Scene }).scene;
  return (scene.getObjectByName(`water.${map.id}`) as THREE.Mesh | undefined) ?? null;
}

function skyOf(manager: SceneManager): THREE.Mesh | null {
  const found = (manager as unknown as { scene: THREE.Scene }).scene.getObjectByName(
    `sky.${WATER_MAP.id}`,
  );
  return found as THREE.Mesh | null;
}

function waterUniforms(manager: SceneManager): Record<string, THREE.IUniform> {
  const mesh = waterOf(manager);
  if (mesh === null) throw new Error("no water plane was built");
  return (mesh.material as THREE.ShaderMaterial).uniforms;
}

function skyUniforms(manager: SceneManager): Record<string, THREE.IUniform> {
  const mesh = skyOf(manager);
  if (mesh === null) throw new Error("no sky dome was built");
  return (mesh.material as THREE.ShaderMaterial).uniforms;
}


// Hoisted mock: the factory runs when `createRenderer` is first called, well
// after `probe` has been assigned, so it always sees the current stub.
vi.mock("@render/core/renderer", () => ({ createRenderer: () => probe.renderer }));

let probe: RendererProbe;

function build(map: MapDef, preset: "medium" | "low" = "medium"): SceneManager {
  probe = stubRenderer();
  const manager = new SceneManager(makeCanvas(), map, settingsFor(preset), 0, preset);
  manager.update(1 / 60);
  manager.render();
  return manager;
}

describe("water in the built scene", () => {
  it("reflects the sky of the actual time of day, because it reads the dome's own uniforms", () => {
    const manager = build(WATER_MAP);
    // Past 1 the sun is down and the dome writes its night arc.
    manager.setTimeOfDay(1.4);
    manager.update(1 / 60);

    const water = waterUniforms(manager);
    const sky = skyUniforms(manager);
    // The very same uniform records, not merely equal values: the water cannot
    // drift out of step with the sky it is holding.
    expect(water.uSunDirection).toBe(sky.uSunDirection);
    expect(water.uNight).toBe(sky.uNight);
    expect(water.uSunDiscColor).toBe(sky.uSunDiscColor);
    expect(water.uNight.value).toBeGreaterThan(0);
    manager.dispose();
  });

  it("drives the refraction capture itself, so the compiled branch is never dead", () => {
    const manager = build(WATER_MAP);
    const water = waterUniforms(manager);
    const material = waterOf(manager)!.material as THREE.ShaderMaterial;

    // `USE_REFRACTION` is compiled in on a post-FX preset, so the sampler has
    // to point at a real half-resolution copy of the frame, not at the 1x1
    // stand-in — which made the shader take its opaque branch and draw mud.
    expect(material.defines?.USE_REFRACTION).toBeDefined();
    const captured = water.uRefractionMap.value as THREE.Texture;
    expect(captured.name).toBe("water.refraction");
    const resolution = water.uResolution.value as THREE.Vector2;
    expect(resolution.x).toBeGreaterThan(1);
    expect(resolution.y).toBeGreaterThan(1);

    // The capture hides the water, so what it holds is the world behind it.
    expect(probe.draws.some((d) => !d.waterVisible)).toBe(true);
    expect(probe.draws.some((d) => d.target !== null && d.target.texture.name === "water.refraction")).toBe(
      true,
    );
    manager.dispose();
  });

  it("compiles no refraction branch at all when the preset pays for no second pass", () => {
    const manager = build(WATER_MAP, "low");
    const material = waterOf(manager)!.material as THREE.ShaderMaterial;
    expect(material.defines?.USE_REFRACTION).toBeUndefined();
    expect(probe.draws.some((d) => !d.waterVisible)).toBe(false);
    manager.dispose();
  });

  it("builds no sea at all on a dry map", () => {
    const manager = build(DRY_MAP);
    expect(waterOf(manager, DRY_MAP)).toBeNull();
    manager.dispose();
  });
});
