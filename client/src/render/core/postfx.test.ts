/**
 * The post-FX chain, driven headlessly against a symbolic renderer.
 *
 * The failure this guards against is an *image* failure: a bare additive
 * `ShaderPass` after the beauty stage renders into `writeBuffer`, which
 * `EffectComposer` never shields from `renderer.autoClear`, so it clears the
 * scene away and the screen ends up showing only the pass's own output. Nothing
 * about that shows up in a return value, so the test models what each pass
 * leaves in each render target and asserts what reaches the screen.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { PostFXPipeline } from "./postfx";
import { settingsFor, type QualityPreset } from "./quality";

/**
 * What a render target holds, as provenance tags: `SCENE` for a beauty render,
 * `PASS:<material>` for a full-screen pass. Enough to tell "the world is on
 * screen" from "a shaft overlay is on screen".
 */
type Contents = Set<string>;

interface ScreenRecord {
  /** Contents of every render target, so a pass's `tDiffuse` can be resolved. */
  readonly targets: Map<THREE.Texture, Contents>;
  /** What reached the default framebuffer. */
  readonly screen: Contents;
  readonly renderer: THREE.WebGLRenderer;
}

/** The material a full-screen quad is drawn with, and the two facts that matter. */
type QuadMaterial = THREE.Material & {
  blending: THREE.Blending;
  uniforms?: Record<string, THREE.IUniform>;
};

function symbolicRenderer(): ScreenRecord {
  const targets = new Map<THREE.Texture, Contents>();
  const screen: Contents = new Set();
  let current: THREE.WebGLRenderTarget | null = null;

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
    getContext: () => ({ getContextAttributes: () => ({ antialias: true }) }),
    getRenderTarget: () => current,
    setRenderTarget: (target: THREE.WebGLRenderTarget | null) => {
      current = target;
      if (target !== null && !targets.has(target.texture)) targets.set(target.texture, new Set());
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

    render(drawn: THREE.Object3D): void {
      // `autoClear` wipes the bound target first, exactly as WebGLBackground
      // does at the head of every real render.
      if (current === null) screen.clear();
      else if (stub.autoClear) targets.set(current.texture, new Set());
      const target = current === null ? screen : targets.get(current.texture)!;

      if ((drawn as THREE.Scene).isScene === true) {
        // A beauty render: the RenderPass and the composite's depth pre-pass
        // both draw the world here. (SSAOPass's normal render also goes
        // through this path, but into its own target, not the screen's.)
        target.add("SCENE");
        return;
      }

      // A full-screen quad. Its material decides what lands in the target.
      const material = (drawn as THREE.Mesh).material as QuadMaterial;
      const sampled = material.uniforms?.tDiffuse?.value;

      // The pass replaces the target unless its blending is additive or a
      // custom multiply (UnrealBloom, SSAO's dst*src), which add to what is
      // already there. `autoClear` above has just emptied the target, so a
      // replacing pass has to be handed the beauty image through `tDiffuse` —
      // and an additive one, which never reads it, throws the image away.
      target.add(`PASS:${material.name}`);

      if (sampled instanceof THREE.Texture) {
        for (const tag of targets.get(sampled) ?? []) target.add(tag);
      }
    },
  };

  return { targets, screen, renderer: stub as unknown as THREE.WebGLRenderer };
}

function renderOnce(preset: QualityPreset): Contents {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial()));
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 1400);
  camera.position.set(0, 40, 60);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const record = symbolicRenderer();
  const pipeline = new PostFXPipeline(record.renderer, scene, camera, settingsFor(preset));
  pipeline.render(1 / 60);
  pipeline.dispose();
  return record.screen;
}

describe("PostFXPipeline", () => {
  // The default preset is medium, so this is what almost every player sees.
  it.each(["medium", "high", "ultra"] as QualityPreset[])("still shows the world on %s", (preset) => {
    expect(renderOnce(preset).has("SCENE")).toBe(true);
  });

  it("draws the graded image from the beauty buffer, not from a shaft-only pass", () => {
    // The composite is what carries both the shafts and the grade, so its tag
    // being in the image is the feature surviving the fix rather than being
    // switched off.
    const screen = renderOnce("medium");
    expect(screen.has("PASS:CompositeShader")).toBe(true);
    expect(screen.has("SCENE")).toBe(true);
  });

  it("leaves a preset without post effects on the plain forward path", () => {
    const screen = renderOnce("low");
    expect(screen.has("SCENE")).toBe(true);
    expect(screen.size).toBe(1);
  });

  it("draws the scene into a depth target for the shafts' occlusion term", () => {
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial()));
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 1400);
    const record = symbolicRenderer();
    const pipeline = new PostFXPipeline(record.renderer, scene, camera, settingsFor("high"));
    pipeline.setSunDirection(new THREE.Vector3(0.3, 0.6, -0.7));
    pipeline.render(1 / 60);
    // A beauty render into a target holding nothing but the scene is the depth
    // pre-pass. Without it the composite's `tDepth` sampler is a 1x1 stub and
    // the shafts smear straight through buildings.
    const depthTargets = [...record.targets.values()].filter((c) => c.size === 1 && c.has("SCENE"));
    expect(depthTargets.length).toBeGreaterThan(0);
    pipeline.dispose();
  });
});
