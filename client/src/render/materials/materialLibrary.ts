/**
 * Material library — one shared MeshStandardMaterial per entity type, tinted
 * by the race palette and shaded with procedurally generated maps.
 *
 * 100% procedural: every map comes from `./proceduralTextures`, so the client
 * renders correctly with the network unplugged. Nothing here allocates per
 * frame: `materialFor` memoises, and the animated uniforms are advanced in one
 * pass by `updateMaterialClock`.
 *
 * Vertex colours do the per-part work. The builders in `../geometry` write a
 * tone multiplier into rgb and an emissive mask into alpha; the injected
 * shader applies the rgb on top of the race colour and lights the masked
 * parts with the race's energy colour, pulsing off a single clock.
 */
import * as THREE from "three";
import { entityDef } from "@shared/gameData";
import type { Race } from "@shared/protocol";
import { GLSL_FRESNEL, injectShaderChunks } from "@render/core/shaderChunks";
import type { ShaderChunkHandle } from "@render/core/shaderChunks";
import { SURFACE_PBR, paletteHex, racePalette } from "./palette";
import type { SurfaceKind } from "./palette";
import {
  chitinTexture,
  energyFieldTexture,
  metalPanelTexture,
  noiseNormalTexture,
  noiseTexture,
  rockTexture,
} from "./proceduralTextures";

interface MaterialRecord {
  material: THREE.Material;
  clock: THREE.IUniform;
  chunks: ShaderChunkHandle | null;
}

const library = new Map<string, MaterialRecord>();

/** Uniforms the injected code expects, kept distinct from core's own names. */
const FRAGMENT_PARS = `
uniform float uStarcTime;
uniform vec3 uEnergyColor;
uniform float uEnergyPulse;
`;

/** Which surface family an entity is made of. Drives the PBR triple + maps. */
function surfaceFor(typeKey: string, race: Race): SurfaceKind {
  if (race === "zerg") return "organic";
  if (typeKey === "bunker") return "rock";
  return "metal";
}

/**
 * Adds the per-part colour/energy treatment to a standard material. `vColor`
 * (rgb = tone multiplier, a = energy mask) and the clock are all three.js
 * already provides, so the only new state is the two tunables above.
 */
function applyPartShader(
  material: THREE.MeshStandardMaterial,
  clock: THREE.IUniform,
  energyColor: THREE.Color,
  energyPulse: number,
): void {
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  const uniforms = {
    uStarcTime: clock,
    uEnergyColor: { value: energyColor },
    uEnergyPulse: { value: energyPulse },
  };
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS}`)
      .replace(
        "#include <color_fragment>",
        [
          "#include <color_fragment>",
          "#ifdef USE_COLOR_ALPHA",
          "  diffuseColor.a = 1.0;",
          "#endif",
        ].join("\n"),
      )
      .replace(
        "#include <emissivemap_fragment>",
        [
          "#include <emissivemap_fragment>",
          "#ifdef USE_COLOR_ALPHA",
          "  float starcPhase = 0.0;",
          "  #ifdef USE_MAP",
          "    starcPhase = vMapUv.x * 8.0 + vMapUv.y * 4.0;",
          "  #endif",
          "  float starcPulse = 0.72 + 0.28 * sin(uStarcTime * 3.0 + starcPhase);",
          "  totalEmissiveRadiance += uEnergyColor * vColor.a * uEnergyPulse * starcPulse;",
          "#endif",
        ].join("\n"),
      );
  };
  material.customProgramCacheKey = () => `${previousKey.call(material)}|starc-parts`;
}

/** Scrolling plasma plus a fresnel rim, for beams, shields and projectiles. */
function applyEnergyShader(
  material: THREE.MeshStandardMaterial,
  clock: THREE.IUniform,
  glow: THREE.Color,
): void {
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  const uniforms = {
    uStarcTime: clock,
    uEnergyColor: { value: glow },
    uEnergyPulse: { value: 1.6 },
  };
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS}\n${GLSL_FRESNEL}`)
      .replace(
        "#include <emissivemap_fragment>",
        [
          "#ifdef USE_EMISSIVEMAP",
          "  vec2 starcUv = vEmissiveMapUv + vec2(uStarcTime * 0.06, uStarcTime * -0.04);",
          "  totalEmissiveRadiance *= texture2D(emissiveMap, starcUv).rgb;",
          "#endif",
          "float starcRim = sc_fresnel(normalize(-vViewPosition), normal, 2.2);",
          "totalEmissiveRadiance += uEnergyColor * uEnergyPulse * starcRim * 0.6;",
        ].join("\n"),
      );
  };
  material.customProgramCacheKey = () => `${previousKey.call(material)}|starc-energy`;
}

/**
 * Shared material for an entity type. Memoised on `typeKey` + `race`, so
 * asking twice hands back the identical instance and a hundred Marines cost
 * one material.
 */
export function materialFor(typeKey: string, race: Race): THREE.Material {
  const id = `${typeKey}:${race}`;
  const cached = library.get(id);
  if (cached) return cached.material;

  const def = entityDef(typeKey);
  const palette = racePalette(race);
  const kind = surfaceFor(typeKey, race);
  const pbr = SURFACE_PBR[kind];
  const albedo =
    kind === "metal"
      ? metalPanelTexture(256, { seed: 4211 + race.length, panels: 3 })
      : kind === "organic"
        ? chitinTexture(256, { seed: 9091 + race.length, cells: 5 })
        : rockTexture(256, { seed: 7702 });

  const material = new THREE.MeshStandardMaterial({
    name: `${def.key}-${race}`,
    color: palette.colors[kind],
    map: albedo,
    normalMap: noiseNormalTexture(128, 1.4),
    roughnessMap: noiseTexture(128),
    metalness: pbr.metalness,
    roughness: pbr.roughness,
    emissive: palette.colors.emissive,
    emissiveIntensity: pbr.emissiveIntensity,
    vertexColors: true,
    envMapIntensity: 0.7,
  });
  material.normalScale.set(0.6, 0.6);

  const clock: THREE.IUniform = { value: 0 };
  const chunks = injectShaderChunks(material, {
    panel: true,
    panelScale: 1.6,
    emissive: true,
  });
  applyPartShader(material, clock, palette.colors.energy, 2.4);
  library.set(id, { material, clock, chunks });
  return material;
}

/**
 * Animated energy surface for beams, shields and projectiles: additive, depth
 * test on but depth write off, with the plasma field scrolling on the clock.
 */
export function energyMaterial(race: Race, colour?: number): THREE.Material {
  const tint = colour ?? paletteHex(race, "energy");
  const id = `energy:${race}:${tint.toString(16)}`;
  const cached = library.get(id);
  if (cached) return cached.material;

  const pbr = SURFACE_PBR.energy;
  const glow = new THREE.Color(tint);
  const material = new THREE.MeshStandardMaterial({
    name: id,
    color: glow,
    emissive: glow,
    emissiveIntensity: pbr.emissiveIntensity,
    emissiveMap: energyFieldTexture(256),
    metalness: pbr.metalness,
    roughness: pbr.roughness,
    transparent: true,
    opacity: pbr.opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const clock: THREE.IUniform = { value: 0 };
  applyEnergyShader(material, clock, glow);
  library.set(id, { material, clock, chunks: null });
  return material;
}

/** Advances every animated material in the library. One call per frame. */
export function updateMaterialClock(seconds: number): void {
  for (const record of library.values()) {
    record.clock.value = seconds;
    record.chunks?.update(seconds);
  }
}

/** Number of live materials; handy in tests and on teardown. */
export function materialCount(): number {
  return library.size;
}

/** Disposes every material and its injected shader chunks. */
export function disposeMaterials(): void {
  for (const record of library.values()) {
    record.chunks?.dispose();
    record.material.dispose();
  }
  library.clear();
}
