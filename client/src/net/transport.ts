/**
 * ActionCable STOMP transport, written from scratch.
 *
 * ActionCable's own JS client is JSON-over-`actioncable-v1-json`, not STOMP, so
 * what this file implements is the raw STOMP 1.2 framing that an ActionCable
 * server speaks on the same `wss://<host>/cable` socket. Everything is
 * hand-rolled — no `@rails/actioncable`, no `@stompjs`.
 *
 * Frame grammar (STOMP 1.2):
 *
 *   COMMAND EOL (header ':' value EOL)* EOL body NUL
 *
 * - A server frame *must* end with NUL and *should* use CRLF; a client frame
 *   *must* use LF. We accept both line endings inbound and always emit LF.
 * - A bare EOL (`\n` or `\r\n`) with no command byte is a heart-beat. Receiving
 *   one obliges an immediate EOL back or the server drops the connection.
 * - `content-length` makes the body length authoritative, and the terminator
 *   after it may be a NUL or a line break. Without it we scan for the NUL.
 * - Header values escape `\`, `:` and newline as `\\`, `\c`, `\n`; the first
 *   *unescaped* colon separates name from value, so a value may itself contain
 *   colons (relevant for server-generated `message-id` / `receipt-id`).
 *
 * Channel mapping: `lobby` and `game:<match_id>` (PROTOCOL.md §1–§2) become
 * STOMP `destination` headers. The payload of every `MESSAGE` is a protocol
 * `ServerMessage` (§2–§5) parsed as JSON and handed to `onMessage`.
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

/** One decoded STOMP frame; `command === ""` marks a heart-beat. */
export interface StompFrame {
  command: string;
  headers: Map<string, string>;
  body: string;
}

export interface StompTransportOptions {
  /** Heart-beat cadence in ms. 0 disables the outbound liveness timer. */
  heartbeatMs?: number;
  /** WebSocket subprotocols to request. */
  protocols?: string | string[];
  /** Observability hook, invoked for every decoded frame. */
  onFrame?: (frame: StompFrame) => void;
}

/** PROTOCOL.md §2: the lobby channel is a fixed name; gameplay is per match. */

/**
 * What the game and lobby clients need on top of the bare {@link Transport}:
 * channel subscription, `identify`, error reporting, and STOMP receipts for
 * round-trip measurement.
 */
export interface ChannelTransport extends Transport {
  /** Subscribes to a channel and returns its STOMP subscription id. */
  subscribe(channel: string): string;
  /** Drops a subscription; the server then stops sending to this client. */
  unsubscribe(channel: string): void;
  /** Sends `identify` on a game channel (PROTOCOL.md §1). */
  identify(channel?: string): void;
  /** Non-fatal problems: protocol violations, unparsable frames. */
  onError(handler: (err: Error) => void): void;
  /**
   * A frame carrying `receipt` was acknowledged. The handler gets the receipt
   * id and both timestamps, so the caller can derive a round-trip time without
   * the transport having to guess a clock.
   */
  onReceipt(handler: (receiptId: string, sentAtMs: number, receivedAtMs: number) => void): void;
  /** Local timestamp of the last inbound byte. */
  lastActivity(): number;
}

export const LOBBY_CHANNEL = "lobby";
export const GAME_CHANNEL_PREFIX = "game:";

/** Gameplay channel name for a match id. */
export function gameChannelFor(matchId: number): string {
  return GAME_CHANNEL_PREFIX + matchId;
}

/** True when a channel name addresses the match browser rather than a match. */
export function isLobbyChannel(channel: string): boolean {
  return channel === LOBBY_CHANNEL;
}

const NUL = "\0";
/** Queued-outbound cap; a client that queues this much is already wedged. */
const MAX_OUTBOX = 256;
/** In-flight receipts tracked for round-trip measurement. */
const MAX_TRACKED_RECEIPTS = 256;
/** How long a graceful close waits for the server's DISCONNECT receipt, ms. */
const DISCONNECT_GRACE_MS = 250;


function escapeHeaderValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\c").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function unescapeHeaderValue(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = value[++i];
    if (next === "c") out += ":";
    else if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "\\") out += "\\";
    else out += next ?? "";
  }
  return out;
}

/** Splits one header line on its first *unescaped* colon. */
function parseHeaderLine(line: string): [string, string] | null {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") {
      i++; // an escaped character can never be the separator
      continue;
    }
    if (line[i + 1] === ":") {
      return [line.slice(0, i + 1), unescapeHeaderValue(line.slice(i + 2))];
    }
  }
  return null;
}

/**
 * Incremental STOMP frame reader. Feed it socket text; it returns whatever
 * whole frames have arrived. Holds one string buffer that is bounded by
 * {@link MAX_BUFFER} so a desynchronised stream cannot grow without limit.
 */
export class StompFrameParser {
  private buffer = "";
  private static readonly MAX_BUFFER = 1 << 20;

  push(chunk: string): StompFrame[] {
    this.buffer += chunk;
    const frames: StompFrame[] = [];
    for (;;) {
      if (this.buffer.length === 0) break;

      // Heart-beat: a leading EOL with no command byte in front of it.
      if (this.buffer[0] === "\n" || this.buffer[0] === "\r") {
        const width = this.buffer[0] === "\r" && this.buffer[1] === "\n" ? 2 : 1;
        this.buffer = this.buffer.slice(width);
        frames.push({ command: "", headers: new Map(), body: "" });
        continue;
      }

      const frame = this.takeFrame();
      if (!frame) break;
      frames.push(frame);
    }
    if (this.buffer.length > StompFrameParser.MAX_BUFFER) this.buffer = "";
    return frames;
  }

  /** Resets the reader, e.g. after a reconnect. */
  reset(): void {
    this.buffer = "";
  }

  private takeFrame(): StompFrame | null {
    // Headers end at the first blank line; the body runs to NUL (or to the
    // declared content-length, which wins because it is unambiguous).
    let headerEnd = -1;
    let separatorWidth = 2;
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i] !== "\n") continue;
      if (this.buffer[i + 1] === "\n") {
        headerEnd = i;
        separatorWidth = 2;
        break;
      }
      if (this.buffer[i + 1] === "\r" && this.buffer[i + 2] === "\n") {
        headerEnd = i;
        separatorWidth = 3;
        break;
      }
    }
    if (headerEnd < 0) return null;

    const headerText = this.buffer.slice(0, headerEnd);
    const bodyStart = headerEnd + separatorWidth;
    const commandEnd = headerText.indexOf("\n");
    const command = (commandEnd < 0 ? headerText : headerText.slice(0, commandEnd)).replace(/\r$/, "");

    const headers = new Map<string, string>();
    if (commandEnd >= 0) {
      for (const raw of headerText.slice(commandEnd + 1).split("\n")) {
        const line = raw.replace(/\r$/, "");
        if (line === "") continue;
        const parsed = parseHeaderLine(line);
        if (parsed) headers.set(parsed[0], parsed[1]);
      }
    }

    const declared = headers.get("content-length");
    if (declared !== undefined) {
      const length = Number.parseInt(declared, 10);
      if (!Number.isFinite(length) || length < 0) {
        // Unusable length: drop the frame rather than desynchronise the stream.
        this.buffer = this.buffer.slice(bodyStart);
        return { command, headers, body: "" };
      }
      if (this.buffer.length - bodyStart < length) return null;
      const body = this.buffer.slice(bodyStart, bodyStart + length);
      let consumed = bodyStart + length;
      if (this.buffer[consumed] === "\r" && this.buffer[consumed + 1] === "\n") consumed += 2;
      else if (this.buffer[consumed] === "\n" || this.buffer[consumed] === NUL) consumed += 1;
      this.buffer = this.buffer.slice(consumed);
      return { command, headers, body };
    }

    const nul = this.buffer.indexOf(NUL, bodyStart);
    if (nul < 0) return null;
    const body = this.buffer.slice(bodyStart, nul);
    this.buffer = this.buffer.slice(nul + 1);
    return { command, headers, body };
  }
}

/** Serialises a client frame. Client frames use LF and are NUL-terminated. */
export function encodeStompFrame(command: string, headers: Record<string, string>, body = ""): string {
  let out = command + "\n";
  for (const key of Object.keys(headers)) out += `${key}:${escapeHeaderValue(headers[key])}\n`;
  return out + "\n" + body + NUL;
}

function hostOf(url: string): string {
  const match = /^[a-z]+:\/\/([^/]+)/i.exec(url);
  return match ? match[1] : url;
}

export class StompTransport implements ChannelTransport {
  private socket: WebSocket | null = null;
  private parser = new StompFrameParser();
  private currentState: TransportState = "idle";
  private token = "";
  private url = "";
  /** Channel → subscription id, so MESSAGE frames can be routed back. */
  private readonly subscriptions = new Map<string, string>();
  /** Gameplay channel currently subscribed, if any. */
  private gameChannel: string | null = null;
  private nextSubscriptionId = 1;
  private connected = false;
  private closeRequested = false;
  /** Frames issued before CONNECTED, replayed in order on the open socket. */
  private outbox: string[] = [];
  private readonly messageHandlers: ((msg: ServerMessage) => void)[] = [];
  private readonly stateHandlers: ((s: TransportState) => void)[] = [];
  private readonly errorHandlers: ((err: Error) => void)[] = [];
  private readonly receiptHandlers: ((receiptId: string, sentAtMs: number, receivedAtMs: number) => void)[] = [];
  /** receipt id → the moment the frame carrying it was written. */
  private readonly receiptsSent = new Map<string, number>();
  /** Receipt awaited by {@link StompTransport.close}, or null. */
  private closingReceipt: string | null = null;
  private closeTimer: number | null = null;

  private heartbeatTimer: number | null = null;
  private lastInboundAt = 0;
  private pingOutstanding = false;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private readonly onFrameHook: ((frame: StompFrame) => void) | null;
  private readonly heartbeatMs: number;
  private readonly protocols: string | string[];

  constructor(options: StompTransportOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    this.protocols = options.protocols ?? "stomp";
    this.onFrameHook = options.onFrame ?? null;
  }

  get state(): TransportState {
    return this.currentState;
  }

  /** Resolves once the STOMP handshake reaches CONNECTED. */
  connect(url: string, token: string): Promise<void> {
    if (this.currentState === "connected") return Promise.resolve();
    if (this.currentState === "connecting" && this.socket) return Promise.resolve();
    this.url = url;
    this.token = token;
    this.closeRequested = false;
    this.parser.reset();
    this.setState(this.currentState === "reconnecting" ? "reconnecting" : "connecting");

    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      let socket: WebSocket;
      try {
        socket = this.protocols ? new WebSocket(url, this.protocols) : new WebSocket(url);
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

  /** Non-fatal transport problems: protocol violations, unparsable frames. */
  onError(handler: (err: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  onReceipt(handler: (receiptId: string, sentAtMs: number, receivedAtMs: number) => void): void {
    this.receiptHandlers.push(handler);
  }


  /** Subscribes to a channel and returns its STOMP subscription id. */
  subscribe(channel: string): string {
    const id = `sub-${this.nextSubscriptionId++}`;
    this.subscriptions.set(channel, id);
    if (!isLobbyChannel(channel)) this.gameChannel = channel;
    this.writeFrame(encodeStompFrame("SUBSCRIBE", { id, destination: channel, ack: "auto" }));
    return id;
  }

  unsubscribe(channel: string): void {
    const id = this.subscriptions.get(channel);
    if (id === undefined) return;
    this.subscriptions.delete(channel);
    if (this.gameChannel === channel) this.gameChannel = null;
    this.writeFrame(encodeStompFrame("UNSUBSCRIBE", { id }));
  }

  /**
   * `identify` must precede every other message on a `game:` channel
   * (PROTOCOL.md §1); the server disconnects unidentified connections after
   * 15 s of silence.
   */
  identify(channel?: string): void {
    const destination = channel ?? this.gameChannel;
    if (!destination || isLobbyChannel(destination)) return;
    this.writeFrame(
      encodeStompFrame(
        "SEND",
        { destination, "content-type": "application/json;charset=utf-8" },
        JSON.stringify({ v: PROTOCOL_VERSION, t: "identify", token: this.token }),
      ),
    );
  }

  /**
   * Sends a protocol message to its natural channel with a STOMP `receipt`, so
   * the server acknowledges receipt. The receipt id is the command id, giving a
   * 1:1 mapping from a `RECEIPT` frame back to the batch it acknowledges.
   */
  send(message: ClientMessage): void {
    const destination = isLobbyMessage(message) ? LOBBY_CHANNEL : this.gameChannel;
    if (destination === null) {
      this.raise(new Error(`no game channel subscribed for ${message.t}`));
      return;
    }
    const headers: Record<string, string> = {
      destination,
      "content-type": "application/json;charset=utf-8",
    };
    if ("id" in message && typeof message.id === "string") {
      headers.receipt = message.id;
      this.trackReceipt(message.id);
    }
    this.writeFrame(encodeStompFrame("SEND", headers, JSON.stringify(message)));

  }

  /**
   * Sends `DISCONNECT` and closes. STOMP 1.2 asks the client to wait for the
   * server's `RECEIPT` before dropping the socket, so a graceful close does
   * not race the frame off the wire; a grace timer bounds the wait for a peer
   * that never answers.
   */
  close(): void {
    this.closeRequested = true;
    this.stopHeartbeat();
    const socket = this.socket;
    if (socket && socket.readyState === 1) {
      const receipt = `bye-${this.nextSubscriptionId++}`;
      this.closingReceipt = receipt;
      try {
        socket.send(encodeStompFrame("DISCONNECT", { receipt }));
      } catch {
        // Socket already dying; the close below is what matters.
      }
      this.closeTimer = setTimeout(() => this.finishClose(), DISCONNECT_GRACE_MS) as unknown as number;
      return;
    }
    this.finishClose();
  }

  private finishClose(): void {
    this.stopHeartbeat();
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    const socket = this.socket;
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) socket.close();
    this.socket = null;
    this.connected = false;
    this.subscriptions.clear();
    this.gameChannel = null;
    this.receiptsSent.clear();
    this.closingReceipt = null;
    this.outbox.length = 0;
    this.setState("closed");
  }

  /** Timestamp of the last inbound byte; the reconnect controller's liveness. */
  lastActivity(): number {
    return this.lastInboundAt;
  }

  /* ------------------------------------------------------------- internals */
  private trackReceipt(receiptId: string): void {
    if (this.receiptsSent.size >= MAX_TRACKED_RECEIPTS) {
      const oldest = this.receiptsSent.keys().next();
      if (!oldest.done) this.receiptsSent.delete(oldest.value);
    }
    this.receiptsSent.set(receiptId, Date.now());
  }


  private onOpen(): void {
    this.parser.reset();
    this.connected = false;
    // Anything queued while the socket was down goes out after CONNECT, in the
    // order it was issued, so SUBSCRIBE still precedes SEND.
    const queued = this.outbox;
    this.outbox = [];
    this.socket?.send(
      encodeStompFrame("CONNECT", {
        "accept-version": "1.2",
        // <desired send interval>,<desired receive interval>: we answer the
        // server's pings immediately, and ask it to ping at least this often.
        "heart-beat": `0,${Math.round(this.heartbeatMs / 2)}`,
        host: hostOf(this.url),
      }),
    );
    for (const frame of queued) this.socket?.send(frame);
    this.lastInboundAt = Date.now();
  }

  private onText(text: string): void {
    this.lastInboundAt = Date.now();
    for (const frame of this.parser.push(text)) {
      this.onFrameHook?.(frame);
      if (frame.command === "") {
        // Heart-beat in: answer with a bare EOL, or the server drops us.
        this.pingOutstanding = false;
        this.writeRaw("\n");
        continue;
      }
      switch (frame.command) {
        case "CONNECTED":
          this.connected = true;
          this.setState("connected");
          this.startHeartbeat();
          this.connectResolve?.();
          this.connectResolve = null;
          this.connectReject = null;
          break;
        case "MESSAGE":
          this.onMessageFrame(frame);
          break;
        case "RECEIPT":
          this.onReceiptFrame(frame);
          break;
        case "ERROR":
          this.raise(new Error(frame.headers.get("message") ?? "stomp error"));
          break;
        default:
          break;
      }
    }
  }

  private onMessageFrame(frame: StompFrame): void {
    if (!frame.body) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.body);
    } catch {
      this.raise(new Error("malformed message body"));
      return;
    }
    if (!isServerMessage(parsed)) {
      this.raise(new Error(`unsupported protocol message: ${String((parsed as { t?: unknown } | null)?.t)}`));
      return;
    }
    for (const handler of this.messageHandlers) handler(parsed);
  }

  private onReceiptFrame(frame: StompFrame): void {
    const receiptId = frame.headers.get("receipt-id");
    if (receiptId === undefined) return;
    const sentAtMs = this.receiptsSent.get(receiptId);
    this.receiptsSent.delete(receiptId);
    const receivedAtMs = this.lastInboundAt;
    if (receiptId === this.closingReceipt) {
      this.finishClose();
      return;
    }
    for (const handler of this.receiptHandlers) {
      handler(receiptId, sentAtMs ?? receivedAtMs, receivedAtMs);
    }
  }

  private onClose(ev: CloseEvent): void {
    this.stopHeartbeat();
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.socket = null;
    this.connected = false;
    this.subscriptions.clear();
    this.gameChannel = null;
    this.outbox.length = 0;
    this.receiptsSent.clear();
    if (this.connectReject) {
      const err = new Error(`cable closed before the STOMP handshake (code ${ev.code})`);
      this.connectReject(err);
      this.connectResolve = null;
      this.connectReject = null;
    }
    this.setState(this.closeRequested ? "closed" : "reconnecting");
  }

  private writeFrame(frame: string): void {
    if (!this.connected) {
      if (this.outbox.length < MAX_OUTBOX) this.outbox.push(frame);
      return;
    }
    this.writeRaw(frame);
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
      // A socket silent far past the negotiated window is dead; closing it
      // moves us to `reconnecting`.
      if (Date.now() - this.lastInboundAt > this.heartbeatMs * 3) {
        this.socket?.close();
        return;
      }
      if (this.pingOutstanding) return;
      this.pingOutstanding = true;
      this.writeRaw("\n");
    }, this.heartbeatMs) as unknown as number;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
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

/** PROTOCOL.md §1–§2: lobby traffic goes to `lobby`, gameplay to `game:<id>`. */
function isLobbyMessage(message: ClientMessage): boolean {
  return message.t.startsWith("lobby:");
}
