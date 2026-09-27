/**
 * Cloud layer — parallax sheets of domain-warped fBm, lit by the same analytic
 * sky the dome is painting.
 *
 * PROVENANCE OF ASSETS: none. Every cloud is arithmetic: the geometry is a
 * single `CircleGeometry` and the fragment shader projects the view ray onto
 * three virtual horizontal planes, so the sheets have real parallax against
 * each other and slide correctly as the camera moves. Nothing is fetched and
 * nothing is sampled from a texture.
 *
 * Why a disc and not a dome: the pattern is evaluated where the ray crosses
 * the sheet, not from the disc's UVs, so a coarse fan is all the geometry that
 * is needed and the horizon converges for free. The disc is re-centred on the
 * camera every frame, which keeps the fade radius meaningful however far the
 * camera has travelled, and it fades out well before its own rim so the edge
 * is never visible.
 *
 * The lighting is the part that makes it read as sky rather than as a texture:
 * the sun side is a second density sample taken along the sun's own ray
 * through the sheet (a one-tap self-shadow), the ambient is the zenith
 * radiance evaluated with the real scattering model — so the deck goes amber at
 * sunset and blue at night for free — and the rim gets a Henyey-Greenstein
 * forward lobe, which is the silver lining.
 */
import * as THREE from "three";
import type { MapDef } from "@shared/protocol";
import type { QualitySettings } from "@render/core/quality";
import { GLSL_HASH, GLSL_NOISE } from "@render/core/shaderChunks";
import { GLSL_SKY_SCATTERING, createSkyUniforms, type SkySource, type SkyUniforms } from "@render/sky/skyMaterial";

/** Altitude of the highest sheet, in metres. The others sit below it. */
const CLOUD_CEILING = 340;
const DISC_RADIUS = 12000;

const GLSL_VERTEX = /* glsl */ `
varying vec3 vCloudWorld;
void main() {
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vCloudWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const GLSL_FRAGMENT = /* glsl */ `
${GLSL_HASH}
${GLSL_NOISE}
${GLSL_SKY_SCATTERING}

uniform float uTime;
uniform float uCoverage;
uniform float uDensity;
uniform float uWindSpeed;
uniform vec3 uSunTint;
uniform float uFadeStart;
uniform float uFadeEnd;
varying vec3 vCloudWorld;

const vec3 CLOUD_UP = vec3( 0.0, 1.0, 0.0 );

/**
 * One sheet. The view ray is intersected with the sheet's altitude, the
 * resulting point is domain-warped into coverage, and a second sample along the
 * sun's ray through the same sheet gives the self-shadow.
 */
float scCloudSheet( vec3 ro, vec3 rd, float altitude, float scale, vec2 wind, out float lit ) {
  float k = ( altitude - ro.y ) / max( rd.y, 0.02 );
  vec2 p = ( ro.xz + rd.xz * k ) * scale + wind * uTime;

  // Domain warp: a low-frequency field displaces the high-frequency one, which
  // is what gives the billows curled edges instead of round blobs.
  float q = sc_fbm2( p * 0.55, 2, 2.0, 0.5 );
  float d = sc_fbm2( p + vec2( q, q * 0.63 ) * 1.35, CLOUD_OCTAVES, 2.0, 0.55 );

  #ifdef CLOUD_SHADOW
    vec2 sunStep = normalize( uSunDirection.xz + 1e-5 ) * ( 0.42 / max( uSunDirection.y, 0.25 ) );
    float ds = sc_fbm2( p + sunStep + vec2( q, q * 0.63 ) * 1.35, CLOUD_OCTAVES, 2.0, 0.55 );
    lit = clamp( 0.5 + ( d - ds ) * 2.4, 0.0, 1.0 );
  #else
    // Without the second tap the billows are lit by their own density: tops
    // bright, undersides dark, which is the same read for a third of the cost.
    lit = clamp( 0.35 + d * 0.9, 0.0, 1.0 );
  #endif

  float density = d - ( 1.0 - uCoverage );
  // Far sheets lose contrast as they compress towards the horizon.
  float aerial = 1.0 - smoothstep( 1200.0, 5200.0, k );
  return max( density, 0.0 ) * ( 0.35 + 0.65 * aerial );
}

/** Composes the sheets into one cloud colour and coverage. */
void scClouds( vec3 ro, vec3 rd, out vec3 color, out float alpha ) {
  vec2 wind = vec2( 1.0, 0.35 ) * uWindSpeed;
  float litHigh = 0.5;
  float litMid = 0.5;
  float litLow = 0.5;
  float high = scCloudSheet( ro, rd, CLOUD_CEILING, 0.0007, wind * 1.6, litHigh );
  float mid = 0.0;
  #if CLOUD_SHEETS >= 2
    mid = scCloudSheet( ro, rd, CLOUD_CEILING - 90.0, 0.0011, wind, litMid );
  #endif
  float low = 0.0;
  #if CLOUD_SHEETS >= 3
    low = scCloudSheet( ro, rd, CLOUD_CEILING - 190.0, 0.0016, wind * 0.55, litLow );
  #endif

  // The high sheet is furthest away and shows through the gaps in the ones below.
  float density = high * 0.8 + mid + low * 1.15;
  float lit = ( high * litHigh + mid * litMid + low * litLow ) / max( high + mid + low, 1e-4 );
  alpha = 1.0 - exp( -density * uDensity * 3.4 );
  if ( alpha < 0.004 ) {
    color = vec3( 0.0 );
    return;
  }

  // The zenith radiance is the ambient a cloud sees from above, evaluated with
  // the real scattering model, so the deck goes amber at sunset without a
  // single hand-tuned colour.
  vec3 ambient = scSkyRadiance( CLOUD_UP ) * 6.0 + vec3( 0.012, 0.016, 0.026 );
  float sunUp = smoothstep( -0.08, 0.25, uSunDirection.y );
  vec3 direct = uSunTint * sunUp * ( 0.35 + 1.25 * lit );

  // Silver lining: forward scattering off the rim of each billow.
  float cosSun = dot( rd, uSunDirection );
  float g = 0.72;
  float hg = ( 1.0 - g * g ) / pow( max( 1.0 + g * g - 2.0 * g * cosSun, 1e-3 ), 1.5 );
  float rim = clamp( 4.0 * alpha * ( 1.0 - alpha ), 0.0, 1.0 );
  direct *= 1.0 + min( hg, 6.0 ) * rim * 1.6;

  color = ( ambient + direct ) * mix( 1.0, 0.55, uNight );
}

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize( vCloudWorld - ro );

  vec3 color;
  float alpha;
  scClouds( ro, rd, color, alpha );

  // Fade towards the rim of the disc and towards the horizon, into the sky's
  // own colour, so the sheet dissolves instead of ending.
  float dist = length( vCloudWorld.xz - ro.xz );
  float edge = 1.0 - smoothstep( uFadeStart, uFadeEnd, dist );
  float horizon = smoothstep( 0.0, 0.055, rd.y );
  float visible = clamp( edge * horizon, 0.0, 1.0 );
  color = mix( scSkyRadiance( rd ), color, visible );
  alpha *= visible;

  if ( alpha < 0.003 ) discard;
  gl_FragColor = vec4( color, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;


export interface CloudLayer {
  readonly mesh: THREE.Mesh;
  /** Advances the wind and re-centres the disc on the camera. */
  update(elapsedSeconds: number, cameraPosition?: THREE.Vector3): void;
  dispose(): void;
}

export function createClouds(
  scene: THREE.Scene,
  map: MapDef,
  settings: QualitySettings,
  sun?: SkySource,
): CloudLayer {
  // Sharing the sky's uniform objects is what keeps the cloud light and the
  // painted sky from ever disagreeing. Standalone, they still light correctly.
  const skyUniforms: SkyUniforms = sun ? sun.uniforms : createSkyUniforms();
  if (!sun) {
    skyUniforms.uSunDirection.value.set(0.4, 0.8, 0.45).normalize();
    skyUniforms.uSunDiscColor.value.setRGB(1, 0.95, 0.85, THREE.LinearSRGBColorSpace);
  }

  const sunTint = { value: new THREE.Color(1, 1, 1) };
  const uniforms: Record<string, THREE.IUniform> = {
    ...skyUniforms,
    uCoverage: { value: map.biome === "badlands" ? 0.42 : 0.52 },
    uDensity: { value: map.biome === "island" ? 0.95 : 0.8 },
    uWindSpeed: { value: 0.0016 },
    uSunTint: sunTint,
    uFadeStart: { value: DISC_RADIUS * 0.32 },
    uFadeEnd: { value: DISC_RADIUS * 0.92 },
  };

  const material = new THREE.ShaderMaterial({
    // The deck is the most expensive thing in the sky by a wide margin: each
    // sheet is a warped fBm plus a second tap along the sun's ray for the
    // self-shadow, and the sheets cover a large part of the frame. `postFx` is
    // the same "can this machine afford a full-screen pass" switch the rest of
    // the renderer reads, so the low preset gets one unshadowed sheet at two
    // octaves and still shows a sky with weather in it.
    defines: {
      // `CLOUD_CEILING` is read by the sheet code inside the GLSL, so it has
      // to reach the shader as a define: a TypeScript const is not in scope
      // inside the fragment string, and a missing declaration there is a hard
      // compile error that takes the whole render loop down with it.
      CLOUD_CEILING: CLOUD_CEILING.toFixed(1),
      CLOUD_SHEETS: settings.postFx ? (settings.terrainLodRings >= 4 ? 3 : 2) : 1,
      CLOUD_OCTAVES: settings.postFx ? (settings.terrainLodRings >= 4 ? 4 : 3) : 2,
      ...(settings.postFx ? { CLOUD_SHADOW: "" } : {}),
    },
    uniforms,
    vertexShader: GLSL_VERTEX,
    fragmentShader: GLSL_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: true,
  });
  material.name = "sky.clouds";

  const geometry = new THREE.CircleGeometry(DISC_RADIUS, 96);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `sky.clouds.${map.id}`;
  mesh.position.set(map.size * 0.5, CLOUD_CEILING, map.size * 0.5);
  mesh.renderOrder = -900;
  mesh.frustumCulled = false;
  scene.add(mesh);

  const scratch = new THREE.Color();

  return {
    mesh,
    update(elapsedSeconds: number, cameraPosition?: THREE.Vector3): void {
      uniforms.uTime.value = elapsedSeconds;
      if (sun) {
        // The sun colour carries extinction and a horizon dimming; the clouds
        // want the hue without that falloff applied a second time.
        scratch.copy(sun.sunColor());
        const peak = Math.max(scratch.r, scratch.g, scratch.b, 1e-3);
        sunTint.value.copy(scratch).multiplyScalar(1 / peak);
      }
      if (cameraPosition) {
        mesh.position.set(cameraPosition.x, CLOUD_CEILING, cameraPosition.z);
      }
    },
    dispose(): void {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}
