/**
 * Cascaded sun shadows plus the contact-shadow blobs that plant units on the
 * ground.
 *
 * Shadow maps come from `three/addons/lights/SunLight.js`, which ships with
 * 0.186 and does the hard part properly: it fits one orthographic box per
 * depth slice of the view frustum, snaps each box to its own texel grid so the
 * shadows do not shimmer while the camera pans, packs the slices into a single
 * atlas and blends between them on the GPU. The renderer multiplies a light's
 * shadow term into that same light's diffuse contribution, which is why the
 * cascaded light has to *be* the key light — see `LightingRig.adoptKeyLight`.
 *
 * three compiles `SUN_LIGHT_CASCADES` to 2, so that is the ceiling here: a
 * third or fourth slice would mean patching every material in the project.
 * Presets asking for more spend the budget on map resolution and on pulling
 * the shadow distance in, which buys more visible quality than a third slice
 * of a 40 metre view would. `settings.shadowCascades === 1` falls back to a
 * single hand-fitted cascade on the rig's own directional light, and 0 turns
 * shadows off entirely.
 *
 * Everything drawn here is procedural; no shadow texture is loaded.
 */
import * as THREE from "three";
import { SunLight } from "three/addons/lights/SunLight.js";
import type { QualitySettings } from "@render/core/quality";
import type { HeightField } from "@render/terrain/heightfield";
import type { LightingRig } from "./lighting";

/** Cascades the engine can actually fit. */
const MAX_CASCADES = 2;
/** Height above the ground at which a contact blob has faded to a quarter. */
const BLOB_FADE_HEIGHT = 6;

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _snapped = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const FALLBACK_UP = new THREE.Vector3(0, 0, 1);
const _cameraRight = new THREE.Vector3();
const _cameraUp = new THREE.Vector3();
const _corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

/**
 * Corner `index` of a view frustum at `depth`, in world space. Corners wind
 * from the far-right one; the scratch vectors are preallocated because this
 * runs on every frame.
 */
function frustumCorner(
  index: number,
  right: THREE.Vector3,
  up: THREE.Vector3,
  forward: THREE.Vector3,
  depth: number,
): THREE.Vector3 {
  const sx = index === 0 || index === 1 ? 1 : -1;
  const sy = index === 0 || index === 3 ? 1 : -1;
  return _corners[index]
    .set(0, 0, 0)
    .addScaledVector(right, sx)
    .addScaledVector(up, sy)
    .addScaledVector(forward, depth);
}

/**
 * One instanced, alpha-blended quad per caster: the dark pool directly under a
 * unit. It is what makes a unit read as *resting on* the terrain rather than
 * hovering a centimetre above it, and it keeps units legible when the sun is
 * too low to cast a real shadow.
 */
export class ContactShadows {
  /** Add to the scene; positions are world space, one quad per caster. */
  readonly mesh: THREE.InstancedMesh;
  /** Scales every blob. Drop it at night, or where bounce light is strong. */
  daylight = 1;

  private readonly material: THREE.ShaderMaterial;
  private readonly alpha: THREE.InstancedBufferAttribute;
  private readonly matrices: Float32Array;
  private readonly alphas: Float32Array;
  private cursor = 0;

  constructor(capacity: number, anisotropy: number) {
    const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aAlpha", this.alpha);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uBlob: { value: radialFalloffTexture(anisotropy) },
        uDaylight: { value: 1 },
      },
      vertexShader: CONTACT_VERT,
      fragmentShader: CONTACT_FRAG,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
    });

    this.mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    this.mesh.name = "contact-shadows";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.matrices = this.mesh.instanceMatrix.array as Float32Array;
    this.alphas = this.alpha.array as Float32Array;
  }

  /** Resets the write cursor. Call once per frame before the `add` calls. */
  begin(): void {
    this.cursor = 0;
  }

  /**
   * Writes one blob. `liftHeight` is the caster's height above the ground: the
   * blob spreads and fades with it, so a jumping unit loses its anchor exactly
   * when it should.
   */
  add(x: number, z: number, groundY: number, liftHeight: number, radius: number, strength: number): void {
    const index = this.cursor;
    if (index >= this.alphas.length) return;
    this.cursor++;

    const lift = liftHeight > 0 ? Math.min(1, liftHeight / BLOB_FADE_HEIGHT) : 0;
    const scale = radius * (1 + lift * 0.45);
    const alpha = strength * (1 - lift * 0.78) * this.daylight;

    const m = index * 16;
    this.matrices[m] = scale;
    this.matrices[m + 1] = 0;
    this.matrices[m + 2] = 0;
    this.matrices[m + 3] = 0;
    this.matrices[m + 4] = 0;
    this.matrices[m + 5] = 1;
    this.matrices[m + 6] = 0;
    this.matrices[m + 7] = 0;
    this.matrices[m + 8] = 0;
    this.matrices[m + 9] = 0;
    this.matrices[m + 10] = scale;
    this.matrices[m + 11] = 0;
    this.matrices[m + 12] = x;
    this.matrices[m + 13] = groundY + 0.035;
    this.matrices[m + 14] = z;
    this.matrices[m + 15] = 1;

    // Written even when it has faded out: the fragment stage discards on zero
    // alpha, which is cheaper than compacting the instance list every frame.
    this.alphas[index] = alpha;
  }

  /** Publishes everything written since `begin`. */
  end(): void {
    const count = this.cursor;
    this.mesh.count = count;
    if (count === 0) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
    this.material.uniforms.uDaylight.value = this.daylight;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    (this.material.uniforms.uBlob.value as THREE.Texture).dispose();
  }
}

const CONTACT_VERT = /* glsl */ `
attribute float aAlpha;
varying vec2 vBlobUv;
varying float vAlpha;
void main() {
  vBlobUv = uv;
  vAlpha = aAlpha;
  vec4 world = instanceMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * modelViewMatrix * world;
}
`;

const CONTACT_FRAG = /* glsl */ `
uniform sampler2D uBlob;
uniform float uDaylight;
varying vec2 vBlobUv;
varying float vAlpha;
void main() {
  float mask = texture2D( uBlob, vBlobUv ).a;
  float alpha = mask * vAlpha;
  if ( alpha < 0.004 ) discard;
  gl_FragColor = vec4( 0.0, 0.0, 0.0, alpha );
}
`;

/** Soft round falloff, generated into a data texture. */
function radialFalloffTexture(anisotropy: number): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const d = Math.min(1, Math.hypot(dx, dy) * 2);
      // A squared smoothstep core keeps the middle flat and the rim soft.
      const a = (1 - d) * (1 - d) * (0.55 + 0.45 * (1 - d));
      const o = (y * size + x) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = Math.max(1, anisotropy);
  texture.needsUpdate = true;
  return texture;
}

/** Wireframe box around one cascade's orthographic shadow frustum. */
class CascadeDebug {
  readonly group = new THREE.Group();
  private readonly boxes: THREE.LineSegments[] = [];
  private readonly edges: THREE.EdgesGeometry;

  constructor(count: number) {
    this.group.name = "cascade-debug";
    this.group.visible = false;
    this.group.renderOrder = 999;
    this.edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    for (let i = 0; i < count; i++) {
      const material = new THREE.LineBasicMaterial({
        color: i === 0 ? 0x49d6ff : 0xffa64d,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        fog: false,
      });
      const box = new THREE.LineSegments(this.edges, material);
      box.frustumCulled = false;
      this.boxes.push(box);
      this.group.add(box);
    }
  }

  /** `selected` is a cascade index, or null to show every cascade evenly. */
  show(cascades: readonly THREE.OrthographicCamera[], selected: number | null): void {
    this.group.visible = cascades.length > 0;
    for (let i = 0; i < this.boxes.length; i++) {
      const box = this.boxes[i];
      const camera = cascades[i];
      if (!camera) {
        box.visible = false;
        continue;
      }
      box.visible = true;
      const material = box.material as THREE.LineBasicMaterial;
      material.opacity = selected === null || selected === i ? 0.95 : 0.2;
      material.color.setHex(selected === i ? 0xffffff : i === 0 ? 0x49d6ff : 0xffa64d);

      box.position.copy(camera.position);
      box.quaternion.copy(camera.quaternion);
      const depth = camera.far - camera.near;
      box.scale.set(camera.right - camera.left, camera.top - camera.bottom, depth);
      box.translateZ(-(camera.near + depth * 0.5));
      box.updateMatrixWorld(true);
    }
  }

  dispose(): void {
    this.edges.dispose();
    for (const box of this.boxes) {
      (box.material as THREE.LineBasicMaterial).dispose();
    }
    this.boxes.length = 0;
    this.group.clear();
  }
}

/**
 * Sun shadows and ground contact for one scene.
 *
 * The system owns the cascade light and the debug view; the terrain is only
 * needed to keep the shadow distance tied to the map, since a 256 m map does
 * not need a kilometre of shadow range.
 */
export class ShadowSystem {
  readonly settings: QualitySettings;
  /** Instanced ground blobs; drive with `begin` / `add` / `end` each frame. */
  readonly contact: ContactShadows;

  private readonly scene: THREE.Scene;
  private readonly rig: LightingRig;
  private readonly debug: CascadeDebug;
  private sun: SunLight | null = null;
  private readonly cascades: number;
  private shadowDistance: number;
  private debugCascade: number | null = null;
  private readonly cascadeCameras: THREE.OrthographicCamera[] = [];

  constructor(scene: THREE.Scene, settings: QualitySettings, rig: LightingRig) {
    this.scene = scene;
    this.rig = rig;
    this.settings = settings;
    this.cascades = Math.max(0, Math.min(MAX_CASCADES, Math.round(settings.shadowCascades)));
    this.shadowDistance = 120;

    const resolution = Math.max(512, Math.round(settings.shadowMapSize));

    if (this.cascades >= 2) {
      const sun = new SunLight(0xffffff, 0);
      sun.name = "cascaded-sun";
      sun.castShadow = true;
      sun.shadow.mapSize.set(resolution, resolution);
      sun.shadow.camera.near = 0.5;
      sun.shadow.camera.far = this.shadowDistance;
      // Slope-scaled depth bias: the bias that stops acne on a 40 m cascade
      // would detach a contact shadow on a 140 m one.
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = 0.045;
      sun.shadow.radius = settings.postFx ? 2.5 : 1.5;
      this.sun = sun;
      rig.adoptKeyLight(sun);
    } else {
      this.rig.sun.castShadow = this.cascades === 1;
      const shadow = this.rig.sun.shadow;
      shadow.mapSize.set(resolution, resolution);
      shadow.bias = -0.0005;
      shadow.normalBias = 0.04;
      shadow.radius = settings.postFx ? 2.5 : 1.5;
      shadow.camera.near = 0.5;
      shadow.camera.far = this.shadowDistance;
    }

    this.contact = new ContactShadows(
      Math.min(1024, Math.max(128, Math.round(settings.particleBudget / 2))),
      settings.anisotropy,
    );
    scene.add(this.contact.mesh);

    this.debug = new CascadeDebug(Math.max(1, this.cascades));
    scene.add(this.debug.group);
  }

  /** Number of depth slices actually being rendered. */
  get cascadeCount(): number {
    return this.cascades;
  }

  /** How far from the camera shadows are fitted, in metres. */
  get distance(): number {
    return this.shadowDistance;
  }

  /**
   * Cascade-selection debug view: `null` shows every slice, an index
   * highlights that one and fades the rest.
   */
  setDebugCascade(index: number | null): void {
    this.debugCascade = index === null ? null : Math.max(0, Math.min(this.cascades - 1, Math.round(index)));
    this.debug.group.visible = this.debugCascade !== null;
  }

  /** Currently highlighted cascade, or null when the debug view is off. */
  get cascadeDebugIndex(): number | null {
    return this.debugCascade;
  }

  /**
   * Re-fits the cascades around the view camera. Call after the camera has
   * settled and before rendering; `terrain` bounds the shadow distance to the
   * map so a wide view does not pay for shadows nobody can see.
   */
  update(camera: THREE.PerspectiveCamera, terrain: HeightField): void {
    const span = terrain.size * 0.55;
    this.shadowDistance = Math.max(70, Math.min(camera.far, span, 200));

    if (this.sun) {
      this.sun.shadow.camera.far = this.shadowDistance;
      this.sun.shadow.camera.near = 0.5;
    } else if (this.cascades === 1) {
      this.fitSingleCascade(camera);
    }

    if (this.debugCascade !== null) {
      this.collectCascadeCameras();
      this.debug.show(this.cascadeCameras, this.debugCascade);
    }
  }

  dispose(): void {
    this.scene.remove(this.contact.mesh);
    this.contact.dispose();
    this.scene.remove(this.debug.group);
    this.debug.dispose();

    if (this.sun) {
      this.sun.castShadow = false;
      this.sun.shadow.dispose();
      this.rig.restoreKeyLight();
      this.sun = null;
    } else {
      this.rig.sun.castShadow = false;
    }
    this.cascadeCameras.length = 0;
  }

  /** Cascade orthographic cameras, for the debug view. */
  private collectCascadeCameras(): void {
    this.cascadeCameras.length = 0;
    if (this.sun) {
      for (let i = 0; i < this.cascades; i++) {
        this.cascadeCameras.push(this.sun.shadow.getCamera(i));
      }
    } else if (this.cascades === 1) {
      this.cascadeCameras.push(this.rig.sun.shadow.camera as THREE.OrthographicCamera);
    }
  }

  /**
   * Single-cascade path: one orthographic box around the whole view frustum,
   * snapped to its own texel grid. The rotation cannot change while the camera
   * only pans, so the snap holds the shadow rock steady.
   */
  private fitSingleCascade(camera: THREE.PerspectiveCamera): void {
    const light = this.rig.sun;
    const shadow = light.shadow;
    const ortho = shadow.camera as THREE.OrthographicCamera;

    camera.updateMatrixWorld();
    _dir.copy(this.rig.sunDirection).normalize();
    _up.copy(Math.abs(_dir.y) > 0.99 ? FALLBACK_UP : UP);
    _right.crossVectors(_up, _dir).normalize();
    _up.crossVectors(_dir, _right).normalize();

    // Corners of the view frustum at the shadow distance.
    camera.getWorldDirection(_forward);
    const halfHeight = Math.tan((camera.fov * Math.PI) / 360) * this.shadowDistance;
    const halfWidth = halfHeight * camera.aspect;
    _cameraRight.set(1, 0, 0).applyQuaternion(camera.quaternion).multiplyScalar(halfWidth);
    _cameraUp.set(0, 1, 0).applyQuaternion(camera.quaternion).multiplyScalar(halfHeight);

    _centre.set(0, 0, 0);
    let minDepth = Infinity;
    let maxDepth = -Infinity;
    for (let i = 0; i < 4; i++) {
      const corner = frustumCorner(i, _cameraRight, _cameraUp, _forward, this.shadowDistance);
      _centre.add(corner);
      const depth = corner.dot(_dir);
      if (depth < minDepth) minDepth = depth;
      if (depth > maxDepth) maxDepth = depth;
    }
    _centre.multiplyScalar(0.25);

    let radius = 0;
    for (let i = 0; i < 4; i++) {
      radius = Math.max(
        radius,
        _centre.distanceTo(frustumCorner(i, _cameraRight, _cameraUp, _forward, this.shadowDistance)),
      );
    }
    // A texel of padding, so snapping can never clip a frustum corner.
    const resolution = Math.max(1, shadow.mapSize.x);
    radius = (radius * 1.02 * resolution) / (resolution - 1);
    const texel = (2 * radius) / resolution;

    // Snap the centre along the two axes the shadow map actually measures.
    const along = _centre.dot(_dir);
    _snapped
      .set(0, 0, 0)
      .addScaledVector(_right, Math.round(_centre.dot(_right) / texel) * texel)
      .addScaledVector(_up, Math.round(_centre.dot(_up) / texel) * texel)
      .addScaledVector(_dir, along);

    // Park the light a full radius beyond the frustum so casters just outside
    // the view still reach into it, and leave a radius of depth behind too.
    const back = maxDepth - along + radius + 8;
    light.target.position.copy(_snapped);
    light.target.updateMatrixWorld();
    light.position.copy(_snapped).addScaledVector(_dir, back);

    ortho.left = -radius;
    ortho.right = radius;
    ortho.top = radius;
    ortho.bottom = -radius;
    ortho.near = 0.5;
    ortho.far = along + back - minDepth + radius;
    ortho.updateProjectionMatrix();
  }
}

