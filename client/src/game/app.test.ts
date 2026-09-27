/**
 * The match-entry flow: the one path that decides whether a live match ever
 * *plays*. The cable, the wire format and the simulation are covered
 * elsewhere; what is tested here is the client's own hand-off, and it is
 * tested end to end because the defect it guards was invisible from any single
 * module.
 *
 * The bug: `onSnapshot` fed the wire snapshot to `GameState` and the HUD but
 * never to the renderer. `SceneManager.applySnapshot` had no caller anywhere in
 * the client, so a match streamed 10 Hz into a fully populated HUD — supply
 * 6/20, a live minimap — over an empty world. Nothing errored; the picture was
 * simply never asked for the units.
 *
 * `App` needs a DOM and a WebGL context, neither of which this runner has, so
 * the test supplies the smallest honest versions of both: a structural element
 * shim, and a scene that models the one thing the renderer is responsible for —
 * which entities are in the world right now. The assertions are about that
 * world, never about whether a method was called.
 */
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./app";
import type { SceneSnapshot } from "@render/entities/sceneManager";
import type { GameSnapshotMessage, GameStartMessage } from "@net/gameConnection";
import type { ChannelTransport, ServerDisconnect, TransportState } from "@net/transport";
import type { ClientMessage, ProtocolEntity, ServerMessage } from "@shared/protocol";
import type { LobbyState } from "@net/lobbyClient";
import { setIconDocument } from "@ui/icons";
import { setAuthToken } from "@net/api";

/* ------------------------------------------------------------------ DOM shim */

/**
 * Enough of `HTMLElement` for the UI layer to mount and for the test to read
 * back which screen and which overlay is showing — the two things the match
 * entry is judged on.
 */
class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: { display: string } = { display: "" };
  readonly classList = {
    add: (...names: string[]) => {
      for (const name of names) {
        if (!this.hasClass(name)) this.className = this.className ? `${this.className} ${name}` : name;
      }
    },
    remove: (...names: string[]) => {
      const kept = this.className.split(/\s+/).filter((c) => c && !names.includes(c));
      this.className = kept.join(" ");
    },
    toggle: (name: string, on: boolean) => {
      if (on) this.classList.add(name);
      else this.classList.remove(name);
      return on;
    },
    contains: (name: string) => this.hasClass(name),
  };
  className = "";
  textContent = "";
  tabIndex = 0;
  type = "";
  disabled = false;
  clientWidth = 1280;
  clientHeight = 720;
  ownerDocument: FakeDocument;
  parentElement: FakeElement | null = null;
  defaultView: FakeWindow;

  constructor(ownerDocument: FakeDocument) {
    this.ownerDocument = ownerDocument;
    this.defaultView = ownerDocument.defaultView;
  }

  appendChild<T>(child: T): T {
    const node = child as unknown as FakeElement;
    node.parentElement = this;
    this.children.push(node);
    this.ownerDocument.index(node);
    return child;
  }

  removeChild(child: FakeElement): void {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
  }

  /** `clear()` empties a node through this, so it must reach null. */
  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get childElementCount(): number {
    return this.children.length;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  prepend(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parentElement = this;
      this.ownerDocument.index(node);
    }
    this.children.unshift(...nodes);
  }

  replaceChildren(): void {
    this.children.length = 0;
  }

  remove(): void {
    this.parentElement?.removeChild(this);
  }
  createElementNS(): FakeElement {
    return new FakeElement(this.ownerDocument);
  }

  cloneNode(): FakeElement {
    return new FakeElement(this.ownerDocument);
  }


  addEventListener(): void {}
  removeEventListener(): void {}
  focus(): void {}
  setAttribute(): void {}
  getBoundingClientRect() {
    return { x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720 };
  }
  /** WebGL answers the availability probe, which is the gate on match entry. */
  getContext(kind: string): unknown {
    return kind === "webgl2" || kind === "webgl" ? { probe: true } : null;
  }
  hasClass(name: string): boolean {
    return this.className.split(/\s+/).includes(name);
  }
  querySelector(): null {
    return null;
  }
  querySelectorAll(): FakeElement[] {
    return [];
  }
  get text(): string {
    return this.textContent;
  }
}

class FakeDocument {
  readonly defaultView = new FakeWindow();
  private readonly byClass = new Map<string, FakeElement[]>();

  createElement(): FakeElement {
    return new FakeElement(this);
  }

  /** The icon factory builds its glyphs in the SVG namespace. */
  createElementNS(): FakeElement {
    return new FakeElement(this);
  }

  index(node: FakeElement): void {
    for (const name of node.className.split(/\s+/).filter(Boolean)) {
      const list = this.byClass.get(name) ?? [];
      list.push(node);
      this.byClass.set(name, list);
    }
  }

  /** Every node carrying `className`, in mount order. */
  all(className: string): FakeElement[] {
    return this.byClass.get(className) ?? [];
  }
}

/** Interval callbacks are captured rather than scheduled, so time is driven. */
class FakeWindow {
  private nextHandle = 1;
  readonly intervals = new Map<number, { handler: () => void; ms: number }>();
  addEventListener(): void {}
  removeEventListener(): void {}
  setInterval(handler: () => void, ms: number): number {
    const handle = this.nextHandle++;
    this.intervals.set(handle, { handler, ms });
    return handle;
  }
  clearInterval(handle: number): void {
    this.intervals.delete(handle);
  }
}

/* --------------------------------------------------------------- fake scene */

/**
 * A renderer stand-in holding the live entity set — the state `SceneManager`
 * keeps across snapshots. Snapshots are full tables, so an id missing from the
 * newest one is gone.
 */
class WorldScene {
  readonly live = new Map<number, ProtocolEntity>();
  myPlayerId = 0;
  disposed = false;

  applySnapshot(snapshot: SceneSnapshot): void {
    if (this.disposed) return;
    this.live.clear();
    for (const entity of snapshot.entities) this.live.set(entity.id, entity);
  }

  ids(): number[] {
    return [...this.live.keys()].sort((a, b) => a - b);
  }

  positionOf(id: number): { x: number; z: number } | null {
    const found = this.live.get(id);
    return found ? { x: found.x, z: found.z } : null;
  }

  /** The minimap viewport rect is picked off the camera; no ground here. */
  screenToGround(): boolean {
    return false;
  }

  isVisible(): boolean {
    return true;
  }

  setSelection(): void {}

  dispose(): void {
    this.disposed = true;
    this.live.clear();
  }
}

/* ------------------------------------------------------------- fake transport */

/**
 * An in-memory cable with the real transport's multi-handler shape: the lobby
 * client and the game connection share one socket, exactly as in the browser.
 */
class FakeTransport implements ChannelTransport {
  readonly written: ClientMessage[] = [];
  private readonly readers = new Set<(msg: ServerMessage) => void>();
  private current: TransportState = "idle";

  get state(): TransportState {
    return this.current;
  }
  get connected(): boolean {
    return this.current === "connected";
  }

  connect(): Promise<void> {
    this.current = "connected";
    return Promise.resolve();
  }
  close(): void {
    this.current = "closed";
  }
  subscribe(): string {
    return "";
  }
  unsubscribe(): void {}
  identify(): void {}
  onError(): void {}
  onReceipt(): void {}
  lastActivity(): number {
    return 0;
  }
  onDisconnect(_handler: (info: ServerDisconnect) => void): void {}
  onStateChange(_handler: (s: TransportState) => void): void {}

  onMessage(handler: (msg: ServerMessage) => void): void {
    this.readers.add(handler);
  }

  send(message: ClientMessage): void {
    this.written.push(message);
  }

  /** Delivers one server frame to every subscriber, as the socket would. */
  deliver(msg: ServerMessage): void {
    for (const reader of [...this.readers]) reader(msg);
  }
}

/* ------------------------------------------------------------------ fixtures */

const MAP_ID = "altaior";
const MATCH_ID = 34;
const ME = 1;

function entity(id: number, over: Partial<ProtocolEntity> = {}): ProtocolEntity {
  return {
    id,
    ty: id === 1 ? "command_center" : "scv",
    pl: ME,
    x: 32 + id,
    z: 32,
    y: 7,
    hp: 100,
    hp_max: 100,
    mp: 0,
    mp_max: 0,
    ang: 0,
    st: "idle",
    ...over,
  } as ProtocolEntity;
}

function startMessage(over: Partial<GameStartMessage> = {}): GameStartMessage {
  return {
    v: 1,
    t: "game:start",
    match_id: MATCH_ID,
    seed: 1,
    map_id: MAP_ID,
    tick_rate: 20,
    snapshot_rate: 10,
    countdown_ms: 3_000,
    players: [
      { player_id: ME, slot: 0, race: "terran", name: "nik", team: 1, start: { x: 32, z: 32 } },
      { player_id: 2, slot: 1, race: "zerg", name: "mvp", team: 2, start: { x: 224, z: 32 } },
    ],
    ...over,
  } as GameStartMessage;
}

function snapshot(tick: number, entities: ProtocolEntity[]): GameSnapshotMessage {
  return {
    v: 1,
    t: "game:snapshot",
    tick,
    server_ms: tick * 50,
    ack: 0,
    entities,
    events: [],
  } as GameSnapshotMessage;
}

function lobbyStateInProgress(): LobbyState {
  return {
    you: { match_id: MATCH_ID, player_id: ME, slot: 0, race: "terran", ready: true, is_host: false },
    matches: [
      {
        id: MATCH_ID,
        name: "TRACE",
        mode: "melee",
        map_id: MAP_ID,
        max_players: 2,
        player_count: 2,
        status: "in_progress",
      },
    ],
  } as unknown as LobbyState;
}

interface Harness {
  app: App;
  doc: FakeDocument;
  scene: WorldScene;
  transport: FakeTransport;
  /** Delivers a server frame the way the cable would. */
  deliver(msg: ServerMessage): void;
  /** Advances every scheduled interval by `ms`, as the browser would. */
  advance(ms: number): void;
  visibleScreen(): string;
  overlayText(name: string): string | null;
}

/** The game loop schedules real frames in node, so every app is torn down. */
const mounted: App[] = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.dispose();
  setIconDocument(null);
});

/**
 * `localStorage` does not exist under `environment: "node"`, and match entry
 * refuses to start without a session token — so the harness supplies the one
 * piece of browser state the flow genuinely depends on.
 */
function signIn(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
  });
  setAuthToken("test-token");
}


async function harness(): Promise<Harness> {
  signIn();
  const doc = new FakeDocument();
  setIconDocument(doc as unknown as Document);
  const root = doc.createElement();
  const transport = new FakeTransport();
  const scene = new WorldScene();
  let clock = 1_000_000;
  const app = new App({
    transport,
    api: { me: () => Promise.resolve({ player: { name: "nik", rating: 1300, wins: 1, losses: 0 } }) } as never,
    quality: "low",
    sceneFactory: () => scene as never,
    now: () => clock,
  });
  mounted.push(app);
  await app.mount(root as unknown as HTMLElement);
  return {
    app,
    doc,
    scene,
    transport,
    deliver: (msg) => transport.deliver(msg),
    advance: (ms) => {
      // The app's own countdown reads `now()`, so moving a clock and ticking
      // the registered intervals is exactly what the browser does — without
      // waiting on wall time.
      for (let elapsed = 0; elapsed <= ms; elapsed += 100) {
        clock += 100;
        for (const { handler } of [...doc.defaultView.intervals.values()]) handler();
      }
    },
    visibleScreen: () => {
      for (const screen of doc.all("screen")) {
        const name = screen.dataset.screen;
        if (name && screen.style.display !== "none") return name;
      }
      return "none";
    },
    overlayText: (name) => {
      const layer = (app as unknown as Record<string, FakeElement | null>)[`${name}Layer`];
      if (!layer || layer.style.display === "none") return null;
      return textOf(layer);
    },
  };
}

/** Concatenated text of a node and its descendants, as the page would show. */
function textOf(node: FakeElement): string {
  return [node.textContent, ...node.children.map(textOf)].join(" ").trim();
}

/** Walks the player from the lobby into the running match, as the app does. */
function enterRunningMatch(h: Harness): void {
  h.app.show("lobby");
  const onLobbyState = (
    h.app as unknown as { onLobbyState: (state: LobbyState) => void }
  ).onLobbyState;
  onLobbyState.call(h.app, lobbyStateInProgress());
}

/* -------------------------------------------------------------------- tests */

describe("match entry", () => {
  it("puts the world on the screen, not only in the HUD", async () => {
    const h = await harness();
    expect(h.app.currentScreen).toBe("menu");

    enterRunningMatch(h);
    expect(h.app.currentScreen).toBe("loading");
    expect(h.overlayText("loading")).toContain("Waiting for the server");

    h.deliver(startMessage());
    expect(h.app.currentScreen).toBe("game");
    expect(h.overlayText("loading")).toBeNull();

    h.deliver(snapshot(1, [entity(1), entity(2), entity(3)]));

    // The HUD readouts were already correct before the fix; the world was not.
    expect(h.app.gameState.supply()).toBeGreaterThan(0);
    expect(h.scene.ids()).toEqual([1, 2, 3]);
  });

  it("moves the drawn units as later snapshots arrive", async () => {
    const h = await harness();
    enterRunningMatch(h);
    h.deliver(startMessage());

    h.deliver(snapshot(1, [entity(2, { x: 40, z: 40 })]));
    expect(h.scene.positionOf(2)).toEqual({ x: 40, z: 40 });

    h.deliver(snapshot(2, [entity(2, { x: 55, z: 48 })]));
    expect(h.scene.positionOf(2)).toEqual({ x: 55, z: 48 });
  });

  it("survives a second game:start mid-countdown without stranding in loading", async () => {
    const h = await harness();
    enterRunningMatch(h);
    h.deliver(startMessage());
    h.deliver(snapshot(1, [entity(1), entity(2)]));
    expect(h.overlayText("countdown")).not.toBeNull();

    // A resynchronise re-announces the match while the countdown is still up.
    h.deliver(startMessage());
    h.deliver(snapshot(2, [entity(1), entity(2), entity(3)]));

    expect(h.app.currentScreen).toBe("game");
    expect(h.overlayText("loading")).toBeNull();
    expect(h.scene.ids()).toEqual([1, 2, 3]);

    h.advance(3_500);
    expect(h.overlayText("countdown")).toBeNull();
    expect(h.app.currentScreen).toBe("game");
  });
});
