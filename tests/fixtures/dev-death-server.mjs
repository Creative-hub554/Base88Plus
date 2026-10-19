// Fake dev server for tests/dev-supervisor.test.ts.
//
// It reproduces the two things the supervisor has to survive, with nothing
// Turbopack-shaped about it:
//
//   1. on the runs named by FAKE_DEATH_RUNS it prints the pool-death line —
//      VERBATIM as this repo's own dev log carried it — and then keeps serving,
//      exactly like the real server that stayed up and answered every compiled
//      route while the uncompiled ones 500ed;
//   2. it binds a real TCP port and answers HTTP on it, so "the tree was killed
//      and a fresh server took the port" is observable: a second run that finds
//      the port still held fails to listen and says so, instead of quietly
//      sharing it with a zombie;
//   3. it has a WORKER of its own — a real child, the way the dev server has
//      `start-server` and transform workers — so the supervisor's kill audit has
//      a tree to enumerate and verify instead of a single pid;
//   4. it logs every request the way the dev server logs its own —
//      ` GET /settings/ 200 in 3ms (next.js: …)` — which is the line the
//      supervisor reads to learn which pages were in use, and records
//      `<run> <path>` per request so a test can tell the requests the person
//      made from the ones the supervisor replayed after the restart.
//
// Run number comes from a file, because each run IS a new process and only the
// file outlives it.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const counterFile = process.env.FAKE_COUNTER_FILE;
const deathRuns = Number.parseInt(process.env.FAKE_DEATH_RUNS ?? "1", 10);
const deathDelayMs = Number.parseInt(process.env.FAKE_DEATH_DELAY_MS ?? "100", 10);
const cleanExitMs = Number.parseInt(process.env.FAKE_CLEAN_EXIT_MS ?? "800", 10);
const port = Number.parseInt(process.env.FAKE_PORT ?? "0", 10);
const requestLog = process.env.FAKE_REQUEST_LOG;

/** The child this run will be killed with, spawned when the server comes up. */
let worker = null;

let run = 1;
if (counterFile) {
  run = existsSync(counterFile) ? Number.parseInt(readFileSync(counterFile, "utf8"), 10) + 1 : 1;
  writeFileSync(counterFile, String(run));
}

const server = createServer((req, res) => {
  if (requestLog) appendFileSync(requestLog, `${run} ${req.url}\n`);
  // The dev server's own request-log shape — the supervisor parses this to
  // learn which pages are in use.
  process.stdout.write(` GET ${req.url} 200 in 3ms (next.js: 1ms, application-code: 2ms)\n`);
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("fake\n");
});

server.on("error", (error) => {
  process.stderr.write(`[fake] could not listen: ${error.message}\n`);
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  const bound = server.address().port;
  // The tree the supervisor is expected to take down with it, spawned only once
  // there is a server to be killed: a run that fails to listen should not leave
  // a worker behind for the next test to trip over. Deliberately not reaped on
  // the way through a kill — that is what makes a survivor observable.
  worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  // The banner Next prints on startup — the supervisor learns the port from it.
  process.stdout.write(`- Local:         http://localhost:${bound}\n`);
  process.stdout.write(`[fake] run ${run} listening on ${bound}\n`);

  if (run <= deathRuns) {
    setTimeout(() => {
      process.stderr.write("Jest worker encountered 2 child process exceptions, exceeding retry limit\n");
      process.stdout.write("[fake] pool dead — still answering from cache\n");
    }, deathDelayMs);
    return;
  }

  process.stdout.write("[fake] healthy\n");
  setTimeout(() => {
    process.stdout.write("[fake] exiting cleanly\n");
    // A clean exit reaps its own children — the supervisor audits the kills it
    // performs, and this is not one of them. The port is released first so a
    // caller that watches the port sees the exit.
    server.close(() => {
      worker?.kill();
      process.exit(0);
    });
  }, cleanExitMs);
});
