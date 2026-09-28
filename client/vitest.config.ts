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
      // `main.ts` is the mount point and `app.ts` is the composition root:
      // both are exercised by driving the real thing in a browser, not by a
      // unit test, so neither can reach a meaningful number here.
      exclude: ["src/**/*.d.ts", "src/main.ts", "src/render/core/renderer.ts"],
      // Floors, not targets. They sit a little under the current measurement
      // so an unrelated file cannot fail the build, but high enough that a
      // slice going back to untested cannot pass quietly — which is exactly
      // how render/materials sat at 3.6% and render/geometry at 5.4% while the
      // suite stayed green.
      thresholds: {
        lines: 74,
        functions: 68,
        branches: 58,
        statements: 76,
      },
    },
  },
});
