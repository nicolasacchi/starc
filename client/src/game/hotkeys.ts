/**
 * Hotkeys — the StarCraft control scheme, bound to `KeyboardEvent.code` so the
 * bindings survive a Dvorak layout.
 *
 * Two things make this more than a lookup table:
 *
 *  - **Cascades.** Letters are double-booked on purpose: `A` is both the marine
 *    hotkey and "select all army" and "pan left". A code maps to an *ordered*
 *    list of actions and the emitter returns whether it handled one; the first
 *    action the game can actually perform wins, otherwise the next candidate
 *    is tried. Holding a barracks and pressing `A` trains a marine; holding
 *    nothing and pressing `A` selects the army; doing either while the cursor
 *    is over the HUD pans the camera.
 *  - **Roster-driven builds.** Train/build letters come from
 *    `game-data.json`, never a hand-typed list, so a data change is enough.
 */
import { raceData } from "@shared/gameData";
import type { Race } from "@shared/protocol";

/** Two taps of the same group key inside this window re-centres the camera. */
export const GROUP_DOUBLE_TAP_MS = 400;

export type HotkeyAction =
  | "select_army"
  | "stop"
  | "hold"
  | "patrol"
  | "assign_group"
  | "add_to_group"
  | "recall_group"
  | "centre_group"
  | "cancel"
  | "cycle_subgroup"
  | "camera_left"
  | "camera_right"
  | "camera_up"
  | "camera_down"
  | "camera_rotate_left"
  | "camera_rotate_right"
  | "zoom_in"
  | "zoom_out"
  | "placement_key"
  | `build:${string}`;

/** Every action a code offers, in the order they are attempted. */
const DEFAULT_BINDINGS: Readonly<Record<string, readonly string[]>> = {
  KeyA: ["select_army", "camera_left"],
  KeyS: ["stop", "camera_down"],
  KeyH: ["hold"],
  KeyP: ["patrol"],
  KeyW: ["camera_up"],
  KeyD: ["camera_right"],
  Comma: ["camera_rotate_left"],
  Period: ["camera_rotate_right"],
  Equal: ["zoom_in"],
  Minus: ["zoom_out"],
  NumpadAdd: ["zoom_in"],
  NumpadSubtract: ["zoom_out"],
  ArrowUp: ["camera_up"],
  ArrowDown: ["camera_down"],
  ArrowLeft: ["camera_left"],
  ArrowRight: ["camera_right"],
  Escape: ["cancel"],
  Tab: ["cycle_subgroup"],
};

/** Actions that mean "the camera moved" — these also fire on key-up. */
export const CAMERA_ACTIONS: ReadonlySet<HotkeyAction> = new Set<HotkeyAction>([
  "camera_left",
  "camera_right",
  "camera_up",
  "camera_down",
  "camera_rotate_left",
  "camera_rotate_right",
  "zoom_in",
  "zoom_out",
]);

const KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Equal: "+",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Escape: "Esc",
  Tab: "Tab",
  Space: "Space",
  Enter: "Enter",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num -",
};

/** `KeyA` → `A`, `Numpad3` → `Num 3`, `ArrowUp` → `↑`. */
export function keyLabel(code: string): string {
  const literal = KEY_LABELS[code];
  if (literal !== undefined) return literal;
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

export interface HotkeyContext {
  /** The event that produced this, for callers that need the raw modifiers. */
  event: KeyboardEvent;
  code: string;
  phase: "down" | "up";
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** 0-9 for the control-group actions. */
  group: number | null;
  /** Roster entity key behind a `build:*` / `placement_key` action. */
  entity: string | null;
  /** Units to produce: 5 when shift is held, otherwise 1. */
  count: number;
}

/**
 * Returns true when the action was actually performed. False lets the next
 * candidate for the same key have a go — that is the whole cascade.
 */
export type HotkeyEmitter = (action: HotkeyAction, ctx: HotkeyContext) => boolean;

export interface HotkeyOptions {
  /** Race whose roster supplies the train/build letters. */
  race?: Race;
  /**
   * Consulted on the first keypress when no race is known yet. A caller that
   * only holds a snapshot can look the race up from the first entity that
   * belongs to us, which is why the letters can never be stale.
   */
  resolveRace?: () => Race | null;
  /** Clock for the group double-tap window; defaults to the event timestamp. */
  now?: () => number;
  /** Extra veto, e.g. "a chat box has focus". */
  ignore?: (event: KeyboardEvent) => boolean;
}

/** `Digit4` and `Numpad4` both mean control group 4; anything else is null. */
function digitOf(code: string): number | null {
  const index = code.startsWith("Digit") ? 5 : code.startsWith("Numpad") ? 6 : -1;
  if (index < 0 || code.length !== index + 1) return null;
  const digit = code.charCodeAt(index) - 48;
  return digit >= 0 && digit <= 9 ? digit : null;
}

export class HotkeyManager {
  /**
   * Physical key code → the actions it may trigger, most specific first. The
   * UI rewrites this table directly when the player rebinds a key.
   */
  readonly bindings = new Map<string, HotkeyAction[]>();

  private readonly emitter: HotkeyEmitter;
  private readonly opts: HotkeyOptions;
  private readonly lastGroupTap = new Map<number, number>();
  private race: Race | null = null;
  private placing = false;
  private disposed = false;

  constructor(emitter: HotkeyEmitter, opts: HotkeyOptions = {}) {
    this.emitter = emitter;
    this.opts = opts;
    this.race = opts.race ?? null;
    this.resetBindings();
  }

  /** True while a building ghost is following the cursor. */
  get placementMode(): boolean {
    return this.placing;
  }

  /**
   * Feeds one key transition. Returns true when the key was claimed — callers
   * should `preventDefault()` and swallow it so the browser's own shortcuts
   * (ctrl+W closing the tab, Tab moving focus) do not fire.
   */
  handle(event: KeyboardEvent): boolean {
    if (this.disposed) return false;
    // AltGr on European layouts reports as ctrl+alt; that is a character, not
    // a command.
    if (event.ctrlKey && event.altKey) return false;
    if (this.opts.ignore?.(event) === true) return false;
    if (this.targetIsTextEntry(event)) return false;

    if (this.race === null && this.opts.resolveRace) {
      const race = this.opts.resolveRace();
      if (race) this.setRace(race);
    }

    const group = digitOf(event.code);
    if (group !== null) {
      if (event.type === "keyup" || event.repeat) return true;
      this.handleGroup(group, event);
      return true;
    }

    const actions = this.bindings.get(event.code);
    if (!actions || actions.length === 0) return false;
    const ctx = this.context(event, null);

    if (event.type === "keyup") {
      // Only the camera cares about a release; everything else already fired.
      const camera = actions.find((a) => CAMERA_ACTIONS.has(a));
      if (camera) this.emitter(camera, ctx);
      return true;
    }
    // Auto-repeat would queue five marines a second; a held key is already
    // registered, and the camera is driven by its own frame loop.
    if (event.repeat) return true;

    for (const action of actions) {
      if (this.placing && action.startsWith("build:")) {
        // A pending ghost swallows the train hotkeys: the key confirms the
        // placement instead of ordering a unit.
        if (this.emitter("placement_key", { ...ctx, entity: action.slice(6) })) return true;
        continue;
      }
      if (this.emitter(action, ctx)) return true;
    }
    return true;
  }

  /** Binds an action to a code, making it that key's first-choice action. */
  bind(action: HotkeyAction, code: string): void {
    for (const [otherCode, actions] of this.bindings) {
      const at = actions.indexOf(action);
      if (at >= 0) actions.splice(at, 1);
      if (otherCode !== code && actions.length === 0) this.bindings.delete(otherCode);
    }
    const list = this.bindings.get(code);
    if (list) list.unshift(action);
    else this.bindings.set(code, [action]);
  }

  /** Drops every action bound to a code. */
  unbind(code: string): void {
    this.bindings.delete(code);
  }

  /** Restores the stock scheme, including the roster letters for the race. */
  resetBindings(): void {
    this.bindings.clear();
    for (const [code, actions] of Object.entries(DEFAULT_BINDINGS)) {
      this.bindings.set(code, [...actions] as HotkeyAction[]);
    }
    this.applyRosterLetters();
  }

  /** Swaps the race whose units and buildings own the letter keys. */
  setRace(race: Race | null): void {
    this.race = race;
    this.applyRosterLetters();
  }

  setPlacementMode(on: boolean): void {
    this.placing = on;
  }

  /** The hotkey reference the UI renders, one row per action. */
  actionsForDisplay(): { action: string; keys: string[] }[] {
    const byAction = new Map<string, Set<string>>();
    for (const [code, actions] of this.bindings) {
      for (const action of actions) {
        const keys = byAction.get(action);
        if (keys) keys.add(keyLabel(code));
        else byAction.set(action, new Set([keyLabel(code)]));
      }
    }
    return [...byAction.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([action, keys]) => ({ action, keys: [...keys].sort() }));
  }

  dispose(): void {
    this.disposed = true;
    this.bindings.clear();
    this.lastGroupTap.clear();
  }

  private handleGroup(group: number, event: KeyboardEvent): void {
    const ctx = this.context(event, group);
    if (event.ctrlKey) {
      this.emitter("assign_group", ctx);
      return;
    }
    if (event.shiftKey) {
      this.emitter("add_to_group", ctx);
      return;
    }
    const now = this.clock(event);
    const previous = this.lastGroupTap.get(group);
    const isDouble = previous !== undefined && now - previous <= GROUP_DOUBLE_TAP_MS;
    this.lastGroupTap.set(group, now);
    this.emitter("recall_group", ctx);
    if (isDouble) this.emitter("centre_group", ctx);
  }

  private context(event: KeyboardEvent, group: number | null): HotkeyContext {
    return {
      event,
      code: event.code,
      phase: event.type === "keyup" ? "up" : "down",
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
      group,
      entity: null,
      count: event.shiftKey ? 5 : 1,
    };
  }

  private clock(event: KeyboardEvent): number {
    if (this.opts.now) return this.opts.now();
    // Synthetic events (and hand-rolled test fakes) may carry no timestamp.
    return typeof event.timeStamp === "number" && event.timeStamp > 0 ? event.timeStamp : Date.now();
  }

  private targetIsTextEntry(event: KeyboardEvent): boolean {
    const target = event.target as { tagName?: string } | null | undefined;
    const tag = target?.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "OPTION";
  }

  /** Re-derives the train/build letters from the roster, first choice first. */
  private applyRosterLetters(): void {
    for (const [code, actions] of this.bindings) {
      const kept = actions.filter((a) => !a.startsWith("build:"));
      if (kept.length === 0) this.bindings.delete(code);
      else if (kept.length !== actions.length) this.bindings.set(code, kept);
    }
    if (!this.race) return;
    for (const def of [...raceData(this.race).units, ...raceData(this.race).buildings]) {
      const letter = def.hotkey;
      if (!letter || letter.length !== 1) continue;
      const action: HotkeyAction = `build:${def.key}`;
      const code = `Key${letter.toUpperCase()}`;
      const list = this.bindings.get(code);
      if (list) list.unshift(action);
      else this.bindings.set(code, [action]);
    }
  }
}
