import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Config for the superlinearity gate (tests/perf/scaling-gate.test.ts) ONLY.
 *
 * The gate measures wall-clock time, which makes its environment part of the
 * measurement rather than an implementation detail:
 *
 *  - `fileParallelism: false`. The default pool runs several test FILES at
 *    once, and two timing probes sharing a core inflate each other's numbers by
 *    whatever the scheduler decides. A ratio gate reading 2.0 when the machine
 *    is busy is indistinguishable from a 4.0 regression, so contention has to
 *    be designed out rather than averaged away. Setting this to false also
 *    overrides `maxWorkers` to 1, which is what we want: the gate is one file
 *    and it must have the runner to itself.
 *
 *  - `isolate: false`. Re-creating the module registry would re-import the
 *    probes and reset JIT state between files, so the harness's "warm up before
 *    you measure" logic would be timing a colder function than the one the ratio
 *    is computed from.
 *
 *  - `pool: "forks"`. Process-based, matching the main suite, so a probe is not
 *    sharing a V8 heap with anything else. The pool OPTIONS object that carried
 *    singleFork/isolate in Vitest 4 is gone in Vitest 5 — that is why the
 *    equivalent settings live at the top level here.
 *
 *  - `environment: "node"`, not the jsdom the app suite uses. None of the probed
 *    functions touch the DOM, and a jsdom global install is pure overhead in
 *    front of every measurement.
 *
 *  - A generous timeout: the corpus is ~75s here, and a loaded or slower CI
 *    runner needs room. The gate's own assertions carry the real failure
 *    conditions; the timeout only catches a hang.
 *
 * Run it with `npm run check:perf`. It is wired into CI as its own job (see
 * .github/workflows/ci.yml) and aggregated into the `ci-ok` required check, so
 * a superlinear regression blocks the merge. It is deliberately NOT part of
 * `npm test`: a wall-clock gate belongs on a quiet machine, and mixing it into
 * the parallel app suite is how timing gates get muted.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/perf/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    pool: "forks",
    isolate: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
