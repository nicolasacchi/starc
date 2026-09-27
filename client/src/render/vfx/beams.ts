/**
 * Continuous-energy weapons: beams and the charge that precedes them.
 *
 * A beam is a camera-facing ribbon stretched between two world points, built in
 * the vertex shader from a birth stamp so no per-frame CPU work is needed. The
 * fragment stage gives it a white hot core inside the weapon's own colour, a
 * pair of scrolling energy bands running down its length, and a flare where it
 * lands.
 *
 * A charge reuses the same geometry with a different behaviour flag: the tip
 * crawls towards the target on a slow-then-rush curve while the ribbon thickens
 * and brightens, so the shot that follows it lands with a punch.
 *
 * Every sprite here is generated in JavaScript; nothing is loaded.
 */
import * as THREE from "three";
import type { QualitySettings } from "@render/core/quality";
import { instancedQuad, softSpriteTexture } from "./particleSystem";

const BEAM_VERT = /* glsl */ `
attribute vec3 aFrom;
attribute vec3 aTo;
attribute vec4 aParams;
attribute vec3 aColor;

uniform float uTime;

varying vec2 vUv;
varying vec3 vColor;
varying float vFade;
varying float vCharge;

void main() {
  float age = uTime - aParams.x;
  float life = aParams.y;
  vUv = uv;
  vColor = aColor;
  vFade = 0.0;
  vCharge = aParams.w;

  if ( life <= 0.0 || age < 0.0 || age > life ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    return;
  }

  float t = age / life;
  float width = aParams.z;
  vec3 head = aFrom;
  vec3 tail = aTo;

  if ( aParams.w > 0.5 ) {
    // Charging: the tip accelerates towards the target as the coil fills.
    float reach = t * t * ( 3.0 - 2.0 * t );
    tail = mix( aFrom, aTo, reach );
    width *= 0.3 + 0.7 * t;
  }

  float fadeIn = smoothstep( 0.0, 0.05, t );
  vFade = aParams.w > 0.5 ? fadeIn * ( 1.0 - smoothstep( 0.88, 1.0, t ) ) : fadeIn * ( 1.0 - smoothstep( 0.7, 1.0, t ) );

  // The ribbon's width axis is perpendicular to both the beam and the view
  // direction, so the beam always presents its full width to the camera.
  vec3 point = mix( head, tail, uv.x );
  vec3 axis = tail - head;
  float span = length( axis );
  vec3 toCamera = cameraPosition - point;
  vec3 side = cross( span > 0.0001 ? axis / span : vec3( 0.0, 1.0, 0.0 ), toCamera );
  float sideLength = length( side );
  side = sideLength > 0.0001 ? side / sideLength : vec3( 1.0, 0.0, 0.0 );

  // Taper the ends so the ribbon does not end in a hard rectangle.
  float taper = sin( uv.x * 3.14159265 );
  vec3 world = point + side * ( uv.y - 0.5 ) * 2.0 * width * ( 0.35 + 0.65 * taper );

  gl_Position = projectionMatrix * modelViewMatrix * vec4( world, 1.0 );
}
`;

const BEAM_FRAG = /* glsl */ `
uniform float uTime;

varying vec2 vUv;
varying vec3 vColor;
varying float vFade;
varying float vCharge;

void main() {
  float across = abs( vUv.y - 0.5 ) * 2.0;
  float core = pow( 1.0 - across, 5.0 );

  // Two bands running down the beam, faster and tighter while charging.
  float speed = mix( 9.0, 26.0, vCharge );
  float bands = 0.5 + 0.5 * sin( vUv.x * 26.0 - uTime * speed );
  float energy = ( 0.7 + 0.3 * bands ) * ( 1.0 - across * 0.6 );

  vec3 colour = mix( vColor, vec3( 1.0 ), core * 0.92 ) * energy;
  float alpha = vFade * ( 0.3 + 0.7 * core ) * ( 1.0 - smoothstep( 0.86, 1.0, across ) );
  if ( alpha < 0.004 ) discard;

  gl_FragColor = vec4( colour, alpha );
}
`;

const FLARE_VERT = /* glsl */ `
attribute vec3 aCentre;
attribute vec4 aParams;
attribute vec3 aColor;

uniform float uTime;

varying vec2 vUv;
varying vec3 vColor;
varying float vFade;

void main() {
  float age = uTime - aParams.x;
  float life = aParams.y;
  vUv = uv;
  vColor = aColor;
  vFade = 0.0;

  if ( life <= 0.0 || age < 0.0 || age > life ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    return;
  }

  float t = age / life;
  vFade = ( 1.0 - t ) * ( 1.0 - t );

  float size = aParams.z * ( 0.55 + 0.85 * t );
  vec2 corner = position.xy * size;
  vec4 view = modelViewMatrix * vec4( aCentre, 1.0 );
  view.xy += corner;
  gl_Position = projectionMatrix * view;
}
`;

const FLARE_FRAG = /* glsl */ `
uniform sampler2D uSprite;

varying vec2 vUv;
varying vec3 vColor;
varying float vFade;

void main() {
  vec4 sprite = texture2D( uSprite, vUv );
  float alpha = sprite.a * vFade;
  if ( alpha < 0.004 ) discard;
  gl_FragColor = vec4( vColor * sprite.rgb, alpha );
}
`;

/**
 * Pooled beams, charges and their impact flares.
 *
 * Two instanced draws cover everything: the ribbons and the flares. Both are
 * ring buffers, so a hundred beams in a frame cost exactly as much as one.
 */
export class BeamSystem {
  /** Root of the two draw passes; already added to the scene. */
  readonly group = new THREE.Group();
  /** Beams and charges the pool holds. */
  readonly beamCapacity: number;
  /** Impact flares the pool holds. */
  readonly flareCapacity: number;

  private readonly beamGeometry: THREE.InstancedBufferGeometry;
  private readonly beamMaterial: THREE.ShaderMaterial;
  private readonly beamFrom: Float32Array;
  private readonly beamTo: Float32Array;
  private readonly beamParams: Float32Array;
  private readonly beamColors: Float32Array;

  private readonly flareGeometry: THREE.InstancedBufferGeometry;
  private readonly flareMaterial: THREE.ShaderMaterial;
  private readonly flareCentres: Float32Array;
  private readonly flareParams: Float32Array;
  private readonly flareColors: Float32Array;
  private readonly sprite: THREE.DataTexture;

  private readonly beamBuffers: THREE.InstancedBufferAttribute[] = [];
  private readonly flareBuffers: THREE.InstancedBufferAttribute[] = [];
  private beamHead = 0;
  private beamSpawned = 0;
  private flareHead = 0;
  private flareSpawned = 0;
  private time = 0;
  private nextId = 1;
  private readonly _color = new THREE.Color();

  constructor(scene: THREE.Scene, settings: QualitySettings) {
    this.beamCapacity = settings.postFx ? 128 : 48;
    this.flareCapacity = settings.postFx ? 128 : 48;
    this.group.name = "beams";

    this.sprite = softSpriteTexture(1.8, 64);

    this.beamGeometry = instancedQuad();
    this.beamFrom = new Float32Array(this.beamCapacity * 3);
    this.beamTo = new Float32Array(this.beamCapacity * 3);
    this.beamParams = new Float32Array(this.beamCapacity * 4);
    this.beamColors = new Float32Array(this.beamCapacity * 3);
    this.beamGeometry.setAttribute("aFrom", this.attribute(this.beamFrom, 3, this.beamBuffers));
    this.beamGeometry.setAttribute("aTo", this.attribute(this.beamTo, 3, this.beamBuffers));
    this.beamGeometry.setAttribute("aParams", this.attribute(this.beamParams, 4, this.beamBuffers));
    this.beamGeometry.setAttribute("aColor", this.attribute(this.beamColors, 3, this.beamBuffers));
    this.beamGeometry.instanceCount = 0;

    this.beamMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });

    const beamMesh = new THREE.Mesh(this.beamGeometry, this.beamMaterial);
    beamMesh.frustumCulled = false;
    beamMesh.renderOrder = 8;
    beamMesh.name = "beams";
    this.group.add(beamMesh);

    this.flareGeometry = instancedQuad();
    this.flareCentres = new Float32Array(this.flareCapacity * 3);
    this.flareParams = new Float32Array(this.flareCapacity * 4);
    this.flareColors = new Float32Array(this.flareCapacity * 3);
    this.flareGeometry.setAttribute("aCentre", this.attribute(this.flareCentres, 3, this.flareBuffers));
    this.flareGeometry.setAttribute("aParams", this.attribute(this.flareParams, 4, this.flareBuffers));
    this.flareGeometry.setAttribute("aColor", this.attribute(this.flareColors, 3, this.flareBuffers));
    this.flareGeometry.instanceCount = 0;

    this.flareMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uSprite: { value: this.sprite } },
      vertexShader: FLARE_VERT,
      fragmentShader: FLARE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });

    const flareMesh = new THREE.Mesh(this.flareGeometry, this.flareMaterial);
    flareMesh.frustumCulled = false;
    flareMesh.renderOrder = 9;
    flareMesh.name = "beam-flares";
    this.group.add(flareMesh);

    scene.add(this.group);
  }

  /** Beams and charges alive or waiting to fade, upper bound. */
  get beamCount(): number {
    return Math.min(this.beamSpawned, this.beamCapacity);
  }

  /**
   * A continuous energy weapon. `width` is the ribbon's half-width in metres
   * and `durationSeconds` is how long it burns; the impact flare fires as the
   * beam starts.
   */
  beam(from: THREE.Vector3, to: THREE.Vector3, width: number, colour: THREE.ColorRepresentation, durationSeconds: number): number {
    if (!(durationSeconds > 0)) return 0;
    this.writeRibbon(from, to, width, colour, durationSeconds, 0);
    this.writeFlare(to, width * 4.5 + 1.2, colour, Math.min(0.45, durationSeconds));
    return this.nextId++;
  }

  /**
   * A charging weapon: a thin coil that grows towards `to` over
   * `durationSeconds`, at which point the caller fires the real beam.
   */
  charge(from: THREE.Vector3, to: THREE.Vector3, durationSeconds: number): number {
    if (!(durationSeconds > 0)) return 0;
    this.writeRibbon(from, to, 0.09, 0x9fd8ff, durationSeconds, 1);
    return this.nextId++;
  }

  /** Advances both pools' clocks. */
  update(deltaSeconds: number): void {
    this.time += deltaSeconds;
    this.beamMaterial.uniforms.uTime.value = this.time;
    this.flareMaterial.uniforms.uTime.value = this.time;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.beamGeometry.dispose();
    this.beamMaterial.dispose();
    this.flareGeometry.dispose();
    this.flareMaterial.dispose();
    this.sprite.dispose();
  }

  private writeRibbon(
    from: THREE.Vector3,
    to: THREE.Vector3,
    width: number,
    colour: THREE.ColorRepresentation,
    duration: number,
    kind: number,
  ): void {
    const index = this.beamHead;
    this.beamHead = index + 1 === this.beamCapacity ? 0 : index + 1;
    if (this.beamSpawned < this.beamCapacity) this.beamSpawned++;

    const i3 = index * 3;
    const i4 = index * 4;
    this.beamFrom[i3] = from.x;
    this.beamFrom[i3 + 1] = from.y;
    this.beamFrom[i3 + 2] = from.z;
    this.beamTo[i3] = to.x;
    this.beamTo[i3 + 1] = to.y;
    this.beamTo[i3 + 2] = to.z;

    this.beamParams[i4] = this.time;
    this.beamParams[i4 + 1] = duration;
    this.beamParams[i4 + 2] = width;
    this.beamParams[i4 + 3] = kind;

    this._color.set(colour);
    this.beamColors[i3] = this._color.r;
    this.beamColors[i3 + 1] = this._color.g;
    this.beamColors[i3 + 2] = this._color.b;

    const count = Math.min(this.beamSpawned, this.beamCapacity);
    if (count > this.beamGeometry.instanceCount) this.beamGeometry.instanceCount = count;
    this.markDirty(this.beamBuffers, index);
  }

  private writeFlare(at: THREE.Vector3, size: number, colour: THREE.ColorRepresentation, duration: number): void {
    const index = this.flareHead;
    this.flareHead = index + 1 === this.flareCapacity ? 0 : index + 1;
    if (this.flareSpawned < this.flareCapacity) this.flareSpawned++;

    const i3 = index * 3;
    const i4 = index * 4;
    this.flareCentres[i3] = at.x;
    this.flareCentres[i3 + 1] = at.y;
    this.flareCentres[i3 + 2] = at.z;
    this.flareParams[i4] = this.time;
    this.flareParams[i4 + 1] = duration;
    this.flareParams[i4 + 2] = size;

    this._color.set(colour);
    this.flareColors[i3] = this._color.r;
    this.flareColors[i3 + 1] = this._color.g;
    this.flareColors[i3 + 2] = this._color.b;

    const count = Math.min(this.flareSpawned, this.flareCapacity);
    if (count > this.flareGeometry.instanceCount) this.flareGeometry.instanceCount = count;
    this.markDirty(this.flareBuffers, index);
  }

  private markDirty(buffers: THREE.InstancedBufferAttribute[], index: number): void {
    for (const attribute of buffers) {
      attribute.addUpdateRange(index * attribute.itemSize, attribute.itemSize);
      // addUpdateRange only records the span; needsUpdate is what makes the
      // renderer upload it.
      attribute.needsUpdate = true;
    }
  }

  private attribute(
    array: Float32Array,
    size: number,
    registry: THREE.InstancedBufferAttribute[],
  ): THREE.InstancedBufferAttribute {
    const attribute = new THREE.InstancedBufferAttribute(array, size);
    attribute.setUsage(THREE.DynamicDrawUsage);
    registry.push(attribute);
    return attribute;
  }
}
