/**
 * End-of-match screen: outcome banner, the full score table and the
 * Replay / Rematch / Menu actions.
 *
 * The summary is the `game:ended` payload plus the viewer's own player id —
 * nothing is recomputed here.
 */
import { raceColor } from "@shared/gameData";
import type { EndReason, PlayerScore } from "@shared/protocol";
import { Teardown, button, clear, docOf, el, fmtClock, fmtInt } from "./uiTypes";

export interface ResultSummary {
  /** Player id of the winner, or null for a draw. */
  winner: number | null;
  /** The viewer's player id — decides victory vs defeat. */
  myPlayerId: number;
  reason: EndReason;
  durationMs: number;
  scores: PlayerScore[];
  replayUrl: string;
  tick: number;
}

export interface ResultActions {
  onReplay(url: string): void;
  onRematch(): void;
  onMenu(): void;
}

const REASON_LABEL: Record<EndReason, string> = {
  defeat: "Your forces were destroyed.",
  annihilation: "Annihilation — nothing left standing.",
  timeout: "Time limit reached.",
  forfeit: "The match was forfeited.",
  disconnect: "A player disconnected.",
  stalemate: "Stalemate — no side could finish the other.",
};

const OUTCOME = { win: "VICTORY", loss: "DEFEAT", draw: "DRAW" } as const;

export class ResultScreen {
  private readonly teardown = new Teardown();
  private readonly actions: ResultActions;
  private root: HTMLElement | null = null;
  private doc: Document | null = null;
  private banner: HTMLElement | null = null;
  private reason: HTMLElement | null = null;
  private clock: HTMLElement | null = null;
  private table: HTMLElement | null = null;
  private replayButton: HTMLButtonElement | null = null;
  private summary: ResultSummary | null = null;

  constructor(actions: ResultActions) {
    this.actions = actions;
  }

  mount(root: HTMLElement): void {
    const doc = docOf(root);
    this.doc = doc;
    const screen = el(doc, "section", "screen result");
    const panel = el(doc, "div", "panel result__panel");
    const banner = el(doc, "h1", "result__banner", "DEFEAT");
    const reason = el(doc, "p", "result__reason", "");
    const clock = el(doc, "p", "result__clock", "");
    const table = el(doc, "table", "result__table");
    const actionsRow = el(doc, "div", "result__actions");
    const replay = button(
      doc,
      { label: "Replay", variant: "primary", disabled: true, onClick: () => this.replay() },
      this.teardown,
    );
    replay.classList.add("btn--lg");
    const rematch = button(
      doc,
      { label: "Rematch", variant: "primary", onClick: () => this.actions.onRematch() },
      this.teardown,
    );
    rematch.classList.add("btn--lg");
    const menu = button(
      doc,
      { label: "Main menu", variant: "ghost", onClick: () => this.actions.onMenu() },
      this.teardown,
    );
    menu.classList.add("btn--lg");
    actionsRow.append(replay, rematch, menu);
    panel.append(banner, reason, clock, table, actionsRow);
    screen.append(panel);
    clear(root);
    root.append(screen);
    this.root = screen;
    this.banner = banner;
    this.reason = reason;
    this.clock = clock;
    this.table = table;
    this.replayButton = replay;
    this.teardown.add(() => {
      if (screen.parentNode !== null) screen.parentNode.removeChild(screen);
      this.root = null;
    });
    screen.hidden = true;
  }

  show(summary: ResultSummary): void {
    const doc = this.doc;
    if (doc === null) return;
    this.summary = summary;
    if (this.root !== null) this.root.hidden = false;
    const mine = summary.scores.find((score) => score.player_id === summary.myPlayerId);
    const outcome = mine?.result ?? (summary.winner === null ? "draw" : "loss");
    if (this.banner !== null) {
      this.banner.textContent = OUTCOME[outcome];
      this.banner.dataset.outcome = outcome;
    }
    if (this.reason !== null) this.reason.textContent = REASON_LABEL[summary.reason] ?? "Match over.";
    if (this.clock !== null) {
      this.clock.textContent = `Duration ${fmtClock(summary.durationMs)} · ${fmtInt(summary.tick)} ticks simulated`;
    }
    if (this.replayButton !== null) this.replayButton.disabled = summary.replayUrl.length === 0;
    this.renderTable(doc, summary);
  }

  hide(): void {
    if (this.root !== null) this.root.hidden = true;
  }

  setVisible(visible: boolean): void {
    if (this.root !== null) this.root.hidden = !visible;
  }

  dispose(): void {
    this.teardown.dispose();
    this.root = null;
  }

  /* ------------------------------------------------------------------ */

  private renderTable(doc: Document, summary: ResultSummary): void {
    const table = this.table;
    if (table === null) return;
    clear(table);
    const head = el(doc, "thead");
    const headRow = el(doc, "tr");
    for (const label of ["Commander", "Race", "Result", "Kills", "Deaths", "Mined", "Built", "Army"]) {
      headRow.append(el(doc, "th", "result__th", label));
    }
    head.append(headRow);
    const body = el(doc, "tbody");
    const ordered = [...summary.scores].sort((a, b) => b.army_value - a.army_value || b.kills - a.kills);
    for (const score of ordered) {
      const row = el(doc, "tr", "result__row");
      if (score.player_id === summary.myPlayerId) row.classList.add("is-me");
      const name = el(doc, "td", "result__td result__td--name", `#${score.player_id}`);
      const race = el(doc, "td", "result__td");
      const dot = el(doc, "span", "result__race");
      dot.style.background = raceColor(score.race);
      race.append(dot, el(doc, "span", "result__racename", score.race));
      const outcome = el(doc, "td", `result__td result__td--${score.result}`, score.result);
      row.append(
        name,
        race,
        outcome,
        el(doc, "td", "result__td", fmtInt(score.kills)),
        el(doc, "td", "result__td", fmtInt(score.deaths)),
        el(doc, "td", "result__td", fmtInt(score.resources_mined)),
        el(doc, "td", "result__td", fmtInt(score.units_built)),
        el(doc, "td", "result__td", fmtInt(score.army_value)),
      );
      body.append(row);
    }
    table.append(head, body);
  }

  private replay(): void {
    if (this.summary === null || this.summary.replayUrl.length === 0) return;
    this.actions.onReplay(this.summary.replayUrl);
  }
}
