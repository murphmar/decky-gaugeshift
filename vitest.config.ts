import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/frontend/**/*.test.ts"],
    coverage: {
      // The decision engine and the Steam adapter are where bugs would hurt;
      // the panel (index.tsx) and wiring (host.ts) are checked on hardware.
      include: ["src/engine.ts", "src/steam.ts"],
      thresholds: { lines: 95, branches: 95, functions: 100, statements: 95 },
    },
  },
});
