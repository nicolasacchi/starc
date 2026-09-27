/**
 * ActionCable cable transport, written from scratch against the protocol the
 * server actually speaks: `actioncable-8.1.4`'s **native JSON protocol**. That
 * gem has no STOMP support at all — a STOMP `CONNECT` frame is ignored and the
 * server answers with `{"type":"welcome"}` — so this file frames every message
 * as one JSON document per WebSocket text frame. No `@rails/actioncable`, no
 * `@stompjs`, no new dependencies.
 *
 * The handshake, end to end:
 *
 * ```
 * ws://host/cable?token=<session>      Upgrade: websocket, no subprotocol
 * ← {"type":"welcome"}                 the connection is open; only now may we subscribe
 * → {"command":"subscribe","identifier":"{\"channel\":\"LobbyChannel\"}"}
 * ← {"type":"confirm_subscription","identifier":"…"}
 * → {"command":"message","identifier":"…","data":"{\"v\":1,\"t\":\"lobby:list\"}"}
 * ← {"identifier":"…","message":"{\"v\":1,\"t\":\"lobby:state\",…}"}
 * ```
 *
 * Three details that are easy to get wrong and expensive to debug:
 *
 * - `identifier` is a **JSON-encoded string** of the channel params, not a
 *   channel name. Server frames are routed by matching that string exactly; a
 *   frame for an identifier we do not hold is dropped.
 * - The `data` we send is itself a JSON **string**, and a server payload that
 *   arrives as `message` may be a string (a Ruby `to_json` transmit) or an
 *   already-decoded object. Both are accepted.
 * - `{"type":"disconnect","reconnect":false}` is a *server-requested* close.
 *   It is terminal: the client must not reconnect, because the server will
 *   refuse the same connection again. That is why it is reported separately
 *   from a socket drop instead of looking like one.
 *
 * `ping` is fire-and-forget: the gem's own client records it and sends nothing
 * back. So do we — it feeds `lastActivity()`, which is what the reconnect
 * controller and the connection-quality indicator read. If the socket goes
 * silent past three heartbeat windows, it is closed so the normal reconnect
 * path takes over.
 *
 * The WebSocket layer reassembles a *JSON document* that arrives in pieces,
 * which a proxy or an extension frame boundary can cause.
 */
import { isServerMessage, PROTOCOL_VERSION } from "@shared/protocol";
import type { ClientMessage, ServerMessage } from "@shared/protocol";

export type TransportState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

export interface Transport {
  readonly state: TransportState;
  connect(url: string, token: string): Promise<void>;
  send(message: ClientMessage): void;
  onMessage(handler: (msg: ServerMessage) => void): void;
  onStateChange(handler: (s: TransportState) => void): void;
  close(): void;
}

/**
 * Channel subscription parameters, exactly as they are JSON-encoded into the
 * ActionCable `identifier`. `LobbyChannel` takes none; `GameChannel` takes
 * `match_id` (see `server/app/channels/*.rb`).
 */
export interface ChannelParams {
  channel: string;
  [key: string]: string | number;
}

/** What the server asked for when it sent `{"type":"disconnect"}`. */
export interface ServerDisconnect {
  reason: string;
  /** False means terminal: do not reconnect. */
  reconnect: boolean;
}

/**
 * What the rest of the slice needs on top of the bare {@link Transport}:
 * channel subscription, `identify`, error reporting, round-trip measurement
 * and a distinct hook for a server-requested close.
 */
export interface ChannelTransport extends Transport {
  /** Subscribes with channel params; returns the ActionCable identifier. */
  subscribe(params: ChannelParams): string;
  /** Drops a subscription; the server stops sending to this client. */
  unsubscribe(params: ChannelParams): void;
  /** Sends `identify` on a game subscription (PROTOCOL.md §1). */
  identify(params?: ChannelParams): void;
  /** Non-fatal problems: protocol violations, unparsable frames. */
  onError(handler: (err: Error) => void): void;
  /**
   * A subscribe was confirmed (or rejected) by the server. Both timestamps
   * come from this transport, so the handler derives a true round-trip time
   * across the same socket gameplay uses.
   */
  onReceipt(handler: (id: string, sentAtMs: number, receivedAtMs: number) => void): void;
  /** Local timestamp of the last inbound frame — liveness. */
  lastActivity(): number;
  /** The server asked us to close. Terminal when `reconnect` is false. */
  onDisconnect(handler: (info: ServerDisconnect) => void): void;
}

export const LOBBY_CHANNEL = "LobbyChannel";
export const GAME_CHANNEL = "GameChannel";

/** Channel params for the match browser. */
export function lobbyParams(): ChannelParams {
  return { channel: LOBBY_CHANNEL };
}

/** Channel params for one match. */
export function gameParams(matchId: number): ChannelParams {
  return { channel: GAME_CHANNEL, match_id: matchId };
}

/** The JSON-encoded ActionCable identifier for a set of channel params. */
export function channelIdentifier(params: ChannelParams): string {
  return JSON.stringify(params);
}

const WELCOME = "welcome";
const PING = "ping";
const CONFIRM_SUBSCRIPTION = "confirm_subscription";
const REJECTION = "rejection";
const DISCONNECT = "disconnect";

/** One decoded cable frame. */
export interface CableFrame {
  type: string;
  identifier?: string;
  message?: unknown;
  reason?: string;
  reconnect?: boolean;
  data?: unknown;
  command?: string;
}

/**
 * Reassembles cable frames from socket text. The WebSocket layer normally
 * hands over whole messages, but a text frame can still arrive in pieces
 * behind a proxy; incomplete documents are buffered rather than dropped, and
 * the buffer is bounded so a desynchronised stream cannot grow without limit.
 */
export class CableMessageReader {
  private buffer = "";
  private static readonly MAX_BUFFER = 1 << 20;

  /** Feeds socket text; returns the frames that are now complete. */
  push(chunk: string): CableFrame[] {
    this.buffer += chunk;
    const frames: CableFrame[] = [];
    for (;;) {
      const end = this.endOfFirstDocument();
      if (end < 0) break;
      const text = this.buffer.slice(0, end + 1);
      this.buffer = this.buffer.slice(end + 1);
      const frame = parseFrame(text);
      if (frame) frames.push(frame);
    }
    if (this.buffer.length > CableMessageReader.MAX_BUFFER) this.buffer = "";
    return frames;
  }

  /** Bytes still waiting for the rest of a document. */
  get pending(): number {
    return this.buffer.length;
  }

  reset(): void {
    this.buffer = "";
  }

  /**
   * Index of the closing brace of the first complete JSON object, or -1.
   * String-aware, so a `}` inside a message payload does not end the frame.
   */
  private endOfFirstDocument(): number {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let started = false;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") {
        depth++;
        started = true;
        continue;
      }
      if (ch !== "}") continue;
      depth--;
      if (started && depth === 0) return i;
    }
    return -1;
  }
}

function parseFrame(text: string): CableFrame | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as CableFrame;
  } catch {
    return null;
  }
}

export interface CableTransportOptions {
  /**
   * Liveness window in ms. A silent socket past three windows is closed so
   * the reconnect path takes over. 0 disables the check.
   */
  heartbeatMs?: number;
  /** WebSocket subprotocols. ActionCable negotiates none, so this is empty. */
  protocols?: string | string[];
  /** Observability hook, invoked for every decoded frame. */
  onFrame?: (frame: CableFrame) => void;
  /**
   * The `WebSocket` constructor. Injectable so the transport can be driven
   * without a live context, and so a test can hand it a fake socket.
   */
  socketFactory?: (url: string) => WebSocket;
}

export class CableTransport implements ChannelTransport {
  private socket: WebSocket | null = null;
  private reader = new CableMessageReader();
  private currentState: TransportState = "idle";
  private token = "";
  /** identifier → params, so an inbound frame routes to the right channel. */
  private readonly subscriptions = new Map<string, ChannelParams>();
  private readonly messageHandlers: ((msg: ServerMessage) => void)[] = [];
  private readonly stateHandlers: ((s: TransportState) => void)[] = [];
  private readonly errorHandlers: ((err: Error) => void)[] = [];
  private readonly receiptHandlers: ((id: string, sentAtMs: number, receivedAtMs: number) => void)[] = [];
  private readonly disconnectHandlers: ((info: ServerDisconnect) => void)[] = [];
  /** identifier → when the subscribe went out, for the round-trip measure. */
  private readonly sentAt = new Map<string, number>();
  /** Identifiers the server has confirmed. A `message` waits for one. */
  private readonly confirmed = new Set<string>();
  /** identifier → messages held until its subscription is confirmed. */
  private readonly pendingMessages = new Map<string, string[]>();
  /** Ceiling on held messages per channel, so a silent server cannot grow it. */
  private static readonly MAX_PENDING_MESSAGES = 64;
  /** Subscriptions and messages issued before `welcome`, replayed in order. */
  private outbox: string[] = [];
  private welcomed = false;
  private closeRequested = false;
  private serverClosed = false;
  private heartbeatTimer: number | null = null;
  private lastInboundAt = 0;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private closeTimer: number | null = null;
  private readonly onFrameHook: ((frame: CableFrame) => void) | null;
  private readonly heartbeatMs: number;
  private readonly protocols: string | string[];
  private readonly socketFactory: (url: string) => WebSocket;

  constructor(options: CableTransportOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    this.socketFactory =
      options.socketFactory ?? ((url: string) => (this.protocols ? new WebSocket(url, this.protocols) : new WebSocket(url)));
    this.protocols = options.protocols ?? "";
    this.onFrameHook = options.onFrame ?? null;
  }

  get state(): TransportState {
    return this.currentState;
  }

  /** True once the server has asked us to close and does not want a retry. */
  get terminated(): boolean {
    return this.serverClosed;
  }

  /** Resolves on the ActionCable `welcome`, not on the TCP upgrade. */
  connect(url: string, token: string): Promise<void> {
    if (this.currentState === "connected" && this.welcomed) return Promise.resolve();
    if (this.currentState === "connecting" && this.socket) return Promise.resolve();
    this.token = token;
    this.closeRequested = false;
    this.serverClosed = false;
    this.welcomed = false;
    this.reader.reset();
    this.setState(this.currentState === "reconnecting" ? "reconnecting" : "connecting");

    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      let socket: WebSocket;
      try {
        socket = this.socketFactory(cableUrl(url, token));
      } catch (err) {
        this.setState("closed");
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.socket = socket;
      socket.onopen = () => this.onOpen();
      socket.onmessage = (ev: MessageEvent) => this.onText(typeof ev.data === "string" ? ev.data : "");
      // The browser gives no detail here; onclose always follows and reports it.
      socket.onerror = () => this.raise(new Error("cable socket error"));
      socket.onclose = (ev: CloseEvent) => this.onClose(ev);
    });
  }

  onMessage(handler: (msg: ServerMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onStateChange(handler: (s: TransportState) => void): void {
    this.stateHandlers.push(handler);
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  onReceipt(handler: (id: string, sentAtMs: number, receivedAtMs: number) => void): void {
    this.receiptHandlers.push(handler);
  }

  onDisconnect(handler: (info: ServerDisconnect) => void): void {
    this.disconnectHandlers.push(handler);
  }

  /**
   * Subscribes with channel params. The `subscribe` command is queued until the
   * server has said `welcome`, because ActionCable drops a subscribe that
   * arrives before the connection is open.
   */
  subscribe(params: ChannelParams): string {
    const identifier = channelIdentifier(params);
    this.subscriptions.set(identifier, params);
    this.sentAt.set(identifier, Date.now());
    this.confirmed.delete(identifier);
    this.write({ command: "subscribe", identifier });
    return identifier;
  }

  unsubscribe(params: ChannelParams): void {
    const identifier = channelIdentifier(params);
    this.subscriptions.delete(identifier);
    this.sentAt.delete(identifier);
    this.confirmed.delete(identifier);
    this.pendingMessages.delete(identifier);
    this.write({ command: "unsubscribe", identifier });
  }

  /**
   * `identify` must precede any other message that needs a player
   * (PROTOCOL.md §1). Defaults to the game subscription, which is the one that
   * refuses to act without it.
   */
  identify(params?: ChannelParams): void {
    const target = params ?? this.gameSubscription();
    if (!target || target.channel !== GAME_CHANNEL) return;
    this.write({
      command: "message",
      identifier: channelIdentifier(target),
      data: JSON.stringify({ v: PROTOCOL_VERSION, t: "identify", token: this.token }),
    });
  }

  /**
   * Sends a protocol message on its natural channel. Lobby traffic goes to the
   * lobby subscription, everything else to the game subscription; `data` is
   * the protocol JSON, sent as a string because that is what ActionCable
   * parses out of a `message` command.
   */
  send(message: ClientMessage): void {
    const target = isLobbyMessage(message) ? this.lobbySubscription() : this.gameSubscription();
    if (!target) {
      this.raise(new Error(`no ${isLobbyMessage(message) ? "lobby" : "game"} subscription for ${message.t}`));
      return;
    }
    this.write({
      command: "message",
      identifier: channelIdentifier(target),
      data: JSON.stringify(message),
    });
  }

  close(): void {
    this.closeRequested = true;
    this.finishClose();
  }

  /** Timestamp of the last inbound frame; the reconnect controller's liveness. */
  lastActivity(): number {
    return this.lastInboundAt;
  }

  /* ------------------------------------------------------------- internals */

  private lobbySubscription(): ChannelParams | null {
    return this.subscriptionFor(LOBBY_CHANNEL);
  }

  private gameSubscription(): ChannelParams | null {
    return this.subscriptionFor(GAME_CHANNEL);
  }

  private subscriptionFor(channel: string): ChannelParams | null {
    for (const params of this.subscriptions.values()) {
      if (params.channel === channel) return params;
    }
    return null;
  }

  private onOpen(): void {
    // The TCP upgrade is not the connection: nothing may be sent until the
    // server has said `welcome`.
    this.lastInboundAt = Date.now();
    this.startHeartbeat();
  }

  private onText(text: string): void {
    this.lastInboundAt = Date.now();
    for (const frame of this.reader.push(text)) {
      this.onFrameHook?.(frame);
      this.onFrame(frame);
    }
  }

  private onFrame(frame: CableFrame): void {
    switch (frame.type) {
      case WELCOME:
        this.onWelcome();
        return;
      case PING:
        // Fire and forget, exactly as the gem's own client treats it: this
        // refreshes `lastActivity` and nothing else.
        return;
      case CONFIRM_SUBSCRIPTION:
      case REJECTION:
        this.onSubscriptionReply(frame);
        return;
      case DISCONNECT:
        this.onServerDisconnect(frame);
        return;
      default:
        this.onPayload(frame);
    }
  }

  private onWelcome(): void {
    this.welcomed = true;
    this.setState("connected");
    this.connectResolve?.();
    this.connectResolve = null;
    this.connectReject = null;
    // Anything queued while the connection was opening goes out now, in order,
    // so a subscribe still precedes the message that needs it.
    const queued = this.outbox;
    this.outbox = [];
    for (const text of queued) {
      // Re-dispatch rather than writing raw: a queued message still has to
      // wait for its subscription to be confirmed.
      const frame = parseFrame(text);
      if (frame) this.write(frame as unknown as Record<string, unknown>);
      else this.writeRaw(text);
    }
  }

  private onSubscriptionReply(frame: CableFrame): void {
    const identifier = frame.identifier;
    if (identifier === undefined) return;
    const sentAtMs = this.sentAt.get(identifier);
    if (sentAtMs !== undefined) this.sentAt.delete(identifier);
    if (frame.type === REJECTION) {
      this.raise(new Error(`subscription rejected: ${identifier}`));
      this.subscriptions.delete(identifier);
      this.pendingMessages.delete(identifier);
    } else {
      this.confirmed.add(identifier);
      // The server registers a subscription asynchronously relative to our
      // write, so a `message` sent straight after `subscribe` can arrive first
      // and be refused with "unable to find subscription". Holding messages
      // until the confirmation removes that race entirely.
      for (const text of this.pendingMessages.get(identifier) ?? []) this.writeRaw(text);
      this.pendingMessages.delete(identifier);
    }
    for (const handler of this.receiptHandlers) {
      handler(identifier, sentAtMs ?? this.lastInboundAt, this.lastInboundAt);
    }
  }

  private onServerDisconnect(frame: CableFrame): void {
    const info: ServerDisconnect = {
      reason: typeof frame.reason === "string" ? frame.reason : "server closed the connection",
      reconnect: frame.reconnect !== false,
    };
    this.serverClosed = !info.reconnect;
    for (const handler of this.disconnectHandlers) handler(info);
    this.finishClose();
  }

  /** A subscription's payload: `{identifier, message}`. */
  private onPayload(frame: CableFrame): void {
    const identifier = frame.identifier;
    // Routing is by identifier: anything we do not hold is not ours.
    if (identifier === undefined || !this.subscriptions.has(identifier)) return;
    const parsed = decodePayload(frame.message);
    if (!isServerMessage(parsed)) {
      this.raise(new Error(`unsupported protocol message: ${String((parsed as { t?: unknown } | null)?.t)}`));
      return;
    }
    for (const handler of this.messageHandlers) handler(parsed);
  }

  private onClose(ev: CloseEvent): void {
    const wasWelcomed = this.welcomed;
    this.welcomed = false;
    if (this.connectReject) {
      const err = new Error(`cable closed before welcome (code ${ev.code})`);
      this.connectReject(err);
      this.connectResolve = null;
      this.connectReject = null;
    }
    this.setState(this.closeRequested || this.serverClosed ? "closed" : wasWelcomed ? "reconnecting" : "connecting");
  }

  private write(frame: Record<string, unknown>): void {
    const text = JSON.stringify(frame);
    if (!this.welcomed) {
      if (this.outbox.length < 256) this.outbox.push(text);
      return;
    }
    if (frame.command === "message" && !this.holdUntilConfirmed(String(frame.identifier), text)) {
      this.writeRaw(text);
    } else if (frame.command !== "message") {
      this.writeRaw(text);
    }
  }

  /**
   * Holds a `message` whose subscription is not confirmed yet. Returns false
   * when the message was held (or dropped, because there is no subscription).
   */
  private holdUntilConfirmed(identifier: string, text: string): boolean {
    if (this.confirmed.has(identifier)) return false;
    if (!this.subscriptions.has(identifier)) return true;
    const queue = this.pendingMessages.get(identifier) ?? [];
    if (queue.length < CableTransport.MAX_PENDING_MESSAGES) queue.push(text);
    this.pendingMessages.set(identifier, queue);
    return true;
  }

  private writeRaw(text: string): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    try {
      socket.send(text);
    } catch (err) {
      this.raise(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.heartbeatMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.lastInboundAt === 0) return;
      if (Date.now() - this.lastInboundAt > this.heartbeatMs * 3) this.socket?.close();
    }, this.heartbeatMs) as unknown as number;
  }

  private stopHeartbeat(): void {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private finishClose(): void {
    this.stopHeartbeat();
    const socket = this.socket;
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) socket.close();
    this.socket = null;
    this.welcomed = false;
    this.subscriptions.clear();
    this.sentAt.clear();
    this.confirmed.clear();
    this.pendingMessages.clear();
    this.outbox.length = 0;
    this.setState("closed");
  }

  private setState(state: TransportState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const handler of this.stateHandlers) handler(state);
  }

  private raise(err: Error): void {
    for (const handler of this.errorHandlers) handler(err);
  }
}

/**
 * A server payload is a Ruby `to_json` string for anything the channels
 * `transmit`, and an already-decoded object when ActionCable re-encodes it.
 * Both are accepted; a string is parsed once, here.
 */
function decodePayload(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The cable carries the session token as `?token=`, which the server reads. */
export function cableUrl(url: string, token: string): string {
  if (token === "") return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

/** Lobby traffic goes to `LobbyChannel`, everything else to `GameChannel`. */
function isLobbyMessage(message: ClientMessage): boolean {
  return message.t.startsWith("lobby:");
}
