/**
 * `hotkeys.ts` is a cascade, not a lookup table: one code can mean several
 * things and the order decides what the key does. These tests assert the
 * orderings a player feels — press `A` with a barracks selected and a marine
 * appears; press it with nothing selected and the army is selected; press it
 * over the HUD and the camera pans — plus the one structural promise: the
 * roster letters come from `game-data.json`, not a hand-typed list.
 */
import { describe, expect, it } from "vitest";
import { CAMERA_ACTIONS, GROUP_DOUBLE_TAP_MS, HotkeyManager, keyLabel } from "./hotkeys";
import type { HotkeyAction, HotkeyContext } from "./hotkeys";
import { GAME, raceData } from "@shared/gameData";

interface Recorded {
  action: HotkeyAction;
  ctx: HotkeyContext;
}

function keyEvent(
  type: "keydown" | "keyup",
  code: string,
  modifiers: { shift?: boolean; ctrl?: boolean; alt?: boolean; repeat?: boolean; tag?: string } = {},
): KeyboardEvent {
  return {
    type,
    code,
    ctrlKey: modifiers.ctrl ?? false,
    shiftKey: modifiers.shift ?? false,
    altKey: modifiers.alt ?? false,
    repeat: modifiers.repeat ?? false,
    target: modifiers.tag ? { tagName: modifiers.tag } : undefined,
    preventDefault: () => undefined,
  } as unknown as KeyboardEvent;
}

function manager(
  accept: (action: HotkeyAction, ctx: HotkeyContext) => boolean = () => true,
  opts: {
    race?: "terran" | "zerg" | "protoss";
    ignore?: (event: KeyboardEvent) => boolean;
    resolveRace?: () => "terran" | "zerg" | "protoss" | null;
    now?: () => number;
  } = {},
): { hotkeys: HotkeyManager; seen: Recorded[] } {
  const seen: Recorded[] = [];
  const hotkeys = new HotkeyManager(
    (action, ctx) => {
      seen.push({ action, ctx });
      return accept(action, ctx);
    },
    {
      race: opts.race,
      resolveRace: opts.resolveRace,
      ignore: opts.ignore,
      now: opts.now,
    },
  );
  return { hotkeys, seen };
}

const actions = (seen: Recorded[]): HotkeyAction[] => seen.map((r) => r.action);

describe("keyLabel", () => {
  it("names a key the way the HUD prints it", () => {
    expect(keyLabel("KeyA")).toBe("A");
    expect(keyLabel("Digit4")).toBe("4");
    expect(keyLabel("Numpad3")).toBe("Num 3");
    expect(keyLabel("ArrowUp")).toBe("↑");
    expect(keyLabel("Escape")).toBe("Esc");
    expect(keyLabel("Equal")).toBe("+");
    // An unmapped code is shown verbatim rather than guessed at.
    expect(keyLabel("F7")).toBe("F7");
  });
});

describe("the cascade", () => {
  it("offers the actions of a code in a fixed, documented order", () => {
    // `A` is a Terran marine, "select all army" and "pan left", in that order.
    const { hotkeys, seen } = manager(() => false, { race: "terran" });

    hotkeys.handle(keyEvent("keydown", "KeyA"));

    expect(actions(seen)).toEqual(["build:marine", "select_army", "camera_left"]);
  });

  it("stops at the first action the game can actually perform", () => {
    const { hotkeys, seen } = manager((action) => action === "select_army", { race: "terran" });

    const claimed = hotkeys.handle(keyEvent("keydown", "KeyA"));

    expect(claimed).toBe(true);
    expect(actions(seen)).toEqual(["build:marine", "select_army"]);
  });

  it("reaches the camera reading only because the game readings refused", () => {
    // Nothing selected and no producer: the HUD reading of `A` is the camera.
    const { hotkeys, seen } = manager((action) => action === "camera_left", { race: "terran" });

    hotkeys.handle(keyEvent("keydown", "KeyA"));

    expect(actions(seen)).toEqual(["build:marine", "select_army", "camera_left"]);
  });

  it("claims the key even when no action applied, so the browser default is swallowed", () => {
    const { hotkeys } = manager(() => false, { race: "terran" });

    expect(hotkeys.handle(keyEvent("keydown", "KeyA"))).toBe(true);
  });

  it("does not claim a code it has no binding for", () => {
    const { hotkeys, seen } = manager();

    expect(hotkeys.handle(keyEvent("keydown", "KeyQ"))).toBe(false);
    expect(seen).toEqual([]);
  });

  it("swallows auto-repeat so a held key cannot queue five marines a second", () => {
    const { hotkeys, seen } = manager();

    const claimed = hotkeys.handle(keyEvent("keydown", "KeyS", { repeat: true }));

    expect(claimed).toBe(true);
    expect(seen).toEqual([]);
  });

  it("treats ctrl+alt as a character, not a command", () => {
    const { hotkeys, seen } = manager();

    expect(hotkeys.handle(keyEvent("keydown", "KeyS", { ctrl: true, alt: true }))).toBe(false);
    expect(seen).toEqual([]);
  });

  it("stays out of the way while a text field owns the keyboard", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
      const { hotkeys, seen } = manager();
      expect(hotkeys.handle(keyEvent("keydown", "KeyS", { tag }))).toBe(false);
      expect(seen).toEqual([]);
    }
  });

  it("exposes exactly the camera actions as the ones that repeat on key-up", () => {
    // This set is what makes a key-up mean "stop panning" rather than "do it
    // again", so a game action leaking into it would double-fire on release.
    expect([...CAMERA_ACTIONS].sort()).toEqual([
      "camera_down",
      "camera_left",
      "camera_right",
      "camera_rotate_left",
      "camera_rotate_right",
      "camera_up",
      "zoom_in",
      "zoom_out",
    ]);
    expect(CAMERA_ACTIONS.has("select_army")).toBe(false);
    expect(CAMERA_ACTIONS.has("build:marine")).toBe(false);
  });

  it("fires the camera action again on key-up, and nothing else", () => {
    const { hotkeys, seen } = manager();

    const claimed = hotkeys.handle(keyEvent("keyup", "KeyA"));

    expect(claimed).toBe(true);
    expect(actions(seen)).toEqual(["camera_left"]);
    expect(seen[0]?.ctx.phase).toBe("up");
  });

  it("fires no camera action on key-up for a code that has none", () => {
    const { hotkeys, seen } = manager();

    hotkeys.handle(keyEvent("keyup", "KeyH"));

    expect(seen).toEqual([]);
  });
});

describe("control groups", () => {
  it("recalls on a digit, adds on shift and assigns on ctrl", () => {
    const { hotkeys, seen } = manager();

    hotkeys.handle(keyEvent("keydown", "Digit4"));
    hotkeys.handle(keyEvent("keydown", "Numpad4", { shift: true }));
    hotkeys.handle(keyEvent("keydown", "Digit4", { ctrl: true }));

    expect(actions(seen)).toEqual(["recall_group", "add_to_group", "assign_group"]);
    expect(seen.map((r) => r.ctx.group)).toEqual([4, 4, 4]);
  });

  it("also centres the group on a second tap inside the window", () => {
    let clock = 1000;
    const { hotkeys, seen } = manager(() => true, { now: () => clock });

    hotkeys.handle(keyEvent("keydown", "Digit5"));
    clock += GROUP_DOUBLE_TAP_MS - 1;
    hotkeys.handle(keyEvent("keydown", "Digit5"));

    expect(actions(seen)).toEqual(["recall_group", "recall_group", "centre_group"]);
  });

  it("does not centre the group when the second tap is too late", () => {
    let clock = 1000;
    const { hotkeys, seen } = manager(() => true, { now: () => clock });

    hotkeys.handle(keyEvent("keydown", "Digit5"));
    clock += GROUP_DOUBLE_TAP_MS + 1;
    hotkeys.handle(keyEvent("keydown", "Digit5"));

    expect(actions(seen)).toEqual(["recall_group", "recall_group"]);
  });

  it("claims a digit key on repeat and on release without acting", () => {
    const { hotkeys, seen } = manager();

    expect(hotkeys.handle(keyEvent("keydown", "Digit2", { repeat: true }))).toBe(true);
    expect(hotkeys.handle(keyEvent("keyup", "Digit2"))).toBe(true);
    expect(seen).toEqual([]);
  });

  it("does not read a two-character numpad name as a group", () => {
    const { hotkeys, seen } = manager();

    expect(hotkeys.handle(keyEvent("keydown", "Numpad12"))).toBe(false);
    expect(seen).toEqual([]);
  });

  it("counts five units when shift is held, one otherwise", () => {
    const { hotkeys, seen } = manager();

    hotkeys.handle(keyEvent("keydown", "KeyA"));
    hotkeys.handle(keyEvent("keydown", "KeyA", { shift: true }));

    expect(seen.map((r) => r.ctx.count)).toEqual([1, 5]);
  });
});

describe("roster letters come from game data", () => {
  it("binds a build action for every single-letter hotkey in the roster", () => {
    const { hotkeys } = manager(undefined, { race: "terran" });
    const roster = [...raceData("terran").units, ...raceData("terran").buildings];

    for (const def of roster) {
      if (!def.hotkey || def.hotkey.length !== 1) continue;
      // Terran's marine letter is also "select army", so the build action is
      // first in the list, not the only entry.
      expect(hotkeys.bindings.get(`Key${def.hotkey.toUpperCase()}`)?.[0]).toBe(`build:${def.key}`);
    }
  });

  it("follows a data change rather than a hand-typed list", () => {
    const marine = raceData("terran").units.find((u) => u.key === "marine");
    if (!marine?.hotkey) throw new Error("marine lost its hotkey in the data");
    const original = marine.hotkey;
    try {
      marine.hotkey = "J";
      const { hotkeys } = manager(undefined, { race: "terran" });

      expect(hotkeys.bindings.get("KeyJ")?.[0]).toBe("build:marine");
      expect(hotkeys.bindings.get("KeyA")?.[0]).not.toBe("build:marine");
    } finally {
      marine.hotkey = original;
    }
  });

  it("moves the letters when the player's race changes", () => {
    const { hotkeys } = manager(undefined, { race: "terran" });

    hotkeys.setRace("protoss");

    expect(hotkeys.bindings.get("KeyA")?.[0]).not.toBe("build:marine");
    expect(
      [...hotkeys.bindings.values()].flat().some((a) => a === "build:zealot"),
    ).toBe(true);
  });

  it("binds no letters at all when the race is unknown", () => {
    const { hotkeys } = manager();

    expect([...hotkeys.bindings.values()].flat().some((a) => a.startsWith("build:"))).toBe(false);
  });

  it("asks for the race on the first keypress and can never act on a stale one", () => {
    const { hotkeys, seen } = manager(() => true, {
      resolveRace: () => "terran",
    });

    hotkeys.handle(keyEvent("keydown", "KeyA"));

    expect(actions(seen)[0]).toBe("build:marine");
  });

  it("keeps the stock non-roster bindings while dropping only the roster letters", () => {
    const { hotkeys } = manager(undefined, { race: "terran" });

    hotkeys.setRace(null);

    expect(hotkeys.bindings.get("KeyS")).toEqual(["stop", "camera_down"]);
    expect([...hotkeys.bindings.values()].flat().some((a) => a.startsWith("build:"))).toBe(false);
  });
});

describe("placement mode", () => {
  it("routes a roster letter to the ghost instead of ordering a unit", () => {
    const { hotkeys, seen } = manager(() => true, { race: "terran" });
    hotkeys.setPlacementMode(true);

    hotkeys.handle(keyEvent("keydown", "KeyA"));

    expect(actions(seen)).toEqual(["placement_key"]);
    expect(seen[0]?.ctx.entity).toBe("marine");
  });

  it("hands the emitter the entity so a building letter can swap the ghost", () => {
    const { hotkeys, seen } = manager(() => true, { race: "terran" });
    hotkeys.setPlacementMode(true);

    hotkeys.handle(keyEvent("keydown", "KeyB"));

    expect(actions(seen)).toEqual(["placement_key"]);
    expect(seen[0]?.ctx.entity).toBe("command_center");
  });

  it("falls through to the next action when the ghost refuses the confirmation", () => {
    const { hotkeys, seen } = manager(
      (action) => action !== "placement_key",
      { race: "terran" },
    );
    hotkeys.setPlacementMode(true);

    hotkeys.handle(keyEvent("keydown", "KeyA"));

    expect(actions(seen)).toEqual(["placement_key", "select_army"]);
  });

  it("leaves non-roster keys alone while a ghost is up", () => {
    const { hotkeys, seen } = manager(() => true, { race: "terran" });
    hotkeys.setPlacementMode(true);

    hotkeys.handle(keyEvent("keydown", "Escape"));

    expect(actions(seen)).toEqual(["cancel"]);
  });

  it("reports the placement mode so the UI can suppress the train hints", () => {
    const { hotkeys } = manager(undefined, { race: "terran" });

    expect(hotkeys.placementMode).toBe(false);
    hotkeys.setPlacementMode(true);
    expect(hotkeys.placementMode).toBe(true);
  });
});

describe("rebinding", () => {
  it("moves an action to the new code and frees the old one", () => {
    const { hotkeys, seen } = manager();

    hotkeys.bind("stop", "KeyZ");
    hotkeys.handle(keyEvent("keydown", "KeyZ"));

    expect(actions(seen)).toEqual(["stop"]);
    expect(hotkeys.bindings.get("KeyS")).toEqual(["camera_down"]);
  });

  it("puts a rebound action first on the code that already had meaning", () => {
    const { hotkeys, seen } = manager();

    hotkeys.bind("stop", "KeyA");
    hotkeys.handle(keyEvent("keydown", "KeyA"));

    // Without the rebuild, `A` would have selected the army first.
    expect(actions(seen)).toEqual(["stop"]);
  });

  it("drops a code entirely when rebinding takes its last action", () => {
    const { hotkeys } = manager();

    hotkeys.bind("hold", "KeyZ");

    expect(hotkeys.bindings.has("KeyH")).toBe(false);
    expect(hotkeys.handle(keyEvent("keydown", "KeyH"))).toBe(false);
  });

  it("unbinds a whole code on request", () => {
    const { hotkeys, seen } = manager();

    hotkeys.unbind("KeyH");
    hotkeys.handle(keyEvent("keydown", "KeyH"));

    expect(seen).toEqual([]);
    expect(hotkeys.handle(keyEvent("keydown", "KeyH"))).toBe(false);
  });

  it("restores the stock scheme, roster letters included", () => {
    const { hotkeys } = manager(undefined, { race: "terran" });

    hotkeys.bind("stop", "KeyZ");
    hotkeys.resetBindings();

    expect(hotkeys.bindings.get("KeyS")).toEqual(["stop", "camera_down"]);
    expect(hotkeys.bindings.get("KeyA")?.[0]).toBe("build:marine");
  });
});

describe("the reference the settings screen renders", () => {
  it("lists one row per action with every key bound to it, labelled", () => {
    const { hotkeys } = manager(undefined, { race: "terran" });
    hotkeys.bind("stop", "KeyZ");

    const rows = hotkeys.actionsForDisplay();
    const stop = rows.find((r) => r.action === "stop");

    // A rebind moves the action, so the HUD must stop advertising the old key.
    expect(stop?.keys).toEqual(["Z"]);
    expect(rows.find((r) => r.action === "select_army")?.keys).toEqual(["A"]);
    expect(rows.find((r) => r.action === "camera_left")?.keys).toEqual(["A", "←"]);
    // Sorted by action, so the reference does not reshuffle between frames.
    expect(rows.map((r) => r.action)).toEqual([...rows.map((r) => r.action)].sort());
  });

  it("stops acting once disposed", () => {
    const { hotkeys, seen } = manager();

    hotkeys.dispose();
    const claimed = hotkeys.handle(keyEvent("keydown", "KeyS"));

    expect(claimed).toBe(false);
    expect(seen).toEqual([]);
  });
});

describe("the data the bindings are derived from", () => {
  it("covers both Terran units and buildings, so a new roster entry needs no code change", () => {
    const { hotkeys } = manager(undefined, { race: "terran" });
    const letters = new Set(
      [...hotkeys.bindings.values()].flat().filter((a) => a.startsWith("build:")).map((a) => a.slice(6)),
    );

    for (const key of [...raceData("terran").units, ...raceData("terran").buildings]) {
      expect(letters.has(key.key), `${key.key} has no build hotkey`).toBe(true);
    }
    // Nothing is bound that the roster does not define.
    for (const letter of letters) {
      expect(GAME.units[letter], `${letter} is bound but absent from the data`).toBeDefined();
    }
  });
});
