# STARC — Terrain (authoritative, must match byte-for-byte on both sides)

The server simulation owns unit Z. The client renders the same surface. If
they disagree by even 0.01 m, units visibly float or sink. So the height field
is a **specified algorithm**, not an implementation detail: the Ruby
(`Starc::Sim::Terrain`) and the TypeScript (`src/render/terrain/heightfield.ts`)
implementations of this document are the same function, and a test asserts
they agree.

All arithmetic is 32-bit unsigned integer modular (`mod 2^32`) where stated,
and IEEE-754 `double` elsewhere. `lerp(a,b,t) = a + (b - a) * t`.

> **Implementer warning.** In JavaScript, `h * 1274126177` overflows Float64's
> exact-integer range (4.29e9 × 1.27e9 = 5.5e18 ≫ 2^53) and silently rounds,
> which desynchronises the two implementations by ~1e-6 — enough for units to
> visibly float. Use `Math.imul(h, 1274126177)`, which returns the exact low 32
> bits, for every step of the mix. Ruby's bignum arithmetic is exact as written.

## Lattice hash

```
lattice(ix, iz, seed) -> float in [0, 1)
  h = (ix * 374761393 + iz * 668265263 + seed * 2654435761) mod 2^32
  h = (h XOR (h >>> 13)) mod 2^32
  h = (h * 1274126177)    mod 2^32
  h = (h XOR (h >>> 16)) mod 2^32
  return h / 4294967296.0
```

`ix` and `iz` are integer lattice coordinates and **may be negative**; the
multiply-then-reduce is done on the 64-bit signed value before the final
`mod 2^32`, so negative inputs wrap consistently.

## Value noise

```
valueNoise(x, z, seed) -> float in [0, 1)
  ix = floor(x); iz = floor(z)
  fx = x - ix;  fz = z - iz
  ux = fx * fx * (3 - 2 * fx)      // Hermite smoothstep
  uz = fz * fz * (3 - 2 * fz)
  a = lattice(ix,   iz,   seed)
  b = lattice(ix+1, iz,   seed)
  c = lattice(ix,   iz+1, seed)
  d = lattice(ix+1, iz+1, seed)
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uz)
```

## fBm

```
OCTAVES      = 5
BASE_FREQ    = 1/48      // lattice cells per metre
LACUNARITY   = 2.0
GAIN         = 0.5

fbm(x, z, seed):
  sum = 0.0; amp = 1.0; norm = 0.0; f = BASE_FREQ
  repeat OCTAVES times:
    sum  += amp * valueNoise(x * f, z * f, seed)
    norm += amp
    amp  *= GAIN
    f    *= LACUNARITY
  return sum / norm
```

## Height and passability

```
MAX_RELIEF = 6.0     // metres
WATER_LEVEL = 0.0    // metres

heightAt(x, z, map):
  h = fbm(x, z, map.terrain_seed)
  // Radial falloff flattens the map border so edges never clip open.
  edge = 0.0
  half = map.size / 2
  dx = max(0, abs(x - half) - (half - 16))
  dz = max(0, abs(z - half) - (half - 16))
  edge = min(1.0, sqrt(dx*dx + dz*dz) / 16.0)
  return h * map.elevation * MAX_RELIEF * (1.0 - edge)

waterLevel(map) = WATER_LEVEL
passable(x, z, map) = heightAt(x, z, map) > WATER_LEVEL
```

`heightAt` is sampled on a `(map.size + 1) × (map.size + 1)` integer lattice
and **bilinearly interpolated** between samples at metre resolution, so both
implementations get identical results without doing 48 cells of fBm per query.

```
grid[i][j] = heightAt(i, j, map)      for i, j in 0..map.size
sample(x, z) = bilinear(grid, clamp(x, 0, size), clamp(z, 0, size))
```

Ground units are placed at `sample(x, z)`. Air units fly at
`AIR_ALTITUDE = 6.0` metres, independent of the surface.

## Conformance test

`server/spec/terrain_conformance_spec.rb` and
`client/src/render/terrain/heightfield.test.ts` both assert:

1. `sample(0,0)`, `sample(size/2, size/2)`, `sample(size, size)` and 200
   pseudo-random points match between the two implementations to within `1e-9`.
   They currently agree bit-exactly (`0.0`), which is the target — a
   regression to `1e-6` means someone reintroduced float64 multiply overflow.
2. The map border (within 16 m of the edge) is flat to within `1e-6`.
3. `passable` agrees with `heightAt > WATER_LEVEL` at every test point.
