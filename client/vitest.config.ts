import { defineConfig } from "vitest/config";
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
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/main.ts"],
      thresholds: {
        lines: 70,
        functions: 65,
        branches: 55,
        statements: 70,
      },
    },
  },
});
