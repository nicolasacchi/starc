/**
 * Lobby: the match browser (left) and the room you are sitting in (right).
 *
 * The screen owns no transport. It is handed a `LobbyGateway` — the subset of
 * the lobby socket client it needs — subscribes to `lobby:state`, polls the
 * browser listing on an interval, and fills the room from `showMatch()` because
 * the wire state carries only the viewer's own context (PROTOCOL §2).
 *
 * The host owns connect/disconnect; this screen subscribes in the constructor
 * and unsubscribes in `dispose()`.
 */
import { GAME, hasMap, mapDef, raceColor } from "@shared/gameData";
import type { LobbyChatLine, LobbyContext, LobbyMatchSummary, LobbyPlayer, MatchMode, Race } from "@shared/protocol";
import type { TimerHandle, UiHost } from "./uiTypes";
import { Teardown, button, checkbox, clear, docOf, el, field, listen, select } from "./uiTypes";

/** A seat in the room — exactly the wire `LobbyPlayer` shape. */
export type RoomSeat = LobbyPlayer;

export interface LobbyStatePayload {
  matches: LobbyMatchSummary[];
  you: LobbyContext | null;
  /** Optional enrichment: seats and chat history when the client has them. */
  players?: RoomSeat[];
  chat?: LobbyChatLine[];
}

export interface LobbyFilters {
  mode?: MatchMode;
  map_id?: string;
  only_joinable?: boolean;
}

export interface LobbyCreateBody {
  name: string;
  mode: MatchMode;
  map_id: string;
  max_players: number;
  password?: string;
  race_preference?: Race;
}

export interface LobbySettingsPatch {
  name?: string;
  map_id?: string;
  mode?: MatchMode;
  max_players?: number;
  password?: string;
}

export interface LobbyRoom {
  match: LobbyMatchSummary;
  players: RoomSeat[];
  chat?: LobbyChatLine[];
}

export interface LobbyGateway {
  connect(): Promise<void>;
  disconnect(): void;
  list(filters?: LobbyFilters): Promise<void>;
  create(body: LobbyCreateBody): Promise<void>;
  join(matchId: number, password?: string): Promise<void>;
  leave(matchId: number): Promise<void>;
  ready(matchId: number, ready: boolean): Promise<void>;
  start(matchId: number): Promise<void>;
  chat(matchId: number, text: string): Promise<void>;
  settings(matchId: number, patch: LobbySettingsPatch): Promise<void>;
  showMatch(matchId: number): Promise<LobbyRoom>;
  onState(handler: (state: LobbyStatePayload) => void): () => void;
  onError(handler: (error: { code: string; message: string }) => void): () => void;
}

export interface LobbyScreenOptions {
  host?: UiHost;
  /** Browser refresh period, ms. Default 6000; 0 disables polling. */
  pollMs?: number;
  now?: () => number;
}

/** Matches the server's `MatchesController::MIN_PLAYERS`. */
const MIN_PLAYERS = 2;
const CHAT_LIMIT = 100;
const DEFAULT_POLL_MS = 6000;
const MODES: readonly MatchMode[] = ["melee", "1v1", "custom", "team"];
const RACES: readonly Race[] = ["terran", "zerg", "protoss"];

export class LobbyScreen {
  private readonly teardown = new Teardown();
  private readonly gateway: LobbyGateway;
  private readonly host: UiHost | null;
  private readonly pollMs: number;
  private readonly now: () => number;
  private doc: Document | null = null;
  private root: HTMLElement | null = null;
  private browserPane: HTMLElement | null = null;
  private createPane: HTMLElement | null = null;
  private roomPane: HTMLElement | null = null;
  private listNode: HTMLElement | null = null;
  private statusNode: HTMLElement | null = null;
  private roomHead: HTMLElement | null = null;
  private seatsNode: HTMLElement | null = null;
  private hostControls: HTMLElement | null = null;
  private chatNode: HTMLElement | null = null;
  private readyButton: HTMLButtonElement | null = null;
  private startButton: HTMLButtonElement | null = null;
  private leaveButton: HTMLButtonElement | null = null;
  private createButton: HTMLButtonElement | null = null;
  private createStatus: HTMLElement | null = null;
  private filterMode: HTMLSelectElement | null = null;
  private filterMap: HTMLSelectElement | null = null;
  private filterJoinable: HTMLInputElement | null = null;
  private filterSearch: HTMLInputElement | null = null;
  private joinPassword: HTMLInputElement | null = null;
  private createName: HTMLInputElement | null = null;
  private createMode: HTMLSelectElement | null = null;
  private createMap: HTMLSelectElement | null = null;
  private createRace: HTMLSelectElement | null = null;
  private createMax: HTMLInputElement | null = null;
  private createPassword: HTMLInputElement | null = null;
  private chatInput: HTMLInputElement | null = null;
  private matches: LobbyMatchSummary[] = [];
  private you: LobbyContext | null = null;
  private room: LobbyRoom | null = null;
  private chat: LobbyChatLine[] = [];
  private roomFetch: number | null = null;
  private poll: TimerHandle | null = null;

  constructor(gateway: LobbyGateway, options: LobbyScreenOptions = {}) {
    this.gateway = gateway;
    this.host = options.host ?? null;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.now = options.now ?? (() => Date.now());
    this.teardown.add(gateway.onState((state) => this.update(state)));
    this.teardown.add(
      gateway.onError((error) => {
        this.setStatus(error.message, "error");
        this.host?.notify(error.message, "error");
      }),
    );
  }

  mount(root: HTMLElement): void {
    const doc = docOf(root);
    this.doc = doc;
    const screen = el(doc, "section", "screen lobby");
    screen.setAttribute("aria-label", "Lobby");

    const head = el(doc, "header", "lobby__head panel");
    const title = el(doc, "h1", "lobby__title", "Lobby");
    const status = el(doc, "p", "lobby__status", "connecting…");
    this.statusNode = status;
    head.append(title, status);

    const panes = el(doc, "div", "lobby__panes");
    const browser = el(doc, "section", "panel lobby__browser");
    const filters = el(doc, "div", "lobby__filters");
    this.filterMode = select<MatchMode | "">(
      doc,
      { className: "field__input field__input--sm", ariaLabel: "Filter by mode", onChange: () => this.paintList() },
      [{ value: "", label: "Any mode" }, ...MODES.map((mode) => ({ value: mode, label: mode }))],
      this.teardown,
    );
    this.filterMap = select<string>(
      doc,
      { className: "field__input field__input--sm", ariaLabel: "Filter by map", onChange: () => this.paintList() },
      [{ value: "", label: "Any map" }, ...GAME.maps.map((map) => ({ value: map.id, label: map.name }))],
      this.teardown,
    );
    const joinable = checkbox(doc, "Joinable only", false, () => this.paintList(), this.teardown);
    this.filterJoinable = joinable.input;
    this.filterSearch = el(doc, "input", "field__input field__input--sm");
    this.filterSearch.type = "search";
    this.filterSearch.placeholder = "Search matches";
    this.filterSearch.setAttribute("aria-label", "Search matches");
    listen(this.filterSearch, "input", () => this.paintList(), this.teardown);
    this.joinPassword = el(doc, "input", "field__input field__input--sm");
    this.joinPassword.type = "password";
    this.joinPassword.placeholder = "Password (locked)";
    this.joinPassword.setAttribute("aria-label", "Password for locked matches");
    const refresh = button(
      doc,
      { label: "Refresh", variant: "ghost", onClick: () => void this.refresh() },
      this.teardown,
    );
    refresh.classList.add("btn--sm");
    filters.append(
      this.filterMode,
      this.filterMap,
      joinable.row,
      this.filterSearch,
      this.joinPassword,
      refresh,
    );
    const list = el(doc, "div", "lobby__list");
    this.listNode = list;
    browser.append(el(doc, "h2", "lobby__section", "Matches"), filters, list);

    const create = el(doc, "section", "panel lobby__create");
    this.buildCreateForm(doc, create);

    const room = el(doc, "section", "panel lobby__room");
    this.buildRoom(doc, room);

    panes.append(browser, create, room);
    screen.append(head, panes);
    clear(root);
    root.append(screen);
    this.root = screen;
    this.browserPane = browser;
    this.createPane = create;
    this.roomPane = room;
    this.teardown.add(() => {
      if (this.poll !== null) clearInterval(this.poll);
      this.poll = null;
      if (screen.parentNode !== null) screen.parentNode.removeChild(screen);
      this.root = null;
    });
    this.showBrowser();
    this.paintList();
    this.paintRoom();
    this.setStatus("connecting…", "info");
    if (this.pollMs > 0) this.poll = setInterval(() => void this.refresh(), this.pollMs);
  }

  /* Data in ------------------------------------------------------------ */

  /** Feeds a `lobby:state` payload; the screen decides which pane to show. */
  update(state: LobbyStatePayload): void {
    const you = state.you;
    this.matches = state.matches;
    this.you = you;
    if (state.chat !== undefined) this.chat = state.chat.slice(-CHAT_LIMIT);
    if (you === null) {
      this.setStatus(`${state.matches.length} match(es) open`, "info");
      this.showBrowser();
      this.paintList();
      return;
    }
    if (state.players !== undefined) {
      const match = this.matches.find((entry) => entry.id === you.match_id);
      this.room = {
        match: match ?? this.room?.match ?? emptyMatch(you.match_id),
        players: state.players,
        chat: state.chat,
      };
    }
    this.setStatus(`in match #${you.match_id}`, "info");
    this.showRoom();
    this.paintRoom();
    this.ensureRoomData(you.match_id);
  }

  /** Seat list (and chat history) for the match you are in. */
  setRoom(room: LobbyRoom | null): void {
    this.room = room;
    if (room?.chat !== undefined) this.chat = room.chat.slice(-CHAT_LIMIT);
    if (room !== null) this.showRoom();
    this.paintRoom();
  }

  /** Appends one chat line, keeping the last `CHAT_LIMIT`. */
  appendChat(line: LobbyChatLine): void {
    this.chat.push(line);
    if (this.chat.length > CHAT_LIMIT) this.chat = this.chat.slice(-CHAT_LIMIT);
    this.paintChat();
  }

  showBrowser(): void {
    if (this.browserPane !== null) this.browserPane.hidden = false;
    if (this.createPane !== null) this.createPane.hidden = false;
    if (this.roomPane !== null) this.roomPane.hidden = true;
  }

  showRoom(): void {
    if (this.browserPane !== null) this.browserPane.hidden = true;
    if (this.createPane !== null) this.createPane.hidden = true;
    if (this.roomPane !== null) this.roomPane.hidden = false;
  }

  setVisible(visible: boolean): void {
    if (this.root !== null) this.root.hidden = !visible;
  }

  /** Asks the gateway for a fresh listing. */
  async refresh(): Promise<void> {
    try {
      await this.gateway.list(this.currentFilters());
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : "listing failed", "error");
    }
  }

  dispose(): void {
    this.teardown.dispose();
    this.doc = null;
  }

  /* Chrome -------------------------------------------------------------- */

  private setStatus(message: string, kind: "info" | "error"): void {
    if (this.statusNode === null) return;
    this.statusNode.textContent = message;
    this.statusNode.dataset.kind = kind;
  }

  private buildCreateForm(doc: Document, host: HTMLElement): void {
    host.append(el(doc, "h2", "lobby__section", "Create a match"));
    const form = el(doc, "form", "lobby__createform");
    this.createName = field(doc, { id: "lobby-create-name", label: "Match name", placeholder: "Friday-night ladder", maxLength: 48 }).input;
    this.createMode = select<MatchMode>(
      doc,
      { className: "field__input", value: "melee", onChange: () => undefined },
      MODES.map((mode) => ({ value: mode, label: mode })),
      this.teardown,
    );
    this.createMap = select<string>(
      doc,
      {
        className: "field__input",
        value: GAME.maps[0]?.id ?? "",
        ariaLabel: "Map",
        onChange: () => this.syncMaxPlayers(),
      },
      GAME.maps.map((map) => ({ value: map.id, label: `${map.name} (${map.max_players}p)` })),
      this.teardown,
    );
    this.createRace = select<Race | "">(
      doc,
      { className: "field__input", ariaLabel: "Preferred race", onChange: () => undefined },
      [{ value: "", label: "Any race" }, ...RACES.map((race) => ({ value: race, label: race }))],
      this.teardown,
    );
    this.createMax = el(doc, "input", "field__input");
    this.createMax.type = "number";
    this.createMax.min = String(MIN_PLAYERS);
    this.createMax.value = "2";
    this.createMax.setAttribute("aria-label", "Maximum players");
    this.createPassword = field(doc, { id: "lobby-create-password", label: "Password (optional)", type: "password" }).input;
    const create = button(
      doc,
      { label: "Create match", variant: "primary", onClick: () => void this.createMatch() },
      this.teardown,
    );
    this.createButton = create;
    const status = el(doc, "p", "lobby__createstatus");
    this.createStatus = status;
    form.append(
      labelled(doc, "Name", this.createName),
      labelled(doc, "Mode", this.createMode),
      labelled(doc, "Map", this.createMap),
      labelled(doc, "Race", this.createRace),
      labelled(doc, "Max players", this.createMax),
      labelled(doc, "Password", this.createPassword),
      create,
      status,
    );
    listen(
      form,
      "submit",
      (ev) => {
        ev.preventDefault();
        void this.createMatch();
      },
      this.teardown,
    );
    host.append(form);
  }

  private buildRoom(doc: Document, host: HTMLElement): void {
    const head = el(doc, "div", "room__head");
    this.roomHead = head;
    const seats = el(doc, "div", "room__seats");
    this.seatsNode = seats;
    const hostControls = el(doc, "div", "room__hostcontrols");
    this.hostControls = hostControls;
    const chatLog = el(doc, "div", "room__chat");
    this.chatNode = chatLog;
    const chatForm = el(doc, "form", "room__chatform");
    this.chatInput = el(doc, "input", "field__input field__input--sm");
    this.chatInput.type = "text";
    this.chatInput.maxLength = 280;
    this.chatInput.placeholder = "Message the room (Enter to send)";
    this.chatInput.setAttribute("aria-label", "Chat message");
    const send = button(doc, { label: "Send", variant: "ghost", onClick: () => this.sendChat() }, this.teardown);
    send.classList.add("btn--sm");
    chatForm.append(this.chatInput, send);
    listen(
      chatForm,
      "submit",
      (ev) => {
        ev.preventDefault();
        this.sendChat();
      },
      this.teardown,
    );
    const footer = el(doc, "div", "room__footer");
    const ready = button(
      doc,
      { label: "Ready", variant: "ghost", onClick: () => void this.toggleReady() },
      this.teardown,
    );
    ready.classList.add("btn--lg");
    const start = button(
      doc,
      { label: "Start match", variant: "primary", onClick: () => void this.startMatch() },
      this.teardown,
    );
    start.classList.add("btn--lg");
    const leave = button(
      doc,
      { label: "Leave", variant: "danger", onClick: () => void this.leaveMatch() },
      this.teardown,
    );
    leave.classList.add("btn--lg");
    this.readyButton = ready;
    this.startButton = start;
    this.leaveButton = leave;
    footer.append(ready, start, leave);
    host.append(head, seats, hostControls, el(doc, "h3", "lobby__section", "Chat"), chatLog, chatForm, footer);
  }

  /* Painting ------------------------------------------------------------ */

  private paintList(): void {
    const doc = this.doc;
    const host = this.listNode;
    if (doc === null || host === null) return;
    clear(host);
    const query = (this.filterSearch?.value ?? "").trim().toLowerCase();
    const mode = this.filterMode?.value ?? "";
    const mapId = this.filterMap?.value ?? "";
    const joinableOnly = this.filterJoinable?.checked === true;
    const rows = this.matches.filter((match) => {
      if (match.status !== "lobby") return false;
      if (mode.length > 0 && match.mode !== mode) return false;
      if (mapId.length > 0 && match.map_id !== mapId) return false;
      if (joinableOnly && match.player_count >= match.max_players) return false;
      if (query.length > 0 && !match.name.toLowerCase().includes(query)) return false;
      return true;
    });
    if (rows.length === 0) {
      host.append(el(doc, "p", "lobby__empty", "No open matches. Create one on the right."));
      return;
    }
    for (const match of rows) host.append(this.renderMatchRow(doc, match));
  }

  private renderMatchRow(doc: Document, match: LobbyMatchSummary): HTMLElement {
    const row = el(doc, "div", "matchrow");
    const main = el(doc, "div", "matchrow__main");
    main.append(el(doc, "span", "matchrow__name", match.name));
    const chips = el(doc, "div", "matchrow__chips");
    chips.append(
      chip(doc, "mode", match.mode),
      chip(doc, "map", mapName(match.map_id)),
      chip(doc, "players", `${match.player_count}/${match.max_players}`),
      chip(doc, "host", `host ${match.host}`),
    );
    if (match.has_password) chips.append(chip(doc, "lock", "locked"));
    main.append(chips);
    const full = match.player_count >= match.max_players;
    const join = button(
      doc,
      {
        label: full ? "Full" : "Join",
        variant: "primary",
        disabled: full,
        onClick: () => void this.joinMatch(match.id, match.has_password),
      },
      this.teardown,
    );
    join.classList.add("btn--sm");
    row.append(main, join);
    return row;
  }

  private paintRoom(): void {
    const doc = this.doc;
    const room = this.room;
    const you = this.you;
    if (doc === null || room === null || you === null) {
      if (this.roomHead !== null) this.roomHead.textContent = "";
      if (this.seatsNode !== null) clear(this.seatsNode);
      if (this.hostControls !== null) clear(this.hostControls);
      if (this.readyButton !== null) this.readyButton.disabled = true;
      if (this.startButton !== null) this.startButton.disabled = true;
      if (this.leaveButton !== null) this.leaveButton.disabled = true;
      return;
    }
    if (this.roomHead !== null) {
      this.roomHead.textContent = `${room.match.name} · ${room.match.mode} · ${mapName(room.match.map_id)} · host ${room.match.host}`;
    }
    if (this.seatsNode !== null) {
      clear(this.seatsNode);
      const ordered = [...room.players].sort((a, b) => a.slot - b.slot);
      for (const seat of ordered) this.seatsNode.append(this.renderSeat(doc, seat, you));
      if (ordered.length === 0) this.seatsNode.append(el(doc, "p", "lobby__empty", "Waiting for players…"));
    }
    this.paintHostControls(doc, room, you);
    if (this.readyButton !== null) {
      this.readyButton.textContent = you.ready ? "Not ready" : "Ready";
      this.readyButton.classList.toggle("btn--primary", !you.ready);
      this.readyButton.disabled = false;
    }
    if (this.leaveButton !== null) this.leaveButton.disabled = false;
    if (this.startButton !== null) {
      const everyoneReady = room.players.length > 0 && room.players.every((seat) => seat.ready);
      const startable = you.is_host && room.players.length >= MIN_PLAYERS && everyoneReady;
      this.startButton.disabled = !startable;
      this.startButton.title = startable
        ? "Start the match"
        : you.is_host
          ? `Needs at least ${MIN_PLAYERS} players, all ready`
          : "Only the host can start";
    }
    this.paintChat();
  }

  private renderSeat(doc: Document, seat: RoomSeat, you: LobbyContext): HTMLElement {
    const row = el(doc, "div", "seat");
    if (seat.player_id === you.player_id) row.classList.add("is-me");
    const slot = el(doc, "span", "seat__slot", String(seat.slot + 1));
    const dot = el(doc, "span", "seat__race");
    dot.style.background = raceColor(seat.race);
    const name = el(doc, "span", "seat__name", seat.name);
    const race = el(doc, "span", "seat__racename", seat.race);
    const ready = el(doc, "span", `seat__ready ${seat.ready ? "is-ready" : ""}`, seat.ready ? "READY" : "not ready");
    row.append(slot, dot, name, race, ready);
    if (seat.is_host) row.append(el(doc, "span", "chip chip--sm", "HOST"));
    if (seat.team > 0) row.append(el(doc, "span", "chip chip--sm", `team ${seat.team}`));
    return row;
  }

  private paintHostControls(doc: Document, room: LobbyRoom, you: LobbyContext): void {
    const host = this.hostControls;
    if (host === null) return;
    if (!you.is_host) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    // Rebuilt only when the match or its map actually changed: the select
    // registers a change listener, and lobby state arrives often.
    const stamp = `${you.match_id}:${room.match.map_id}`;
    if (host.dataset.stamp === stamp) return;
    host.dataset.stamp = stamp;
    clear(host);
    const picker = select<string>(
      doc,
      {
        className: "field__input field__input--sm",
        value: room.match.map_id,
        ariaLabel: "Match map",
        onChange: (value) => {
          void this.gateway.settings(you.match_id, { map_id: value });
        },
      },
      GAME.maps.map((map) => ({ value: map.id, label: map.name })),
      this.teardown,
    );
    host.append(el(doc, "span", "room__hostlabel", "Map"), picker);
  }

  private paintChat(): void {
    const doc = this.doc;
    const host = this.chatNode;
    if (doc === null || host === null) return;
    clear(host);
    const you = this.you;
    for (const line of this.chat) {
      const row = el(doc, "div", "chatline");
      if (you !== null && line.player_id === you.player_id) row.classList.add("is-me");
      row.append(
        el(doc, "span", "chatline__time", clockTime(line.ts)),
        el(doc, "span", "chatline__name", line.name || "player"),
        el(doc, "span", "chatline__text", line.text),
      );
      host.append(row);
    }
    if (this.chat.length === 0) host.append(el(doc, "p", "lobby__empty", "No messages yet."));
    host.scrollTop = host.scrollHeight;
  }

  /* Actions ------------------------------------------------------------- */

  private currentFilters(): LobbyFilters {
    const filters: LobbyFilters = {};
    const mode = this.filterMode?.value ?? "";
    if (mode.length > 0) filters.mode = mode as MatchMode;
    const mapId = this.filterMap?.value ?? "";
    if (mapId.length > 0) filters.map_id = mapId;
    if (this.filterJoinable?.checked === true) filters.only_joinable = true;
    return filters;
  }

  private async joinMatch(matchId: number, hasPassword: boolean): Promise<void> {
    const password = hasPassword ? (this.joinPassword?.value ?? "") : undefined;
    try {
      await this.gateway.join(matchId, password);
    } catch (err) {
      this.host?.notify(err instanceof Error ? err.message : "Could not join that match", "error");
    }
  }

  private async createMatch(): Promise<void> {
    const name = (this.createName?.value ?? "").trim();
    const mapId = this.createMap?.value ?? "";
    if (name.length === 0) {
      this.setCreateStatus("Give the match a name.", true);
      return;
    }
    if (mapId.length === 0) {
      this.setCreateStatus("Pick a map.", true);
      return;
    }
    const max = Number.parseInt(this.createMax?.value ?? "2", 10);
    const body: LobbyCreateBody = {
      name,
      mode: (this.createMode?.value ?? "melee") as MatchMode,
      map_id: mapId,
      max_players: Number.isFinite(max) ? max : MIN_PLAYERS,
    };
    const password = this.createPassword?.value ?? "";
    if (password.length > 0) body.password = password;
    const race = this.createRace?.value ?? "";
    if (race.length > 0) body.race_preference = race as Race;
    this.setCreateStatus("Creating…", false);
    if (this.createButton !== null) this.createButton.disabled = true;
    try {
      await this.gateway.create(body);
      this.setCreateStatus(`Created “${name}”.`, false);
      if (this.createPassword !== null) this.createPassword.value = "";
    } catch (err) {
      this.setCreateStatus(err instanceof Error ? err.message : "Could not create the match", true);
    } finally {
      if (this.createButton !== null) this.createButton.disabled = false;
    }
  }

  private async toggleReady(): Promise<void> {
    if (this.you === null) return;
    try {
      await this.gateway.ready(this.you.match_id, !this.you.ready);
    } catch (err) {
      this.host?.notify(err instanceof Error ? err.message : "Could not update readiness", "error");
    }
  }

  private async startMatch(): Promise<void> {
    if (this.you === null) return;
    try {
      await this.gateway.start(this.you.match_id);
    } catch (err) {
      this.host?.notify(err instanceof Error ? err.message : "Could not start the match", "error");
    }
  }

  private async leaveMatch(): Promise<void> {
    if (this.you === null) return;
    try {
      await this.gateway.leave(this.you.match_id);
    } catch (err) {
      this.host?.notify(err instanceof Error ? err.message : "Could not leave the match", "error");
    }
  }

  private sendChat(): void {
    const input = this.chatInput;
    if (input === null || this.you === null) return;
    const text = input.value.trim();
    if (text.length === 0) return;
    const me = this.room?.players.find((seat) => seat.player_id === this.you?.player_id);
    input.value = "";
    this.appendChat({
      player_id: this.you.player_id,
      name: me?.name ?? "you",
      text,
      ts: this.now(),
    });
    void this.gateway.chat(this.you.match_id, text);
  }

  private ensureRoomData(matchId: number): void {
    if (this.roomFetch === matchId) return;
    this.roomFetch = matchId;
    void this.gateway
      .showMatch(matchId)
      .then((room) => {
        if (this.you === null || this.you.match_id !== matchId) return;
        this.room = room;
        if (room.chat !== undefined) this.chat = room.chat.slice(-CHAT_LIMIT);
        this.paintRoom();
      })
      .catch((err: unknown) => {
        this.host?.notify(err instanceof Error ? err.message : "Could not load the room", "warn");
      });
  }

  private syncMaxPlayers(): void {
    const mapId = this.createMap?.value ?? "";
    if (!hasMap(mapId)) return;
    const cap = mapDef(mapId).max_players;
    if (this.createMax === null) return;
    this.createMax.max = String(cap);
    const current = Number.parseInt(this.createMax.value, 10);
    if (!Number.isFinite(current) || current > cap) this.createMax.value = String(Math.max(MIN_PLAYERS, cap));
    if (current < MIN_PLAYERS) this.createMax.value = String(MIN_PLAYERS);
  }

  private setCreateStatus(message: string, isError: boolean): void {
    if (this.createStatus === null) return;
    this.createStatus.textContent = message;
    this.createStatus.dataset.kind = isError ? "error" : "info";
  }
}

function emptyMatch(id: number): LobbyMatchSummary {
  return {
    id,
    name: `Match #${id}`,
    mode: "melee",
    map_id: GAME.maps[0]?.id ?? "",
    max_players: 2,
    player_count: 0,
    status: "lobby",
    has_password: false,
    host: "",
  };
}

function mapName(id: string): string {
  return hasMap(id) ? mapDef(id).name : id;
}

function clockTime(ts: number): string {
  const date = new Date(ts);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function chip(doc: Document, kind: string, text: string): HTMLElement {
  return el(doc, "span", `chip chip--sm chip--${kind}`, text);
}

function labelled(doc: Document, label: string, input: HTMLElement): HTMLElement {
  const row = el(doc, "label", "field");
  row.append(el(doc, "span", "field__label", label), input);
  return row;
}
