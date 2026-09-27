/**
 * The in-game overlay.
 *
 * Layout is a 12-column grid (see styles.css):
 *   row 1  resource bar (cols 1–4) · match cluster (cols 9–12)
 *   row 2  alert feed (cols 1–4) · inspector (col 1, bottom aligned)
 *   row 3  minimap (cols 1–3) · command card (cols 4–9) · selection (cols 10–12)
 *
 * The HUD owns no game state: the host pushes resources, supply, selection,
 * command-card pages and the queue through the setters, and gets told what the
 * player pressed through `HudCallbacks`. Setters are idempotent and cheap, so
 * the host can call them on every snapshot.
 */
import { displayName, hasEntityDef } from "@shared/gameData";
import type { ProtocolEntity, Race } from "@shared/protocol";
import type { BuildMenu } from "./buildMenu";
import { entityIcon, resourceIcon } from "./icons";
import type { MinimapUi } from "./minimapUi";
import type { UnitPanel } from "./unitPanel";
import type { AlertKind, CommandSlot, HudCallbacks, Meter, QueueItem, SupplyReadout, TimerHandle } from "./uiTypes";
import { Teardown, button, clear, docOf, el, fmtInt, listen, meter, raceOf } from "./uiTypes";

export interface HudOptions {
  minimap?: MinimapUi;
  unitPanel?: UnitPanel;
  buildMenu?: BuildMenu;
  race?: Race;
}

export interface MatchInfo {
  mapName: string;
  mode: string;
  players: number;
}

interface SlotCard {
  node: HTMLButtonElement;
  sweep: HTMLElement;
  cost: HTMLElement;
  cooldown: HTMLElement;
}

const ALERT_LIMIT = 7;
const ALERT_TTL_MS = 6000;
const COMMAND_SLOTS = 9;

export class Hud {
  private readonly teardown = new Teardown();
  private readonly callbacks: HudCallbacks;
  private readonly children: { minimap?: MinimapUi; unitPanel?: UnitPanel; buildMenu?: BuildMenu; race: Race };
  private root: HTMLElement | null = null;
  private mineralsNode: HTMLElement | null = null;
  private vespeneNode: HTMLElement | null = null;
  private supplyNode: HTMLElement | null = null;
  private supplyBar: Meter | null = null;
  private supplyChip: HTMLElement | null = null;
  private matchNode: HTMLElement | null = null;
  private alertsNode: HTMLElement | null = null;
  private portraitIcon: HTMLElement | null = null;
  private portraitName: HTMLElement | null = null;
  private portraitHp: Meter | null = null;
  private portraitHpText: HTMLElement | null = null;
  private pageNode: HTMLElement | null = null;
  private cardQueue: HTMLElement | null = null;
  private selectionNode: HTMLElement | null = null;
  private cards: SlotCard[] = [];
  private page = 0;
  private pages = 1;
  private slots: readonly CommandSlot[] = [];
  private alertTimers = new Map<HTMLElement, TimerHandle>();

  constructor(callbacks: HudCallbacks, options: HudOptions = {}) {
    this.callbacks = callbacks;
    this.children = {
      minimap: options.minimap,
      unitPanel: options.unitPanel,
      buildMenu: options.buildMenu,
      race: options.race ?? "terran",
    };
  }

  /** The injected minimap, once mounted. */
  get minimap(): MinimapUi | undefined {
    return this.children.minimap;
  }

  get unitPanel(): UnitPanel | undefined {
    return this.children.unitPanel;
  }

  get buildMenu(): BuildMenu | undefined {
    return this.children.buildMenu;
  }

  mount(root: HTMLElement): void {
    const doc = docOf(root);
    const hud = el(doc, "div", "hud");
    hud.dataset.race = this.children.race;

    /* Resource bar ------------------------------------------------------ */
    const resources = el(doc, "header", "hud__resources panel");
    const mineralChip = this.chip(doc, "minerals", () => this.callbacks.onSelectWorker?.());
    const vespeneChip = this.chip(doc, "vespene");
    const supplyChip = this.chip(doc, "supply");
    const supplyBar = meter(doc, "meter--supply", "supply");
    supplyChip.node.append(supplyBar.root);
    this.mineralsNode = mineralChip.value;
    this.vespeneNode = vespeneChip.value;
    this.supplyNode = supplyChip.value;
    this.supplyChip = supplyChip.node;
    this.supplyBar = supplyBar;
    resources.append(mineralChip.node, vespeneChip.node, supplyChip.node);

    /* Match cluster ----------------------------------------------------- */
    const match = el(doc, "div", "hud__match panel");
    const matchText = el(doc, "span", "hud__matchtext", "—");
    this.matchNode = matchText;
    match.append(
      matchText,
      button(doc, { label: "?", variant: "ghost", onClick: () => this.callbacks.onHotkeyHelp() }, this.teardown),
      button(doc, { label: "Menu", variant: "ghost", onClick: () => this.callbacks.onMenu() }, this.teardown),
    );

    /* Alert feed -------------------------------------------------------- */
    const alerts = el(doc, "div", "hud__alerts");
    alerts.setAttribute("role", "log");
    this.alertsNode = alerts;

    /* Command card ------------------------------------------------------ */
    const card = el(doc, "section", "hud__card panel");
    const portrait = el(doc, "div", "card__portrait");
    const portraitIcon = el(doc, "span", "card__portraiticon");
    const portraitName = el(doc, "span", "card__portraitname", "No selection");
    const portraitHp = meter(doc, "meter--sm", "hp");
    const portraitHpText = el(doc, "span", "card__porthp", "");
    portrait.append(portraitIcon, portraitName, portraitHp.root, portraitHpText);
    this.portraitIcon = portraitIcon;
    this.portraitName = portraitName;
    this.portraitHp = portraitHp;
    this.portraitHpText = portraitHpText;

    const slots = el(doc, "div", "card__slots");
    for (let i = 0; i < COMMAND_SLOTS; i += 1) slots.append(this.renderSlot(doc, i));

    const footer = el(doc, "div", "card__footer");
    const prev = el(doc, "button", "pager__arrow", "‹");
    prev.type = "button";
    prev.title = "Previous commands";
    const page = el(doc, "div", "pager__dots");
    const next = el(doc, "button", "pager__arrow", "›");
    next.type = "button";
    next.title = "More commands";
    this.pageNode = page;
    listen(prev, "click", () => this.turnPage(-1), this.teardown);
    listen(next, "click", () => this.turnPage(1), this.teardown);
    const cardQueue = el(doc, "div", "card__queue");
    this.cardQueue = cardQueue;
    footer.append(prev, page, next, cardQueue);

    const buildSlot = el(doc, "div", "hud__build");
    card.append(portrait, slots, footer);
    const cardColumn = el(doc, "div", "hud__cardcolumn");
    cardColumn.append(buildSlot, card);
    if (this.children.buildMenu !== undefined) this.children.buildMenu.mount(buildSlot);

    /* Selection grid ---------------------------------------------------- */
    const selection = el(doc, "div", "hud__selection");
    this.selectionNode = selection;

    /* Minimap ----------------------------------------------------------- */
    const minimapSlot = el(doc, "div", "hud__minimap");
    if (this.children.minimap !== undefined) this.children.minimap.mount(minimapSlot);

    const inspectorSlot = el(doc, "div", "hud__inspect");
    if (this.children.unitPanel !== undefined) this.children.unitPanel.mount(inspectorSlot);

    hud.append(resources, match, alerts, inspectorSlot, minimapSlot, cardColumn, selection);
    clear(root);
    root.append(hud);
    this.root = hud;
    this.paintPages();
    this.teardown.add(() => {
      for (const timer of this.alertTimers.values()) clearTimeout(timer);
      this.alertTimers.clear();
      this.children.minimap?.dispose();
      this.children.unitPanel?.dispose();
      this.children.buildMenu?.dispose();
      if (hud.parentNode !== null) hud.parentNode.removeChild(hud);
      this.root = null;
    });
  }

  setVisible(visible: boolean): void {
    if (this.root !== null) this.root.hidden = !visible;
  }

  setRace(race: Race): void {
    if (this.root !== null) this.root.dataset.race = race;
  }

  setMatchInfo(info: MatchInfo): void {
    if (this.matchNode === null) return;
    this.matchNode.textContent = `${info.mapName} · ${info.mode} · ${info.players}p`;
  }

  setResources(minerals: number, vespene: number): void {
    if (this.mineralsNode !== null) this.mineralsNode.textContent = fmtInt(minerals);
    if (this.vespeneNode !== null) this.vespeneNode.textContent = fmtInt(vespene);
    this.children.buildMenu?.setResources(minerals, vespene);
  }

  setSupply(supply: SupplyReadout): void {
    if (this.supplyNode !== null) this.supplyNode.textContent = `${fmtInt(supply.used)} / ${fmtInt(supply.cap)}`;
    if (this.supplyBar !== null) {
      this.supplyBar.set(supply.cap > 0 ? supply.used / supply.cap : 0);
    }
    if (this.supplyChip !== null) {
      this.supplyChip.classList.toggle("is-blocked", supply.blocked);
      this.supplyChip.title = supply.blocked ? "Supply blocked — build or destroy something" : "Supply used of cap";
    }
  }

  /** Current selection; also refreshes the portrait, grid and inspector. */
  setSelection(entities: readonly ProtocolEntity[], relation: "own" | "ally" | "enemy"): void {
    this.paintPortrait(entities);
    this.paintSelection(entities);
    if (this.children.unitPanel !== undefined) this.children.unitPanel.show(entities, relation);
  }

  /** Per-snapshot refresh for the selection you already have. */
  refreshSelection(entities: readonly ProtocolEntity[], relation: "own" | "ally" | "enemy"): void {
    if (this.children.unitPanel !== undefined) this.children.unitPanel.update(entities, relation);
    if (entities.length > 0) this.paintPortrait(entities);
  }

  /** The nine command slots for the active page, plus how many pages exist. */
  setCommandCard(pages: number, page: number, slots: readonly CommandSlot[]): void {
    this.pages = Math.max(1, pages);
    this.page = Math.min(Math.max(page, 0), this.pages - 1);
    this.slots = slots;
    this.paintSlots();
    this.paintPages();
  }

  setQueue(items: readonly QueueItem[]): void {
    const doc = this.doc;
    const host = this.cardQueue;
    if (doc === null || host === null) return;
    clear(host);
    if (items.length === 0) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    for (const item of items.slice(0, 4)) {
      const chip = el(doc, "div", "queuechip");
      const progress = meter(doc, "meter--micro", "accent");
      progress.set(item.progress);
      const label = el(doc, "span", "queuechip__label", item.label);
      chip.append(label, progress.root);
      if (item.cancellable) {
        const cancel = el(doc, "button", "queuechip__cancel", "✕");
        cancel.type = "button";
        cancel.title = `Cancel ${item.label}`;
        listen(cancel, "click", () => this.callbacks.onCancelProduction(item.entityId), this.teardown);
        chip.append(cancel);
      }
      host.append(chip);
    }
    if (items.length > 4) host.append(el(doc, "span", "queuechip__more", `+${items.length - 4}`));
  }

  /** Highlights the building whose rally point is being placed. */
  setRallyMode(buildingId: number | null): void {
    this.children.unitPanel?.setRallyArmed(buildingId);
    for (const card of this.cards) card.node.classList.toggle("is-rally", buildingId !== null);
    this.root?.classList.toggle("is-rallying", buildingId !== null);
  }

  /** Pushes a line into the feed (`{e:"alert"}` snapshot events land here). */
  alert(text: string, kind: AlertKind = "info"): void {
    const doc = this.doc;
    const host = this.alertsNode;
    if (doc === null || host === null) return;
    const node = el(doc, "div", `feed feed--${kind}`, text);
    host.insertBefore(node, host.firstChild);
    const timer = setTimeout(() => {
      node.classList.add("is-leaving");
      this.alertTimers.delete(node);
      setTimeout(() => {
        if (node.parentNode !== null) node.parentNode.removeChild(node);
      }, 260);
    }, ALERT_TTL_MS);
    this.alertTimers.set(node, timer);
    while (host.childElementCount > ALERT_LIMIT) {
      const oldest = host.lastElementChild;
      if (oldest === null) break;
      const oldestTimer = this.alertTimers.get(oldest as HTMLElement);
      if (oldestTimer !== undefined) {
        clearTimeout(oldestTimer);
        this.alertTimers.delete(oldest as HTMLElement);
      }
      host.removeChild(oldest);
    }
  }

  dispose(): void {
    this.teardown.dispose();
  }

  /* ------------------------------------------------------------------ */

  private get doc(): Document | null {
    return this.root?.ownerDocument ?? null;
  }

  private chip(
    doc: Document,
    kind: "minerals" | "vespene" | "supply",
    onClick?: () => void,
  ): { node: HTMLElement; value: HTMLElement } {
    const node: HTMLElement =
      onClick === undefined ? el(doc, "div", `chip chip--${kind}`) : el(doc, "button", `chip chip--${kind}`);
    if (onClick !== undefined) {
      (node as HTMLButtonElement).type = "button";
      node.title = "Select a worker";
      listen(node, "click", onClick, this.teardown);
    }
    node.append(resourceIcon(kind, 18));
    const value = el(doc, "span", "chip__value", "0");
    node.append(value);
    return { node, value };
  }

  private renderSlot(doc: Document, index: number): HTMLButtonElement {
    const node = el(doc, "button", "slot");
    node.type = "button";
    const sweep = el(doc, "div", "slot__sweep");
    const iconWrap = el(doc, "span", "slot__icon");
    const hotkey = el(doc, "span", "slot__hotkey");
    const cost = el(doc, "span", "slot__cost");
    const cooldown = el(doc, "span", "slot__cooldown");
    node.append(sweep, iconWrap, hotkey, cost, cooldown);
    node.hidden = true;
    listen(
      node,
      "click",
      () => {
        const slot = this.slots[index];
        if (slot === undefined || node.disabled) return;
        if (slot.kind === "train" && this.callbacks.onTrain !== undefined) this.callbacks.onTrain(slot.key);
        else this.callbacks.onAbility(slot.key);
      },
      this.teardown,
    );
    this.cards.push({ node, sweep, cost, cooldown });
    return node;
  }

  private paintSlots(): void {
    for (let index = 0; index < COMMAND_SLOTS; index += 1) {
      const card = this.cards[index];
      const slot = this.slots[index];
      if (card === undefined) continue;
      if (slot === undefined) {
        card.node.hidden = true;
        continue;
      }
      card.node.hidden = false;
      card.node.disabled = slot.disabled === true;
      card.node.classList.toggle("slot--train", slot.kind === "train");
      card.node.classList.toggle("slot--ability", slot.kind === "ability");
      const iconWrap = card.node.querySelector(".slot__icon");
      if (iconWrap !== null) {
        clear(iconWrap);
        iconWrap.append(entityIcon(slot.icon, 34));
      }
      const hotkey = card.node.querySelector(".slot__hotkey");
      if (hotkey !== null && hotkey.textContent !== (slot.hotkey ?? "")) {
        hotkey.textContent = slot.hotkey ?? "";
      }
      const costText = describeCost(slot);
      if (card.cost.textContent !== costText) card.cost.textContent = costText;
      card.node.title = slot.reason === undefined ? `${slot.label}${costText}` : `${slot.label} — ${slot.reason}`;
      const total = slot.cooldownTotal ?? 0;
      const left = slot.cooldown ?? 0;
      const fraction = total > 0 && left > 0 ? Math.min(left / total, 1) : 0;
      card.sweep.style.setProperty("--sweep", (fraction * 360).toFixed(1));
      card.node.classList.toggle("is-cooling", fraction > 0);
      const cooldownText = left > 0 ? `${Math.ceil(left)}s` : "";
      if (card.cooldown.textContent !== cooldownText) card.cooldown.textContent = cooldownText;
      const progress = slot.progress ?? 0;
      card.node.classList.toggle("is-building", progress > 0);
      card.node.style.setProperty("--build", (progress * 100).toFixed(1));
    }
  }

  private paintPages(): void {
    const doc = this.doc;
    const host = this.pageNode;
    if (doc === null || host === null) return;
    clear(host);
    for (let i = 0; i < this.pages; i += 1) {
      const dot = el(doc, "button", "pager__dot");
      dot.type = "button";
      dot.title = `Commands ${i + 1}`;
      dot.classList.toggle("is-active", i === this.page);
      listen(dot, "click", () => this.callbacks.onPage?.(i), this.teardown);
      host.append(dot);
    }
  }

  private turnPage(delta: number): void {
    const next = Math.min(Math.max(this.page + delta, 0), this.pages - 1);
    if (next === this.page) return;
    this.page = next;
    this.paintPages();
    this.callbacks.onPage?.(next);
  }

  private paintPortrait(entities: readonly ProtocolEntity[]): void {
    const doc = this.doc;
    if (doc === null) return;
    const primary = entities[0];
    if (this.portraitIcon !== null) {
      clear(this.portraitIcon);
      this.portraitIcon.append(entityIcon(primary === undefined ? "" : primary.ty, 44));
    }
    if (this.portraitName !== null) {
      this.portraitName.textContent =
        primary === undefined
          ? "No selection"
          : entities.length === 1
            ? nameOf(primary.ty)
            : `${nameOf(primary.ty)} +${entities.length - 1}`;
    }
    const hp = entities.reduce((sum, entity) => sum + entity.hp, 0);
    const hpMax = entities.reduce((sum, entity) => sum + entity.hp_max, 0);
    this.portraitHp?.set(hpMax > 0 ? hp / hpMax : 0);
    if (this.portraitHpText !== null) {
      this.portraitHpText.textContent = entities.length === 0 ? "" : `${fmtInt(hp)} / ${fmtInt(hpMax)}`;
    }
    if (this.root !== null) this.root.dataset.tone = entities[0] === undefined ? "none" : raceOf(entities[0].ty) ?? "none";
  }

  private paintSelection(entities: readonly ProtocolEntity[]): void {
    const doc = this.doc;
    const host = this.selectionNode;
    if (doc === null || host === null) return;
    clear(host);
    if (entities.length === 0) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    for (const entity of entities.slice(0, 24)) {
      const card = el(doc, "button", "portrait");
      card.type = "button";
      card.title = `${nameOf(entity.ty)} · ${fmtInt(entity.hp)}/${fmtInt(entity.hp_max)}`;
      const icon = el(doc, "span", "portrait__icon");
      icon.append(entityIcon(entity.ty, 26));
      const bar = meter(doc, "meter--micro", entity.hp * 2 < entity.hp_max ? "low" : "hp");
      bar.set(entity.hp_max > 0 ? entity.hp / entity.hp_max : 0);
      card.append(icon, bar.root);
      listen(card, "click", () => this.callbacks.onSelectEntity?.(entity.id), this.teardown);
      host.append(card);
    }
    if (entities.length > 24) host.append(el(doc, "span", "portrait__more", `+${entities.length - 24}`));
  }
}

function nameOf(key: string): string {
  return hasEntityDef(key) ? displayName(key) : key;
}

function describeCost(slot: CommandSlot): string {
  const parts: string[] = [];
  if (slot.minerals !== undefined && slot.minerals > 0) parts.push(fmtInt(slot.minerals));
  if (slot.vespene !== undefined && slot.vespene > 0) parts.push(fmtInt(slot.vespene));
  return parts.length === 0 ? "" : parts.join("/");
}
