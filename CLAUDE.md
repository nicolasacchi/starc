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

**Axes: the ground plane is `x`/`z`, height is `y`.** Three.js Y-up, and
`shared/TERRAIN.md`, `HeightField.sample(x, z)` and `screenToGround` all
assume it. A snapshot entity carries `x`, `z` and `y` (the server's
authoritative height), orders carry `x`, `z` (patrol also `x2`, `z2`), and
the order target is `ox`/`oz`. An earlier protocol said the ground plane was
`x`/`y`; the sim followed the document and the renderer did not, so every
entity was placed transposed. If you see `y` used as a ground coordinate, it
is a bug.

**The cable speaks ActionCable's native JSON protocol, not STOMP.**
ActionCable 8.1 has no STOMP support at all — a STOMP `CONNECT` is silently
ignored. Each WebSocket frame is one JSON document: client sends
`{"command":"subscribe"|"message"|"unsubscribe", "identifier": "<JSON-encoded
channel params>", "data": "<JSON string>"}`; the server replies with
`welcome`, `confirm_subscription`, `ping`, `disconnect` or a payload frame
routed by `identifier`. Two ordering rules are load-bearing and both are
asserted: nothing may be written before `welcome`, and a `message` waits for
its subscription's `confirm_subscription`. `docs/PROTOCOL.md` §1 has the
framing.

**`docs/PROTOCOL.md` is the source of truth;** `client/src/shared/protocol.ts`
mirrors it. Change the document, then both sides.

**A spec that pins a method nothing calls is the most expensive kind of
test.** This codebase accumulated three dead-but-fully-tested paths that way
(`SceneManager.applySnapshot`, `World#snapshot_for`, `GameConnection.sampleWorld`)
plus seventeen methods with no references at all. Every one removed was a
*third spelling* of a rule already enforced inline, and two had drifted far
enough to encode a rule the code does not actually enforce. So: a test proves
the thing is reachable only if something production calls it. When you find
code with specs but no caller, treat the spec's claim as a hypothesis to check
against the enforced behaviour — it is more often wrong than the code.

**Test the wiring, not the helper.** Every serious defect in this project
passed a fully green suite: an unstyled app shell, a 3D world that was never
drawn, a post-FX chain that replaced the scene with a smear, a match that
never simulated, and a shared cable whose second consumer never subscribed.
`spec/e2e` exists because a mocked channel cannot see those. When you add a
test, ask what it would still pass if the production call were deleted.

## Layout rules

`client/src` is partitioned into strictly disjoint slices, each owned by one
worker:

```
shared/   protocol types, roster accessors
net/      cable transport, snapshots, interpolation, prediction
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

**Check a review claim against the code before you act on it.** A wave of eight
fresh read-only lenses reported five real defects and three false ones — the
build panel called inert was fully wired, and a `hold` order called permanent
was correct StarCraft semantics. Two of the three refutations were headline
claims, and following either would have replaced working code with a guess.
Static reading is good at finding a wrong value and bad at concluding a path is
unreachable; the build panel's `click` handler is four hops away and perfectly
intact. Read the whole chain before calling something dead.

**When a test cannot fail without your change, say so.** A regression guard
that passes before and after is legitimate — label it a guard, not evidence.
Do not present it as a reproduction.
