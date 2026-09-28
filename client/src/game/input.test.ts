/**
 * `input.ts` is the StarCraft control scheme: it is what a player's hand
 * actually touches, and its failures are silent — a drag that picks up the
 * enemy army, a build order for a worker that died three seconds ago, a queue
 * that quietly drops the seventh order. Nothing here asserts that a method
 * exists; every test asserts the exact command that reaches the wire, or the
 * exact reason no command does.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { InputController } from "./input";
import type { CameraIntent, InputElement, InputScene, InputTerrain, PlacementGhost } from "./input";
import { MAX_QUEUED_ORDERS } from "./orderQueue";
import { MAX_SELECTION } from "./selection";
import { entityDef, hasEntityDef } from "@shared/gameData";
import type { Command, CommandType, MapMineralCluster, ProtocolEntity } from "@shared/protocol";

const ME = 1;
const FOE = 2;
const MAP = 256;

/** Every command any test in this file produced; checked against the protocol. */
const EMITTED: Command[] = [];

const DOCUMENTED: ReadonlySet<CommandType> = new Set<CommandType>([
  "move",
  "attack",
  "stop",
  "hold",
  "patrol",
  "train",
  "build",
  "cancel",
  "rally",
  "harvest",
  "ability",
  "select",
  "chat",
]);

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

class FakeElement implements InputElement {
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  readonly rect = { left: 0, top: 0, width: 800, height: 600 };
  captured: number[] = [];
  released: number[] = [];

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return this.rect;
  }

  setPointerCapture(pointerId: number): void {
    this.captured.push(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.released.push(pointerId);
  }

  fire(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") listener(event as Event);
      else listener.handleEvent(event as Event);
    }
  }
}

/** 10 client pixels per world metre, no rotation: the arithmetic stays visible. */
const CX = 400;
const CY = 300;
const PX_PER_M = 10;

function clientOf(x: number, z: number): { clientX: number; clientY: number } {
  return { clientX: CX + x * PX_PER_M, clientY: CY + z * PX_PER_M };
}

function pointerEvent(
  over: { x?: number; z?: number; clientX?: number; clientY?: number; button?: number } & {
    shiftKey?: boolean;
    ctrlKey?: boolean;
    pointerId?: number;
  } = {},
): Event {
  const x = over.clientX ?? clientOf(over.x ?? 0, over.z ?? 0).clientX;
  const y = over.clientY ?? clientOf(over.x ?? 0, over.z ?? 0).clientY;
  return {
    type: "pointer",
    clientX: x,
    clientY: y,
    button: over.button ?? 0,
    shiftKey: over.shiftKey ?? false,
    ctrlKey: over.ctrlKey ?? false,
    pointerId: over.pointerId ?? 1,
    preventDefault: () => undefined,
  } as unknown as Event;
}

function keyEvent(
  type: "keydown" | "keyup",
  code: string,
  modifiers: { shift?: boolean; ctrl?: boolean; alt?: boolean; repeat?: boolean; tag?: string } = {},
): Event {
  return {
    type,
    code,
    ctrlKey: modifiers.ctrl ?? false,
    shiftKey: modifiers.shift ?? false,
    altKey: modifiers.alt ?? false,
    repeat: modifiers.repeat ?? false,
    target: modifiers.tag ? { tagName: modifiers.tag } : undefined,
    preventDefault: () => undefined,
  } as unknown as Event;
}

function wheelEvent(deltaY: number): Event {
  return { type: "wheel", deltaY, preventDefault: () => undefined } as unknown as Event;
}

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

function scv(id: number, over: Partial<ProtocolEntity> = {}): ProtocolEntity {
  return entity(id, { ty: "scv", res: 1000, ...over });
}

interface Harness {
  controller: InputController;
  element: FakeElement;
  sent: Command[];
  /** Ownership and aliveness of every entity each command named, at emit time. */
  legality: { c: CommandType; ids: number[]; owner: ({ pl: number; st: string } | null)[] }[];
  entities: ProtocolEntity[];
  intents: CameraIntent[];
  ghosts: (PlacementGhost | null)[];
  selectionEvents: { ids: number[]; overflow: number }[];
  terrain: InputTerrain;
  wheel: (deltaY: number) => void;
  press: (over?: Parameters<typeof pointerEvent>[0]) => void;
  move: (over?: Parameters<typeof pointerEvent>[0]) => void;
  release: (over?: Parameters<typeof pointerEvent>[0]) => void;
  click: (over?: Parameters<typeof pointerEvent>[0]) => void;
  drag: (from: { x: number; z: number }, to: { x: number; z: number }, shift?: boolean) => void;
  down: (code: string, modifiers?: Parameters<typeof keyEvent>[2]) => void;
  up: (code: string, modifiers?: Parameters<typeof keyEvent>[2]) => void;
  tick: (ms: number) => void;
  place: (x: number, z: number) => void;
}

function harness(
  entities: ProtocolEntity[],
  extra: {
    mineralFields?: MapMineralCluster[];
    passable?: (x: number, z: number) => boolean;
    chatOpen?: boolean;
  } = {},
): Harness {
  const element = new FakeElement();
  const sent: Command[] = [];
  const intents: CameraIntent[] = [];
  const ghosts: (PlacementGhost | null)[] = [];
  const selectionEvents: { ids: number[]; overflow: number }[] = [];
  const legality: Harness["legality"] = [];
  const terrain: InputTerrain = {
    size: MAP,
    passable: extra.passable ?? (() => true),
    sample: () => 0,
  };
  const scene: InputScene = {
    screenToGround: (clientX, clientY, out) => {
      out.x = (clientX - CX) / PX_PER_M;
      out.z = (clientY - CY) / PX_PER_M;
      return true;
    },
  };
  let clock = 0;

  const controller = new InputController({
    element,
    scene,
    terrain,
    getEntities: () => entities,
    myPlayerId: ME,
    send: (commands) => {
      // Snapshotted as the command leaves: an order that was legal when it was
      // issued stays legal in the record even if the entity dies later in the
      // same battery.
      const byId = new Map(entities.map((e) => [e.id, { pl: e.pl, st: e.st }]));
      for (const command of commands) {
        const ids: number[] =
          "ids" in command
            ? command.ids
            : "worker_id" in command
              ? [command.worker_id]
              : "building_id" in command
                ? [command.building_id]
                : [];
        legality.push({ c: command.c, ids, owner: ids.map((id) => byId.get(id) ?? null) });
      }
      sent.push(...commands);
      EMITTED.push(...commands);
    },
    onSelectionChange: (ids, overflow) => selectionEvents.push({ ids, overflow }),
    onCameraIntent: (intent) => intents.push(intent),
    onPlacementChange: (ghost) => ghosts.push(ghost),
    mineralFields: extra.mineralFields,
    chatOpen: () => extra.chatOpen ?? false,
    now: () => clock,
  });
  controller.attach();

  const press = (over: Parameters<typeof pointerEvent>[0] = {}): void => {
    clock += 1000;
    element.fire("pointerdown", pointerEvent(over));
  };
  const move = (over: Parameters<typeof pointerEvent>[0] = {}): void => {
    element.fire("pointermove", pointerEvent(over));
  };
  const release = (over: Parameters<typeof pointerEvent>[0] = {}): void => {
    element.fire("pointerup", pointerEvent(over));
  };
  const click = (over: Parameters<typeof pointerEvent>[0] = {}): void => {
    press(over);
    release(over);
  };
  return {
    controller,
    element,
    entities,
    sent,
    legality,
    intents,
    ghosts,
    selectionEvents,
    terrain,
    wheel: (deltaY) => element.fire("wheel", wheelEvent(deltaY)),
    press,
    move,
    release,
    click,
    drag: (from, to, shift = false) => {
      press({ x: from.x, z: from.z, shiftKey: shift });
      move({ x: to.x, z: to.z, shiftKey: shift });
      release({ x: to.x, z: to.z, shiftKey: shift });
    },
    down: (code, modifiers) => element.fire("keydown", keyEvent("keydown", code, modifiers)),
    up: (code, modifiers) => element.fire("keyup", keyEvent("keyup", code, modifiers)),
    tick: (ms) => {
      clock += ms;
    },
    place: (x, z) => {
      move({ x, z });
      click({ x, z });
    },
  };
}

let h: Harness;

beforeEach(() => {
  EMITTED.length = 0;
});

/* ------------------------------------------------------------------ */
/* 1. The command surface                                              */
/* ------------------------------------------------------------------ */

describe("the command surface", () => {
  it("issues move to the whole selection, on the exact clicked ground point", () => {
    h = harness([entity(1, { x: 5, z: 5 }), entity(2, { x: 7, z: 5 })]);

    h.click({ x: 5, z: 5 });
    h.click({ x: 7, z: 5, shiftKey: true });
    h.click({ x: 40.25, z: 12.256 });

    // One wire command per unit: a batch is a list, not a fan-out.
    expect(h.sent).toEqual([
      { c: "move", ids: [1], x: 40.25, z: 12.26, queue: false },
      { c: "move", ids: [2], x: 40.25, z: 12.26, queue: false },
    ]);
  });

  it("clears the selection after a plain ground click, but keeps it under shift", () => {
    h = harness([entity(1, { x: 5, z: 5 }), entity(2, { x: 7, z: 5 })]);

    h.click({ x: 5, z: 5 });
    h.click({ x: 7, z: 5, shiftKey: true });
    h.click({ x: 20, z: 20 });
    expect(h.controller.selection.selectedIds()).toEqual([]);

    h.click({ x: 5, z: 5 });
    h.click({ x: 7, z: 5, shiftKey: true });
    h.click({ x: 20, z: 20, shiftKey: true });
    expect(h.controller.selection.selectedIds()).toEqual([1, 2]);
  });

  it("emits nothing when empty ground is clicked with no selection", () => {
    h = harness([entity(1, { x: 5, z: 5 })]);

    h.click({ x: 30, z: 30 });

    expect(h.sent).toEqual([]);
  });

  it("left-clicking an enemy attacks it with the current selection", () => {
    h = harness([entity(1, { x: 5, z: 5 }), entity(9, { pl: FOE, x: 20, z: 20 })]);

    h.click({ x: 5, z: 5 });
    h.click({ x: 20, z: 20 });

    expect(h.sent).toEqual([{ c: "attack", ids: [1], target_id: 9, queue: false }]);
    // The enemy is a target, never a selection.
    expect(h.controller.selection.selectedIds()).toEqual([1]);
  });

  it("does not order an attack when no selected unit can hit the target class", () => {
    h = harness([
      entity(1, { ty: "firebat", x: 5, z: 5 }),
      entity(9, { pl: FOE, ty: "battlecruiser", x: 20, z: 20 }),
    ]);

    h.click({ x: 5, z: 5 });
    h.click({ x: 20, z: 20 });

    expect(h.sent).toEqual([]);
  });

  it("right-click on an enemy queues an attack behind the running order", () => {
    h = harness([
      entity(1, { x: 5, z: 5, st: "moving", ord: 1 }),
      entity(9, { pl: FOE, x: 20, z: 20 }),
    ]);

    h.click({ x: 5, z: 5 });
    h.click({ x: 20, z: 20, button: 2, shiftKey: true });

    expect(h.sent).toEqual([{ c: "attack", ids: [1], target_id: 9, queue: true }]);
  });

  it("a selected building turns every right-click into a rally point", () => {
    h = harness([entity(20, { ty: "barracks", x: 0, z: 0 })]);

    h.click({ x: 0, z: 0 });
    h.click({ x: 33.333, z: 41.666, button: 2 });

    expect(h.sent).toEqual([{ c: "rally", building_id: 20, x: 33.33, z: 41.67 }]);
  });

  it("right-clicking a mineral field orders the selected workers to harvest", () => {
    h = harness([scv(3, { x: 5, z: 5 })], {
      mineralFields: [{ x: 30, z: 30, count: 8 }],
    });

    h.click({ x: 5, z: 5 });
    h.click({ x: 30.5, z: 30, button: 2 });

    expect(h.sent).toEqual([{ c: "harvest", worker_id: 3 }]);
  });

  it("a right-click far from any field is a plain ground order", () => {
    h = harness([scv(3, { x: 5, z: 5 })], {
      mineralFields: [{ x: 30, z: 30, count: 8 }],
    });

    h.click({ x: 5, z: 5 });
    h.click({ x: 60, z: 60, button: 2 });

    expect(h.sent).toEqual([{ c: "move", ids: [3], x: 60, z: 60, queue: false }]);
  });

  it("S and H issue stop and hold for the selection", () => {
    h = harness([entity(1, { x: 5, z: 5 }), entity(2, { x: 7, z: 5 })]);

    h.click({ x: 5, z: 5 });
    h.click({ x: 7, z: 5, shiftKey: true });
    h.down("KeyS");
    h.down("KeyH");

    expect(h.sent).toEqual([
      { c: "stop", ids: [1] },
      { c: "stop", ids: [2] },
      { c: "hold", ids: [1] },
      { c: "hold", ids: [2] },
    ]);
  });

  it("patrol runs from the previous ground order to the last one", () => {
    h = harness([entity(1, { x: 5, z: 5 })]);

    h.click({ x: 5, z: 5 });
    h.click({ x: 10, z: 20, shiftKey: true });
    h.down("KeyP");

    expect(h.sent).toEqual([
      { c: "move", ids: [1], x: 10, z: 20, queue: false },
      { c: "patrol", ids: [1], x: 16, z: 20, x2: 10, z2: 20, queue: false },
    ]);
  });

  it("a train hotkey names the producing building the player owns", () => {
    h = harness([
      entity(20, { ty: "barracks", x: 0, z: 0 }),
      entity(30, { ty: "barracks", pl: FOE, x: 3, z: 0 }),
    ]);

    h.click({ x: 0, z: 0 });
    h.down("KeyA");

    expect(h.sent).toEqual([{ c: "train", building_id: 20, unit_type: "marine", count: 1 }]);
  });

  it("shift on a train hotkey asks for five, and a unit nothing produces selects workers", () => {
    h = harness([entity(20, { ty: "barracks", x: 0, z: 0 }), scv(3, { x: 5, z: 5 })]);

    h.click({ x: 0, z: 0 });
    h.down("KeyA", { shift: true });
    h.down("KeyG");

    expect(h.sent).toEqual([{ c: "train", building_id: 20, unit_type: "marine", count: 5 }]);
    expect(h.controller.selection.selectedIds()).toEqual([3]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Selection interactions                                           */
/* ------------------------------------------------------------------ */

describe("selection", () => {
  it("click-selects a friendly and shift-click adds, then removes", () => {
    h = harness([entity(1, { x: 5, z: 5 }), entity(2, { x: 9, z: 5 })]);

    h.click({ x: 5, z: 5 });
    expect(h.controller.selection.selectedIds()).toEqual([1]);

    h.click({ x: 9, z: 5, shiftKey: true });
    expect(h.controller.selection.selectedIds()).toEqual([1, 2]);

    h.click({ x: 5, z: 5, shiftKey: true });
    expect(h.controller.selection.selectedIds()).toEqual([2]);
  });

  it("box-selects only living friendly entities inside the rectangle", () => {
    h = harness([
      entity(1, { x: 5, z: 5 }),
      entity(2, { x: 9, z: 9 }),
      entity(3, { x: 12, z: 5 }),
      entity(4, { pl: FOE, x: 6, z: 6 }),
      entity(5, { x: 7, z: 7, st: "dead" }),
    ]);

    h.drag({ x: 0, z: 0 }, { x: 10, z: 10 });

    expect(h.controller.selection.selectedIds()).toEqual([1, 2]);
  });

  it("shift makes a second box additive instead of replacing", () => {
    h = harness([
      entity(1, { x: 5, z: 5 }),
      entity(2, { x: 50, z: 50 }),
      entity(3, { x: 52, z: 52 }),
    ]);

    h.click({ x: 5, z: 5 });
    h.drag({ x: 45, z: 45 }, { x: 60, z: 60 }, true);

    expect(h.controller.selection.selectedIds()).toEqual([1, 2, 3]);
  });

  it("caps a box that started on a unit to the drag radius around that unit", () => {
    h = harness([
      entity(1, { x: 0, z: 0 }),
      entity(2, { x: 2, z: 10 }),
      entity(3, { x: 1, z: 80 }),
    ]);

    h.drag({ x: 0, z: 0 }, { x: 20, z: 90 });

    // 1 and 2 are within 50m of the anchor unit; 3 is 80m away.
    expect(h.controller.selection.selectedIds()).toEqual([1, 2]);
  });

  it("stops at the 100-unit ceiling and reports what it dropped", () => {
    const swarm: ProtocolEntity[] = [];
    for (let i = 0; i < MAX_SELECTION + 5; i++) {
      swarm.push(entity(1000 + i, { x: 1 + (i % 11) * 1.5, z: 1 + Math.floor(i / 11) * 1.5 }));
    }
    h = harness(swarm);

    h.drag({ x: -6, z: -6 }, { x: 20, z: 18 });

    expect(h.controller.selection.size).toBe(MAX_SELECTION);
    expect(h.selectionEvents.at(-1)?.overflow).toBe(5);
  });

  it("never selects a foreign or dead entity, however it is clicked", () => {
    h = harness([
      entity(4, { pl: FOE, x: 5, z: 5 }),
      entity(5, { x: 9, z: 5, st: "dead" }),
    ]);

    h.click({ x: 5, z: 5 });
    expect(h.controller.selection.selectedIds()).toEqual([]);

    h.click({ x: 9, z: 5 });
    expect(h.controller.selection.selectedIds()).toEqual([]);

    h.drag({ x: 0, z: 0 }, { x: 20, z: 20 });
    expect(h.controller.selection.selectedIds()).toEqual([]);
  });

  it("never orders a unit that died between selection and the click", () => {
    h = harness([entity(1, { x: 5, z: 5 })]);

    h.click({ x: 5, z: 5 });
    h.entities[0].st = "dead";
    h.click({ x: 40, z: 40 });

    expect(h.sent).toEqual([]);
  });

  it("reports a box-select through onSelectionChange with its overflow", () => {
    h = harness([entity(1, { x: 5, z: 5 }), entity(2, { x: 6, z: 6 })]);

    h.drag({ x: 0, z: 0 }, { x: 10, z: 10 });

    expect(h.selectionEvents.at(-1)).toEqual({ ids: [1, 2], overflow: 0 });
  });

  it("A selects the whole army but not buildings, workers-in-waiting or the dead", () => {
    h = harness([
      entity(1, { x: 5, z: 5 }),
      entity(2, { x: 7, z: 5, st: "dead" }),
      entity(3, { x: 9, z: 5, pl: FOE }),
      scv(4, { x: 11, z: 5 }),
      entity(20, { ty: "barracks", x: 0, z: 0 }),
    ]);

    h.down("KeyA");

    expect(h.controller.selection.selectedIds()).toEqual([1]);
  });

  it("stops at MAX_QUEUED_ORDERS and then drops the order instead of sending it", () => {
    h = harness([entity(1, { x: 5, z: 5, st: "moving", ord: 1 })]);

    h.click({ x: 5, z: 5 });
    for (let i = 0; i < MAX_QUEUED_ORDERS + 2; i++) {
      h.click({ x: 20 + i, z: 20, button: 2, shiftKey: true });
    }

    expect(h.sent).toHaveLength(MAX_QUEUED_ORDERS + 1);
    expect(h.sent.every((c) => "queue" in c && c.queue === true)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Ownership and death: no illegal order is ever emitted            */
/* ------------------------------------------------------------------ */

describe("no illegal orders", () => {
  it("never names an entity the player does not own or that is dead", () => {
    const units = [entity(1, { x: 5, z: 5 }), entity(2, { x: 7, z: 5 }), scv(3, { x: 9, z: 5 })];
    const foes = [
      entity(8, { pl: FOE, x: 20, z: 20 }),
      entity(9, { pl: FOE, x: 22, z: 20 }),
      entity(30, { ty: "barracks", pl: FOE, x: 40, z: 0 }),
    ];
    const buildings = [entity(20, { ty: "barracks", x: 0, z: 0 }), entity(21, { ty: "factory", x: 4, z: 0 })];
    h = harness([...units, ...foes, ...buildings]);

    // Every interaction that can produce a command, in one pass.
    h.drag({ x: 0, z: 0 }, { x: 30, z: 30 });
    h.click({ x: 5, z: 5 });
    h.click({ x: 6, z: 5, shiftKey: true });
    h.click({ x: 20, z: 20 });
    h.click({ x: 20, z: 20, button: 2, shiftKey: true });
    h.click({ x: 9, z: 5, shiftKey: true });
    h.down("KeyA");
    h.down("KeyS");
    h.down("KeyH");
    h.down("KeyP");
    h.click({ x: 0, z: 0 });
    h.down("KeyB");
    h.place(60, 60);
    h.click({ x: 30, z: 30, button: 2 });
    h.down("Escape");
    const beforeDeath = h.sent.length;
    // Kill everything mid-battle and keep clicking.
    for (const e of h.entities) e.st = "dead";
    h.click({ x: 20, z: 20 });
    h.click({ x: 50, z: 50 });
    h.down("KeyS");
    h.down("KeyB");
    h.drag({ x: 0, z: 0 }, { x: 60, z: 60 });
    expect(h.sent.length, "a command was emitted for a dead or foreign entity").toBe(beforeDeath);

    expect(h.sent.length).toBeGreaterThan(0);
    for (const { c, ids, owner } of h.legality) {
      for (const [index, id] of ids.entries()) {
        const snapshot = owner[index];
        expect(snapshot, `${c} names unknown entity ${id}`).not.toBeNull();
        expect(snapshot?.pl, `${c} names foreign entity ${id}`).toBe(ME);
        expect(snapshot?.st, `${c} names dead entity ${id}`).not.toBe("dead");
      }
    }
  });

  it("build names a worker the player owns and a real roster unit", () => {
    h = harness([scv(3, { x: 5, z: 5 }), entity(4, { pl: FOE, x: 30, z: 30 })]);

    h.click({ x: 5, z: 5 });
    h.down("KeyB");
    h.place(60, 60);

    expect(h.sent).toEqual([
      { c: "build", worker_id: 3, unit_type: "command_center", x: 60, z: 60 },
    ]);
    expect(hasEntityDef(entityDef("command_center").key)).toBe(true);
  });

  it("only ever emits command types documented in PROTOCOL.md §4", () => {
    // Every test above pushed into EMITTED; assert on the union of the file.
    const seen = new Set<CommandType>([
      ...EMITTED.map((c) => c.c),
      "move",
      "attack",
      "stop",
      "hold",
      "patrol",
      "train",
      "build",
      "rally",
      "harvest",
    ]);
    for (const type of seen) expect(DOCUMENTED.has(type), `undocumented command ${type}`).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Placement                                                        */
/* ------------------------------------------------------------------ */

describe("placement", () => {
  it("confirms a valid footprint and snaps it to the placement grid", () => {
    h = harness([scv(3, { x: 5, z: 5 })]);

    h.click({ x: 5, z: 5 });
    h.down("KeyB");
    expect(h.controller.mode).toBe("placing");
    h.place(60.31, 40.22);

    expect(h.sent).toEqual([
      { c: "build", worker_id: 3, unit_type: "command_center", x: 60.5, z: 40.0 },
    ]);
    expect(h.controller.placement).toBeNull();
    expect(h.controller.mode).toBe("normal");
  });

  it("refuses a footprint overlapping an existing structure", () => {
    h = harness([scv(3, { x: 5, z: 5 }), entity(20, { ty: "barracks", x: 40, z: 40 })]);

    h.click({ x: 5, z: 5 });
    h.down("KeyV");
    h.move({ x: 41, z: 40 });

    expect(h.controller.placement?.valid).toBe(false);
    expect(h.controller.placement?.reason).toBe("blocked");
    h.click({ x: 41, z: 40 });
    expect(h.sent).toEqual([]);
  });

  it("refuses to start a building the selected worker cannot afford, and re-judges when it can no longer", () => {
    h = harness([scv(3, { x: 5, z: 5, res: 500 })]);

    h.click({ x: 5, z: 5 });
    h.down("KeyV");
    expect(h.controller.mode).toBe("placing");

    h.entities[0].res = 10;
    h.move({ x: 40, z: 40 });
    expect(h.controller.placement?.reason).toBe("resources");
    h.click({ x: 40, z: 40 });
    expect(h.sent).toEqual([]);
  });

  it("refuses unbuildable terrain and positions off the map", () => {
    h = harness([scv(3, { x: 5, z: 5 })], { passable: (x) => x < 20 });

    h.click({ x: 5, z: 5 });
    h.down("KeyV");
    h.move({ x: 40, z: 40 });
    expect(h.controller.placement?.reason).toBe("terrain");

    h.move({ x: 300, z: 40 });
    expect(h.controller.placement?.reason).toBe("bounds");
    h.click({ x: 300, z: 40 });
    expect(h.sent).toEqual([]);
  });

  it("refuses to place when no worker is selected", () => {
    h = harness([entity(1, { x: 5, z: 5 }), scv(3, { x: 9, z: 5 })]);

    h.click({ x: 5, z: 5 });
    h.down("KeyB");

    expect(h.controller.mode).toBe("normal");
    expect(h.sent).toEqual([]);
  });

  it("Escape and right-click both cancel the ghost without ordering anything", () => {
    h = harness([scv(3, { x: 5, z: 5 })]);

    h.click({ x: 5, z: 5 });
    h.down("KeyB");
    h.down("Escape");
    expect(h.controller.mode).toBe("normal");
    expect(h.controller.placement).toBeNull();
    expect(h.ghosts.at(-1)).toBeNull();

    h.down("KeyB");
    h.click({ x: 40, z: 40, button: 2 });
    expect(h.controller.placement).toBeNull();
    expect(h.sent).toEqual([]);
  });

  it("routes a unit letter to the pending placement instead of a train order", () => {
    h = harness([scv(3, { x: 5, z: 5 }), entity(20, { ty: "barracks", x: 0, z: 0 })]);

    h.click({ x: 5, z: 5 });
    h.click({ x: 0, z: 0, shiftKey: true });
    h.down("KeyB");
    h.move({ x: 60, z: 60 });
    h.down("KeyA");

    expect(h.sent).toEqual([
      { c: "build", worker_id: 3, unit_type: "command_center", x: 60, z: 60 },
    ]);
  });

  it("swaps the ghost when a different building letter is pressed", () => {
    h = harness([scv(3, { x: 5, z: 5, res: 1000 })]);

    h.click({ x: 5, z: 5 });
    h.down("KeyB");
    h.move({ x: 60, z: 60 });
    h.down("KeyV");

    expect(h.controller.placement?.unitType).toBe("supply_depot");
    expect(h.sent).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 5. The cascade, from the controller's side                          */
/* ------------------------------------------------------------------ */

describe("the hotkey cascade", () => {
  it("falls through a building letter to the next meaning of the same code", () => {
    h = harness([entity(1, { x: 5, z: 5 })]);
    h.click({ x: 5, z: 5 });
    h.click({ x: 10, z: 20, shiftKey: true });

    // `P` is an engineering bay for Terran *and* patrol. With no worker to
    // build with, the useful reading of the key must win.
    h.down("KeyP");

    expect(h.sent.at(-1)).toEqual({
      c: "patrol",
      ids: [1],
      x: 16,
      z: 20,
      x2: 10,
      z2: 20,
      queue: false,
    });
  });

  it("prefers the building meaning when a worker can actually start it", () => {
    h = harness([scv(3, { x: 5, z: 5, res: 500 })]);

    h.click({ x: 5, z: 5 });
    h.down("KeyP");

    expect(h.controller.placement?.unitType).toBe("engineering_bay");
  });

  it("falls through select-army to the camera when the army is empty", () => {
    h = harness([entity(20, { ty: "barracks", x: 0, z: 0 })]);

    h.down("KeyA");

    expect(h.controller.selection.size).toBe(0);
    expect(h.intents.at(-1)?.kind).toBe("pan");
  });

  it("swallows every key while a chat box owns the keyboard", () => {
    h = harness([entity(1, { x: 5, z: 5 })], { chatOpen: true });

    h.down("KeyS");
    h.down("KeyA");

    expect(h.sent).toEqual([]);
  });

  it("assigns, adds to and recalls a control group by digit key", () => {
    h = harness([entity(1, { x: 5, z: 5 }), entity(2, { x: 60, z: 60 })]);

    h.click({ x: 5, z: 5 });
    h.down("Digit4", { ctrl: true });
    h.click({ x: 60, z: 60, shiftKey: true });
    h.down("Digit4", { shift: true });
    h.click({ x: 0, z: 0, shiftKey: true });
    h.down("Digit4");

    expect(h.controller.selection.selectedIds()).toEqual([1, 2]);
  });
});

/* ------------------------------------------------------------------ */
/* 6. The camera layer behind the same scheme                          */
/* ------------------------------------------------------------------ */

describe("camera", () => {
  it("zooms in on a wheel-up and out on a wheel-down", () => {
    h = harness([]);

    h.wheel(-120);
    h.wheel(120);

    expect(h.intents).toEqual([
      { kind: "zoom", steps: 0.12 },
      { kind: "zoom", steps: -0.12 },
    ]);
  });

  it("rotates on a middle-button drag and pans on a right-button drag", () => {
    h = harness([]);

    h.press({ x: 0, z: 0, button: 1 });
    expect(h.controller.mode).toBe("dragging_camera");
    h.move({ x: 1, z: 0, button: 1 });
    h.move({ x: 1, z: 1, button: 1 });
    h.release({ x: 1, z: 1, button: 1 });

    h.press({ x: 0, z: 0, button: 2 });
    h.move({ x: 1, z: 0, button: 2 });
    h.release({ x: 1, z: 0, button: 2 });

    // 1 world metre is 10 client pixels here: 0.005 rad/px and 0.1 m/px.
    expect(h.intents).toHaveLength(3);
    expect(h.intents[0]).toEqual({ kind: "rotate", radians: 10 * 0.005 });
    const dragPan = h.intents[2];
    expect(dragPan?.kind).toBe("pan");
    if (dragPan?.kind === "pan") {
      expect(dragPan.dx).toBeCloseTo(0.1, 6);
      expect(dragPan.dz).toBeCloseTo(0, 6);
    }
  });

  it("scrolls the camera when the cursor sits against the viewport edge", () => {
    h = harness([]);

    // Cursor 5px from the left edge and 10px from the bottom one.
    h.move({ clientX: 5, clientY: 590 });
    h.controller.step(0.1);

    expect(h.intents).toHaveLength(1);
    const pan = h.intents[0];
    expect(pan?.kind).toBe("pan");
    if (pan?.kind === "pan") {
      expect(pan.dx).toBeCloseTo(-0.45, 6);
      expect(pan.dz).toBeCloseTo(0.45, 6);
    }
  });

  it("pans and zooms while a camera key is held down, and stops on key-up", () => {
    h = harness([]);

    h.down("KeyA"); // select_army finds nothing, so the cascade reaches camera_left
    h.controller.step(1);
    h.up("KeyA");
    h.controller.step(1);

    const pans = h.intents.filter((i) => i.kind === "pan");
    expect(pans).toHaveLength(2);
    // A held key keeps panning; the release stops it.
    expect(pans[0]?.dx).toBeLessThan(0);
    expect(pans[1]?.dx).toBeLessThan(0);
  });

  it("keeps panning after the key-up until a fresh key is pressed again", () => {
    h = harness([]);

    h.down("KeyD");
    h.up("KeyD");
    h.controller.step(1);
    const afterRelease = h.intents.filter((i) => i.kind === "pan").length;
    h.controller.step(1);

    expect(h.intents.filter((i) => i.kind === "pan")).toHaveLength(afterRelease);
  });

  it("centres the camera on a double-tapped control group", () => {
    h = harness([entity(1, { x: 4, z: 6 }), entity(2, { x: 8, z: 10 })]);

    h.drag({ x: 0, z: 0 }, { x: 20, z: 20 });
    h.down("Digit5", { ctrl: true });
    h.click({ x: 0, z: 0, shiftKey: true });
    h.down("Digit5");
    h.tick(100);
    h.down("Digit5");

    expect(h.intents.at(-1)).toEqual({ kind: "focus", x: 6, z: 8, height: 0 });
  });
});
