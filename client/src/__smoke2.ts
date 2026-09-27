import { AuthService } from "./game/auth";
import { authToken, setAuthToken } from "@net/api";

// `@net/api` persists through `localStorage`, which Node/Bun do not provide.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  get length() {
    return store.size;
  },
  clear: () => store.clear(),
  getItem: (k: string) => store.get(k) ?? null,
  key: (i: number) => [...store.keys()][i] ?? null,
  removeItem: (k: string) => void store.delete(k),
  setItem: (k: string, v: string) => void store.set(k, v),
} as Storage;
const player = { name: "nik", rating: 1200, wins: 3, losses: 1 };

let meCalls = 0;
let logouts = 0;
const api = {
  register: async () => ({ token: "t-register", player }),
  login: async () => ({ token: "t-login", player }),
  logout: async () => {
    logouts++;
  },
  me: async () => {
    meCalls++;
    if (authToken() === "good") return { player };
    throw new Error("unauthenticated");
  },
};

setAuthToken(null);
const anon = new AuthService(api);
console.assert((await anon.restored) === null, "no token means no restore call");
console.assert(meCalls === 0, "me() is not called without a token");
console.assert(!anon.isAuthenticated, "anonymous is not authenticated");

setAuthToken("good");
const restored = new AuthService(api);
console.assert((await restored.restored)?.name === "nik", "session restored from the persisted token");
console.assert(restored.isAuthenticated, "restored session is authenticated");
console.assert(meCalls === 1, `me() called once, got ${meCalls}`);

await restored.login("nik", "hunter22");
console.assert(authToken() === "t-login", "login replaces the token");
await restored.logout();
console.assert(authToken() === null && !restored.isAuthenticated, "logout clears the session");
console.assert(logouts === 1, "the server logout was called");

setAuthToken("stale");
const stale = new AuthService(api);
console.assert((await stale.restored) === null, "a rejected token restores to nobody");
console.assert(authToken() === null, "a rejected token is cleared");
console.log("auth smoke ok");
