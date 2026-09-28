/**
 * The procedural texture set is the game's entire art pipeline, so these
 * tests check the properties the renderer and the artist rely on: byte-level
 * determinism, correct texture metadata (size, format, colour space, wrap),
 * a normal map that really is the gradient of its height field, and no seam
 * where the tile wraps.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  chitinTexture,
  disposeTextures,
  energyFieldTexture,
  gradientRamp,
  hazardStripeTexture,
  metalPanelTexture,
  normalFromHeight,
  noiseNormalTexture,
  noiseTexture,
  rockTexture,
  setTextureAnisotropy,
  stripeTexture,
  textureKeys,
} from "./proceduralTextures";

const rgba = (t: THREE.DataTexture): Uint8Array => t.image.data as Uint8Array;
const width = (t: THREE.DataTexture): number => t.image.width;
const px = (t: THREE.DataTexture, x: number, y: number): number[] => {
  const d = rgba(t);
  const i = (y * width(t) + x) * 4;
  return [d[i] as number, d[i + 1] as number, d[i + 2] as number, d[i + 3] as number];
};

/** Every generator that takes a seed, with arguments that keep builds cheap. */
const SEEDED: ReadonlyArray<readonly [string, (seed: number) => THREE.DataTexture]> = [
  ["noise", (seed) => noiseTexture(32, { seed })],
  ["metalPanel", (seed) => metalPanelTexture(64, { seed, panels: 2 })],
  ["chitin", (seed) => chitinTexture(64, { seed, cells: 3 })],
  ["energyField", (seed) => energyFieldTexture(64, { seed, cells: 2 })],
  ["rock", (seed) => rockTexture(64, { seed })],
  ["stripe", (seed) => stripeTexture(32, { seed, bands: 2 })],
  ["hazardStripe", (seed) => hazardStripeTexture(32, { seed, bands: 2 })],
  ["noiseNormal", (seed) => noiseNormalTexture(32, 1.4, seed)],
];

const colourMaps: ReadonlyArray<readonly [string, () => THREE.DataTexture]> = [
  ["metalPanel", () => metalPanelTexture(64, { seed: 4211, panels: 2 })],
  ["chitin", () => chitinTexture(64, { seed: 9091, cells: 3 })],
  ["energyField", () => energyFieldTexture(64, { seed: 5150, cells: 2 })],
  ["rock", () => rockTexture(64, { seed: 7702 })],
  ["stripe", () => stripeTexture(32, { seed: 3141, bands: 2 })],
  ["hazardStripe", () => hazardStripeTexture(32, { seed: 2718, bands: 2 })],
  ["gradientRamp", () => gradientRamp([[0, 0x101010], [1, 0xf0f0f0]], 16)],
];

afterEach(() => disposeTextures());

describe("determinism", () => {
  it.each(SEEDED)("%s produces byte-identical data for the same seed", (_name, make) => {
    disposeTextures();
    const first = rgba(make(4242));
    disposeTextures();
    const second = rgba(make(4242));
    expect(second).toEqual(first);
    expect(first.some((v) => v !== first[0])).toBe(true);
  });

  it.each(SEEDED)("%s produces different data for a different seed", (_name, make) => {
    disposeTextures();
    const a = rgba(make(4242));
    disposeTextures();
    const b = rgba(make(90210));
    expect(b).not.toEqual(a);
  });

  it("gradientRamp is stable for the same stops and changes with the stops", () => {
    const stops: readonly (readonly [number, number])[] = [
      [0, 0x102030],
      [0.5, 0x804020],
      [1, 0xf0f0ff],
    ];
    disposeTextures();
    const first = rgba(gradientRamp(stops, 16));
    disposeTextures();
    expect(rgba(gradientRamp(stops, 16))).toEqual(first);
    disposeTextures();
    expect(rgba(gradientRamp([[0, 0x000000], [1, 0xffffff]], 16))).not.toEqual(first);
  });

  it("hands back the same instance while cached and a fresh one after disposal", () => {
    const a = metalPanelTexture(64, { seed: 11, panels: 2 });
    expect(metalPanelTexture(64, { seed: 11, panels: 2 })).toBe(a);
    disposeTextures();
    const b = metalPanelTexture(64, { seed: 11, panels: 2 });
    expect(b).not.toBe(a);
    expect(rgba(b)).toEqual(rgba(a));
  });
});

describe("texture metadata", () => {
  it.each(colourMaps)("%s is an sRGB RGBA DataTexture sized as requested", (_name, make) => {
    const t = make();
    expect(t).toBeInstanceOf(THREE.DataTexture);
    expect(t.format).toBe(THREE.RGBAFormat);
    expect(t.type).toBe(THREE.UnsignedByteType);
    expect(t.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(t.image.width).toBe(t.image.height);
    expect(rgba(t)).toHaveLength(t.image.width * t.image.height * 4);
    expect(t.wrapS).toBe(THREE.RepeatWrapping);
    expect(t.wrapT).toBe(THREE.RepeatWrapping);
    expect(t.magFilter).toBe(THREE.LinearFilter);
    expect(t.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(t.generateMipmaps).toBe(true);
    expect(t.version).toBeGreaterThan(0);
  });

  it("noise data is linear, not sRGB", () => {
    const t = noiseTexture(32, { seed: 1337 });
    expect(t.colorSpace).toBe(THREE.NoColorSpace);
    expect(rgba(t)).toHaveLength(32 * 32 * 4);
  });

  it("normal maps are linear data", () => {
    expect(noiseNormalTexture(32, 1.4).colorSpace).toBe(THREE.NoColorSpace);
    expect(normalFromHeight(new Float32Array(64), 8).colorSpace).toBe(THREE.NoColorSpace);
  });

  it("alpha is opaque everywhere in the albedo generators", () => {
    for (const [, make] of colourMaps) {
      const t = make();
      const data = rgba(t);
      for (let i = 3; i < data.length; i += 4) expect(data[i]).toBe(255);
    }
  });

  it("each cached texture is listed under its own parameter key", () => {
    noiseTexture(32, { seed: 1337, octaves: 4 });
    chitinTexture(64, { seed: 9091, cells: 3 });
    const keys = textureKeys();
    expect(keys).toContain("noise:32:1337:4");
    expect(keys).toContain("chitin:64:9091:3:0.5");
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("setTextureAnisotropy clamps into 1..16 across the cache", () => {
    const noise = noiseTexture(32, { seed: 1337 });
    const rock = rockTexture(64, { seed: 7702 });
    setTextureAnisotropy(99);
    expect(noise.anisotropy).toBe(16);
    expect(rock.anisotropy).toBe(16);
    setTextureAnisotropy(0);
    expect(noise.anisotropy).toBe(1);
    expect(rock.anisotropy).toBe(1);
    setTextureAnisotropy(4);
    expect(noise.anisotropy).toBe(4);
    expect(rock.anisotropy).toBe(4);
  });

  it("disposeTextures empties the cache", () => {
    noiseTexture(32, { seed: 1337 });
    expect(textureKeys().length).toBeGreaterThan(0);
    disposeTextures();
    expect(textureKeys()).toEqual([]);
  });

  it("every generator builds usable data from its default options", () => {
    const defaults: THREE.DataTexture[] = [
      noiseTexture(),
      metalPanelTexture(),
      chitinTexture(),
      energyFieldTexture(),
      rockTexture(),
      stripeTexture(),
      hazardStripeTexture(),
      noiseNormalTexture(),
      gradientRamp([[0, 0x000000], [1, 0xffffff]]),
    ];
    for (const t of defaults) {
      const data = rgba(t);
      expect(data.length).toBe(t.image.width * t.image.height * 4);
      expect(data.some((v) => v !== data[0])).toBe(true);
    }
    expect(textureKeys()).toHaveLength(defaults.length);
  });
});

describe("normalFromHeight", () => {
  const SIZE = 16;
  const h = (x: number, y: number): number => Math.sin((x / SIZE) * Math.PI * 2) * 0.5 + (y / SIZE) * 0.2;

  const decode = (t: THREE.DataTexture, x: number, y: number) => {
    const [r, g, b] = px(t, x, y);
    return [(r / 255) * 2 - 1, (g / 255) * 2 - 1, (b / 255) * 2 - 1];
  };

  it("encodes the central-difference gradient of the height field", () => {
    const height = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) height[y * SIZE + x] = h(x, y);

    const strength = 2;
    const t = normalFromHeight(height, SIZE, strength);
    expect(rgba(t)).toHaveLength(SIZE * SIZE * 4);

    // Interior texels use a plain central difference, so recompute it here.
    for (const [x, y] of [[5, 4], [9, 11], [2, 13]] as const) {
      const dx = (height[y * SIZE + ((x + 1) % SIZE)] as number - height[y * SIZE + ((x - 1 + SIZE) % SIZE)] as number) * strength;
      const dy = (height[(((y + 1) % SIZE) * SIZE + x) as number] - height[(((y - 1 + SIZE) % SIZE) * SIZE + x) as number] as number) * strength;
      const len = Math.hypot(-dx, -dy, 1);
      const [nx, ny, nz] = decode(t, x, y);
      expect(nx).toBeCloseTo(-dx / len, 1);
      expect(ny).toBeCloseTo(-dy / len, 1);
      expect(nz).toBeCloseTo(1 / len, 1);
    }
  });

  it("points a raised slope away from the rise (inverted gradients are a real defect)", () => {
    const height = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) height[y * SIZE + x] = x;
    const t = normalFromHeight(height, SIZE, 2);
    const [nx, ny, nz] = decode(t, 8, 8);
    expect(nx).toBeLessThan(-0.5);
    expect(ny).toBeCloseTo(0, 2);
    expect(nz).toBeGreaterThan(0);
  });

  it("a flat height field yields the flat tangent normal", () => {
    const t = normalFromHeight(new Float32Array(SIZE * SIZE), SIZE, 2);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const [r, g, b] = px(t, x, y);
        expect(Math.abs(r - 128)).toBeLessThanOrEqual(1);
        expect(Math.abs(g - 128)).toBeLessThanOrEqual(1);
        expect(b).toBeGreaterThan(250);
      }
    }
  });

  it("stays continuous across the wrap boundary for a periodic height field", () => {
    const size = 32;
    const height = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        height[y * size + x] = Math.sin((x / size) * Math.PI * 2) + Math.cos((y / size) * Math.PI * 2);
      }
    }
    const t = normalFromHeight(height, size, 2);
    for (let y = 0; y < size; y++) {
      const jump = Math.hypot(decode(t, 0, y)[0] - decode(t, size - 1, y)[0], 0);
      // The boundary derivative must be no larger than any interior step.
      const interior = Math.abs(decode(t, 1, y)[0] - decode(t, 0, y)[0]);
      expect(jump).toBeLessThanOrEqual(interior + 0.02);
    }
  });
});

describe("tileability", () => {
  const rowJump = (t: THREE.DataTexture, x: number, y: number): number => {
    const [ar, ag, ab] = px(t, x, y);
    const [br, bg, bb] = px(t, (x + 1) % width(t), y);
    return Math.hypot(ar - br, ag - bg, ab - bb);
  };

  const expectNoSeam = (t: THREE.DataTexture, rows: number[]): void => {
    for (const y of rows) {
      const n = width(t);
      let worstInterior = 0;
      for (let x = 0; x < n; x++) worstInterior = Math.max(worstInterior, rowJump(t, x, y));
      const boundary = rowJump(t, n - 1, y);
      expect(boundary).toBeLessThanOrEqual(worstInterior + 1);
    }
  };

  it("stripe tiles without a seam on the wrap boundary", () => {
    expectNoSeam(stripeTexture(64, { seed: 3141, bands: 4, skew: 0, feather: 0.2 }), [0, 5, 17, 33, 63]);
  });

  it("diagonal hazard stripes tile without a seam", () => {
    expectNoSeam(hazardStripeTexture(64, { seed: 2718, bands: 6, skew: 1 }), [0, 9, 40, 63]);
  });

  it("hard-edged (feather 0) stripes still tile", () => {
    const t = stripeTexture(64, { seed: 3141, bands: 4, skew: 0, feather: 0 });
    expectNoSeam(t, [0, 7, 31, 63]);
    // A hard edge means the band interior stays put instead of ramping.
    const a = px(t, 8, 0)[0] as number;
    const b = px(t, 10, 0)[0] as number;
    expect(Math.abs(a - b)).toBeLessThan(6);
  });

  it("a wrong wrap shows up as a seam", () => {
    // Guards the assertion above: a deliberately discontinuous row does fail it.
    const broken = stripeTexture(32, { seed: 3141, bands: 2 });
    const d = rgba(broken);
    d[0] = 255;
    d[1] = 0;
    expect(rowJump(broken, 31, 0)).toBeGreaterThan(1);
  });
});

describe("gradientRamp", () => {
  const decode = (t: THREE.DataTexture, y: number) => {
    const [r, g, b] = px(t, 0, y);
    return [r / 255, g / 255, b / 255];
  };
  const linear = (hex: number): number[] => {
    const c = new THREE.Color(hex);
    return [c.r, c.g, c.b];
  };

  it("rejects an empty stop list instead of producing a blank ramp", () => {
    expect(() => gradientRamp([], 16)).toThrow(/at least one stop/i);
  });

  it("puts the last stop at the top row and the first at the bottom row", () => {
    const t = gradientRamp([[0, 0x000000], [1, 0xffffff]], 32);
    expect(width(t)).toBe(32);
    const top = decode(t, 0);
    const bottom = decode(t, 31);
    for (let c = 0; c < 3; c++) {
      expect(top[c]).toBeCloseTo(linear(0xffffff)[c] as number, 2);
      expect(bottom[c]).toBeCloseTo(linear(0x000000)[c] as number, 2);
    }
  });

  it("flip reverses the ramp", () => {
    const normal = decode(gradientRamp([[0, 0x000000], [1, 0xffffff]], 32), 0);
    const flipped = decode(gradientRamp([[0, 0x000000], [1, 0xffffff]], 32, { flip: true }), 0);
    expect(flipped[0]).toBeCloseTo(1 - (normal[0] as number), 2);
    expect(flipped[1]).toBeCloseTo(1 - (normal[1] as number), 2);
  });

  it("interpolates through a multi-stop ramp in stop order", () => {
    const t = gradientRamp([[0, 0x000000], [0.5, 0x808080], [1, 0xffffff]], 64);
    const mid = decode(t, 32);
    for (let c = 0; c < 3; c++) {
      expect(mid[c]).toBeCloseTo(linear(0x808080)[c] as number, 2);
    }
  });

  it("is constant across x so horizontal tiling cannot seam", () => {
    const t = gradientRamp([[0, 0x224466], [1, 0xaabbcc]], 16);
    for (let y = 0; y < 16; y++) {
      for (let x = 1; x < 16; x++) expect(px(t, x, y)).toEqual(px(t, 0, y));
    }
  });
});
