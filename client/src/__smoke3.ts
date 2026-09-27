import { App } from "./game/app";
import { authToken, setAuthToken } from "@net/api";
import type { ApiClient } from "@net/api";
import type { ChannelTransport } from "@net/transport";

setAuthToken(null);

let calls: string[] = [];
const api = {
  register: async () => ({ token: "t", player: { name: "n", rating: 1, wins: 0, losses: 0 } }),
  login: async () => ({ token: "t", player: { name: "n", rating: 1, wins: 0, losses: 0 } }),
  logout: async () => void calls.push("logout"),
  me: async () => ({ player: { name: "n", rating: 1, wins: 0, losses: 0 } }),
} as unknown as ApiClient;

const transport = {
  state: "idle",
  connect: async () => void calls.push("connect"),
  send: () => void calls.push("send"),
  onMessage: () => {},
  onStateChange: () => {},
  close: () => void calls.push("close"),
  subscribe: () => "sub-1",
  unsubscribe: () => void calls.push("unsubscribe"),
  identify: () => {},
  onError: () => {},
  onReceipt: () => {},
  lastActivity: () => 0,
} as unknown as ChannelTransport;

const app = new App({ api, transport, cableUrl: "ws://test/cable", now: () => 0 });
console.assert(app.currentScreen === "boot", `boots in boot, got ${app.currentScreen}`);
console.assert(app.gameState.started === false, "no match before game:start");
app.setQuality("medium");
console.assert(app.qualityPreset === "medium", "quality is settable before a match exists");
app.dispose();
console.assert(calls.includes("close"), `transport closed, calls: ${calls.join(",")}`);
console.log("app smoke ok");
