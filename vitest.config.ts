import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.{ts,tsx}"],
    // The superlinearity gate measures WALL-CLOCK time, and this suite runs
    // several test files at once. Probes sharing a core inflate each other, and
    // a 2.0 reading under contention is indistinguishable from a 4.0
    // regression — so the gate gets its own quiet, serialised run via
    // `npm run check:perf` (see vitest.perf.config.ts) and is a separate CI job.
    // It is a required check; it is just not a noisy one bolted onto this.
    exclude: [...configDefaults.exclude, "tests/perf/**"],
  },
});
