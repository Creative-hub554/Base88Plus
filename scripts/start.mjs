#!/usr/bin/env node
/**
 * Supervised production server — what `npm start` runs.
 *
 * `next start` is a long-running process with nothing in front of it. When Node
 * exits — an unhandled rejection, a native crash, the platform killing the
 * process under memory pressure — the app is simply dark until somebody
 * notices. Under a process manager that is a restart after whatever interval
 * the manager happens to have; under `npm start` in a terminal it is nothing at
 * all, and the terminal usually belongs to a window that has been closed.
 *
 * This runs the shared supervision loop (`scripts/supervise.mjs` — one
 * mechanism, two policies, and neither entry importing the other) with the
 * policy production needs:
 *
 *   - a server that DIED is restarted, with the same backoff and per-run restart
 *     budget as development, and with the same audited tree kill before each
 *     restart — the audit is what turns "the tree is gone" into a finding
 *     instead of an assumption, and it is the same code, so it cannot be right
 *     on one side and wrong on the other;
 *   - a running server is REPLACED without the port ever closing. The
 *     supervisor holds the public port itself — the "front door" — and every run
 *     is started behind it on a port of its own. A reload therefore starts the
 *     replacement beside the server that is serving, waits for it to answer, and
 *     points the front door at it: the port is never closed, so no client ever
 *     lands on a dead port. A reload that cannot produce a server changes
 *     nothing — the replacement is stopped, the log says why, and the server
 *     that was already up keeps serving;
 *   - and a replacement that came up but does not WORK is rolled back off. The
 *     server a reload replaced is kept warm — still running, still holding its
 *     own port, so no traffic can reach it — while the replacement serves and is
 *     health-checked; if a check fails (the replacement is gone, or it answers
 *     5xx), the front door is pointed back at the server that was there before
 *     and the replacement is stopped, which is a reload that undoes itself rather
 *     than a deploy that takes the app down. How long that warmth lasts is
 *     decided by the APP rather than by the clock: the front door counts the real
 *     connections it hands each run and remembers when they arrived, and once the
 *     app has put `PROD_ROLLBACK_CONNECTIONS` of them through the replacement and
 *     it has stayed healthy through them, there is nothing left to wait for and
 *     the server it replaced is retired then — early. Short of that, the window is
 *     kept for as long as the rate the app is actually using the replacement at
 *     needs to produce one, so a window the app is hammering closes in seconds
 *     while one nothing has arrived in runs to `PROD_ROLLBACK_MS` (90s) — a
 *     ceiling again rather than the rule — and `PROD_ROLLBACK_MIN_MS` (2s) is the
 *     floor under it, so that real connections cannot retire the way back before
 *     the replacement has been health-checked at all. `PROD_ROLLBACK_MS=0` retires
 *     the replaced server at the swap and gives up the way back entirely. What happened is
 *     also written down for a machine: name `PROD_RELOAD_HISTORY` and every
 *     reload that is performed appends one JSON object per line to that file —
 *     when it began, when the port changed hands, when it was decided, what
 *     became of it (replaced, rolled back, or nothing changed), what closed the
 *     window, and the numbers that verdict rests on — so a deploy pipeline can
 *     check what a deploy did instead of reading a log;
 *   - a CLEAN exit is respected: code 0, or the SIGINT/SIGTERM you sent, ends
 *     the supervisor with that status rather than restarting. `docker stop`,
 *     systemd's SIGTERM and Ctrl+C therefore do what they say;
 *   - the two startup errors a restart cannot fix stop the loop instead of
 *     spinning on them: a port already in use, and no production build to
 *     serve. The second is the reason this exists as a wrapper at all — a bare
 *     `next start` without a build exits, a manager restarts it, and the
 *     operator gets a flap loop instead of the one line that says `npm run
 *     build`;
 *   - NOTHING is replayed and nothing is compiled. The warm pass exists in
 *     development because a fresh Turbopack process has an empty compile cache;
 *     production has no such thing, and re-requesting pages a person asked for
 *     is not a decision a supervisor should make about a live server.
 *
 * Why the front door exists
 * -------------------------
 * A port belongs to one process at a time. Without something holding it across
 * the change, "restart" can only mean "close the port, start again" — which is
 * a gap, however short, that a request can land in. Holding the port is the
 * whole trick, and it costs one thing: the port a person pins, and the port the
 * app is reachable on, is now the supervisor's, while each run gets a private
 * one. `PROD_FRONT=0` gives the port back to the server and runs without a front
 * door — at which point a crash is what it always was (a gap in which this
 * supervisor's port answers 503 rather than refusing the connection), and
 * reloads are off, because there is nothing to hand the port over through.
 *
 * It is raw TCP, not an HTTP proxy: bytes are piped through untouched, so
 * keep-alive, a streaming response, a WebSocket upgrade and a TLS socket behind
 * it all work without the front door knowing what any of them are. What it does
 * NOT do is make an unplanned death seamless — there was no second server to
 * hand over to. A run that dies is still a gap, answered 503 instead of refused,
 * until its replacement is probed up.
 *
 * Reloads, and what asks for one
 * ------------------------------
 * On POSIX, `SIGHUP` is the conventional request (`kill -HUP <pid>`,
 * `docker kill -s HUP`), and it is wired up whenever the front door is on.
 * Windows cannot deliver SIGHUP — Ctrl+C and Ctrl+Break are its signals — so
 * there, and anywhere a signal is awkward to send at all, the trigger is a file:
 * name it with `PROD_RELOAD_FILE` and touching it asks for one reload, which is
 * what makes a reload reachable from a deploy script, a Makefile, or a step that
 * has just written a new `.next` beside the running server. The file is removed
 * as it is read, so one touch is one reload, and a file that is still being
 * written is left for the next poll rather than read half-way. Reload requests
 * made while the supervisor is busy are remembered rather than lost, and a
 * second one while the first is in flight is one more reload, not a queue of
 * them.
 *
 * Deliberately NOT the dev pool-death signature. `next start` has no Turbopack
 * transform pool, and a URL can reach production output — measured: this Next
 * version's `next start` prints no request lines at all, however many requests
 * it serves, but an error page, a custom server or a dependency can print one —
 * so a URL containing that phrase must not be able to make the supervisor kill
 * and restart a healthy server. The classifier below reads only the ways this
 * server can be dead on arrival, and the reload window's evidence comes from the
 * front door's own count of real connections for the same reason: the one thing
 * that is certainly true of production traffic is that it went through the door.
 *
 * A crash loop is bounded, not endless: after `PROD_MAX_RESTARTS` deaths in a
 * row without a run that stays up `PROD_HEALTHY_MS`, the supervisor says why and
 * exits 1 — which is the signal a process manager, a container runtime, or a
 * person needs to see. Running under a manager is fine and intended: this
 * recovers in about a second what the manager would recover on its own
 * schedule, and hands over deliberately once the cause is clearly not transient.
 *
 * Knobs (all optional):
 *   -p, --port N           the public port (forwarded to the server when there
 *                          is no front door; held by the supervisor when there is)
 *   -H, --hostname H       interface to bind — honored by the front door too, so
 *                          a server pinned to loopback does not become public
 *   PROD_PORT=N            same as --port, via the environment
 *   PROD_FRONT=0           no front door: the server holds the port again, and
 *                          reloads are off (there is nothing to hand it over)
 *   PROD_RELOAD_FILE=path  touch this file to ask for one reload (the trigger a
 *                          platform without SIGHUP has)
 *   PROD_ROLLBACK_MS=N     the ceiling on how long the server a reload replaced is
 *                          kept warm as the way back, health-checking the
 *                          replacement throughout. The rate the app uses the
 *                          replacement at decides the window inside it: a busy
 *                          deploy's closes in seconds, and one nothing arrives in
 *                          runs to this (default 90000; 0 retires it at the swap)
 *   PROD_ROLLBACK_MIN_MS=N the floor under that window: the shortest it may be
 *                          while the app's own traffic is deciding it (default
 *                          2000)
 *   PROD_ROLLBACK_CONNECTIONS=N
 *                          real connections the app must put through the
 *                          replacement, on top of its health checks, before the
 *                          server it replaced is retired early (default 3; 0
 *                          leaves the window a clock, at its ceiling)
 *   PROD_RELOAD_HISTORY=path
 *                          append one JSON object per performed reload to this
 *                          file (one line each; off when unset). A record that
 *                          cannot be written is reported and never fatal
 *   PROD_MAX_RESTARTS=N    deaths in a row before giving up (default 5)
 *   PROD_HEALTHY_MS=N      uptime that refills the restart budget (default
 *                          600000 — longer than development's, because a server
 *                          that flaps every few minutes should surface as
 *                          "giving up", not restart all day)
 *   PROD_BACKOFF_MS=N      first restart delay, doubling per attempt (default 1000)
 *   PROD_BACKOFF_MAX_MS=N  delay ceiling (default 15000)
 *   PROD_SERVER_CMD='…'    run this instead of `next start` (tests, or any other
 *                          long-running server). Command-line arguments are NOT
 *                          forwarded to it, so its port is learned from its own
 *                          `- Local:` banner — or, behind a front door, from the
 *                          `PORT` the supervisor gives it.
 */

import { fileURLToPath } from "node:url";

import {
  envInt,
  localUrlPort,
  nextBin,
  parseArgs,
  stripAnsi,
  supervise,
  tokenizeCommand,
} from "./supervise.mjs";

const DEFAULTS = {
  maxRestarts: 5,
  healthyMs: 600_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 15_000,
  // The ceiling on how long a reload keeps the server it replaced alive as the
  // way back. Long enough to catch a replacement that came up and then broke — a
  // bad build, a missing secret in the new environment, a startup path that dies
  // under real traffic — and short enough that two servers is a moment and not a
  // state. It is a ceiling and not the rule: the rate the app is using the
  // replacement at decides the window inside it, so a busy deploy's window closes
  // in seconds and a quiet one runs to this. 90s rather than the 30s a fixed
  // window used, because it is now the length of the window NOBODY has arrived in
  // — the one window that needs the most time before it becomes evidence either
  // way.
  rollbackWindowMs: 90_000,
  // The floor under that window: the shortest it may be once the app's own traffic
  // is what is deciding it. Connections arriving in a burst have gaps far too
  // small to pass the health checks a proof rests on, so the floor is what keeps
  // evidence in front of the decision rather than behind it.
  rollbackWindowMinMs: 2_000,
  // What the app itself has to do before the way back can be let go: real
  // connections through the replacement, on top of the health checks it has
  // passed. Three is roughly one visit — a page and its requests — and it is
  // meant to be evidence that the replacement served a client, not a benchmark.
  rollbackProofConnections: 3,
  // The public port when nobody names one. 3000 is the port `next start` itself
  // would have bound (it is the Next CLI's own default), so `npm start` keeps
  // meaning "the app on 3000" whether or not a port was named — and the front
  // door has to know, because it must take the port before anything can serve on it.
  port: 3000,
  host: "0.0.0.0",
};

/**
 * Lines that mean a restart would fail the same way — the production half of
 * the dev entry's `NO_RESTART`. Both are startup conditions, not crashes: the
 * server is not running yet, so there is no run to recover, only a cause to
 * report.
 */
export const START_NO_RESTART = [
  {
    re: /\beaddrinuse\b/i,
    why: "the port is held by a process that is not this server",
  },
  {
    re: /could not find a production build/i,
    why: "there is no production build to serve — run `npm run build`",
  },
];

/**
 * `next start`'s own output → what the supervisor should do about it.
 *
 * Only the two ways this server can be dead on arrival, plus the banner that
 * says where it is listening. Everything else — request logs, a stack trace
 * from a page that threw, a warning from a dependency — describes a server that
 * is still serving, and a supervisor's job is to leave it alone.
 */
export function classifyStartLine(line) {
  const text = stripAnsi(line);
  const fatal = START_NO_RESTART.find((pattern) => pattern.re.test(text));
  if (fatal) return { kind: "no-restart", why: fatal.why };
  const port = localUrlPort(text);
  if (port !== null) return { kind: "local-url", port };
  return null;
}

export async function main(argv = process.argv.slice(2)) {
  const frontEnabled = process.env.PROD_FRONT !== "0";
  // With a front door the port on the command line is the SUPERVISOR's, so it is
  // read and not forwarded: a run that also tried to bind it would fail on a port
  // this process is already holding, and it is told its own port through `PORT`
  // instead. Without one, the port belongs to the server exactly as before.
  const { port, host, forward } = parseArgs(argv, process.env, {
    portEnv: "PROD_PORT",
    forwardPort: !frontEnabled,
  });
  const override = tokenizeCommand(process.env.PROD_SERVER_CMD ?? "");
  // The argv to run, built by the entry: the loop has no default server of its
  // own — same binary either way, different subcommand.
  const serverCmd = override.length
    ? override
    : [process.execPath, nextBin(), "start", ...forward];

  // A pinned interface is respected on both sides of the front door, which is
  // the point: `-H 127.0.0.1` must not turn into a public port just because
  // something took over the listener. A wildcard bind is reached on loopback —
  // and the probe has always talked to loopback, so nothing about that changes.
  const bindHost = host ?? DEFAULTS.host;
  const probeHost = bindHost === "0.0.0.0" || bindHost === "::" ? "127.0.0.1" : bindHost;

  return supervise({
    port: frontEnabled ? null : port,
    frontPort: frontEnabled ? (port ?? DEFAULTS.port) : null,
    frontHost: bindHost,
    probeHost,
    reloadFile: process.env.PROD_RELOAD_FILE ?? null,
    // The account of a reload, written where an operator asked for it and
    // nowhere by default: a deploy pipeline reads this, a terminal reads the log.
    reloadHistory: process.env.PROD_RELOAD_HISTORY ?? null,
    rollbackWindowMs: envInt("PROD_ROLLBACK_MS", DEFAULTS.rollbackWindowMs),
    rollbackWindowMinMs: envInt("PROD_ROLLBACK_MIN_MS", DEFAULTS.rollbackWindowMinMs),
    rollbackProofConnections: envInt("PROD_ROLLBACK_CONNECTIONS", DEFAULTS.rollbackProofConnections),
    serverCmd,
    classify: classifyStartLine,
    banner:
      "supervising `next start` — a server that dies is restarted, a running one is " +
      "replaced without the port ever closing, and a replacement that fails its health " +
      "check hands the port back",
    plainHint: "npm run start:plain",
    log: (message) => process.stdout.write(`[start] ${message}\n`),
    warmEnabled: false,
    maxRestarts: envInt("PROD_MAX_RESTARTS", DEFAULTS.maxRestarts),
    healthyMs: envInt("PROD_HEALTHY_MS", DEFAULTS.healthyMs),
    backoffBaseMs: envInt("PROD_BACKOFF_MS", DEFAULTS.backoffBaseMs),
    backoffMaxMs: envInt("PROD_BACKOFF_MAX_MS", DEFAULTS.backoffMaxMs),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`[start] ${error?.message ?? error}\n`);
      process.exit(1);
    });
}
