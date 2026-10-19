/**
 * The supervision loop both servers run under — one mechanism, two policies.
 *
 * `npm run dev` (`scripts/dev.mjs`) and `npm start` (`scripts/start.mjs`) both
 * run their server under the loop in this file. What lives here is the
 * mechanism and NOT the judgement: nothing in this file decides what a line of
 * server output MEANS. Each entry passes its own `classify`, its own startup
 * `banner`, the `plainHint` to print when it gives up, its own log prefix,
 * whether pages are replayed, and its own restart budget and backoff knobs.
 * `supervise()` refuses to run without that policy, so a new entry cannot
 * inherit development's by accident, and this file imports neither entry — so
 * a fix to the probe, the kill or the audit cannot land on one server and miss
 * the other.
 *
 * What the loop does
 * ------------------
 * It runs the server as a child and streams its output through untouched (the
 * terminal behaves exactly as it did with the server bare), reading every line
 * through the entry's classifier. A line can mean the transform pool died, that
 * the run is dead on arrival, where the server is listening, or which page it
 * served. On a verdict that ends a run it kills the whole server tree —
 * child.kill() alone would leave Next's `start-server` child and its workers
 * holding the port — and starts a fresh server, then waits for the port to
 * answer HTTP before calling it recovered, asking again every few milliseconds
 * while the answer is a refusal, so that line lands on the answer rather than a
 * poll interval after it. A server that dies on its own is restarted the same
 * way. Two things are deliberately NOT restarted: a clean exit (code 0 or a
 * signal — you asked it to stop), and the fatal startup errors the entry lists,
 * which stop the loop instead of spinning on them.
 *
 * Then it AUDITS the kill rather than trusting it. "The tree is gone" is an
 * assumption — a process-group SIGKILL can be ignored, and a worker that lost
 * its parent to adoption is no longer reachable by the tree that was killed
 * while still holding memory, and the port if it is the server. Each platform
 * answers with the evidence it already has, and neither answer costs a subprocess
 * that was not already being spent: on POSIX the subtree is read from /proc
 * before the root is removed and once again afterwards, and on Windows the
 * enumeration and the verdict both come from `taskkill`'s own report, because
 * reading that platform's table means PowerShell (measured: 3.3–9s a read, on
 * every restart). A survivor is named in the log, force-killed on its own, and
 * if it still will not die the log says so instead of reporting a clean tree. A
 * run that died by itself is not audited: nothing was killed, and a server that
 * outlived it there announces itself as EADDRINUSE on the next start.
 *
 * The restart budget is per healthy run, not per session: a run that stays up
 * `healthyMs` proves the server is healthy again, so the counter refills and an
 * all-day session can recover any number of unrelated crashes. Only a server
 * that dies again and again without ever staying up gives up.
 *
 * The replay pass is for whichever entry wants it. Once the port answers, the
 * loop re-requests the pages the server itself logged as served — most recent
 * first, bounded by `warmLimit`, one at a time, and only when the entry enabled
 * it. Serial on purpose: the pool that just died in development is the one most
 * likely to die again under load, so this is the opposite of a warm-up
 * stampede. Only pages are replayed — never a `/api/` route — because replaying
 * a request the user never made is not a decision a supervisor should make on
 * its own. Production switches the pass off: it has nothing to compile, and
 * re-requesting a live server's pages is not a supervisor's call.
 *
 * The front door
 * --------------
 * An optional listener of the supervisor's own, asked for by naming a
 * `frontPort`. A port belongs to one process at a time, so the only way a
 * server can be replaced without the port closing is for something else to hold
 * it: with a front door, the SUPERVISOR holds the public port and pipes every
 * connection through, byte for byte, to the run behind it — which is told a port
 * of its own through `PORT`, the one variable every Node server reads. Raw TCP,
 * not an HTTP proxy: keep-alive, a streaming response, a WebSocket upgrade and a
 * TLS socket behind it all work unchanged, because the front door never looks at
 * what is flowing. A connection that arrives while nothing answers behind it —
 * before the first run is up, or in the gap after one died — gets a 503 from the
 * front door itself, which is a truer answer than a refused connection.
 *
 * Two things follow from piping rather than proxying, and both are the truth rather
 * than a limitation to route around. A client that KEEPS its connection open is
 * still piped to the run it was piped to when it connected, and a swap does not
 * move it — a new connection is what a swap moves, which is exactly what a
 * browser eventually makes. And because every byte is passed through untouched,
 * the front door cannot re-target anything inside a connection: an upgraded
 * stream, a long poll or a streamed response lives and dies with the run behind
 * it, which is also what would happen with no front door at all.
 *
 * A reload is what the front door buys, and it is why it exists. Asked to reload
 * (`SIGHUP`, or the sentinel file an entry names), the supervisor starts a
 * REPLACEMENT beside the run that is serving, waits for it to answer, points the
 * front door at it — a pointer move, not a close and a bind — and only then
 * retires the run it replaced, through the same audited stop every restart uses.
 * The port is never closed for an instant. A reload that cannot produce a server
 * changes NOTHING: the replacement is stopped, the log says why, and the run
 * that was already serving keeps serving, because a failed reload must not cost
 * you a server that works. `frontDrainMs` is the pause between the switch and
 * the stop, and it is what a request the front door has just piped to the old
 * run has to come back in.
 *
 * A swap is not the end of a reload, either, because a replacement that answers
 * the probe is not yet a server that WORKS. So the run that was replaced is not
 * stopped at the swap: it is kept WARM — still running, still holding its own
 * port — while the replacement is health-checked. A replacement that has died,
 * or that starts answering 5xx on `/`, is taken out and the front door is
 * pointed back at the run it replaced: the reload becomes a rolled-back reload
 * instead of a deploy that went wrong. One that survives has the retired run
 * stopped for good, through the same audited stop every other retirement uses.
 * The price is one extra server process while the window is open, which is the
 * whole point: for that window, going back is one pointer move.
 * `rollbackWindowMs: 0` retires straight away, as a reload did before the window
 * existed.
 *
 * How long that window is, is decided by the app and not by the clock. The front
 * door counts the real connections it hands each run — a connection it accepted
 * is a client's by definition, because the health checks are made straight at the
 * run's own port and never through the door — and it remembers when they arrived,
 * so it can be asked what rate the app is using a run at. From that rate the
 * window's length falls out (`rollbackWindowFor`): a replacement that has been
 * given `rollbackProofConnections` of them while passing `rollbackProofChecks`
 * health checks has been exercised by the app and stayed healthy, so there is
 * nothing left for the clock to discover and the run it replaced is retired then,
 * early; and short of that proof, the way back is kept for as long as the rate the
 * app is sending at needs to produce one, measured from the last connection rather
 * than from the clock, so that a window cannot push its own end out by being idle.
 * A window the app is hammering therefore closes in seconds, and one nobody has
 * touched runs to `rollbackWindowMs` — which is a CEILING again rather than the
 * rule — while `rollbackWindowMinMs` is the floor under it, so that a burst of
 * connections cannot let the way back go before the replacement has been
 * health-checked at all. (The count comes from the door and not from the server's
 * own output because there is nothing there to read: measured on this machine,
 * `next start` on Next 16.3.6 prints no request lines at all in production,
 * however many requests it serves.)
 *
 * Every reload that is performed is also RECORDED when the entry names a
 * `reloadHistory` path: one JSON object per line, appended, one write per record —
 * JSONL, so a reader can tail it and a crash cannot leave a half-replaced file
 * behind. A record carries the schema, the three moments (when the supervisor
 * began the reload, when the port changed hands, when the verdict landed), why the
 * reload was asked for, what became of it — the replacement serving, a rollback, no
 * change at all, no way back, or a shutdown — what closed the window (the app's
 * traffic, the clock, a failed check, the replacement's exit, a shutdown, or no
 * port to check on), whether it was rolled back, and the numbers that verdict
 * rests on. It is written for a deploy pipeline rather than for a person: a record
 * that cannot be written is REPORTED and never fatal, because an audit trail able
 * to take the server down would be worse than one that admits a gap in itself.
 *
 * What the front door does NOT do is make an unplanned death seamless. A run
 * that dies is still a gap — 503 instead of connection-refused — until its
 * replacement is probed up, because there was no second server to hand over to.
 * There is no rollback window after a CRASH either: a run that died has already
 * lost the port by definition, so there is nothing left warm to go back to.
 *
 * What `supervise()` requires from an entry: `serverCmd` (the argv it wants
 * run), `classify`, `banner`, `plainHint`, `log`, `warmEnabled`. An entry also
 * passes its own restart budget and backoff — its environment is the only place
 * those numbers are named — while the timing knobs below are mechanism
 * internals and have defaults.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { connect as connectTcp, createServer as createTcpServer } from "node:net";

const require = createRequire(import.meta.url);

/**
 * Fallbacks for the mechanism's own helpers — the probe's window and cadence,
 * the grace period, the replay bound, the line cap, the port range — plus the
 * four policy-shaped numbers an entry overrides from its own environment
 * (`maxRestarts`, `healthyMs`, `backoffBaseMs`, `backoffMaxMs`). Nothing here
 * decides what a line MEANS: that is the entry's `classify`, and it is required.
 */
export const DEFAULTS = {
  maxRestarts: 5,
  healthyMs: 120_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 15_000,
  probeTimeoutMs: 30_000,
  // The wait between probe attempts. Almost nothing on purpose: what a server
  // that is still booting returns is a refused loopback connect, which costs
  // less to ask again than the time waiting saves (see `probeUp`).
  probeFloorMs: 25,
  probeIntervalMs: 500,
  exitGraceMs: 8_000,
  warmLimit: 6,
  warmTimeoutMs: 20_000,
  lineLimit: 4_096,
  portMin: 1,
  portMax: 65_535,
  // Between pointing the front door at a replacement and stopping the run it
  // replaced: the window a request the front door has just piped to that run has
  // to come back in, before the process it is coming from is stopped.
  frontDrainMs: 500,
  // The CEILING on how long a run a reload replaced is kept warm before it is
  // stopped for good — the window in which a replacement that is failing can hand
  // the port back, and the answer for a window the app's own traffic has not
  // shortened. It is the only thing standing between a reload and a bad deploy:
  // for its length there are two servers, and the one that is not serving is the
  // way back. It is 90s rather than the 30s it was while a window's length was
  // fixed, because it is no longer the length of every window — only of one the
  // app has not been used in, which is the window that needs the most time before
  // it can turn into evidence either way. 0 retires the replaced run at the swap,
  // with no way back.
  rollbackWindowMs: 90_000,
  // The FLOOR under that window, in the same units and for the same reason: real
  // connections decide how long a window is, and this is the shortest one they are
  // allowed to decide. It is what keeps the proof's own evidence in front of it —
  // `rollbackProofChecks` health checks cannot be passed in less than that many
  // intervals — so a burst of connections cannot retire the way back before the
  // replacement behind it has been checked at all.
  rollbackWindowMinMs: 2_000,
  // How many of the most recent connections handed to a run are kept to read a
  // rate from. Two instants are the minimum a gap can be measured between, and
  // four is two gaps' worth — enough for a burst not to read as a rate, and a
  // small enough ring that the rate is the RECENT one: what the app did a minute
  // ago says nothing about what it is doing now, while a rate averaged over the
  // whole window would only ever grow as the window did.
  trafficSample: 4,
  // Real connections the app must have sent the replacement, on top of the
  // health checks below, before the run it replaced can be retired EARLY — the
  // evidence that the replacement works, rather than merely that it answers. 0
  // never retires early: the clock alone decides, which is what a window did
  // before the app's own traffic was consulted.
  rollbackProofConnections: 3,
  // The floor under that proof: health checks the replacement must have passed
  // since the swap before real traffic is allowed to retire the run it replaced,
  // so one busy second cannot close the way back on its own.
  rollbackProofChecks: 2,
  // How often the replacement is health-checked inside that window, and how long
  // ONE check waits for an answer before it counts as a failure (a check that
  // gets a refusal asks again inside that window, at this interval).
  healthCheckIntervalMs: 1_000,
  healthCheckTimeoutMs: 5_000,
  // How often a reload sentinel is looked for. A poll, not a watch: a watcher
  // misses a file replaced by a rename on some platforms, and the cost of
  // looking is one `existsSync`.
  reloadPollMs: 200,
};

/**
 * `- Local:  http://localhost:3111` → 3111.
 *
 * Used to learn the port when it was not pinned on the command line (the server
 * walks up from its first choice when that is taken, so the supervisor must not
 * assume). Only the Local line counts: Network is a different interface.
 */
export function localUrlPort(line) {
  const match = /(?:^|\s)-?\s*Local:\s+https?:\/\/\S*?:(\d+)\b/i.exec(line);
  if (!match) return null;
  const port = Number.parseInt(match[1], 10);
  return Number.isInteger(port) ? port : null;
}

/**
 * ANSI colour. A pipe is not a TTY, so Next normally leaves colour out — but
 * `FORCE_COLOR` makes it colourise anyway, and a status code or a model name
 * wrapped in escapes would silently stop parsing. Built from the escape's code
 * point rather than written as a literal so the ban on control characters in
 * regexes keeps meaning what it means everywhere else in the repo.
 */
const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, "g");

export function stripAnsi(line) {
  return line.replace(ANSI, "");
}

/**
 * The marker on every request this script makes for itself — the recovery probe
 * and the warm replays. The server echoes the whole URL into its own request
 * log, so the marker is what lets the supervisor read its own traffic back and
 * not mistake it for pages a person was using: without it, the probe would
 * enter the warm list, each replay would re-enter at the front, and the list
 * would become a record of the supervisor talking to itself rather than of the
 * pages that were in use.
 */
export const SELF_MARKER = "_warm=1";
const SELF_REQUEST = /[?&]_warm=1(?:&|$)/;

/**
 * A URL this tooling may call on its own behalf, carrying the marker. The host is
 * a parameter because an entry may have pinned its server to an interface other
 * than loopback; loopback is what it means when it has not.
 *
 * The marker is APPENDED to whatever query the path already carries, because a
 * query is one `?` followed by `&`-separated parts — a check asked for with a
 * path a page was reached by must not become a different URL from the one that
 * page had.
 *
 * Exported with the marker because the marker is a vocabulary rather than this
 * script's private business: the soak asks the door whether it is up with the
 * same spelling (`scripts/soak-supervisor.mjs`), which is what lets a run — or a
 * fixture wearing one — tell a check apart from a client in ONE place.
 */
export function selfUrl(host, port, path) {
  return `http://${host}:${port}${path}${path.includes("?") ? "&" : "?"}${SELF_MARKER}`;
}

/**
 * The server's own request log — ` GET /settings/ 200 in 1631ms (next.js: …)`
 * — reduced to the page it served, or null when that line is not worth keeping
 * warm.
 *
 * GET and HEAD only: anything else would re-send a request the user made once,
 * which is not a supervisor's business.
 */
export function servedRoute(line) {
  const match = /^\s*(?:GET|HEAD)\s+(\S+)\s+(\d{3})\s+in\s/i.exec(line);
  if (!match) return null;
  const status = Number.parseInt(match[2], 10);
  // A route that answered with an error is not one to replay, and a 404 in
  // development usually means the path was a guess.
  if (status < 200 || status >= 400) return null;
  const url = match[1];
  if (SELF_REQUEST.test(url)) return null;
  const path = url.split("?")[0];
  return isWarmable(path) ? path : null;
}

/**
 * Pages only. Build internals (`/_next/…`, Next's `__nextjs` endpoints) and
 * static files have nothing to compile, and route handlers under `/api/` are
 * excluded on principle: a GET is supposed to be safe, but re-sending one the
 * user never asked for is not a judgement this script should make.
 */
export function isWarmable(path) {
  if (!path.startsWith("/")) return false;
  if (path.startsWith("/_next") || path.startsWith("/__nextjs") || path.startsWith("/api/")) {
    return false;
  }
  const last = path.slice(path.lastIndexOf("/") + 1);
  return !last.includes(".") || last.endsWith(".html");
}

/**
 * `-p 3001`, `--port 3001`, `--port=3001` → 3001; `-H 127.0.0.1` and
 * `--hostname` likewise; anything else forwards.
 *
 * The environment variable is named by the caller and has NO default — one
 * entry's `DEV_PORT` must not be able to configure the other's `PROD_PORT`, so
 * an entry that does not name its own gets a command line and nothing else.
 *
 * `forwardPort: false` reads the port and does NOT put it on the child's command
 * line, which is what an entry with a front door needs: there the command line's
 * port is the FRONT's, and a run that also tried to bind it would fail on a port
 * the supervisor is already holding.
 *
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 * @param {{ portEnv?: string, forwardPort?: boolean }} [options]
 * @returns {{ port: number | null, host: string | null, forward: string[] }}
 */
export function parseArgs(argv, env = {}, { portEnv, forwardPort = true } = {}) {
  const forward = [];
  let port = null;
  let host = null;
  const take = (value, from) => {
    const parsed = Number.parseInt(value ?? "", 10);
    if (!Number.isInteger(parsed) || parsed < DEFAULTS.portMin || parsed > DEFAULTS.portMax) {
      throw new Error(`${from}: not a port: ${JSON.stringify(value)}`);
    }
    return parsed;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-p" || arg === "--port") {
      port = take(argv[i + 1], arg);
      if (forwardPort) forward.push("--port", String(port));
      i += 1;
      continue;
    }
    const inline = /^--port=(.+)$/.exec(arg);
    if (inline) {
      port = take(inline[1], "--port");
      if (forwardPort) forward.push("--port", String(port));
      continue;
    }
    if (arg === "-H" || arg === "--hostname") {
      const value = argv[i + 1];
      if (value === undefined) {
        forward.push(arg);
        continue;
      }
      host = value;
      forward.push("--hostname", value);
      i += 1;
      continue;
    }
    const inlineHost = /^--hostname=(.+)$/.exec(arg);
    if (inlineHost) {
      host = inlineHost[1];
      forward.push("--hostname", host);
      continue;
    }
    forward.push(arg);
  }

  if (port === null && env[portEnv]) port = take(env[portEnv], portEnv);
  return { port, host, forward };
}

/**
 * Split a command line into argv. Quotes group, so a path with a space works;
 * there is no shell, so nothing else is interpreted.
 */
export function tokenizeCommand(command) {
  const parts = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(command)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }
  return parts;
}

/**
 * How a run ended, in words. Windows reports a force-killed process as an
 * unsigned DWORD, so `4294967295` is what -1 looks like once it has been
 * through the platform — printing that raw number tells a reader nothing about
 * what happened, and hex at least says "this is not a code your code chose".
 */
export function describeExit(code, signal) {
  if (signal) return `on ${signal}`;
  if (typeof code !== "number") return "without an exit code";
  if (code > 2 ** 31 - 1) return `with code 0x${(code >>> 0).toString(16)}`;
  return `with code ${code}`;
}

/**
 * A run's lifetime, in the largest unit that still reads as a quantity. A dev
 * session's crashes are seconds apart and stay that way; a production server
 * that dies after six hours must not report `after 21730s`.
 */
export function formatLifetime(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * The mean gap between the arrivals in `instants` — the rate the app is sending
 * at, as a duration — or null when there are fewer than two of them, which is a
 * rate that cannot be read rather than a rate of zero.
 *
 * The instants do not have to be a run's whole traffic: `trafficSample` of the
 * most recent ones is what the ring holds, and the rate over those is the recent
 * rate, which is the one worth acting on.
 */
export function meanGapMs(instants) {
  if (!Array.isArray(instants) || instants.length < 2) return null;
  const span = instants[instants.length - 1] - instants[0];
  return span / (instants.length - 1);
}

/**
 * How long the way back is kept, from what the app has actually done with the
 * replacement rather than from the clock.
 *
 * `arrivals` are the instants the front door handed the replacement real
 * connections — the most recent few, oldest first — and `served` is how many it
 * has been given in all. The window the traffic asks for is the time the rate the
 * app is using it at needs to produce the rest of a proof: the last arrival, plus
 * the connections still missing times the mean gap between the arrivals we have.
 *
 * Measured from the last connection and not from now, because a deadline that
 * follows the clock is not a deadline: a window that re-measured its own idleness
 * would push its end out for as long as it stayed open, and every window would
 * run to its ceiling. Anchored to a connection, it can only be moved by more
 * traffic — which is the point of asking the traffic in the first place.
 *
 * The traffic can move the window only inside its bounds: `minMs` is the floor,
 * so real connections cannot retire the way back before the health checks have
 * had their say, and `maxMs` is the ceiling an operator named. No traffic at all,
 * or instants too few to read a rate from, is a window with no evidence in it and
 * there `maxMs` is the answer — which is what makes a quiet deploy's window
 * LONGER than a busy one's rather than equal to it. `proofConnections: 0` is the
 * same answer for a different reason: with no proof to be had, the clock is the
 * only thing that can close a window.
 *
 * A `maxMs` of 0 or less is no window at all, and a `minMs` above it is not a
 * floor: the ceiling wins, because it is the operator's promise about how long
 * two servers can be up.
 *
 * @param {{
 *   swappedAt: number,
 *   arrivals?: number[],
 *   served?: number,
 *   proofConnections?: number,
 *   minMs?: number,
 *   maxMs?: number,
 * }} [options] the swap the window is measured from, the connections the app has
 *   sent the replacement (when they arrived, and how many in all), and the bounds
 * @returns {number} how long the way back is kept, in milliseconds
 */
export function rollbackWindowFor({
  swappedAt,
  arrivals = [],
  served = 0,
  proofConnections = DEFAULTS.rollbackProofConnections,
  minMs = DEFAULTS.rollbackWindowMinMs,
  maxMs = DEFAULTS.rollbackWindowMs,
} = {}) {
  if (!(maxMs > 0)) return 0;
  if (!(proofConnections > 0)) return maxMs;
  const remaining = proofConnections - served;
  // Nothing left to wait for but the floor: the traffic has already done what it
  // would take to prove the replacement.
  if (remaining <= 0) return Math.min(maxMs, minMs);
  const gap = meanGapMs(arrivals);
  if (gap === null) return maxMs;
  const needed = Math.max(0, remaining * gap);
  const fromLast = arrivals[arrivals.length - 1] + needed;
  return Math.min(maxMs, Math.max(minMs, fromLast - swappedAt));
}

/**
 * A duration that is a RATE rather than a lifetime — the gap between two of an
 * app's connections, or the time such a rate needs for the rest of them — at the
 * precision such a number is decided on. `formatLifetime` is whole seconds, which
 * is right for "how long did this run live" and useless for a burst: a gap of
 * 40ms would read as `0s`, and a window decided by it deserves better than a
 * number that looks like no time at all.
 */
export function formatGapMs(ms) {
  if (!(ms > 0)) return "0s";
  if (ms < 100) return `${Math.round(ms)}ms`;
  // Rounded to the nearest tenth rather than truncated to one: `toFixed` on 150ms
  // reads `0.1s`, and a rate that is a third faster than it says is worse than a
  // rate that says nothing.
  if (ms < 10_000) return `${Math.round(ms / 100) / 10}s`;
  return formatLifetime(ms);
}

/** 1 → base, 2 → 2×base, 3 → 4×base … capped at maxMs. */
export function backoffMs(attempt, { baseMs = DEFAULTS.backoffBaseMs, maxMs = DEFAULTS.backoffMaxMs } = {}) {
  const doubling = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(maxMs, Number.isFinite(doubling) ? doubling : maxMs);
}

export class RestartBudget {
  constructor({ maxRestarts = DEFAULTS.maxRestarts, healthyMs = DEFAULTS.healthyMs } = {}) {
    this.maxRestarts = maxRestarts;
    this.healthyMs = healthyMs;
    this.used = 0;
    this.runStartedAt = null;
  }

  startRun(now = Date.now()) {
    this.runStartedAt = now;
    return this;
  }

  /**
   * Called when a run ends: a run that survived healthyMs retires the whole
   * count, so an all-day session recovers from unrelated crashes forever while
   * a server that dies during startup still exhausts the budget.
   */
  refresh(now = Date.now()) {
    if (this.runStartedAt !== null && now - this.runStartedAt >= this.healthyMs) this.used = 0;
    return this.used;
  }

  /** Reserve one restart, or refuse if the budget is spent. */
  claim() {
    if (this.used >= this.maxRestarts) return false;
    this.used += 1;
    return true;
  }
}

/**
 * Kill a server tree.
 *
 * child.kill() signals only the CLI process. On Windows that leaves Next's
 * `start-server` child and every transform worker alive and holding the port,
 * so the next start collides with a server nobody can see; taskkill /t /f
 * takes the subtree. On POSIX the server was spawned as a group leader
 * (detached), so the negative pid reaches all of it — a plain kill would
 * orphan exactly the same processes. Synchronous by design: it is also the
 * last-resort cleanup in an exit handler.
 *
 * The seams are parameters because the interesting behaviour is the platform
 * branch, and only one of them can be exercised on any given machine.
 *
 * @param {{ pid?: number, exitCode?: number | null, signalCode?: string | null } | null | undefined} child
 * @param {{
 *   signal?: string,
 *   platform?: string,
 *   spawnSyncImpl?: (command: string, args: string[], options: object) => { status?: number | null, error?: unknown },
 *   killGroup?: (pid: number, signal: string) => unknown,
 *   killChild?: (child: object, signal: string) => unknown,
 * }} [options]
 */
export function killTree(
  child,
  {
    signal = "SIGTERM",
    platform = process.platform,
    spawnSyncImpl = spawnSync,
    killGroup = (pid, sig) => process.kill(-pid, sig),
    killChild = (target, sig) => target.kill(sig),
  } = {},
) {
  // Every branch answers the same shape, so a caller can ask for the report
  // without asking which platform it is on: `terminated`/`failed` are the kill's
  // own account of the tree where the platform gives one, and null where it does
  // not (POSIX reports nothing back from a signal).
  if (!child || !child.pid) return { killed: false, reason: "no child", terminated: null, failed: null };
  if (child.exitCode !== null || child.signalCode !== null) {
    return { killed: false, reason: "already exited", terminated: null, failed: null };
  }

  if (platform === "win32") {
    // Force is the point: a graceful request leaves the workers behind. The
    // report is captured because it IS the audit on this platform: taskkill
    // names every process it terminated and every one it could not, and reading
    // the table itself would cost seconds per restart (measured).
    const result = spawnSyncImpl("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      // Both streams: taskkill reports what it terminated on stdout and what it
      // could not on stderr (measured — the distinction decides whether a
      // failure is ever visible).
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (result.error) {
      killChild(child, "SIGKILL");
      return { killed: true, reason: "SIGKILL fallback (taskkill unavailable)", terminated: null, failed: null };
    }
    // A non-zero exit is not by itself a failure: 128 is "no such process",
    // which for a kill is the outcome we wanted, and a tree it could not finish
    // says so per pid in the report.
    return {
      killed: true,
      reason:
        result.status === 0
          ? "taskkill /t /f on the process tree"
          : `taskkill /t /f on the process tree (exit ${result.status})`,
      ...parseTaskkillReport(`${result.stdout ?? ""}${result.stderr ?? ""}`),
    };
  }

  try {
    killGroup(child.pid, signal);
    return { killed: true, reason: `${signal} to the process group`, terminated: null, failed: null };
  } catch {
    killChild(child, signal);
    return { killed: true, reason: `${signal} to the child (no group)`, terminated: null, failed: null };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A process table as `{ pid, ppid, command }` rows — POSIX only, deliberately.
 *
 * Linux answers from `/proc` directly: no subprocess, no parsing, the pid is the
 * directory name, and the parent and the full command line come from the kernel.
 * A POSIX without `/proc` (macOS) answers with `ps`. Windows is absent because
 * reading its table means PowerShell, and that costs seconds per read: measured
 * at 8–9s for the whole table, at 6.5–7.7s filtered to `Name='node.exe'` with
 * command lines, and at 3.3s for pids alone — which is no command line, so no
 * owner to match a reused pid against. `tasklist` was worse (8–60s under load)
 * and this machine has no `wmic`. All of it is more than this audit is worth on
 * every restart. It does not need it: `taskkill /t /f` already names every
 * process it terminated and every one it could not (see `parseTaskkillReport`),
 * which is the same evidence for free.
 *
 * Anything unreadable yields no rows: the audit is evidence, never a gate on the
 * restart it is describing.
 *
 * @param {{
 *   procRoot?: string,
 *   readDir?: (path: string) => string[],
 *   readFile?: (path: string) => string,
 *   run?: (command: string, args: string[], options: object) => { error?: unknown, stdout?: string },
 * }} [options]
 * @returns {{ pid: number, ppid: number, command: string }[]}
 */
export function readProcessTable({
  procRoot = "/proc",
  readDir = readdirSync,
  readFile = readFileSync,
  run = spawnSync,
} = {}) {
  return procProcessTable(procRoot, readDir, readFile) ?? psProcessTable(run);
}

/**
 * `/proc/<pid>/stat` field 4 is the parent; the command comes from the
 * NUL-separated `<pid>/cmdline`, which is what the process was actually run
 * with. Returns null when there is no `/proc` to read.
 *
 * @param {string} procRoot
 * @param {(path: string) => string[]} [readDir]
 * @param {(path: string) => string} [readFile]
 */
export function procProcessTable(procRoot, readDir = readdirSync, readFile = readFileSync) {
  let entries;
  try {
    entries = readDir(procRoot);
  } catch {
    return null;
  }
  const rows = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try {
      stat = readFile(join(procRoot, name, "stat"), "utf8");
    } catch {
      continue; // it exited between the listing and the read
    }
    // The executable name is parenthesised and may itself contain spaces and
    // parenthesis: everything up to the LAST ')' is the name, then state, then
    // the parent pid.
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number.parseInt(after[1], 10);
    if (!Number.isInteger(ppid)) continue;
    let command = "";
    try {
      command = readFile(join(procRoot, name, "cmdline"), "utf8").split("\0").filter(Boolean).join(" ");
    } catch {
      // A kernel thread has no cmdline; the pid and parent are still true.
    }
    rows.push({ pid: Number.parseInt(name, 10), ppid, command });
  }
  return rows;
}

/**
 * `ps -A -o pid=,ppid=,args=` — the POSIX fallback where /proc is absent.
 *
 * @param {(command: string, args: string[], options: object) => { error?: unknown, stdout?: string }} [run]
 */
export function psProcessTable(run = spawnSync) {
  const result = run("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" });
  if (result.error || typeof result.stdout !== "string") return [];
  return parseRows(result.stdout, /^\s*(\d+)\s+(\d+)\s+(.*)$/);
}

/**
 * What `taskkill` reported doing, read from its own output:
 *
 *   SUCCESS: The process with PID 26100 (child process of PID 67996) has been terminated.
 *   ERROR: The process with PID 26100 could not be terminated.
 *   ERROR: The process "26100" not found.
 *
 * The third is not a failure — a process that is already gone is exactly what an
 * audit wants — and the second is the only kind of survivor this platform can
 * report, because taskkill names the tree it took on the way through and there
 * is no cheaper door onto the table than that.
 *
 * Callers hand over BOTH streams: the successes arrive on stdout and the errors
 * on stderr (measured), so a parse of either one alone is half an audit.
 *
 * @param {string | null | undefined} text
 * @returns {{ terminated: number[], failed: number[] }}
 */
export function parseTaskkillReport(text) {
  const terminated = [];
  const failed = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    const success = /^SUCCESS: The process with PID (\d+)/.exec(trimmed);
    if (success) {
      terminated.push(Number.parseInt(success[1], 10));
      continue;
    }
    const couldNot = /^ERROR: The process with PID (\d+) could not be terminated/.exec(trimmed);
    if (couldNot) failed.push(Number.parseInt(couldNot[1], 10));
  }
  return { terminated, failed };
}

function parseRows(text, pattern) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    if (!Number.isInteger(pid)) continue;
    rows.push({ pid, ppid: Number.isInteger(ppid) ? ppid : -1, command: (match[3] ?? "").trim() });
  }
  return rows;
}

/**
 * Every row below a pid, in whatever order the table gave (the root is not one of them).
 *
 * @param {{ pid: number, ppid: number, command?: string }[]} rows
 * @param {number} rootPid
 * @returns {{ pid: number, ppid: number, command: string }[]}
 */
export function descendantsOf(rows, rootPid) {
  const byParent = new Map();
  for (const row of rows) {
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }
  const found = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    for (const row of byParent.get(pid) ?? []) {
      if (seen.has(row.pid)) continue; // a pid cannot be its own ancestor, but tables lie
      seen.add(row.pid);
      found.push(row);
      queue.push(row.pid);
    }
  }
  return found;
}

/**
 * Rows from `before` that the later table still shows, matched on the pid AND
 * its command line: a pid alone can be reused within milliseconds, and a
 * survivor that is a different process is worse than no audit at all.
 *
 * @param {{ pid: number, command?: string }[]} before
 * @param {{ pid: number, command?: string }[]} after
 * @returns {{ pid: number, ppid?: number, command: string }[]}
 */
export function stillAlive(before, after) {
  const byPid = new Map(after.map((row) => [row.pid, row]));
  return before
    .filter((row) => {
      const now = byPid.get(row.pid);
      if (!now) return false;
      return !now.command || !row.command || now.command === row.command;
    })
    .map((row) => byPid.get(row.pid));
}

/**
 * One row, short enough to sit in a log line. The command is optional: a pid that
 * came out of a kill report has none, and the line has to stay truthful without
 * inventing one.
 */
export function describeProcess(row) {
  const command = row.command ?? "";
  const shown = command.length > 70 ? `${command.slice(0, 70)}…` : command;
  return `${row.pid}${shown ? ` (${shown})` : ""}`;
}

/**
 * Force-kill named processes, one pid at a time — never a tree: a leftover may
 * have been adopted by something innocent, and `/t` would take that with it.
 *
 * "Killed" means "not running any more as far as this platform will say": a pid
 * that was already gone counts, because that is the outcome the audit wanted.
 *
 * @param {{ pid: number, command?: string }[]} rows
 * @param {{
 *   platform?: string,
 *   run?: (command: string, args: string[], options: object) => { error?: unknown, stdout?: string, stderr?: string },
 *   killPid?: (pid: number) => void,
 * }} [options]
 * @returns {{ killed: number[], failed: number[] }}
 */
export function killPids(rows, {
  platform = process.platform,
  run = spawnSync,
  killPid = (pid) => process.kill(pid, "SIGKILL"),
} = {}) {
  const killed = [];
  const failed = [];
  for (const row of rows) {
    if (platform === "win32") {
      const result = run("taskkill", ["/pid", String(row.pid), "/f"], {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      });
      // Two ways to fail, and only two: taskkill could not run, or it said so.
      // "not found" is the audit succeeding late — the process is gone.
      const report = parseTaskkillReport(`${result?.stdout ?? ""}${result?.stderr ?? ""}`);
      if (result?.error || report.failed.includes(row.pid)) failed.push(row.pid);
      else killed.push(row.pid);
      continue;
    }
    try {
      killPid(row.pid);
      killed.push(row.pid);
    } catch (error) {
      // Already gone is the answer the audit wanted; anything else is a failure
      // worth naming.
      (error?.code === "ESRCH" ? killed : failed).push(row.pid);
    }
  }
  return { killed, failed };
}

/**
 * Wait until the server answers HTTP on loopback. Any status counts — a 404
 * from a bad path and a 500 from a page still compiling both prove the
 * listening process is back; only a refused connection means it is not. Gives
 * up early if the run it is watching has already ended.
 *
 * The wait between attempts is the FLOOR, not the interval. A refused loopback
 * connect costs nothing to ask again, so waiting a whole interval to ask again
 * is what used to put the recovery line up to that interval behind the moment
 * the port actually answered. `intervalMs` still bounds that wait, and a caller
 * may ask for something tighter than the floor (the tests do, at 5ms and 1ms).
 *
 * One ATTEMPT gets the whole window, not a fraction of it. A server that is up
 * but still compiling a cold route answers in seconds — measured on this repo,
 * `/` took 3.5–22s for the first requests after a restart — and a probe that
 * hangs up on it gets two things wrong at once: it reports "the port has not
 * answered" about a port that did answer, and every abandoned request leaves
 * work running in the very pool it is probing, which made each retry slower
 * than the last (observed live: six abandoned probe requests, 3.5s then 8, 8,
 * 17, 8, 3.5s, and the probe gave up on a server that had answered all of
 * them). A refused connection is the case the floor is for — it returns
 * immediately, so the fast cadence survives — and a server that accepts the
 * socket and then truly stalls runs out the window either way.
 *
 * @param {number} port
 * @param {{
 *   host?: string,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   floorMs?: number,
 *   isDead?: () => boolean,
 *   fetchImpl?: (input: string | URL, init?: object) => Promise<{ status: number }>,
 *   sleepImpl?: (ms: number) => Promise<unknown>,
 * }} [options]
 */
export async function probeUp(
  port,
  {
    host = "127.0.0.1",
    timeoutMs = DEFAULTS.probeTimeoutMs,
    intervalMs = DEFAULTS.probeIntervalMs,
    floorMs = DEFAULTS.probeFloorMs,
    isDead = () => false,
    fetchImpl = fetch,
    sleepImpl = sleep,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  const waitMs = Math.min(floorMs, intervalMs);
  while (Date.now() < deadline) {
    if (isDead()) return { up: false, reason: "the server ended before it answered" };
    try {
      // Raced, not aborted: the attempt is bounded by what is left of the
      // window, so one hung socket cannot outlive the probe — and a refused
      // connect, which is what a server that is still starting gives, settles
      // this in microseconds. (No AbortSignal: `fetch` is a documented global
      // in lint, the web-platform timeout helpers are not.)
      const response = await Promise.race([
        fetchImpl(selfUrl(host, port, "/"), { redirect: "manual" }),
        sleepImpl(Math.max(1, deadline - Date.now())).then(() => {
          throw new Error("probe request timed out");
        }),
      ]);
      return { up: true, status: response.status };
    } catch {
      // Not listening yet (or mid-restart): poll again, at the floor.
    }
    await sleepImpl(waitMs);
  }
  return { up: false, reason: `no answer within ${timeoutMs}ms` };
}

/**
 * One health check of a run that is already up: the same question the probe asks
 * — does it answer on its port — plus the one the probe cannot ask, because the
 * probe is looking for the FIRST answer and this one is looking at a server that
 * has already given one. A run that has died, or that answers 5xx on `/`, has
 * stopped being a server you want in front of the door; anything else, including
 * a 404, means it is still there and still answering.
 *
 * 5xx and not "not 200" on purpose: a page that redirects, a path that 404s and
 * a proxy that says 403 all describe a server that is working. A server error is
 * the app itself saying it cannot serve, which is the one thing a rollback is
 * for.
 *
 * @param {number} port
 * @param {{
 *   host?: string,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   isDead?: () => boolean,
 *   fetchImpl?: (input: string | URL, init?: object) => Promise<{ status: number }>,
 *   sleepImpl?: (ms: number) => Promise<unknown>,
 * }} [options]
 * @returns {Promise<{ ok: boolean, status?: number, reason?: string }>}
 */
export async function healthCheck(
  port,
  {
    host = "127.0.0.1",
    timeoutMs = DEFAULTS.healthCheckTimeoutMs,
    intervalMs = DEFAULTS.healthCheckIntervalMs,
    isDead = () => false,
    fetchImpl = fetch,
    sleepImpl = sleep,
  } = {},
) {
  const result = await probeUp(port, {
    host,
    timeoutMs,
    intervalMs,
    isDead,
    fetchImpl,
    sleepImpl,
  });
  if (!result.up) return { ok: false, reason: result.reason };
  if (result.status >= 500) return { ok: false, status: result.status, reason: `it answered HTTP ${result.status}` };
  return { ok: true, status: result.status };
}

/**
 * The pages that were in use, most recent first, without duplicates and
 * bounded — the list a restart replays. Recency is by request, so a page hit
 * twice in a row is warmed once, and the page hit last is warmed first.
 */
export class WarmList {
  constructor({ limit = DEFAULTS.warmLimit } = {}) {
    this.limit = Math.max(0, limit);
    this.paths = [];
  }

  remember(path) {
    if (!path) return this;
    const seen = this.paths.indexOf(path);
    if (seen !== -1) this.paths.splice(seen, 1);
    this.paths.unshift(path);
    if (this.paths.length > this.limit) this.paths.length = this.limit;
    return this;
  }

  get entries() {
    return [...this.paths];
  }
}

/**
 * Re-request the pages that were in use so the fresh pool compiles them now
 * instead of while the user waits for the page they clicked.
 *
 * One at a time, deliberately: the pool that just died is the one most likely
 * to die again under load, and a parallel replay of six pages is exactly the
 * stampede that killed it. A page that hangs costs its own timeout and nothing
 * more, and the pass stops the moment the run it belongs to is gone.
 *
 * @param {number} port
 * @param {string[]} paths
 * @param {{
 *   host?: string,
 *   timeoutMs?: number,
 *   fetchImpl?: (input: string | URL, init?: object) => Promise<{ status: number }>,
 *   sleepImpl?: (ms: number) => Promise<unknown>,
 *   isDead?: () => boolean,
 * }} [options]
 * @returns {Promise<{ path: string, status: number | null, ms: number, error?: string }[]>}
 */
export async function warmRoutes(
  port,
  paths,
  {
    host = "127.0.0.1",
    timeoutMs = DEFAULTS.warmTimeoutMs,
    fetchImpl = fetch,
    sleepImpl = sleep,
    isDead = () => false,
  } = {},
) {
  const results = [];
  for (const path of paths) {
    if (isDead()) break;
    const startedAt = Date.now();
    try {
      const response = await Promise.race([
        fetchImpl(selfUrl(host, port, path), { redirect: "manual" }),
        sleepImpl(timeoutMs).then(() => {
          throw new Error(`no response in ${timeoutMs}ms`);
        }),
      ]);
      results.push({ path, status: response.status, ms: Date.now() - startedAt });
    } catch (error) {
      results.push({
        path,
        status: null,
        ms: Date.now() - startedAt,
        error: error?.message ?? String(error),
      });
    }
  }
  return results;
}

/**
 * A port of its own for a run that must not hold the public one: taken from the
 * OS's ephemeral range, released, and the number handed to the run.
 *
 * The OS could hand that number to somebody else between the release and the
 * run's own listen, and it cannot be asked not to: the alternative is passing a
 * bound socket to the child, which no server CLI accepts. So the window is
 * accepted, and only its consequence is handled — a run that cannot take the
 * port says EADDRINUSE, which the entry's classifier already treats as fatal,
 * so the supervisor reports it instead of looping on it.
 *
 * @param {{ host?: string }} [options]
 * @returns {Promise<number>}
 */
export async function reservePort({ host = "127.0.0.1" } = {}) {
  const probe = createTcpServer();
  let port;
  try {
    port = await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, host, () => {
        const address = probe.address();
        if (!address || typeof address === "string") {
          reject(new Error("the OS did not name a port"));
          return;
        }
        resolve(address.port);
      });
    });
  } catch (error) {
    probe.close();
    throw error;
  }
  await new Promise((resolve) => probe.close(() => resolve(null)));
  return port;
}

/**
 * The public port, held by the supervisor instead of by the server.
 *
 * A port belongs to one process at a time, so replacing a server without the
 * port closing is only possible if something outlives it: this listener does.
 * Every connection it accepts is piped straight through to the run behind it,
 * byte for byte, and it never looks at what those bytes are — so keep-alive, a
 * streaming response, a WebSocket upgrade and a TLS socket behind it all work
 * unchanged, which is more than an HTTP-aware proxy could promise.
 *
 * A connection that arrives while nothing answers behind it is answered 503 by
 * the front door itself. A refused connection would say "no server here"; a
 * supervisor that is about to have one should say that instead.
 *
 * The port is bound once, in `listen()`, and never again: `setTarget` is the
 * whole of a swap, which is what makes it invisible to whoever is connected.
 * On the way through, a wildcard host is reached on loopback.
 */
export class FrontDoor {
  /**
   * @param {{ *   port: number,
 *   host?: string,
 *   backend?: string,
 *   log?: (message: string) => void,
 *   trafficSample?: number,
 * }} options
 */
  constructor({
    port,
    host = "0.0.0.0",
    backend = "127.0.0.1",
    log = () => {},
    trafficSample = DEFAULTS.trafficSample,
  }) {
    this.port = port;
    this.host = host;
    this.backend = backend;
    this.log = log;
    this.trafficSample = trafficSample;
    this.targetPort = null;
    // Every connection this door accepted, so that closing it cannot be held
    // open by one — including a socket that has already been answered by the
    // door itself, or one a client is slow to read the 503 from.
    this.sockets = new Set();
    // Which of those are piped to which run, kept per target so that a reload
    // can say how many are still on the run it is retiring — a number, rather
    // than an assurance nobody can check.
    this.live = new Map();
    // How many connections each target has been handed since the door last
    // pointed somewhere else: the supervisor's only account of REAL traffic,
    // since the door accepts connections without reading a byte and the health
    // checks never come through it. Counted per target, so what a reload sees is
    // what the app did with the RUN IT IS JUDGING, not with its predecessor.
    this.served = new Map();
    // WHEN those connections arrived — the last `trafficSample` instants per
    // target, oldest first. The count alone says whether the app has used a run;
    // the instants say how HARD, which is what decides how long the way back is
    // kept (see `rollbackWindowFor`).
    this.arrivals = new Map();
    this.server = null;
  }

  /** Take the port. Rejects (EADDRINUSE and friends) when somebody else holds it. */
  async listen() {
    const server = createTcpServer();
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      const target = this.targetPort;
      if (target === null) {
        refuse(socket);
        return;
      }
      socket.setNoDelay(true);
      this.served.set(target, (this.served.get(target) ?? 0) + 1);
      const arrivals = this.arrivals.get(target) ?? [];
      arrivals.push(Date.now());
      if (arrivals.length > this.trafficSample) {
        arrivals.splice(0, arrivals.length - this.trafficSample);
      }
      this.arrivals.set(target, arrivals);
      const upstream = connectTcp({ host: this.backend, port: target });
      upstream.setNoDelay(true);
      const pipes = this.live.get(target) ?? new Set();
      pipes.add(socket);
      this.live.set(target, pipes);
      // Called from BOTH ends' close handlers, so it happens twice for one connection,
      // and the second call is what used to under-report: `live` is keyed by target
      // port and a set is installed only for a port that has none, so a connection
      // accepted in between the two closes installs its OWN set — and deleting the map
      // entry on behalf of the empty set this connection installed took that live
      // connection out of the count. Measured on a real soak: the client held across a
      // swap vanished from `leftoverConnections` exactly when the next client arrived
      // in the 3ms between one connection's two closes, and the soak was told the door
      // had moved a connection a client was still holding. So it runs ONCE and deletes
      // the entry it installed, never whatever set is there now.
      let forgotten = false;
      const forget = () => {
        if (forgotten) return;
        forgotten = true;
        pipes.delete(socket);
        if (pipes.size === 0 && this.live.get(target) === pipes) this.live.delete(target);
      };
      // Neither end may be left half-open: an error or a close on one side tears
      // down the other, which is what a client reads as the connection ending.
      // The one exception is the ordinary end of an upstream response — `pipe`
      // has already ended this socket gracefully by then, and destroying it here
      // would cut the tail of a body that was still being written.
      upstream.on("error", () => {
        // The run behind the door is gone, or never came up at all. If nothing
        // has been written yet, the honest answer is the one a connection with
        // no run behind it gets — a 503 with a retry — rather than a connection
        // that opens and then ends for no stated reason. Once bytes are on their
        // way there is nothing left to say, and the connection ends.
        if (socket.bytesWritten === 0 && !socket.destroyed) refuse(socket);
        else socket.destroy();
      });
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => {
        forget();
        upstream.destroy();
      });
      upstream.on("close", () => {
        forget();
        if (!socket.writableEnded) socket.destroy();
      });
      socket.pipe(upstream);
      upstream.pipe(socket);
    });

    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.port, this.host, () => resolve(null));
      });
    } catch (error) {
      server.close();
      throw error;
    }
    // The port it ACTUALLY holds, which is the one a person needs in the log —
    // and the only way to learn it when the caller asked for 0.
    const address = server.address();
    if (address && typeof address !== "string") this.port = address.port;
    this.server = server;
    return this;
  }

  /**
   * Point the door at a run, returning where it pointed before. Nothing is
   * closed and nothing is re-bound: connections accepted from here on go to the
   * new run, and the ones already piped to the old one stay on it until they end.
   */
  setTarget(port) {
    const previous = this.targetPort;
    this.targetPort = port;
    // A run the door has just been pointed at starts at zero. The counters are
    // keyed by port and a port outlives the process that held it, so without this
    // a replacement that happened to be handed a port an older run had would
    // begin with THAT run's traffic — and the window that traffic decides would
    // be decided on evidence about a process that no longer exists.
    if (port !== null) {
      this.served.delete(port);
      this.arrivals.delete(port);
    }
    return previous;
  }

  /** How many connections are still piped to a run. */
  countFor(port) {
    return this.live.get(port)?.size ?? 0;
  }

  /**
   * How many connected clients a run has been handed since the door pointed at
   * it — the traffic the app has actually sent it, as opposed to the traffic the
   * supervisor asks it for.
   */
  usesFor(port) {
    return this.served.get(port) ?? 0;
  }

  /**
   * When the last `trafficSample` connections of a run arrived, oldest first —
   * the rate the app is using it at, as instants. Empty for a run nothing has
   * been sent through, which is a rate nobody can read rather than a slow one.
   */
  arrivalsFor(port) {
    return this.arrivals.get(port) ?? [];
  }

  /** Let the port go, and every connection with it. */
  async close() {
    // Every socket, not only the piped ones: a connection the door answered
    // itself is still a connection the listener holds, and `server.close()`
    // waits for all of them — a client that never reads its 503 would otherwise
    // hold the exit open.
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.live.clear();
    this.served.clear();
    this.targetPort = null;
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve(null)));
  }
}

/**
 * What a connection gets while nothing is behind the door: a real HTTP answer,
 * with the one header that means "ask again", rather than a bare close that a
 * client can only read as a server that is not there.
 */
function refuse(socket) {
  const body = "the server is not answering on this port yet\n";
  socket.end(
    "HTTP/1.1 503 Service Unavailable\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${body.length}\r\n` +
      "Retry-After: 1\r\n" +
      "Connection: close\r\n\r\n" +
      body,
  );
}

/**
 * Reload requests, one at a time.
 *
 * A request that arrives while the loop is busy — starting a server, retiring
 * one, sleeping out a backoff — is remembered rather than lost, and ten touches
 * of a sentinel are one reload rather than ten: the loop is told to reload, not
 * how many times somebody asked. A request is taken by `next()`, so the loop
 * sees each one exactly once.
 */
export class ReloadQueue {
  constructor() {
    this.pending = null;
    this.wake = null;
  }

  /** Ask for one reload. False when one is already waiting to be served. */
  request(why) {
    if (this.pending !== null) return false;
    this.pending = why;
    const wake = this.wake;
    this.wake = null;
    if (wake) wake();
    return true;
  }

  /** Resolves the next time a reload has been asked for, once per request. */
  async next() {
    if (this.pending === null) {
      await new Promise((resolve) => {
        this.wake = resolve;
      });
    }
    const why = this.pending ?? "requested";
    this.pending = null;
    return why;
  }
}

/**
 * The version of the reload record below, carried on every line of the history.
 * A deploy pipeline pins it and refuses anything else, so a change to what a line
 * MEANS cannot be mistaken for a change to the numbers in it.
 */
export const RELOAD_HISTORY_SCHEMA = "base88.reload/1";

/**
 * One reload, as a machine reads it.
 *
 * `outcome` is what became of the reload, and it is the field a pipeline branches
 * on:
 *
 *   replaced      the replacement is serving, and the run it replaced is gone
 *   rolled-back   the replacement failed and the door went back to that run
 *   kept          nothing changed: the replacement never came up, or the
 *                 supervisor was already stopping when it was asked for
 *   no-fallback   the replacement failed AND the run it replaced was gone, so
 *                 the replacement stays — there was no way back to take
 *   stopped       a shutdown ended the reload; the replacement is in place
 *
 * `closedBy` is what ended the window, and it is `null` when no window was open at
 * all (there was nothing to swap, early retirement was switched off, or there was
 * no port to check on): `traffic` the app's own connections proved it, `clock` the
 * window's time ran out, `check` a health check failed, `exit` the replacement
 * exited, `shutdown` a signal arrived, `no-port` there was nothing to check it on.
 *
 * `rolledBack` restates `outcome === "rolled-back"` in the shape an alarm wants,
 * and the rest is the evidence: how many REAL connections the app put through the
 * replacement, how many health checks it passed across them, how long the window
 * was allowed to last (`windowMs`, the ceiling an operator set) and how long it
 * actually did (`windowUsedMs`, which is the length the app's own traffic asked
 * for: the two are equal only when there was no traffic to ask), how many
 * connections were still open on the run this reload stopped when it stopped it,
 * and the ports the door moved between — the numbers on the machine rather than
 * the numbers in a promise.
 *
 * @param {{
 *   asked: string,
 *   outcome: string,
 *   closedBy?: string | null,
 *   detail?: string | null,
 *   startedAt: number,
 *   at?: number,
 *   swappedAt?: number | null,
 *   windowMs: number,
 *   proofConnections: number,
 *   served?: number,
 *   checks?: number,
 *   leftoverConnections?: number,
 *   replacementPort?: number | null,
 *   previousPort?: number | null,
 *   frontPort?: number | null,
 * }}
 * @returns {Record<string, unknown>} the object that goes on the line, unchanged
 */
export function reloadRecord({
  asked,
  outcome,
  closedBy = null,
  detail = null,
  startedAt,
  at = Date.now(),
  swappedAt = null,
  windowMs,
  proofConnections,
  served = 0,
  checks = 0,
  leftoverConnections = 0,
  replacementPort = null,
  previousPort = null,
  frontPort = null,
}) {
  return {
    schema: RELOAD_HISTORY_SCHEMA,
    at: new Date(at).toISOString(),
    startedAt: new Date(startedAt).toISOString(),
    swappedAt: swappedAt === null ? null : new Date(swappedAt).toISOString(),
    asked,
    outcome,
    closedBy,
    rolledBack: outcome === "rolled-back",
    windowMs,
    // How long the way back was actually open — the number a pipeline compares
    // `windowMs` against — and null when nothing was ever swapped in.
    windowUsedMs: swappedAt === null ? null : at - swappedAt,
    proofConnections,
    served,
    checks,
    leftoverConnections,
    replacementPort,
    previousPort,
    frontPort,
    detail,
  };
}

/**
 * Append one record to the history, as one line. Returns whether it landed.
 *
 * Failing to WRITE it is reported and not fatal: this is an account of a reload,
 * and a supervisor that stopped serving because it could not sign its own
 * minutes would be a worse failure than the gap in the minutes. One `appendFile`
 * per record is also what keeps the file readable while it is being written — a
 * single small write to an O_APPEND handle is a line or it is nothing, never half
 * of one.
 *
 * @param {string} path
 * @param {Record<string, unknown>} record
 * @param {{
 *   log?: (message: string) => void,
 *   appendFile?: (path: string, text: string) => void,
 * }} [options]
 */
export function appendReloadRecord(path, record, { log = () => {}, appendFile = appendFileSync } = {}) {
  try {
    appendFile(path, `${JSON.stringify(record)}\n`);
    return true;
  } catch (error) {
    log(
      `the reload happened, but its record could not be written to ${path} ` +
        `(${error?.message ?? error}) — carrying on without it`,
    );
    return false;
  }
}

/**
 * A reload asked for by touching a file — the trigger that works from a script,
 * a Makefile or a deployment step, and the only one a platform that cannot
 * deliver SIGHUP has.
 *
 * The file is REMOVED as it is read, because that is what makes one touch one
 * reload: a file left in place would ask again on every poll. A file that cannot
 * be removed yet — something is still writing it, which on Windows locks it — is
 * left alone and looked at again, rather than read half-written.
 *
 * @param {{
 *   file?: string | null,
 *   pollMs?: number,
 *   onReload: (why: string) => void,
 *   fs?: { existsSync: (path: string) => boolean, unlinkSync: (path: string) => void },
 * }} options
 * @returns {{ stop: () => void } | null} null when no file was named
 */
export function watchReloadFile({
  file,
  pollMs = DEFAULTS.reloadPollMs,
  onReload,
  fs = { existsSync, unlinkSync },
}) {
  if (!file) return null;
  const timer = setInterval(() => {
    if (!fs.existsSync(file)) return;
    try {
      fs.unlinkSync(file);
    } catch {
      return; // still being written; the next poll will find it whole
    }
    onReload(file);
  }, pollMs);
  // Never a reason for the supervisor to stay alive on its own.
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * Split a stream into lines but keep the raw bytes going to the terminal. A
 * chunk boundary in the middle of a line cannot hide a signature, and an
 * unterminated line (a progress bar, a huge stack) cannot grow without bound.
 */
function createLineScanner(onLine, limit = DEFAULTS.lineLimit) {
  let pending = "";
  const emit = (text) => {
    if (text.length) onLine(text);
  };
  return {
    push(chunk) {
      pending += chunk;
      let index;
      while ((index = pending.indexOf("\n")) !== -1) {
        emit(pending.slice(0, index).replace(/\r$/, ""));
        pending = pending.slice(index + 1);
      }
      if (pending.length > limit) {
        emit(pending);
        pending = "";
      }
    },
    flush() {
      const rest = pending;
      pending = "";
      emit(rest);
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const isExited = (child) => child.exitCode !== null || child.signalCode !== null;

/**
 * Start one run. Returns the child plus the two moments the supervisor cares
 * about: `done` — the verdict that ended this run (the classifier said the pool
 * died, a fatal error appeared, or the process exited) — and `gone`, which
 * resolves when the process is really gone, whether or not it exited on its
 * own.
 */
function startRun({ serverCmd, classify, onPort, onRoute, env = null }) {
  const [file, ...args] = serverCmd;
  const child = spawn(file, args, {
    stdio: ["inherit", "pipe", "pipe"],
    // POSIX: own process group, so the whole tree can be signalled at once.
    // Windows: no group is needed — taskkill takes the subtree — and staying
    // attached to the console keeps Ctrl+C working the way it always did.
    detached: process.platform !== "win32",
    // What the run has to know about ITSELF, and nothing else: today, the port it
    // was given when something else holds the public one. Its environment is
    // otherwise the supervisor's own, unchanged.
    ...(env ? { env: { ...process.env, ...env } } : null),
  });

  const done = deferred();
  const gone = deferred();
  let verdict = null;
  const settle = (value) => {
    if (verdict) return;
    verdict = value;
    done.resolve(value);
  };

  // Both streams are scanned, because the lines worth reacting to are not
  // guaranteed to arrive on one of them (the pool-death line has been seen on
  // stdout and on stderr in different Next versions); the classifier decides
  // what any of them means.
  const scan = (line) => {
    const found = classify(line);
    if (!found) return;
    if (found.kind === "pool-death") settle({ kind: "pool-death", line, why: found.why });
    else if (found.kind === "no-restart") settle({ kind: "no-restart", line, why: found.why });
    else if (found.kind === "local-url") onPort(found.port);
    else onRoute(found.path);
  };
  const out = createLineScanner(scan);
  const err = createLineScanner(scan);

  // stdin stays inherited so the server's own keyboard shortcuts keep working.
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
    out.push(chunk.toString());
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
    err.push(chunk.toString());
  });

  child.on("close", (code, signal) => {
    out.flush();
    settle(signal || code !== 0 ? { kind: "exit", code, signal } : { kind: "clean-exit", code });
    gone.resolve();
  });
  child.on("error", (error) => {
    settle({ kind: "spawn-error", error });
    gone.resolve();
  });

  return { child, done: done.promise, gone: gone.promise, isExited: () => isExited(child) };
}

/**
 * The `next` CLI from this project's own node_modules — exported because both
 * entries build their server argv from it (`next dev`, `next start`): one
 * resolution, so both run the version this project installed.
 */
export function nextBin() {
  return require.resolve("next/dist/bin/next");
}

/**
 * Run the server until it exits cleanly, hits an error a restart cannot fix, or
 * spends its restart budget. Returns the exit code for the supervisor to pass
 * through.
 *
 * This loop IS the supervision mechanism, and it is deliberately the same one
 * for `npm run dev` and `npm start`: spawn the server, stream its output
 * through untouched, probe the port until it answers, kill the whole tree when
 * the run ends, audit what that kill actually left behind, back off, and stop
 * when the budget or a fatal line says a restart cannot help. Only the policy
 * differs, and it is REQUIRED: an entry that forgets some of it is stopped with
 * a message rather than quietly inheriting another server's judgement.
 *
 * @param {{
 *   serverCmd: string[],
 *   classify: (line: string) => { kind: string, why?: string, port?: number, path?: string } | null,
 *   banner: string,
 *   plainHint: string,
 *   log: (message: string) => void,
 *   warmEnabled: boolean,
 *   port?: number | null,
 *   frontPort?: number | null,
 *   frontHost?: string,
 *   probeHost?: string,
 *   reloadFile?: string | null,
 *   frontDrainMs?: number,
 *   rollbackWindowMs?: number,
 *   rollbackWindowMinMs?: number,
 *   rollbackProofConnections?: number,
 *   rollbackProofChecks?: number,
 *   reloadHistory?: string | null,
 *   healthCheckIntervalMs?: number,
 *   healthCheckTimeoutMs?: number,
 *   maxRestarts?: number,
 *   healthyMs?: number,
 *   backoffBaseMs?: number,
 *   backoffMaxMs?: number,
 *   exitGraceMs?: number,
 *   probeTimeoutMs?: number,
 *   probeIntervalMs?: number,
 *   warmLimit?: number,
 *   warmTimeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   kill?: typeof killTree,
 *   table?: (() => { pid: number, ppid: number, command: string }[]) | null,
 *   sleepImpl?: (ms: number) => Promise<unknown>,
 * }} [options] the entry's policy, and whichever mechanism knobs it wants
 * @returns {Promise<number>} the exit code for the entry to pass through
 */
export async function supervise(options = {}) {
  const {
    port = null,
    maxRestarts = DEFAULTS.maxRestarts,
    healthyMs = DEFAULTS.healthyMs,
    backoffBaseMs = DEFAULTS.backoffBaseMs,
    backoffMaxMs = DEFAULTS.backoffMaxMs,
    exitGraceMs = DEFAULTS.exitGraceMs,
    probeTimeoutMs = DEFAULTS.probeTimeoutMs,
    probeIntervalMs = DEFAULTS.probeIntervalMs,
    warmLimit = DEFAULTS.warmLimit,
    warmTimeoutMs = DEFAULTS.warmTimeoutMs,
    // The front door, off unless an entry names a port for it. `frontHost` is
    // what it binds, `probeHost` is what a run is reached on from inside this
    // process (they differ exactly when the entry's host is a wildcard), and
    // `reloadFile` is the sentinel one touch of which asks for a reload.
    frontPort = null,
    frontHost = "0.0.0.0",
    probeHost = "127.0.0.1",
    reloadFile = null,
    frontDrainMs = DEFAULTS.frontDrainMs,
    // How long a run a reload replaced is kept warm behind the swap — at most
    // `rollbackWindowMs` and at least `rollbackWindowMinMs`, with the app's own
    // traffic deciding where in between — how much real traffic the app must have
    // put through the replacement before that run can be retired early, and how
    // the replacement is checked while it is. Neither bound can decide a window on
    // its own: the traffic's rate is what sets the length inside them (see
    // `rollbackWindowFor`). `rollbackWindowMs: 0` retires the replaced run at the
    // swap, which is what a reload did before the window existed;
    // `rollbackProofConnections: 0` makes the window a clock again, with the app's
    // traffic only decorating the log.
    rollbackWindowMs = DEFAULTS.rollbackWindowMs,
    rollbackWindowMinMs = DEFAULTS.rollbackWindowMinMs,
    rollbackProofConnections = DEFAULTS.rollbackProofConnections,
    rollbackProofChecks = DEFAULTS.rollbackProofChecks,
    // Where each performed reload is recorded, one JSON object per line — the
    // account a deploy pipeline reads. The path is the entry's promise (a
    // production operator names it), and the mechanism only appends to it;
    // nothing is written when no path is named.
    reloadHistory = null,
    healthCheckIntervalMs = DEFAULTS.healthCheckIntervalMs,
    healthCheckTimeoutMs = DEFAULTS.healthCheckTimeoutMs,
    fetchImpl = fetch,
    kill = killTree,
    // Windows has no cheap table to read, and needs none: its kill report carries
    // the enumeration and the verdict (see killTree).
    table = process.platform === "win32" ? null : readProcessTable,
    sleepImpl = sleep,
    // The policy, all of it required. `serverCmd` is the argv to run; `classify`
    // is what a line of its output MEANS; `banner` is the first line printed;
    // `plainHint` is what the give-up line tells you to run instead of this;
    // `log` is where every supervisor line goes; `warmEnabled` is whether the
    // pages in use are replayed.
    serverCmd,
    classify,
    banner,
    plainHint,
    log,
    warmEnabled,
  } = options;
  // A missing policy must be an error, not an inheritance. A production
  // supervisor scanning for a Turbopack death line, or a dev one that never
  // replays its pages, is a bug that would otherwise be invisible.
  const missing = [];
  if (!Array.isArray(serverCmd) || serverCmd.length === 0) missing.push("serverCmd");
  if (typeof classify !== "function") missing.push("classify");
  if (typeof banner !== "string") missing.push("banner");
  if (typeof plainHint !== "string") missing.push("plainHint");
  if (typeof log !== "function") missing.push("log");
  if (typeof warmEnabled !== "boolean") missing.push("warmEnabled");
  if (missing.length) {
    throw new Error(
      `supervise() needs the entry's own policy: missing ${missing.join(", ")} ` +
        "(the two entries that exist are scripts/dev.mjs and scripts/start.mjs)",
    );
  }

  const budget = new RestartBudget({ maxRestarts, healthyMs });
  const warmList = new WarmList({ limit: warmLimit });
  let stopping = false;
  let current = null;
  let knownPort = port;
  let front = null;
  const reloads = new ReloadQueue();
  // A reload can only BE a reload if something holds the port across it: without
  // a front door there is no listener to hand over, and a restart with a gap is
  // not a reload. So the triggers are wired only when there is one.
  const reloadWatcher = frontPort === null ? null : watchReloadFile({ file: reloadFile, onReload: (why) => reloads.request(why) });
  if (frontPort === null && reloadFile) {
    log("a reload file was named, but nothing can be reloaded without a front door — ignoring it");
  }

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} — stopping the server`);
    if (!current || current.isExited()) return;
    try {
      current.child.kill(signal === "SIGTERM" ? "SIGTERM" : "SIGINT");
    } catch {
      // Already gone between the check and the signal.
    }
    setTimeout(() => {
      if (!current?.isExited()) kill(current?.child, { signal: "SIGKILL" });
    }, exitGraceMs).unref?.();
  };

  /**
   * Replay the pages that were in use, once the replacement server is known to
   * be answering. Never fatal, never awaited by the supervisor loop: it is a
   * courtesy to the next click, not part of staying alive.
   */
  const warm = async (warmPort, isDead) => {
    if (!warmEnabled) return;
    const paths = warmList.entries;
    if (paths.length === 0) return;
    log(`re-requesting ${paths.length} page(s) that were in use, so the fresh pool compiles them first: ${paths.join(" ")}`);
    const results = await warmRoutes(warmPort, paths, {
      host: probeHost,
      timeoutMs: warmTimeoutMs,
      fetchImpl,
      sleepImpl,
      isDead,
    });
    if (results.length === 0) return;
    const summary = results
      .map((result) => `${result.path} → ${result.status ?? `no answer (${result.error})`}`)
      .join("; ");
    log(`warmed ${summary}`);
  };

  /** Stop a run: escalate once, then check the table for what the kill missed. */
  const stopRun = (run) => terminate(run, { kill, sleepImpl, graceMs: exitGraceMs, table, log });

  /**
   * Start one run: the entry's argv, on the port it is either told (there is a
   * front door) or pinned to, with its output scanned through the entry's
   * classifier and its port probed until it answers.
   *
   * Returns the run and the promise of that probe, because for a reload the
   * answer to "did it come up?" IS the decision.
   */
  const beginRun = (assignedPort) => {
    // A restart is only "recovered" once the port answers, so the probe runs
    // alongside the output stream rather than after it — and starts as soon
    // as a port is known, which for an unpinned port is the banner line.
    //
    // The pinned port is only an assumption about where the server listens;
    // the banner is what it actually bound, so the banner wins when they
    // disagree, and each probe carries a generation so a superseded one (or
    // one from an earlier run) reports nothing rather than a stale verdict.
    let runPort = assignedPort ?? knownPort;
    let probeGeneration = 0;
    let probedPort = null;
    let run = null;

    const startProbe = (probePort) => {
      if (probePort === null || probePort === probedPort) return Promise.resolve(null);
      probedPort = probePort;
      probeGeneration += 1;
      const generation = probeGeneration;
      return probeUp(probePort, {
        host: probeHost,
        timeoutMs: probeTimeoutMs,
        intervalMs: probeIntervalMs,
        isDead: () => run.isExited(),
        fetchImpl,
        sleepImpl,
      }).then(async (result) => {
        if (generation !== probeGeneration || run.isExited()) return null;
        if (!result.up) {
          log(`restarted, but the port has not answered yet (${result.reason})`);
          return result;
        }
        // The front door only ever points at a run that HAS answered, and that
        // single line is the whole of a reload's seamlessness: the pointer
        // moves, and the port never closes.
        if (front) front.setTarget(probePort);
        log(`back up — http://${probeHost}:${probePort} answered HTTP ${result.status}`);
        await warm(probePort, () => generation !== probeGeneration || run.isExited());
        return result;
      });
    };

    run = startRun({
      serverCmd,
      classify,
      onPort: (found) => {
        runPort = found;
        knownPort = found;
        startProbe(found);
      },
      onRoute: (path) => warmList.remember(path),
      // Under a front door a run must not take the public port, so it is given
      // one of its own and told about it the way every Node server already
      // reads. Without a front door there is nothing to tell it.
      env: assignedPort === null ? null : { PORT: String(assignedPort) },
    });
    // The port this run is reached on, as a function of time rather than a value:
    // it is the one it was given until its banner says otherwise, and a caller
    // that needs it (a health check, a way back) needs the run's own answer. The
    // accessor hangs off the run itself as well as the pair, because a run is what
    // the supervisor hands around: a reload's way back is the port of the run it
    // was serving with, and that is `serving` — a run, not the pair it came from.
    const port = () => runPort;
    return { run: Object.assign(run, { port }), probed: startProbe(runPort), port };
  };

  /**
   * Watch the replacement for as long as the app needs it watched: until it has
   * been exercised and stayed healthy (which is the window closing EARLY, on the
   * app's own evidence), until the window the app's traffic asks for runs out
   * (nothing proved it in that long, so the clock is all there is), or until a
   * judgement ends it — a run that has exited, or one that answered 5xx, has
   * already failed. A null port cannot be checked and cannot fail one (the probe
   * answered on it, so the door knows where it is).
   *
   * Real traffic is the strongest evidence there is, and it is measured where it
   * cannot be faked or missed: the connections the front door accepted for this
   * run, which are clients' by construction. The floor under it is the health
   * checks, so a single busy second cannot retire the run that is the way back.
   *
   * The window is re-read every tick rather than fixed at the swap, because the
   * rate it is derived from is a live measurement: a window that opened long
   * because nothing had arrived yet must be allowed to SHORTEN once the app
   * arrives at speed. The waits are capped by what is left of it, so it is a BOUND
   * rather than something crossed once per interval: a health check that starts
   * before the window closes counts, and one after it does not begin.
   *
   * @param {{ isExited: () => boolean }} run
   * @param {number | null} checkPort
   * @param {number} swappedAt when the port changed hands, which is what the
   *   window is measured from and what its floor is measured from.
   */
  const watchReplacement = async (run, checkPort, swappedAt) => {
    if (checkPort === null) return { outcome: "unchecked" };
    let checks = 0;
    for (;;) {
      // Asked before the wait as well as after it, so a shutdown that arrives the
      // moment the window opens does not cost an interval to be noticed.
      if (stopping) return { outcome: "stopping" };
      if (run.isExited()) return { outcome: "unhealthy", source: "exit", reason: "it exited" };
      // What the app has done with the replacement, read fresh every tick: the
      // connections the door handed it since it was swapped in, and when they
      // arrived — the count is whether it has been used, the rate is how hard.
      const served = front ? front.usesFor(checkPort) : 0;
      const arrivals = front ? front.arrivalsFor(checkPort) : [];
      const gapMs = meanGapMs(arrivals);
      // How long the traffic says to keep the way back, this tick. See
      // `rollbackWindowFor`: it is the ceiling when there is no rate to read,
      // the floor when the app has already done everything a proof needs, and
      // the time the observed rate needs to finish proving itself in between.
      const windowMs = rollbackWindowFor({
        swappedAt,
        arrivals,
        served,
        proofConnections: rollbackProofConnections,
        minMs: rollbackWindowMinMs,
        maxMs: rollbackWindowMs,
      });
      // The app has used it and it is still healthy — the clock has nothing left
      // to discover, so the way back is closed now rather than at the ceiling.
      if (rollbackProofConnections > 0 && served >= rollbackProofConnections && checks >= rollbackProofChecks) {
        return { outcome: "proven", served, checks, gapMs, windowMs };
      }
      const left = swappedAt + windowMs - Date.now();
      if (left <= 0) return { outcome: "healthy", served, checks, gapMs, windowMs };
      // The wait is capped by what is left of the window, with a floor, so a
      // caller cannot turn the window into a hammer.
      await sleepImpl(Math.max(1, Math.min(healthCheckIntervalMs, left)));
      if (stopping) return { outcome: "stopping" };
      if (run.isExited()) return { outcome: "unhealthy", source: "exit", reason: "it exited" };
      checks += 1;
      const check = await healthCheck(checkPort, {
        host: probeHost,
        timeoutMs: healthCheckTimeoutMs,
        intervalMs: healthCheckIntervalMs,
        isDead: () => run.isExited(),
        fetchImpl,
        sleepImpl,
      });
      if (!check.ok) return { outcome: "unhealthy", source: "check", reason: check.reason };
    }
  };

  /**
   * A reload: bring a replacement up BESIDE the run that is serving, point the
   * front door at it, and only then — once the app's own traffic has proved it,
   * or it has STAYED healthy for the window that traffic asks for — retire the run
   * it replaced.
   *
   * The order is the whole feature, and the wait is the rest of it. The run being
   * replaced goes on serving while the replacement boots, the front door is
   * pointed at the replacement — a pointer move, not a close and a bind — and
   * that run is then kept WARM while the replacement is health-checked. A
   * replacement that fails a check is stopped and the door goes back to the run
   * it replaced, which is still there precisely because it was not stopped yet;
   * one that survives the window is trusted, and the run it replaced is stopped
   * through the same audited stop every retirement uses. A reload that cannot
   * produce a server at all changes nothing: the replacement is stopped, the log
   * says why, and the run that was already serving keeps serving, because a
   * failed reload must not cost you the server you had.
   *
   * Returns the run the loop should watch from now on, and the verdict it reached
   * — the same object the log is written from, so what went into the history and
   * what an operator read cannot disagree.
   */
  const performReload = async (serving, why) => {
    const startedAt = Date.now();
    log(`reload requested (${why}) — starting a replacement beside the run that is serving`);
    // Where the door points right now: the run that is serving, or nothing if
    // that run never answered through it. It is also the way back.
    const previous = front ? front.targetPort : null;
    // Reserved on the interface runs are reached on, not on loopback by
    // default: an entry that pinned its server elsewhere must be given a port
    // that is free THERE.
    const runPort = await reservePort({ host: probeHost });
    const { run: replacement, probed, port: replacementPort } = beginRun(runPort);
    // What every record of this reload has in common whoever it turned out: when
    // the supervisor began acting on the request, why it was asked for, where the
    // door was pointing, and the port the replacement is reached on.
    const common = {
      asked: why,
      startedAt,
      previousPort: previous,
      replacementPort: replacementPort(),
      frontPort: front ? front.port : null,
    };
    // Racing the probe against the replacement's own end matters: a replacement
    // that dies without listening would otherwise hold the reload for the whole
    // probe window before admitting it never came up.
    const result = await Promise.race([probed, replacement.done.then(() => null)]);

    if (stopping) {
      // A stop that arrived during the reload wins: nothing is swapped, and the
      // run that was serving is the one the signal handler is already stopping.
      const settledAt = Date.now();
      await stopRun(replacement);
      return {
        run: serving,
        verdict: {
          ...common,
          // When the VERDICT landed, which is what the log says and what
          // `windowUsedMs` is measured to — not after the drain and the tree stop
          // that follow it, which would make a proven reload read as a long one.
          at: settledAt,
          outcome: "kept",
          closedBy: null,
          detail: "the supervisor was stopping while the replacement was starting",
        },
      };
    }
    if (!result?.up) {
      const reason = result?.reason ?? "it ended before it answered";
      log(`the replacement never came up (${reason}) — keeping the run that is already serving`);
      const settledAt = Date.now();
      await stopRun(replacement);
      return {
        run: serving,
        verdict: {
          ...common,
          at: settledAt,
          outcome: "kept",
          closedBy: null,
          detail: `the replacement never came up (${reason})`,
        },
      };
    }

    const backTo = previous ?? serving.port();
    // When the port changed hands, which is what the window is measured from.
    const swappedAt = Date.now();
    if (rollbackWindowMs <= 0) {
      const leftoverConnections = front && backTo !== null ? front.countFor(backTo) : 0;
      log(
        `the replacement is serving — retiring the run it replaced` +
          (front && backTo !== null ? ` (${leftoverConnections} connection(s) still on it)` : ""),
      );
      const settledAt = Date.now();
      // The switch is instantaneous, so a reply the front door has just piped to
      // the old run has this long to arrive before the process producing it is
      // stopped. On a platform whose stop is forceful this pause IS the drain.
      await sleepImpl(frontDrainMs);
      await stopRun(serving);
      return {
        run: replacement,
        verdict: {
          ...common,
          at: settledAt,
          swappedAt,
          outcome: "replaced",
          closedBy: null,
          leftoverConnections,
        },
      };
    }

    log(
      `the replacement is serving — keeping the run it replaced warm and answering ` +
        (rollbackProofConnections > 0
          ? `for as long as the app's own traffic asks for: between ` +
            `${formatLifetime(rollbackWindowMinMs)} and ${formatLifetime(rollbackWindowMs)}, ` +
            `since ${rollbackProofConnections} real connection(s) through the replacement prove it ` +
            "and a window nothing arrives in runs to that ceiling, "
          : `for ${formatLifetime(rollbackWindowMs)}, the whole of it, retiring early being ` +
            "switched off and the clock the only thing that closes it, ") +
        "to hand the port back to if the replacement fails",
    );
    // From here the replacement is the run the supervisor is responsible for: a
    // SIGINT goes to the server that is serving, and this function is what stops
    // the warm one on every path out of the window.
    current = replacement;

    // The verdict, whole: `outcome` says which way it went, `served`/`checks` are
    // the evidence it went that way on, and `windowMs` is the length the app's own
    // traffic asked the window to be — which the log then reports.
    const verdict = await watchReplacement(
      replacement,
      front ? front.targetPort : replacementPort(),
      swappedAt,
    );
    // The instant the verdict landed, which is what the log line is about and
    // what `windowUsedMs` is measured to. Read HERE and not where the record is
    // written: between the two come the drain and the audited stop of a server,
    // and counting those as window time would make a proven reload read as one
    // that used the whole of it.
    const settledAt = Date.now();
    const { outcome, source, reason } = verdict;

    if (outcome === "stopping") {
      // Going down: the run the reload kept warm is not the signal handler's to
      // stop (it has already been given the replacement), so it is stopped here
      // rather than left holding a port with nobody watching it.
      const leftoverConnections = front && backTo !== null ? front.countFor(backTo) : 0;
      await stopRun(serving);
      return {
        run: replacement,
        verdict: {
          ...common,
          at: settledAt,
          swappedAt,
          outcome: "stopped",
          closedBy: "shutdown",
          served: verdict.served,
          checks: verdict.checks,
          leftoverConnections,
          detail: "a shutdown ended the reload before the window did",
        },
      };
    }

    if (outcome === "unhealthy") {
      // What went wrong, in the evidence's own terms: an exit and a failed check
      // are different verdicts about the same run and must not read as one.
      const failed =
        source === "exit"
          ? "the replacement exited after it answered"
          : `the replacement failed its health check (${reason})`;
      if (serving.isExited()) {
        // The way back is gone — the run that was kept warm ended during the
        // window — so there is no rollback to make. The replacement is the only
        // server there is; a run that dies from here is an ordinary crash.
        log(
          `${failed}, and the run it replaced is gone too — there is nothing to fall back to, ` +
            "so the replacement stays",
        );
        return {
          run: replacement,
          verdict: {
            ...common,
            at: settledAt,
            swappedAt,
            outcome: "no-fallback",
            closedBy: source === "exit" ? "exit" : "check",
            served: verdict.served,
            checks: verdict.checks,
            detail: `${failed}, and the run it replaced was gone`,
          },
        };
      }
      // Connections still piped to the run being taken out, read before it is
      // stopped: the requests this rollback cuts off. The door is pointing at the
      // replacement at this moment, so that is where they are.
      const leftoverConnections = front ? front.countFor(front.targetPort) : 0;
      front?.setTarget(backTo);
      log(
        `${failed} — rolling back: the front door is ` +
          (backTo === null
            ? "back to having nothing behind it, as it was before the reload, and the replacement is stopped"
            : "back to the run it replaced, and the replacement is stopped"),
      );
      current = serving;
      // Symmetrical with the commit below: a reply the door has just piped to
      // the replacement gets to arrive before the process producing it is stopped.
      await sleepImpl(frontDrainMs);
      await stopRun(replacement);
      return {
        run: serving,
        verdict: {
          ...common,
          at: settledAt,
          swappedAt,
          outcome: "rolled-back",
          closedBy: source === "exit" ? "exit" : "check",
          served: verdict.served,
          checks: verdict.checks,
          leftoverConnections,
          detail: failed,
        },
      };
    }

    const stillOnIt =
      front && backTo !== null ? ` (${front.countFor(backTo)} connection(s) still on it)` : "";
    // The run being retired, and the connections that were still on it when it
    // went: the same number the log's tail carries, in the record's own field.
    const leftoverConnections = front && backTo !== null ? front.countFor(backTo) : 0;
    let closedBy;
    if (outcome === "unchecked") {
      closedBy = "no-port";
      log(
        "the replacement was swapped in, but there is no port to health-check it on — " +
          `retiring the run it replaced without one${stillOnIt}`,
      );
    } else if (outcome === "proven") {
      // The app's own traffic, not the clock, is what closed the window.
      closedBy = "traffic";
      log(
        `the replacement has taken ${verdict.served} real connection(s) from the app and passed ` +
          `${verdict.checks} health check(s) — retiring the run it replaced early${stillOnIt}`,
      );
    } else {
      // The clock decided, and the line says HOW LONG that clock was and why: the
      // rate the app was using the replacement at, the ceiling a window with no
      // rate to read runs to, or no early retirement to be had at all. The window
      // is the traffic's number, so a reader can only judge it if the evidence
      // behind it is in the same sentence.
      closedBy = "clock";
      const decided = verdict.windowMs ?? rollbackWindowMs;
      const remaining = Math.max(0, rollbackProofConnections - verdict.served);
      const needed = verdict.gapMs === null ? null : remaining * verdict.gapMs;
      const why =
        rollbackProofConnections <= 0
          ? `retiring early is switched off, so nothing but the clock could close it, and the app ` +
            `sent it ${verdict.served} real connection(s) while it was open`
          : verdict.served === 0
            ? `the app sent it nothing, and a window with no traffic in it runs to the ` +
              `${formatLifetime(rollbackWindowMs)} it is allowed`
            : verdict.gapMs === null
              ? `the app sent it ${verdict.served} real connection(s), not two of them to read a ` +
                `rate from, so the window ran to the ${formatLifetime(rollbackWindowMs)} it is allowed`
              : `${verdict.served} real connection(s) through it, one every ` +
                `${formatGapMs(verdict.gapMs)}, and at that rate the ${remaining} more a proof ` +
                `needs is ${formatGapMs(needed)}` +
                (decided >= rollbackWindowMs
                  ? `, longer than the ${formatLifetime(rollbackWindowMs)} this window is allowed`
                  : decided <= rollbackWindowMinMs
                    ? `, shorter than the ${formatLifetime(rollbackWindowMinMs)} a window is never ` +
                      "shorter than"
                    : "");
      log(
        `the replacement stayed healthy for ${formatLifetime(decided)} — ${why} — retiring the ` +
          `run it replaced at the end of the window${stillOnIt}`,
      );
    }
    await sleepImpl(frontDrainMs);
    await stopRun(serving);
    return {
      run: replacement,
      verdict: {
        ...common,
        at: settledAt,
        swappedAt,
        outcome: "replaced",
        closedBy,
        served: verdict.served,
        checks: verdict.checks,
        leftoverConnections,
      },
    };
  };

  /**
   * A reload, and the account of it: the record is written from the SAME verdict
   * the log was written from, so a line in the history cannot say something the
   * log did not, or miss a reload the log announced.
   *
   * The write is not awaited and not fatal — see `appendReloadRecord` — because
   * an audit trail is worth having and not worth failing over.
   */
  const reloadRun = async (serving, why) => {
    const { run, verdict } = await performReload(serving, why);
    if (reloadHistory) {
      appendReloadRecord(
        reloadHistory,
        reloadRecord({
          ...verdict,
          windowMs: rollbackWindowMs,
          proofConnections: rollbackProofConnections,
        }),
        { log },
      );
    }
    return run;
  };

  const onSignal = (signal) => () => stop(signal);
  const onSigint = onSignal("SIGINT");
  const onSigterm = onSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  // The conventional reload request, and the reason a reload needs no flag of its
  // own on a POSIX platform. Windows cannot deliver SIGHUP — Ctrl+C and Ctrl+Break
  // are its signals — so there the sentinel file is the only trigger.
  const onSighup = () => reloads.request("SIGHUP");
  const sighupWired = reloadWatcher !== null && process.platform !== "win32";
  if (sighupWired) process.on("SIGHUP", onSighup);
  // Last resort: if the supervisor itself is torn down, do not leave a server
  // holding the port with no one watching it.
  const onExit = () => {
    if (current && !current.isExited()) kill(current.child, { signal: "SIGKILL" });
  };
  process.on("exit", onExit);

  try {
    log(banner);
    if (frontPort !== null) {
      front = new FrontDoor({
      port: frontPort,
      host: frontHost,
      backend: probeHost,
      log,
      trafficSample: DEFAULTS.trafficSample,
    });
      try {
        await front.listen();
      } catch (error) {
        log(`could not take the port in front of the server: ${frontPort} — ${error?.message ?? error}`);
        log(`free the port, or run \`${plainHint}\`, which serves without a supervisor in front of it`);
        return 1;
      }
      log(
        `front door on ${frontHost}:${front.port} — a reload replaces the server behind it ` +
          "without this port ever closing",
      );
    }

    for (;;) {
      const startedAt = Date.now();
      budget.startRun(startedAt);
      // A run under a front door must not hold the public port, so it is given
      // one of its own; without a front door the port is the entry's business,
      // pinned or learned from the banner, exactly as it always was.
      const assignedPort = frontPort === null ? null : await reservePort({ host: probeHost });
      let { run } = beginRun(assignedPort);
      current = run;

      // The wait is for a verdict OR a reload, whichever comes first: a reload
      // only makes sense while a run is alive and serving, and a run that dies
      // while a reload is queued is still a crash to recover from.
      let result;
      for (;;) {
        const raced = await Promise.race([
          run.done.then((verdict) => ({ from: "run", verdict })),
          reloads.next().then((why) => ({ from: "reload", why })),
        ]);
        if (raced.from === "run") {
          result = raced.verdict;
          break;
        }
        const replacement = await reloadRun(run, raced.why);
        if (replacement !== run) {
          run = replacement;
          current = replacement;
        }
      }
      // This run is over, so nothing answers behind the door until the next one
      // is probed up: clearing the target means the gap is the front door's own
      // 503 rather than a connection piped at a port with nothing on it — and it
      // means the door can never end up pointing at whatever takes that port next.
      if (front) front.setTarget(null);
      if (stopping) {
        await Promise.race([run.gone, sleepImpl(exitGraceMs)]);
        return 0;
      }

      if (result.kind === "clean-exit") {
        log("the server exited cleanly — not restarting it");
        return result.code ?? 0;
      }

      if (result.kind === "no-restart") {
        log(`${result.why} — not restarting`);
        await stopRun(run);
        return 1;
      }

      if (result.kind === "spawn-error") {
        log(`could not start the server: ${result.error?.message ?? result.error}`);
        return 1;
      }

      const lasted = Date.now() - startedAt;
      budget.refresh(Date.now());
      const restartNumber = budget.used + 1;
      if (!budget.claim()) {
        log(
          `the server died ${budget.used} times in a row without staying up ` +
            `(last run: ${formatLifetime(lasted)}) — giving up; fix the cause, or run \`${plainHint}\``,
        );
        await stopRun(run);
        return 1;
      }

      if (result.kind === "pool-death") {
        log(`Turbopack's transform worker pool died: ${result.line.trim()}`);
        log(`${result.why}; a fresh process gets a healthy pool`);
      } else {
        log(`the server exited ${describeExit(result.code, result.signal)} after ${formatLifetime(lasted)}`);
      }

      await stopRun(run);

      const delay = backoffMs(restartNumber, { baseMs: backoffBaseMs, maxMs: backoffMaxMs });
      log(`restart ${restartNumber}/${budget.maxRestarts} in ${delay}ms`);
      await sleepImpl(delay);
    }
  } finally {
    reloadWatcher?.stop();
    if (sighupWired) process.off("SIGHUP", onSighup);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("exit", onExit);
    // The port goes back last: everything above stops talking to it first.
    await front?.close();
  }
}

/**
 * Stop a run, wait for it to be gone, escalating once — and then AUDIT what the
 * kill actually achieved rather than assuming it.
 *
 * The assumption is worth checking: a process-group SIGKILL can be ignored, a
 * tree can have lost a worker to adoption, and a worker that outlived the tree
 * still holds memory and — if it is the server — the port, with nobody watching
 * it. Each platform answers with the evidence it has, and neither answer costs a
 * subprocess that was not already being spawned:
 *
 *   POSIX    the subtree is read from the process table WHILE the root is still
 *            there (it is about to be removed, and a table stops pointing at a
 *            subtree the moment its parent is gone), and the same table read
 *            afterwards says what is left — /proc, so both reads are free;
 *   Windows  `taskkill /t /f` names every process it terminated and every one it
 *            could not, in the call the kill already makes.
 *
 * Where a platform cannot answer, the audit says nothing rather than inventing a
 * clean bill of health: a Linux table after a root that exited on its own has no
 * link left to follow (Windows would still name the creator, but its read costs
 * seconds, so it is not paid for that case alone).
 *
 * @param {{ child: object, gone: Promise<unknown>, isExited: () => boolean }} run
 * @param {{
 *   kill: (child: object, options?: object) => { killed?: boolean, reason?: string, terminated?: number[] | null, failed?: number[] | null },
 *   sleepImpl: (ms: number) => Promise<unknown>,
 *   graceMs: number,
 *   table?: (() => { pid: number, ppid: number, command: string }[]) | null,
 *   killPids?: (rows: { pid: number, command?: string }[]) => { killed?: number[], failed?: number[] },
 *   log?: (message: string) => void,
 * }} options
 */
export async function terminate(
  run,
  { kill, sleepImpl, graceMs, table = null, killPids: killPidsImpl = killPids, log = () => {} },
) {
  // Read the tree while it is still linked to its root, not after the kill.
  const before = table && !run.isExited() ? descendantsOf(table(), run.child.pid) : null;

  let result = { killed: false, reason: "already exited" };
  if (!run.isExited()) {
    result = kill(run.child);
    const gone = await Promise.race([run.gone.then(() => true), sleepImpl(graceMs).then(() => false)]);
    if (!gone) {
      result = { ...kill(run.child, { signal: "SIGKILL" }), escalated: true };
      await Promise.race([run.gone, sleepImpl(graceMs)]);
    }
  }

  // What the kill named, and what it admitted it could not end.
  const named = Array.isArray(result.terminated) ? result.terminated.map((pid) => ({ pid })) : null;
  const candidates = named ?? before;
  if (!candidates || candidates.length === 0) return result;

  const survivors = named
    ? (result.failed ?? []).map((pid) => ({ pid }))
    : stillAlive(candidates, table());
  if (survivors.length === 0) {
    log(`tree gone — ${candidates.length} process(es), no survivors`);
    return result;
  }

  log(
    `tree gone — ${candidates.length} process(es), but ${survivors.length} survived: ` +
      `${survivors.map(describeProcess).join(", ")} — killing them`,
  );
  const retry = killPidsImpl(survivors);
  const remaining = named
    ? survivors.filter((row) => (retry?.failed ?? []).includes(row.pid))
    : stillAlive(survivors, table());
  log(
    remaining.length === 0
      ? "the leftovers are gone"
      : `still alive after a force kill: ${remaining.map(describeProcess).join(", ")} — the port may still be held`,
  );
  return { ...result, survivors: remaining };
}

/** A knob value from the environment: a non-negative integer, or the fallback. */
export const envInt = (name, fallback) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
};
