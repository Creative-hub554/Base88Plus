// Fake production server for tests/start-supervisor.test.ts.
//
// The ways `next start` ends in production, with nothing Next-shaped about it:
//
//   1. a crash — the process exits, and NOTHING is printed first, which is the
//      whole point: unlike development, production has no signature line to
//      scan for, so the supervisor has to recover from the exit itself;
//   2. a fatal startup line (FAKE_FATAL_LINE) — the server is dead on arrival
//      and keeps running anyway, the way `next start` does when the port is
//      held or there is no build: the supervisor must recognise it, stop the
//      loop, and take the tree down rather than restart into the same wall.
//
// It binds a real TCP port and answers HTTP on it, prints Next's own banner
// shape so the supervisor can learn the port from it, logs requests the way the
// real server does (` GET /settings/ 200 in 3ms (next.js: …)`), and spawns a
// WORKER of its own, so the supervisor's kill audit has a tree to enumerate and
// verify instead of a single pid. (Measured: `next start` on this Next version
// serves in-process, so the real production tree is only the CLI — the fixture
// carries MORE than production does, which is the direction that makes a missed
// kill show up in an assertion.)
//
// Run number comes from a file, because each run IS a new process and only the
// file outlives it.
//
// Eight shapes it can be asked for, six of them about a run that is being
// REPLACED rather than one that crashed:
//
//   3. a run named in FAKE_MUTE_RUNS never listens at all and then exits. It is
//      what a reload that cannot produce a server looks like from the outside —
//      the replacement is real, it is just never there — and it is how the
//      supervisor's promise that the serving run is left alone is observable;
//   4. the port comes from `PORT` when the supervisor gives it one (behind a
//      front door the public port belongs to the supervisor, and each run is
//      told its own), and from FAKE_PORT otherwise;
//   5. a run named in FAKE_SICK_RUNS comes up HEALTHY — it answers the probe, so
//      a reload swaps it in — and then, FAKE_FAULT_AFTER_MS later, answers 500
//      to everything. That is a deploy that looked fine for one request and is
//      broken by the next, which is what a failing health check is made of;
//   6. a run named in FAKE_DYING_RUNS does the same with a harder ending: it
//      answers the probe, then exits (taking its own worker down first, so a
//      survivor is never the fixture's leak). A rollback has to cope with a
//      replacement that is not merely erroring but gone;
//   7. a run named in FAKE_LOSE_RUNS comes up healthy and STAYS healthy, and
//      costs exactly ONE client its answer: the Nth client request it is handed
//      (`FAKE_AFTER_CLIENTS`, the first one unless that says otherwise) is closed
//      with no reply at all. This is one of the two shapes that make the FRONT DOOR
//      miss its own promise — a client at the port change that does not come back
//      200 (shape 8 is the other one, and the opposite half of it) — while the run
//      itself is blameless, so the door is the only thing left to blame and the
//      soak's own loss count (`swapsAtTheDoor[].lost`) is non-zero. A normal soak
//      through this fixture never loses a client, so nothing else in it exercises
//      that count.
//
//      The requests that are never the ones counted are somebody else's: the
//      supervisor marks every request it makes for itself — the probe and the health
//      checks after it — with `_warm=1` (SELF_MARKER in scripts/supervise.mjs), and
//      the soak marks its own readiness probe with the same marker, so what this
//      counts is the app's traffic and nothing else. (A run that failed a health
//      check would be a run the supervisor rolls back off — a different finding
//      entirely.) The client lost is therefore always a client of the app's, and for
//      a REPLACEMENT that is also always a client of the SWAP: before the door points
//      at this run there is no such thing, because every client the door takes is
//      still piped to the run it is replacing. It is the first client this run is
//      handed — the one the swap is answerable for — and no clock takes part in it.
//
//      WHICH SWAP: the one the run was swapped in AT, since that is the swap that
//      hands it clients — so the run number picks the swap, and with a counter file
//      the runs are numbered in the order they were started (run 2 is the
//      replacement the first reload swaps in). The swap also has to be one that HAS
//      clients at the door for the loss to be read as its: a swap is judged over a
//      band around the instant the port changed hands, and on a phase with nothing
//      arriving in it the client this costs is not in that band. Measured, through
//      `npm run soak:supervisor -- --reloads 1 --phases trickle` with this knob on
//      the replacement: the door's mix shows the lost client (`"!no status line":1`)
//      and the run's own loss count stays 0 (`a client at 0 of them ... 0 lost`),
//      because the one connection the trickle sent arrived seconds after the swap.
//      On a busy swap the same knob lands a loss AT the swap: `lost: 1`, and the
//      door's finding names the reload it was lost at.
//
//   8. a run named in FAKE_STALL_RUNS comes up healthy and STAYS healthy and leaves
//      exactly ONE client's request standing: the Nth client request it is handed
//      (`FAKE_AFTER_CLIENTS`, the first one unless that says otherwise) is never
//      answered at all — no reply, no close, nothing written and nothing ending it —
//      and the socket is simply held. Where shape 7 costs a client AT the swap its
//      answer, this costs a client IN FLIGHT ACROSS it: the request is one already
//      piped to the run being RETIRED, and what ends it is the retirement. That is
//      the other half of the door's own claim, and the half the DRAIN is: the door
//      keeps piping the connection to the run it was piped to, and gives it the drain
//      to come back in, so a client this run never answered is a client cut off at the
//      end of the drain rather than one refused at the change.
//
//      WHICH RUN: the one a reload REPLACES, since that is the run being retired — run
//      1 is the run the first reload retires (and run 2 the replacement it swaps in,
//      see 7). Which CLIENT does not matter to the claim, only that the run it is
//      piped to is retired while it is still unanswered: a request this run took and
//      never answered is open across any swap that happens before it is stopped, so
//      the Nth client it is handed is as good as the first, and both are counted
//      rather than timed. Nothing in the fixture arms a clock against the request
//      afterwards, and Node's own request clock covers RECEIVING one, which this
//      request has already finished doing — so the stop is what ends it, and the
//      client's own patience (the soak's per-request timeout) is the only other
//      ending there is. Measured through the soak with the knob on the run the first
//      reload retires: `lost: 1` at that swap, `1 connection(s) in flight across the
//      change`, `a client in flight across the port change` as the door's finding,
//      and the run's own reload a plain `replaced`.
//
// The fault in 5 and 6 is timed from the LISTEN, not from the process starting,
// because those runs have to be healthy long enough to be swapped in, and what they
// are about is WHEN a run goes bad. A replacement that never came up at all is a
// different case, and a much easier one. 7 and 8 are counted instead of timed — the
// Nth CLIENT each is handed (`FAKE_AFTER_CLIENTS`) — because what those two are about
// is a client rather than an instant: a run behind the door is handed nothing until
// the door points at it, and a run being retired is handed clients until the moment
// it is retired, so the count is what makes the loss belong to a SWAP rather than to
// a moment an operator guessed at.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const counterFile = process.env.FAKE_COUNTER_FILE;
// FAKE_PORT first: it is what the tests that run WITHOUT a front door pin the
// public port with, and the supervisor sets PORT only when it is doing the
// pinning itself.
const port = Number.parseInt(process.env.FAKE_PORT ?? process.env.PORT ?? "0", 10);
// Run numbers that never listen — a replacement that comes up dead.
const muteRuns = new Set(
  (process.env.FAKE_MUTE_RUNS ?? "")
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value)),
);
const exitRuns = Number.parseInt(process.env.FAKE_EXIT_RUNS ?? "0", 10);
const exitDelayMs = Number.parseInt(process.env.FAKE_EXIT_DELAY_MS ?? "1500", 10);
const stayMs = Number.parseInt(process.env.FAKE_STAY_MS ?? "4000", 10);
// Runs that come up healthy and then fail: 500s, or gone. How long after the
// listen the fault lands — long enough that the probe (and therefore the swap)
// has already happened by then.
const runSet = (name) =>
  new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isInteger(value)),
  );
const sickRuns = runSet("FAKE_SICK_RUNS");
const dyingRuns = runSet("FAKE_DYING_RUNS");
// Runs that cost ONE client its answer: the Nth client request they are handed is
// closed with no reply.
const loseRuns = runSet("FAKE_LOSE_RUNS");
// Runs that leave ONE client's request standing: the Nth client request they are
// handed is never answered and never closed, so only stopping this process can end
// it (see shape 8 above).
const stallRuns = runSet("FAKE_STALL_RUNS");
// WHICH client those two shapes spend, counted among the clients this run is handed
// rather than timed from the listen — the first one unless told otherwise. The two
// shapes are the only thing this counts for: 5 and 6 go bad after a delay by
// definition, so they keep using `FAKE_FAULT_AFTER_MS`, and the count here starts at
// the first request the door pipes to this process (see `isSelfRequest` for what is
// not a client at all).
//
// And the count is the SAME PLACE the soak's account names, rather than a second
// ordering that happens to agree: the account reads a run's clients off the door's own
// accepts (`handed` in `swapProblems`, scripts/soak-supervisor.mjs), the door hands a
// client to the run it points at in the order it took it, and a request arrives at this
// process in that order — so "the Nth client this run was handed" is one reading with
// two ends. The handle that lets the two be checked against each other is the ordinal
// the client carries: the soak's traffic stamps the ordinal it handed a client over at
// onto the request itself (`_client=` on the path, see `asked` in
// scripts/soak-supervisor.mjs), this fixture never interprets it, and it reaches a
// log or a replay through `req.url` like any other query. The client either shape
// spends is also named in `FAKE_REQUEST_LOG` — `${run} ${req.url} (cost)` for the one
// shape 7 closes without a reply, `${run} ${req.url} (stalled)` for the one shape 8
// leaves standing — which is the line the same ordinal can be looked up in.
const afterClients = Math.max(1, Number.parseInt(process.env.FAKE_AFTER_CLIENTS ?? "1", 10) || 1);
const faultAfterMs = Number.parseInt(process.env.FAKE_FAULT_AFTER_MS ?? "300", 10);
const fatalLine = process.env.FAKE_FATAL_LINE;
const requestLog = process.env.FAKE_REQUEST_LOG;

/** The child this run is killed with, spawned when the server comes up. */
let worker = null;

/** Set once a sick run stops serving: every answer from then on is a 500. */
let sick = false;

/** How many clients this run has been handed — the count the two shapes act on. */
let clientsHanded = 0;

/** Whether it has spent that one client's answer already. */
let lostOneClient = false;

/** ...and whether it has left that one request standing already. */
let stalledOneClient = false;

/**
 * Whether a request is this tooling's own rather than a client's.
 *
 * The supervisor marks every request it makes for itself — the first probe and
 * the health checks after it — with `_warm=1` (SELF_MARKER in
 * scripts/supervise.mjs), and the soak marks its readiness probe with the same
 * marker: both are a tool asking whether the port ANSWERS rather than an app
 * answering a page somebody asked for. So this is that one marker, and what it
 * leaves is the app's own traffic — which is what the two loss shapes are about,
 * and why neither of them can be spent on a check.
 */
const isSelfRequest = (url) => /[?&]_warm=1(?:&|$)/.test(String(url ?? ""));

let run = 1;
if (counterFile) {
  run = existsSync(counterFile) ? Number.parseInt(readFileSync(counterFile, "utf8"), 10) + 1 : 1;
  writeFileSync(counterFile, String(run));
}

const server = createServer((req, res) => {
  // A CLIENT, and nothing else: the supervisor's probe and health checks, and the
  // soak's readiness probe, are not handed anything here — and are not counted, so
  // the two shapes below spend a client of the app's and never a check.
  const client = !isSelfRequest(req.url);
  if (client) clientsHanded += 1;
  const atTheNth = client && clientsHanded === afterClients;
  if (atTheNth && stallRuns.has(run) && !stalledOneClient) {
    // One client, and never a check: the run keeps passing every check made straight
    // at it, so it is never rolled back off — and what the client gets is nothing at
    // all. Nothing is written to it and nothing arms a clock against it, so the only
    // thing that can end this request is this process being stopped, which is exactly
    // what makes the loss the retirement's rather than the run's own ending. (The
    // access line is not printed either: this request never had an answer to log.)
    stalledOneClient = true;
    if (requestLog) appendFileSync(requestLog, `${run} ${req.url} (stalled)\n`);
    process.stdout.write(`[fake] run ${run} stalled a client — ${req.url} left with no answer\n`);
    return;
  }
  if (atTheNth && loseRuns.has(run) && !lostOneClient) {
    // One client, and only ever a client: the run keeps passing every check the
    // supervisor makes straight at it, so it is swapped in and kept, and the only
    // thing that went wrong is a client that did not come back.
    lostOneClient = true;
    // Named in the log, the way the standing shape's client is named when it is left
    // standing: the line is where the ordinal this client was handed over at (`_client=`
    // on `req.url`) can be found, and `(cost)` is what says this is the client it was.
    if (requestLog) appendFileSync(requestLog, `${run} ${req.url} (cost)\n`);
    process.stdout.write(`[fake] run ${run} cost a client its answer — ${req.url} closed with no reply\n`);
    req.socket.destroy();
    return;
  }
  const status = sick ? 500 : 200;
  if (requestLog) appendFileSync(requestLog, `${run} ${req.url}\n`);
  process.stdout.write(
    ` GET ${req.url} ${status} in 3ms (next.js: 1ms, application-code: 2ms)\n`,
  );
  res.writeHead(status, { "content-type": "text/plain" });
  res.end("fake\n");
});

server.on("error", (error) => {
  process.stderr.write(`[fake] could not listen: ${error.message}\n`);
  process.exit(1);
});

if (muteRuns.has(run)) {
  // Never listening, then gone: the probe behind the reload never gets an
  // answer, and the supervisor has to decide without one.
  process.stdout.write(`[fake] run ${run} muted — never listening\n`);
  setTimeout(() => process.exit(1), exitDelayMs);
} else {
  server.listen(port, "127.0.0.1", () => {
    const bound = server.address().port;
    // Spawned only once there is a server to be killed, so a run that fails to
    // listen leaves no worker behind for the next test to trip over.
    worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    // The banner Next prints on startup — the supervisor learns the port from it.
    process.stdout.write(`- Local:         http://localhost:${bound}\n`);
    process.stdout.write(`[fake] run ${run} listening on ${bound}\n`);

  if (fatalLine) {
    // Dead on arrival, and still serving: the supervisor has to kill this.
    process.stderr.write(`${fatalLine}\n`);
    return;
  }

  if (dyingRuns.has(run)) {
    setTimeout(() => {
      process.stdout.write(`[fake] run ${run} died after coming up\n`);
      worker?.kill();
      process.exit(1);
    }, faultAfterMs);
    return;
  }

  if (sickRuns.has(run)) {
    setTimeout(() => {
      sick = true;
      process.stdout.write(`[fake] run ${run} went sick — every answer is a 500 from now on\n`);
    }, faultAfterMs);
  }

  if (loseRuns.has(run)) {
    process.stdout.write(`[fake] run ${run} will cost client ${afterClients} it is handed its answer\n`);
  }

  if (stallRuns.has(run)) {
    process.stdout.write(`[fake] run ${run} will leave client ${afterClients} it is handed with no answer\n`);
  }

    if (run <= exitRuns) {
      setTimeout(() => {
        // A crash that takes its own tree with it: the supervisor audits the
        // kills IT performs, and this is not one of them, so a worker left
        // behind here would be the fixture's leak and not the supervisor's.
        worker?.kill();
        process.exit(1);
      }, exitDelayMs);
      return;
    }

    setTimeout(() => {
      process.stdout.write("[fake] exiting cleanly\n");
      server.close(() => {
        worker?.kill();
        process.exit(0);
      });
    }, stayMs);
  });
}
