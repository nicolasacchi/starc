# STARC — Wire Protocol v1

Authoritative-server RTS netcode. JSON over ActionCable (STOMP). Server is
authoritative: clients never compute damage, deaths or resource totals.

- Transport: `wss://<host>/cable` (ActionCable, subprotocol `stomp`)
- Channel: `game:<match_id>` for gameplay, `lobby` for the match browser
- Encoding: JSON, UTF-8. All numbers are finite JSON numbers; no NaN/Infinity
  (use `null`).
- Clock: fixed simulation step `TICK_MS = 50` (20 Hz). Snapshot cadence
  `SNAPSHOT_HZ = 10` (every 2nd tick). Clients render at display rate and
  interpolate between the two most recent snapshots.

Every message has the shape:

```json
{ "v": 1, "t": "<message_type>", "id": "<uuid>", "ts": 1712345678901 }
```

`v` is the protocol version, `t` the type, `id` a client-generated uuid
(present on client→server only, used for command acknowledgement), `ts`
server epoch millis on server→client (client-supplied on client→server and
ignored).

---

## 1. Connection & identity

1. Client opens the cable and subscribes to `lobby`.
2. Client performs HTTP `POST /api/v1/session` (see §7) and receives
   `{ "token": "<opaque>", "player": {...} }`.
3. Client sends `identify` on the `game:<id>` channel with the token; the
   connection stores the authenticated player in
   `connection.current_player`.

`identify` is mandatory before any other message on a `game:` channel.
Unidentified connections may only send `identify` and are disconnected after
15 s of silence.

---

## 2. Lobby channel (`lobby`)

### Client → Server

| type | payload | notes |
|---|---|---|
| `lobby:list` | `{ filters?: { mode?, map?, only_joinable? } }` | request a browser listing |
| `lobby:create` | `{ name, mode, map_id, max_players, password?, race_preference? }` | creates + joins |
| `lobby:join` | `{ match_id, password? }` | |
| `lobby:leave` | `{ match_id }` | |
| `lobby:ready` | `{ match_id, ready }` | |
| `lobby:settings` | `{ match_id, ...settings }` | host only |
| `lobby:start` | `{ match_id }` | host only, requires all ready & ≥2 players |
| `lobby:chat` | `{ match_id, text }` | 1..280 chars, 500 ms rate limit |

### Server → Client

`lobby:state` — full lobby, broadcast to every subscriber of `lobby`:

```json
{
  "v": 1, "t": "lobby:state", "ts": 0,
  "matches": [ { "id": 1, "name": "...", "mode": "melee", "map_id": "altaior",
                 "max_players": 2, "player_count": 1, "status": "lobby",
                 "has_password": false, "host": "nick" } ],
  "you": { "match_id": 1, "player_id": 7, "slot": 0, "race": "terran",
           "ready": false, "is_host": true }
}
```

`lobby:chat` carries a match's chat. `lines` is the backlog (up to 100,
oldest first) plus any new line, so a client that just joined renders the
whole room from one message and needs no separate history request. It is sent
on the per-match stream `lobby:match:<id>`, which a connection subscribes to
only while it is in that room.

Errors use `error` with `{ code, message, fatal }`. Codes:
`unauthenticated`, `not_found`, `lobby_full`, `already_in_match`,
`wrong_password`, `not_host`, `not_ready`, `invalid_payload`,
`match_in_progress`, `rate_limited`, `server_error`.

---

## 3. Match start

`game:start` is sent to each `game:<match_id>` subscriber. Every client
reconstructs the identical opening state from `seed` + `map_id` + the roster,
so no opening world-state payload is transmitted.

```json
{
  "v": 1, "t": "game:start", "ts": 0,
  "match_id": 12, "seed": 987654321, "map_id": "altaior",
  "tick_rate": 20, "snapshot_rate": 10,
  "countdown_ms": 3000,
  "players": [
    { "player_id": 7, "slot": 0, "race": "terran", "name": "nik",
      "team": 1, "start": { "x": 32.0, "z": 32.0 } },
    { "player_id": 8, "slot": 1, "race": "zerg", "name": "zz",
      "team": 2, "start": { "x": 96.0, "z": 96.0 } }
  ]
}
```

`seed` is a 32-bit unsigned integer. Every client derives identical
per-player and per-match PRNG streams from it via
`mulberry32(seed ^ hash(player_id))` — see §6.

---

## 4. Commands (client → server)

`game:command` carries a **batch**. The client sends every command it issues
in the current frame, stamped with the *last snapshot tick it has seen*; the
server rebases them onto the current authoritative tick.

```json
{
  "v": 1, "t": "game:command", "id": "…", "ts": 0,
  "from_tick": 840,
  "commands": [
    { "c": "move",    "ids": [101, 102], "x": 40.5, "z": 12.25, "queue": false },
    { "c": "attack",  "ids": [101], "target_id": 550, "queue": true },
    { "c": "stop",    "ids": [101] },
    { "c": "hold",    "ids": [102] },
    { "c": "patrol",  "ids": [102], "x": 20, "z": 20, "x2": 30, "z2": 30 },
    { "c": "train",   "building_id": 200, "unit_type": "marine", "count": 1 },
    { "c": "build",   "worker_id": 101, "unit_type": "barracks", "x": 35, "z": 30 },
    { "c": "cancel",  "building_id": 200 },
    { "c": "rally",   "building_id": 200, "x": 40, "z": 40 },
    { "c": "harvest", "worker_id": 101 },
    { "c": "ability", "ids": [550], "ability": "stimpack" },
    { "c": "select",  "ids": [101] },
    { "c": "chat",    "text": "gg" }
  ]
}
```

Field rules:

- `ids` is a non-empty array of integer entity ids, max 256 per command.
- All commands in a batch are validated independently. Valid ones are applied
  in array order; invalid ones are dropped individually.
- `queue: true` appends behind the current order queue instead of replacing.
- Coordinates are world-space metres, `0 ≤ x,z < 256`.
- `unit_type` must exist in the shared roster for the issuing player's race.
- Ownership is enforced: a player may only issue orders to entities they own.

`game:reject` reports dropped commands, always matching by command index:

```json
{ "v": 1, "t": "game:reject", "ts": 0,
  "rejected": [ { "index": 0, "code": "not_owner", "message": "…" } ] }
```

Codes: `not_owner`, `no_such_entity`, `dead_entity`, `invalid_target`,
`out_of_range`, `insufficient_resources`, `queue_full`, `production_busy`,
`cooldown`, `not_ready`, `invalid_payload`, `no_such_unit_type`,
`no_such_ability`.

---

## 5. Snapshots (server → client)

`game:snapshot` carries the full entity table. Full-table broadcast (not
deltas) is deliberate: at ≤256 entities per side it is smaller than a delta
plus per-client bookkeeping, and it makes late joiners and reconnects free.

```json
{
  "v": 1, "t": "game:snapshot", "ts": 0,
  "tick": 841, "server_ms": 12345, "ack": 838,
  "entities": [ Entity... ],
  "events": [ Event... ]
}
```

`ack` is the highest `from_tick` the server has processed from this client;
the client may drop prediction history at or below it.

### Entity

```json
{
  "id": 101, "ty": "marine", "pl": 7, "x": 40.5, "z": 12.25, "y": 0.4,
  "hp": 45, "hp_max": 45, "mp": 0, "mp_max": 0,
  "ang": 1.5708, "st": "idle",
  "w": 0.0,               // weapon cooldown, seconds remaining
  "sel": 0,               // selected for whom: 0 none, 1 self, 2 ally, 3 enemy
  "tid": 0,               // current target entity id, 0 = none
  "ord": 0,               // 0 = none, else 1 move / 2 attack / 3 harvest / 4 patrol
  "ox": 0.0, "oz": 0.0,   // order destination
  "prog": 0.0,            // construction / production progress 0..1
  "cargo": 0,             // resource units carried
  "res": 200,             // player resources (only on the player's own workers)
  "n": 8,                 // queued production count
  "b": 0                  // active ability buff bitmask
}
```

Fields are omitted when they equal the type's static default, to keep frames
small. The ground plane is `x`/`z` and height is `y` — the three.js
Y-up convention, matching `shared/TERRAIN.md` and the client renderer.
`y` is authoritative terrain height: clients must not recompute it from
their own height field, or units visibly float or sink.

`st` is one of: `idle, moving, attacking, harvesting, returning, building,
training, casting, dead`.

`sel` is advisory colour state; clients may recompute it locally.

### Events

Events are transient (one snapshot only) and drive VFX, audio and floating
text. They are never replayed for interpolation.

```json
{ "e": "shot",  "id": 101, "x": 40.5, "z": 12.25, "y": 1.0, "tx": 44, "tz": 12, "ty": 0.8 }
{ "e": "hit",   "id": 101, "tid": 550, "dmg": 9, "crit": false, "shield": false }
{ "e": "death", "id": 550, "ty": "zealot", "x": 44, "z": 12, "y": 0.4, "killer": 101 }
{ "e": "built", "id": 200, "ty": "barracks", "x": 35, "z": 30, "y": 0 }
{ "e": "proj",  "id": 9001, "ty": "bullet", "x": 1, "z": 2, "y": 3, "tx": 4, "tz": 5, "ty": 6 }
{ "e": "ability", "id": 550, "ab": "stimpack", "x": 1, "z": 2, "y": 3 }
{ "e": "res",   "pl": 7, "amount": 15, "x": 1, "z": 2 }
{ "e": "alert", "text": "Under attack" }
```

`e` values: `shot, hit, death, built, proj, ability, res, alert`.

### `game:ended`

```json
{
  "v": 1, "t": "game:ended", "ts": 0, "tick": 9123,
  "winner": 8, "reason": "defeat", "duration_ms": 456150,
  "scores": [ { "player_id": 7, "race": "terran", "result": "defeat",
                "kills": 41, "deaths": 22, "resources_mined": 12450,
                "units_built": 88, "army_value": 3120 } ],
  "replay_url": "/api/v1/matches/12/replay"
}
```

`reason`: `defeat, annihilation, timeout, forfeit, disconnect, stalemate`.
`winner` is `null` on a draw.

---

## 6. Determinism

Server and clients share the simulation rules. Clients use the shared
simulation module only for *prediction* and *interpolation*; the server's
snapshot always wins.

- PRNG: `mulberry32`, seeded `seed ^ imul(player_id, 0x9E3779B1)`.
- The simulation advances only in whole 50 ms steps. Float accumulation uses
  the order defined in `shared/sim/step-order.json`.
- Commands issued in a snapshot tick are applied in ascending `index`.
- Entity ids are allocated from one monotonically increasing server counter
  starting at 1 per match; clients never allocate ids.

---

## 7. REST API

All under `/api/v1`. Errors: `{ "error": { "code", "message" } }` with an
appropriate HTTP status.

| method | path | body | returns |
|---|---|---|---|
| POST | `/players` | `{ name, password }` | `201 { token, player }` |
| POST | `/session` | `{ name, password }` | `200 { token, player }` |
| GET | `/me` | — | `200 { player }` (bearer token) |
| GET | `/races` | — | `200 { races: [...] }` full roster |
| GET | `/maps` | — | `200 { maps: [...] }` |
| GET | `/matches` | `?status=&mode=&map_id=&page=` | `200 { matches, page, per_page, total }` |
| POST | `/matches` | `{ name, mode, map_id, max_players, password? }` | `201 { match }` |
| GET | `/matches/:id` | — | `200 { match }` with players |
| POST | `/matches/:id/join` | `{ password? }` | `200 { match }` |
| POST | `/matches/:id/leave` | — | `200 { match }` |
| POST | `/matches/:id/ready` | `{ ready }` | `200 { match }` |
| POST | `/matches/:id/start` | — | `200 { match }` host only |
| GET | `/matches/:id/replay` | — | `200 { header, commands, snapshots_meta, replay_url }` |
| GET | `/matches/:id/replay.json` | — | `200 application/json` full replay |
| GET | `/leaderboard` | `?race=&mode=&limit=` | `200 { entries }` |
| GET | `/players/:name/stats` | — | `200 { player, stats }` |

Auth: `Authorization: Bearer <token>`. Tokens are opaque random strings with
a 30-day expiry, stored in the `sessions` table.

---

## 8. Replay format

```json
{
  "format": "starc-replay",
  "version": 1,
  "header": {
    "match_id": 12, "map_id": "altaior", "seed": 987654321, "mode": "melee",
    "started_at": "2026-09-27T10:00:00Z", "duration_ms": 456150, "winner": 8,
    "players": [ { "player_id": 7, "name": "nik", "race": "terran", "team": 1,
                   "result": "defeat" } ]
  },
  "commands": [ { "tick": 0, "player_id": 7, "index": 0, "c": "move",
                  "ids": [101], "x": 40.5, "z": 12.25, "queue": false } ],
  "final_state": { "entities": [ Entity... ] }
}
```

A replay is deterministic: feeding `commands` to the shared simulation from
`header.seed` reproduces `final_state` exactly. `spec/replay_determinism_spec.rb`
asserts this.
