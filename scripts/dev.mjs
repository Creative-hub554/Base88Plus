#!/usr/bin/env node
/**
 * Supervised dev server — what `npm run dev` runs.
 *
 * This file is the POLICY. The loop itself — probe, tree kill, kill audit,
 * backoff, budget, warm replay — is `scripts/supervise.mjs`, which both this
 * entry and the production one (`scripts/start.mjs`) run under; neither entry
 * imports the other.
 *
 * The failure this exists for
 * ---------------------------
 * Turbopack compiles through a pool of transform workers (the `pool_entry-*.js`
 * children under Next's own `start-server` process), managed by jest-worker.
 * When that pool gives up, the dev server does NOT exit. It keeps answering
 * every route whose chunks are already built — so the app looks healthy on the
 * pages you happened to visit — and returns 500 for anything that still needs
 * a compile. All the parent says on the way down is one line:
 *
 *   Jest worker encountered 2 child process exceptions, exceeding retry limit
 *
 * That line is the entire signal: no exit code, no error overlay, nothing that
 * says "restart me". The pool is per-process, so a fresh `next dev` always has
 * a healthy one — the fix is a restart, and until now it was manual: notice the
 * 500s, find the line, kill the tree, start again.
 *
 * What this entry supplies to the loop
 * ------------------------------------
 * `classifyLine` below: that pool-death line means restart, and the two Next
 * startup errors a new process cannot fix stop the loop instead of spinning on
 * them. Everything the classifier reads beyond its own signatures — where the
 * server is listening, which page it just served — comes from the shared
 * module. So does the rest of the policy wiring: the startup banner, the hint
 * to run `npm run dev:plain`, warm replay switched ON (it is the point here),
 * the `[dev]` log prefix, and the `DEV_*` knobs.
 *
 * A fresh process also has an empty compile cache, so the pages you had been
 * using would cold-compile again on your next click — a recovered server that
 * still makes you wait. Once the port answers, the loop therefore re-requests
 * the pages this server logged as served, most recent first, bounded by
 * `DEV_WARM_LIMIT` and sent one at a time. Serial on purpose: the pool that just
 * died is the one most likely to die again under load, so this is the opposite
 * of a warm-up stampede. Only pages are replayed — never a `/api/` route —
 * because replaying a request the user never made is not a decision a
 * supervisor should make on its own.
 *
 * Boundary: detection is the pool's own death line. A pool that dies without
 * printing it is not distinguishable from outside, because the routes that
 * still work are exactly the ones served from cache — a probe cannot tell a
 * healthy server from a half-dead one without knowing which routes need a
 * fresh compile, and guessing that per request is not this script's job.
 *
 * Knobs (all optional):
 *   -p, --port N          fixed port (also forwarded to the server)
 *   DEV_PORT=N            same, via the environment
 *   DEV_MAX_RESTARTS=N    restarts in a row before giving up (default 5)
 *   DEV_HEALTHY_MS=N      uptime that refills the restart budget (default 120000)
 *   DEV_BACKOFF_MS=N      first restart delay, doubling per attempt (default 1000)
 *   DEV_BACKOFF_MAX_MS=N  delay ceiling (default 15000)
 *   DEV_SERVER_CMD='…'    run this instead of `next dev` (tests, other servers).
 *                         Command-line arguments are NOT forwarded to it, so
 *                         the port is learned from its own `- Local:` banner.
 *   DEV_WARM=0            do not re-request the pages that were in use
 *   DEV_WARM_LIMIT=N      how many of them to remember and replay (default 6)
 *   DEV_WARM_TIMEOUT_MS=N give up on one page after this long (default 20000)
 */

import { fileURLToPath } from "node:url";

import {
  DEFAULTS,
  envInt,
  localUrlPort,
  nextBin,
  parseArgs,
  servedRoute,
  stripAnsi,
  supervise,
  tokenizeCommand,
} from "./supervise.mjs";

/**
 * Lines that mean the transform worker pool is gone. Kept to the one signature
 * that was actually observed in this repo's dev log — jest-worker naming its
 * own pool and the count of dead children. The retry wording is left off the
 * pattern on purpose: "exceeding" and "exceeded" both appear in the wild, and
 * neither changes what happened.
 */
export const POOL_DEATH = [
  {
    re: /jest worker encountered \d+ child process exception/i,
    why: "jest-worker gave up on the Turbopack transform pool",
  },
];

/**
 * Lines that mean a restart would fail the same way. Restarting on these turns
 * one clear error into a loop of identical ones.
 *
 * The production entry keeps its own list (`scripts/start.mjs`) and deliberately
 * shares only the port rule: a production log carries request lines, so a URL
 * containing one of these sentences must not be able to kill a healthy server.
 */
export const NO_RESTART = [
  {
    re: /another next dev server is already running/i,
    why: "Next refuses a second dev server for this directory, on any port",
  },
  {
    re: /\beaddrinuse\b/i,
    why: "the port is held by a process that is not this server",
  },
];

/** One line of server output → what the supervisor should do about it. */
export function classifyLine(line) {
  const text = stripAnsi(line);
  const death = POOL_DEATH.find((p) => p.re.test(text));
  if (death) return { kind: "pool-death", why: death.why };
  const fatal = NO_RESTART.find((p) => p.re.test(text));
  if (fatal) return { kind: "no-restart", why: fatal.why };
  const port = localUrlPort(text);
  if (port !== null) return { kind: "local-url", port };
  const route = servedRoute(text);
  if (route !== null) return { kind: "route", path: route };
  return null;
}

export async function main(argv = process.argv.slice(2)) {
  const { port, forward } = parseArgs(argv, process.env, { portEnv: "DEV_PORT" });
  const override = tokenizeCommand(process.env.DEV_SERVER_CMD ?? "");
  // The argv to run, built by the entry: the loop has no default server of its
  // own, so it cannot run `next dev` for a production entry or the other way
  // round.
  const serverCmd = override.length
    ? override
    : [process.execPath, nextBin(), "dev", ...forward];

  return supervise({
    port,
    serverCmd,
    classify: classifyLine,
    banner: "supervising `next dev` — a dead Turbopack worker pool restarts the server automatically",
    plainHint: "npm run dev:plain",
    log: (message) => process.stdout.write(`[dev] ${message}\n`),
    warmEnabled: process.env.DEV_WARM !== "0",
    maxRestarts: envInt("DEV_MAX_RESTARTS", DEFAULTS.maxRestarts),
    healthyMs: envInt("DEV_HEALTHY_MS", DEFAULTS.healthyMs),
    backoffBaseMs: envInt("DEV_BACKOFF_MS", DEFAULTS.backoffBaseMs),
    backoffMaxMs: envInt("DEV_BACKOFF_MAX_MS", DEFAULTS.backoffMaxMs),
    warmLimit: envInt("DEV_WARM_LIMIT", DEFAULTS.warmLimit),
    warmTimeoutMs: envInt("DEV_WARM_TIMEOUT_MS", DEFAULTS.warmTimeoutMs),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`[dev] ${error?.message ?? error}\n`);
      process.exit(1);
    });
}
