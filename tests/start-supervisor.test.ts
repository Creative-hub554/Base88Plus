/**
 * The production supervisor (scripts/start.mjs).
 *
 * The MECHANISM is `supervise()` in scripts/supervise.mjs — one loop, two
 * policies, neither entry importing the other — and it is pinned in
 * tests/dev-supervisor.test.ts (with the split itself pinned in
 * tests/supervise-module.test.ts): the probe, the tree kill, the audit, the
 * backoff and the budget. What is pinned here is the POLICY that differs,
 * because that is the part production can get wrong on its own:
 *
 *   - a server that simply DIED is restarted, with no signature line to scan
 *     for (production has none) and no pages replayed (production has nothing
 *     to compile);
 *   - the ways a production server can be dead on arrival — a held port, no
 *     build — stop the loop and take the tree down instead of restarting into
 *     the same wall;
 *   - the dev pool-death signature is NOT one of them, and that is a safety
 *     property rather than an omission: a production log carries request lines,
 *     so a URL containing that phrase must not be able to make the supervisor
 *     kill and restart a healthy server;
 *   - the front door is on by default, which is what makes a reload possible at
 *     all, and `PROD_FRONT=0` gives the port back to the server. Both are
 *     pinned here: a reload really does start the replacement beside the server
 *     that is serving, point the port at it, and only then retire that server —
 *     and "the port never closed" is MEASURED, by a client that requests the
 *     port throughout the swap on a connection of its own and records every
 *     answer it gets, rather than asserted from the log.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The dev entry's own classifier, named here on purpose: the last case below is
// that production must NOT share its judgement about a line.
import { classifyLine } from '../scripts/dev.mjs';
import { classifyStartLine, START_NO_RESTART } from '../scripts/start.mjs';

describe('production supervisor — what a line means', () => {
  it('learns the port from the server banner, like the dev supervisor', () => {
    expect(classifyStartLine('- Local:         http://localhost:3401')).toEqual({
      kind: 'local-url',
      port: 3401,
    });
  });

  it('refuses to restart into a port somebody else holds', () => {
    // Node's own wording, which is what `next start` prints when it loses the race.
    expect(classifyStartLine('Error: listen EADDRINUSE: address already in use :::3401')).toEqual({
      kind: 'no-restart',
      why: START_NO_RESTART[0].why,
    });
  });

  it('refuses to restart a server that has no build to serve, and says what to run', () => {
    // Next's own sentence (measured from the installed next/dist), because the
    // classifier has to match the real message and not a tidied version of it.
    const output =
      "Error: Could not find a production build in the '.next' directory. " +
      "Try building your app with 'next build' before starting the production server.";
    expect(classifyStartLine(output)).toEqual({
      kind: 'no-restart',
      why: expect.stringMatching(/npm run build/),
    });
  });

  it('leaves a serving server alone, whatever it is printing', () => {
    // A request line, a page that threw, a dependency warning: all of them
    // describe a server that is still working.
    expect(classifyStartLine(' GET /settings/ 200 in 12ms (next.js: 9ms, application-code: 3ms)')).toBeNull();
    expect(classifyStartLine('Error: connect ECONNREFUSED 127.0.0.1:5432')).toBeNull();
  });

  it('does not read the dev pool-death signature as a reason to restart', () => {
    // The same line the dev supervisor restarts on, seen by both classifiers:
    // in development it means a dead Turbopack pool and only a restart can fix
    // it; in production the phrase can arrive inside a request URL, so treating
    // it as fatal would hand a stranger the kill switch.
    const line = 'Jest worker encountered 2 child process exceptions, exceeding retry limit';
    expect(classifyLine(line)).toMatchObject({ kind: 'pool-death' });
    expect(classifyStartLine(line)).toBeNull();
  });
});

const START_SCRIPT = join(process.cwd(), 'scripts', 'start.mjs');
const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'prod-death-server.mjs');

/**
 * Poll until the port answers with the status a person would be happy with. The
 * STATUS is the point once a front door is in the way: the port is the
 * supervisor's, it answers from the moment it holds it, and until a run is up
 * behind it that answer is a 503.
 */
async function waitForHttp(port: number, timeoutMs: number, status = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.status === status) return;
    } catch {
      // Not listening at all yet: the run is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`nothing answered ${status} on ${port} within ${timeoutMs}ms`);
}

/**
 * One HTTP/1.1 request on a connection of its own — the client this needs to be,
 * because a kept-alive connection is piped to whichever run was behind the door
 * when it was opened, and would therefore never exercise a swap at all.
 */
function pollOnce(port: number, path: string): Promise<{ status: number | null; error?: string }> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    let text = '';
    let settled = false;
    const finish = (result: { status: number | null; error?: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.on('connect', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      text += chunk.toString();
    });
    socket.on('error', (error: NodeJS.ErrnoException) => finish({ status: null, error: String(error?.code ?? error) }));
    socket.on('close', () => {
      const line = /^HTTP\/1\.1 (\d{3})/.exec(text);
      finish(line ? { status: Number(line[1]) } : { status: null, error: 'no status line' });
    });
  });
}

/**
 * A client that keeps asking, and remembers every answer. This is how "the port
 * never closed" is measured: a refused connection, or an answer that is not the
 * one the app gives, is in this list rather than argued about.
 */
function startPolling(port: number, path = '/poll') {
  const answers: { status: number | null; error?: string }[] = [];
  let running = true;
  const finished = (async () => {
    while (running) {
      answers.push(await pollOnce(port, path));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  return {
    answers,
    stop: async () => {
      running = false;
      await finished;
      return answers;
    },
  };
}

/** Wait until the supervisor's own log says something, rather than guessing how long it takes. */
async function waitForLog(
  session: { text: () => string },
  pattern: RegExp,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(session.text())) return session.text();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`the supervisor never said ${pattern}\n---\n${session.text()}`);
}

/**
 * The reload history, as a deploy pipeline reads it: one JSON object per line,
 * appended. Reading it back through JSON is the assertion — a file a pipeline
 * cannot parse is a file that does not exist.
 */
function readReloadHistory(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Wait for a line and say how long it took, because for the reload window the
 * timing IS half the claim: a window closed by the app's traffic and one closed
 * by the clock are told apart by when they closed, not only by what they logged.
 */
async function waitForLogTimed(
  session: { text: () => string },
  pattern: RegExp,
  timeoutMs = 20_000,
): Promise<{ text: string; ms: number }> {
  const startedAt = Date.now();
  const text = await waitForLog(session, pattern, timeoutMs);
  return { text, ms: Date.now() - startedAt };
}

/**
 * Wait until a port stops answering. Used after a reload commits: the run that was
 * kept warm is the way back, and the way back closing is a fact about the port.
 */
async function waitForSilence(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** The port a fixture run printed in its own banner — how a test reaches a run directly. */
function portOfRun(text: string, run: number): number {
  const match = new RegExp(`\\[fake\\] run ${run} listening on (\\d+)`).exec(text);
  return match ? Number(match[1]) : 0;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function runSupervisor(env: Record<string, string>, args: string[] = []) {
  const child = spawn(process.execPath, [START_SCRIPT, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // The supervisor runs the same code path as `npm start`; only the program
      // under it changes, so the test needs no production build.
      PROD_SERVER_CMD: `"${process.execPath}" "${FIXTURE}"`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    output += chunk.toString();
  });

  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  return { child, exited, text: () => output };
}

/** Never leave a supervisor (or its fixture) behind after a failed assertion. */
function reap(session: { child: { pid?: number; exitCode: number | null } }) {
  if (!session.child.pid || session.child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(session.child.pid), '/t', '/f'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-session.child.pid, 'SIGKILL');
  } catch {
    // Already gone between the check and the signal.
  }
}

describe('production supervisor — end to end', () => {
  it(
    'brings a server that died back, and replays nothing on the way',
    { timeout: 60_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-start-supervisor-'));
      const counter = join(dir, 'runs.txt');
      const requests = join(dir, 'requests.txt');
      const port = await freePort();
      const session = runSupervisor(
        {
          FAKE_COUNTER_FILE: counter,
          FAKE_REQUEST_LOG: requests,
          // Run 1 crashes with no line of any kind — the production failure mode.
          FAKE_EXIT_RUNS: '1',
          // Long enough that a person's request lands on run 1 well before it
          // crashes, even on a loaded machine.
          FAKE_EXIT_DELAY_MS: '1500',
          // Run 2 stays up long enough to be probed, and long enough for a
          // warm replay to have happened if this policy still did that.
          FAKE_STAY_MS: '5000',
          PROD_BACKOFF_MS: '20',
          PROD_BACKOFF_MAX_MS: '40',
        },
        // The public port, which by default belongs to the front door: the
        // fixture is told a port of its own, and a person still uses this one.
        ['--port', String(port)],
      );

      try {
        await waitForHttp(port, 20_000);
        // A page a person used, on the run that is about to crash.
        await fetch(`http://127.0.0.1:${port}/settings/`);
        const { code } = await session.exited;
        const output = session.text();
        const log = readFileSync(requests, 'utf8');

        // Two runs: the one that crashed and the one that replaced it.
        expect(readFileSync(counter, 'utf8')).toBe('2');
        expect(output).toMatch(/\[start\] supervising `next start`/);
        expect(output).toMatch(/\[start\] front door on 0\.0\.0\.0:\d+ — a reload replaces the server behind it/);
        expect(output).toMatch(/\[start\] the server exited with code 1 after \d+s/);
        expect(output).toMatch(/\[start\] restart 1\/5 in 20ms/);
        expect(output).toMatch(/\[start\] back up — http:\/\/127\.0\.0\.1:\d+ answered HTTP 200/);

        // The page was served on run 1 and never re-requested: the dev
        // supervisor replays what was in use, production has nothing to compile
        // and does not re-request a live server's pages. (The probe's own `/`
        // requests are marked and are not this.)
        expect(log).toMatch(/^1 \/settings\/$/m);
        expect(log).not.toMatch(/^2 \/settings\//m);
        expect(log).not.toMatch(/settings\/\?_warm=1/);

        // Run 2 ended cleanly by itself, and a clean exit is respected: this is
        // what makes `docker stop` and Ctrl+C do what they say.
        expect(code).toBe(0);
        expect(output).toMatch(/the server exited cleanly — not restarting it/);
      } finally {
        reap(session);
      }
    },
  );

  it(
    'stops on a startup error a restart cannot fix, and takes the tree with it',
    { timeout: 60_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-start-supervisor-'));
      const counter = join(dir, 'runs.txt');
      const port = await freePort();
      const session = runSupervisor({
        FAKE_COUNTER_FILE: counter,
        FAKE_PORT: String(port),
        // Without a front door the port belongs to the server, which is where
        // this one binds it and where the banner says it did.
        PROD_FRONT: '0',
        // Next's real sentence for a missing build, which the supervisor must
        // report instead of restarting into it five times.
        FAKE_FATAL_LINE:
          "Error: Could not find a production build in the '.next' directory. " +
          "Try building your app with 'next build' before starting the production server.",
      });

      try {
        const { code } = await session.exited;
        const output = session.text();

        expect(code).toBe(1);
        // One run only: the line was read as fatal, not as a crash to retry.
        expect(readFileSync(counter, 'utf8')).toBe('1');
        expect(output).toMatch(/there is no production build to serve — run `npm run build` — not restarting/);
        expect(output).not.toMatch(/restart 1\//);
        // The server was still serving when it was stopped, so the kill is one of
        // ours and is audited: the tree is gone and nothing survived. The COUNT
        // differs by platform (POSIX enumerates the subtree below the root,
        // Windows reads taskkill's report, which names the root as well), so the
        // verdict is the assertion and not the number.
        expect(output).toMatch(/\[start\] tree gone — \d+ process\(es\), no survivors/);
        expect(output).not.toMatch(/survived:|leftovers are gone|still alive after/);
      } finally {
        reap(session);
      }
    },
  );

  it(
    'still brings a server back without a front door, where the port belongs to the server',
    { timeout: 60_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-start-supervisor-'));
      const counter = join(dir, 'runs.txt');
      const port = await freePort();
      const session = runSupervisor({
        FAKE_COUNTER_FILE: counter,
        FAKE_PORT: String(port),
        PROD_FRONT: '0',
        // Named anyway, on purpose: without a front door there is nothing to
        // hand the port across, so it is reported and ignored rather than
        // leaving a sentinel that looks like it works.
        PROD_RELOAD_FILE: join(dir, 'reload'),
        FAKE_EXIT_RUNS: '1',
        FAKE_EXIT_DELAY_MS: '500',
        FAKE_STAY_MS: '3000',
        PROD_BACKOFF_MS: '20',
      });

      try {
        const { code } = await session.exited;
        const output = session.text();

        expect(readFileSync(counter, 'utf8')).toBe('2');
        expect(output).toMatch(/\[start\] the server exited with code 1 after \d+s/);
        // The restart was announced only on evidence: the port answered, and it
        // is the server's own port, not a supervisor's.
        expect(output).toMatch(/\[start\] back up — http:\/\/127\.0\.0\.1:\d+ answered HTTP 200/);
        expect(output).not.toMatch(/front door on/);
        expect(output).toMatch(/nothing can be reloaded without a front door — ignoring it/);
        expect(code).toBe(0);
      } finally {
        reap(session);
      }
    },
  );

  it(
    'replaces a running server without the port ever closing, and retires the one it replaced as soon as the app has proven the replacement',
    { timeout: 90_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-start-reload-'));
      const counter = join(dir, 'runs.txt');
      const requests = join(dir, 'requests.txt');
      const reloadFile = join(dir, 'reload');
      const history = join(dir, 'reloads.jsonl');
      const port = await freePort();
      const session = runSupervisor(
        {
          FAKE_COUNTER_FILE: counter,
          FAKE_REQUEST_LOG: requests,
          // Long enough that neither run exits on its own: the first is retired
          // by the reload, and the second is the one left serving.
          FAKE_STAY_MS: '12000',
          PROD_RELOAD_FILE: reloadFile,
          PROD_BACKOFF_MS: '20',
          PROD_RELOAD_HISTORY: history,
          // A ceiling far longer than this app needs, on purpose: what closes
          // this window is the traffic through the replacement, not this number.
          PROD_ROLLBACK_MS: '20000',
        },
        ['--port', String(port)],
      );

      try {
        await waitForHttp(port, 20_000);
        // From here on a client asks, over and over, on a connection of its own:
        // the app really is being used, which is the evidence this window reads.
        const poller = startPolling(port);
        await new Promise((resolve) => setTimeout(resolve, 250));
        writeFileSync(reloadFile, 'reload\n');

        // The switch is announced only once the replacement has answered, so
        // waiting for that line is waiting for the moment the port changed hands.
        await waitForLog(session, /keeping the run it replaced warm and answering/);
        // …and the retirement is announced when the APP has proven the
        // replacement, not when a clock has run out.
        const retired = await waitForLogTimed(session, /retiring the run it replaced early/);

        const answers = await poller.stop();
        const { code } = await session.exited;
        const output = session.text();
        const log = readFileSync(requests, 'utf8');

        // The window is 20s and it closed in about two: the replacement took real
        // connections from the app and stayed healthy through them, so there was
        // nothing left for the clock to discover. The floor is visible too — two
        // health checks, one interval each, so real traffic cannot retire the way
        // back inside the first second.
        expect(retired.ms).toBeLessThan(10_000);
        expect(retired.ms).toBeGreaterThan(1_000);
        expect(output).toMatch(
          /\[start\] the replacement has taken \d+ real connection\(s\) from the app and passed \d+ health check\(s\) — retiring the run it replaced early/,
        );
        // Two runs, and the port never stopped answering in between: every
        // request got the app's 200 — never a refused connection, never the
        // front door's 503 — across the whole swap.
        expect(readFileSync(counter, 'utf8')).toBe('2');
        expect(answers.length).toBeGreaterThan(10);
        expect(answers.filter((answer) => answer.status !== 200)).toEqual([]);
        // …and the answers came from BOTH runs, so it really was a replacement
        // rather than one server that happened to stay up.
        expect(log).toMatch(/^1 \/poll$/m);
        expect(log).toMatch(/^2 \/poll$/m);
        // The order is the feature: the replacement came up first, and the run it
        // replaced was retired after the port was already pointing at the new one.
        expect(output).toMatch(/\[start\] reload requested \(.*reload\) — starting a replacement beside the run that is serving/);
        expect(output).toMatch(/\[start\] back up — http:\/\/127\.0\.0\.1:\d+ answered HTTP 200/);
        // The window is announced as a range the app's traffic decides inside of,
        // not as a number the clock will use: this is the line an operator reads to
        // know what the reload is waiting for.
        expect(output).toMatch(
          /\[start\] the replacement is serving — keeping the run it replaced warm and answering for as long as the app's own traffic asks for: between 2s and 20s, since 3 real connection\(s\) through the replacement prove it and a window nothing arrives in runs to that ceiling/,
        );
        expect(output).toMatch(/\[start\] tree gone — \d+ process\(es\), no survivors/);
        expect(output).not.toMatch(/never came up|restart 1\/|at the end of the window/);

        // The same verdict, as a pipeline reads it: one line, the window closed
        // by the app's traffic, not rolled back, and the numbers the LOG reported
        // — the record and the log are one verdict, so they cannot disagree.
        const records = readReloadHistory(history);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          schema: 'base88.reload/1',
          // The sentinel file, which is what asked for it.
          asked: reloadFile,
          outcome: 'replaced',
          closedBy: 'traffic',
          rolledBack: false,
          windowMs: 20_000,
          proofConnections: 3,
          frontPort: port,
        });
        const said = /taken (\d+) real connection\(s\) from the app and passed (\d+) health check/.exec(
          output,
        );
        expect(said).not.toBeNull();
        expect(records[0].served).toBe(Number(said?.[1]));
        expect(records[0].checks).toBe(Number(said?.[2]));
        // A window that really was closed early, and three moments a reader can
        // put on a timeline.
        expect(Number(records[0].windowUsedMs)).toBeGreaterThan(1_000);
        expect(Number(records[0].windowUsedMs)).toBeLessThan(10_000);
        expect(Number.isNaN(Date.parse(String(records[0].startedAt)))).toBe(false);
        expect(Number.isNaN(Date.parse(String(records[0].swappedAt)))).toBe(false);
        expect(Number.isNaN(Date.parse(String(records[0].at)))).toBe(false);
        expect(records[0].detail).toBeNull();
        // One reload, one swap: the window does not start a second replacement.
        expect(readFileSync(counter, 'utf8')).toBe('2');
        // The second run ends by itself, and a clean exit is still respected.
        expect(code).toBe(0);
      } finally {
        reap(session);
      }
    },
  );

  it(
    'keeps the way back for the whole window when the app has not put enough traffic through the replacement',
    { timeout: 90_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-start-reload-'));
      const counter = join(dir, 'runs.txt');
      const requests = join(dir, 'requests.txt');
      const reloadFile = join(dir, 'reload');
      const history = join(dir, 'reloads.jsonl');
      const port = await freePort();
      const session = runSupervisor(
        {
          FAKE_COUNTER_FILE: counter,
          FAKE_REQUEST_LOG: requests,
          FAKE_STAY_MS: '12000',
          PROD_RELOAD_FILE: reloadFile,
          PROD_BACKOFF_MS: '20',
          PROD_RELOAD_HISTORY: history,
          PROD_ROLLBACK_MS: '4000',
        },
        ['--port', String(port)],
      );

      try {
        await waitForHttp(port, 20_000);
        writeFileSync(reloadFile, 'reload\n');
        await waitForLog(session, /keeping the run it replaced warm and answering/);

        // ONE real request through the door: not nothing — the app did use the
        // replacement — and not enough to stand for the app having tested it.
        // On a connection of its own, because a kept-alive one is piped to
        // whichever run it was piped to when it opened and would never reach the
        // replacement at all (which is why the door counts CONNECTIONS).
        expect((await pollOnce(port, '/one-real-request')).status).toBe(200);
        expect(readFileSync(requests, 'utf8')).toMatch(/^2 \/one-real-request$/m);

        // The run that was replaced is not gone: it is WARM — still listening on
        // the port of its own the front door used to point at, which is what makes
        // going back possible — measured by asking it directly, inside the window.
        const warmPort = portOfRun(session.text(), 1);
        expect(warmPort).toBeGreaterThan(0);
        expect((await fetch(`http://127.0.0.1:${warmPort}/still-warm`)).status).toBe(200);
        expect(readFileSync(requests, 'utf8')).toMatch(/^1 \/still-warm$/m);

        // The clock is what decides here, and it is the only thing that does.
        const retired = await waitForLogTimed(session, /retiring the run it replaced at the end of the window/);
        expect(retired.ms).toBeGreaterThan(2_500);
        // The way back closes with it: the port that answered a moment ago, inside
        // the window, is gone once the window is over.
        expect(await waitForSilence(warmPort, 5_000)).toBe(true);

        const { code } = await session.exited;
        const output = session.text();

        // One real connection is not two instants, so there is no rate to read and
        // the window is the ceiling — said in the line, with the number that proves
        // it (the connection itself).
        expect(output).toMatch(
          /\[start\] the replacement stayed healthy for 4s — the app sent it 1 real connection\(s\), not two of them to read a rate from, so the window ran to the 4s it is allowed — retiring the run it replaced at the end of the window/,
        );
        expect(output).toMatch(/\[start\] tree gone — \d+ process\(es\), no survivors/);
        expect(output).not.toMatch(/retiring the run it replaced early|has failed|restart 1\//);
        // The clock decided, and the record says so in the same word: the one
        // real request was not proof, and the numbers show the window it took.
        const records = readReloadHistory(history);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ outcome: 'replaced', closedBy: 'clock', rolledBack: false });
        expect(Number(records[0].served)).toBeGreaterThanOrEqual(1);
        expect(Number(records[0].windowUsedMs)).toBeGreaterThan(2_500);
        expect(readFileSync(counter, 'utf8')).toBe('2');
        expect(code).toBe(0);
      } finally {
        reap(session);
      }
    },
  );

  it(
    'waits out the window however much traffic arrives when early retirement is switched off',
    { timeout: 90_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-start-reload-'));
      const counter = join(dir, 'runs.txt');
      const reloadFile = join(dir, 'reload');
      const port = await freePort();
      const session = runSupervisor(
        {
          FAKE_COUNTER_FILE: counter,
          FAKE_STAY_MS: '12000',
          PROD_RELOAD_FILE: reloadFile,
          PROD_BACKOFF_MS: '20',
          PROD_ROLLBACK_MS: '4000',
          // The way back, timed rather than decided: no amount of traffic closes
          // this window early, which is what an operator asks for when a clock is
          // what they want to reason about.
          PROD_ROLLBACK_CONNECTIONS: '0',
        },
        ['--port', String(port)],
      );

      try {
        await waitForHttp(port, 20_000);
        const poller = startPolling(port, '/poll');
        await new Promise((resolve) => setTimeout(resolve, 250));
        writeFileSync(reloadFile, 'reload\n');
        await waitForLog(session, /keeping the run it replaced warm and answering for 4s/);
        const retired = await waitForLogTimed(session, /retiring the run it replaced at the end of the window/);
        const answers = await poller.stop();
        const { code } = await session.exited;
        const output = session.text();

        expect(retired.ms).toBeGreaterThan(2_500);
        expect(output).toMatch(
          /\[start\] the replacement stayed healthy for 4s — retiring early is switched off, so nothing but the clock could close it, and the app sent it \d+ real connection\(s\) while it was open — retiring the run it replaced at the end of the window/,
        );
        expect(output).not.toMatch(/retiring the run it replaced early/);
        // The traffic was real and continuous — the door answered every request
        // through it — and the window closed on the clock anyway.
        expect(answers.length).toBeGreaterThan(10);
        expect(answers.filter((answer) => answer.status !== 200)).toEqual([]);
        expect(readFileSync(counter, 'utf8')).toBe('2');
        expect(code).toBe(0);
      } finally {
        reap(session);
      }
    },
  );

  it(
    'sizes the window by the rate the app is using the replacement at, between its floor and its ceiling',
    { timeout: 90_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-start-rate-'));
      const counter = join(dir, 'runs.txt');
      const requests = join(dir, 'requests.txt');
      const reloadFile = join(dir, 'reload');
      const history = join(dir, 'reloads.jsonl');
      const port = await freePort();
      const session = runSupervisor(
        {
          FAKE_COUNTER_FILE: counter,
          FAKE_REQUEST_LOG: requests,
          FAKE_STAY_MS: '12000',
          PROD_RELOAD_FILE: reloadFile,
          PROD_BACKOFF_MS: '20',
          PROD_RELOAD_HISTORY: history,
          // A ceiling five times what this app's rate will ask for, so the window
          // that closes is provably the traffic's number and not this one.
          PROD_ROLLBACK_MS: '20000',
        },
        ['--port', String(port)],
      );

      try {
        await waitForHttp(port, 20_000);
        writeFileSync(reloadFile, 'reload\n');
        await waitForLog(session, /keeping the run it replaced warm and answering for as long as the app's own traffic asks for: between 2s and 20s/);

        // Two real connections, a couple of seconds apart: an app being used at a
        // trickle, which is a rate a window can be measured from — and one short of
        // the three connections that would prove the replacement outright.
        expect((await pollOnce(port, '/first')).status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        expect((await pollOnce(port, '/second')).status).toBe(200);
        expect(readFileSync(requests, 'utf8')).toMatch(/^2 \/first$/m);
        expect(readFileSync(requests, 'utf8')).toMatch(/^2 \/second$/m);

        // Nothing else is sent, and nothing needs to be: the window was decided
        // when the second connection arrived.
        const retired = await waitForLogTimed(session, /retiring the run it replaced at the end of the window/);
        const { code } = await session.exited;
        const output = session.text();

        expect(retired.ms).toBeGreaterThan(1_000);
        expect(output).toMatch(
          /\[start\] the replacement stayed healthy for \d+s — 2 real connection\(s\) through it, one every \d+(\.\d+)?(ms|s), and at that rate the 1 more a proof needs is \d+(\.\d+)?(ms|s) — retiring the run it replaced at the end of the window/,
        );
        expect(output).not.toMatch(/retiring the run it replaced early|has failed|restart 1\//);
        // The same verdict, and the two numbers a reader needs to see that the
        // window was the app's: the ceiling it was ALLOWED (20s) and the ~5s it
        // took — the last connection plus one more at the rate it was sent at.
        const records = readReloadHistory(history);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          outcome: 'replaced',
          closedBy: 'clock',
          rolledBack: false,
          served: 2,
          windowMs: 20_000,
        });
        expect(Number(records[0].windowUsedMs)).toBeGreaterThan(3_500);
        expect(Number(records[0].windowUsedMs)).toBeLessThan(9_000);
        expect(readFileSync(counter, 'utf8')).toBe('2');
        expect(code).toBe(0);
      } finally {
        reap(session);
      }
    },
  );

  it(
    'runs the window to its ceiling when the app has sent nothing through the replacement',
    { timeout: 90_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-start-quiet-'));
      const counter = join(dir, 'runs.txt');
      const reloadFile = join(dir, 'reload');
      const history = join(dir, 'reloads.jsonl');
      const port = await freePort();
      const session = runSupervisor(
        {
          FAKE_COUNTER_FILE: counter,
          // No FAKE_REQUEST_LOG connection happens after the swap: this window is
          // the quiet one, and a single request through the door would make it a
          // different case entirely.
          FAKE_STAY_MS: '12000',
          PROD_RELOAD_FILE: reloadFile,
          PROD_BACKOFF_MS: '20',
          PROD_RELOAD_HISTORY: history,
          PROD_ROLLBACK_MS: '8000',
        },
        ['--port', String(port)],
      );

      try {
        await waitForHttp(port, 20_000);
        writeFileSync(reloadFile, 'reload\n');
        // The swap line states the range, and the ceiling is the whole of it here.
        await waitForLog(session, /keeping the run it replaced warm and answering for as long as the app's own traffic asks for: between 2s and 8s/);
        const retired = await waitForLogTimed(session, /retiring the run it replaced at the end of the window/);
        const { code } = await session.exited;
        const output = session.text();

        // The clock ran the whole window, and the line says WHY it was that long:
        // not a rate anyone could read, but an absence of one.
        expect(retired.ms).toBeGreaterThan(6_000);
        expect(output).toMatch(
          /\[start\] the replacement stayed healthy for 8s — the app sent it nothing, and a window with no traffic in it runs to the 8s it is allowed — retiring the run it replaced at the end of the window/,
        );
        const records = readReloadHistory(history);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          outcome: 'replaced',
          closedBy: 'clock',
          rolledBack: false,
          served: 0,
          windowMs: 8_000,
        });
        expect(Number(records[0].windowUsedMs)).toBeGreaterThan(6_000);
        expect(readFileSync(counter, 'utf8')).toBe('2');
        expect(code).toBe(0);
      } finally {
        reap(session);
      }
    },
  );

  it(
    'never lets a burst of traffic close the window sooner than its floor',
    { timeout: 90_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-start-floor-'));
      const counter = join(dir, 'runs.txt');
      const requests = join(dir, 'requests.txt');
      const reloadFile = join(dir, 'reload');
      const history = join(dir, 'reloads.jsonl');
      const port = await freePort();
      const session = runSupervisor(
        {
          FAKE_COUNTER_FILE: counter,
          FAKE_REQUEST_LOG: requests,
          FAKE_STAY_MS: '12000',
          PROD_RELOAD_FILE: reloadFile,
          PROD_BACKOFF_MS: '20',
          PROD_RELOAD_HISTORY: history,
          PROD_ROLLBACK_MS: '20000',
        },
        ['--port', String(port)],
      );

      try {
        await waitForHttp(port, 20_000);
        writeFileSync(reloadFile, 'reload\n');
        await waitForLog(session, /keeping the run it replaced warm and answering for as long as the app's own traffic asks for/);

        // A burst: two connections a tenth of a second apart and then silence. The
        // rate would close the window a tenth of a second later; the floor is what
        // stops it, because the health checks a proof rests on have to be passable
        // before traffic can retire the way back.
        expect((await pollOnce(port, '/burst-1')).status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect((await pollOnce(port, '/burst-2')).status).toBe(200);

        const retired = await waitForLogTimed(session, /retiring the run it replaced at the end of the window/);
        const { code } = await session.exited;
        const output = session.text();

        expect(retired.ms).toBeGreaterThan(1_200);
        expect(retired.ms).toBeLessThan(5_000);
        expect(output).toMatch(
          /\[start\] the replacement stayed healthy for 2s — 2 real connection\(s\) through it, one every \d+(\.\d+)?(ms|s), and at that rate the 1 more a proof needs is \d+(\.\d+)?(ms|s), shorter than the 2s a window is never shorter than — retiring the run it replaced at the end of the window/,
        );
        const records = readReloadHistory(history);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          outcome: 'replaced',
          closedBy: 'clock',
          rolledBack: false,
          served: 2,
          windowMs: 20_000,
        });
        expect(Number(records[0].windowUsedMs)).toBeGreaterThan(1_200);
        expect(Number(records[0].windowUsedMs)).toBeLessThan(4_000);
        expect(readFileSync(counter, 'utf8')).toBe('2');
        expect(code).toBe(0);
      } finally {
        reap(session);
      }
    },
  );

  it(
    'rolls back to the run it replaced when the replacement starts answering server errors',
    { timeout: 90_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-start-rollback-'));
      const counter = join(dir, 'runs.txt');
      const requests = join(dir, 'requests.txt');
      const reloadFile = join(dir, 'reload');
      const history = join(dir, 'reloads.jsonl');
      const port = await freePort();
      const session = runSupervisor(
        {
          FAKE_COUNTER_FILE: counter,
          FAKE_REQUEST_LOG: requests,
          // Run 2 is the replacement: it answers the probe, so the reload DOES
          // swap it in, and then 300ms later every answer it gives is a 500.
          FAKE_SICK_RUNS: '2',
          FAKE_FAULT_AFTER_MS: '300',
          FAKE_STAY_MS: '12000',
          PROD_RELOAD_FILE: reloadFile,
          PROD_BACKOFF_MS: '20',
          PROD_RELOAD_HISTORY: history,
          PROD_ROLLBACK_MS: '8000',
        },
        ['--port', String(port)],
      );

      try {
        await waitForHttp(port, 20_000);
        const poller = startPolling(port, '/poll');
        await new Promise((resolve) => setTimeout(resolve, 250));
        writeFileSync(reloadFile, 'reload\n');

        // The bad replacement really does reach the door — a rollback that never
        // had anything to roll back from would be a test of nothing.
        await waitForLog(session, /the replacement is serving — keeping the run it replaced warm/);
        await waitForLog(session, /the replacement failed its health check/);
        // The rollback is complete once the replacement is out of the way.
        await waitForLog(session, /tree gone/);
        // The client is stopped BEFORE the last request below, so that request
        // is provably the last thing either run served.
        const answers = await poller.stop();
        // The app is up again, through the public port, answered by the run that
        // was there before the reload.
        await waitForHttp(port, 20_000);
        await fetch(`http://127.0.0.1:${port}/after-the-rollback`);
        const { code } = await session.exited;
        const output = session.text();
        const log = readFileSync(requests, 'utf8');
        const lines = log.trim().split('\n');
        const statuses = answers.map((answer) => answer.status);
        const lastBad = statuses.lastIndexOf(500);

        expect(output).toMatch(/\[fake\] run 2 went sick — every answer is a 500 from now on/);
        expect(output).toMatch(
          /\[start\] the replacement failed its health check \(it answered HTTP 500\) — rolling back: the front door is back to the run it replaced, and the replacement is stopped/,
        );
        expect(output).toMatch(/\[start\] tree gone — \d+ process\(es\), no survivors/);
        // The window never elapsed, so nothing was ever committed…
        expect(output).not.toMatch(/has stayed healthy for/);
        // …and a bad replacement is not a crash: no restart budget was spent,
        // and there is no second replacement.
        expect(output).not.toMatch(/restart 1\//);

        // A rolled-back reload, in the fields a pipeline can act on: the record
        // says it was rolled back, that a failed health check closed the window,
        // and why in its own words rather than only in the log's.
        const records = readReloadHistory(history);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          outcome: 'rolled-back',
          rolledBack: true,
          closedBy: 'check',
          detail: 'the replacement failed its health check (it answered HTTP 500)',
        });
        expect(Number(records[0].windowUsedMs)).toBeLessThan(8_000);
        expect(readFileSync(counter, 'utf8')).toBe('2');

        // MEASURED, request by request: the door never refused a connection and
        // never had nothing behind it (no 503) — the bad replacement served
        // errors for a while, and once it was rolled back every answer was the
        // restored server's 200 again.
        expect(answers.filter((answer) => answer.error)).toEqual([]);
        expect(statuses.filter((status) => status === 503)).toEqual([]);
        expect(lastBad).toBeGreaterThan(0);
        expect(statuses.slice(lastBad + 1).length).toBeGreaterThan(0);
        expect(statuses.slice(lastBad + 1).every((status) => status === 200)).toBe(true);

        // The last thing the app served was served by run 1 — the run the reload
        // had replaced — which is what "rolled back" means from the outside.
        expect(lines[lines.length - 1]).toBe('1 /after-the-rollback');
        expect(lines.filter((line) => line.startsWith('2 ')).length).toBeGreaterThan(0);
        // Run 1 ends by itself, and a clean exit is still respected.
        expect(code).toBe(0);
      } finally {
        reap(session);
      }
    },
  );

  it(
    'rolls back to the run it replaced when the replacement dies after the swap',
    { timeout: 90_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-start-rollback-'));
      const counter = join(dir, 'runs.txt');
      const requests = join(dir, 'requests.txt');
      const reloadFile = join(dir, 'reload');
      const history = join(dir, 'reloads.jsonl');
      const port = await freePort();
      const session = runSupervisor(
        {
          FAKE_COUNTER_FILE: counter,
          FAKE_REQUEST_LOG: requests,
          // Run 2 answers the probe — so the reload swaps it in — and is then
          // gone, taking its own worker with it. The way back is the only server
          // left, and the rollback is what keeps the app up.
          FAKE_DYING_RUNS: '2',
          FAKE_FAULT_AFTER_MS: '300',
          FAKE_STAY_MS: '12000',
          PROD_RELOAD_FILE: reloadFile,
          PROD_BACKOFF_MS: '20',
          PROD_RELOAD_HISTORY: history,
          PROD_ROLLBACK_MS: '8000',
        },
        ['--port', String(port)],
      );

      try {
        await waitForHttp(port, 20_000);
        writeFileSync(reloadFile, 'reload\n');
        await waitForLog(session, /the replacement exited after it answered/);
        await waitForHttp(port, 20_000);
        await fetch(`http://127.0.0.1:${port}/after-the-rollback`);
        const { code } = await session.exited;
        const output = session.text();
        const lines = readFileSync(requests, 'utf8').trim().split('\n');

        expect(output).toMatch(/\[fake\] run 2 died after coming up/);
        // An exit and a failed check are different verdicts, and the log says
        // which one happened: this replacement was gone, not erroring.
        expect(output).toMatch(
          /\[start\] the replacement exited after it answered — rolling back: the front door is back to the run it replaced, and the replacement is stopped/,
        );
        expect(output).not.toMatch(/has stayed healthy for|restart 1\//);
        // An exit and a failed check are different verdicts in the record too,
        // and this one was an exit.
        const records = readReloadHistory(history);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          outcome: 'rolled-back',
          rolledBack: true,
          closedBy: 'exit',
          detail: 'the replacement exited after it answered',
        });
        expect(readFileSync(counter, 'utf8')).toBe('2');
        expect(lines[lines.length - 1]).toBe('1 /after-the-rollback');
        expect(code).toBe(0);
      } finally {
        reap(session);
      }
    },
  );

  it(
    'keeps the replacement when the run it replaced is gone too, rather than pointing the port at nothing',
    { timeout: 90_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-start-rollback-'));
      const counter = join(dir, 'runs.txt');
      const port = await freePort();
      const reloadFile = join(dir, 'reload');
      const history = join(dir, 'reloads.jsonl');
      const session = runSupervisor(
        {
          FAKE_COUNTER_FILE: counter,
          // Run 2 is swapped in and goes sick, and run 1 — the way back — is
          // already gone by the time the first health check comes round. It is
          // the one case in which no rollback can be made, and the case a
          // careless implementation turns into a front door pointing at a dead
          // port; the replacement stays instead.
          FAKE_SICK_RUNS: '2',
          FAKE_FAULT_AFTER_MS: '300',
          FAKE_EXIT_RUNS: '1',
          FAKE_EXIT_DELAY_MS: '900',
          PROD_RELOAD_FILE: reloadFile,
          PROD_BACKOFF_MS: '20',
          PROD_RELOAD_HISTORY: history,
          PROD_ROLLBACK_MS: '8000',
        },
        ['--port', String(port)],
      );

      try {
        await waitForHttp(port, 20_000);
        writeFileSync(reloadFile, 'reload\n');
        await waitForLog(session, /there is nothing to fall back to/);
        const output = session.text();

        expect(output).toMatch(
          /\[start\] the replacement failed its health check \(it answered HTTP 500\), and the run it replaced is gone too — there is nothing to fall back to, so the replacement stays/,
        );
        // No rollback was claimed, and the port was not pointed at the run that
        // just died: what answers is still the replacement's own answer.
        expect(output).not.toMatch(/rolling back/);
        expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(500);

        // A record that does NOT say "rolled back": the reload could not be
        // undone, and the replacement is what stayed — a pipeline must be able
        // to tell that apart from a rollback it asked for.
        const records = readReloadHistory(history);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          outcome: 'no-fallback',
          rolledBack: false,
          closedBy: 'check',
          detail: 'the replacement failed its health check (it answered HTTP 500), and the run it replaced was gone',
        });
      } finally {
        reap(session);
      }
    },
  );

  it(
    'retires the run it replaced at the swap when the rollback window is off',
    { timeout: 90_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-start-reload-'));
      const counter = join(dir, 'runs.txt');
      const port = await freePort();
      const reloadFile = join(dir, 'reload');
      const session = runSupervisor(
        {
          FAKE_COUNTER_FILE: counter,
          FAKE_STAY_MS: '6000',
          PROD_RELOAD_FILE: reloadFile,
          PROD_BACKOFF_MS: '20',
          // The escape hatch: no window, so no second server alive behind the
          // first, and no way back once the swap has happened.
          PROD_ROLLBACK_MS: '0',
        },
        ['--port', String(port)],
      );

      try {
        await waitForHttp(port, 20_000);
        writeFileSync(reloadFile, 'reload\n');
        await waitForLog(session, /the replacement is serving/);
        const { code } = await session.exited;
        const output = session.text();

        expect(output).toMatch(/\[start\] the replacement is serving — retiring the run it replaced/);
        expect(output).toMatch(/\[start\] tree gone — \d+ process\(es\), no survivors/);
        expect(output).not.toMatch(/keeping the run it replaced warm|has stayed healthy for/);
        expect(readFileSync(counter, 'utf8')).toBe('2');
        expect(code).toBe(0);
      } finally {
        reap(session);
      }
    },
  );

  it(
    'leaves the run that is serving alone when a reload cannot produce a server',
    { timeout: 90_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-start-reload-'));
      const counter = join(dir, 'runs.txt');
      const requests = join(dir, 'requests.txt');
      const reloadFile = join(dir, 'reload');
      const history = join(dir, 'reloads.jsonl');
      const port = await freePort();
      const session = runSupervisor(
        {
          FAKE_COUNTER_FILE: counter,
          FAKE_REQUEST_LOG: requests,
          FAKE_STAY_MS: '6000',
          // Run 2 is the replacement: it never listens, then it is gone.
          FAKE_MUTE_RUNS: '2',
          FAKE_EXIT_DELAY_MS: '200',
          PROD_RELOAD_FILE: reloadFile,
          PROD_BACKOFF_MS: '20',
          PROD_RELOAD_HISTORY: history,
        },
        ['--port', String(port)],
      );

      try {
        await waitForHttp(port, 20_000);
        writeFileSync(reloadFile, 'reload\n');
        await waitForLog(session, /the replacement never came up/);

        // The server that was serving is STILL serving: this request after the
        // failed reload is answered by the original run.
        expect((await fetch(`http://127.0.0.1:${port}/settings/`)).status).toBe(200);
        const { code } = await session.exited;
        const output = session.text();
        const log = readFileSync(requests, 'utf8');

        expect(output).toMatch(/\[fake\] run 2 muted — never listening/);
        expect(output).toMatch(/\[start\] the replacement never came up \(.*\) — keeping the run that is already serving/);
        expect(log).toMatch(/^1 \/settings\/$/m);
        expect(log).not.toMatch(/^2 /m);
        // A failed reload is not a crash: no restart was spent on it, and the
        // run that was already up went on being the run.
        expect(output).not.toMatch(/restart 1\//);
        expect(output).not.toMatch(/tree gone/);

        // And it is a reload nothing changed, recorded as exactly that: no
        // window ever opened, so there is nothing to have closed and nothing to
        // measure — null rather than a zero that would read like a window.
        const records = readReloadHistory(history);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ outcome: 'kept', closedBy: null, rolledBack: false, swappedAt: null, windowUsedMs: null });
        expect(String(records[0].detail)).toMatch(/the replacement never came up/);
        expect(code).toBe(0);
      } finally {
        reap(session);
      }
    },
  );

  it(
    'answers 503 in the gap after a run dies, instead of refusing the connection',
    { timeout: 60_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-start-supervisor-'));
      const counter = join(dir, 'runs.txt');
      const port = await freePort();
      const session = runSupervisor(
        {
          FAKE_COUNTER_FILE: counter,
          FAKE_EXIT_RUNS: '1',
          FAKE_EXIT_DELAY_MS: '600',
          FAKE_STAY_MS: '4000',
          // A slow restart on purpose: the gap is what is under test, and a
          // 20ms backoff would usually be over before a client knocked.
          PROD_BACKOFF_MS: '1500',
          PROD_BACKOFF_MAX_MS: '1500',
        },
        ['--port', String(port)],
      );

      try {
        await waitForHttp(port, 20_000);
        const poller = startPolling(port, '/gap');
        // The moment the run is known to be gone, the port has nothing behind it.
        await waitForLog(session, /the server exited with code 1/);
        await new Promise((resolve) => setTimeout(resolve, 900));
        const answers = await poller.stop();
        const inGap = answers.filter((answer) => answer.status === 503);

        // An unplanned death cannot be made seamless — there was no second
        // server to hand over to — but it is still ANSWERED: not one attempt in
        // the gap got a refused or silently closed connection, and every one of
        // them was told to come back rather than left hanging.
        expect(answers.filter((answer) => answer.error)).toEqual([]);
        expect(inGap.length).toBeGreaterThan(0);

        // And the same port came back on its own, which is the other half of the
        // promise: the gap is a status, not the end of the port.
        await waitForHttp(port, 20_000);
        const { code } = await session.exited;
        const output = session.text();
        expect(output).toMatch(/\[start\] restart 1\/5 in 1500ms/);
        expect((output.match(/\[start\] back up — /g) ?? []).length).toBe(2);
        expect(readFileSync(counter, 'utf8')).toBe('2');
        expect(code).toBe(0);
      } finally {
        reap(session);
      }
    },
  );

  it(
    'reloads while the door has nothing behind it, instead of taking the door down with it',
    { timeout: 90_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-start-reload-'));
      const counter = join(dir, 'runs.txt');
      const reloadFile = join(dir, 'reload');
      const history = join(dir, 'reloads.jsonl');
      const port = await freePort();
      const session = runSupervisor(
        {
          FAKE_COUNTER_FILE: counter,
          // Run 1 never listens: the door holds the public port from its first
          // instant and nothing has answered behind it yet. A reload asked for
          // in THAT moment is the one case where the way back is not a port the
          // door is pointing at but the run in the reload's own hands — and the
          // run in its hands is the muted one. Run 2 is the replacement, and it
          // does come up.
          FAKE_MUTE_RUNS: '1',
          FAKE_EXIT_DELAY_MS: '30000',
          FAKE_STAY_MS: '4000',
          PROD_RELOAD_FILE: reloadFile,
          PROD_BACKOFF_MS: '20',
          PROD_RELOAD_HISTORY: history,
          // No window: the swap is taken as it lands, so what the reload DID is
          // read off its record rather than waited for.
          PROD_ROLLBACK_MS: '0',
        },
        ['--port', String(port)],
      );

      try {
        // The 503 IS the door with nothing behind it, and that is the state the
        // reload is asked for in.
        await waitForHttp(port, 20_000, 503);
        writeFileSync(reloadFile, 'reload\n');
        await waitForLog(session, /the replacement is serving/);

        // The replacement is answering through the door, so a client that knocks
        // after the swap is served rather than refused.
        expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);

        const { code } = await session.exited;
        const output = session.text();

        // The supervisor is STILL supervising, which is the whole claim: a reload
        // asked for while the door has no target used to end the process that
        // holds the port, and with it every client at the door.
        expect(output).not.toMatch(/is not a function/);
        expect(output).toMatch(/\[start\] reload requested \(.*reload\) — starting a replacement beside the run that is serving/);
        expect(output).toMatch(/\[start\] the replacement is serving — retiring the run it replaced/);
        expect(readFileSync(counter, 'utf8')).toBe('2');

        // Recorded as what it was: the door was pointing at nothing, so there is
        // no port it was pointing at to name — null, rather than a port nobody
        // ever reached.
        const records = readReloadHistory(history);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          previousPort: null,
          outcome: 'replaced',
          rolledBack: false,
          leftoverConnections: 0,
        });
        expect(records[0].replacementPort).toBeGreaterThan(0);
        expect(records[0].frontPort).toBe(port);
        expect(code).toBe(0);
      } finally {
        reap(session);
      }
    },
  );

  it(
    'refuses to start when the port in front is already taken, and starts no server at all',
    { timeout: 60_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-start-supervisor-'));
      const counter = join(dir, 'runs.txt');
      const port = await freePort();
      const holder = createServer();
      await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', () => resolve()));
      const session = runSupervisor(
        { FAKE_COUNTER_FILE: counter },
        ['--port', String(port), '--hostname', '127.0.0.1'],
      );

      try {
        const { code } = await session.exited;
        const output = session.text();

        expect(code).toBe(1);
        expect(output).toMatch(/\[start\] could not take the port in front of the server: \d+ — .*EADDRINUSE/);
        expect(output).toMatch(/npm run start:plain/);
        // Nothing was started: there was no port to serve on, and a server
        // behind a door that never opened is not a server.
        expect(() => readFileSync(counter, 'utf8')).toThrow();
      } finally {
        reap(session);
        await new Promise<void>((resolve) => holder.close(() => resolve()));
      }
    },
  );
});
