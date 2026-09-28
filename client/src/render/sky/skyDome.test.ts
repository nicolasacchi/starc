/**
 * The moon the dome paints and the moon the key light shines from are one
 * object, and these drive the real `SkyDome` over a whole clock to keep them
 * one object.
 *
 * `lighting.ts` evaluates a two-unit cycle: [0,1] is the day arc, [1,2] the
 * night arc, and once the sun is down the key light's direction IS the moon
 * (the rig lerps fully onto its night-arc moon). A disc painted anywhere else
 * is a second, independent sun model — the failure the dome's own header
 * says cannot happen. It did: the reading was advanced by half a cycle, which
 * is quadrature, not anti-solar, and the disc sat 49-139 degrees from the
 * moonlight at midnight.
 *
 * Tolerance. The disc is deliberately lagged — a gibbous moon trails the
 * anti-solar point by `(phase - 0.5) * 0.2` of a cycle, and the shipped
 * phases (0.55..0.97) make that 0.011..0.094. Travelling that far along the
 * night arc turns the moon 2 rad of azimuth and up to 42 deg of elevation, so
 * the disc is INTENDED to sit up to 3.05 * 0.094 = 0.287 rad = 16.4 degrees
 * from the light; 20 degrees is the round number above that bound. The gate is
 * `night >= 0.99` for the same reason from the other side: below it the key
 * light is a blend of a sun under the horizon and a moon over it, so "the
 * light comes from the moon" is not yet true of the direction the rig hands
 * out, and no disc can be near it.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { MapDef } from "@shared/protocol";
import { GAME } from "@shared/gameData";
import { settingsFor } from "@render/core/quality";
import { GLSL_SKY_SCATTERING } from "./skyMaterial";
import { SkyDome } from "./skyDome";

/** Degrees between two directions, from their dot product. */
const DEGREES = 180 / Math.PI;

/** The dome may be this far from the moonlight; see the header. */
const MOON_TOLERANCE_DEG = 20;

/**
 * Past this the key light is the moon to within a percent, so the dome's
 * painted disc and the rig's direction describe the same object.
 */
const KEY_IS_THE_MOON = 0.99;

/** A 48 hour sweep of the two-unit cycle, in 1.4 minute steps. */
const CLOCK_START = 0;
const CLOCK_END = 4;
const CLOCK_STEP = 0.002;

function mountDome(map: MapDef): SkyDome {
  return new SkyDome(new THREE.Scene(), map, settingsFor("medium"));
}

function domes(): SkyDome[] {
  return GAME.maps.map(mountDome);
}

describe("sky dome moon", () => {
  const built = domes();

  afterAll(() => {
    for (const dome of built) dome.dispose();
  });

  it("paints the disc where the moonlight comes from, all night long", () => {
    for (const dome of built) {
      let worst = 0;
      let worstAt = 0;
      for (let t = CLOCK_START; t <= CLOCK_END; t += CLOCK_STEP) {
        dome.setTimeOfDay(t);
        if (dome.nightAmount() < KEY_IS_THE_MOON) continue;
        const disc = dome.uniforms.uMoonDirection.value as THREE.Vector3;
        const apart = Math.acos(Math.min(1, Math.max(-1, disc.dot(dome.sunDirection())))) * DEGREES;
        if (apart > worst) {
          worst = apart;
          worstAt = t;
        }
      }
      expect(
        worst,
        `${dome.mesh.name}: moon disc ${worst.toFixed(1)} deg from the key light at clock ${worstAt.toFixed(3)}`,
      ).toBeLessThan(MOON_TOLERANCE_DEG);
    }
  });

  it("keeps the disc above the horizon while the moonlight is", () => {
    for (const dome of built) {
      for (let t = CLOCK_START; t <= CLOCK_END; t += CLOCK_STEP) {
        dome.setTimeOfDay(t);
        if (dome.nightAmount() < KEY_IS_THE_MOON) continue;
        if (dome.sunDirection().y <= 0) continue;
        const disc = dome.uniforms.uMoonDirection.value as THREE.Vector3;
        // A disc on the horizon with moonlight streaming down from 40 degrees
        // of sky is the same disagreement, read as elevation.
        expect(disc.y, `${dome.mesh.name}: disc under the horizon at clock ${t.toFixed(3)}`).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * The sun disc is gated on `uNight`. `scSunDisc` used to be added
 * unconditionally, and its own horizon gate could not save it: past phase 1
 * `uSunDirection` is the MOON, which sits up to 42 degrees above the horizon,
 * so `smoothstep(-0.05, 0.01, uSunDirection.y)` was 1.0 all night and the
 * shader painted a `760 * min(sunE, 80)` core — about 6.1e4 radiance, roughly
 * 38000x the moon disc's 1.6 — inside the moon's own disc, which is the larger
 * of the two. The night sky rendered a blown-out white dot with a thin ring.
 */
describe("sky sun disc", () => {
  const built = GAME.maps.map(mountDome);

  afterAll(() => {
    for (const dome of built) dome.dispose();
  });

  it("fades the sun disc out as the dome's own night weight rises", () => {
    // Read the gate off the shader rather than restating it, so renaming the
    // uniform or dropping the term fails here instead of silently passing.
    const source = GLSL_SKY_SCATTERING;
    const disc = source.slice(source.indexOf("vec3 scSunDisc"), source.indexOf("vec3 scSunDisc") + 1200);
    expect(disc, "scSunDisc not found in GLSL_SKY_SCATTERING").toContain("1.0 - uNight");

    for (const dome of built) {
      let dayWorst = 1;
      let dayAt = 0;
      let nightWorst = 1;
      let nightAt = 0;
      for (let t = CLOCK_START; t <= CLOCK_END; t += CLOCK_STEP) {
        dome.setTimeOfDay(t);
        const night = dome.nightAmount();
        // Exactly what the shader evaluates on that line.
        const gate = 1 - night;
        if (night <= 0.001) {
          if (gate < dayWorst) {
            dayWorst = gate;
            dayAt = t;
          }
        } else if (night >= 0.99 && gate < nightWorst) {
          nightWorst = gate;
          nightAt = t;
        }
      }
      // With the sun up the disc must be untouched: the setting sun is a
      // shipped thing and the gate may not dim it.
      expect(
 dayWorst,
  `${dome.mesh.name}: sun disc dimmed to ${dayWorst} while the sun was up (clock ${dayAt.toFixed(3)})`,
      ).toBe(1);
      // Once it is fully night the key light is the moon, so the sun disc
      // must be gone rather than merely dimmed.
      expect(
        nightWorst,
        `${dome.mesh.name}: sun disc still lit ${nightWorst} at full night (clock ${nightAt.toFixed(3)})`,
      ).toBeLessThan(0.01);
    }
  });

  it("never leaves the sun disc lit while the moon is the light", () => {
    for (const dome of built) {
      for (let t = CLOCK_START; t <= CLOCK_END; t += CLOCK_STEP) {
        dome.setTimeOfDay(t);
        const night = dome.nightAmount();
        if (night < KEY_IS_THE_MOON) continue;
        // The blowout was a sun disc painted onto the moon's disc. With the
        // gate the two can no longer overlap: moon lit, sun disc dark.
        expect(1 - night, `${dome.mesh.name}: sun disc lit at full night, clock ${t.toFixed(3)}`).toBeLessThan(0.01);
      }
    }
  });
});
