/**
 * Detailed inspector for the current selection.
 *
 * Single unit: name, race bar, HP/shield, armour, damage/range/cooldown/DPS
 * and every ability with a cooldown sweep. Several units: a stacked summary
 * grouped by type with per-group health. A building additionally gets its
 * production queue, a rally-point button and a cancel.
 *
 * Every number comes from the roster through `gameData` or from the snapshot
 * entity — nothing is hard-coded.
 */
import { displayName, entityDef, hasEntityDef } from "@shared/gameData";
import type { AbilityDef, EntityDef, ProtocolEntity } from "@shared/protocol";
import { entityIcon } from "./icons";
import type { Meter, QueueItem } from "./uiTypes";
import {
  Teardown,
  accentFor,
  button,
  clear,
  docOf,
  el,
  fmtInt,
  fmtSeconds,
  listen,
  meter,
  raceOf,
} from "./uiTypes";

export interface UnitPanelOptions {
  onCancelProduction?(entityId: number): void;
  onSetRally?(entityId: number): void;
  onAbility?(entityId: number, abilityKey: string): void;
}

export type SelectionRelation = "own" | "ally" | "enemy";

interface Combat {
  damage: number;
  range: number;
  cooldown: number;
  dps: number;
  weapon: string;
  splash: string;
}

interface Group {
  entities: readonly ProtocolEntity[];
  bar: Meter;
  shieldBar: Meter;
  label: HTMLElement;
}

/** Roster combat block for a unit or a defensive building. */
function combatOf(def: EntityDef): Combat | null {
  if (def.kind === "unit") {
    const attack = def.attack;
    if (!("damage" in attack)) return null;
    return {
      damage: attack.damage,
      range: attack.range,
      cooldown: attack.cooldown,
      dps: attack.cooldown > 0 ? attack.damage / attack.cooldown : attack.damage,
      weapon: attack.weapon,
      splash: attack.splash === null || attack.splash === undefined ? "" : ` · splash ${attack.splash.radius}m`,
    };
  }
  const defense = def.defense;
  if (defense === null || defense === undefined) return null;
  return {
    damage: defense.damage,
    range: defense.range,
    cooldown: defense.cooldown,
    dps: defense.cooldown > 0 ? defense.damage / defense.cooldown : defense.damage,
    weapon: defense.weapon ?? "gun",
    splash: defense.missile_splash === undefined ? "" : ` · splash ${defense.missile_splash}m`,
  };
}

export class UnitPanel {
  private readonly teardown = new Teardown();
  private readonly opts: UnitPanelOptions;
  private doc: Document | null = null;
  private root: HTMLElement | null = null;
  private titleNode: HTMLElement | null = null;
  private raceBar: HTMLElement | null = null;
  private totalBar: Meter | null = null;
  private totalLabel: HTMLElement | null = null;
  private groupsNode: HTMLElement | null = null;
  private statsNode: HTMLElement | null = null;
  private abilitiesNode: HTMLElement | null = null;
  private queueNode: HTMLElement | null = null;
  private actionsNode: HTMLElement | null = null;
  private groups: Group[] = [];
  private signature = "";
  private relation: SelectionRelation = "own";
  private cooldowns = new Map<string, number>();
  private abilityCards: { node: HTMLElement; def: AbilityDef }[] = [];
  private primaryId = 0;
  private queue: readonly QueueItem[] = [];

  constructor(options: UnitPanelOptions = {}) {
    this.opts = options;
  }

  mount(root: HTMLElement): void {
    const doc = docOf(root);
    this.doc = doc;
    const panel = el(doc, "aside", "panel unit");
    const head = el(doc, "header", "unit__head");
    const raceBar = el(doc, "div", "unit__racebar");
    const titleNode = el(doc, "h2", "unit__title", "No selection");
    head.append(raceBar, titleNode);
    const totalBar = meter(doc, "meter--hp", "hp");
    const totalLabel = el(doc, "span", "unit__totallabel");
    const groupsNode = el(doc, "div", "unit__groups");
    const statsNode = el(doc, "dl", "unit__stats");
    const abilitiesNode = el(doc, "div", "unit__abilities");
    const queueNode = el(doc, "div", "unit__queue");
    const actionsNode = el(doc, "div", "unit__actions");
    panel.append(head, totalBar.root, totalLabel, groupsNode, statsNode, abilitiesNode, queueNode, actionsNode);
    clear(root);
    root.append(panel);
    this.root = panel;
    this.raceBar = raceBar;
    this.titleNode = titleNode;
    this.totalBar = totalBar;
    this.totalLabel = totalLabel;
    this.groupsNode = groupsNode;
    this.statsNode = statsNode;
    this.abilitiesNode = abilitiesNode;
    this.queueNode = queueNode;
    this.actionsNode = actionsNode;
    this.teardown.add(() => {
      if (panel.parentNode !== null) panel.parentNode.removeChild(panel);
      this.root = null;
      this.groups = [];
      this.abilityCards = [];
    });
    panel.hidden = true;
  }

  /** Full re-render; use when the selection itself changed. */
  show(entities: readonly ProtocolEntity[], relation: SelectionRelation = "own"): void {
    this.relation = relation;
    this.signature = signatureOf(entities);
    this.render(entities);
  }

  /** Per-snapshot refresh: repaints bars, sweeps and the queue only. */
  update(entities: readonly ProtocolEntity[], relation: SelectionRelation = "own"): void {
    if (relation !== this.relation) {
      this.show(entities, relation);
      return;
    }
    if (signatureOf(entities) !== this.signature) {
      this.show(entities, relation);
      return;
    }
    let hp = 0;
    let hpMax = 0;
    let shield = 0;
    let shieldMax = 0;
    for (const entity of entities) {
      hp += entity.hp;
      hpMax += entity.hp_max;
      shield += entity.mp;
      shieldMax += entity.mp_max;
    }
    for (const group of this.groups) {
      let groupHp = 0;
      let groupHpMax = 0;
      let groupShield = 0;
      let groupShieldMax = 0;
      for (const entity of group.entities) {
        groupHp += entity.hp;
        groupHpMax += entity.hp_max;
        groupShield += entity.mp;
        groupShieldMax += entity.mp_max;
      }
      group.bar.set(groupHpMax > 0 ? groupHp / groupHpMax : 0);
      group.shieldBar.set(groupShieldMax > 0 ? groupShield / groupShieldMax : 0);
      group.label.textContent = `${fmtInt(groupHp)} / ${fmtInt(groupHpMax)} hp`;
    }
    this.totalBar?.set(hpMax > 0 ? hp / hpMax : 0);
    if (this.totalLabel !== null) {
      this.totalLabel.textContent = `${fmtInt(hp)} / ${fmtInt(hpMax)} hp`;
    }
    this.paintAbilities();
  }

  /** Remaining cooldown, in seconds, per ability key. */
  setAbilityCooldowns(remaining: ReadonlyMap<string, number>): void {
    this.cooldowns = new Map(remaining);
    this.paintAbilities();
  }

  /** Production rows for the selected building. */
  setQueue(items: readonly QueueItem[]): void {
    this.queue = items;
    this.paintQueue();
  }

  setRallyArmed(buildingId: number | null): void {
    const actions = this.actionsNode;
    if (actions === null) return;
    for (const node of actions.querySelectorAll<HTMLElement>("[data-building]")) {
      node.classList.toggle("is-armed", buildingId !== null && node.dataset.building === String(buildingId));
    }
  }

  hide(): void {
    if (this.root !== null) this.root.hidden = true;
  }

  dispose(): void {
    this.teardown.dispose();
    this.doc = null;
  }

  /* ------------------------------------------------------------------ */

  private render(entities: readonly ProtocolEntity[]): void {
    const doc = this.doc;
    const root = this.root;
    if (doc === null || root === null) return;
    if (entities.length === 0) {
      this.hide();
      return;
    }
    root.hidden = false;
    root.dataset.relation = this.relation;
    this.groups = [];
    this.abilityCards = [];
    const primary = entities[0];
    this.primaryId = primary.id;

    const buckets = new Map<string, ProtocolEntity[]>();
    for (const entity of entities) {
      const bucket = buckets.get(entity.ty);
      if (bucket === undefined) buckets.set(entity.ty, [entity]);
      else bucket.push(entity);
    }

    const def = hasEntityDef(primary.ty) ? entityDef(primary.ty) : null;
    const race = raceOf(primary.ty);
    if (this.raceBar !== null) {
      this.raceBar.style.background = accentFor(race);
    }
    if (this.titleNode !== null) {
      this.titleNode.textContent =
        entities.length === 1 || def === null
          ? (def === null ? primary.ty : displayName(primary.ty))
          : `${entities.length} selected · ${displayName(primary.ty)}`;
    }

    let hp = 0;
    let hpMax = 0;
    let shield = 0;
    let shieldMax = 0;
    for (const entity of entities) {
      hp += entity.hp;
      hpMax += entity.hp_max;
      shield += entity.mp;
      shieldMax += entity.mp_max;
    }
    this.totalBar?.set(hpMax > 0 ? hp / hpMax : 0);
    if (this.totalLabel !== null) this.totalLabel.textContent = `${fmtInt(hp)} / ${fmtInt(hpMax)} hp`;

    if (this.groupsNode !== null) {
      clear(this.groupsNode);
      for (const [key, members] of buckets) {
        const groupDef = hasEntityDef(key) ? entityDef(key) : null;
        const row = el(doc, "div", "unit__group");
        const iconWrap = el(doc, "span", "unit__groupicon");
        iconWrap.append(entityIcon(key, 28));
        const body = el(doc, "div", "unit__groupbody");
        const label = el(doc, "span", "unit__grouplabel");
        const bar = meter(doc, "meter--sm", "hp");
        const shieldBar = meter(doc, "meter--sm", "shield");
        body.append(label, bar.root, shieldBar.root);
        row.append(iconWrap, body);
        this.groupsNode.append(row);
        let groupHp = 0;
        let groupHpMax = 0;
        let groupShield = 0;
        let groupShieldMax = 0;
        for (const entity of members) {
          groupHp += entity.hp;
          groupHpMax += entity.hp_max;
          groupShield += entity.mp;
          groupShieldMax += entity.mp_max;
        }
        bar.set(groupHpMax > 0 ? groupHp / groupHpMax : 0);
        shieldBar.set(groupShieldMax > 0 ? groupShield / groupShieldMax : 0);
        label.textContent = groupDef === null ? `${members.length} × ${key}` : `${members.length} × ${displayName(key)}`;
        this.groups.push({ entities: members, bar, shieldBar, label });
      }
    }

    this.renderStats(doc, entities, def);
    this.renderAbilities(doc, def);
    this.paintQueue();
    this.renderActions(doc, def);
  }

  private renderStats(doc: Document, entities: readonly ProtocolEntity[], def: EntityDef | null): void {
    const stats = this.statsNode;
    if (stats === null) return;
    clear(stats);
    if (def === null) return;
    const combat = combatOf(def);
    const shieldTotal = entities.reduce((sum, entity) => sum + entity.mp_max, 0);
    const add = (label: string, value: string, tone?: string): void => {
      stats.append(el(doc, "dt", "unit__statlabel", label));
      const dd = el(doc, "dd", tone === undefined ? "unit__statvalue" : `unit__statvalue ${tone}`, value);
      stats.append(dd);
    };
    add("Armour", fmtInt(def.armor));
    if (combat !== null) {
      add("Damage", fmtInt(combat.damage));
      add("Range", `${combat.range.toFixed(1)} m`);
      add("Cooldown", fmtSeconds(combat.cooldown));
      add("DPS", fmtInt(combat.dps), "unit__statvalue--hi");
      add("Weapon", `${combat.weapon}${combat.splash}`);
    }
    if (def.kind === "unit") {
      add("Speed", `${def.speed.toFixed(1)} m/s`);
      add("Sight", `${def.sight} m`);
      add("Supply", fmtInt(def.cost.supply));
      if (def.harvest !== null && def.harvest !== undefined) {
        add("Cargo", `${fmtInt(def.harvest.capacity)} (+${fmtInt(def.harvest.rate * def.harvest.capacity)}/trip)`);
      }
    }
    if (shieldTotal > 0) add("Shield", fmtInt(shieldTotal));
    add("Tier", fmtInt(def.tier ?? 1));
    if (def.required_buildings !== undefined && def.required_buildings.length > 0) {
      add("Requires", def.required_buildings.map((key) => (hasEntityDef(key) ? displayName(key) : key)).join(", "));
    }
    const working = entities.find((entity) => entity.st === "building" || entity.st === "training");
    if (working !== undefined && working.prog !== undefined && working.prog > 0) {
      add("Progress", `${Math.round(working.prog * 100)}%`);
    }
  }

  private renderAbilities(doc: Document, def: EntityDef | null): void {
    const host = this.abilitiesNode;
    if (host === null) return;
    clear(host);
    this.abilityCards = [];
    if (def === null || def.abilities.length === 0) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    host.append(el(doc, "h3", "unit__section", "Abilities"));
    const list = el(doc, "div", "unit__abilitylist");
    for (const ability of def.abilities) {
      const node = el(doc, "button", "ability");
      node.type = "button";
      const sweep = el(doc, "div", "ability__sweep");
      const name = el(doc, "span", "ability__name", ability.name);
      const hint = el(doc, "span", "ability__hint", abilityHint(ability));
      node.append(sweep, name, hint);
      listen(
        node,
        "click",
        () => {
          if (this.opts.onAbility !== undefined) this.opts.onAbility(this.primaryId, ability.key);
        },
        this.teardown,
      );
      list.append(node);
      this.abilityCards.push({ node, def: ability });
    }
    host.append(list);
    this.paintAbilities();
  }

  /** The conic sweep over an ability that is on cooldown. */
  private paintAbilities(): void {
    for (const card of this.abilityCards) {
      const total = card.def.cooldown;
      const left = this.cooldowns.get(card.def.key) ?? 0;
      const fraction = total > 0 && left > 0 ? Math.min(left / total, 1) : 0;
      card.node.style.setProperty("--sweep", (fraction * 360).toFixed(1));
      card.node.classList.toggle("is-cooling", fraction > 0);
      const hint = card.node.querySelector(".ability__hint");
      if (hint !== null) {
        const label = left > 0 ? fmtSeconds(left) : abilityHint(card.def);
        if (hint.textContent !== label) hint.textContent = label;
      }
    }
  }

  private renderActions(doc: Document, def: EntityDef | null): void {
    const actions = this.actionsNode;
    if (actions === null) return;
    clear(actions);
    if (def === null) return;
    if (def.kind !== "building" || this.relation === "enemy") return;
    const rally = button(
      doc,
      {
        label: "Set rally point",
        variant: "ghost",
        onClick: () => this.opts.onSetRally?.(this.primaryId),
      },
      this.teardown,
    );
    rally.dataset.building = String(this.primaryId);
    rally.classList.add("btn--sm");
    actions.append(rally);
  }

  private paintQueue(): void {
    const doc = this.doc;
    const host = this.queueNode;
    if (doc === null || host === null) return;
    clear(host);
    if (this.queue.length === 0) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    host.append(el(doc, "h3", "unit__section", `Production queue (${this.queue.length})`));
    const list = el(doc, "div", "unit__queuelist");
    for (const item of this.queue) {
      const row = el(doc, "div", "queue__row");
      const iconWrap = el(doc, "span", "queue__icon");
      iconWrap.append(entityIcon(item.type, 24));
      const body = el(doc, "div", "queue__body");
      const label = el(doc, "span", "queue__label", item.label);
      const time = el(doc, "span", "queue__time", fmtSeconds(item.remaining));
      const head = el(doc, "div", "queue__head");
      head.append(label, time);
      const progress = meter(doc, "meter--sm", "accent");
      progress.set(item.progress);
      body.append(head, progress.root);
      row.append(iconWrap, body);
      if (item.cancellable) {
        const cancel = button(
          doc,
          { label: "✕", variant: "danger", onClick: () => this.opts.onCancelProduction?.(item.entityId) },
          this.teardown,
        );
        cancel.classList.add("queue__cancel");
        cancel.title = `Cancel ${item.label}`;
        row.append(cancel);
      }
      list.append(row);
    }
    host.append(list);
  }
}

function signatureOf(entities: readonly ProtocolEntity[]): string {
  return entities.map((entity) => `${entity.id}:${entity.ty}`).join(",");
}

function abilityHint(ability: AbilityDef): string {
  if (ability.cooldown > 0) return `cd ${fmtSeconds(ability.cooldown)}`;
  if (ability.effect === "spawn" && ability.spawn !== undefined) {
    return hasEntityDef(ability.spawn) ? `→ ${displayName(ability.spawn)}` : "→ unit";
  }
  if (ability.magnitude !== undefined && ability.magnitude > 0) return `+${fmtInt(ability.magnitude)}`;
  if (ability.duration_s !== undefined && ability.duration_s > 0) return `${fmtSeconds(ability.duration_s)}`;
  return ability.effect;
}
