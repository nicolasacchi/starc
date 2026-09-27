# Engineering guide

Reference material for extending STARC. Kept deliberately short — the
contracts that matter live in `shared/`, `docs/PROTOCOL.md` and `CLAUDE.md`.

## Adding a unit or building

1. Add the entry to `shared/data/race-<race>.json` following the existing
   shape. `shared/schema.json` is the authority — it sets
   `additionalProperties: false`, so an unexpected key is a validation error,
   not a warning.
2. Give it a unique `key` and a unique single-letter `hotkey` within the race.
3. List every `produces`, `required_buildings` and ability `spawn` target. All
   three must resolve to another key in the same file; the validator enforces
   this.
4. `bun run data:build`. It validates the schema, then the cross-file
   invariants: supply in 1..3 for units, melee and claw weapons at
   `projectile_speed` 0, everything else 20..100, exactly one harvesting unit
   per race, unique hotkeys, unique keys, and non-empty `hp`/`size`.
5. Nothing else. The server simulation, the renderer, the geometry factory and
   the UI all read the roster — none of them enumerate unit types.

If you add an ability `effect` value, you must also handle it in
`server/app/lib/starc/sim/systems/` and, if it has a visual, in
`client/src/render/vfx/`. The enum is closed on both sides.

## Adding a map

Add an entry to `shared/data/maps.json`: id, name, size, `max_players`,
`terrain_seed`, biome, water flag, elevation, start positions, mineral
clusters, expansion candidates and a `lighting` block. The terrain height
field is generated from `terrain_seed` alone, so a new map is a different
number — no new code.

Balance note: the map must supply at least one mineral cluster within
harvesting distance of every `start_positions` entry, or that player cannot
open economically. The start positions also need to be spread far enough apart
that two players' bases do not overlap.

## The tick loop

`Starc::Sim::World#step!` advances exactly 50 ms. The step order is fixed and
documented in a comment at the top of `world.rb`:

1. command application 2. building construction 3. production queues
4. harvesting/economy 5. ability effects 6. target acquisition 7. movement
8. weapon fire + projectiles 9. damage + deaths 10. supply/resources
11. victory check 12. event drain

Reordering these changes replay determinism, which is a contract with the
replay format and with clients. If you believe the order is wrong, change it
deliberately and update `docs/PROTOCOL.md` §6 and the determinism spec.

The loop broadcasts at 10 Hz — every second tick — and carries the full entity
table rather than deltas. At the entity counts this game produces that is
smaller than a delta plus per-client bookkeeping, and it makes late joiners
and reconnects free.

## Netcode rules

- `from_tick` in a command batch is the last snapshot tick the client had seen.
  The server rebases onto its own tick. Never trust it beyond a sanity window.
- Cap: 256 commands per batch, 256 ids per command. Enforced in the channel,
  not in the simulation.
- Every command is validated independently. Valid ones apply in array order;
  invalid ones are dropped individually and reported by index in
  `game:reject`. A single bad command never fails a batch.
- Prediction is movement-only, for the issuing player's own units. Do not
  port combat or economy to the client.

## Performance budget

| Thing | Budget |
|---|---|
| Simulation tick | 50 ms wall clock, 256 entities per side |
| Snapshot | every 100 ms, full entity table |
| On-screen units | 300+ at 60 fps, distance LOD, instanced where possible |
| Terrain | ~200k triangles via clipmap, vertex-shader displacement |
| Particles | advanced on the GPU; CPU cost must not scale with count |

The rule that matters: nothing in a per-frame path may allocate. If you are
building a vector, a closure, or an array inside `update()` or `render()`, hoist
it.

## Adding a graphics feature

Procedural assets mean a new texture is a function, not a file. Put it in
`client/src/render/materials/proceduralTextures.ts` (or the relevant module),
seed it deterministically, cache it by parameter key, and set the colour space
correctly: albedo `SRGBColorSpace`, normal/roughness `NoColorSpace`.

Every expensive effect must respect `QualitySettings`. The `low` preset has to
stay playable on integrated graphics — if a feature cannot be switched off,
it does not belong in the render loop.

Everything you allocate gets a `dispose()`.
