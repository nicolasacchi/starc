/**
 * Worker build list.
 *
 * Everything it shows is read from the roster: `buildableWith(building, race)`
 * gives the options, each `cost` and `required_buildings` drives the
 * affordability and prerequisite state, and the hotkey comes off the def. No
 * list of "buildable things" is written by hand anywhere.
 */
import { buildableWith, displayName, hasEntityDef } from "@shared/gameData";
import type { EntityDef, Race } from "@shared/protocol";
import { entityIcon } from "./icons";
import type { Meter } from "./uiTypes";
import { Teardown, clear, docOf, el, fmtInt, keyBadge, listen, meter } from "./uiTypes";

export interface BuildMenuOptions {
  /** The player chose something to place; the host arms a build order. */
  onBeginPlacement(unitType: string): void;
  /** Optional: right-click / alt-click a row to inspect it. */
  onInspect?(unitType: string): void;
}

interface Row {
  def: EntityDef;
  node: HTMLButtonElement;
  reason: HTMLElement;
  minerals: Meter;
  vespene: Meter;
  missing: readonly string[];
}

const TIER_LABEL: Record<number, string> = {
  0: "Tier 0 · Core",
  1: "Tier 1",
  2: "Tier 2",
  3: "Tier 3",
  4: "Tier 4",
};

export class BuildMenu {
  private readonly teardown = new Teardown();
  private readonly opts: BuildMenuOptions;
  private doc: Document | null = null;
  private root: HTMLElement | null = null;
  private title: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private rows: Row[] = [];
  private buildingKey: string | null = null;
  private race: Race = "terran";
  private minerals = 0;
  private vespene = 0;
  private owned = new Set<string>();

  constructor(options: BuildMenuOptions) {
    this.opts = options;
  }

  mount(root: HTMLElement): void {
    const doc = docOf(root);
    this.doc = doc;
    const panel = el(doc, "aside", "panel build");
    const head = el(doc, "header", "build__head");
    const title = el(doc, "h2", "build__title", "Build");
    const hint = el(doc, "p", "build__hint", "Pick a structure, then click the ground.");
    head.append(title, hint);
    const list = el(doc, "div", "build__list");
    panel.append(head, list);
    clear(root);
    root.append(panel);
    this.root = panel;
    this.title = title;
    this.list = list;
    this.teardown.add(() => {
      if (panel.parentNode !== null) panel.parentNode.removeChild(panel);
      this.root = null;
      this.rows = [];
    });
    panel.hidden = true;
  }

  /** Shows everything this building (and race) can produce. */
  show(buildingKey: string, race: Race): void {
    this.buildingKey = buildingKey;
    this.race = race;
    this.render();
  }

  hide(): void {
    if (this.root !== null) this.root.hidden = true;
  }

  setResources(minerals: number, vespene: number): void {
    this.minerals = minerals;
    this.vespene = vespene;
    this.refresh();
  }

  /** Roster keys of every standing structure the player owns. */
  setOwnedBuildingKeys(keys: Iterable<string>): void {
    this.owned = new Set(keys);
    this.refresh();
  }

  /** Re-evaluates affordability and prerequisites in place. */
  refresh(): void {
    for (const row of this.rows) this.paintRow(row);
  }

  dispose(): void {
    this.teardown.dispose();
    this.doc = null;
  }

  /* ------------------------------------------------------------------ */

  private render(): void {
    const doc = this.doc;
    const list = this.list;
    const root = this.root;
    if (doc === null || list === null || root === null) return;
    if (this.buildingKey === null || !hasEntityDef(this.buildingKey)) {
      root.hidden = true;
      this.rows = [];
      return;
    }
    const defs = buildableWith(this.buildingKey, this.race);
    clear(list);
    this.rows = [];
    if (this.title !== null) this.title.textContent = `Build · ${displayName(this.buildingKey)}`;
    if (defs.length === 0) {
      list.append(el(doc, "p", "build__empty", "This structure produces nothing."));
      root.hidden = false;
      return;
    }
    const groups = new Map<number, EntityDef[]>();
    for (const def of defs) {
      const tier = def.tier ?? 1;
      const bucket = groups.get(tier);
      if (bucket === undefined) groups.set(tier, [def]);
      else bucket.push(def);
    }
    for (const tier of [...groups.keys()].sort((a, b) => a - b)) {
      const group = el(doc, "div", "build__group");
      group.append(el(doc, "h3", "build__grouptitle", TIER_LABEL[tier] ?? `Tier ${tier}`));
      const grid = el(doc, "div", "build__grid");
      for (const def of groups.get(tier) ?? []) grid.append(this.renderRow(doc, def));
      group.append(grid);
      list.append(group);
    }
    root.hidden = false;
  }

  private renderRow(doc: Document, def: EntityDef): HTMLButtonElement {
    const node = el(doc, "button", "build__item");
    node.type = "button";
    const cost = def.cost;
    const nodeIcon = el(doc, "span", "build__icon");
    nodeIcon.append(entityIcon(def.key, 34));
    const name = el(doc, "span", "build__name", displayName(def.key));
    const hotkey = def.hotkey === undefined ? null : keyBadge(doc, def.hotkey, "keycap keycap--sm");
    const minerals = meter(doc, "meter--mini", "mineral");
    const vespene = meter(doc, "meter--mini", "vespene");
    const supplyLabel = el(doc, "span", "build__supply", cost.supply > 0 ? `+${cost.supply}` : "—");
    const reason = el(doc, "span", "build__reason");
    const body = el(doc, "span", "build__body");
    const head = el(doc, "span", "build__rowhead");
    head.append(name, supplyLabel);
    if (hotkey !== null) head.append(hotkey);
    const costRow = el(doc, "span", "build__costs");
    costRow.append(minerals.root, vespene.root);
    body.append(head, costRow, reason);
    node.append(nodeIcon, body);

    const row: Row = {
      def,
      node,
      reason,
      minerals,
      vespene,
      missing: def.required_buildings ?? [],
    };
    this.rows.push(row);
    this.paintRow(row);
    listen(
      node,
      "click",
      () => {
        if (node.disabled) return;
        this.opts.onBeginPlacement(def.key);
      },
      this.teardown,
    );
    listen(
      node,
      "contextmenu",
      (ev) => {
        if (this.opts.onInspect === undefined) return;
        ev.preventDefault();
        this.opts.onInspect(def.key);
      },
      this.teardown,
    );
    return node;
  }

  private paintRow(row: Row): void {
    const cost = row.def.cost;
    const affordable = this.minerals >= cost.minerals && this.vespene >= cost.vespene;
    const missing = row.missing.filter((key) => !this.owned.has(key));
    const ready = affordable && missing.length === 0;
    row.node.disabled = !ready;
    row.node.classList.toggle("is-locked", missing.length > 0);
    row.node.classList.toggle("is-poor", !affordable);
    row.minerals.set(cost.minerals > 0 ? this.minerals / cost.minerals : 1, cost.minerals > 0 ? fmtInt(cost.minerals) : "");
    row.vespene.set(cost.vespene > 0 ? this.vespene / cost.vespene : 1, cost.vespene > 0 ? fmtInt(cost.vespene) : "");
    let reason = "";
    if (missing.length > 0) {
      const names = missing.map((key) => (hasEntityDef(key) ? displayName(key) : key));
      reason = `Needs ${names.join(", ")}`;
    } else if (!affordable) {
      reason = "Not enough resources";
    }
    if (row.reason.textContent !== reason) row.reason.textContent = reason;
    const title = `${displayName(row.def.key)} — ${cost.minerals}m ${cost.vespene}v${cost.supply > 0 ? ` · ${cost.supply} supply` : ""}`;
    if (row.node.title !== title) row.node.title = title;
  }
}

