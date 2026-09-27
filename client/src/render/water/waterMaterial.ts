/**
 * Water — a real surface, not a blue plane.
 *
 * PROVENANCE OF ASSETS: none. The only texture is a `DataTexture` built here
 * from a sum of periodic sine waves (integer frequencies, so it tiles exactly,
 * with no seam) and sampled at three scales, rotations and drift speeds to make
 * the chop. Everything else is arithmetic — including the sky reflection, which
 * re-uses the sky module's own scattering function and its uniform objects, so
 * the water always reflects the sky that is actually on screen, at the actual
 * time of day.
 *
 * What it does:
 *  - Fresnel-weighted sky reflection (Schlick, F0 = 0.02 for water) with the
 *    sun's disc in it, which is where the glint comes from: a real specular
 *    highlight, not a painted one.
 *  - Beer-Lambert absorption with a per-channel extinction, so shallow water
 *    is warm and the sand shows through while deep water goes deep blue. The
 *    absorption is applied to the background the water is blended over, so the
 *    seabed really is attenuated rather than merely tinted.
 *  - A refracted seabed when `settings.postFx` is on: the caller hands over a
 *    copy of the frame rendered without the water (waterPlane.ts) and the
 *    shader offsets the screen UV by the surface normal, scaled by the water
 *    depth. With post effects off the path is skipped entirely and the plain
 *    alpha-blended seabed still reads correctly.
 *  - A shoreline foam band from the terrain height, whitecaps on the steepest
 *    crests, and sub-surface scatter through the back of a wave.
 */
import * as THREE from "three";
import type { MapDef } from "@shared/protocol";
import type { QualitySettings } from "@render/core/quality";
import { TERRAIN_WATER_LEVEL, acquireTerrainFieldTexture, releaseTerrainFieldTexture } from "@render/terrain/terrainMaterial";
import { GLSL_SKY_SCATTERING, type SkySource } from "@render/sky/skyMaterial";

/**
 * The surface sits a few centimetres above the terrain's zero plane. The map
 * border falls off to exactly y = 0, so water drawn at exactly 0 would be
 * coplanar with the seabed out there and would z-fight across the whole
 * horizon. The foam band is still keyed to the true 0 m waterline in-shader.
 */
export const WATER_SURFACE_LIFT = 0.03;

/** Nominal depth of the open sea beyond the map border, in metres. */
const OPEN_SEA_DEPTH = 6;

const NORMAL_MAP_SIZE = 128;

/**
 * A tiling chop map. Periodic because every frequency is an integer, so the
 * texture wraps without a seam and the far water does not tile visibly. Alpha
 * carries the wave height, reused as a whitecap mask.
 */
function buildNormalTexture(size: number, anisotropy: number): THREE.DataTexture {
  // Direction (x, z), frequency, amplitude, phase — deliberately not
  // harmonically related, so the sum does not repeat within the tile.
  const waves: readonly [number, number, number, number, number][] = [
    [1, 0, 1, 0.55, 0],
    [-1, 1, 2, 0.32, 1.7],
    [0, 1, 3, 0.24, 3.1],
    [2, 1, 2, 0.19, 0.6],
    [1, -2, 4, 0.13, 2.2],
    [-2, 2, 5, 0.1, 4.4],
    [3, 1, 6, 0.08, 5.0],
    [1, 3, 7, 0.06, 1.2],
  ];
  const height = new Float32Array(size * size);
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const v = j / size;
      let h = 0;
      for (const [dx, dz, f, a, phase] of waves) {
        h += a * Math.sin(2 * Math.PI * (dx * f * u + dz * f * v) + phase);
      }
      height[j * size + i] = h;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }

  const data = new Uint8Array(size * size * 4);
  const span = Math.max(hi - lo, 1e-4);
  const at = (i: number, j: number): number => height[(((j % size) + size) % size) * size + (((i % size) + size) % size)];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const o = (j * size + i) * 4;
      const dx = (at(i + 1, j) - at(i - 1, j)) * 0.5;
      const dy = (at(i, j + 1) - at(i, j - 1)) * 0.5;
      const len = Math.hypot(dx, dy, 1);
      data[o] = Math.round((-dx / len * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((-dy / len * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      data[o + 3] = Math.round(((at(i, j) - lo) / span) * 255);
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = "water.normal";
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

const GLSL_WATER_PARS = /* glsl */ `
uniform sampler2D uField;
uniform float uFieldSpan;
uniform float uWaterLevel;
uniform vec2 uMapCenter;
uniform float uMapHalf;
uniform float uOpenSeaDepth;
uniform float uTime;
uniform float uWaveAmplitude;
uniform float uChopScale;
uniform float uFoamWidth;
uniform vec3 uShallowTint;
uniform vec3 uDeepTint;
uniform vec3 uExtinction;
uniform float uSunGlint;
uniform sampler2D uNormalMap;
uniform vec2 uResolution;
#ifdef USE_REFRACTION
uniform sampler2D uRefractionMap;
uniform float uRefractionStrength;
#endif
#ifdef USE_FOG
// three writes all four of these every frame for whichever fog the scene uses;
// declaring the linear pair too means swapping FogExp2 for Fog cannot throw.
uniform vec3 fogColor;
uniform float fogDensity;
uniform float fogNear;
uniform float fogFar;
#endif
varying vec3 vWaterWorld;
varying vec3 vWaveNormal;
varying float vWaveHeight;
varying float vWaterDepth;
#ifdef USE_FOG
varying float vFogDepth;
#endif
`;

const GLSL_VERTEX = /* glsl */ `
${GLSL_WATER_PARS}

/**
 * Water column depth under this point. Inside the map it is the terrain height
 * below the waterline; outside the map the height field clamps to the border's
 * zero, which is the waterline and not a seabed, so the open sea ramps in over
 * the first couple of metres past the border.
 */
float scWaterDepth( vec2 wxz ) {
  float bed = texture2D( uField, ( wxz + 0.5 ) / uFieldSpan ).r;
  float depth = max( uWaterLevel - bed, 0.0 );
  vec2 outside = max( abs( wxz - uMapCenter ) - uMapHalf, 0.0 );
  return depth + uOpenSeaDepth * smoothstep( 0.0, 2.0, length( outside ) );
}

void main() {
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vec2 w = world.xz;
  float depth = scWaterDepth( w );
  float amp = uWaveAmplitude * smoothstep( 0.0, 1.1, depth );

  // Four directional waves. The gradient is analytic, so the surface normal is
  // exact and costs nothing.
  vec2 d0 = normalize( vec2( 1.0, 0.22 ) );
  vec2 d1 = normalize( vec2( -0.62, 0.78 ) );
  vec2 d2 = normalize( vec2( 0.31, -0.95 ) );
  vec2 d3 = normalize( vec2( 0.87, 0.49 ) );
  float p0 = dot( w, d0 ) * 0.55 + uTime * 1.35;
  float p1 = dot( w, d1 ) * 0.93 + uTime * 1.05;
  float p2 = dot( w, d2 ) * 1.77 + uTime * 1.85;
  float p3 = dot( w, d3 ) * 3.1 + uTime * 2.6;

  float h = 0.5 * sin( p0 ) + 0.28 * sin( p1 ) + 0.15 * sin( p2 ) + 0.07 * sin( p3 );
  vec2 grad = 0.275 * cos( p0 ) * d0
            + 0.2604 * cos( p1 ) * d1
            + 0.2655 * cos( p2 ) * d2
            + 0.217 * cos( p3 ) * d3;

  world.y += h * amp;
  vWaterWorld = world.xyz;
  vWaveNormal = normalize( vec3( -grad.x, 1.0, -grad.y ) );
  vWaveHeight = h;
  vWaterDepth = depth;

  vec4 mv = viewMatrix * world;
  #ifdef USE_FOG
    vFogDepth = -mv.z;
  #endif
  gl_Position = projectionMatrix * mv;
}
`;

const GLSL_FRAGMENT = /* glsl */ `
${GLSL_WATER_PARS}
${GLSL_SKY_SCATTERING}

/** Two or three scrolling taps of the chop map: swell, chop and fine detail. */
vec3 scChopNormal( vec2 wxz, out float crest ) {
  vec2 drift = vec2( uTime * 0.021, uTime * 0.013 );
  vec3 n = ( texture2D( uNormalMap, wxz * 0.03 + drift ).xyz * 2.0 - 1.0 )
    + ( texture2D( uNormalMap, wxz * 0.085 - drift * 2.1 ).xyz * 2.0 - 1.0 ) * 0.55;
  #ifdef WATER_FINE_DETAIL
    vec4 fine = texture2D( uNormalMap, wxz * 0.24 + drift * 3.4 );
    n += ( fine.xyz * 2.0 - 1.0 ) * 0.28;
    crest = fine.a;
  #else
    crest = texture2D( uNormalMap, wxz * 0.085 - drift * 2.1 ).a;
  #endif
  return normalize( n );
}

void main() {
  vec3 viewDir = normalize( cameraPosition - vWaterWorld );
  float depth = vWaterDepth;

  // Flatten the surface with distance so the far water does not alias into a
  // field of sparkles.
  float dist = length( cameraPosition - vWaterWorld );
  float detail = 1.0 - smoothstep( 60.0, 320.0, dist );
  float crest;
  vec3 chop = scChopNormal( vWaterWorld.xz, crest );
  vec3 base = normalize( vWaveNormal );
  vec3 normal = normalize( mix( base, normalize( base + chop * uChopScale ), detail ) );

  // --- Fresnel: water reflects 2% head on and nearly everything at a graze ---
  float fresnel = 0.02 + 0.98 * pow( 1.0 - clamp( dot( normal, viewDir ), 0.0, 1.0 ), 5.0 );

  // --- reflection: the same scattering model the sky dome is painted with ---
  vec3 reflectDir = reflect( -viewDir, normal );
  reflectDir.y = abs( reflectDir.y );
  vec3 reflection = scSkyRadiance( reflectDir ) + scSunDisc( reflectDir ) * uSunGlint;

  // --- absorption: per-channel Beer-Lambert over the water column ---
  vec3 transmit = exp( -uExtinction * depth );
  vec3 scatter = mix( uShallowTint, uDeepTint, 1.0 - transmit.g );

  // --- the seabed, refracted ---
  #ifdef USE_REFRACTION
    vec2 ruv = gl_FragCoord.xy / uResolution;
    ruv += normal.xz * uRefractionStrength * clamp( depth * 0.5, 0.0, 1.0 ) * ( 1.0 - fresnel );
    vec3 background = texture2D( uRefractionMap, clamp( ruv, vec2( 0.002 ), vec2( 0.998 ) ) ).rgb;
  #else
    vec3 background = vec3( 0.0 );
  #endif

  // --- foam: a band along the shore, and caps on the steepest crests ---
  float shoreNoise = texture2D( uNormalMap, vWaterWorld.xz * 0.16 + vec2( uTime * 0.013, -uTime * 0.009 ) ).a;
  float shore = 1.0 - smoothstep( 0.0, uFoamWidth, depth );
  float foam = smoothstep( 0.35, 0.95, shore * ( 0.55 + 0.9 * shoreNoise ) );
  foam += smoothstep( 0.86, 1.0, crest ) * smoothstep( 0.1, 0.45, vWaveHeight ) * 0.8 * detail;
  foam = clamp( foam, 0.0, 1.0 );

  // --- sub-surface scatter through the back of a wave ---
  float backlight = pow( clamp( dot( viewDir, -uSunDirection ), 0.0, 1.0 ), 3.0 );
  vec3 sss = uShallowTint * uSunDiscColor * backlight * clamp( vWaveHeight, 0.0, 1.0 ) * 1.6;

  vec3 body = background * transmit + scatter * ( 1.0 - transmit );
  vec3 color = mix( body, reflection, fresnel ) + sss;
  color = mix( color, vec3( 0.92, 0.96, 0.98 ), foam * 0.85 );

  #ifdef USE_REFRACTION
    // The refraction texture already contains everything behind the water, so
    // the surface is composited opaquely over it.
    float alpha = 1.0;
  #else
    // Otherwise the water is opaque exactly to the extent that the water
    // column and the Fresnel term hide what is underneath.
    float alpha = 1.0 - ( 1.0 - fresnel ) * ( 1.0 - foam ) * transmit.g;
  #endif

  gl_FragColor = vec4( color, clamp( alpha, 0.0, 1.0 ) );

  #ifdef USE_FOG
    float fogFactor = 1.0 - exp( -fogDensity * fogDensity * vFogDepth * vFogDepth );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
    // Fog has to close the alpha too, or the terrain would show through the
    // haze at the horizon.
    gl_FragColor.a = mix( gl_FragColor.a, 1.0, fogFactor );
  #endif

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface WaterMaterialHandle {
  readonly material: THREE.ShaderMaterial;
  readonly uniforms: Record<string, THREE.IUniform>;
  /** Wave clock and drawing-buffer size for the screen-space refraction. */
  setFrame(elapsedSeconds: number, width: number, height: number): void;
  /**
   * Points the shader at a copy of the frame rendered without the water. Pass
   * `null` to fall back to plain alpha blending over the seabed.
   */
  setRefractionTexture(texture: THREE.Texture | null): void;
  dispose(): void;
}

export function createWaterMaterial(
  map: MapDef,
  settings: QualitySettings,
  sky: SkySource,
): WaterMaterialHandle {
  // Sharing the sky's uniform objects is what keeps the reflection in step with
  // the sky on screen, so `sky` is required rather than optional: standalone
  // uniforms would silently freeze the water at a midday sun under a sunset
  // sky, and there is no way for the shader to notice.
  const skyUniforms = sky.uniforms;

  const chop = buildNormalTexture(NORMAL_MAP_SIZE, settings.anisotropy);
  const field = acquireTerrainFieldTexture(map);
  const useRefraction = settings.postFx;

  // Only ever read before the first capture on a post-FX preset, so the sampler
  // is never unbound. It is a plausible seabed rather than black: shallow
  // water still reads as water over sand instead of a black hole, and deep
  // water absorbs it away entirely.
  const blank = new THREE.DataTexture(new Uint8Array([110, 92, 66, 255]), 1, 1);
  blank.needsUpdate = true;

  const uniforms: Record<string, THREE.IUniform> = {
    ...skyUniforms,
    uField: { value: field },
    uFieldSpan: { value: map.size + 1 },
    uWaterLevel: { value: TERRAIN_WATER_LEVEL },
    uMapCenter: { value: new THREE.Vector2(map.size * 0.5, map.size * 0.5) },
    uMapHalf: { value: map.size * 0.5 },
    uOpenSeaDepth: { value: OPEN_SEA_DEPTH },
    uTime: { value: 0 },
    uWaveAmplitude: { value: 0.16 },
    uChopScale: { value: 1 },
    uFoamWidth: { value: 0.55 },
    uShallowTint: { value: new THREE.Color(0.16, 0.46, 0.44) },
    uDeepTint: { value: new THREE.Color(0.012, 0.055, 0.1) },
    // Red goes first, then green, then blue: about 1.7 m of water halves red.
    uExtinction: { value: new THREE.Vector3(0.58, 0.19, 0.11) },
    // 1.0 keeps the glint at the same radiance as the sun disc in the dome; it
    // is meant to blow out to white and feed the bloom, not to tint.
    uSunGlint: { value: 1 },
    uNormalMap: { value: chop },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uRefractionMap: { value: blank },
    uRefractionStrength: { value: 0.045 },
    // Seeded from the map's own values so the horizon is right on the first
    // frame; three overwrites both from the scene fog every frame after.
    fogColor: { value: new THREE.Color(map.lighting?.sun_color ?? "#9fb4c8") },
    fogDensity: { value: map.lighting?.fog_density ?? 0.012 },
    fogNear: { value: 1 },
    fogFar: { value: 2000 },
  };

  const material = new THREE.ShaderMaterial({
    defines: {
      ...(useRefraction ? { USE_REFRACTION: "" } : {}),
      ...(settings.anisotropy > 1 ? { WATER_FINE_DETAIL: "" } : {}),
    },
    uniforms,
    vertexShader: GLSL_VERTEX,
    fragmentShader: GLSL_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
    fog: true,
    toneMapped: true,
  });
  material.name = `water.${map.id}`;

  return {
    material,
    uniforms,
    setFrame(elapsedSeconds: number, width: number, height: number): void {
      uniforms.uTime.value = elapsedSeconds;
      (uniforms.uResolution.value as THREE.Vector2).set(width, height);
    },
    setRefractionTexture(texture: THREE.Texture | null): void {
      if (!useRefraction) return;
      uniforms.uRefractionMap.value = texture ?? blank;
    },
    dispose(): void {
      material.dispose();
      chop.dispose();
      blank.dispose();
      releaseTerrainFieldTexture(map);
    },
  };
}
