# STARC

A real-time strategy game in the StarCraft tradition: **three races, 57 units
and structures, four maps, and authoritative multiplayer**.

Rendered in **three.js / WebGL2** with a full custom graphics stack — geometry,
textures, sky, water and effects are all generated in code, so the repository
carries no art assets at all. The backend is **Rails 8 + SQLite + ActionCable**,
running a fixed-step authoritative simulation at 20 Hz.

```
┌─────────────────────────┐         ┌──────────────────────────────┐
│  client/  three.js      │   WS    │  server/  Rails 8            │
│  Vite · TypeScript      │◀───────▶│  ActionCable (native JSON)   │
│  WebGL2 custom renderer │  JSON   │  Starc::Sim::World @ 20 Hz   │
└─────────────────────────┘  REST   │  SQLite · Replays · Ratings  │
              ▲                       └──────────────────────────────┘
              └────────── shared/game-data.json ──────────┘
```

The roster and maps live in one JSON file that both sides load. There are no
hard-coded stats anywhere in the codebase.

---

## Why these technologies

**Rails + SQLite, not Erlang, not Redis.** The interesting decision is the
database, so it is worth being explicit:

- **SQLite is the right store, not a compromise.** The workload is a bounded,
  fully transactional dataset — a match, its players, a replay, aggregate
  ratings. It is read-mostly and write-batched, which is exactly SQLite's
  shape. The hot path (20 Hz snapshots) never touches it: it lives in memory
  inside the match loop and is flushed once, at match end, as a replay row.
- **The single-writer model is a feature here.** The authoritative simulation
  for a match is a *sequential* state machine — one thread, one tick at a
  time. That is the workload Redis is worst at and SQLite is indifferent to.
  Redis would add a network hop, an operational dependency, and a persistence
  story we would then have to build anyway.
- **Erlang/OTP is a genuinely strong alternative — for a different
  architecture.** A process-per-match supervision tree with hot code reload is
  a better fit than threads for running hundreds of concurrent matches. We did
  not choose it because the simulation is deliberately isolated in a plain
  Ruby module (`Starc::Sim::World`) with no Rails coupling and no I/O, which
  makes the port contained: an OTP `GenServer` wrapping the same `World`, a
  WebSocket endpoint, and SQLite persistence are all it takes. The transport is
  chosen at the channel boundary for exactly this reason.
- **Scaling is a config flip, not a rewrite.** `config/cable.yml` ships `async`
  for dev and `redis` for production, so horizontal fan-out is one env var. No
  game code changes.

**Authoritative server, not lockstep.** Clients send commands and render
snapshots; they never compute damage, deaths or economy. A 50 ms prediction
window on the issuing client's own units keeps orders feeling instant, and
reconciliation snaps anything the server disagrees with. This is what modern
RTS netcode does, and it is why a dropped packet cannot desync a match.

---

## Quick start

Requires Ruby 3.4+, Node 20+/Bun, and SQLite 3.

```bash
# 1. Shared game data (validates the roster and rebuilds shared/game-data.json)
bun install
bun run data:build

# 2. Backend
cd server
bundle install
bin/rails db:prepare
bin/rails db:seed          # 5 accounts, password "starcraft"
bin/rails server -p 3000

# 3. Client, in another shell
cd client
bun install
bun run dev                # http://127.0.0.1:5173
```

Open two browser windows, log in as two different seeded accounts, create a
match in one, join from the other, and start.

---

## Layout

```
shared/          the contract both sides load
  game-data.json   3 races · 57 entities · 4 maps (generated)
  schema.json      JSON Schema every race file validates against
  data/            race-terran|zerg|protoss.json, maps.json
  TERRAIN.md       the height-field algorithm, specified exactly

docs/PROTOCOL.md the wire protocol: every message, in full

server/
  app/lib/starc/
    game_data.rb    memoized roster loader
    maps.rb         map catalog
    match_runner.rb live match loop (fixed 50 ms step, drift-corrected)
    lobby_registry  ActionCable fan-out cache
    sim/            the simulation — no Rails coupling, no I/O
      world.rb        fixed step order documented at the top
      entity.rb  rng.rb  terrain.rb  spatial_index.rb  projectile.rb
      systems/commands.rb  buff_registry.rb
  app/channels/     ApplicationCable::Connection, GameChannel, LobbyChannel
  app/models/       Player, Session, Match, MatchPlayer, Replay, LeaderboardEntry
  app/controllers/api/v1/
  spec/             RSpec: models, requests, channels, simulation, e2e

client/src/
  shared/          protocol types + typed roster accessors
  net/             cable transport, snapshot buffer, interpolation, prediction
  render/
    core/            renderer, post FX, RTS camera, quality presets
    terrain/         height field (mirrors the Ruby one exactly) + clipmap mesh
    sky/  water/     analytic sky scattering, depth-absorbing water
    geometry/        procedural unit and building meshes
    materials/       procedural textures, PBR library, race palettes
    lighting/        day-night rig, cascaded shadow maps, procedural IBL
    vfx/             GPU particles, explosions, projectiles, beams, decals
    entities/        entity views, animation, LOD, the SceneManager
    hud3d/           health bars, selection rings, minimap, floating text
  game/            input, selection, control groups, hotkeys, app state machine
  ui/              main menu, lobby, HUD, build menu, result screen
```

---

## The roster

| Race | Units | Structures |
|---|---|---|
| **Terran** | SCV, Marine, Firebat, Siege Tank, Thor, Reaper, Ghost, Battlecruiser, Raven, Medic | Command Center, Supply Depot, Refinery, Barracks, Engineering Bay, Factory, Starport, Bunker, Turret |
| **Zerg** | Drone, Zergling, Hydralisk, Ultralisk, Queen, Roach, Lurker, Infestor, Corruptor, Guardian | Hatchery, Overlord, Extractor, Spawning Pool, Hydralisk Den, Roach Warren, Spire, Lair, Spine Crawler |
| **Protoss** | Probe, Zealot, Stalker, Sentry, High Templar, Dark Templar, Adept, Archon, Carrier, Phoenix | Nexus, Pylon, Assimilator, Gateway, Forge, Photon Cannon, Cybernetics Core, Twilight Council, Robotics Facility |

Maps: **Altaior** (open, 8 players), **Chokepoint** (four gates, 4 players),
**Cataclysm** (lava rivers, 4 players), **Shattered Isle** (islands, 6
players).

Changing a stat is a one-line edit to `shared/data/race-*.json` followed by
`bun run data:build`. The validator enforces referential integrity, unique
hotkeys, supply ranges and weapon sanity on both sides.

---

## Graphics

No model, texture, or HDR file is downloaded or committed. Everything is
generated at runtime:

- **Terrain** — value-noise fBm height field (identical to the server's, so
  units never float), a geometry clipmap with vertex-shader displacement, and
  a four-layer splat driven by height, slope and noise, with a shoreline
  wetness band.
- **Sky** — analytic Rayleigh/Mie single scattering with a limb-darkened sun
  disc, a real star field at night, and domain-warped cloud layers.
- **Water** — Fresnel reflection, depth-based absorption, animated normals,
  sun glint and a terrain-derived foam shoreline.
- **Units** — every unit and building is a distinct procedural mesh with a
  silhouette designed to read instantly at RTS zoom.
- **Light** — a day-night rig with a colour-temperature ramp, cascaded shadow
  maps with texel snapping, and image-based lighting from a procedurally
  rendered environment probe.
- **Effects** — GPU-advanced particles, layered explosions with shockwaves,
  instanced projectiles, energy beams, and terrain-conforming decals.
- **Post** — SSAO, bloom, god rays, chromatic aberration, vignette, grain and
  sharpening in a single composite pass, plus SMAA.

Four quality presets from `low` to `ultra` scale every effect; the preset is
auto-detected from the GPU and can be forced in the menu.

---

## Testing

```bash
bun run data:build                            # validates the roster, rebuilds game-data.json
cd server && bundle exec rspec                # 885 examples: models, requests, channels, simulation
cd server && bundle exec rspec spec/e2e       # 3 examples: two real WebSocket clients play a full match
cd client && bun run test:run                 # netcode, prediction, input, rendering
cd client && bun run typecheck                # strict tsc
cd client && bun run build                    # production bundle
```

The suite is order-independent — verified at seeds 1, 2, 7, 42 and 99 — and
`spec/e2e` is opt-in (`STARC_E2E=1` or by naming the path) because it boots a
real Puma on a real port.

The simulation is deterministic, which is what makes replays real. That is
asserted, not assumed: the same seed and command stream produce byte-identical
snapshots across separate processes and `RAILS_ENV` values; one batch of three
commands and three batches of one agree; both players' commands applied in
swapped order within a tick agree; and the `mulberry32` stream matches a
canonical reference bit-exactly. The Ruby and TypeScript terrain
implementations agree to `1e-9` — in practice bit-exactly — and a spec pins the
table from both sides.

The e2e suite is deliberately unmocked. A start position on the world edge, a
snapshot cadence that is not 10 Hz, a rejection indexed against the wrong
command, and a `replay_url` that 404s are exactly the defects a mocked channel
cannot see.

### What the tests did not catch, and the browser did

Every defect below passed a fully green suite. They were found by driving the
running application: logging in, creating a match, joining from a second
account, and looking at the screen.

- The **entire app shell had no CSS** — the shell emitted `starc-*` class names
  and the stylesheet was written against a different vocabulary, so the game
  screen rendered invisible.
- The **3D world was never drawn**: `SceneManager.applySnapshot`, the only
  method that creates entity views, had no caller anywhere. Terrain, sky and
  the HUD all rendered; the world did not.
- The **post-FX chain showed a radial smear instead of the world** on three of
  four quality presets, and two further defects made the fourth draw black.
- A **match started over REST never simulated** — the runner was only adopted
  from the channel paths.
- A **shared cable's second consumer never subscribed**, so entering a match
  waited forever for a `game:start` on a channel it had never joined.
- **Any account could end any live match** in 60 seconds with a fabricated
  result, and **closing a second tab forfeited a match the player was still
  playing**.

The general lesson, recorded in `CLAUDE.md`: a test that exercises a helper in
isolation proves nothing about whether production calls it. Three separate
dead-but-fully-tested paths turned up in this codebase before an explicit sweep
found seventeen more.

---

## Licence

MIT — see [LICENSE](LICENSE).

StarCraft is a trademark of Blizzard Entertainment. STARC is an independent
homage; it contains no Blizzard assets, code, or audio.
