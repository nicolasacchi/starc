/**
 * Shared contracts for the hand-written DOM front end.
 *
 * Two jobs live here:
 *   1. the types every screen agrees on (buttons, hosts, callbacks, readouts);
 *   2. a very small DOM helper kit (`el`, `listen`, `button`, `field`, …) so the
 *      eight screen modules do not each invent their own element factory.
 *
 * Nothing in this file touches `document` at module scope or inside a
 * constructor — every helper takes the `Document` explicitly, which is taken
 * from the element passed to `mount()`. That keeps the screens constructible
 * under a headless Vitest run (`environment: "node"`, no jsdom).
 */
import { GAME, raceColor } from "@shared/gameData";
import type { Race } from "@shared/protocol";

/* ------------------------------------------------------------------ */
/* Screen contracts                                                    */
/* ------------------------------------------------------------------ */

export type ScreenName = "menu" | "lobby" | "game" | "result";

export interface UiButton {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "ghost" | "danger";
}

export interface UiHost {
  show(screen: ScreenName): void;
  notify(message: string, kind?: "info" | "warn" | "error"): void;
}

export interface HudCallbacks {
  /** A command-card ability slot was activated. */
  onAbility(abilityKey: string): void;
  /** Cancel the production of the entity with this id. */
  onCancelProduction(buildingId: number): void;
  /** Arm "click the world to set a rally point" for this building. */
  onSetRally(buildingId: number): void;
  onHotkeyHelp(): void;
  onMenu(): void;
  /** Optional extras — a host that ignores them keeps the same widget. */
  /** A command-card train slot was activated; falls back to `onAbility`. */
  onTrain?(unitType: string): void;
  /** The command-card page selector moved. */
  onPage?(page: number): void;
  /** A selection portrait was clicked (primary selection). */
  onSelectEntity?(entityId: number): void;
  /** A resource chip was clicked (jump to the main base). */
  onSelectWorker?(entityId: number): void;
}

/* ------------------------------------------------------------------ */
/* Readouts shared between the HUD and the inspector                   */
/* ------------------------------------------------------------------ */

export type AlertKind = "info" | "warn" | "error";

/** The signed-in account, as shown in the menu, lobby header and result. */
export interface AccountSummary {
  name: string;
  rating: number;
  wins: number;
  losses: number;
}

/** Resource totals; `blocked` is true when the supply cap is hit. */
export interface SupplyReadout {
  used: number;
  cap: number;
  blocked: boolean;
}

/** One command-card slot (an ability or a trainable unit). */
export interface CommandSlot {
  /** Ability key, or the roster key of the unit to train. */
  key: string;
  label: string;
  /** Roster key used to pick the icon. */
  icon: string;
  kind: "ability" | "train";
  hotkey?: string;
  disabled?: boolean;
  /** Reason shown in the tooltip when `disabled`. */
  reason?: string;
  minerals?: number;
  vespene?: number;
  supply?: number;
  /** 0..1 — build/upgrade progress drawn as a sweep over the icon. */
  progress?: number;
  /** Seconds left on the cooldown, and the cooldown's full length. */
  cooldown?: number;
  cooldownTotal?: number;
}

/** One row of a production queue. */
export interface QueueItem {
  /** Id of the building producing it — the cancel target. */
  entityId: number;
  /** Roster key being produced. */
  type: string;
  label: string;
  /** 0..1 */
  progress: number;
  /** Seconds remaining. */
  remaining: number;
  cancellable: boolean;
}

/** A dot on the minimap. */
export interface MinimapBlip {
  id: number;
  x: number;
  z: number;
  relation: "own" | "ally" | "enemy" | "neutral";
  kind: "unit" | "building";
  selected?: boolean;
}

/* ------------------------------------------------------------------ */
/* Roster lookups the UI needs (never a hard-coded stat)               */
/* ------------------------------------------------------------------ */

let raceByKey: Map<string, Race> | null = null;

/** Which race a roster key belongs to, or null for an unknown key. */
export function raceOf(key: string): Race | null {
  if (raceByKey === null) {
    raceByKey = new Map();
    for (const [race, keys] of Object.entries(GAME.race_index)) {
      for (const rosterKey of keys) raceByKey.set(rosterKey, race as Race);
    }
  }
  return raceByKey.get(key) ?? null;
}

/** The roster colour for a race — the one source for the UI tint. */
export function accentFor(race: Race | null): string {
  return race === null ? "var(--text-dim)" : raceColor(race);
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function fmtInt(value: number): string {
  const rounded = Math.round(value);
  return Number.isFinite(rounded) ? rounded.toLocaleString("en-US") : "0";
}

export function fmtCompact(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 100_000) return `${Math.round(value / 1000)}k`;
  if (abs >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  return fmtInt(value);
}

export function fmtSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.ceil(seconds)}s`;
}

export function fmtClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function clamp01(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  return fraction >= 1 ? 1 : fraction;
}

/* ------------------------------------------------------------------ */
/* Teardown — every listener, timer and node the UI allocates is       */
/* registered here and released by `dispose()`.                         */
/* ------------------------------------------------------------------ */

export class Teardown {
  private fns: (() => void)[] = [];
  private done = false;

  get disposed(): boolean {
    return this.done;
  }

  /** Registers a release function; runs it immediately if already disposed. */
  add(fn: () => void): void {
    if (this.done) {
      fn();
      return;
    }
    this.fns.push(fn);
  }

  dispose(): void {
    if (this.done) return;
    this.done = true;
    for (let i = this.fns.length - 1; i >= 0; i -= 1) {
      try {
        this.fns[i]();
      } catch {
        // Teardown is best effort: one broken listener must not strand the rest.
      }
    }
    this.fns.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/* DOM kit                                                             */
/* ------------------------------------------------------------------ */

/** The document that owns a mounted element. Throws when there is no DOM. */
export function docOf(root: HTMLElement): Document {
  const doc = root.ownerDocument ?? (typeof document === "undefined" ? null : document);
  if (doc === null) {
    throw new Error("STARC UI: mount() needs a DOM element — no document is available in this environment");
  }
  return doc;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Removes every child; `removeChild` is the universally implemented path. */
export function clear(node: Node): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

export function listen(
  target: EventTarget,
  type: string,
  handler: (ev: Event) => void,
  teardown?: Teardown,
): () => void {
  const wrapped = (ev: Event): void => handler(ev);
  target.addEventListener(type, wrapped);
  const off = (): void => target.removeEventListener(type, wrapped);
  if (teardown) teardown.add(off);
  return off;
}

/** Builds a `<button>` from a `UiButton` spec. */
export function button(doc: Document, spec: UiButton, teardown?: Teardown): HTMLButtonElement {
  const node = el(doc, "button", `btn btn--${spec.variant ?? "ghost"}`, spec.label);
  node.type = "button";
  node.disabled = spec.disabled === true;
  listen(
    node,
    "click",
    () => {
      if (!node.disabled) spec.onClick();
    },
    teardown,
  );
  return node;
}

export interface FieldRefs {
  row: HTMLDivElement;
  input: HTMLInputElement;
  error: HTMLParagraphElement;
}

export interface FieldSpec {
  id: string;
  label: string;
  type?: string;
  placeholder?: string;
  value?: string;
  autocomplete?: string;
  maxLength?: number;
  hint?: string;
}

/** A labelled text input with an inline error slot underneath. */
export function field(doc: Document, spec: FieldSpec, teardown?: Teardown): FieldRefs {
  const row = el(doc, "div", "field");
  const id = `sc-${spec.id}`;
  const label = el(doc, "label", "field__label", spec.label);
  label.htmlFor = id;
  const input = el(doc, "input", "field__input");
  input.id = id;
  input.type = spec.type ?? "text";
  input.autocomplete = spec.autocomplete ?? "off";
  input.spellcheck = false;
  if (spec.placeholder !== undefined) input.placeholder = spec.placeholder;
  if (spec.value !== undefined) input.value = spec.value;
  if (spec.maxLength !== undefined) input.maxLength = spec.maxLength;
  if (spec.hint !== undefined) input.title = spec.hint;
  const error = el(doc, "p", "field__error");
  error.id = `${id}-error`;
  input.setAttribute("aria-describedby", error.id);
  row.append(label, input, error);
  if (teardown) {
    teardown.add(() => {
      label.htmlFor = "";
    });
  }
  return { row, input, error };
}

export interface SelectSpec<T extends string> {
  className?: string;
  value?: T;
  ariaLabel?: string;
  onChange: (value: T) => void;
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

/** A `<select>` wired to `onChange`; returns the element for later patching. */
export function select<T extends string>(
  doc: Document,
  spec: SelectSpec<T>,
  options: readonly SelectOption<T>[],
  teardown?: Teardown,
): HTMLSelectElement {
  const node = el(doc, "select", spec.className ?? "field__input");
  if (spec.ariaLabel !== undefined) node.setAttribute("aria-label", spec.ariaLabel);
  for (const option of options) {
    const node_option = el(doc, "option", undefined, option.label);
    node_option.value = option.value;
    node.append(node_option);
  }
  if (spec.value !== undefined) node.value = spec.value;
  listen(
    node,
    "change",
    () => {
      spec.onChange(node.value as T);
    },
    teardown,
  );
  return node;
}

export interface CheckboxRefs {
  row: HTMLLabelElement;
  input: HTMLInputElement;
}

export function checkbox(
  doc: Document,
  labelText: string,
  checked: boolean,
  onChange: (value: boolean) => void,
  teardown?: Teardown,
): CheckboxRefs {
  const row = el(doc, "label", "check");
  const input = el(doc, "input", "check__input");
  input.type = "checkbox";
  input.checked = checked;
  listen(
    input,
    "change",
    () => onChange(input.checked),
    teardown,
  );
  const text = el(doc, "span", "check__label", labelText);
  row.append(input, text);
  return { row, input };
}

export interface Meter {
  root: HTMLDivElement;
  fill: HTMLDivElement;
  set(fraction: number, label?: string): void;
}

/** A horizontal bar. `set` clamps, and re-uses the node (no churn per frame). */
export function meter(doc: Document, className: string, tone?: string): Meter {
  const root = el(doc, "div", `meter ${className}`);
  const fill = el(doc, "div", tone === undefined ? "meter__fill" : `meter__fill meter__fill--${tone}`);
  root.append(fill);
  let lastLabel: string | null = null;
  return {
    root,
    fill,
    set(fraction: number, label?: string): void {
      fill.style.width = `${(clamp01(fraction) * 100).toFixed(1)}%`;
      if (label !== undefined && label !== lastLabel) {
        lastLabel = label;
        fill.textContent = label;
      }
    },
  };
}

/** A small uppercase key badge (hotkeys, page dots, resource caps). */
export function keyBadge(doc: Document, key: string, className = "keycap"): HTMLSpanElement {
  return el(doc, "span", className, key);
}

/** `require`-free clamp of a child count into a grid of `columns` per row. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const step = Math.max(1, size);
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}
