/**
 * `GameState` is the client's whole view of a match, derived from two wire
 * messages. The failures that matter are all "the HUD is wrong and nobody can
 * tell why": a stale entity still on the map after it died, supply that never
 * moves, an ally drawn as an enemy, or a resource counter that drifts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { GAME } from "@shared/gameData";
import { GameState } from "./gameState";
import type { EndMessage, SnapshotPayload, StartMessage } from "./gameState";
import type { GameEvent, ProtocolEntity } from "@shared/protocol";

const ME = 1;
const ALLY = 2;
const ENEMY = 3;

function entity(id: number, over: Partial<ProtocolEntity> = {}): ProtocolEntity {
  return {
    id,
    ty: "marine",
    pl: ME,
    x: 0,
    y: 0,
    z: 0,
    hp: 45,
    hp_max: 45,
    mp: 0,
    mp_max: 0,
    ang: 0,
    st: "idle",
    ...over,
  };
}

function start(over: Partial<StartMessage> = {}): StartMessage {
  return {
    v: 1,
    t: "game:start",
    match_id: 7,
    seed: 42,
    map_id: "dust",
    tick_rate: 20,
    snapshot_rate: 10,
    countdown_ms: 3_000,
    players: [
      { player_id: ME, slot: 0, race: "terran", name: "me", team: 0, start: { x: 10, y: 10 } },
      { player_id: ALLY, slot: 1, race: "zerg", name: "ally", team: 0, start: { x: 12, y: 10 } },
      { player_id: ENEMY, slot: 2, race: "protoss", name: "foe", team: 1, start: { x: 200, y: 200 } },
    ],
    ...over,
  };
}

function snapshot(tick: number, entities: ProtocolEntity[], events: GameEvent[] = []): SnapshotPayload {
  return { tick, entities, events };
}

function endMsg(tick: number): EndMessage {
  return {
    v: 1,
    t: "game:ended",
    tick,
    winner: ME,
    reason: "annihilation",
    duration_ms: 600_000,
    scores: [],
    replay_url: "/replays/7.json",
  };
}

describe("GameState entity table", () => {
  let state: GameState;

  beforeEach(() => {
    state = new GameState(ME);
    state.start(start());
  });

  it("holds the entities of the snapshot it was given", () => {
    state.applySnapshot(snapshot(10, [entity(1), entity(2)]));

    expect(state.entities().map((e) => e.id).sort()).toEqual([1, 2]);
    expect(state.tick).toBe(10);
  });

  it("replaces the whole entity set on the next snapshot", () => {
    state.applySnapshot(snapshot(10, [entity(1), entity(2)]));
    state.applySnapshot(snapshot(11, [entity(2), entity(3)]));

    // Snapshots are full tables, so a merge would leave a unit that died ten
    // seconds ago standing in the middle of the base.
    expect(state.entities().map((e) => e.id).sort()).toEqual([2, 3]);
    expect(state.entity(1)).toBeUndefined();
    expect(state.entity(3)?.id).toBe(3);
  });

  it("ignores a late or duplicated snapshot instead of rewinding the world", () => {
    state.applySnapshot(snapshot(20, [entity(1, { x: 50 })]));
    state.applySnapshot(snapshot(15, [entity(1, { x: 5 }), entity(9)]));

    expect(state.tick).toBe(20);
    expect(state.entity(1)?.x).toBe(50);
    expect(state.entity(9)).toBeUndefined();
  });

  it("applies a repeated tick, which is how a resynchronise rewinds", () => {
    state.applySnapshot(snapshot(20, [entity(1, { x: 50 })]));
    state.applySnapshot(snapshot(20, [entity(1, { x: 7 })]));
    expect(state.entity(1)?.x).toBe(7);
  });

  it("filters ownEntities to the local player's units", () => {
    state.applySnapshot(
      snapshot(10, [entity(1), entity(2, { pl: ALLY }), entity(3, { pl: ENEMY, ty: "zealot" })]),
    );

    expect(state.ownEntities().map((e) => e.id)).toEqual([1]);
    expect(state.entitiesOf(ENEMY).map((e) => e.id)).toEqual([3]);
    expect(state.isOwner(1)).toBe(true);
    expect(state.isOwner(3)).toBe(false);
  });

  it("tracks the seat when the lobby tells us our id after construction", () => {
    const late = new GameState(0);
    late.start(start());
    late.applySnapshot(snapshot(1, [entity(1, { pl: 2 })]));
    expect(late.ownEntities()).toHaveLength(0);

    late.setMyPlayerId(2);
    // Before the seat is known the HUD shows an empty, unusable roster.
    expect(late.myPlayerId).toBe(2);
    expect(late.ownEntities().map((e) => e.id)).toEqual([1]);
  });

  it("starts from a clean slate when a new match starts", () => {
    state.applySnapshot(snapshot(10, [entity(1)]));
    state.end(endMsg(10));
    state.start(start({ match_id: 8, map_id: "mar Sara" }));

    expect(state.finished).toBe(false);
    expect(state.matchId).toBe(8);
    expect(state.mapId).toBe("mar Sara");
    expect(state.entities()).toEqual([]);
    expect(state.minerals()).toBe(0);
  });
});

describe("GameState relations", () => {
  let state: GameState;

  beforeEach(() => {
    state = new GameState(ME);
    state.start(start());
    state.applySnapshot(snapshot(1, [entity(1), entity(2, { pl: ALLY }), entity(3, { pl: ENEMY })]));
  });

  it("treats the local player as own", () => {
    expect(state.relationTo(1)).toBe("own");
    expect(state.relationOfPlayer(ME)).toBe("own");
  });

  it("treats a player on our team as an ally", () => {
    // Teams come from game:start, not from "whoever is nearby"; guessing it is
    // how a teammate's marines end up in your attack-move.
    expect(state.relationOfPlayer(ALLY)).toBe("ally");
    expect(state.relationTo(2)).toBe("ally");
  });

  it("treats a player on another team as an enemy", () => {
    expect(state.relationOfPlayer(ENEMY)).toBe("enemy");
    expect(state.relationTo(3)).toBe("enemy");
  });

  it("calls an unknown id an enemy, since it cannot be ours", () => {
    expect(state.relationTo(999)).toBe("enemy");
  });

  it("exposes the roster it was started with, in slot order", () => {
    expect(state.players.map((p) => p.playerId)).toEqual([ME, ALLY, ENEMY]);
    expect(state.playerInfo(ENEMY)?.name).toBe("foe");
    expect(state.raceOf(ALLY)).toBe("zerg");
  });
});

describe("GameState economy", () => {
  let state: GameState;

  beforeEach(() => {
    state = new GameState(ME);
    state.start(start());
  });

  it("reads the spendable balance off our own worker's res field", () => {
    state.applySnapshot(snapshot(1, [entity(1, { ty: "scv", res: 500 })]));

    expect(state.minerals()).toBe(500);
    expect(state.vespene()).toBe(0);
  });

  it("ignores the balance echoed on somebody else's worker", () => {
    state.applySnapshot(snapshot(1, [entity(1, { ty: "scv" }), entity(2, { pl: ALLY, ty: "scv", res: 9_999 })]));

    // Reading the wrong player's balance is how the HUD shows a rich army you
    // cannot afford.
    expect(state.minerals()).toBe(0);
  });

  it("keeps the attributed split summing back to the echoed balance", () => {
    state.applySnapshot(snapshot(1, [entity(1, { ty: "scv", res: 500 })]));
    state.applySnapshot(snapshot(2, [entity(1, { ty: "scv", res: 650 })], [
      { e: "res", pl: ME, amount: 50, x: 0, y: 0 },
    ]));

    // Growth the delivery events do not explain is geyser income; the two
    // counters must still add up to what the server echoed.
    expect(state.vespene()).toBe(100);
    expect(state.minerals()).toBe(550);
    expect(state.minerals() + state.vespene()).toBe(650);
  });

  it("never reports a negative resource after a spend", () => {
    state.applySnapshot(snapshot(1, [entity(1, { ty: "scv", res: 500 })]));
    state.applySnapshot(snapshot(2, [entity(1, { ty: "scv", res: 120 })]));

    expect(state.minerals()).toBe(120);
    expect(state.vespene()).toBe(0);
  });

  it("sums our own units' supply and counts buildings against the cap", () => {
    state.applySnapshot(
      snapshot(1, [
        entity(1, { ty: "marine" }),
        entity(2, { ty: "marine" }),
        entity(3, { ty: "scv" }),
        entity(4, { ty: "siege_tank" }),
        entity(5, { ty: "command_center" }),
        entity(6, { ty: "supply_depot" }),
        entity(7, { pl: ENEMY, ty: "marine" }),
      ]),
    );

    // 2 marines + 1 scv + 3 tank = 6; a dead unit costs nothing.
    expect(state.supply()).toBe(6);
    expect(state.supplyMax()).toBe(GAME.base_supply + 10 + 8);
  });

  it("does not count an unfinished building towards the supply cap", () => {
    state.applySnapshot(snapshot(1, [entity(1, { ty: "barracks", prog: 0.5 })]));

    // A building still under construction provides nothing to build behind.
    expect(state.supplyMax()).toBe(GAME.base_supply);
  });

  it("holds the selection the UI set, copied rather than aliased", () => {
    const ids = [3, 1, 2];
    state.setSelection(ids);
    ids.push(99);

    expect(state.selection()).toEqual([3, 1, 2]);
  });
});

describe("GameState end of match", () => {
  let state: GameState;

  beforeEach(() => {
    state = new GameState(ME);
    state.start(start());
    state.applySnapshot(snapshot(10, [entity(1), entity(2)]));
  });

  it("marks the match finished and remembers why", () => {
    state.end(endMsg(10));

    expect(state.finished).toBe(true);
    expect(state.endPayload?.reason).toBe("annihilation");
    expect(state.endPayload?.winner).toBe(ME);
  });

  it("does not let a late snapshot revive the finished world", () => {
    state.end(endMsg(10));
    state.applySnapshot(snapshot(11, [entity(1), entity(5), entity(6)]));

    // A snapshot still in flight when game:ended lands must not put units back
    // on a map the results screen has already declared over.
    expect(state.entities().map((e) => e.id).sort()).toEqual([1, 2]);
    expect(state.tick).toBe(10);
    expect(state.entity(5)).toBeUndefined();
  });

  it("disposes back to an empty, reusable state", () => {
    state.end(endMsg(10));
    state.dispose();

    expect(state.started).toBe(false);
    expect(state.finished).toBe(false);
    expect(state.entities()).toEqual([]);
    expect(state.players).toEqual([]);
  });
});
