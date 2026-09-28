/**
 * Lobby operations over the same cable the game uses.
 *
 * The `lobby` channel is a broadcast channel: every connected client receives
 * every `lobby:state` the server sends, so there is no request/response pairing
 * — `list` asks, the broadcast answers. This client therefore is mostly a thin,
 * well-typed wrapper over the `lobby:*` messages of PROTOCOL.md §2 plus a
 * typed `lobby:state` subscription the browser UI can bind to directly.
 *
 * It shares a transport with {@link ./gameConnection}, which is why the state
 * handler ignores game-channel traffic: one socket, two consumers.
 */
import { PROTOCOL_VERSION } from "@shared/protocol";
import type { ClientMessage, LobbyChatLine, LobbyContext, LobbyMatchSummary, MatchMode, Race, ServerMessage } from "@shared/protocol";
import { TypedEmitter } from "./events";
import type { Unsubscribe } from "./events";
import { CableTransport, lobbyParams } from "./transport";
import type { ChannelTransport, TransportState } from "./transport";

/** The broadcast the server sends on the `lobby` channel. */
export interface LobbyState {
  matches: LobbyMatchSummary[];
  you: LobbyContext | null;
}

export interface LobbyFilters {
  mode?: MatchMode;
  map_id?: string;
  only_joinable?: boolean;
}

export interface CreateMatchRequest {
  name: string;
  mode: MatchMode;
  map_id: string;
  max_players: number;
  password?: string;
  race_preference?: Race;
}

export type LobbySettings = Partial<Pick<CreateMatchRequest, "name" | "map_id" | "mode" | "max_players" | "password">>;

export interface LobbyClientEvents {
  /** A new `lobby:state` broadcast arrived. */
  state: LobbyState;
  /** A chat line relayed by the server. */
  chat: LobbyChatLine;
  /** A server `error` message, or a local refusal to send. */
  error: { code: string; message: string; fatal: boolean };
  stateChange: TransportState;
}

/** PROTOCOL.md §2: chat is rate limited server-side at 500 ms. */
export const LOBBY_CHAT_COOLDOWN_MS = 500;
export const LOBBY_CHAT_MAX_LENGTH = 280;

export interface LobbyClientOptions {
  /** Transport override; a {@link CableTransport} is built when absent. */
  transport?: ChannelTransport;
  /** Match this client is currently seated in, for the argument-free helpers. */
  matchId?: number;
  /** Chat cooldown override, mostly for tests. */
  chatCooldownMs?: number;
}

export class LobbyClient {
  readonly events = new TypedEmitter<LobbyClientEvents>();

  private readonly transport: ChannelTransport;
  private readonly ownsTransport: boolean;
  private readonly chatCooldownMs: number;
  private lastChatAtMs = 0;
  private subscribed = false;
  private current: LobbyState = { matches: [], you: null };

  constructor(options: LobbyClientOptions = {}) {
    this.ownsTransport = options.transport === undefined;
    this.transport = options.transport ?? new CableTransport();
    this.chatCooldownMs = options.chatCooldownMs ?? LOBBY_CHAT_COOLDOWN_MS;
    this.matchId = options.matchId ?? null;
    this.transport.onMessage((msg) => this.onMessage(msg));
    this.transport.onStateChange((state) => {
      if (state === "connected") this.subscribe();
      // `CableTransport` clears its whole subscription set when a socket
      // closes, because the server forgets them too and they are re-sent on the
      // next welcome. Caching `subscribed` across that would make the next
      // `subscribe()` a no-op on a transport that holds no lobby subscription
      // at all, so every `lobby:*` message afterwards fails with
      // "no lobby subscription". The flag means "subscribed on the *current*
      // connection", so it has to be cleared whenever that connection ends.
      if (state === "closed" || state === "reconnecting") this.subscribed = false;
      this.events.emit("stateChange", state);
    });
    this.transport.onError((err) => this.events.emit("error", { code: "transport_error", message: err.message, fatal: false }));
  }

  /** The most recent `lobby:state` broadcast. */
  get state(): LobbyState {
    return this.current;
  }

  /** Match this client is seated in; the default for the helpers above. */
  matchId: number | null;

  onState(handler: (state: LobbyState) => void): Unsubscribe {
    return this.events.on("state", handler);
  }

  onChat(handler: (line: LobbyChatLine) => void): Unsubscribe {
    return this.events.on("chat", handler);
  }

  onError(handler: (error: { code: string; message: string; fatal: boolean }) => void): Unsubscribe {
    return this.events.on("error", handler);
  }

  onConnectionState(handler: (state: TransportState) => void): Unsubscribe {
    return this.events.on("stateChange", handler);
  }

  /** Subscribes to the `lobby` broadcast. Idempotent. */
  subscribe(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.transport.subscribe(lobbyParams());
  }

  /** Asks the server for a match listing (PROTOCOL.md §2). */
  list(filters?: LobbyFilters): void {
    const message: ClientMessage =
      filters === undefined
        ? { v: PROTOCOL_VERSION, t: "lobby:list" }
        : { v: PROTOCOL_VERSION, t: "lobby:list", filters };
    this.transport.send(message);
  }

  /** Creates a match and seats the caller in it. */
  create(request: CreateMatchRequest): void {
    this.transport.send({ v: PROTOCOL_VERSION, t: "lobby:create", ...request });
  }

  join(matchId: number, password?: string): void {
    const message: ClientMessage =
      password === undefined
        ? { v: PROTOCOL_VERSION, t: "lobby:join", match_id: matchId }
        : { v: PROTOCOL_VERSION, t: "lobby:join", match_id: matchId, password };
    this.transport.send(message);
  }

  /** Leaves the match, defaulting to the one this client is seated in. */
  leave(matchId?: number): void {
    const target = this.requireMatch(matchId);
    if (target !== null) {
      this.transport.send({ v: PROTOCOL_VERSION, t: "lobby:leave", match_id: target });
    }
  }

  ready(matchId?: number, ready = true): void {
    const target = this.requireMatch(matchId);
    if (target !== null) {
      this.transport.send({ v: PROTOCOL_VERSION, t: "lobby:ready", match_id: target, ready });
    }
  }

  /** Host only: the server refuses if every player is not ready. */
  start(matchId?: number): void {
    const target = this.requireMatch(matchId);
    if (target !== null) {
      this.transport.send({ v: PROTOCOL_VERSION, t: "lobby:start", match_id: target });
    }
  }

  /** Rate limited locally to one line per {@link LOBBY_CHAT_COOLDOWN_MS}. */
  chat(text: string, matchId?: number): boolean {
    const target = this.requireMatch(matchId);
    if (target === null) return false;
    const trimmed = text.slice(0, LOBBY_CHAT_MAX_LENGTH);
    if (trimmed.length === 0) return false;
    const now = Date.now();
    if (now - this.lastChatAtMs < this.chatCooldownMs) {
      this.events.emit("error", { code: "rate_limited", message: "chat is rate limited", fatal: false });
      return false;
    }
    this.lastChatAtMs = now;
    this.transport.send({ v: PROTOCOL_VERSION, t: "lobby:chat", match_id: target, text: trimmed });
    return true;
  }

  /** Host only: change name, map, mode, seat count or password. */
  settings(settings: LobbySettings, matchId?: number): void {
    const target = this.requireMatch(matchId);
    if (target !== null) {
      this.transport.send({ v: PROTOCOL_VERSION, t: "lobby:settings", match_id: target, ...settings });
    }
  }

  /**
   * Resolves the target match, or reports that there is none.
   *
   * An explicitly passed match id addresses that match and nothing else: it
   * must not become the client's new default. Latching it here meant
   * `ready(13, false)` followed by an argument-free `start()` addressed match
   * 13, so a host in a two-lobby UI could start the wrong match.
   */
  private requireMatch(matchId?: number): number | null {
    if (matchId !== undefined) return matchId;
    if (this.matchId === null) {
      this.events.emit("error", { code: "no_match", message: "no match selected", fatal: false });
      return null;
    }
    return this.matchId;
  }

  /** Leaves the lobby channel; the transport itself is left alone. */
  dispose(): void {
    this.transport.unsubscribe(lobbyParams());
    this.subscribed = false;
    if (this.ownsTransport) this.transport.close();
    this.events.removeAll();
  }

  /* ------------------------------------------------------------- internals */

  private onMessage(msg: ServerMessage): void {
    if (msg.t === "lobby:state") {
      this.current = { matches: msg.matches, you: msg.you };
      this.events.emit("state", this.current);
      return;
    }
    if (msg.t === "error") {
      this.events.emit("error", { code: msg.code, message: msg.message, fatal: msg.fatal });
      return;
    }
    if (msg.t === "lobby:chat") {
      for (const line of msg.lines) this.events.emit("chat", line);
    }
  }
}
