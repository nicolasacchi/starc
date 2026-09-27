/**
 * The application: one state machine from "signed out" to "in a match".
 *
 *   boot → menu → lobby → loading → game → result
 *          ↑                              │
 *          └──────────────────────────────┘
 *
 * Every transition owns its teardown. Leaving the lobby disposes the lobby
 * screen; entering a match builds a `SceneManager` for that match's map and a
 * `GameConnection` for that match's channel; leaving one disposes both and
 * stops the loop, so nothing is left rendering behind the result screen.
 *
 * The wiring is deliberately boring and explicit:
 *
 * - `game:start` is the only thing that opens a match. The loop starts from it,
 *   but `GameConnection.start()` and input attachment wait for the countdown to
 *   expire, so a click during the countdown is buffered rather than lost.
 * - Snapshots feed `GameState`, the single source of truth. The HUD and the
 *   minimap are re-driven from it at the snapshot rate, not per rendered frame.
 * - A rejected command is a UI event as much as a network one: the code picks
 *   the affordance that flashes, and the message always reaches the notifier.
 * - The camera is driven through `RtsCamera` (focus/zoom/rotate) with the focus
 *   point tracked here, so pointer, hotkey and minimap intents land in one
 *   place.
 *
 * Nothing touches `document` before `mount()`, and every collaborator is
 * injectable, so the machine is drivable headlessly.
 */
import { InputController } from "@game/input";
import type { CameraIntent } from "@game/input";
import { ApiClient, authToken } from "@net/api";
import { GameConnection } from "@net/gameConnection";
import type { GameRejectionEvent, GameSnapshotMessage, GameStartMessage } from "@net/gameConnection";
import { LobbyClient } from "@net/lobbyClient";
import type { LobbyFilters, LobbyState } from "@net/lobbyClient";
import { CableTransport } from "@net/transport";
import type { ChannelTransport } from "@net/transport";
import { MAX_ZOOM, MIN_ZOOM } from "@render/core/camera";
import { detectQuality, setForcedQuality, settingsFor } from "@render/core/quality";
import type { QualityPreset } from "@render/core/quality";
import { SceneManager } from "@render/entities/sceneManager";
import { heightField } from "@render/terrain/heightfield";
import type { HeightField } from "@render/terrain/heightfield";
import { GAME, abilitiesOf, entityDef, hasEntityDef, isBuilding, productionOptions } from "@shared/gameData";
import type {
  Command,
  CommandRejectionCode,
  LobbyMatchSummary,
  MapDef,
  ProtocolEntity,
  Race,
} from "@shared/protocol";
import { BuildMenu } from "@ui/buildMenu";
import { Hud } from "@ui/hud";
import { LobbyScreen } from "@ui/lobbyScreen";
import type { LobbyCreateBody, LobbyRoom, LobbySettingsPatch } from "@ui/lobbyScreen";
import { MainMenu } from "@ui/mainMenu";
import { MinimapUi } from "@ui/minimapUi";
import { Notifier } from "@ui/notify";
import { ResultScreen } from "@ui/resultScreen";
import type { ResultSummary } from "@ui/resultScreen";
import { UnitPanel } from "@ui/unitPanel";
import type { CommandSlot, MinimapBlip, QueueItem, ScreenName, SupplyReadout, UiHost } from "@ui/uiTypes";
import { AuthService } from "./auth";
import { GameLoop } from "./gameLoop";
import { GameState } from "./gameState";
import type { EndMessage } from "./gameState";

export type AppScreen = "boot" | "menu" | "lobby" | "loading" | "game" | "result";

/** Command-card slots per page, matching the HUD's grid. */
const SLOTS_PER_PAGE = 9;

/** HUD refresh interval; the wire delivers snapshots at 10 Hz. */
const HUD_INTERVAL_MS = 100;

/** Overlay refresh interval for the net indicator and the F3 readout. */
const OVERLAY_INTERVAL_MS = 250;

/** How long a rejection flash stays lit, ms. */
const FLASH_MS = 320;

/** Which part of the HUD a rejection code should light up. */
type FlashRegion = "resources" | "command" | "selection";

/**
 * Where a rejection flash lands, per region: the resource bar bottom right,
 * the command card bottom centre, or the middle of the viewport.
 */
const FLASH_BOX: Record<FlashRegion, { cssText: string }> = {
  resources: {
    cssText:
      "position:absolute;right:1.5%;bottom:16%;width:22%;height:9%;pointer-events:none;" +
      "border:2px solid #ff5f56;border-radius:4px;box-shadow:0 0 18px rgba(255,95,86,0.6);",
  },
  command: {
    cssText:
      "position:absolute;left:50%;bottom:2%;width:34%;height:16%;transform:translateX(-50%);" +
      "pointer-events:none;border:2px solid #ffb648;border-radius:4px;box-shadow:0 0 18px rgba(255,182,72,0.55);",
  },
  selection: {
    cssText:
      "position:absolute;left:50%;top:50%;width:44%;height:34%;transform:translate(-50%,-50%);" +
      "pointer-events:none;border:2px solid #3fd8ff;border-radius:6px;box-shadow:0 0 18px rgba(63,216,255,0.5);",
  },
};


/** The camera surface the scene exposes (`RtsCamera`). */
interface CameraControls {
  focus(x: number, z: number, worldHeight: number): void;
  /** Slides the view by ground metres. */
  panBy(dx: number, dz: number): void;
  setZoom(zoom: number): void;
  readonly zoom: number;
  rotate(deltaYaw: number): void;
}

export interface AppOptions {
  api?: ApiClient;
  transport?: ChannelTransport;
  /** Cable endpoint; derived from `location` when omitted. */
  cableUrl?: string;
  quality?: QualityPreset;
  now?: () => number;
}

/** A listener registration to undo on teardown. */
interface Cleanup {
  run(): void;
}

export class App implements UiHost {
  private readonly api: ApiClient;
  private readonly transport: ChannelTransport;
  private readonly opts: AppOptions;
  private readonly auth: AuthService;
  private readonly lobby: LobbyClient;
  private readonly notifier: Notifier;

  private state = new GameState();
  private root: HTMLElement | null = null;
  private doc: Document | null = null;
  private win: Window | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private hudHost: HTMLElement | null = null;
  private containers: Partial<Record<ScreenName, HTMLElement>> = {};
  private countdownLayer: HTMLElement | null = null;
  private pauseLayer: HTMLElement | null = null;
  private loadingLayer: HTMLElement | null = null;
  private flashLayer: HTMLElement | null = null;
  private netLayer: HTMLElement | null = null;
  private statsLayer: HTMLElement | null = null;
  private fatalLayer: HTMLElement | null = null;

  private menu: MainMenu | null = null;
  private lobbyScreen: LobbyScreen | null = null;
  private resultScreen: ResultScreen | null = null;
  private hud: Hud | null = null;
  private minimap: MinimapUi | null = null;
  private conn: GameConnection | null = null;
  private scene: SceneManager | null = null;
  private loop: GameLoop | null = null;
  private input: InputController | null = null;
  private terrain: HeightField | null = null;

  /** The lobby screen is mounted once; `openLobby` may be called repeatedly. */
  private lobbyMounted = false;
  private readonly cleanups: Cleanup[] = [];
  private screen: AppScreen = "boot";
  private quality: QualityPreset;
  private paused = false;
  private ended = false;
  private statsVisible = false;

  private matchId = 0;
  private myPlayerId = 0;
  private seatedMatchId = 0;
  private race: Race = "terran";
  private countdownTimer: number | null = null;
  private countdownEndsAtMs = 0;

  private commandPage = 0;
  private commandPages = 1;
  private readonly slots: CommandSlot[] = [];
  private readonly pageSlots: CommandSlot[] = [];
  private readonly queue: QueueItem[] = [];
  /** Locally issued production, reconciled against the server's queue count. */
  private readonly pendingProduction = new Map<number, string[]>();
  private armedRallyFor = 0;

  private readonly cameraIntents: CameraIntent[] = [];
  private lastLobbyState: LobbyState | null = null;

  private readonly blips: MinimapBlip[] = [];
  private hudTimerMs = 0;
  private overlayTimerMs = 0;
  private flashTimer: number | null = null;

  constructor(options: AppOptions = {}) {
    this.opts = options;
    this.api = options.api ?? new ApiClient();
    this.transport = options.transport ?? new CableTransport();
    this.auth = new AuthService(this.api);
    this.lobby = new LobbyClient({ transport: this.transport });
    this.notifier = new Notifier();
    this.quality = options.quality ?? detectQuality();
  }

  get currentScreen(): AppScreen {
    return this.screen;
  }

  get gameState(): GameState {
    return this.state;
  }

  get qualityPreset(): QualityPreset {
    return this.quality;
  }

  /* ------------------------------------------------------------------ mount */

  /**
   * Builds the DOM skeleton, restores the session and shows the menu. Calling it
   * twice disposes the first mount first.
   */
  async mount(root: HTMLElement): Promise<void> {
    if (this.root) this.dispose();
    this.root = root;
    this.doc = root.ownerDocument;
    const doc = this.doc;
    this.win = doc.defaultView;
    root.classList.add("app");
    root.textContent = "";

    const app = doc.createElement("div");
    app.className = "app__inner";
    root.appendChild(app);

    const menuContainer = this.screenContainer(doc, app, "menu");
    this.containers.menu = menuContainer;
    this.containers.lobby = this.screenContainer(doc, app, "lobby");
    this.containers.result = this.screenContainer(doc, app, "result");
    this.buildGameLayer(doc, app);

    const toasts = doc.createElement("div");
    toasts.className = "toasts";
    app.appendChild(toasts);
    this.notifier.mount(toasts);

    this.listen(this.lobby.onState((state) => this.onLobbyState(state)));
    this.listen(this.lobby.onError((err) => this.notify(err.message, err.fatal ? "error" : "warn")));
    this.listen(this.lobby.onChat((line) => this.lobbyScreen?.appendChat(line)));

    const onKeyDown = (ev: KeyboardEvent): void => this.onKeyDown(ev);
    const onUnload = (): void => this.conn?.disconnect();
    this.win?.addEventListener("keydown", onKeyDown);
    this.win?.addEventListener("beforeunload", onUnload);
    this.cleanups.push({ run: () => this.win?.removeEventListener("keydown", onKeyDown) });
    this.cleanups.push({ run: () => this.win?.removeEventListener("beforeunload", onUnload) });

    this.menu = new MainMenu(this, {
      auth: this.auth,
      onPlay: () => void this.openLobby(),
      onSignOut: () => void this.signOut(),
      onLeaderboard: () => void this.showLeaderboard(),
      onQuality: (preset) => this.setQuality(preset),
    });
    this.menu.mount(menuContainer);
    this.menu.show(this.auth.currentPlayer);

    await this.auth.restored;
    if (this.root !== root) return; // disposed while the session check was in flight
    this.menu.show(this.auth.currentPlayer);
    this.setScreen("menu");
  }

  private listen(unsubscribe: () => void): void {
    this.cleanups.push({ run: unsubscribe });
  }

  private screenContainer(doc: Document, parent: HTMLElement, name: ScreenName): HTMLElement {
    const node = doc.createElement("div");
    node.className = `screen screen--${name}`;
    node.dataset.screen = name;
    node.style.display = "none";
    parent.appendChild(node);
    return node;
  }

  /** Canvas, HUD host, and every overlay the loop draws over. */
  private buildGameLayer(doc: Document, parent: HTMLElement): void {
    const layer = this.screenContainer(doc, parent, "game");

    const canvas = doc.createElement("canvas");
    canvas.className = "canvas";
    canvas.tabIndex = 0;
    layer.appendChild(canvas);
    this.canvas = canvas;

    const hudHost = doc.createElement("div");
    hudHost.className = "hud";
    layer.appendChild(hudHost);
    this.hudHost = hudHost;

    this.countdownLayer = this.overlay(doc, layer, "countdown");
    this.flashLayer = this.overlay(doc, layer, "flash");
    this.pauseLayer = this.overlay(doc, layer, "pause");
    this.loadingLayer = this.overlay(doc, layer, "loading");
    this.netLayer = this.overlay(doc, layer, "net");
    this.statsLayer = this.overlay(doc, layer, "stats");
    this.fatalLayer = this.overlay(doc, layer, "fatal");
  }

  private overlay(doc: Document, parent: HTMLElement, className: string): HTMLElement {
    const node = doc.createElement("div");
    node.className = className;
    node.style.display = "none";
    parent.appendChild(node);
    return node;
  }

  /* ----------------------------------------------------------------- UiHost */

  show(screen: ScreenName): void {
    this.setScreen(screen);
  }

  notify(message: string, kind: "info" | "warn" | "error" = "info"): void {
    this.notifier.notify(message, kind);
  }

  private setScreen(screen: AppScreen): void {
    this.screen = screen;
    // "boot" has no screen of its own and "loading" is the game screen wearing
    // a curtain, so both map onto the containers that already exist.
    const visible: ScreenName | null =
      screen === "game" || screen === "loading" ? "game" : screen === "boot" ? null : screen;
    for (const [name, node] of Object.entries(this.containers)) {
      if (node) node.style.display = name === visible ? "" : "none";
    }
    if (this.countdownLayer) {
      this.countdownLayer.style.display = screen === "game" && this.countdownTimer !== null ? "" : "none";
    }
    if (this.pauseLayer) this.pauseLayer.style.display = screen === "game" && this.paused ? "" : "none";
    if (this.loadingLayer) this.loadingLayer.style.display = screen === "loading" ? "" : "none";
    if (screen === "game" || screen === "loading") this.canvas?.focus();
  }

  /* ------------------------------------------------------------------- menu */

  private async signOut(): Promise<void> {
    await this.auth.logout();
    this.menu?.show(null);
    this.notify("Signed out", "info");
  }

  private async showLeaderboard(): Promise<void> {
    try {
      const board = await this.api.leaderboard({ limit: 5 });
      const rows = board.entries.map((e) => `${e.rank}. ${e.name} — ${e.rating} (${e.wins}W/${e.losses}L)`);
      this.notify(rows.length > 0 ? rows.join("   ") : "No ranked matches yet", "info");
    } catch (err) {
      this.notify(errorMessage(err), "error");
    }
  }

  setQuality(preset: QualityPreset): void {
    this.quality = preset;
    setForcedQuality(preset);
    this.scene?.setQuality(preset);
  }

  /* ------------------------------------------------------------------ lobby */

  private async openLobby(): Promise<void> {
    if (!this.auth.isAuthenticated) {
      this.notify("Sign in to play", "warn");
      return;
    }
    const token = authToken();
    if (token === null) {
      this.notify("No session token — sign in again", "error");
      return;
    }
    const container = this.containers.lobby;
    if (!container) return;
    this.setScreen("lobby");
    this.lobbyScreen ??= this.createLobbyScreen();
    if (!this.lobbyMounted) {
      this.lobbyScreen.mount(container);
      this.lobbyMounted = true;
    }
    this.lobbyScreen.setVisible(true);
    try {
      await this.transport.connect(this.cableUrl(), token);
      this.lobby.list();
    } catch (err) {
      this.notify(errorMessage(err), "error");
      this.setScreen("menu");
    }
  }

  /**
   * Bridges the lobby screen's gateway onto the cable client and the REST API.
   * The gateway is promise-shaped and the cable client is fire-and-forget, so
   * every call resolves as soon as the message is queued; the authoritative
   * answer arrives as a `lobby:state` broadcast.
   */
  private createLobbyScreen(): LobbyScreen {
    return new LobbyScreen({
      connect: async () => {
        await this.transport.connect(this.cableUrl(), authToken() ?? "");
      },
      disconnect: () => this.transport.close(),
      list: async (filters?: LobbyFilters) => void this.lobby.list(filters),
      create: async (body: LobbyCreateBody) => void this.lobby.create(body),
      join: async (matchId: number, password?: string) => void this.lobby.join(matchId, password),
      leave: async (matchId: number) => void this.lobby.leave(matchId),
      ready: async (matchId: number, ready: boolean) => void this.lobby.ready(matchId, ready),
      start: async (matchId: number) => {
        this.lobby.start(matchId);
        this.beginMatch(this.matchSummary(matchId));
      },
      chat: async (matchId: number, text: string) => void this.lobby.chat(text, matchId),
      settings: async (matchId: number, patch: LobbySettingsPatch) => void this.lobby.settings(patch, matchId),
      showMatch: (matchId: number) => this.fetchRoom(matchId),
      onState: (handler) => this.lobby.onState(handler),
      onError: (handler) => this.lobby.onError(handler),
    });
  }

  private matchSummary(matchId: number): LobbyMatchSummary | null {
    return this.lastLobbyState?.matches.find((m) => m.id === matchId) ?? null;
  }

  private async fetchRoom(matchId: number): Promise<LobbyRoom> {
    const { match } = await this.api.showMatch(matchId);
    return {
      match,
      players: match.players.map((seat) => ({
        player_id: seat.player_id,
        name: seat.name,
        race: seat.race,
        ready: seat.ready,
        is_host: seat.host,
        slot: seat.slot,
        team: seat.team,
      })),
    };
  }

  private onLobbyState(state: LobbyState): void {
    this.lastLobbyState = state;
    this.lobbyScreen?.update({ matches: state.matches, you: state.you });
    if (state.you === null) {
      this.seatedMatchId = 0;
      this.lobbyScreen?.setRoom(null);
      return;
    }
    if (state.you.match_id !== this.seatedMatchId) {
      this.seatedMatchId = state.you.match_id;
      this.myPlayerId = state.you.player_id;
      this.race = state.you.race;
      void this.refreshRoom(state.you.match_id);
    }
    const match = this.matchSummary(state.you.match_id);
    // The host tears the lobby down on the click; everybody else waits for the
    // broadcast to say the match has gone in progress.
    if (match && match.status === "in_progress") this.beginMatch(match);
  }

  private async refreshRoom(matchId: number): Promise<void> {
    try {
      this.lobbyScreen?.setRoom(await this.fetchRoom(matchId));
    } catch (err) {
      this.notify(errorMessage(err), "warn");
    }
  }

  /* ------------------------------------------------------------- match entry */

  private beginMatch(match: LobbyMatchSummary | null): void {
    if (match === null) {
      this.notify("The match is starting but its details never arrived — back to the lobby", "error");
      return;
    }
    if (this.screen === "loading" || this.screen === "game") return;
    const map = GAME.maps.find((m) => m.id === match.map_id);
    if (!map) {
      this.showFatal(`Unknown map "${match.map_id}" — the shared roster has no such map.`);
      return;
    }
    if (authToken() === null) {
      this.showFatal("Your session expired. Return to the menu and sign in again.");
      return;
    }
    if (!this.webglAvailable()) {
      this.showFatal(
        "This browser could not create a WebGL context, so the game world cannot be drawn. " +
          "Enable hardware acceleration, or try a different browser.",
      );
      return;
    }

    const canvas = this.canvas;
    const hudHost = this.hudHost;
    if (!canvas || !hudHost) {
      this.showFatal("The game canvas is missing from the page, so there is nothing to draw on.");
      return;
    }

    this.matchId = match.id;
    this.ended = false;
    this.paused = false;
    this.commandPage = 0;
    this.armedRallyFor = 0;
    this.pendingProduction.clear();
    this.state = new GameState(this.myPlayerId);

    // The lobby is gone for good: the match owns the screen from here.
    this.lobbyScreen?.dispose();
    this.lobbyScreen = null;
    this.lobbyMounted = false;
    this.seatedMatchId = 0;

    this.buildMatchScene(map, match, canvas, hudHost);
    const token = authToken();
    this.conn = new GameConnection({
      url: this.cableUrl(),
      token: token ?? "",
      transport: this.transport,
      playerId: this.myPlayerId,
    });
    this.conn.onStart((msg) => this.onGameStart(msg));
    this.conn.onSnapshot((msg) => this.onSnapshot(msg));
    this.conn.onEnd((msg) => this.onGameEnd(msg));
    this.conn.onReject((event) => this.onReject(event));
    this.conn.onError((error) => this.notify(error.message, "warn"));
    this.conn.onStateChange((connState) => {
      if (connState === "reconnecting") this.notify("Connection lost — reconnecting…", "warn");
    });

    this.setScreen("loading");
    this.renderLoading(`Deploying to ${map.name}…`);
    void this.conn.connect(match.id).catch((err: unknown) => {
      this.showFatal(`Could not reach the match server: ${errorMessage(err)}`);
    });
  }

  /** Builds the world, the HUD and the input layer for a fresh match. */
  private buildMatchScene(
    map: MapDef,
    match: LobbyMatchSummary,
    canvas: HTMLCanvasElement,
    hudHost: HTMLElement,
  ): void {
    const scene = new SceneManager(canvas, map, settingsFor(this.quality), this.myPlayerId);
    this.scene = scene;
    this.terrain = heightField(map);

    this.minimap = new MinimapUi({
      onWorldPoint: (x, z, rightClick) => this.onMinimapPoint(x, z, rightClick),
      onSelectUnits: (ids) => this.input?.selection.set(ids),
      worldSize: map.size,
    });
    this.hud = new Hud(
      {
        onAbility: (ability) => this.sendAbility(ability),
        onTrain: (unitType) => this.sendTrain(unitType),
        onCancelProduction: (buildingId) => this.cancelProduction(buildingId),
        onSetRally: (buildingId) => this.armRally(buildingId),
        onHotkeyHelp: () =>
          this.notify("A select army · S stop · H hold · P patrol · Ctrl+1-9 assign · 1-9 recall · Esc cancel"),
        onMenu: () => this.setPaused(true),
        onPage: (page) => {
          this.commandPage = clamp(page, 0, Math.max(0, this.commandPages - 1));
          this.refreshCommandCard();
        },
        onSelectEntity: (id) => this.input?.selection.set([id]),
        onSelectWorker: () => this.selectWorkers(),
      },
      {
        minimap: this.minimap,
        unitPanel: new UnitPanel({
          onCancelProduction: (buildingId) => this.cancelProduction(buildingId),
          onSetRally: (buildingId) => this.armRally(buildingId),
          onAbility: (entityId, abilityKey) => this.sendAbilityTo(entityId, abilityKey),
        }),
        buildMenu: new BuildMenu({
          onBeginPlacement: (unitType) => this.input?.beginPlacement(unitType),
        }),
        race: this.race,
      },
    );
    this.hud.mount(hudHost);
    this.minimap.setMap(map);
    this.hud.setMatchInfo({ mapName: map.name, mode: match.mode, players: match.max_players });

    this.input = new InputController({
      element: canvas,
      scene,
      terrain: this.terrain,
      getEntities: () => this.state.entities(),
      myPlayerId: this.myPlayerId,
      send: (commands) => this.send(commands),
      onSelectionChange: (ids) => this.onSelection(ids),
      onCameraIntent: (intent) => this.cameraIntents.push(intent),
      // The controller's own animation loop is not scheduled: the game loop
      // already drives `step(dt)` with a fixed timestep, and two loops would
      // pan twice as fast.
      requestFrame: () => 0,
      cancelFrame: () => {},
    });
  }

  /** The mineral chip jumps to the economy: every worker we own. */
  private selectWorkers(): void {
    const workers: number[] = [];
    for (const e of this.state.ownEntities()) {
      if (e.st === "dead" || !hasEntityDef(e.ty)) continue;
      const def = entityDef(e.ty);
      if (def.kind === "unit" && def.harvest) workers.push(e.id);
    }
    if (workers.length === 0) {
      this.notify("No workers yet", "warn");
      return;
    }
    this.input?.selection.set(workers);
  }

  /* ------------------------------------------------------------------- start */

  private onGameStart(msg: GameStartMessage): void {
    this.matchId = msg.match_id;
    this.state.start(msg);
    if (this.myPlayerId === 0) {
      // The lobby context is the only place the server names *our* seat; when it
      // never arrived, slot 0 is the documented fallback rather than nobody.
      this.myPlayerId = msg.players[0]?.player_id ?? 0;
      this.notify("Your seat id was never announced; assuming slot 0", "warn");
      this.state.setMyPlayerId(this.myPlayerId);
    }
    this.race = this.state.raceOf(this.myPlayerId) ?? this.race;
    if (this.scene) this.scene.myPlayerId = this.myPlayerId;
    this.input?.setMyPlayerId(this.myPlayerId);
    this.input?.setRace(this.race);
    this.hud?.setRace(this.race);
    const start = msg.players.find((p) => p.player_id === this.myPlayerId)?.start;
    if (start) this.sceneCamera()?.focus(start.x, start.z, this.groundHeight(start.x, start.z));

    this.setScreen("game");
    this.startCountdown(msg.countdown_ms);
    this.startLoop();
  }

  private startCountdown(countdownMs: number): void {
    this.cancelCountdown();
    const layer = this.countdownLayer;
    const doc = this.doc;
    if (!layer || !doc) return;
    this.countdownEndsAtMs = this.nowMs() + countdownMs;
    const label = doc.createElement("p");
    label.className = "countdown__label";
    label.textContent = "Match begins in";
    const number = doc.createElement("p");
    number.className = "countdown__number";
    layer.textContent = "";
    layer.appendChild(label);
    layer.appendChild(number);
    this.countdownTimer =
      this.win?.setInterval(() => {
        const left = Math.max(0, this.countdownEndsAtMs - this.nowMs());
        number.textContent = String(Math.ceil(left / 1000));
        if (left > 0) return;
        // The match is open: the connection may flush and input may attach.
        this.cancelCountdown();
        layer.style.display = "none";
        this.conn?.start();
        this.input?.attach();
      }, 100) ?? null;
    layer.style.display = "";
  }

  private cancelCountdown(): void {
    if (this.countdownTimer !== null) {
      this.win?.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  /* -------------------------------------------------------------------- loop */

  private startLoop(): void {
    if (this.loop) {
      this.loop.start();
      return;
    }
    this.loop = new GameLoop({
      update: (dt) => this.stepFrame(dt),
      render: (frameDt) => this.renderFrame(frameDt),
      now: () => this.nowMs(),
    });
    this.loop.start();
  }

  /** Fixed-step work: input hold-state, camera intents and the world update. */
  private stepFrame(dt: number): void {
    this.applyCameraIntents();
    this.input?.step(dt);
    this.scene?.update(dt);
  }

  /** Once-per-frame work: draw, then refresh the overlay readouts. */
  private renderFrame(frameDt: number): void {
    this.scene?.render();
    // The connection runs its own fixed tick for prediction, metrics and the
    // 20 Hz send cap; one call per rendered frame keeps them in step.
    this.conn?.tick(frameDt * 1000);
    if (this.paused) return;
    this.hudTimerMs += frameDt * 1000;
    if (this.hudTimerMs >= HUD_INTERVAL_MS) {
      this.hudTimerMs = 0;
      this.refreshHud();
    }
    this.overlayTimerMs += frameDt * 1000;
    if (this.overlayTimerMs >= OVERLAY_INTERVAL_MS) {
      this.overlayTimerMs = 0;
      this.refreshNetOverlay();
    }
  }

  private setPaused(paused: boolean): void {
    if (this.paused === paused || this.screen !== "game") return;
    this.paused = paused;
    if (paused) {
      this.loop?.stop();
      this.input?.detach();
      this.renderPauseOverlay();
      if (this.pauseLayer) this.pauseLayer.style.display = "";
    } else {
      if (this.pauseLayer) this.pauseLayer.style.display = "none";
      this.input?.attach();
      this.loop?.start();
    }
  }

  private renderPauseOverlay(): void {
    const layer = this.pauseLayer;
    const doc = this.doc;
    if (!layer || !doc) return;
    layer.textContent = "";
    const title = doc.createElement("h2");
    title.className = "pause__title";
    title.textContent = "Paused";
    layer.appendChild(title);
    layer.appendChild(this.actionButton(doc, "Resume", () => this.setPaused(false)));
    layer.appendChild(
      this.actionButton(doc, "Forfeit match", () => this.conn?.forfeit("forfeited from the pause menu")),
    );
    layer.appendChild(this.actionButton(doc, "Leave to menu", () => this.leaveToMenu(), "danger"));
    const hint = doc.createElement("p");
    hint.className = "pause__hint";
    hint.textContent = "Esc resumes · F3 toggles the net readout";
    layer.appendChild(hint);
  }

  private actionButton(
    doc: Document,
    label: string,
    onClick: () => void,
    variant: "primary" | "ghost" | "danger" = "primary",
  ): HTMLButtonElement {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = `btn btn--${variant}`;
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  /* ---------------------------------------------------------------- snapshots */

  private onSnapshot(msg: GameSnapshotMessage): void {
    if (!this.state.started) return;
    this.state.applySnapshot({ tick: msg.tick, entities: msg.entities, events: msg.events });
    this.state.setAck(msg.ack);
    this.refreshHud();
    for (const event of msg.events) {
      this.scene?.playEvents([event]);
      if (event.e === "alert") this.hud?.alert(event.text, "warn");
    }
  }

  private onGameEnd(msg: EndMessage): void {
    if (this.ended) return;
    this.ended = true;
    this.state.end(msg);
    this.loop?.stop();
    this.cancelCountdown();
    this.input?.detach();
    this.setScreen("result");

    const container = this.containers.result;
    if (!this.resultScreen && container) {
      this.resultScreen = new ResultScreen({
        onReplay: (url) => this.openReplay(url),
        onRematch: () => void this.rematch(),
        onMenu: () => {
          this.leaveToMenu();
          this.show("menu");
        },
      });
      this.resultScreen.mount(container);
    }
    const summary: ResultSummary = {
      winner: msg.winner,
      myPlayerId: this.myPlayerId,
      reason: msg.reason,
      durationMs: msg.duration_ms,
      scores: msg.scores,
      replayUrl: msg.replay_url,
      tick: msg.tick,
    };
    this.resultScreen?.show(summary);
    this.resultScreen?.setVisible(true);
  }

  private openReplay(url: string): void {
    if (url.length === 0) {
      this.notify("No replay was recorded for this match", "warn");
      return;
    }
    this.win?.open(url, "_blank", "noopener");
  }

  private async rematch(): Promise<void> {
    const finished = this.matchId;
    this.teardownMatch();
    if (finished > 0) {
      try {
        await this.api.leaveMatch(finished);
      } catch (err) {
        this.notify(errorMessage(err), "warn");
      }
    }
    await this.openLobby();
  }

  private leaveToMenu(): void {
    this.teardownMatch();
    this.setScreen("menu");
  }

  /** Releases everything a match owns: loop, input, scene, HUD, connection. */
  private teardownMatch(): void {
    this.loop?.stop();
    this.loop = null;
    this.cancelCountdown();
    this.input?.dispose();
    this.input = null;
    this.hud?.dispose();
    this.hud = null;
    this.minimap = null;
    this.scene?.dispose();
    this.scene = null;
    this.terrain = null;
    this.conn?.dispose();
    this.conn = null;
    this.state.dispose();
    this.pendingProduction.clear();
    this.cameraIntents.length = 0;
    for (const layer of [this.pauseLayer, this.loadingLayer, this.countdownLayer, this.fatalLayer]) {
      if (layer) layer.style.display = "none";
    }
    this.paused = false;
    this.ended = false;
    this.statsVisible = false;
    if (this.statsLayer) this.statsLayer.style.display = "none";
  }

  /* ------------------------------------------------------------------ inputs */

  /** Routes a batch, intercepting one armed rally point. */
  private send(commands: Command[]): void {
    if (this.armedRallyFor > 0) {
      const buildingId = this.armedRallyFor;
      this.armedRallyFor = 0;
      this.hud?.setRallyMode(null);
      const ground = commands.find((c) => c.c === "move");
      if (ground && ground.c === "move") {
        this.conn?.send([{ c: "rally", building_id: buildingId, x: ground.x, z: ground.z }]);
        return;
      }
    }
    this.conn?.send(commands);
  }

  private armRally(buildingId: number): void {
    this.armedRallyFor = buildingId;
    this.hud?.setRallyMode(buildingId);
    this.notify("Click the ground to set the rally point", "info");
  }

  private onMinimapPoint(x: number, z: number, rightClick: boolean): void {
    if (rightClick) {
      const ids = this.state.selection();
      if (ids.length > 0) this.conn?.send([{ c: "move", ids, x, z }]);
      return;
    }
    this.cameraIntents.push({ kind: "focus", x, z, height: 0 });
  }

  private onSelection(ids: number[]): void {
    this.state.setSelection(ids);
    this.scene?.setSelection(ids, ids.length > 0 ? this.state.relationTo(ids[0]) : "own");
    this.refreshHud();
  }

  private onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === "F3") {
      ev.preventDefault();
      this.toggleStats();
      return;
    }
    if (ev.key !== "Escape" || this.screen !== "game") return;
    // The hotkey table binds Escape to cancel as well; taking the event here
    // means one press means one thing — cancel the ghost, or pause.
    ev.preventDefault();
    ev.stopPropagation();
    if (this.input?.mode === "placing") {
      this.input.cancelPlacement();
      this.armedRallyFor = 0;
      this.hud?.setRallyMode(null);
    } else if (this.paused) {
      this.setPaused(false);
    } else {
      this.setPaused(true);
    }
  }

  private toggleStats(): void {
    if (!this.statsLayer) return;
    this.statsVisible = !this.statsVisible;
    this.statsLayer.style.display = this.statsVisible ? "" : "none";
    if (this.statsVisible) this.refreshNetOverlay();
  }

  /**
   * Camera intents are drained once per fixed step. The camera owns its own
   * focus and zoom, so a pan is a relative nudge and a zoom is a notch applied
   * to the current level rather than a value tracked here.
   */
  private applyCameraIntents(): void {
    if (this.cameraIntents.length === 0) return;
    const camera = this.sceneCamera();
    for (const intent of this.cameraIntents) {
      switch (intent.kind) {
        case "pan":
          camera?.panBy(intent.dx, intent.dz);
          break;
        case "focus":
          camera?.focus(intent.x, intent.z, intent.height);
          break;
        case "zoom":
          if (camera) camera.setZoom(clamp(camera.zoom * Math.pow(0.88, intent.steps), MIN_ZOOM, MAX_ZOOM));
          break;
        case "rotate":
          camera?.rotate(intent.radians);
          break;
      }
    }
    this.cameraIntents.length = 0;
  }

  private sceneCamera(): CameraControls | null {
    const scene = this.scene as unknown as { camera?: CameraControls } | null;
    return scene?.camera ?? null;
  }

  private groundHeight(x: number, z: number): number {
    return this.terrain?.sample(x, z) ?? 0;
  }

  /* --------------------------------------------------------------------- HUD */

  private refreshHud(): void {
    const hud = this.hud;
    if (!hud) return;
    const used = this.state.supply();
    const cap = this.state.supplyMax();
    const supply: SupplyReadout = { used, cap, blocked: used >= cap };
    const selectionIds = this.state.selection();
    const selected: ProtocolEntity[] = [];
    for (const id of selectionIds) {
      const entity = this.state.entity(id);
      if (entity) selected.push(entity);
    }

    hud.setResources(this.state.minerals(), this.state.vespene());
    hud.setSupply(supply);
    hud.setSelection(selected, selectionIds.length > 0 ? this.state.relationTo(selectionIds[0]) : "own");
    this.refreshQueue();
    this.refreshCommandCard();
    this.refreshMinimap(selectionIds);
  }

  private refreshMinimap(selectionIds: readonly number[]): void {
    const minimap = this.minimap;
    if (!minimap) return;
    const selected = new Set(selectionIds);
    const blips = this.blips;
    blips.length = 0;
    for (const e of this.state.entities()) {
      if (e.st === "dead" || !hasEntityDef(e.ty)) continue;
      blips.push({
        id: e.id,
        x: e.x,
        z: e.z,
        relation: this.state.relationOfPlayer(e.pl),
        kind: isBuilding(e.ty) ? "building" : "unit",
        selected: selected.has(e.id),
      });
    }
    minimap.setBlips(blips);
    const rect = this.viewportRect();
    if (rect) minimap.setViewport(rect);
  }

  /**
   * The world rectangle the camera can see, found by unprojecting the four
   * canvas corners through the ground plane. Corners that miss the ground
   * (looking at the sky) are skipped; fewer than two survivors means there is
   * no rectangle worth drawing, so the last one stands.
   */
  private viewportRect(): { x: number; z: number; w: number; h: number } | null {
    const canvas = this.canvas;
    const scene = this.scene;
    if (!canvas || !scene) return null;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width < 2 || bounds.height < 2) return null;
    const out = { x: 0, z: 0 };
    let minX = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    let hits = 0;
    for (const corner of [
      [0, 0],
      [bounds.width, 0],
      [0, bounds.height],
      [bounds.width, bounds.height],
    ]) {
      if (!scene.screenToGround(bounds.left + corner[0], bounds.top + corner[1], out)) continue;
      hits++;
      if (out.x < minX) minX = out.x;
      if (out.x > maxX) maxX = out.x;
      if (out.z < minZ) minZ = out.z;
      if (out.z > maxZ) maxZ = out.z;
    }
    return hits < 2 ? null : { x: minX, z: minZ, w: maxX - minX, h: maxZ - minZ };
  }

  /**
   * Rebuilds the command card from the roster for the primary selection, nine
   * slots to a page. Affordability uses the same derived totals the HUD shows;
   * the server still has the last word on what it accepts.
   */
  private refreshCommandCard(): void {
    const hud = this.hud;
    if (!hud) return;
    const slots = this.slots;
    slots.length = 0;
    const minerals = this.state.minerals();
    const vespene = this.state.vespene();
    const supplyBlocked = this.state.supply() >= this.state.supplyMax();
    const primaryId = this.state.selection()[0];
    const primary = primaryId === undefined ? undefined : this.state.entity(primaryId);
    if (primary && this.state.isOwner(primary.id) && hasEntityDef(primary.ty)) {
      for (const ability of abilitiesOf(primary.ty)) {
        const cost = ability.cost ?? 0;
        const affordable = minerals >= cost;
        slots.push({
          key: ability.key,
          label: ability.name,
          icon: primary.ty,
          kind: "ability",
          minerals: cost,
          cooldownTotal: ability.cooldown,
          disabled: !affordable,
          reason: affordable ? undefined : `Needs ${cost} minerals`,
        });
      }
      const def = entityDef(primary.ty);
      if (def.kind === "building") {
        for (const key of productionOptions(primary.ty)) {
          const unit = entityDef(key);
          const affordable =
            minerals >= unit.cost.minerals && vespene >= unit.cost.vespene && !supplyBlocked;
          slots.push({
            key,
            label: unit.name,
            icon: key,
            kind: "train",
            hotkey: unit.hotkey,
            minerals: unit.cost.minerals,
            vespene: unit.cost.vespene,
            supply: unit.cost.supply,
            disabled: !affordable,
            reason: supplyBlocked ? "Supply blocked" : affordable ? undefined : "Not enough resources",
          });
        }
      }
      const buildMenu = hud.buildMenu;
      if (buildMenu) {
        buildMenu.setResources(minerals, vespene);
        buildMenu.setOwnedBuildingKeys(this.ownedBuildingKeys());
        buildMenu.show(primary.ty, this.race);
      }
    } else {
      hud.buildMenu?.hide();
    }
    this.commandPages = Math.max(1, Math.ceil(slots.length / SLOTS_PER_PAGE));
    this.commandPage = clamp(this.commandPage, 0, this.commandPages - 1);
    this.pageSlots.length = 0;
    const start = this.commandPage * SLOTS_PER_PAGE;
    for (let i = start; i < Math.min(start + SLOTS_PER_PAGE, slots.length); i++) {
      this.pageSlots.push(slots[i]);
    }
    hud.setCommandCard(this.commandPages, this.commandPage, this.pageSlots);
  }

  private ownedBuildingKeys(): string[] {
    const keys: string[] = [];
    for (const e of this.state.ownEntities()) {
      if (e.st === "dead" || (e.prog ?? 1) < 1) continue;
      if (hasEntityDef(e.ty) && isBuilding(e.ty)) keys.push(e.ty);
    }
    return keys;
  }

  /**
   * The wire carries a queue *count* and a progress fraction, never the key
   * being built, so the rows come from what we asked to train and are trimmed
   * to whatever the server says is actually queued.
   */
  private refreshQueue(): void {
    const hud = this.hud;
    if (!hud) return;
    const items = this.queue;
    items.length = 0;
    for (const e of this.state.ownEntities()) {
      if (e.n === undefined || e.n <= 0 || !hasEntityDef(e.ty) || !isBuilding(e.ty)) continue;
      const wanted = this.pendingProduction.get(e.id);
      if (wanted && wanted.length > e.n) wanted.length = e.n;
      const key = wanted?.[0] ?? e.ty;
      const def = entityDef(key);
      const progress = e.prog ?? 0;
      items.push({
        entityId: e.id,
        type: key,
        label: def.name,
        progress,
        remaining: Math.max(0, def.build_time * (1 - progress)),
        cancellable: true,
      });
    }
    hud.setQueue(items);
  }

  /* ---------------------------------------------------------------- commands */

  private sendAbility(abilityKey: string): void {
    const ids = this.state.selection();
    if (ids.length > 0) this.send([{ c: "ability", ids, ability: abilityKey }]);
  }

  /** The inspector activates an ability on one specific entity. */
  private sendAbilityTo(entityId: number, abilityKey: string): void {
    this.send([{ c: "ability", ids: [entityId], ability: abilityKey }]);
  }

  private sendTrain(unitType: string): void {
    const buildingId = this.state.selection()[0];
    if (buildingId === undefined) return;
    const queued = this.pendingProduction.get(buildingId) ?? [];
    queued.push(unitType);
    this.pendingProduction.set(buildingId, queued);
    this.send([{ c: "train", building_id: buildingId, unit_type: unitType, count: 1 }]);
  }

  /** Cancels the head of a building's queue and drops it from our tracking. */
  private cancelProduction(buildingId: number): void {
    const queued = this.pendingProduction.get(buildingId);
    if (queued && queued.length > 0) queued.shift();
    this.send([{ c: "cancel", building_id: buildingId }]);
  }

  private onReject(event: GameRejectionEvent): void {
    for (const rejection of event.rejections) {
      this.notify(rejection.message, rejection.code === "insufficient_resources" ? "warn" : "error");
      this.flash(flashRegionFor(rejection.code));
    }
  }

  /**
   * Lights the affordance a rejection code refers to, for a moment. The box is
   * positioned over the HUD region the code implicates, so "not enough
   * minerals" flashes the resource bar and a bad entity id flashes the
   * viewport. Styling lives here because the overlay is ours, not the HUD's.
   */
  private flash(region: FlashRegion): void {
    const layer = this.flashLayer;
    const win = this.win;
    if (!layer || !win) return;
    const box = FLASH_BOX[region];
    layer.dataset.region = region;
    layer.style.cssText = box.cssText;
    layer.style.display = "block";
    if (this.flashTimer !== null) win.clearTimeout(this.flashTimer);
    this.flashTimer = win.setTimeout(() => {
      this.flashTimer = null;
      layer.style.display = "none";
    }, FLASH_MS);
  }

  /* ---------------------------------------------------------------- overlays */

  private refreshNetOverlay(): void {
    const metrics = this.conn?.metrics;
    if (this.netLayer) {
      const report = metrics?.snapshot(this.nowMs());
      const quality = report === undefined ? "offline" : connectionQuality(report.rttMs, report.droppedFrames);
      this.netLayer.textContent = `net ${quality}`;
      this.netLayer.dataset.quality = quality;
    }
    if (this.statsLayer && this.statsVisible) {
      this.statsLayer.textContent =
        metrics === undefined
          ? "no game connection"
          : `${metrics.format(this.nowMs())}\nrender ${this.loop?.fps.toFixed(0) ?? "0"} fps · tick ${this.state.tick}`;
    }
  }

  private renderLoading(message: string): void {
    const layer = this.loadingLayer;
    const doc = this.doc;
    if (!layer || !doc) return;
    layer.textContent = "";
    const title = doc.createElement("p");
    title.className = "loading__title";
    title.textContent = message;
    const hint = doc.createElement("p");
    hint.className = "loading__hint";
    hint.textContent = "Waiting for the server to open the match…";
    layer.appendChild(title);
    layer.appendChild(hint);
  }

  /** Replaces every screen with a message the player can act on. */
  private showFatal(message: string): void {
    const layer = this.fatalLayer;
    const doc = this.doc;
    if (!layer || !doc) {
      this.notify(message, "error");
      return;
    }
    for (const node of Object.values(this.containers)) {
      if (node) node.style.display = "none";
    }
    layer.textContent = "";
    layer.style.display = "";
    const title = doc.createElement("h2");
    title.className = "fatal__title";
    title.textContent = "Cannot start the game";
    const body = doc.createElement("p");
    body.className = "fatal__body";
    body.textContent = message;
    layer.appendChild(title);
    layer.appendChild(body);
    layer.appendChild(
      this.actionButton(doc, "Back to menu", () => {
        layer.style.display = "none";
        this.teardownMatch();
        this.setScreen("menu");
      }),
    );
  }

  /* ---------------------------------------------------------------- plumbing */

  private webglAvailable(): boolean {
    const canvas = this.canvas;
    if (!canvas) return false;
    try {
      return canvas.getContext("webgl2") !== null || canvas.getContext("webgl") !== null;
    } catch {
      return false;
    }
  }

  private cableUrl(): string {
    if (this.opts.cableUrl !== undefined) return this.opts.cableUrl;
    const loc = globalThis.location;
    const scheme = loc !== undefined && loc.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${loc?.host ?? "127.0.0.1:3000"}/cable`;
  }

  private nowMs(): number {
    return this.opts.now !== undefined ? this.opts.now() : Date.now();
  }

  dispose(): void {
    this.teardownMatch();
    this.menu?.dispose();
    this.menu = null;
    this.lobbyScreen?.dispose();
    this.lobbyScreen = null;
    this.lobbyMounted = false;
    this.lastLobbyState = null;
    this.resultScreen?.dispose();
    this.resultScreen = null;
    this.notifier.dispose();
    for (const cleanup of this.cleanups.splice(0)) cleanup.run();
    if (this.flashTimer !== null) {
      this.win?.clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
    this.transport.close();
    this.state.dispose();
    if (this.root) {
      this.root.textContent = "";
      this.root.classList.remove("app");
    }
    this.root = null;
    this.containers = {};
    this.canvas = null;
    this.hudHost = null;
    this.countdownLayer = null;
    this.pauseLayer = null;
    this.loadingLayer = null;
    this.flashLayer = null;
    this.netLayer = null;
    this.statsLayer = null;
    this.fatalLayer = null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Which HUD region a rejection code belongs to. */
function flashRegionFor(code: CommandRejectionCode): FlashRegion {
  switch (code) {
    case "insufficient_resources":
    case "production_busy":
    case "queue_full":
    case "cooldown":
    case "not_ready":
      return "resources";
    case "no_such_unit_type":
    case "no_such_ability":
    case "invalid_payload":
      return "command";
    default:
      return "selection";
  }
}

function connectionQuality(rttMs: number, droppedFrames: number): "good" | "fair" | "poor" {
  if (rttMs > 220 || droppedFrames > 0.1) return "poor";
  return rttMs > 90 || droppedFrames > 0.03 ? "fair" : "good";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
