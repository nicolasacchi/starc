/**
 * Typed `fetch` wrappers for every REST endpoint in PROTOCOL.md §7.
 *
 * Three things every call here shares:
 *
 * - **One error shape.** The server always answers a failure with
 *   `{ "error": { "code", "message" } }` and a matching HTTP status. That is
 *   parsed into {@link ApiError} so a caller can branch on `code` rather than
 *   regex a message, and a non-JSON failure (a proxy 502, an HTML error page)
 *   still yields a usable error instead of a parse crash.
 * - **A timeout.** Every request is raced against an `AbortController`, because
 *   a hung socket with no timeout is an infinite spinner, not an error.
 * - **The bearer token.** Read from `localStorage` under `starc.token` on every
 *   request, so a login performed anywhere in the app is picked up without
 *   threading a token through every call site. The client also exposes
 *   `setToken` / `clearToken` for the auth store to drive, and the module-level
 *   `authToken` / `setAuthToken` accessors for code that is not holding a
 *   client instance.
 *
 * `baseUrl` defaults to the relative `/api/v1`, which the Vite dev server
 * proxies to Rails (§7 lives behind the same origin in production too).
 */
import type { MapDef, MatchMode, MatchStatus, Race, RaceData } from "@shared/protocol";

/** `localStorage` key holding the session token. */
export const TOKEN_STORAGE_KEY = "starc.token";
export const DEFAULT_BASE_URL = "/api/v1";
export const DEFAULT_TIMEOUT_MS = 10_000;

/** A failed REST call: HTTP status plus the server's own error code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Response body as text, for diagnostics when the body was not JSON. */
  readonly body: string;

  constructor(code: string, message: string, status: number, body = "") {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.body = body;
  }

  /** True when the failure is a lost or hung connection, not a server verdict. */
  get isNetwork(): boolean {
    return this.code === "network_error" || this.code === "timeout";
  }
}

/* ------------------------------------------------------------------ models */

/** `player_json` from the server's base controller. */
export interface PlayerJson {
  id: number;
  name: string;
  wins: number;
  losses: number;
  draws: number;
  kills: number;
  deaths: number;
  resources_mined: number;
  units_built: number;
  rating: number;
  created_at: string | null;
}

export interface SessionResponse {
  token: string;
  player: PlayerJson;
}

export interface MeResponse {
  player: PlayerJson;
}

/** One seat in a match, as `match_player_json` renders it. */
export interface MatchPlayerJson {
  player_id: number;
  name: string;
  slot: number;
  team: number;
  race: Race;
  host: boolean;
  ready: boolean;
  result: "win" | "loss" | "draw" | "pending";
  kills: number;
  deaths: number;
  resources_mined: number;
  units_built: number;
  army_value: number;
}

/** The caller's own seat, present only on authenticated views. */
export interface MatchSeatJson {
  player_id: number;
  slot: number;
  race: Race;
  ready: boolean;
  host: boolean;
}

export interface MatchJson {
  id: number;
  name: string;
  mode: MatchMode;
  map_id: string;
  max_players: number;
  player_count: number;
  status: MatchStatus;
  has_password: boolean;
  host: string;
  seed: number;
  winner_player_id: number | null;
  end_reason: string | null;
  duration_ms: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string | null;
  players: MatchPlayerJson[];
  you: MatchSeatJson | null;
}

export interface MatchListResponse {
  matches: MatchJson[];
  page: number;
  per_page: number;
  total: number;
}

export interface MatchResponse {
  match: MatchJson;
}

export interface RacesResponse {
  races: RaceData[];
}

export interface MapsResponse {
  maps: MapDef[];
}

export interface LeaderboardEntry {
  rank: number;
  player_id: number;
  name: string;
  race: string;
  mode: string;
  wins: number;
  losses: number;
  draws: number;
  rating: number;
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
}

export interface RaceStats {
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  win_rate: number;
  kills: number;
  deaths: number;
  kd_ratio: number;
  resources_mined: number;
  units_built: number;
}

export interface PlayerStats {
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  win_rate: number;
  kills: number;
  deaths: number;
  kd_ratio: number;
  resources_mined: number;
  units_built: number;
  by_race: Record<string, RaceStats>;
}

export interface RecentMatch {
  match_id: number;
  name: string;
  mode: string;
  map_id: string;
  status: string;
  result: string;
  kills: number;
  deaths: number;
  resources_mined: number;
  units_built: number;
  started_at: string | null;
  ended_at: string | null;
}

export interface PlayerStatsResponse {
  player: PlayerJson;
  stats: PlayerStats;
  recent_matches: RecentMatch[];
}

/** `GET /matches/:id/replay` — the replay with its final state elided. */
export interface ReplayResponse {
  header: {
    match_id: number;
    map_id: string;
    seed: number;
    mode: MatchMode;
    started_at: string;
    duration_ms: number;
    winner: number | null;
    players: { player_id: number; name: string; race: Race; team: number; result: string }[];
  };
  commands: { tick: number; player_id: number; index: number }[];
  snapshots_meta: { ticks: number; rate: number } | null;
  replay_url: string;
}

export interface CreateMatchRequest {
  name: string;
  mode: MatchMode;
  map_id: string;
  max_players: number;
  password?: string;
}

export interface ListMatchesQuery {
  status?: MatchStatus;
  mode?: MatchMode;
  map_id?: string;
  page?: number;
  per_page?: number;
}

/* ------------------------------------------------------------------- token */

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Blocked by browser privacy settings; the app runs without persistence.
    return null;
  }
}

/** The persisted session token, or null when signed out. */
export function authToken(): string | null {
  return safeRead(browserStorage());
}

/** Persists (or clears, with null) the session token. */
export function setAuthToken(token: string | null): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    if (token === null) storage.removeItem(TOKEN_STORAGE_KEY);
    else storage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Quota or private mode: the session simply will not survive a reload.
  }
}

/* ------------------------------------------------------------------ client */

export interface ApiClientOptions {
  /** Defaults to `/api/v1`; override for an absolute or different origin. */
  baseUrl?: string;
  /** Per-request timeout, ms. */
  timeoutMs?: number;
  /** `fetch` override, for tests or a request interceptor. */
  fetchImpl?: typeof fetch;
  /** Storage override; defaults to `localStorage`. */
  storage?: StorageLike | null;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly storage: StorageLike | null;
  /** Token override; when null the persisted token is used. */
  private token: string | null = null;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
  }

  /** The token this client will send: the override, else the stored one. */
  currentToken(): string | null {
    return this.token ?? safeRead(this.storage);
  }

  /** Overrides the stored token for this client's requests. */
  setToken(token: string | null): void {
    this.token = token;
  }

  /** Drops the override and any persisted token. */
  clearToken(): void {
    this.token = null;
    safeRemove(this.storage);
  }

  /* ------------------------------------------------------------------ auth */

  /** `POST /players` → 201 `{ token, player }`; stores the token. */
  async register(name: string, password: string): Promise<SessionResponse> {
    const session = await this.request<SessionResponse>("POST", "/players", { name, password });
    this.token = session.token;
    setAuthToken(session.token);
    return session;
  }

  /** `POST /session` → 200 `{ token, player }`; stores the token. */
  async login(name: string, password: string): Promise<SessionResponse> {
    const session = await this.request<SessionResponse>("POST", "/session", { name, password });
    this.token = session.token;
    setAuthToken(session.token);
    return session;
  }

  /** `DELETE /session` → 204. Clears the token whether or not it succeeds. */
  async logout(): Promise<void> {
    try {
      await this.request<null>("DELETE", "/session");
    } finally {
      this.clearToken();
    }
  }

  /** `GET /me` → 200 `{ player }`. */
  me(): Promise<MeResponse> {
    return this.request<MeResponse>("GET", "/me");
  }

  /** `GET /me/stats` → 200 player + aggregate stats + recent matches. */
  myStats(): Promise<PlayerStatsResponse> {
    return this.request<PlayerStatsResponse>("GET", "/me/stats");
  }

  /* -------------------------------------------------------------- game data */

  /** `GET /races` → 200 `{ races }`, the full roster. */
  races(): Promise<RacesResponse> {
    // Public read: no bearer token.
    return this.request<RacesResponse>("GET", "/races", undefined, false);
  }

  /** `GET /maps` → 200 `{ maps }`. */
  maps(): Promise<MapsResponse> {
    // Public read: no bearer token.
    return this.request<MapsResponse>("GET", "/maps", undefined, false);
  }

  /* ---------------------------------------------------------------- matches */

  /** `GET /matches` → 200 `{ matches, page, per_page, total }`. */
  listMatches(query: ListMatchesQuery = {}): Promise<MatchListResponse> {
    // Public read: the match browser is world-readable.
    return this.request<MatchListResponse>("GET", `/matches${queryString(query)}`, undefined, false);
  }

  /** `POST /matches` → 201 `{ match }`; the caller is seated as host. */
  createMatch(body: CreateMatchRequest): Promise<MatchResponse> {
    return this.request<MatchResponse>("POST", "/matches", body);
  }

  /** `GET /matches/:id` → 200 `{ match }` including every seat. */
  showMatch(matchId: number): Promise<MatchResponse> {
    return this.request<MatchResponse>("GET", `/matches/${matchId}`);
  }

  /** `POST /matches/:id/join` → 200 `{ match }`. */
  joinMatch(matchId: number, password?: string): Promise<MatchResponse> {
    return this.request<MatchResponse>("POST", `/matches/${matchId}/join`, password ? { password } : {});
  }

  /** `POST /matches/:id/leave` → 200 `{ match }`. */
  leaveMatch(matchId: number): Promise<MatchResponse> {
    return this.request<MatchResponse>("POST", `/matches/${matchId}/leave`, {});
  }

  /** `POST /matches/:id/ready` → 200 `{ match }`. */
  ready(matchId: number, ready = true): Promise<MatchResponse> {
    return this.request<MatchResponse>("POST", `/matches/${matchId}/ready`, { ready });
  }

  /** `POST /matches/:id/start` → 200 `{ match }`. Host only. */
  startMatch(matchId: number): Promise<MatchResponse> {
    return this.request<MatchResponse>("POST", `/matches/${matchId}/start`, {});
  }

  /** `POST /matches/:id/forfeit` → 200 `{ match }`. */
  forfeit(matchId: number): Promise<MatchResponse> {
    return this.request<MatchResponse>("POST", `/matches/${matchId}/forfeit`, {});
  }

  /* ----------------------------------------------------------------- replay */

  /** `GET /matches/:id/replay` → 200 replay metadata plus `replay_url`. */
  replay(matchId: number): Promise<ReplayResponse> {
    return this.request<ReplayResponse>("GET", `/matches/${matchId}/replay`);
  }

  /** `GET /matches/:id/replay.json` → 200 the full deterministic replay. */
  replayJson(matchId: number): Promise<unknown> {
    return this.request<unknown>("GET", `/matches/${matchId}/replay.json`);
  }

  /* ------------------------------------------------------------ scoreboards */

  /** `GET /leaderboard` → 200 `{ entries }`, optionally filtered. */
  leaderboard(query: { race?: Race; mode?: MatchMode; limit?: number } = {}): Promise<LeaderboardResponse> {
    return this.request<LeaderboardResponse>("GET", `/leaderboard${queryString(query)}`);
  }

  /** `GET /players/:name/stats` → 200 player + stats + recent matches. */
  playerStats(name: string): Promise<PlayerStatsResponse> {
    return this.request<PlayerStatsResponse>("GET", `/players/${encodeURIComponent(name)}/stats`);
  }

  /* --------------------------------------------------------------- plumbing */

  /**
   * One request. Parses the error envelope into {@link ApiError} and times out
   * through an `AbortController` so a stalled server cannot hang the UI.
   */
  private async request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    // Only authenticated calls carry the bearer token. The roster, the map
    // list and the match browser are public reads, and sending the session
    // token to an endpoint that does not need it hands it to whatever origin
    // `baseUrl` names for no benefit.
    const token = auth ? this.currentToken() : null;
    if (token) headers.authorization = `Bearer ${token}`;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        credentials: "same-origin",
      });
    } catch (err) {
      const aborted = controller.signal.aborted;
      throw new ApiError(
        aborted ? "timeout" : "network_error",
        aborted ? `request timed out after ${this.timeoutMs}ms` : describe(err),
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 204) return null as T;
    const text = await response.text();
    if (!response.ok) throw apiError(response.status, text);
    if (text.length === 0) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError("invalid_response", "response was not JSON", response.status, text);
    }
  }
}

/** Builds the error envelope into an {@link ApiError}, whatever the body. */
function apiError(status: number, body: string): ApiError {
  let code = "server_error";
  let message = `request failed with status ${status}`;
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } };
    if (typeof parsed.error?.code === "string") code = parsed.error.code;
    if (typeof parsed.error?.message === "string") message = parsed.error.message;
  } catch {
    // A proxy error page or an empty body: keep the status-derived message.
  }
  return new ApiError(code, message, status, body);
}

function queryString(query: object): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeRead(storage: StorageLike | null): string | null {
  try {
    return storage?.getItem(TOKEN_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function safeRemove(storage: StorageLike | null): void {
  try {
    storage?.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Nothing to do: the in-memory token is already gone.
  }
}
