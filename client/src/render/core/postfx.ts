/**
 * Post-processing chain.
 *
 * Order: SSAO → render → bloom → god rays → composite → SMAA. The god rays and
 * the grade (chromatic aberration + vignette + grain + sharpen) are two custom
 * `ShaderPass`es written for this game; the grade deliberately fuses four
 * effects into one fragment shader because four full-screen passes cost four
 * bandwidth-bound round trips for what is a few dozen ALU ops.
 *
 * Everything is optional and driven by `QualitySettings`; with `postFx` off the
 * pipeline is a pass-through that calls `renderer.render` directly, which is the
 * only sane path on the low preset.
 */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { QualitySettings } from "./quality";

const BLOOM_STRENGTH = 0.55;
const BLOOM_RADIUS = 0.5;
const BLOOM_THRESHOLD = 0.85;

/**
 * Calls `dispose()` when the object has one. Several three passes implement it
 * at runtime without declaring it in @types/three, and EffectComposer declares
 * one it does not implement, so a structural optional call is the only call
 * that is both safe and type-clean.
 */
function release(pass: object | null): void {
  (pass as { dispose?: () => void } | null)?.dispose?.();
}

/* ------------------------------------------------------------------ */
/* God rays — radial blur toward the sun, masked by occlusion           */
/* ------------------------------------------------------------------ */

/**
 * Screen-space radial blur from the sun's projected position, with a
 * depth-aware occlusion term so a building in front of the sun actually cuts
 * the shafts instead of smearing through it. Dithered start offsets kill the
 * banding that a 24-tap blur otherwise produces.
 */
export const GodRaysShader = {
  name: "GodRaysShader",
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uSunPosition: { value: new THREE.Vector2(0.5, 0.5) },
    uSunVisible: { value: 1 },
    uDensity: { value: 0.92 },
    uDecay: { value: 0.955 },
    uWeight: { value: 0.42 },
    uExposure: { value: 0.34 },
    uSamples: { value: 24 },
    uSunDepth: { value: 1e6 },
    uUseDepth: { value: 1 },
    uTime: { value: 0 },
    uAspect: { value: 1.777 },
  },
  // Both passes are authored as GLSL ES 3.00 and the materials are tagged
  // `glslVersion: GLSL3` at build time, so WebGL2 compiles them natively.
  vertexShader: /* glsl */ `
    out vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    precision highp int;

    layout(location = 0) out vec4 fragColor;

    in vec2 vUv;

    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uSunPosition;
    uniform float uSunVisible;
    uniform float uDensity;
    uniform float uDecay;
    uniform float uWeight;
    uniform float uExposure;
    uniform int uSamples;
    uniform float uCameraNear;
    uniform float uCameraFar;
    uniform float uSunDepth;
    uniform float uUseDepth;
    uniform float uTime;
    uniform float uAspect;

    const int MAX_SAMPLES = 32;

    float linearDepth(float d) {
      float z = d * 2.0 - 1.0;
      return (2.0 * uCameraNear * uCameraFar) / (uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear));
    }

    float interleavedGradientNoise(vec2 p) {
      return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
    }

    void main() {
      // Aspect-corrected delta keeps the shafts circular on a wide viewport.
      vec2 delta = (vUv - uSunPosition) * (uDensity / float(uSamples));
      delta.x *= uAspect;
      vec2 uv = vUv;

      // Per-pixel start offset: turns the banding of a 24-tap blur into fine
      // noise, which the grade's grain then absorbs.
      float jitter = interleavedGradientNoise(gl_FragCoord.xy + fract(uTime) * 37.0);

      float surfaceDepth = linearDepth(texture(tDepth, vUv).x);
      float illumination = 1.0;
      float weight = 1.0;
      vec3 shafts = vec3(0.0);

      for (int i = 0; i < MAX_SAMPLES; i++) {
        if (i >= uSamples) break;
        uv -= delta * jitter;
        vec3 sampled = texture(tDiffuse, uv).rgb;
        float sampleDepth = linearDepth(texture(tDepth, uv).x);
        float brightness = dot(sampled, vec3(0.2126, 0.7152, 0.0722));

        // Depth mode: a sample contributes only if it is behind the surface
        // being shaded and in front of the sun, so a tower really does cast a
        // shadow through the shafts. Luminance mode (medium preset, no depth
        // target) approximates the same thing by scattering only bright pixels,
        // which is the classic screen-space god ray and costs nothing extra.
        float depthGate = step(surfaceDepth - 0.05, sampleDepth) * step(sampleDepth, uSunDepth);
        float lumaGate = smoothstep(0.65, 1.0, brightness);
        float gate = mix(lumaGate, depthGate, uUseDepth);
        shafts += sampled * illumination * gate * weight;
        illumination *= uDecay;
      }

      shafts *= (uExposure / float(uSamples)) * uWeight * 2.0;

      // Fade out as the sun leaves the frame so the shafts never pop.
      vec2 offscreen = max(abs(uSunPosition - 0.5) - 0.5, 0.0);
      float onScreen = uSunVisible * (1.0 - smoothstep(0.0, 0.5, length(offscreen * vec2(uAspect, 1.0))));

      fragColor = vec4(shafts * onScreen, 1.0);
    }
  `,
};

/* ------------------------------------------------------------------ */
/* Composite grade — CA + vignette + grain + sharpen, in one pass       */
/* ------------------------------------------------------------------ */

export const CompositeShader = {
  name: "CompositeShader",
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1280, 720) },
    uAberration: { value: 0.0016 },
    uVignette: { value: 0.32 },
    uGrain: { value: 0.035 },
    uSharpen: { value: 0.22 },
    uSaturation: { value: 1.06 },
    uTime: { value: 0 },
  },
  vertexShader: GodRaysShader.vertexShader,
  fragmentShader: /* glsl */ `
    precision highp float;
    precision highp int;

    layout(location = 0) out vec4 fragColor;

    in vec2 vUv;

    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uAberration;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uSharpen;
    uniform float uSaturation;
    uniform float uTime;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 texel = 1.0 / uResolution;
      vec2 centered = vUv - 0.5;
      float radius2 = dot(centered, centered);

      // Lateral chromatic aberration: the split scales with r², like a real
      // lens, so the middle of the screen stays clean.
      vec2 shift = centered * radius2 * uAberration;
      vec3 color;
      color.r = texture(tDiffuse, vUv + shift).r;
      color.g = texture(tDiffuse, vUv).g;
      color.b = texture(tDiffuse, vUv - shift).b;

      // Unsharp mask on luminance only: chroma noise is far more visible.
      vec3 blur = (
        texture(tDiffuse, vUv + vec2(texel.x, 0.0)).rgb +
        texture(tDiffuse, vUv - vec2(texel.x, 0.0)).rgb +
        texture(tDiffuse, vUv + vec2(0.0, texel.y)).rgb +
        texture(tDiffuse, vUv - vec2(0.0, texel.y)).rgb
      ) * 0.25;
      vec3 detail = (color - blur) * uSharpen;
      // Only sharpen what is already bright enough to show the difference.
      color += detail * smoothstep(0.25, 0.9, dot(color, vec3(0.2126, 0.7152, 0.0722)));

      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(luma), color, uSaturation);

      // Vignette: a smooth cos^4-ish falloff, gentle enough to stay cinematic.
      float vignette = 1.0 - uVignette * smoothstep(0.15, 0.75, radius2);
      color *= vignette;

      // Film grain, scaled down in the highlights so skies do not fizz.
      float grain = hash12(gl_FragCoord.xy + fract(uTime) * 511.0) - 0.5;
      color += grain * uGrain * (1.0 - luma * 0.6);

      fragColor = vec4(max(color, vec3(0.0)), 1.0);
    }
  `,
};

export class PostFXPipeline {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly settings: QualitySettings;

  private composer: EffectComposer | null = null;
  private ssao: SSAOPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private godRays: ShaderPass | null = null;
  private composite: ShaderPass | null = null;
  private smaa: SMAAPass | null = null;
  private output: OutputPass | null = null;

  /** Depth target the god-ray pass samples for its occlusion term. */
  private depthTarget: THREE.WebGLRenderTarget | null = null;
  /** Only the presets that already pay for an extra pass can afford this. */
  private readonly depthOcclusion: boolean;

  private readonly scratchSize = new THREE.Vector2();
  private readonly scratchProjected = new THREE.Vector3();
  private readonly scratchForward = new THREE.Vector3();
  private elapsed = 0;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, settings: QualitySettings) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.settings = settings;
    this.depthOcclusion = settings.ssao;
    if (settings.postFx) this.build();
  }

  private build(): void {
    const renderer = this.renderer;
    renderer.getDrawingBufferSize(this.scratchSize);
    const width = Math.max(1, Math.floor(this.scratchSize.x));
    const height = Math.max(1, Math.floor(this.scratchSize.y));

    this.composer = new EffectComposer(renderer);
    this.composer.setPixelRatio(renderer.getPixelRatio());
    this.composer.setSize(width, height);

    // SSAOPass renders the beauty buffer itself, so a RenderPass behind it
    // would throw that work away and pay for it twice. With SSAO on it takes
    // the first slot; without it the plain RenderPass does.
    if (this.settings.ssao) {
      this.ssao = new SSAOPass(this.scene, this.camera, width, height);
      this.ssao.kernelRadius = 12;
      this.ssao.minDistance = 0.002;
      this.ssao.maxDistance = 0.12;
      this.composer.addPass(this.ssao);
    } else {
      this.composer.addPass(new RenderPass(this.scene, this.camera));
    }

    if (this.settings.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(width, height), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
      this.composer.addPass(this.bloom);
    }

    // Depth for the god-ray occlusion test. A depth-only geometry pass costs a
    // second draw of the scene, which only the high presets can afford; the
    // medium preset falls back to the shader's luminance occlusion and gets a
    // 1x1 stub so the sampler is never left unbound.
    this.depthTarget = new THREE.WebGLRenderTarget(
      this.depthOcclusion ? width : 1,
      this.depthOcclusion ? height : 1,
      {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
        stencilBuffer: false,
      },
    );
    this.depthTarget.depthTexture = new THREE.DepthTexture(
      this.depthOcclusion ? width : 1,
      this.depthOcclusion ? height : 1,
      THREE.UnsignedIntType,
    );

    this.godRays = new ShaderPass(GodRaysShader);
    this.godRays.uniforms.uAspect.value = width / height;
    this.godRays.uniforms.uUseDepth.value = this.depthOcclusion ? 1 : 0;
    this.godRays.uniforms.tDepth.value = this.depthTarget.depthTexture;
    // The pass only produces light: it adds to whatever is already in the
    // buffer instead of replacing it.
    this.godRays.material.glslVersion = THREE.GLSL3;
    this.godRays.material.blending = THREE.AdditiveBlending;
    this.godRays.material.transparent = true;
    this.composer.addPass(this.godRays);

    this.composite = new ShaderPass(CompositeShader);
    this.composite.uniforms.uResolution.value.set(width, height);
    this.composite.material.glslVersion = THREE.GLSL3;
    this.composer.addPass(this.composite);

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    // The context has MSAA off below `high`, so SMAA is what cleans the unit
    // silhouettes up there; above it the hardware resolve already did the job.
    if (renderer.getContext().getContextAttributes()?.antialias !== true) {
      this.smaa = new SMAAPass();
      this.composer.addPass(this.smaa);
    }
  }

  setSize(w: number, h: number): void {
    const width = Math.max(1, Math.floor(w));
    const height = Math.max(1, Math.floor(h));
    this.composer?.setSize(width, height);
    if (this.depthOcclusion) this.depthTarget?.setSize(width, height);
    this.ssao?.setSize(width, height);
    this.bloom?.setSize(width, height);
    if (this.composite) this.composite.uniforms.uResolution.value.set(width, height);
    if (this.godRays) this.godRays.uniforms.uAspect.value = width / height;
  }


  /**
   * Feeds the god-ray pass the sun's screen position for this frame. `depth` is
   * the sun's view-space distance; an infinitely distant sun stays at the far
   * plane, which is what the shader wants for "nothing occludes it".
   */
  setSunScreenPosition(x: number, y: number, visible: boolean, depth = Number.POSITIVE_INFINITY): void {
    if (!this.godRays) return;
    const uniforms = this.godRays.uniforms;
    (uniforms.uSunPosition.value as THREE.Vector2).set(x, y);
    uniforms.uSunVisible.value = visible ? 1 : 0;
    uniforms.uSunDepth.value = Number.isFinite(depth) ? depth : 1e6;
    if (this.camera instanceof THREE.PerspectiveCamera) {
      uniforms.uCameraNear.value = this.camera.near;
      uniforms.uCameraFar.value = this.camera.far;
    }
  }

  /**
   * Projects a world-space sun *direction* (pointing towards the sun) to the
   * screen and forwards it. The sun is infinitely far away, so the direction
   * doubles as a position offset.
   */
  setSunDirection(sunDirection: THREE.Vector3): void {
    if (!this.godRays) return;
    this.scratchForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.scratchForward.negate();
    this.scratchProjected.copy(sunDirection).normalize();
    // dot(forward, toSun) > 0 means the sun is behind the camera.
    const behind = this.scratchForward.dot(this.scratchProjected) <= 0;
    this.scratchProjected.multiplyScalar(10000).add(this.camera.position).project(this.camera);
    this.setSunScreenPosition(this.scratchProjected.x * 0.5 + 0.5, this.scratchProjected.y * 0.5 + 0.5, !behind);
  }

  render(deltaSeconds: number): void {
    const composer = this.composer;
    if (!composer) {
      // No post chain on this preset: one forward render and done.
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.elapsed += THREE.MathUtils.clamp(deltaSeconds, 0, 0.1);

    if (this.godRays) {
      // The composer's targets do not expose depth, so the god-ray pass gets
      // its own depth-only geometry pass. Skipped on the medium preset, which
      // falls back to the shader's luminance occlusion.
      if (this.depthOcclusion) {
        this.renderer.setRenderTarget(this.depthTarget);
        this.renderer.clear(false, true, false);
        this.renderer.render(this.scene, this.camera);
        this.renderer.setRenderTarget(null);
      }
      this.godRays.uniforms.uTime.value = this.elapsed;
    }
    if (this.composite) this.composite.uniforms.uTime.value = this.elapsed;
    composer.render(this.elapsed);
  }

  dispose(): void {
    // @types/three omits dispose() on several of these passes (SSAOPass even
    // spells it "dipose"), so release them structurally rather than through a
    // cast that would break the day the runtime changes.
    release(this.ssao);
    release(this.bloom);
    release(this.godRays);
    release(this.composite);
    release(this.smaa);
    release(this.output);
    this.depthTarget?.depthTexture?.dispose();
    this.depthTarget?.dispose();
    // EffectComposer declares a dispose() that does not exist at runtime, so
    // its two ping-pong buffers — everything it owns beyond the passes — are
    // released here.
    this.composer?.renderTarget1.dispose();
    this.composer?.renderTarget2.dispose();
    if (this.composer) this.composer.passes.length = 0;

    this.ssao = null;
    this.bloom = null;
    this.godRays = null;
    this.composite = null;
    this.smaa = null;
    this.output = null;
    this.depthTarget = null;
    this.composer = null;
  }
}
