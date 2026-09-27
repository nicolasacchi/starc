# Regenerating the terrain conformance table after a deliberate data change

`shared/data/maps.json` carries a per-map `elevation` scalar.
`shared/TERRAIN.md` specifies `height = fbm(...) * elevation * MAX_RELIEF(6.0)`,
so changing a map's `elevation` scales every height on that map while leaving
the **algorithm** untouched.

`server/spec/terrain_conformance_spec.rb` pins a 200-point table of hard-coded
heights. It exists to catch two things:

1. a change to the algorithm (lattice hash, value noise, fBm, bilinear fetch);
2. a change to the algorithm in *one* language only, so the Ruby and TypeScript
   height fields diverge.

It is **not** meant to pin a particular map's elevation — that is data, and data
is meant to change. So when a map's `elevation` or `time_of_day` changes
deliberately, the pinned table is stale by design and must be re-captured.

## Procedure

1. Change the value in `shared/data/maps.json`.
2. `bun run data:build` — rebuilds `shared/game-data.json`, which both sides read.
3. Re-capture the table from the **Ruby** side, which owns the authoritative
   surface:
   ```bash
   bin/rails runner '
     t = Starc::Sim::Terrain.for("altaior")
     rng = Random.new(20_260_927)
     200.times {
       x = rng.rand(0.0..256.0); z = rng.rand(0.0..256.0)
       puts "    [#{x}, #{z}, #{t.height_at(x, z)}]"
     }'
   ```
   Paste into `POINT_SAMPLES`. Refresh `ANCHOR_SAMPLES`, `SLOPE_HEIGHTS` and
   `OTHER_MAP_CENTRE` from the same run.
4. Mirror the same numbers into
   `client/src/render/terrain/heightfield.test.ts`.
5. `cd server && bundle exec rspec spec/terrain_conformance_spec.rb` and
   `cd client && bunx vitest run src/render/terrain/heightfield.test.ts`.

## The check that matters

Do not trust that both files were edited. Confirm the two implementations still
agree independently:

```bash
# Ruby, at the conformance points
bin/rails runner 't = Starc::Sim::Terrain.for("altaior");
  puts JSON.generate([[128,128],[20,20],[20.5,20],[21,20]].map { |x,z| t.height_at(x,z) })' > /tmp/rb.json

# TypeScript, same points
cd client && bun -e '
  import { HeightField } from "./src/render/terrain/heightfield.ts";
  const m = JSON.parse(require("fs").readFileSync("../shared/data/maps.json","utf8")).maps[0];
  const f = new HeightField(m);
  console.log(JSON.stringify([[128,128],[20,20],[20.5,20],[21,20]].map(([x,z]) => f.sample(x,z))));'
```

They must be **bit-identical** (`0.0` difference). `Math.imul` in the TS lattice
and `& 0xFFFFFFFF` in the Ruby one are the same 32-bit operation; a difference
means someone has reintroduced a float multiply, which is the documented trap in
`shared/TERRAIN.md`.

## What must never be regenerated blindly

If you are pasting whatever the code prints *because a test failed for an
unrelated reason*, stop. The table is only meaningful if you know the change was
a data change. A failure after an *algorithm* edit means the edit was wrong.
