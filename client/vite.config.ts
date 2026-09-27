import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const shared = (p: string) => fileURLToPath(new URL(`../shared/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@render": r("./src/render"),
      "@game": r("./src/game"),
      "@ui": r("./src/ui"),
      "@net": r("./src/net"),
      "@shared": r("./src/shared"),
      "@data": shared("game-data.json"),
      "@data/maps": shared("data/maps.json"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    fs: { allow: [".."] },
    proxy: {
      "/api": { target: "http://127.0.0.1:3000", changeOrigin: true },
      "/cable": { target: "ws://127.0.0.1:3000", ws: true },
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      output: {
        // Vite 8 bundles with Rolldown, which only accepts the function form
        // of manualChunks — the object form was removed.
        manualChunks(id: string) {
          if (id.includes("node_modules/three")) return "three";
          return undefined;
        },
      },
    },
  },
});
