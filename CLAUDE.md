# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

STARC is a real-time strategy game. Three.js/WebGL2 client, Rails 8 +
SQLite + ActionCable server, one shared JSON roster that both load.

## The three rules that matter

1. **Never hard-code a unit stat.** Read `shared/game-data.json` through
   `Starc::GameData` (Ruby) or `@shared/gameData` (TypeScript). If a number
   about a marine exists in code outside the data, that is a bug.
2. **The server is authoritative.** Clients never compute damage, deaths or
   economy. Prediction is limited to the issuing client's own unit movement,
   and reconciliation snaps to the server's answer.
3. **No external assets.** No model, texture, HDR, or font file. Geometry and
   textures are generated in code at runtime. If a PR adds a binary asset, it
   is wrong.

## Before you change anything

```bash
bun run data:build            # validates the roster; run after ANY shared/data edit
cd server && bundle exec rspec
cd client && bun run typecheck && bun run test:run
```

`data:build` also fails CI if `shared/game-data.json` is stale, so never edit
that generated file by hand.

## Architecture you need to know

**The simulation is a plain Ruby module with no Rails coupling and no I/O.**
`server/app/lib/starc/sim/world.rb` documents its fixed step order in a
comment at the top. The order is part of the contract: changing it changes
replay determinism. It is deterministic by construction — same seed plus same
command list produces byte-identical snapshots, and specs assert this.

**The terrain algorithm is specified, not implemented.** `shared/TERRAIN.md`
defines the lattice hash, value noise, fBm and border falloff exactly. The
Ruby (`sim/terrain.rb`) and TypeScript (`render/terrain/heightfield.ts`)
implementations of that document are the same function, and specs assert they
agree to `1e-9`. If you change one, change the document first.

**The wire protocol is specified in `docs/PROTOCOL.md`.** Message shapes,
error codes and command rejection codes are all fixed there and mirrored in
`client/src/shared/protocol.ts`. Change the document, then both sides.

**Entity Z in a snapshot is authoritative.** Clients must not recompute
terrain height to place a unit. The heightfield is for effects that need the
ground — decals, contact shadows, VFX grounding.

## Layout rules

`client/src` is partitioned into strictly disjoint slices, each owned by one
worker:

```
shared/   protocol types, roster accessors
net/      STOMP transport, snapshots, interpolation, prediction
render/   core, terrain, sky, water, geometry, materials, lighting, vfx, entities, hud3d
game/     input, selection, hotkeys, app state machine
ui/       screens and HUD (DOM)
```

Nothing in `render/` may import from `ui/` or `game/`, and nothing in `ui/`
may import from `render/`. The only cross-boundary interfaces are the ones
declared in each module's exported signatures — read the file's header comment
before assuming a shape.

## Rails specifics

- `Match#status` is an enum — use `m.lobby?`, never `m.status.to_s == "lobby"`.
- `Match#player_count` uses `.count`, not `.size`. `.size` reads the cached
  association and goes stale when a player leaves.
- Do not add a `valid?` override to an ActiveRecord model. It shadows
  `ActiveRecord::Model#valid?(context)` and breaks `save`. Use `active?`.
- Auth tokens live in the `sessions` table and nowhere else. There is no
  denormalised copy on `players`.

## Testing expectations

A test must be able to fail for a plausible consumer-visible reason. Do not
write tests that assert wiring, that a copy happened, that a method was
called, or that a value merely "grew". Headless is the default: Vitest runs
with `environment: "node"`, so anything that touches `document` must do it in
an explicit `mount()`, never a constructor.
