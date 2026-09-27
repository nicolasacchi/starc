import { GameState } from "./game/gameState";
import { GameLoop } from "./game/gameLoop";
import type { ProtocolEntity } from "./shared/protocol";

function entity(id: number, pl: number, x = 0, extra: Partial<ProtocolEntity> = {}): ProtocolEntity {
  return {
    id,
    ty: "marine",
    pl,
    x,
    z: x,
    y: 0,
    hp: 45,
    hp_max: 45,
    mp: 0,
    mp_max: 0,
    ang: 0,
    st: "idle",
    ...extra,
  };
}

const state = new GameState(7);
state.start({
  v: 1,
  t: "game:start",
  match_id: 12,
  seed: 1,
  map_id: "altaior",
  tick_rate: 20,
  snapshot_rate: 10,
  countdown_ms: 3000,
  players: [
    { player_id: 7, slot: 0, race: "terran", name: "me", team: 1, start: { x: 32, y: 32 } },
    { player_id: 8, slot: 1, race: "zerg", name: "ally", team: 1, start: { x: 64, y: 32 } },
    { player_id: 9, slot: 2, race: "protoss", name: "foe", team: 2, start: { x: 96, y: 32 } },
  ],
});
state.applySnapshot({ tick: 10, entities: [entity(1, 7, 1), entity(2, 8, 2), entity(3, 9, 3)] });
console.assert(state.entities().length === 3, "three entities");
console.assert(state.ownEntities().length === 1, "one own entity");
console.assert(state.relationTo(2) === "ally", "same team is ally");
console.assert(state.relationTo(3) === "enemy", "other team is enemy");
console.assert(state.relationTo(1) === "own", "own");
state.applySnapshot({ tick: 11, entities: [entity(1, 7, 5, { res: 350 })] });
console.assert(state.entities().length === 1, "full-table replace drops the dead");
console.assert(state.minerals() === 350 && state.vespene() === 0, `resources ${state.minerals()}/${state.vespene()}`);
console.assert(state.supply() === 1 && state.supplyMax() === 10, `supply ${state.supply()}/${state.supplyMax()}`);

// vespene attribution: growth not explained by a cargo delivery is geyser income.
state.applySnapshot({
  tick: 12,
  entities: [entity(1, 7, 6, { res: 352 })],
  events: [],
});
console.assert(state.vespene() === 2, `vespene ${state.vespene()}`);
state.applySnapshot({
  tick: 13,
  entities: [entity(1, 7, 7, { res: 367 })],
  events: [{ e: "res", pl: 7, amount: 10, x: 1, y: 2 }],
});
console.assert(state.vespene() === 7 && state.minerals() === 360, `split ${state.minerals()}/${state.vespene()}`);
state.applySnapshot({ tick: 12, entities: [] });
console.assert(state.entities().length === 1, "an older tick is ignored");
state.end({ v: 1, t: "game:ended", tick: 900, winner: 9, reason: "defeat", duration_ms: 1000, scores: [], replay_url: "" });
console.assert(state.finished && state.tick === 900, "end recorded");
state.dispose();

// GameLoop: a 1 s frame is clamped to 0.25 s and drained in 5 steps of 1/60.
let clock = 0;
const steps: number[] = [];
let renders = 0;
const loop = new GameLoop({
  update: (dt) => steps.push(dt),
  render: () => { renders++; },
  now: () => clock,
  raf: () => 1,
  caf: () => {},
});
loop.start();
console.assert(loop.running, "running after start");
loop.stepFrame(1000);
console.assert(steps.length === 5, `catch-up steps ${steps.length}`);
console.assert(renders === 1, `one render per frame, got ${renders}`);
console.assert(steps.every((s) => Math.abs(s - 1 / 60) < 1e-9), "fixed step");
loop.stop();
console.assert(!loop.running, "stopped");

// A 1/30 s frame runs two sub-steps and keeps the remainder.
steps.length = 0;
clock = 0;
loop.start();
loop.stepFrame(1000 / 30);
console.assert(steps.length === 2, `30fps steps ${steps.length}`);
clock = 1000 / 30 + 1000 / 60;
loop.stepFrame(clock);
console.assert(steps.length === 3, `remainder carried, got ${steps.length}`);
loop.stop();
console.log("smoke ok");
