/**
 * Session state for the client.
 *
 * The service owns exactly one question — "who is playing?" — and keeps the
 * answer in two places: the bearer token, which the API layer persists under
 * `starc.token`, and the decoded player record, which is never persisted
 * because it is cheap to refetch and cannot go stale on its own.
 *
 * Construction kicks off a restore: if a token exists, `me()` is called and
 * the result lands in {@link AuthService.currentPlayer}; a rejected token is
 * cleared rather than left to fail every later call. Callers await
 * {@link AuthService.restored} before deciding what to show, so the menu never
 * flashes "sign in" at somebody who is already signed in.
 *
 * The API client is injected as a structural interface, which keeps this
 * constructible under `environment: "node"` with a stub — the only module
 * binding is the token pair from `@net/api`.
 */
import { authToken, setAuthToken } from "@net/api";

/** The player fields the UI needs; a subset of the server's `player_json`. */
export interface AuthPlayer {
  name: string;
  rating: number;
  wins: number;
  losses: number;
}

/** Response of `POST /players` and `POST /session`. */
export interface AuthSessionResponse {
  token: string;
  player: AuthPlayer;
}

/** Response of `GET /me`. */
export interface MeResponse {
  player: AuthPlayer;
}

/** The slice of `ApiClient` this service depends on. */
export interface AuthApi {
  register(name: string, password: string): Promise<AuthSessionResponse>;
  login(name: string, password: string): Promise<AuthSessionResponse>;
  logout(): Promise<void>;
  me(): Promise<MeResponse>;
}

export class AuthService {
  private readonly api: AuthApi;
  private player: AuthPlayer | null = null;
  private restorePromise: Promise<AuthPlayer | null>;

  constructor(api: AuthApi) {
    this.api = api;
    this.restorePromise = this.restore();
  }

  /** Resolves once the persisted session has been checked. Never rejects. */
  get restored(): Promise<AuthPlayer | null> {
    return this.restorePromise;
  }

  get currentPlayer(): AuthPlayer | null {
    return this.player;
  }

  get isAuthenticated(): boolean {
    return this.player !== null && authToken() !== null;
  }

  /** `GET /me`, for callers that want to revalidate rather than trust state. */
  async me(): Promise<MeResponse> {
    return this.api.me();
  }

  async register(name: string, password: string): Promise<AuthSessionResponse> {
    const session = await this.api.register(name, password);
    this.adopt(session);
    return session;
  }

  async login(name: string, password: string): Promise<AuthSessionResponse> {
    const session = await this.api.login(name, password);
    this.adopt(session);
    return session;
  }

  /**
   * Clears the local session even if the server call fails: a user who asked
   * to sign out must end up signed out, and the token is worthless once the
   * server has dropped it.
   */
  async logout(): Promise<void> {
    this.player = null;
    setAuthToken(null);
    try {
      await this.api.logout();
    } catch {
      // Nothing to recover: the local session is already gone.
    }
  }

  private adopt(session: AuthSessionResponse): void {
    setAuthToken(session.token);
    this.player = session.player;
  }

  private async restore(): Promise<AuthPlayer | null> {
    if (!authToken()) return null;
    try {
      const { player } = await this.api.me();
      this.player = player;
      return player;
    } catch {
      // Expired or revoked token: drop it so the next attempt starts clean.
      this.player = null;
      setAuthToken(null);
      return null;
    }
  }
}
