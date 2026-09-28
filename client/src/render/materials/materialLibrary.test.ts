/**
 * The material library is a GPU-resource cache: a miss means a new material
 * per draw call, and a mis-tuned surface makes a unit look like the wrong
 * material. These tests pin the memoisation, the PBR configuration per surface
 * family, and the shader injection the renderer actually compiles.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import type { Race } from "@shared/protocol";
import { entityDef, raceData, unitKeys, buildingKeys } from "@shared/gameData";
import {
  disposeMaterials,
  energyMaterial,
  materialCount,
  materialFor,
  updateMaterialClock,
} from "./materialLibrary";
import { SURFACE_PBR, paletteHex, racePalette } from "./palette";

const RACES: Race[] = ["terran", "zerg", "protoss"];

const standard = (m: THREE.Material): THREE.MeshStandardMaterial => {
  if (!(m instanceof THREE.MeshStandardMaterial)) {
    throw new Error(`expected a MeshStandardMaterial, got ${m.type}`);
  }
  return m;
};

afterEach(() => disposeMaterials());

describe("memoisation", () => {
  it("returns the identical instance for the same type and race", () => {
    const a = materialFor("marine", "terran");
    const b = materialFor("marine", "terran");
    expect(b).toBe(a);
    expect(materialCount()).toBe(1);
  });

  it("a hundred of the same unit still cost one material", () => {
    const first = materialFor("marine", "terran");
    for (let i = 0; i < 100; i++) expect(materialFor("marine", "terran")).toBe(first);
    expect(materialCount()).toBe(1);
  });

  it("a different race is a different material", () => {
    expect(materialFor("marine", "terran")).not.toBe(materialFor("marine", "protoss"));
  });

  it("a different type key is a different material", () => {
    expect(materialFor("marine", "terran")).not.toBe(materialFor("firebat", "terran"));
  });

  it("every one of the 57 entity keys yields a distinct, named material", () => {
    const seen: THREE.Material[] = [];
    for (const race of RACES) {
      for (const key of [...unitKeys(race), ...buildingKeys(race)]) {
        const m = standard(materialFor(key, race));
        expect(m.name).toBe(`${entityDef(key).key}-${race}`);
        expect(seen).not.toContain(m);
        seen.push(m);
      }
    }
    expect(seen).toHaveLength(57);
    expect(materialCount()).toBe(57);
  });

  it("energyMaterial is memoised per race and tint", () => {
    const a = energyMaterial("terran");
    expect(energyMaterial("terran")).toBe(a);
    expect(energyMaterial("zerg")).not.toBe(a);
    expect(energyMaterial("terran", 0x00ff00)).not.toBe(a);
    expect(energyMaterial("terran", 0x00ff00)).toBe(energyMaterial("terran", 0x00ff00));
  });

  it("re-requests after disposal build a fresh material", () => {
    const before = materialFor("marine", "terran");
    const beforeEnergy = energyMaterial("zerg");
    expect(materialCount()).toBe(2);
    disposeMaterials();
    expect(materialCount()).toBe(0);
    const after = materialFor("marine", "terran");
    expect(after).not.toBe(before);
    expect(energyMaterial("zerg")).not.toBe(beforeEnergy);
  });
});

describe("surface configuration", () => {
  it("a terran infantryman is metal", () => {
    const m = standard(materialFor("marine", "terran"));
    const pbr = SURFACE_PBR.metal;
    expect(m.metalness).toBe(pbr.metalness);
    expect(m.roughness).toBe(pbr.roughness);
    expect(m.emissiveIntensity).toBe(pbr.emissiveIntensity);
    expect(m.metalness).toBeGreaterThan(0.7);
    expect(m.roughness).toBeGreaterThan(0.2);
    expect(m.roughness).toBeLessThan(0.7);
    expect(m.transparent).toBe(false);
  });

  it("a zerg unit is organic, never metal", () => {
    const m = standard(materialFor("queen", "zerg"));
    const pbr = SURFACE_PBR.organic;
    expect(m.metalness).toBe(pbr.metalness);
    expect(m.roughness).toBe(pbr.roughness);
    expect(m.metalness).toBeLessThan(0.2);
    expect(m.roughness).toBeGreaterThan(0.5);
    expect(m.transparent).toBe(false);
  });

  it("a bunker is rock, whoever owns it", () => {
    for (const race of RACES.filter((r) => r !== "zerg")) {
      const m = standard(materialFor("bunker", race));
      expect(m.metalness).toBe(0);
      expect(m.roughness).toBe(SURFACE_PBR.rock.roughness);
      expect(m.roughness).toBeGreaterThan(0.8);
      expect(m.emissiveIntensity).toBe(0);
      expect(m.transparent).toBe(false);
    }
  });

  it("energy material is additive, emissive and see-through", () => {
    const m = standard(energyMaterial("protoss"));
    const pbr = SURFACE_PBR.energy;
    expect(m.metalness).toBe(pbr.metalness);
    expect(m.roughness).toBe(pbr.roughness);
    expect(m.emissiveIntensity).toBe(pbr.emissiveIntensity);
    expect(m.emissiveIntensity).toBeGreaterThan(1);
    expect(m.transparent).toBe(true);
    expect(m.opacity).toBe(pbr.opacity);
    expect(m.opacity).toBeGreaterThan(0);
    expect(m.opacity).toBeLessThan(1);
    expect(m.depthWrite).toBe(false);
    expect(m.blending).toBe(THREE.AdditiveBlending);
    expect(m.side).toBe(THREE.DoubleSide);
  });

  it("the energy tint follows the race palette and an explicit override wins", () => {
    const p = racePalette("zerg");
    expect(standard(energyMaterial("zerg")).emissive.getHex(THREE.SRGBColorSpace)).toBe(
      p.hex.energy,
    );
    const custom = standard(energyMaterial("zerg", 0x3366ff));
    expect(custom.emissive.getHex(THREE.SRGBColorSpace)).toBe(0x3366ff);
    expect(paletteHex("zerg", "energy")).not.toBe(0x3366ff);
  });

  it("colours, maps and vertex colours are wired from the race palette", () => {
    for (const race of RACES) {
      const m = standard(materialFor("zealot", race));
      const palette = racePalette(race);
      const kind = race === "zerg" ? "organic" : "metal";
      expect(m.color.getHex(THREE.SRGBColorSpace)).toBe(palette.hex[kind]);
      expect(m.emissive.getHex(THREE.SRGBColorSpace)).toBe(palette.hex.emissive);
      expect(m.vertexColors).toBe(true);
      expect(m.map).toBeInstanceOf(THREE.DataTexture);
      expect(m.normalMap).toBeInstanceOf(THREE.DataTexture);
      expect(m.roughnessMap).toBeInstanceOf(THREE.DataTexture);
      expect(m.normalMap?.colorSpace).toBe(THREE.NoColorSpace);
      expect(m.roughnessMap?.colorSpace).toBe(THREE.NoColorSpace);
      expect(m.envMapIntensity).toBeCloseTo(0.7, 5);
    }
  });

  it("rock and metal races never share a material", () => {
    const a = standard(materialFor("bunker", "terran"));
    const b = standard(materialFor("marine", "terran"));
    expect(a.map).not.toBe(b.map);
    expect(a.color.getHex()).not.toBe(b.color.getHex());
  });
});

describe("shader injection and the clock", () => {
  const compile = (m: THREE.Material): { fragmentShader: string; uniforms: Record<string, THREE.IUniform> } => {
    const shader = {
      fragmentShader:
        "#include <common>\n#include <color_fragment>\n#include <emissivemap_fragment>",
      vertexShader: "#include <worldpos_vertex>\nvoid main() { }",
      uniforms: {} as Record<string, THREE.IUniform>,
    };
    m.onBeforeCompile?.(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      null as unknown as THREE.WebGLRenderer,
    );
    return shader;
  };

  it("splices the per-part uniforms and energy pulse into the fragment shader", () => {
    const m = standard(materialFor("marine", "terran"));
    const shader = compile(m);
    expect(shader.fragmentShader).toContain("uniform float uStarcTime;");
    expect(shader.fragmentShader).toContain("uniform vec3 uEnergyColor;");
    expect(shader.fragmentShader).toContain("totalEmissiveRadiance += uEnergyColor * vColor.a");
    expect(shader.uniforms.uEnergyColor?.value).toBeInstanceOf(THREE.Color);
    expect(
      (shader.uniforms.uEnergyColor?.value as THREE.Color).getHex(THREE.SRGBColorSpace),
    ).toBe(racePalette("terran").hex.energy);
  });

  it("the energy material gets the fresnel rim and no colour-alpha patch", () => {
    const shader = compile(energyMaterial("protoss"));
    expect(shader.fragmentShader).toContain("sc_fresnel");
    expect(shader.fragmentShader).toContain("starcRim");
    expect(shader.fragmentShader).not.toContain("USE_COLOR_ALPHA");
    expect(shader.uniforms.uEnergyPulse?.value).toBeGreaterThan(1);
  });

  it("the program cache key distinguishes the injected variants", () => {
    const part = standard(materialFor("marine", "terran"));
    const energy = standard(energyMaterial("protoss"));
    expect(part.customProgramCacheKey()).toContain("starc-parts");
    expect(energy.customProgramCacheKey()).toContain("starc-energy");
    expect(part.customProgramCacheKey()).not.toBe(energy.customProgramCacheKey());
  });

  it("updateMaterialClock drives every material's time uniform", () => {
    const part = compile(materialFor("marine", "terran")).uniforms;
    const energy = compile(energyMaterial("terran")).uniforms;
    updateMaterialClock(4.5);
    expect(part.uStarcTime?.value).toBe(4.5);
    expect(energy.uStarcTime?.value).toBe(4.5);
    updateMaterialClock(0);
    expect(part.uStarcTime?.value).toBe(0);
  });

  it("the clock is per material, so one unit's clock cannot advance another's", () => {
    const a = compile(materialFor("marine", "terran")).uniforms;
    const b = compile(materialFor("zealot", "terran")).uniforms;
    updateMaterialClock(2);
    expect(a.uStarcTime?.value).toBe(2);
    expect(b.uStarcTime?.value).toBe(2);
    expect(a.uStarcTime).not.toBe(b.uStarcTime);
  });
});

describe("guards", () => {
  it("an unknown entity type is rejected rather than silently shaded", () => {
    expect(() => materialFor("not_a_unit", "terran")).toThrow(/unknown entity type/i);
  });

  it("every race has at least one key that maps to a material", () => {
    for (const race of RACES) {
      const key = unitKeys(race)[0];
      expect(key).toBeDefined();
      expect(standard(materialFor(key as string, race)).name).toContain(race);
      expect(raceData(race).race).toBe(race);
    }
  });
});
