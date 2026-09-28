/**
 * Tests for the REST client, `net/api.ts`.
 *
 * The layer exists to translate the wire into something the UI can act on: a
 * 401, a 422 and a 500 must be *distinguishable*, a dropped connection must
 * never look like success, and the bearer token must ride on exactly the calls
 * that need it. The expectations below are cross-checked against
 * `server/config/routes.rb`, the `api/v1` controllers (the single error
 * envelope `{error:{code,message}}` in `base_controller.rb`) and the lobby
 * table in `docs/PROTOCOL.md` §2 — not against the client implementation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, DEFAULT_BASE_URL, TOKEN_STORAGE_KEY, authToken, setAuthToken } from "./api";

/* ------------------------------------------------------------------ harness */

interface Call {
  url: string;
  init: RequestInit;
}

interface Recorded {
  calls: Call[];
  /** JSON body of call `n`, or undefined when the request had none. */
  body(index?: number): unknown;
  headers(index?: number): Record<string, string>;
  url(index?: number): string;
  method(index?: number): string;
  last(): Call;
}

/** A `fetch` that answers from a queue of scripted responses. */
function scripted(responses: Response[]): { fetchImpl: typeof fetch; recorded: Recorded } {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request to ${String(input)}`);
    return next;
  }) as unknown as typeof fetch;

  const headersOf = (index = 0): Record<string, string> => {
    const raw = calls[index]?.init.headers;
    return typeof raw === "object" && raw !== null ? (raw as Record<string, string>) : {};
  };
  return {
    fetchImpl,
    recorded: {
      calls,
      body(index = 0): unknown {
        const body = calls[index]?.init.body;
        return body === undefined ? undefined : JSON.parse(String(body));
      },
      headers: headersOf,
      url: (index = 0) => calls[index]?.url ?? "",
      method: (index = 0) => String(calls[index]?.init.method ?? ""),
      last(): Call {
        const call = calls[calls.length - 1];
        if (!call) throw new Error("no request was made");
        return call;
      },
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A `localStorage` stand-in — the module reads it by global name. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
}

const PLAYER = {
  id: 7,
  name: "nik",
  wins: 3,
  losses: 1,
  draws: 0,
  kills: 40,
  deaths: 12,
  resources_mined: 9000,
  units_built: 60,
  rating: 1200,
  created_at: "2026-01-01T00:00:00Z",
};

const MATCH = {
  id: 12,
  name: "scrim",
  mode: "melee",
  map_id: "altaior",
  max_players: 2,
  player_count: 1,
  status: "lobby",
  has_password: false,
  host: "nik",
  seed: 1234,
  winner_player_id: null,
  end_reason: null,
  duration_ms: null,
  started_at: null,
  ended_at: null,
  created_at: "2026-01-01T00:00:00Z",
  players: [
    {
      player_id: 7,
      name: "nik",
      slot: 0,
      team: 1,
      race: "terran",
      host: true,
      ready: false,
      result: "pending",
      kills: 0,
      deaths: 0,
      resources_mined: 0,
      units_built: 0,
      army_value: 0,
    },
  ],
  you: { player_id: 7, slot: 0, race: "terran", ready: false, host: true },
};

/* ------------------------------------------------------------------- setup */

const realFetch = globalThis.fetch;

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: memoryStorage(), configurable: true, writable: true });
});

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", { value: realFetch, configurable: true, writable: true });
  vi.useRealTimers();
});

/* ------------------------------------------------------- error translation */

describe("error translation", () => {
  it("turns a 401 into an unauthenticated ApiError carrying the server's code and message", async () => {
    const { fetchImpl } = scripted([json({ error: { code: "unauthenticated", message: "A valid bearer token is required" } }, 401)]);
    const client = new ApiClient({ fetchImpl, storage: null });

    const err = await client.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const api = err as ApiError;
    expect(api.status).toBe(401);
    expect(api.code).toBe("unauthenticated");
    expect(api.message).toBe("A valid bearer token is required");
    // A server verdict is not a connection problem: retrying will not help.
    expect(api.isNetwork).toBe(false);
  });

  it("turns a 422 into a distinct invalid_payload ApiError, distinguishable from the 401", async () => {
    const { fetchImpl } = scripted([json({ error: { code: "invalid_payload", message: "name and password are required" } }, 422)]);
    const client = new ApiClient({ fetchImpl, storage: null });

    const err = (await client.register("", "").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("invalid_payload");
    expect(err.message).toBe("name and password are required");
  });

  it("turns a 500 into a server_error ApiError rather than a silent success", async () => {
    const { fetchImpl } = scripted([json({ error: { code: "server_error", message: "boom" } }, 500)]);
    const client = new ApiClient({ fetchImpl, storage: null });

    const err = (await client.me().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.code).toBe("server_error");
    expect(err.isNetwork).toBe(false);
  });

  it("keeps 401, 422 and 500 mutually distinguishable in code and status", async () => {
    const cases: [number, string][] = [
      [401, "unauthenticated"],
      [422, "invalid_payload"],
      [500, "server_error"],
    ];
    const errors: ApiError[] = [];
    for (const [status, code] of cases) {
      const { fetchImpl } = scripted([json({ error: { code, message: `m${status}` } }, status)]);
      const client = new ApiClient({ fetchImpl, storage: null });
      errors.push((await client.me().catch((e: unknown) => e)) as ApiError);
    }
    expect(new Set(errors.map((e) => e.code)).size).toBe(3);
    expect(errors.map((e) => e.status)).toEqual([401, 422, 500]);
  });

  it("rejects — never resolves undefined — when the network itself fails", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const client = new ApiClient({ fetchImpl, storage: null });

    const outcome = await client.me().then(
      (value) => ({ resolved: value }),
      (error: unknown) => ({ rejected: error }),
    );
    expect(outcome).toHaveProperty("rejected");
    const err = (outcome as { rejected: unknown }).rejected as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("network_error");
    expect(err.isNetwork).toBe(true);
    // The underlying cause is preserved in the message, or debugging a flaky
    // connection is impossible.
    expect(err.message).toContain("fetch failed");
  });

  it("reports a stalled request as a timeout, not a network error", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const client = new ApiClient({ fetchImpl, storage: null, timeoutMs: 5 });

    const err = (await client.me().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("timeout");
    expect(err.status).toBe(0);
    expect(err.isNetwork).toBe(true);
  });

  it("does not mistake a non-JSON error body for a parsed success", async () => {
    const html = new Response("<html>502 Bad Gateway</html>", { status: 502 });
    const { fetchImpl } = scripted([html]);
    const client = new ApiClient({ fetchImpl, storage: null });

    const err = (await client.me().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    // Nothing to take code/message from: it falls back to the status-derived
    // shape rather than throwing a raw SyntaxError.
    expect(err.code).toBe("server_error");
    expect(err.message).toBe("request failed with status 502");
    expect(err.body).toContain("Bad Gateway");
  });

  it("does not mistake a non-JSON 200 body for a successful response", async () => {
    const { fetchImpl } = scripted([new Response("not json at all", { status: 200 })]);
    const client = new ApiClient({ fetchImpl, storage: null });

    const err = (await client.me().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("invalid_response");
    expect(err.status).toBe(200);
    expect(err.body).toBe("not json at all");
  });

  it("ignores a non-string code or message in the envelope instead of leaking undefined", async () => {
    const { fetchImpl } = scripted([json({ error: { code: 42, message: null } }, 409)]);
    const client = new ApiClient({ fetchImpl, storage: null });

    const err = (await client.me().catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("server_error");
    expect(err.message).toBe("request failed with status 409");
  });

  it("keeps the status-derived fallback for an empty error body", async () => {
    const { fetchImpl } = scripted([new Response("", { status: 403 })]);
    const client = new ApiClient({ fetchImpl, storage: null });

    const err = (await client.me().catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(403);
    expect(err.code).toBe("server_error");
    expect(err.message).toBe("request failed with status 403");
  });
});

/* --------------------------------------------------------------------- auth */

describe("auth", () => {
  it("attaches the bearer token to authenticated calls", async () => {
    const { fetchImpl, recorded } = scripted([json({ player: PLAYER })]);
    const client = new ApiClient({ fetchImpl, storage: null });
    client.setToken("tok-123");

    await client.me();
    expect(recorded.headers().authorization).toBe("Bearer tok-123");
  });

  it("attaches the persisted token, not just the in-memory override", async () => {
    const { fetchImpl, recorded } = scripted([json({ player: PLAYER })]);
    const client = new ApiClient({ fetchImpl, storage: memoryStorage({ [TOKEN_STORAGE_KEY]: "stored-token" }) });

    await client.me();
    expect(recorded.headers().authorization).toBe("Bearer stored-token");
  });

  it("sends no authorization header at all when there is no token", async () => {
    const { fetchImpl, recorded } = scripted([json({ races: [] })]);
    const client = new ApiClient({ fetchImpl, storage: null });

    await client.races();
    expect(Object.keys(recorded.headers())).not.toContain("authorization");
  });

  it("does not require a token for the public reads: races, maps and the match index", async () => {
    // The public reads must not carry the session token. Attaching it to
    // endpoints that do not need it hands the token to whatever origin
    // `baseUrl` names, for no benefit — the server skips `require_auth!` on
    // these routes precisely because they are world-readable.
    const { fetchImpl, recorded } = scripted([json({ races: [] }), json({ maps: [] }), json({ matches: [], page: 1, per_page: 25, total: 0 })]);
    const client = new ApiClient({ fetchImpl, storage: null });
    client.setToken("tok-123");

    await client.races();
    await client.maps();
    await client.listMatches();

    // Public: they succeed with no token at all, and none is persisted.
    const anonymous = new ApiClient({ fetchImpl: scripted([json({ races: [] })]).fetchImpl, storage: null });
    await expect(anonymous.races()).resolves.toEqual({ races: [] });

    expect(recorded.calls).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(recorded.headers(i).authorization).toBeUndefined();
    }
  });

  it("still authenticates the calls that need it", async () => {
    // The other half of the invariant: marking the public reads must not have
    // cost the private ones their token.
    const { fetchImpl, recorded } = scripted([json({ match: { id: 1 } }), json({ player: { id: 1 } })]);
    const client = new ApiClient({ fetchImpl, storage: null });
    client.setToken("tok-456");

    await client.createMatch({ name: "n", mode: "melee", map_id: "altaior", max_players: 2 });
    await client.me();

    expect(recorded.headers(0).authorization).toBe("Bearer tok-456");
    expect(recorded.headers(1).authorization).toBe("Bearer tok-456");
  });

  it("still sends the token to the per-match reads, which the server serves to anyone", async () => {
    const { fetchImpl, recorded } = scripted([json({ match: MATCH }), json({ match: MATCH })]);
    const client = new ApiClient({ fetchImpl, storage: null });
    client.setToken("tok-123");

    await client.showMatch(12);
    await client.replay(12);
    // The server returns the caller's own seat in `you` only when it can
    // resolve the bearer, so these must not be sent anonymously.
    expect(recorded.headers(0).authorization).toBe("Bearer tok-123");
    expect(recorded.headers(1).authorization).toBe("Bearer tok-123");
  });

  it("round-trips the token through localStorage under starc.token", async () => {
    const { fetchImpl } = scripted([json({ token: "tok-abc", player: PLAYER }, 201)]);
    const client = new ApiClient({ fetchImpl });

    const session = await client.register("nik", "hunter2");
    expect(session.token).toBe("tok-abc");
    expect(authToken()).toBe("tok-abc");
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("tok-abc");
  });

  it("clears the stored token when setAuthToken(null) is called", async () => {
    setAuthToken("tok-abc");
    expect(authToken()).toBe("tok-abc");

    setAuthToken(null);
    expect(authToken()).toBeNull();
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("stops sending the token after logout(), so a stale one is never replayed", async () => {
    const { fetchImpl, recorded } = scripted([json({ token: "tok-abc", player: PLAYER }, 201), new Response(null, { status: 204 }), json({ player: PLAYER })]);
    const client = new ApiClient({ fetchImpl });
    await client.login("nik", "hunter2");

    await client.logout();
    expect(recorded.headers(1).authorization).toBe("Bearer tok-abc");
    // The 204 is the whole body of a DELETE /session.
    expect(recorded.method(1)).toBe("DELETE");

    await client.me();
    expect(recorded.headers(2).authorization).toBeUndefined();
    expect(client.currentToken()).toBeNull();
  });

  it("clears the token even when logout fails, so a retry cannot reuse it", async () => {
    const { fetchImpl } = scripted([json({ error: { code: "unauthenticated", message: "A valid bearer token is required" } }, 401)]);
    const client = new ApiClient({ fetchImpl, storage: memoryStorage({ [TOKEN_STORAGE_KEY]: "stale" }) });

    await expect(client.logout()).rejects.toBeInstanceOf(ApiError);
    expect(client.currentToken()).toBeNull();
    expect(authToken()).toBeNull();
  });

  it("lets an in-memory override shadow a stale stored token", async () => {
    const { fetchImpl, recorded } = scripted([json({ player: PLAYER }), json({ player: PLAYER })]);
    const client = new ApiClient({ fetchImpl, storage: memoryStorage({ [TOKEN_STORAGE_KEY]: "stale" }) });
    client.setToken("fresh");

    await client.me();
    expect(recorded.headers().authorization).toBe("Bearer fresh");

    client.setToken(null);
    await client.me();
    // Back to the persisted value, not a leftover override.
    expect(recorded.headers(1).authorization).toBe("Bearer stale");
  });

  it("keeps working when localStorage throws on every access", async () => {
    const hostile = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const { fetchImpl } = scripted([json({ token: "tok", player: PLAYER }, 201)]);
    const client = new ApiClient({ fetchImpl, storage: hostile });

    const session = await client.register("nik", "hunter2");
    expect(session.token).toBe("tok");
    // Nothing persisted, but the in-memory override still authenticates.
    expect(client.currentToken()).toBe("tok");
    expect(() => client.clearToken()).not.toThrow();
    expect(() => setAuthToken("x")).not.toThrow();
    expect(() => authToken()).not.toThrow();

    const second = scripted([json({ player: PLAYER })]);
    const anon = new ApiClient({ fetchImpl: second.fetchImpl, storage: hostile });
    await anon.me();
    expect(second.recorded.headers().authorization).toBeUndefined();
  });
});

/* ------------------------------------------------------------ request shape */

describe("request shape", () => {
  it("registers with POST /players and the {name,password} body", async () => {
    const { fetchImpl, recorded } = scripted([json({ token: "t", player: PLAYER }, 201)]);
    const client = new ApiClient({ fetchImpl, storage: null });

    await client.register("nik", "hunter2");
    expect(recorded.url()).toBe(`${DEFAULT_BASE_URL}/players`);
    expect(recorded.method()).toBe("POST");
    expect(recorded.body()).toEqual({ name: "nik", password: "hunter2" });
    expect(recorded.headers()["content-type"]).toBe("application/json");
  });

  it("logs in with POST /session", async () => {
    const { fetchImpl, recorded } = scripted([json({ token: "t", player: PLAYER })]);
    const client = new ApiClient({ fetchImpl, storage: null });

    await client.login("nik", "hunter2");
    expect(recorded.url()).toBe(`${DEFAULT_BASE_URL}/session`);
    expect(recorded.method()).toBe("POST");
    expect(recorded.body()).toEqual({ name: "nik", password: "hunter2" });
  });

  it("sends no body or content-type on a bare GET", async () => {
    const { fetchImpl, recorded } = scripted([json({ player: PLAYER })]);
    const client = new ApiClient({ fetchImpl, storage: null });

    await client.me();
    expect(recorded.last().init.body).toBeUndefined();
    expect(recorded.headers()["content-type"]).toBeUndefined();
    expect(recorded.headers().accept).toBe("application/json");
  });

  it("maps every match action onto the routes in server/config/routes.rb", async () => {
    const { fetchImpl, recorded } = scripted([
      json({ matches: [], page: 1, per_page: 25, total: 0 }),
      json({ match: MATCH }, 201),
      json({ match: MATCH }),
      json({ match: MATCH }),
      json({ match: MATCH }),
      json({ match: MATCH }),
      json({ match: MATCH }),
      json({ match: MATCH }),
      json({ match: MATCH }),
    ]);
    const client = new ApiClient({ fetchImpl, storage: null });

    await client.listMatches();
    await client.createMatch({ name: "scrim", mode: "melee", map_id: "altaior", max_players: 2 });
    await client.showMatch(12);
    await client.joinMatch(12);
    await client.joinMatch(12, "pw");
    await client.leaveMatch(12);
    await client.ready(12);
    await client.startMatch(12);
    await client.forfeit(12);

    const seen = recorded.calls.map((c) => `${c.init.method} ${c.url}`);
    expect(seen).toEqual([
      `GET ${DEFAULT_BASE_URL}/matches`,
      `POST ${DEFAULT_BASE_URL}/matches`,
      `GET ${DEFAULT_BASE_URL}/matches/12`,
      `POST ${DEFAULT_BASE_URL}/matches/12/join`,
      `POST ${DEFAULT_BASE_URL}/matches/12/join`,
      `POST ${DEFAULT_BASE_URL}/matches/12/leave`,
      `POST ${DEFAULT_BASE_URL}/matches/12/ready`,
      `POST ${DEFAULT_BASE_URL}/matches/12/start`,
      `POST ${DEFAULT_BASE_URL}/matches/12/forfeit`,
    ]);
  });

  it("sends the join password in the body when one is given, and nothing when it is not", async () => {
    const { fetchImpl, recorded } = scripted([json({ match: MATCH }), json({ match: MATCH })]);
    const client = new ApiClient({ fetchImpl, storage: null });

    await client.joinMatch(12, "hunter2");
    expect(recorded.body(0)).toEqual({ password: "hunter2" });
    await client.joinMatch(12, "");
    // An empty password is no password; sending `""` would ask the server to
    // check the hash against the empty string.
    expect(recorded.body(1)).toEqual({});
  });

  it("sends the ready flag as a JSON boolean, which is what coerce_bool requires", async () => {
    const { fetchImpl, recorded } = scripted([json({ match: MATCH }), json({ match: MATCH })]);
    const client = new ApiClient({ fetchImpl, storage: null });

    await client.ready(12);
    expect(recorded.body(0)).toEqual({ ready: true });
    await client.ready(12, false);
    expect(recorded.body(1)).toEqual({ ready: false });
  });

  it("sends a create-match body the server can read, including the optional password", async () => {
    const { fetchImpl, recorded } = scripted([json({ match: MATCH }, 201)]);
    const client = new ApiClient({ fetchImpl, storage: null });

    await client.createMatch({ name: "scrim", mode: "melee", map_id: "altaior", max_players: 4, password: "pw" });
    expect(recorded.body()).toEqual({ name: "scrim", mode: "melee", map_id: "altaior", max_players: 4, password: "pw" });
  });

  it("encodes the match-list filters and pagination the server reads", async () => {
    const { fetchImpl, recorded } = scripted([json({ matches: [], page: 3, per_page: 10, total: 0 })]);
    const client = new ApiClient({ fetchImpl, storage: null });

    await client.listMatches({ status: "lobby", mode: "melee", map_id: "altaior", page: 3, per_page: 10 });
    const url = recorded.url();
    expect(url.startsWith(`${DEFAULT_BASE_URL}/matches?`)).toBe(true);
    const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(Object.fromEntries(query)).toEqual({
      status: "lobby",
      mode: "melee",
      map_id: "altaior",
      page: "3",
      per_page: "10",
    });
  });

  it("percent-encodes filter values instead of emitting raw query syntax", async () => {
    const { fetchImpl, recorded } = scripted([json({ matches: [], page: 1, per_page: 25, total: 0 })]);
    const client = new ApiClient({ fetchImpl, storage: null });

    await client.listMatches({ map_id: "two words&more" });
    const url = recorded.url();
    expect(url).toContain("map_id=two%20words%26more");
    expect(url.split("?")[1].split("&")).toHaveLength(1);
  });

  it("omits undefined filters instead of sending the literal string 'undefined'", async () => {
    const { fetchImpl, recorded } = scripted([json({ matches: [], page: 1, per_page: 25, total: 0 })]);
    const client = new ApiClient({ fetchImpl, storage: null });

    await client.listMatches({ mode: undefined, page: 2 });
    expect(recorded.url()).toBe(`${DEFAULT_BASE_URL}/matches?page=2`);
  });

  it("encodes the leaderboard filters and drops the empty case entirely", async () => {
    const { fetchImpl, recorded } = scripted([json({ entries: [] }), json({ entries: [] })]);
    const client = new ApiClient({ fetchImpl, storage: null });

    await client.leaderboard({ race: "terran", mode: "melee", limit: 20 });
    expect(recorded.url(0)).toBe(`${DEFAULT_BASE_URL}/leaderboard?race=terran&mode=melee&limit=20`);

    await client.leaderboard();
    expect(recorded.url(1)).toBe(`${DEFAULT_BASE_URL}/leaderboard`);
  });

  it("escapes a player name in the path, so a hostile name cannot add a query or a path segment", async () => {
    const { fetchImpl, recorded } = scripted([json({ player: PLAYER, stats: {}, recent_matches: [] })]);
    const client = new ApiClient({ fetchImpl, storage: null });

    await client.playerStats("a/../me?x=1");
    expect(recorded.url()).toBe(`${DEFAULT_BASE_URL}/players/a%2F..%2Fme%3Fx%3D1/stats`);
    expect(recorded.url()).not.toContain("?");
  });

  it("asks for the two distinct replay representations", async () => {
    const { fetchImpl, recorded } = scripted([json({ header: {}, commands: [], replay_url: "/x" }), json({ header: {} })]);
    const client = new ApiClient({ fetchImpl, storage: null });

    await client.replay(12);
    await client.replayJson(12);
    expect(recorded.url(0)).toBe(`${DEFAULT_BASE_URL}/matches/12/replay`);
    expect(recorded.url(1)).toBe(`${DEFAULT_BASE_URL}/matches/12/replay.json`);
    expect(recorded.method(1)).toBe("GET");
  });

  it("normalises a trailing slash on the base URL so paths do not double up", async () => {
    const { fetchImpl, recorded } = scripted([json({ races: [] })]);
    const client = new ApiClient({ fetchImpl, baseUrl: "https://starc.test/api/v1///", storage: null });

    await client.races();
    expect(recorded.url()).toBe("https://starc.test/api/v1/races");
  });

  it("does not throw when the caller passes no base URL at all", async () => {
    const { fetchImpl, recorded } = scripted([json({ maps: [] })]);
    const client = new ApiClient({ fetchImpl, storage: null });

    await client.maps();
    expect(recorded.url()).toBe(`${DEFAULT_BASE_URL}/maps`);
  });
});

/* ----------------------------------------------------------- response shape */

describe("response shape", () => {
  it("surfaces the session token and the player the server rendered", async () => {
    const { fetchImpl } = scripted([json({ token: "tok", player: PLAYER }, 201)]);
    const client = new ApiClient({ fetchImpl, storage: null });

    const session = await client.register("nik", "hunter2");
    expect(session.player.name).toBe("nik");
    expect(session.player.rating).toBe(1200);
  });

  it("surfaces the list envelope the match browser paginates on", async () => {
    const { fetchImpl } = scripted([json({ matches: [MATCH], page: 2, per_page: 25, total: 51 })]);
    const client = new ApiClient({ fetchImpl, storage: null });

    const list = await client.listMatches({ page: 2 });
    expect(list.page).toBe(2);
    expect(list.per_page).toBe(25);
    expect(list.total).toBe(51);
    expect(list.matches[0].id).toBe(12);
  });

  it("leaves the optional match fields null rather than inventing them", async () => {
    const { fetchImpl } = scripted([json({ match: { id: 3, name: "n", status: "lobby", players: [] } })]);
    const client = new ApiClient({ fetchImpl, storage: null });

    const match = (await client.showMatch(3)).match;
    // A public view has no `you`, and an unfinished match has no winner.
    expect(match.you).toBeUndefined();
    expect(match.winner_player_id).toBeUndefined();
    expect(match.id).toBe(3);
    expect(match.players).toEqual([]);
  });

  it("reads the replay header and command list the way the player renders it", async () => {
    const header = {
      match_id: 12,
      map_id: "altaior",
      seed: 987,
      mode: "melee",
      started_at: "2026-01-01T00:00:00Z",
      duration_ms: 1000,
      winner: 7,
      players: [{ player_id: 7, name: "nik", race: "terran", team: 1, result: "win" }],
    };
    const { fetchImpl } = scripted([
      json({ header, commands: [{ tick: 5, player_id: 7, index: 0 }], snapshots_meta: { ticks: 20, rate: 10 }, replay_url: "/api/v1/matches/12/replay" }),
    ]);
    const client = new ApiClient({ fetchImpl, storage: null });

    const replay = await client.replay(12);
    expect(replay.header.seed).toBe(987);
    expect(replay.header.winner).toBe(7);
    expect(replay.commands[0].tick).toBe(5);
    expect(replay.snapshots_meta?.rate).toBe(10);
  });

  it("surfaces the stats payload including per-race breakdowns", async () => {
    const stats = {
      matches: 4,
      wins: 3,
      losses: 1,
      draws: 0,
      win_rate: 0.75,
      kills: 40,
      deaths: 12,
      kd_ratio: 3.3,
      resources_mined: 9000,
      units_built: 60,
      by_race: { terran: { matches: 4, wins: 3, losses: 1, draws: 0, win_rate: 0.75, kills: 40, deaths: 12, kd_ratio: 3.3, resources_mined: 9000, units_built: 60 } },
    };
    const { fetchImpl } = scripted([json({ player: PLAYER, stats, recent_matches: [] }), json({ player: PLAYER, stats, recent_matches: [] })]);
    const client = new ApiClient({ fetchImpl, storage: null });

    const mine = await client.myStats();
    expect(mine.stats.win_rate).toBe(0.75);
    expect(mine.stats.by_race.terran.wins).toBe(3);
    expect(mine.recent_matches).toEqual([]);

    const theirs = await client.playerStats("zz");
    expect(theirs.player.name).toBe("nik");
  });

  it("returns null for a 204 rather than failing to parse an empty body", async () => {
    const { fetchImpl } = scripted([new Response(null, { status: 204 })]);
    const client = new ApiClient({ fetchImpl, storage: null });

    await expect(client.logout()).resolves.toBeUndefined();
  });

  it("returns null for a 200 with an empty body instead of throwing", async () => {
    const { fetchImpl } = scripted([new Response("", { status: 200 })]);
    const client = new ApiClient({ fetchImpl, storage: null });

    await expect(client.replayJson(12)).resolves.toBeNull();
  });
});

describe("degrading without localStorage", () => {
  it("signs in and authenticates with no persistence at all, rather than throwing", async () => {
    // A browser privacy setting makes *reading* the global throw, which is
    // what `browserStorage()` guards against. The app must still work; it just
    // will not remember the session across a reload.
    Object.defineProperty(globalThis, "localStorage", {
      get() {
        throw new Error("access denied");
      },
      configurable: true,
    });
    const { fetchImpl, recorded } = scripted([json({ token: "tok-live", player: PLAYER }, 201), json({ player: PLAYER })]);
    const client = new ApiClient({ fetchImpl });

    const session = await client.register("nik", "hunter2");
    expect(session.token).toBe("tok-live");
    await client.me();
    expect(recorded.headers(1).authorization).toBe("Bearer tok-live");
    expect(authToken()).toBeNull();
  });
});
