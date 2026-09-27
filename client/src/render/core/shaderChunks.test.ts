/**
 * The injected GLSL must be legal shader source.
 *
 * The bug these pin: the injected body referenced uniforms as
 * `uChunkScale.value` — three.js's JavaScript `Uniform` accessor, which is
 * illegal GLSL ("field selection requires structure, vector, or interface
 * block on left hand side"). It compiled fine at the low preset, where the
 * panel/fresnel/emissive chunks are not requested, and broke the
 * `command_center-terran` material at high and ultra:
 *
 *   ERROR: 0:1748: 'value' : field selection requires structure...
 *   ERROR: 0:1750: 'sc_emissiveScan' : no matching overloaded function found
 *
 * A second latent failure sat next to it: the emissive scan is time-driven and
 * used `uTime`, but `uTime` was only declared for the time/panel/fresnel
 * options, so a material requesting `emissive` alone would not compile either.
 *
 * There is no GLSL compiler in the unit suite, so these assert the two
 * properties that would have caught it: no JavaScript accessor syntax survives
 * into the shader, and every uniform the body reads is declared.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { GLSL_FBM, GLSL_HASH, GLSL_NOISE, injectShaderChunks } from "./shaderChunks";

/** Captures what `onBeforeCompile` would splice into a compiled program. */
function splice(options: Parameters<typeof injectShaderChunks>[1]) {
  const material = new THREE.MeshStandardMaterial();
  injectShaderChunks(material, options);

  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: "void main() { }",
    // The injection splices declarations before `void main()` and the effect
    // body after `#include <emissivemap_fragment>`. A fixture missing either
    // anchor silently splices nothing, and every assertion below becomes
    // vacuous — which is exactly what happened the first time.
    fragmentShader: ["void main() {", "  #include <emissivemap_fragment>", "}"].join("\n"),
  };
  const patched = material.onBeforeCompile;
  expect(typeof patched, "injectShaderChunks must patch onBeforeCompile").toBe("function");
  patched.call(material, shader as never, null as never);
  return { declarations: shader.fragmentShader, uniforms: shader.uniforms };
}

const U_TIME = "uTime";
const U_CHUNK_STRENGTH = "uChunkStrength";
const U_CHUNK_SCALE = "uChunkScale";
const U_FRESNEL_POWER = "uFresnelPower";
const U_RIM_COLOR = "uRimColor";

describe("injected shader chunks", () => {
  const cases = [
    { name: "detail", options: { detail: true } },
    { name: "panel", options: { panel: true } },
    { name: "fresnel", options: { fresnel: true } },
    { name: "emissive", options: { emissive: true } },
    { name: "everything", options: { detail: true, panel: true, fresnel: true, emissive: true } },
  ] as const;

  for (const { name, options } of cases) {
    it(`emits no JavaScript accessor syntax with ${name}`, () => {
      const { declarations } = splice(options);
      // `uFoo.value` in a shader is a field selection on a float.
      const offenders = declarations.match(/\b[a-zA-Z_]\w*\.value\b/g) ?? [];
      expect(offenders, `JS accessor syntax leaked into GLSL (${name})`).toEqual([]);
    });

    it(`declares every uniform the ${name} body reads`, () => {
      const { declarations, uniforms } = splice(options);
      // `uniform <type> <name>;` for each declaration.
      const declared = new Set(
        [...declarations.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1]),
      );
      for (const name of [U_TIME, U_CHUNK_STRENGTH, U_CHUNK_SCALE, U_FRESNEL_POWER, U_RIM_COLOR]) {
        // A uniform is only meaningful if it is both declared and supplied.
        const used = new RegExp(`\\b${name}\\b`).test(declarations.split("void main")[0] ?? "");
        if (!used) continue;
        expect(declared.has(name) || Object.prototype.hasOwnProperty.call(uniforms, name),
          `${name} is read but neither declared nor supplied (${name})`).toBe(true);
      }
    });
  }

  it("declares uTime for the emissive scan, which is time-driven", () => {
    const { declarations, uniforms } = splice({ emissive: true });
    expect(Object.prototype.hasOwnProperty.call(uniforms, U_TIME)).toBe(true);
    expect(declarations).toContain(`uniform float ${U_TIME};`);
  });

  it("keeps the exported GLSL helper chunks free of accessor syntax", () => {
    for (const [name, chunk] of Object.entries({ GLSL_HASH, GLSL_NOISE, GLSL_FBM })) {
      expect(chunk.match(/\b[a-zA-Z_]\w*\.value\b/g) ?? [], `${name}`).toEqual([]);
      const open = (chunk.match(/\{/g) ?? []).length;
      const close = (chunk.match(/\}/g) ?? []).length;
      expect(open, `${name} brace balance`).toBe(close);
    }
  });

  it("drives uTime from the returned handle so the scan animates", () => {
    const material = new THREE.MeshStandardMaterial();
    const handle = injectShaderChunks(material, { emissive: true });
    handle.update(4.5);
    expect(handle.uniforms[U_TIME].value).toBe(4.5);
    expect(() => handle.dispose()).not.toThrow();
  });
});
