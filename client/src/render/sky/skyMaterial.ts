/**
 * Analytic sky — Preetham single-scattering for the day, a real star field and
 * a phase-lit moon for the night.
 *
 * PROVENANCE OF ASSETS: there are none. The sky is evaluated per pixel from
 * closed-form Rayleigh + Mie scattering with the optical air mass integrated
 * analytically, so the whole thing is a few dozen ALU ops and no texture at
 * all. The same GLSL is reused by the water shader to reflect the sky, which is
 * why the uniforms are a shareable object rather than private state.
 *
 * The scattering integrals are the textbook Preetham formulation: beta_r and
 * beta_m are wavelength-dependent, the view ray picks up `1 - Fex` (in-scatter)
 * and the sun ray picks up `Fex` (extinction), and the two phase functions are
 * Rayleigh's `3/16pi (1 + cos^2)` and Henyey-Greenstein. What this file does
 * NOT do is march the view ray through the atmosphere 100 times per pixel the
 * way the classic `Sky.js` does — the zenith optical depth is `beta * H * m`
 * with `m` the Rozenberg air-mass function and `H` the Rayleigh (8 km) and Mie
 * (1.2 km) scale heights, which is the same integral to within a few percent
 * and costs one `acos` and one `pow`.
 *
 * `uNight` cross-fades to the night term, which is not physical (there is no
 * single-scattering solution for a sun below the horizon) but is what actually
 * happens: airglow, starlight, the moon, and the afterglow still sitting on
 * the horizon where the sun went down.
 */
import * as THREE from "three";
import { GLSL_HASH, GLSL_NOISE } from "@render/core/shaderChunks";

/** Wavelength-dependent Rayleigh scattering at sea level, 1/m. */
export const SKY_RAYLEIGH = new THREE.Vector3(5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5);

/** Mie scattering constants, from the Preetham/Hosek fit. */
export const SKY_MIE_CONST = new THREE.Vector3(1.8399918514433978e14, 2.7798023919666528e14, 4.0790479543861094e14);

const RAYLEIGH_SCALE_HEIGHT = 8000;
const MIE_SCALE_HEIGHT = 1200;
const MIE_TURBIDITY_SCALE = 1e-18;
const MIE_TURBIDITY_COEFF = 0.434;

/** Total Mie scattering for a turbidity, 1/m. Mirrors `scTotalMie` in GLSL. */
export function totalMie(turbidity: number, out = new THREE.Vector3()): THREE.Vector3 {
  const c = 0.2 * turbidity * MIE_TURBIDITY_SCALE;
  return out.set(
    MIE_TURBIDITY_COEFF * c * SKY_MIE_CONST.x,
    MIE_TURBIDITY_COEFF * c * SKY_MIE_CONST.y,
    MIE_TURBIDITY_COEFF * c * SKY_MIE_CONST.z,
  );
}

/** Rozenberg relative air mass for a cosine from the zenith. */
export function airMass(cosZenith: number): number {
  const deg = (Math.acos(THREE.MathUtils.clamp(cosZenith, -1, 1)) * 180) / Math.PI;
  const t = Math.max(93.885 - deg, 0.02);
  return 1 / (Math.max(cosZenith, 0) + 0.15 * Math.pow(t, -1.253));
}

const scratchMie = new THREE.Vector3();
const scratchBeta = new THREE.Vector3();

/**
 * How much sunlight survives the trip to the ground at this sun elevation,
 * per channel. This is what turns the sun disc and the key light orange at
 * sunset, and it is computed with the same constants as the shader so the
 * lighting and the painted sky never disagree.
 */
export function sunTransmittance(cosSunZenith: number, turbidity: number, out = new THREE.Color()): THREE.Color {
  const m = airMass(cosSunZenith);
  const betaM = totalMie(turbidity, scratchMie);
  out.setRGB(
    Math.exp(-(SKY_RAYLEIGH.x * RAYLEIGH_SCALE_HEIGHT + betaM.x * MIE_SCALE_HEIGHT) * m),
    Math.exp(-(SKY_RAYLEIGH.y * RAYLEIGH_SCALE_HEIGHT + betaM.y * MIE_SCALE_HEIGHT) * m),
    Math.exp(-(SKY_RAYLEIGH.z * RAYLEIGH_SCALE_HEIGHT + betaM.z * MIE_SCALE_HEIGHT) * m),
    THREE.LinearSRGBColorSpace,
  );
  return out;
}

/** Sun radiance used by the disc: the Preetham extinction cutoff. */
export function sunDiscIntensity(cosSunZenith: number): number {
  const cutoff = 1.6110731556870734;
  const steepness = 1.5;
  const z = THREE.MathUtils.clamp(cosSunZenith, -1, 1);
  return Math.max(0, 1 - Math.exp(-((cutoff - Math.acos(z)) / steepness)));
}

/* ------------------------------------------------------------------ */
/* Uniforms — one object, shared with the water                        */
/* ------------------------------------------------------------------ */

/**
 * The uniform objects themselves are shared: `skyDome` writes the sun into
 * them once per frame and the water's shader reads the same values, so the
 * water can never reflect a sky that is out of step with the one on screen.
 */
export interface SkyUniforms {
  [name: string]: THREE.IUniform;
  uSunDirection: THREE.IUniform;
  uTurbidity: THREE.IUniform;
  uMieCoefficient: THREE.IUniform;
  uMieDirectionalG: THREE.IUniform;
  uRayleigh: THREE.IUniform;
  uSunIntensity: THREE.IUniform;
  uSkyLuminance: THREE.IUniform;
  uSunDiscColor: THREE.IUniform;
  uNight: THREE.IUniform;
  uMoonDirection: THREE.IUniform;
  uMoonPhase: THREE.IUniform;
  uStarIntensity: THREE.IUniform;
  uTime: THREE.IUniform;
}

export function createSkyUniforms(): SkyUniforms {
  return {
    uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
    uTurbidity: { value: 3.4 },
    uMieCoefficient: { value: 0.005 },
    uMieDirectionalG: { value: 0.8 },
    uRayleigh: { value: SKY_RAYLEIGH.clone().multiplyScalar(1.6) },
    uSunIntensity: { value: 900 },
    uSkyLuminance: { value: 1 },
    uSunDiscColor: { value: new THREE.Color(1, 1, 1) },
    uNight: { value: 0 },
    uMoonDirection: { value: new THREE.Vector3(0, -1, 0) },
    uMoonPhase: { value: 0.72 },
    uStarIntensity: { value: 1 },
    uTime: { value: 0 },
  };
}

/* ------------------------------------------------------------------ */
/* GLSL                                                               */
/* ------------------------------------------------------------------ */

const GLSL_SKY_DECLS = /* glsl */ `
uniform vec3 uSunDirection;      // world space, pointing towards the sun
uniform float uTurbidity;
uniform float uMieCoefficient;
uniform float uMieDirectionalG;
uniform vec3 uRayleigh;
uniform float uSunIntensity;
uniform float uSkyLuminance;
uniform vec3 uSunDiscColor;
uniform float uNight;            // 0 by day, 1 at night
uniform vec3 uMoonDirection;
uniform float uMoonPhase;        // 0 new .. 1 full
uniform float uStarIntensity;
uniform float uTime;

const float SKY_PI = 3.141592653589793;
const vec3 SKY_MIE_CONST = vec3( 1.8399918514433978E14, 2.7798023919666528E14, 4.0790479543861094E14 );
`;

/** Rayleigh + Mie scattering and the sun disc. Reused verbatim by the water. */
export const GLSL_SKY_SCATTERING = /* glsl */ `
${GLSL_SKY_DECLS}

float scRayleighPhase( float c ) {
  return ( 3.0 / ( 16.0 * SKY_PI ) ) * ( 1.0 + c * c );
}

float scHenyeyGreenstein( float c, float g ) {
  float g2 = g * g;
  return ( 1.0 / ( 4.0 * SKY_PI ) ) * ( ( 1.0 - g2 ) / pow( max( 1.0 + g2 - 2.0 * g * c, 1e-4 ), 1.5 ) );
}

vec3 scTotalMie( float turbidity ) {
  float c = ( 0.2 * turbidity ) * 1e-18;
  return 0.434 * c * SKY_MIE_CONST;
}

// Rozenberg's fit to the Chapman function: the relative optical depth through
// the whole atmosphere along a ray at this cosine from the zenith. This is the
// integral the classic Sky shader marches 100 steps to approximate.
float scAirMass( float cosZenith ) {
  float deg = degrees( acos( clamp( cosZenith, -1.0, 1.0 ) ) );
  return 1.0 / ( max( cosZenith, 0.0 ) + 0.15 * pow( max( 93.885 - deg, 0.02 ), -1.253 ) );
}

float scSunExtinction( float cosSunZenith ) {
  const float cutoff = 1.6110731556870734;
  const float steepness = 1.5;
  return max( 0.0, 1.0 - exp( -( ( cutoff - acos( clamp( cosSunZenith, -1.0, 1.0 ) ) ) / steepness ) ) );
}

/** In-scattered radiance along `dir`, in the same units as the sun intensity. */
vec3 scSkyRadiance( vec3 dir ) {
  vec3 betaR = uRayleigh;
  vec3 betaM = scTotalMie( uTurbidity ) * uMieCoefficient;
  float m = scAirMass( dir.y );
  vec3 sR = betaR * ${RAYLEIGH_SCALE_HEIGHT.toFixed(1)} * m;
  vec3 sM = betaM * ${MIE_SCALE_HEIGHT.toFixed(1)} * m;
  vec3 Fex = exp( -( betaR * sR + betaM * sM ) );

  float cosSun = dot( dir, uSunDirection );
  vec3 ratio = ( betaR * scRayleighPhase( cosSun ) + betaM * scHenyeyGreenstein( cosSun, uMieDirectionalG ) )
    / ( betaR + betaM );
  float sunE = scSunExtinction( uSunDirection.y ) * uSunIntensity;

  vec3 lin = pow( max( sunE * ratio * ( 1.0 - Fex ), 0.0 ), vec3( 1.5 ) );
  // Looking towards the sun the in-scattered term is replaced by the
  // forward-scattered one; that is what makes the aureole around the sun.
  float sunFade = clamp( pow( 1.0 - uSunDirection.y, 5.0 ), 0.0, 1.0 );
  lin *= mix( vec3( 1.0 ), pow( max( sunE * ratio * Fex, 0.0 ), vec3( 1.5 ) ), sunFade );
  return lin * uSkyLuminance;
}

/** The sun's disc with a real limb-darkening law, plus its aureole. */
vec3 scSunDisc( vec3 dir ) {
  float cosSun = dot( dir, uSunDirection );
  float ang = acos( clamp( cosSun, -1.0, 1.0 ) );
  const float sunRadius = 0.0093;   // ~0.53 degrees
  float disc = 1.0 - smoothstep( sunRadius * 0.96, sunRadius, ang );
  float r = clamp( ang / sunRadius, 0.0, 1.0 );
  float mu = sqrt( max( 0.0, 1.0 - r * r ) );
  // Hestroffer & Magnan: I(mu)/I(1) = 1 - u(1-mu) - v(1-mu)^2, u=0.93, v=0.23.
  float limb = 1.0 - 0.93 * ( 1.0 - mu ) - 0.23 * ( 1.0 - mu ) * ( 1.0 - mu );
  float aureole = pow( max( cosSun, 0.0 ), 1400.0 ) * 0.5 + pow( max( cosSun, 0.0 ), 12.0 ) * 0.012;
  return ( uSunDiscColor * limb * disc * 14.0 + uSunDiscColor * aureole ) * smoothstep( -0.06, 0.02, uSunDirection.y );
}
`;

const GLSL_SKY_NIGHT = /* glsl */ `
${GLSL_HASH}
${GLSL_NOISE}

/** Airglow gradient: deep blue overhead, a shade warmer at the horizon. */
vec3 scNightSky( vec3 dir ) {
  float up = clamp( dir.y, 0.0, 1.0 );
  vec3 zenith = vec3( 0.0075, 0.0125, 0.0300 );
  vec3 horizon = vec3( 0.0230, 0.0290, 0.0520 );
  vec3 c = mix( horizon, zenith, pow( up, 0.42 ) );
  // The sun is still just under the horizon: leave its afterglow sitting there.
  vec3 flat_ = normalize( vec3( dir.x, 0.0, dir.z ) + 1e-5 );
  vec3 sunFlat = normalize( vec3( uSunDirection.x, 0.0, uSunDirection.z ) + 1e-5 );
  float afterglow = pow( max( dot( flat_, sunFlat ), 0.0 ), 5.0 ) * ( 1.0 - smoothstep( -0.02, 0.30, dir.y ) );
  c += vec3( 0.16, 0.075, 0.045 ) * afterglow * ( 1.0 - uNight * 0.55 );
  return c;
}

/** One layer of stars: a hashed point per cell, brightness and colour varied. */
float scStarLayer( vec3 dir, float scale, float density, float size, out vec3 tint ) {
  vec3 p = dir * scale;
  vec3 cell = floor( p );
  vec3 h = sc_hash33( cell );
  if ( h.x > density ) {
    tint = vec3( 0.0 );
    return 0.0;
  }
  float dist = length( fract( p ) - h );
  float bright = 0.25 + 0.75 * fract( h.y * 91.7 );
  tint = mix( vec3( 0.72, 0.80, 1.0 ), vec3( 1.0, 0.86, 0.70 ), fract( h.z * 57.3 ) );
  return smoothstep( size, 0.0, dist ) * bright;
}

/**
 * Stars and the galactic band. Three densities so the sky has both a few
 * bright anchors and a dust of faint ones, plus a milky way band from 3D fBm
 * so the sky is not a uniform field of dots.
 */
vec3 scStars( vec3 dir ) {
  vec3 tint;
  float total = scStarLayer( dir, 70.0, 0.055, 0.16, tint );
  vec3 color = tint * total;
  total = scStarLayer( dir, 150.0, 0.10, 0.20, tint );
  color += tint * total * 0.7;
  total = scStarLayer( dir, 300.0, 0.16, 0.26, tint );
  color += tint * total * 0.42;

  // Galactic plane: a great circle tilted off the horizon, thickened and
  // clumped with 3D noise so it reads as dust rather than a drawn line.
  vec3 axis = normalize( vec3( 0.42, 0.78, -0.46 ) );
  float band = 1.0 - smoothstep( 0.0, 0.20, abs( dot( dir, axis ) ) );
  float clump = sc_fbm3( dir * 5.0, 4 );
  color += vec3( 0.055, 0.058, 0.075 ) * band * band * ( 0.35 + 1.3 * clump );

  // Scintillation: a slow, low-amplitude twinkle so the sky is not dead.
  float twinkle = 0.82 + 0.18 * sin( uTime * 2.1 + dir.x * 31.0 + dir.z * 17.0 );
  return color * uStarIntensity * twinkle;
}

/** A phase-lit moon with maria, limb falloff and a soft halo. */
vec3 scMoon( vec3 dir ) {
  float cosMoon = dot( dir, uMoonDirection );
  float ang = acos( clamp( cosMoon, -1.0, 1.0 ) );
  const float moonRadius = 0.0110;
  float disc = 1.0 - smoothstep( moonRadius * 0.90, moonRadius, ang );

  vec3 up = abs( uMoonDirection.y ) < 0.95 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
  vec3 tx = normalize( cross( up, uMoonDirection ) );
  vec3 ty = cross( uMoonDirection, tx );
  vec2 uv = vec2( dot( dir, tx ), dot( dir, ty ) ) / moonRadius;
  float rr = clamp( length( uv ), 0.0, 1.0 );
  vec3 n = vec3( uv, sqrt( max( 0.0, 1.0 - rr * rr ) ) );

  // Terminator: the projection of the sun onto the disc plane.
  vec2 sunUv = vec2( dot( uSunDirection, tx ), dot( uSunDirection, ty ) );
  float sunLen = length( sunUv );
  float lit = sunLen < 0.05
    ? 1.0
    : smoothstep( -0.12, 0.16, dot( uv, sunUv / sunLen ) ) * 0.94 + 0.06;
  lit = clamp( lit, 0.0, 1.0 ) * uMoonPhase;

  float maria = 0.80 + 0.30 * sc_fbm2( uv * 1.7 + 11.0, 3, 2.0, 0.5 );
  float limb = 0.55 + 0.45 * n.z;
  vec3 surface = vec3( 0.92, 0.90, 0.86 ) * maria * limb * lit;

  float halo = pow( max( cosMoon, 0.0 ), 900.0 ) * 0.35 + pow( max( cosMoon, 0.0 ), 40.0 ) * 0.02;
  return surface * disc * 1.6 + vec3( 0.55, 0.62, 0.80 ) * halo * ( 0.25 + 0.75 * uMoonPhase ) * smoothstep( -0.02, 0.06, uMoonDirection.y );
}
`;

const GLSL_VERTEX = /* glsl */ `
varying vec3 vSkyDir;
void main() {
  // The local position IS the view direction. The dome is drawn as a sphere
  // large enough to contain the camera from anywhere on the map, so treating
  // its geometry as a direction rather than a position makes the sky infinitely
  // far away with no parallax error and nothing to keep in sync per frame.
  vSkyDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const GLSL_FRAGMENT = /* glsl */ `
varying vec3 vSkyDir;
${GLSL_SKY_SCATTERING}
${GLSL_SKY_NIGHT}

void main() {
  vec3 dir = normalize( vSkyDir );
  vec3 color = scSkyRadiance( dir );
  color += scSunDisc( dir );

  if ( uNight > 0.001 ) {
    color += scNightSky( dir ) * uNight;
    color += scStars( dir ) * uNight * smoothstep( -0.04, 0.02, dir.y );
    color += scMoon( dir ) * uNight;
  }

  // Below the horizon there is no sky, only the dark side of the world; this
  // keeps the terrain silhouette and the sea horizon reading correctly.
  float below = smoothstep( 0.0, -0.06, dir.y );
  color = mix( color, color * 0.22, below );

  gl_FragColor = vec4( max( color, 0.0 ), 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ */
/* Material                                                           */
/* ------------------------------------------------------------------ */

export interface SkyMaterialHandle {
  readonly material: THREE.ShaderMaterial;
  readonly uniforms: SkyUniforms;
  dispose(): void;
}

export interface SkyMaterialOptions {
  turbidity?: number;
  mieCoefficient?: number;
  mieDirectionalG?: number;
  rayleighScale?: number;
  luminance?: number;
}

export function createSkyMaterial(options: SkyMaterialOptions = {}): SkyMaterialHandle {
  const uniforms = createSkyUniforms();
  if (options.turbidity !== undefined) uniforms.uTurbidity.value = options.turbidity;
  if (options.mieCoefficient !== undefined) uniforms.uMieCoefficient.value = options.mieCoefficient;
  if (options.mieDirectionalG !== undefined) uniforms.uMieDirectionalG.value = options.mieDirectionalG;
  if (options.rayleighScale !== undefined) {
    uniforms.uRayleigh.value = SKY_RAYLEIGH.clone().multiplyScalar(options.rayleighScale);
  }
  if (options.luminance !== undefined) uniforms.uSkyLuminance.value = options.luminance;

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: GLSL_VERTEX,
    fragmentShader: GLSL_FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: true,
  });
  material.name = "sky.dome";

  return {
    material,
    uniforms,
    dispose(): void {
      material.dispose();
    },
  };
}
