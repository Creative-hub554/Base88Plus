/**
 * The soak (scripts/soak-supervisor.mjs).
 *
 * The helper tests pin what a leak verdict MEANS — what a history has to look
 * like, what each traffic phase is allowed to have done, what a supervisor's own
 * kill audit has to say — and the last case runs the whole thing, as a process,
 * against the production fixture: five reloads through all three traffic phases,
 * every leak check on, and a verdict a pipeline would branch on.
 *
 * The fixture rather than a real build, deliberately: a test suite cannot demand
 * that somebody ran `npm run build` first, and the checks themselves are about the
 * supervisor's behaviour, not Next's. The real-build soak is the same script,
 * run by hand — `npm run soak:supervisor`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { connect, createServer, type Socket } from 'node:net';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { FrontDoor, RELOAD_HISTORY_SCHEMA, reloadRecord } from '../scripts/supervise.mjs';
import {
  HELD_SHAPE,
  PAGERDUTY_EVENTS_URL,
  PAGERDUTY_ROUTING_KEY_ENV,
  SOAK_TREND_SCHEMA,
  SWAP_WATCH_SCHEMA,
  checkHistory,
  checkPortsFree,
  classifyLogLines,
  clientLogLines,
  deliverSwapAlert,
  describeAppLines,
  describeSpent,
  describeSwap,
  handleTrendProblems,
  heldConnectionProblems,
  holdConnection,
  leftoverCountInstant,
  nameSpent,
  parseArgs,
  phaseProblems,
  phaseTraffic,
  planPhases,
  probePort,
  startAppLogView,
  startHeldPool,
  startTraffic,
  supervisorLogProblems,
  swapAlertBody,
  swapAlertResolution,
  swapProblems,
  watchDeploy,
  watchedSwap,
} from '../scripts/soak-supervisor.mjs';

const SOAK_SCRIPT = join(process.cwd(), 'scripts', 'soak-supervisor.mjs');
const TREND_SCRIPT = join(process.cwd(), 'scripts', 'check-soak-trend.mjs');
const START_SCRIPT = join(process.cwd(), 'scripts', 'start.mjs');
const DIAGNOSE_SCRIPT = join(process.cwd(), 'scripts', 'soak-diagnose.mjs');
const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'prod-death-server.mjs');

/** Wait for something to become true, or say what never happened. */
async function until(ready: () => boolean | Promise<boolean>, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`waited ${ms}ms and ${what} never happened`);
}

/**
 * Stop a supervisor and everything it started.
 *
 * On Windows there is no signal a console process can be sent to make it clean
 * up, and the fixture each run spawns is a real child of its own, so the tree is
 * what has to go — the same `/t /f` the soak itself uses on the supervisor it
 * owns.
 */
function stopTree(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

/** A history line as the supervisor writes one, from the writer's own builder. */
function line(overrides: Record<string, unknown> = {}) {
  return JSON.stringify(
    reloadRecord({
      asked: 'C:\\tmp\\reload',
      outcome: 'replaced',
      closedBy: 'clock',
      startedAt: Date.parse('2026-10-14T00:00:00.000Z'),
      at: Date.parse('2026-10-14T00:00:06.000Z'),
      swappedAt: Date.parse('2026-10-14T00:00:00.500Z'),
      windowMs: 6000,
      proofConnections: 3,
      served: 0,
      checks: 2,
      replacementPort: 41001,
      previousPort: 41002,
      frontPort: 41000,
      ...overrides,
    }),
  );
}

const historyOf = (...lines: string[]) => `${lines.join('\n')}\n`;

/**
 * One client of the fixture, as it happens: the request the soak's own traffic asks
 * with (`Connection: close`), and what became of it — the status line, the ending that
 * came instead, or neither, which is the whole point of the shape that stalls.
 */
function clientOf(port: number, path: string) {
  const socket = connect(port, '127.0.0.1');
  let text = '';
  let answer: { status: number | null; error?: string } | null = null;
  let ended: string | null = null;
  const settle = (result: { status: number | null; error?: string }) => {
    answer ??= result;
  };
  socket.on('connect', () =>
    socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`),
  );
  socket.on('data', (chunk) => (text += chunk.toString()));
  socket.on('error', (error) => {
    ended ??= String((error as NodeJS.ErrnoException).code ?? error);
    settle({ status: null, error: ended });
  });
  socket.on('close', () => {
    ended ??= 'closed';
    const line = /^HTTP\/1\.1 (\d{3})/.exec(text);
    settle(line ? { status: Number(line[1]) } : { status: null, error: 'no status line' });
  });
  return {
    /** What it was answered once something was said or the socket ended — or null. */
    answered: () => answer,
    /** How the connection ended, once it has: the one thing a stalled request has not done. */
    ended: () => ended,
    close: () => socket.destroy(),
  };
}

/** Wait up to `ms` for a client to have been answered, and say nothing that came. */
async function untilAnswered(port: number, path: string, ms: number) {
  const client = clientOf(port, path);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && client.answered() === null) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { ...client, answer: client.answered() };
}

/** A port nothing holds, so a case below can bind one. */
async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('the schedule a soak runs', () => {
  it('cycles the phases, one per reload, and keeps the order asked for', () => {
    expect(planPhases(7)).toEqual(['busy', 'trickle', 'quiet', 'busy', 'trickle', 'quiet', 'busy']);
    expect(planPhases(4, ['quiet', 'busy'])).toEqual(['quiet', 'busy', 'quiet', 'busy']);
  });

  it('refuses a schedule it cannot run, before anything is started', () => {
    expect(() => planPhases(3, [])).toThrow(/at least one traffic phase/);
    expect(() => planPhases(3, ['busy', 'lively'])).toThrow(/unknown phase\(s\): lively/);
  });

  it('turns a phase into what the traffic driver needs', () => {
    expect(phaseTraffic('busy', { busyRate: 12 })).toMatchObject({ kind: 'rate', perSecond: 12 });
    expect(phaseTraffic('trickle', { trickleGapMs: 250 })).toMatchObject({ kind: 'gap', gapMs: 250 });
    expect(phaseTraffic('quiet')).toMatchObject({ kind: 'none' });
    expect(() => phaseTraffic('fast')).toThrow(/unknown phase/);
  });

  it('reads the command line as options, and says no to a bad one', () => {
    const options = parseArgs(['--reloads', '4', '--phases', 'busy,quiet', '--window-ms=3000', '--json']);
    expect(options).toMatchObject({ reloads: 4, phases: ['busy', 'quiet'], windowMs: 3000, json: true });
    expect(() => parseArgs(['--reloads', 'many'])).toThrow(/--reloads/);
    expect(() => parseArgs(['--reloads', '3', '--phases', 'quick'])).toThrow(/unknown phase/);
    expect(() => parseArgs(['--reloads', '0'])).toThrow(/at least one reload/);
    expect(() => parseArgs(['--nope'])).toThrow(/unknown option/);
    // The flag that used to keep the held connection alive is refused BY NAME, in both
    // modes: the connection is the unfinished head of a request, so no clock of a run's
    // ends it for being idle and there is nothing to re-arm. A caller whose script still
    // passes it hears what became of it rather than reading an unknown-option message as
    // a typo of its own.
    expect(() => parseArgs(['--reloads', '2', '--rearm-ms', '2000'])).toThrow(/--rearm-ms: nothing to re-arm/);
    expect(() => parseArgs(['--attach', '3000', '--history', 'x', '--rearm-ms', '2000'])).toThrow(/--rearm-ms: nothing to re-arm/);
  });
});

describe('the account a soak reads back', () => {
  const options = { expected: 2, windowMs: 6000, proof: 3, frontPort: 41000 };

  it('accepts two reloads that landed, with the fields the verdict rests on', () => {
    // A second reload a minute later, with its own window — the shape a file of
    // them has when the supervisor has been up for a while.
    const second = line({
      startedAt: Date.parse('2026-10-14T00:01:00.000Z'),
      swappedAt: Date.parse('2026-10-14T00:01:00.500Z'),
      at: Date.parse('2026-10-14T00:01:06.000Z'),
    });
    const { entries, problems } = checkHistory(historyOf(line(), second), options);
    expect(problems).toEqual([]);
    expect(entries).toHaveLength(2);
  });

  it('counts the reloads: one record per ask, no more and no fewer', () => {
    const { problems } = checkHistory(historyOf(line()), options);
    expect(problems.join('\n')).toMatch(/holds 1 record\(s\), not the 2 reloads/);
  });

  it('refuses a reload that did not land, because a soak has nothing to undo', () => {
    const rolledBack = line({ outcome: 'rolled-back', closedBy: 'check' });
    const { problems } = checkHistory(historyOf(rolledBack, line()), options);
    expect(problems.join('\n')).toMatch(/ROLLED BACK/);

    const unknown = historyOf(line({ outcome: 'splendid' }), line());
    expect(checkHistory(unknown, options).problems.join('\n')).toMatch(/not one this build knows/);
  });

  it('refuses a line it cannot read at all, so nothing is judged on a broken file', () => {
    const { problems } = checkHistory(historyOf(line(), '{"schema":"base88.reload/1","outcome":"replaced"}'), options);
    expect(problems.join('\n')).toMatch(/line 2 is unreadable: no readable at/);

    const foreign = checkHistory(historyOf(JSON.stringify({ schema: 'other/1', outcome: 'replaced', at: '2026-10-14T00:00:00.000Z' }), line()), options);
    expect(foreign.problems.join('\n')).toMatch(/schema "other\/1" is not base88\.reload\/1/);
  });

  it('refuses a window that ran past the ceiling it was given, out of order records, and missing evidence', () => {
    // The window is re-read every tick, so it may overshoot by one — by a second
    // and a half it is not a tick, it is a ceiling that was not respected.
    const t0 = Date.parse('2026-10-14T00:00:00.000Z');
    const overrun = checkHistory(
      historyOf(
        line({ startedAt: t0, swappedAt: t0 + 500, at: t0 + 8_500 }),
        line({ startedAt: t0 + 20_000, swappedAt: t0 + 20_500, at: t0 + 26_000 }),
      ),
      options,
    );
    expect(overrun.problems.join('\n')).toMatch(/window used 8000ms of a 6000ms ceiling/);

    const backwards = checkHistory(
      historyOf(line({ at: Date.parse('2026-10-14T00:00:20.000Z') }), line({ at: Date.parse('2026-10-14T00:00:10.000Z') })),
      options,
    );
    expect(backwards.problems.join('\n')).toMatch(/landed at .*, before the record above it/);

    const wrong = checkHistory(historyOf(line({ windowMs: 90_000, proofConnections: 1, frontPort: 40000, replacementPort: null }), line()), options);
    const said = wrong.problems.join('\n');
    expect(said).toMatch(/windowMs 90000 is not the 6000 the supervisor was given/);
    expect(said).toMatch(/proofConnections 1 is not the 3/);
    expect(said).toMatch(/frontPort 40000 is not the door's 41000/);
    expect(said).toMatch(/no usable replacementPort/);

    const unswapped = checkHistory(historyOf(line({ swappedAt: null }), line()), options);
    expect(unswapped.problems.join('\n')).toMatch(/no swappedAt, so no window was ever open/);
  });
});

describe('what each phase is allowed to have done', () => {
  const options = { windowMs: 6000, proof: 3 };
  const record = (closedBy: string, served: number, windowUsedMs = 6000) => ({
    record: { outcome: 'replaced', closedBy, served, windowUsedMs },
  });

  it('insists the app closes a busy window, and the clock closes the other two', () => {
    expect(phaseProblems([record('traffic', 44, 1222), record('clock', 2), record('clock', 0)], ['busy', 'trickle', 'quiet'], options)).toEqual([]);
  });

  it('calls a busy window the clock closed, and a quiet one traffic reached, findings', () => {
    // A busy window may be closed by the clock rather than by `traffic` — a slow
    // health check stretches it by its own duration, measured on the real build —
    // so what the phase is held to is that the app's connections reached the
    // replacement and that it stayed healthy through them. A failed check is not a
    // window at all, and neither is a window nobody used.
    expect(phaseProblems([record('clock', 4)], ['busy'], options)).toEqual([]);

    const failed = phaseProblems([record('check', 4, 1200)], ['busy'], options).join('\n');
    expect(failed).toMatch(/the replacement did not stay healthy under the app's traffic/);

    const starved = phaseProblems([record('clock', 1)], ['busy'], options).join('\n');
    expect(starved).toMatch(/only 1 connection\(s\) reached the replacement/);

    const broken = phaseProblems([record('traffic', 3)], ['quiet'], options).join('\n');
    expect(broken).toMatch(/a window nothing arrived in was closed by "traffic"/);
    expect(broken).toMatch(/3 connection\(s\) reached a window that was meant to have none/);

    const short = phaseProblems([record('clock', 0, 2000)], ['quiet'], options).join('\n');
    expect(short).toMatch(/closed at 2000ms, short of the 6000ms ceiling/);

    const proven = phaseProblems([record('traffic', 3)], ['trickle'], options).join('\n');
    expect(proven).toMatch(/a trickle read as proof/);
    expect(proven).toMatch(/3 connection\(s\) arrived on a 4000ms gap/);
  });
});

describe("the supervisor's own kill audit, read back", () => {
  const retired = 'retiring the run it replaced early (0 connection(s) still on it)\n[start] tree gone — 2 process(es), no survivors\n';

  it('passes a stop the supervisor audited', () => {
    expect(supervisorLogProblems(retired.repeat(3), { retirements: 3 })).toEqual([]);
  });

  it('reports a survivor, a force kill that did not finish the job, and a lost record', () => {
    const survived = supervisorLogProblems(`${retired}[start] tree gone — 2 process(es), but 1 survived: 41 (node)\n`, {
      retirements: 2,
    }).join('\n');
    expect(survived).toMatch(/but 1 survived: 41 \(node\)/);
    // Two retirements, one audited line: the second stop is unaccounted for.
    expect(survived).toMatch(/1 audited tree kill\(s\) for 2 retirement\(s\)/);

    const stranded = supervisorLogProblems(`${retired}[start] still alive after a force kill: 41 (node) — the port may still be held\n`, {
      retirements: 1,
    }).join('\n');
    expect(stranded).toMatch(/a process outlived the kill/);
    expect(stranded).toMatch(/may still be holding a port/);

    const unwritten = supervisorLogProblems(`${retired}[start] the reload happened, but its record could not be written to /x (EACCES)\n`, {
      retirements: 1,
    }).join('\n');
    expect(unwritten).toMatch(/the history lost a record/);
  });
});

describe('descriptors that must not creep up', () => {
  const series = (...values: number[]) => new Map([['busy', values]]);

  it('passes a floor that stays where it was, however much single readings churn', () => {
    // Measured shape of a clean supervisor: a retirement's own sockets and pipes
    // come and go, so readings swing by a dozen — which is exactly why the check
    // reads a floor rather than a reading.
    const churn = series(278, 291, 277, 291, 278, 291, 277, 278);
    expect(handleTrendProblems(churn, { slack: 8 }).problems).toEqual([]);
  });

  it('catches a floor that rose, and says what the series was', () => {
    const leaked = handleTrendProblems(series(280, 281, 282, 283, 290, 293, 296, 298), { slack: 8 });
    expect(leaked.problems.join('\n')).toMatch(/lowest descriptor count rose from 280 to 290/);
    expect(leaked.problems.join('\n')).toMatch(/series: 280, 281, 282, 283, 290, 293, 296, 298/);
  });

  it('judges each phase against itself, and refuses to judge too few reloads', () => {
    const readings = new Map([
      ['busy', [400, 401, 402, 403, 420, 421, 422, 424]],
      ['quiet', [280, 281, 280, 281]],
      ['trickle', [300, 300]],
    ]);
    const verdict = handleTrendProblems(readings, { slack: 8 });
    // Each phase is compared against its own first half, never against another
    // phase's — the busy one rose, the quiet one did not — and a phase with too
    // few reloads to have a floor says so instead of being judged.
    expect(verdict.judged).toEqual(['busy 400→420', 'quiet 280→280']);
    expect(verdict.skipped).toEqual(['trickle (2 reading(s))']);
    expect(verdict.problems).toHaveLength(1);
    expect(verdict.problems[0]).toMatch(/the busy phase/);
  });
});

describe('a port that should be free', () => {
  it('is free only when it can be bound — which is the leak check itself', async () => {
    const held = createServer();
    await new Promise<void>((resolve) => held.listen(0, '127.0.0.1', () => resolve()));
    const { port } = held.address() as { port: number };

    expect(await probePort(port)).toBe(false);
    expect((await checkPortsFree([port], { waitMs: 200 })).held).toEqual([port]);

    await new Promise<void>((resolve) => held.close(() => resolve()));
    expect(await probePort(port)).toBe(true);
    expect((await checkPortsFree([port], { waitMs: 200 })).free).toEqual([port]);
  });
});

describe('what the front door owes a client at the swap', () => {
  const swap = { index: 2, phase: 'busy', at: 1_200 };
  /** One answer through the door, as the traffic driver times one. */
  const answer = (overrides: Record<string, unknown> = {}) => ({
    phase: 'busy',
    startedAt: 1_000,
    connectedAt: 1_005,
    finishedAt: 1_400,
    status: 200,
    error: null,
    ...overrides,
  });

  it('passes a swap every client came through with an answer, and counts them', () => {
    const answers = [
      answer({ startedAt: 600, connectedAt: 605, finishedAt: 900 }), // before
      answer({ startedAt: 1_100, connectedAt: 1_105, finishedAt: 1_600 }), // in flight across it
      answer({ startedAt: 1_250, connectedAt: 1_255, finishedAt: 1_500 }), // after
      answer({ startedAt: 2_500, connectedAt: 2_505, finishedAt: 2_700 }), // nowhere near
    ];
    const { problems, evidence } = swapProblems(answers, [swap]);
    expect(problems).toEqual([]);
    expect(evidence).toEqual([{ index: 2, phase: 'busy', at: 1_200, band: 3, inFlight: 1, lost: 0, spent: [] }]);
  });

  it('fails a client that was in flight across the change and did not come back', () => {
    const answers = [answer({ startedAt: 1_100, connectedAt: 1_105, finishedAt: 1_900, status: 503 })];
    const problems = swapProblems(answers, [swap]).problems.join('\n');
    expect(problems).toMatch(/reload 2 \(busy\): a client in flight across the port change was answered 503/);
    expect(problems).toMatch(/a swap may not cost a client its answer/);
  });

  it('names WHICH client a swap spent, of the clients at the door and of the run it handed them to', () => {
    // Two swaps, because a RUN's tenure is read between them: the swap that hands a run the
    // port is where its clients start and the swap after it is where they stop, so a caller
    // that names only one of them cannot say which client of a run a loss was (the case
    // below). The swap judged here is the first, and the run it is answerable for is the one
    // it RETIRED: every client the door took before the port changed hands was piped there,
    // and the client lost is one of them.
    const swaps = [
      { index: 1, phase: 'busy', at: 1_200, handedAt: null, previousPort: 4_000, replacementPort: 4_001 },
      { index: 2, phase: 'trickle', at: 5_000, handedAt: 1_200, previousPort: 4_001, replacementPort: 4_002 },
    ];
    const answers = [
      answer({ startedAt: 600, connectedAt: 605, finishedAt: 900 }), // the retired run's, answered
      answer({ startedAt: 1_100, connectedAt: 1_105, finishedAt: 1_400, status: 503, opened: 2 }), // in flight: lost
      answer({ startedAt: 1_250, connectedAt: 1_255, finishedAt: 1_500, opened: 3 }), // the replacement's first
    ];

    const { problems, evidence } = swapProblems(answers, swaps);
    // Two denominators, and neither is derived from the other: the lost client was the 2nd
    // of the 3 the swap had AT THE DOOR (the set a loss is a rate of, banded around the
    // instant), and the 2nd of the 2 that run was HANDED (the set the failure is usually
    // about — the client before it in the same tenure is the one that was served).
    expect(evidence[0].lost).toBe(1);
    expect(evidence[0].spent).toEqual([
      {
        // WHICH client, by the one handle both sides of a loss carry: the ordinal it was handed
        // to the door at, which is also the number the client asks with (`_client=`).
        client: 2,
        acceptedAt: new Date(1_105).toISOString(),
        atTheDoor: { nth: 2, of: 3 },
        handed: { side: 'retired', port: 4_000, nth: 2, of: 2 },
      },
    ]);
    // The finding says which client it was, in the same breath as what happened to it — a
    // count and the sentence for it are then about the same client rather than about a
    // number and an explanation that could belong to any client of the swap.
    expect(problems).toEqual([
      expect.stringMatching(
        /^reload 1 \(busy\): a client in flight across the port change was answered 503 — the 2nd of the 3 client\(s\) the swap had at the door — the 2nd of the 2 client\(s\) the run this swap retired \(port 4000\) was handed — the front door holds the port and never closes it, so a swap may not cost a client its answer$/,
      ),
    ]);
    // A swap that cost nothing says nothing about which client it cost: the empty list it
    // has, rather than a clause about a zero.
    expect(evidence[1]).toMatchObject({ lost: 0, spent: [] });
  });

  it('says where a loss was in the SWAP alone when the caller names one swap and no tenure', () => {
    // A watch judges one swap as it lands and holds no line of them, which is the line a
    // tenure is read between — so the run's side of a loss is NOT readable from it, and the
    // reading it does have is the one set a single swap can be asked about on its own. This
    // is a deliberate absence rather than a count of whatever window the caller held.
    const one = swapProblems(
      [answer({ startedAt: 1_100, connectedAt: 1_105, finishedAt: 1_400, status: 503 })],
      [swap],
    ).evidence[0];
    expect(one.spent[0].handed).toBeNull();
    // ...and an account whose clients were not the traffic driver's carries no ordinal for them
    // either, which is the same absence rather than a zero that would read as a place.
    expect(one.spent[0].client).toBeNull();
    expect(describeSpent(one.spent[0])).toBe('the 1st of the 1 client(s) the swap had at the door');
    // And a loss the account cannot place at all is SAID rather than left as a silence that
    // reads like a swap that cost nothing.
    expect(describeSpent({ atTheDoor: null, handed: null })).toBe('a client the account names no place for');
  });

  it('reads a client’s place off the door’s accept instants, not off the order its answer came back', () => {
    // The traffic driver records an answer when its socket ENDS, so the array is in the order the
    // answers SETTLED in. Here that is the reverse of the order the door took the clients: the
    // FIRST client the door accepted is the last one whose page comes back, and a reader that
    // counted the array would name the third client for the loss the door is answerable for.
    const settled = [
      answer({ startedAt: 1_300, connectedAt: 1_310, finishedAt: 1_320 }), // accepted 3rd, back first
      answer({ startedAt: 1_100, connectedAt: 1_110, finishedAt: 2_000, status: 503 }), // accepted 1st, back 2nd: LOST
      answer({ startedAt: 1_200, connectedAt: 1_205, finishedAt: 2_100 }), // accepted 2nd, back last
    ];
    const { problems, evidence } = swapProblems(settled, [swap]);

    expect(evidence[0].lost).toBe(1);
    expect(evidence[0].spent[0].acceptedAt).toBe(new Date(1_110).toISOString());
    expect(evidence[0].spent[0].atTheDoor).toEqual({ nth: 1, of: 3 });
    expect(problems[0]).toMatch(/the 1st of the 3 client\(s\) the swap had at the door/);
  });

  it('separates clients the door accepted in the SAME instant by the order it was handed them', () => {
    // A burst: every client of this swap is accepted in the same millisecond, so the instants
    // cannot separate them and the array's order — the order the answers settled, here the
    // reverse of the order the clients were handed over — is all a reader would otherwise have.
    // `opened` is the ordinal the traffic driver stamps a client with as it hands it to the door,
    // and the loss is named by THAT: the first client the door was handed, whose page is the last
    // to come back.
    const burst = [
      answer({ startedAt: 1_100, connectedAt: 1_150, finishedAt: 1_160, opened: 3 }),
      answer({ startedAt: 1_100, connectedAt: 1_150, finishedAt: 1_170, opened: 2 }),
      answer({ startedAt: 1_100, connectedAt: 1_150, finishedAt: 1_900, status: 503, opened: 1 }),
    ];
    const { evidence } = swapProblems(burst, [swap]);
    expect(evidence[0].band).toBe(3);
    expect(evidence[0].spent[0].atTheDoor).toEqual({ nth: 1, of: 3 });
    // ...and the client it names is the one the door was handed first, by the ordinal it was
    // handed over at rather than by where it came in this array.
    expect(evidence[0].spent[0].client).toBe(1);

    // Without the ordinal the same three answers are named in the order they settled, which is a
    // different client — so this is a real distinction rather than a field nothing reads.
    const unnumbered = burst.map((entry) => ({ ...entry, opened: undefined }));
    expect(swapProblems(unnumbered, [swap]).evidence[0].spent[0].atTheDoor).toEqual({ nth: 3, of: 3 });
    expect(swapProblems(unnumbered, [swap]).evidence[0].spent[0].client).toBeNull();
  });

  it('names the clients of a real burst in the order the door was handed them', async () => {
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok\n');
    });
    const port = await freePort();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
    // A burst rather than a trickle: a batch of connections opened in one tick, so several
    // clients are in flight together and their pages come back in whatever order the answers
    // settle — the traffic that shares an accept instant and completes out of order.
    const driver = startTraffic(port, { busyRate: 200, maxInFlight: 12, requestTimeoutMs: 2_000 });
    driver.setPhase('busy');
    await until(() => driver.stats.requests >= 12, 10_000, 'a burst of clients went through the door');
    const stats = await driver.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // The burst was one: clients whose connections were open at the same time, which a run that
    // asked for one page at a time could not have produced.
    expect(stats.answers.length).toBeGreaterThanOrEqual(12);
    expect(
      stats.answers.some((entry) =>
        stats.answers.some(
          (other) => Number(other.opened) > Number(entry.opened) && Number(other.connectedAt) <= entry.finishedAt,
        ),
      ),
    ).toBe(true);
    // Every client carries an ordinal of its own, and the ordinals are exactly the clients the
    // driver handed over, once each.
    expect(stats.answers.map((entry) => Number(entry.opened)).sort((a, b) => a - b)).toEqual(
      Array.from({ length: stats.requests }, (_, index) => index + 1),
    );
    // ...and an ordinal is assigned when the connection is ESTABLISHED, which is the instant the
    // door's queue received it and therefore the order it accepts them in: the ordinals run in
    // the order the door took the clients, not in the order the requests were FIRED (the two are
    // different, and only the first is what a place in the account is read from).
    expect(stats.answers.every((entry) => Number.isFinite(entry.opened))).toBe(true);
    const handedInOrder = [...stats.answers].sort((one, other) => Number(one.opened) - Number(other.opened));
    expect(handedInOrder.map((entry) => entry.connectedAt)).toEqual(
      handedInOrder.map((entry) => entry.connectedAt).sort((a, b) => Number(a) - Number(b)),
    );

    // Read as if every client of the run had been lost, because that is what puts one place per
    // client in the account — and then the account's order has to be the door's: the instant each
    // client was accepted, the ordinal it was handed over at for the ones that share an instant,
    // and never the order the answers came back in.
    const all = stats.answers.map((entry) => ({ ...entry, status: 503 }));
    const { evidence } = swapProblems(all, [{ index: 1, phase: 'busy', at: Date.now(), handedAt: null }], { bandMs: 60_000 });
    const door = [...stats.answers].sort(
      (one, other) => Number(one.connectedAt) - Number(other.connectedAt) || Number(one.opened) - Number(other.opened),
    );
    expect(evidence[0].lost).toBe(door.length);
    expect(evidence[0].spent.map((entry) => entry.acceptedAt)).toEqual(
      door.map((entry) => new Date(Number(entry.connectedAt)).toISOString()),
    );
    expect(evidence[0].spent.map((entry) => entry.atTheDoor.nth)).toEqual(door.map((_, index) => index + 1));
    // The client each place is a place OF is carried with it, in that same order — so a loss can
    // be looked up by the ordinal the run it was handed to saw it under.
    expect(evidence[0].spent.map((entry) => entry.client)).toEqual(door.map((entry) => entry.opened));
    // The door's own clock never goes backwards along that order, however the answers came back.
    const times = evidence[0].spent.map((entry) => Date.parse(entry.acceptedAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('fails a refusal at the change, a hang, and a refusal anywhere else', () => {
    const refused = swapProblems(
      [answer({ startedAt: 1_000, connectedAt: null, finishedAt: 1_000, status: null, error: 'ECONNREFUSED' })],
      [swap],
    ).problems.join('\n');
    expect(refused).toMatch(/at the port change was refused \(ECONNREFUSED\)/);
    expect(refused).toMatch(/the front door holds the port and never closes it/);
    // Said once, and said as the swap's: the sweep for refusals is for the ones the
    // swaps have not already spoken for.
    expect(refused.match(/ECONNREFUSED/g)).toHaveLength(1);

    const hung = swapProblems(
      [answer({ startedAt: 1_150, connectedAt: 1_155, finishedAt: 9_000, status: null, error: 'timeout' })],
      [swap],
    ).problems.join('\n');
    expect(hung).toMatch(/in flight across the port change was never answered \(the door took the connection and hung\)/);

    const elsewhere = swapProblems(
      [answer({ startedAt: 40_000, connectedAt: null, finishedAt: 40_100, status: null, error: 'ECONNRESET' })],
      [swap],
    ).problems.join('\n');
    expect(elsewhere).toMatch(/the front door was refused \(ECONNRESET\) — the port belongs to the door for the whole soak/);
  });

  it('refuses to pass a phase that had no client at the swap at all', () => {
    // The claim is about the clients AT a swap, so a busy reload with none had
    // nothing tested — which has to read as "not exercised", never as a clean bill.
    const busy = swapProblems([answer({ startedAt: 9_000, connectedAt: 9_000, finishedAt: 9_100 })], [swap]).problems.join('\n');
    expect(busy).toMatch(/no client had a connection open within 500ms of the port changing hands/);

    const quiet = swapProblems([answer({ startedAt: 9_000, connectedAt: 9_000, finishedAt: 9_100 })], [
      { index: 3, phase: 'quiet', at: 1_200 },
    ]);
    expect(quiet.problems).toEqual([]);
    expect(quiet.evidence[0]).toMatchObject({ band: 0, inFlight: 0, lost: 0 });
  });

  it('times the traffic it sends, because a swap is judged on those instants', async () => {
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok\n');
    });
    const port = await freePort();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
    const driver = startTraffic(port, { busyRate: 20, maxInFlight: 2, requestTimeoutMs: 2_000 });
    driver.setPhase('busy');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const stats = await driver.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(stats.answers.length).toBeGreaterThan(2);
    for (const entry of stats.answers) {
      expect(entry).toMatchObject({ phase: 'busy', status: 200 });
      // The connection was accepted (or the answer would not be a 200), and the
      // three instants are in the order a connection lives in.
      expect(typeof entry.connectedAt).toBe('number');
      expect(Number(entry.connectedAt)).toBeGreaterThanOrEqual(entry.startedAt);
      expect(entry.finishedAt).toBeGreaterThanOrEqual(Number(entry.connectedAt));
    }
    // The count and the instants agree: nothing is answered that was never asked.
    expect(stats.requests).toBe(stats.answers.length);
  });
});

describe('the connection a client holds across a swap', () => {
  const record = {
    outcome: 'replaced',
    swappedAt: new Date(1_200).toISOString(),
    windowUsedMs: 4_000,
    previousPort: 41_002,
    leftoverConnections: 1,
  };
  const held = (overrides: Record<string, unknown> = {}) => ({
    accepted: true,
    endedAt: 6_000,
    endedReason: 'closed',
    requests: [{ status: 200 }, { status: 200 }],
    final: { status: null, error: 'closed' },
    ...overrides,
  });

  it('passes a connection the retired run answered, and that ended with it', () => {
    expect(heldConnectionProblems(held(), record, { index: 1, phase: 'busy' })).toEqual([]);
  });

  it('fails a connection the door handed to the replacement, or closed early', () => {
    const handed = heldConnectionProblems(held({ final: { status: 200, error: null } }), record, { index: 1, phase: 'busy' }).join('\n');
    expect(handed).toMatch(/was answered 200 after the run it was piped to had been stopped/);
    expect(handed).toMatch(/handed an established connection to the replacement/);
    // The door's own 503 is what a connection with nothing behind it gets, which is
    // one of the ways this connection is supposed to end.
    expect(heldConnectionProblems(held({ final: { status: 503, error: null } }), record, { index: 1, phase: 'busy' })).toEqual([]);

    const early = heldConnectionProblems(held({ endedAt: 1_500 }), record, { index: 2, phase: 'quiet' }).join('\n');
    expect(early).toMatch(/only 300ms into the 4000ms window the swap opened/);

    const before = heldConnectionProblems(held({ endedAt: 900 }), record, { index: 2, phase: 'quiet' }).join('\n');
    expect(before).toMatch(/300ms BEFORE the port changed hands/);
  });

  it('fails a retirement that was not still holding the connection, and a run that did not answer it', () => {
    const dropped = heldConnectionProblems(held(), { ...record, leftoverConnections: 0 }, { index: 3, phase: 'busy' }).join('\n');
    expect(dropped).toMatch(/reported 0 connection\(s\) still on the run it retired/);

    const refused = heldConnectionProblems(held({ requests: [{ status: 200 }, { status: 503 }] }), record, { index: 3, phase: 'busy' }).join('\n');
    expect(refused).toMatch(/the connection held across the swap was answered 503 while the run it was piped to was serving/);

    // The door's retry-503 is the one exception, and only from the instant the port
    // changes hands: that is the door discharging a connection whose run has gone —
    // the same answer the ending is allowed to be — rather than a client it refused
    // while it was serving. Before the swap it is still a client the door cost.
    const discharged = heldConnectionProblems(
      held({ requests: [{ at: 1_201, status: 503 }] }),
      record,
      { index: 3, phase: 'busy' },
    );
    expect(discharged).toEqual([]);
    const refusedEarly = heldConnectionProblems(held({ requests: [{ at: 1_100, status: 503 }] }), record, { index: 3, phase: 'busy' }).join('\n');
    expect(refusedEarly).toMatch(/was answered 503 while the run it was piped to was serving/);

    const never = heldConnectionProblems(held({ accepted: false, endedReason: 'ECONNREFUSED' }), record, { index: 4, phase: 'trickle' }).join('\n');
    expect(never).toMatch(/no connection could be held open through the door across the swap \(ECONNREFUSED\)/);
  });

  it('blames the door for a mid-window ending, and reads the count only for a connection open at it', () => {
    // The count is read at ONE instant — swappedAt + windowUsedMs, here 5200 — and it
    // speaks for this connection exactly while the connection was open at that instant:
    // a run with nothing left on it is what a count of zero should say. So the two are
    // divided there and nothing is hedged around it. The run behind the door is serving
    // this connection until then, and no clock of that run's can end it — it is never
    // idle while it is held, and no response of its ever finishes (see `holdConnection`)
    // — so an ending before that instant has one author left, and it is the door's
    // however early it comes.
    expect(leftoverCountInstant(record)).toBe(5_200);
    for (const endedAt of [5_000, 5_100, 5_199]) {
      const problems = heldConnectionProblems(held({ endedAt }), { ...record, leftoverConnections: 0 }, { index: 5, phase: 'busy' }).join('\n');
      expect(problems, `ended at ${endedAt}`).toMatch(
        /the door closed a connection a client was holding only \d+ms into the 4000ms window the swap opened/,
      );
      expect(problems, `ended at ${endedAt}`).not.toMatch(/still on the run it retired/);
    }
    // ...and the count is what speaks for a connection that was still open when it was
    // taken, whether the ending came after it (the ordinary shape of a swap that worked:
    // the run is stopped after the count is read) or not at all (the door moved the
    // connection to the replacement rather than ending it with the run).
    for (const endedAt of [5_200, 5_900, 6_000, null]) {
      const problems = heldConnectionProblems(held({ endedAt }), { ...record, leftoverConnections: 0 }, { index: 6, phase: 'busy' }).join('\n');
      expect(problems, `ended at ${endedAt}`).toMatch(/reported 0 connection\(s\) still on the run it retired/);
      expect(problems, `ended at ${endedAt}`).not.toMatch(/closed a connection a client was holding/);
    }
  });

  it('lays a run’s own give-up on the run, and still reads the count for a connection open at it', () => {
    // The one ending of this connection that is not the door's, and the run says so itself:
    // its header timeout, giving up on a request head this connection never received the end
    // of (the shape is `holdConnection`'s; the end-to-end case above measures what that looks
    // like). A 408 is not a door that cost a client an answer, and the ending it comes with
    // is the run's, so the count — taken after the connection was already gone — is not read
    // for it either.
    const gaveUpEarly = held({ requests: [{ at: 2_000, status: 408 }], endedAt: 2_100 });
    expect(leftoverCountInstant(record)).toBe(5_200);
    expect(heldConnectionProblems(gaveUpEarly, { ...record, leftoverConnections: 0 }, { index: 7, phase: 'busy' })).toEqual([]);
    expect(heldConnectionProblems(gaveUpEarly, record, { index: 7, phase: 'busy' })).toEqual([]);
    // ...and it is never reported as a run that answered a client: it answered a request no
    // client finished asking.
    expect(heldConnectionProblems(gaveUpEarly, record, { index: 7, phase: 'busy' }).join('\n')).not.toMatch(/was answered 408/);

    // A give-up AFTER the count was taken is a different ending: the connection was still on
    // the run when the door counted it, so the count is read, and zero is the finding.
    const gaveUpLate = held({ requests: [{ at: 5_400, status: 408 }], endedAt: 5_500 });
    expect(heldConnectionProblems(gaveUpLate, { ...record, leftoverConnections: 0 }, { index: 8, phase: 'busy' }).join('\n')).toMatch(
      /reported 0 connection\(s\) still on the run it retired/,
    );
  });

  it('does not judge the ending of a reload that never retired anything', () => {
    // A reload that did not land as `replaced` — here, nothing changed — has no
    // retirement to judge an ending against, and the reload itself is the finding.
    expect(heldConnectionProblems(held({ final: { status: 200, error: null } }), { ...record, outcome: 'kept' }, { index: 1, phase: 'busy' })).toEqual([]);
    // ...but a door that cost the client an answer is still a door that did.
    const cost = heldConnectionProblems(held({ requests: [{ status: 502 }] }), { ...record, outcome: 'kept' }, { index: 1, phase: 'busy' }).join('\n');
    expect(cost).toMatch(/was answered 502 while the run it was piped to was serving/);
  });

  it('is held open on the run it was opened against, and ends with it when the door moves', async () => {
    /** A backend that answers with a status of its own, so a swap is observable. */
    const backend = async (status: number) => {
      const sockets = new Set<Socket>();
      const server = createHttpServer((_req, res) => {
        res.writeHead(status, { 'content-type': 'text/plain' });
        res.end(`backend ${status}\n`);
      });
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      const port = await freePort();
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
      return {
        port,
        /** Stop serving AND drop what it is serving: a run that has been retired. */
        stop: async () => {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
      };
    };

    const serving = await backend(200);
    const replacement = await backend(404);
    const port = await freePort();
    const front = new FrontDoor({ port, host: '127.0.0.1' });
    await front.listen();
    try {
      front.setTarget(serving.port);
      const held = await holdConnection(port);
      expect(held.accepted).toBe(true);
      // Nothing is answered while it is held, and that is the whole reason it is held this
      // way: the request it holds the run with is never finished, so there is no request any
      // run could answer and no idle clock any run could reach it with (see
      // `holdConnection`). What it is here for is that it is still THERE.
      expect(held.requests).toEqual([]);
      // The door's own account of the run it is piping to — it counts a connection
      // when it ACCEPTS it, before a byte is read, which is what makes a held
      // connection visible to a retirement without the door looking inside it.
      expect(front.countFor(serving.port)).toBe(1);

      // The swap, and then the run it replaced is stopped: the connection was the
      // retired run's, so it may not be answered by the replacement from here.
      expect(front.setTarget(replacement.port)).toBe(serving.port);
      await serving.stop();
      const final = await held.stop();
      // Not the replacement's answer, whichever way the door ended it: the door's own
      // 503 for a connection with nothing behind it, or the socket ending with the run
      // it was piped to.
      expect(final.status).not.toBe(404);
      expect([null, 503]).toContain(final.status);
      expect(held.endedAt).not.toBeNull();
    } finally {
      await front.close();
      await replacement.stop();
    }
  });

  it('is not ended by the run’s own idle clock, so a mid-window ending has no other author than the door', async () => {
    // The boundary the ending rule stands on, measured on real pieces: a front door serving a
    // real run whose keep-alive clock is turned down to 300ms. A client connection the run
    // has ANSWERED and that nobody is using is closed by that run's own clock — the control
    // below — while the connection the soak holds is still open, and still that run's: it
    // holds the head of a request that never finishes, so no response of its ever completes,
    // and the clock a run arms when one does is never armed at all (see `holdConnection`).
    // That is what the ending rule leans on, and it is only half of the picture: the one
    // clock of that run's which CAN reach this shape announces itself, and that is the case
    // after this one. (The backend is asked to idle its connections out in 300ms rather than
    // the 5s default so the clock under test costs the suite a third of a second.)
    const sockets = new Set<Socket>();
    const backend = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('backend\n');
    });
    backend.keepAliveTimeout = 300;
    backend.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    const backendPort = await freePort();
    await new Promise<void>((resolve) => backend.listen(backendPort, '127.0.0.1', () => resolve()));
    const port = await freePort();
    const front = new FrontDoor({ port, host: '127.0.0.1' });
    await front.listen();
    try {
      front.setTarget(backendPort);

      // The control: one client, one request, one answer, and then nothing at all. From here
      // the only clock left on this connection is the run's own.
      const client = connect(port, '127.0.0.1');
      client.setNoDelay(true);
      const answered = { answers: 0, endedAt: null as number | null };
      let buffered = '';
      client.on('data', (chunk) => {
        buffered += chunk.toString();
        const end = buffered.indexOf('\r\n\r\n');
        if (end === -1) return;
        const line = /^HTTP\/1\.[01] (\d{3})/.exec(buffered.slice(0, end));
        buffered = buffered.slice(end + 4);
        if (line) answered.answers += 1;
      });
      client.on('error', () => {});
      client.on('close', () => {
        if (answered.endedAt === null) answered.endedAt = Date.now();
      });
      client.write(`HEAD / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`);
      await until(() => answered.answers >= 1, 5_000, 'the run answered the control connection');
      await until(() => answered.endedAt !== null, 5_000, 'the run closed the connection nobody was using');

      // The hold: the same run, the same door, the same 300ms clock — and still open,
      // with nothing written into it after the head it holds the run with.
      const held = await holdConnection(port);
      expect(held.accepted).toBe(true);
      const acceptedAt = held.acceptedAt as number;
      await until(() => Date.now() - acceptedAt >= 1_500, 5_000, 'the held connection outlives the clock');
      expect(held.endedAt, 'the run’s idle clock ended the connection the soak holds').toBeNull();
      expect(held.requests).toEqual([]);
      // ...and it IS the run's connection, on the run it was piped to: finishing the head is
      // answered rather than the socket having ended with something else.
      expect((await held.stop()).status).toBe(200);
      // The run itself was serving through all of it: this ended a connection, not a server.
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
      await front.close();
    }
  }, 30_000);

  it('reads a run’s own give-up on the unfinished head as the run’s ending, not the door’s', async () => {
    // The clock that DOES reach this shape, and the reason the ending rule can still be a
    // boundary rather than a hedge: `headersTimeout`, which a run applies to a request head
    // it never received the end of. Measured here (and against a run asked nothing at all,
    // which that clock reaches just the same — so no shape is immune to it): the run gives
    // up at the first check after the timeout and ANNOUNCES it, `HTTP/1.1 408 Request
    // Timeout` and then the close. Against Node's defaults that is ~90s of holding (a 60s
    // clock, checked every 30s), which is why the hold has to be — and is — younger than it
    // for as long as it is judged: one reload, ~10-20s, against a 64s budget.
    // Taken straight from the run rather than through the door on purpose: the door forwards
    // those bytes like any others, but a run that ends its socket abruptly having written
    // nothing to the client can equally be answered by the door's own 503, so the run's own
    // answer is the deterministic half of this measurement.
    const backend = createHttpServer({ headersTimeout: 300, connectionsCheckingInterval: 100 }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('backend\n');
    });
    const backendPort = await freePort();
    await new Promise<void>((resolve) => backend.listen(backendPort, '127.0.0.1', () => resolve()));
    try {
      const head = connect(backendPort, '127.0.0.1');
      head.setNoDelay(true);
      const gotten = { endedAt: null as number | null, answers: [] as string[] };
      let bytes = '';
      head.on('data', (chunk) => {
        bytes += chunk.toString();
        const end = bytes.indexOf('\r\n\r\n');
        if (end === -1) return;
        gotten.answers.push(bytes.slice(0, end).split('\r\n')[0] ?? '');
        bytes = bytes.slice(end + 4);
      });
      head.on('error', () => {});
      head.on('close', () => {
        if (gotten.endedAt === null) gotten.endedAt = Date.now();
      });
      // The shape the hold is: the head of a request, and never the empty line that ends it.
      head.write(`HEAD / HTTP/1.1\r\nHost: 127.0.0.1:${backendPort}\r\nConnection: keep-alive\r\n`);
      await until(() => gotten.endedAt !== null, 5_000, 'the run gave up on the unfinished request head');
      expect(gotten.answers.join(' | ')).toMatch(/408 Request Timeout/);

      // What the verdict does with that ending: the run said so, so it is the run's — no
      // problem for the door, and no count read against a connection that was already gone
      // when the door took it (the window here runs long past the give-up).
      const endedAt = gotten.endedAt as number;
      const gaveUp = {
        accepted: true,
        acceptedAt: endedAt - 500,
        endedAt,
        endedReason: 'closed',
        requests: [{ at: endedAt, status: 408 }],
        final: { at: endedAt, status: null, error: 'closed' },
      };
      const record = {
        outcome: 'replaced',
        previousPort: backendPort,
        swappedAt: new Date(endedAt - 1_000).toISOString(),
        windowUsedMs: 60_000,
        leftoverConnections: 0,
      };
      expect(heldConnectionProblems(gaveUp, record, { index: 1, phase: 'busy' })).toEqual([]);
      expect(describeSwap(watchedSwap(record, { index: 1, attachedAt: 0, answers: [], held: gaveUp }).report)).toMatch(
        /was ended by the run it was piped to, which answered 408 for a request this connection never finished — the door was not judged through it/,
      );
      // ...while the SAME ending with no such answer on it is still the door's: the one thing
      // that separates them is what the run said.
      expect(heldConnectionProblems({ ...gaveUp, requests: [] }, record, { index: 1, phase: 'busy' }).join('\n')).toMatch(
        /the door closed a connection a client was holding/,
      );
    } finally {
      await new Promise<void>((resolve) => backend.close(() => resolve()));
    }
  }, 30_000);
});


describe('watching a deploy rather than soaking one', () => {
  it("reads the watch's own command line, and refuses the soak's schedule with it", () => {
    const options = parseArgs(['--attach', '3000', '--history', 'reloads.jsonl', '--swaps', '2', '--wait', '5000', '--json']);
    expect(options).toMatchObject({ attach: 3000, history: 'reloads.jsonl', swaps: 2, waitMs: 5000, json: true });
    expect(() => parseArgs(['--attach', '3000'])).toThrow(/--history/);
    expect(() => parseArgs(['--attach', '0', '--history', 'x'])).toThrow(/--attach: the front door to watch is a port/);
    // Everything that only means something when this script is the one asking for
    // reloads is refused by name, rather than silently doing nothing.
    expect(() => parseArgs(['--attach', '3000', '--history', 'x', '--reloads', '4'])).toThrow(
      /--reloads: with --attach the reloads are the deploy's own/,
    );
    expect(() => parseArgs(['--attach', '3000', '--history', 'x', '--server', 'node x.mjs'])).toThrow(/--server/);
    expect(() => parseArgs(['--attach', '3000', '--history', 'x', '--window-ms', '90'])).toThrow(/--window-ms/);
    // ...and this is the exact argv `npm run watch:swaps -- 3000 --history
    // ./reloads.jsonl` produces — the npm script names `--attach` itself, so the
    // port lands in the slot the flag reads it from.
    expect(parseArgs(['--attach', '3000', '--history', './reloads.jsonl'])).toMatchObject({
      attach: 3000,
      history: './reloads.jsonl',
    });
    // A daemon: the log it appends to, and no stopping count — the count is the
    // one thing a daemon cannot have, because a daemon that exits at a swap count
    // exits while the deploy it is watching is still going.
    expect(parseArgs(['--attach', '3000', '--history', 'x', '--daemon', 'swaps.jsonl'])).toMatchObject({
      daemon: 'swaps.jsonl',
      swaps: 0,
    });
    expect(() =>
      parseArgs(['--attach', '3000', '--history', 'x', '--daemon', 'swaps.jsonl', '--swaps', '2']),
    ).toThrow(/a daemon does not stop after a count/);
    // ...and a log needs somewhere for the swaps to have come from: a soak performs
    // its own reloads, so it has none of somebody else's to append.
    expect(() => parseArgs(['--reloads', '2', '--daemon', 'swaps.jsonl'])).toThrow(/only a watch has swaps/);
    // Demanding proof is the watch's, for its own reason: a soak performs the
    // reloads it judges the records of, so it has nobody else's swaps to demand a
    // swap out of.
    expect(parseArgs(['--attach', '3000', '--history', 'x', '--require-swap'])).toMatchObject({
      requireSwap: true,
    });
    expect(parseArgs(['--attach', '3000', '--history', 'x'])).toMatchObject({ requireSwap: false });
    expect(() => parseArgs(['--reloads', '2', '--require-swap'])).toThrow(
      /--require-swap: a soak performs its own reloads/,
    );
    // Where a person is told: PagerDuty, or any endpoint that will take the account
    // as JSON — and nothing else, because a destination nobody can reach is a page
    // nobody gets.
    expect(parseArgs(['--attach', '3000', '--history', 'x', '--alert', 'pagerduty'])).toMatchObject({
      alert: 'pagerduty',
    });
    expect(parseArgs(['--attach', '3000', '--history', 'x', '--alert', 'https://hooks.example.test/T1/B2'])).toMatchObject({
      alert: 'https://hooks.example.test/T1/B2',
    });
    expect(parseArgs(['--attach', '3000', '--history', 'x'])).toMatchObject({ alert: null });
    expect(() => parseArgs(['--attach', '3000', '--history', 'x', '--alert', 'slack'])).toThrow(
      /--alert: expected `pagerduty` or an http\(s\) URL, not "slack"/,
    );
    expect(() => parseArgs(['--attach', '3000', '--history', 'x', '--alert', 'ftp://x/y'])).toThrow(/--alert: expected/);
    expect(() => parseArgs(['--reloads', '2', '--alert', 'pagerduty'])).toThrow(
      /--alert: only a watch of somebody else's deploy pages somebody/,
    );
    // Where the deploy's own output is, so a loss can be CLASSIFIED as it lands: a watch
    // names it, and a soak cannot — it writes `server.log` beside its own account and reads
    // it from there.
    expect(parseArgs(['--attach', '3000', '--history', 'x', '--server-log', 'out.log'])).toMatchObject({
      serverLog: 'out.log',
    });
    expect(parseArgs(['--attach', '3000', '--history', 'x'])).toMatchObject({ serverLog: null });
    expect(() => parseArgs(['--reloads', '2', '--server-log', 'out.log'])).toThrow(
      /--server-log: a soak writes the app's own output beside its account/,
    );
    // ...and the soak's own options still work the way they did without it.
    expect(parseArgs(['--reloads', '2'])).toMatchObject({ attach: null, history: null, swaps: 0, daemon: null });
  });
});

describe('one swap, as the watch saw it', () => {
  const record = {
    swappedAt: new Date(1_200).toISOString(),
    outcome: 'replaced',
    closedBy: 'traffic',
    windowUsedMs: 1_200,
    leftoverConnections: 1,
  };
  /** The connection the deploy's swap was answerable for: open before it, retired with it. */
  const across = (overrides: Record<string, unknown> = {}) => ({
    accepted: true,
    acceptedAt: 500,
    endedAt: 3_000,
    requests: [{ status: 200 }, { status: 200 }],
    final: { status: null, error: 'closed' },
    ...overrides,
  });
  const answers = [
    { phase: 'deploy', startedAt: 600, connectedAt: 605, finishedAt: 900, status: 200 },
    { phase: 'deploy', startedAt: 1_100, connectedAt: 1_105, finishedAt: 1_600, status: 200 },
  ];

  it('passes a swap the door carried its clients through, and says what it had', () => {
    const { judged, report, problems } = watchedSwap(record, { index: 1, attachedAt: 100, answers, held: across() });
    expect(judged).toBe(true);
    expect(problems).toEqual([]);
    expect(report).toMatchObject({
      schema: SWAP_WATCH_SCHEMA,
      swap: 1,
      outcome: 'replaced',
      closedBy: 'traffic',
      leftoverConnections: 1,
      judged: true,
      atTheDoor: { band: 2, inFlight: 1, lost: 0 },
      held: { answers: 2, afterStop: '!closed' },
    });
    expect(describeSwap(report)).toBe(
      'swap 1: replaced, closed by traffic, window 1200ms — 2 client(s) at the door, 1 in flight across the change, 0 lost; ' +
        'the connection held across it (2 answer(s)) ended with the run it was piped to',
    );
  });

  it('says a hold nothing answered was a request in flight, rather than counting zero answers', () => {
    // The connection the soak holds is not answered while it is held — the request it holds
    // the run with is never finished (see `holdConnection`) — so the line says what held the
    // connection instead of reporting an answer count of nothing.
    const { report } = watchedSwap(record, { index: 1, attachedAt: 100, answers, held: across({ requests: [] }) });
    expect(report.held).toMatchObject({ answers: 0 });
    expect(describeSwap(report)).toMatch(
      /the connection held across it \(a request in flight, never answered\) ended with the run it was piped to/,
    );
  });

  it('answers for an ending before the count as the door’s, and one after it as the retirement’s', () => {
    // The connection ended while the run it was piped to was still serving it — before
    // the instant the door read its count, which here is swappedAt + 1200ms. Nothing but
    // the door can end a connection the watch holds (see `heldConnectionProblems`), so
    // this ending is the door's, and the record and the line both say WHICH ending this
    // was rather than the ending a swap that worked leaves behind.
    // `previousPort` is what makes this a retirement the checks can judge, and the count
    // is zero on purpose: a count that says the retired run held nothing is the finding —
    // unless the connection had already ended when it was taken, in which case the
    // ending itself is the finding.
    const died = watchedSwap({ ...record, leftoverConnections: 0, previousPort: 41_002 }, { index: 4, attachedAt: 100, answers, held: across({ endedAt: 2_300 }) });
    expect(died.judged).toBe(true);
    expect(died.problems.join('\n')).toMatch(
      /reload 4 \(deploy\): the door closed a connection a client was holding only 1100ms into the 1200ms window the swap opened/,
    );
    expect(died.report.held as Record<string, unknown>).toMatchObject({ endedBeforeCount: true });
    expect(describeSwap(died.report)).toMatch(/\(2 answer\(s\)\) ended before the run it was piped to was retired$/);

    // The ordinary ending — with the run it was piped to, after the door had counted
    // it — is not a finding, and still reads the way it always did.
    const withIt = watchedSwap({ ...record, previousPort: 41_002 }, { index: 5, attachedAt: 100, answers, held: across() });
    expect(withIt.problems).toEqual([]);
    expect(withIt.report.held as Record<string, unknown>).toMatchObject({ endedBeforeCount: false });
    expect(describeSwap(withIt.report)).toMatch(/ended with the run it was piped to$/);
  });

  it('reports a run that gave up on the request the held connection never finished', () => {
    // The one clock of the run's that reaches this shape announces itself (a 408, see
    // `holdConnection` and the end-to-end case above it), so the verdict knows which ending
    // this was: the record carries that fact beside the boundary the verdict was made on, and
    // the line says it rather than blaming a door that did nothing.
    const gaveUp = watchedSwap(
      { ...record, leftoverConnections: 0, previousPort: 41_002 },
      { index: 6, attachedAt: 100, answers, held: across({ requests: [{ at: 1_800, status: 408 }], endedAt: 1_900 }) },
    );
    expect(gaveUp.judged).toBe(true);
    expect(gaveUp.problems).toEqual([]);
    expect(gaveUp.report.held as Record<string, unknown>).toMatchObject({ runGaveUp: true, endedBeforeCount: true });
    expect(describeSwap(gaveUp.report)).toMatch(
      /the connection held across it \(1 answer\(s\)\) was ended by the run it was piped to, which answered 408 for a request this connection never finished/,
    );
  });

  it('reports a swap that happened before it attached instead of judging it', () => {
    // The history a deploy keeps is its past, and the first record after attaching
    // may be a reload that was already over: nothing was watching, so nothing is
    // claimed about it — and it is not a finding either.
    const { judged, report, problems } = watchedSwap(record, { index: 1, attachedAt: 5_000, answers, held: across() });
    expect(judged).toBe(false);
    expect(problems).toEqual([]);
    expect(report.why).toMatch(/the port changed hands before the watch attached/);
    expect(describeSwap(report)).toMatch(/swap 1: NOT JUDGED — the port changed hands before the watch attached/);
  });

  it('reports a reload that never swapped the port as nothing to judge, not as a failure', () => {
    // The writer's own vocabulary: `swappedAt` is null exactly when no window was
    // ever open, which is what a reload that changes nothing leaves behind (a
    // replacement that never came up). There was no change at the door, so nothing
    // about the door is claimed and nothing about it can fail: the record is
    // reported and the verdict is left to the swaps that did land.
    const keptRecord = { ...record, swappedAt: null, outcome: 'kept', closedBy: null, windowUsedMs: null, leftoverConnections: 0 };
    const kept = watchedSwap(keptRecord, { index: 2, attachedAt: 100, answers, held: null });
    expect(kept.judged).toBe(false);
    expect(kept.problems).toEqual([]);
    expect(kept.report.why).toMatch(/the reload never swapped the port \(kept\)/);
    expect(kept.report.why).toMatch(/there was no change at the door to judge/);
    expect(describeSwap(kept.report)).toBe(
      'swap 2: NOT JUDGED — the reload never swapped the port (kept) — no window was ever open, so there was no change at the door to judge',
    );

    // A record that names no instant at all reads the same way rather than as a
    // finding: absence of a swap is not a broken one.
    const nameless = watchedSwap({ ...keptRecord, outcome: 'kept', swappedAt: undefined }, {
      index: 3,
      attachedAt: 100,
      answers,
      held: null,
    });
    expect(nameless.judged).toBe(false);
    expect(nameless.problems).toEqual([]);
  });

  it('fails a record that claims a swap at an instant it cannot read', () => {
    // Distinct from the case above on purpose: an instant that is THERE and cannot
    // be read is unreadable evidence, not an absent swap, and a watch that cannot
    // place the swap does not pass it.
    const corrupt = watchedSwap({ ...record, swappedAt: 'yesterday' }, { index: 2, attachedAt: 100, answers, held: null });
    expect(corrupt.judged).toBe(false);
    expect(corrupt.problems.join('\n')).toMatch(
      /swap 2: the record claims a swap at an instant that cannot be read \("yesterday"\)/,
    );
    expect(describeSwap(corrupt.report)).toMatch(/swap 2: NOT JUDGED — the record claims a swap at an instant that cannot be read/);
  });

  it('fails a swap with nothing held across it, and one whose clients lost an answer', () => {
    const nothingHeld = watchedSwap(record, { index: 2, attachedAt: 100, answers, held: null }).problems.join('\n');
    expect(nothingHeld).toMatch(/swap 2: no connection was being held across the port change/);

    const lost = watchedSwap(record, {
      index: 3,
      attachedAt: 100,
      answers: [{ phase: 'deploy', startedAt: 1_100, connectedAt: 1_105, finishedAt: 1_900, status: 503 }],
      held: across(),
    });
    expect(lost.judged).toBe(true);
    expect(lost.problems.join('\n')).toMatch(/reload 3 \(deploy\): a client in flight across the port change was answered 503/);
    expect(describeSwap(lost.report)).toMatch(/1 client\(s\) at the door, 1 in flight across the change, 1 lost/);

    // A deploy's own outcome is reported and never a finding: a rollback is a thing
    // a deploy is allowed to do.
    const rolledBack = watchedSwap({ ...record, outcome: 'rolled-back', closedBy: 'check' }, {
      index: 4,
      attachedAt: 100,
      answers,
      held: { ...across(), final: { status: 200, error: null } },
    });
    expect(rolledBack.problems).toEqual([]);
  });

  it("names the client a swap cost by the same handle the downloaded account's timeline does", () => {
    // A swap read as it lands and the same swap read out of an account afterwards are ONE
    // incident, so the client has to be named the same way in both — the ordinal it was handed
    // to the door at, spelled the way the app's own request log spells it. The watch judges a
    // single swap and cannot say which client of a run it was (`handed` is null by design), so
    // this handle is the whole of what it can offer, and it offers it on the line a person reads
    // while the deploy is still running.
    const lost = watchedSwap(record, {
      index: 3,
      attachedAt: 100,
      answers: [{ phase: 'deploy', startedAt: 1_100, connectedAt: 1_105, finishedAt: 1_900, opened: 63, status: 503 }],
      held: across(),
    });
    expect(lost.judged).toBe(true);
    const spent = (lost.report.atTheDoor as { spent: { client: number | null; handed: unknown }[] }).spent;
    expect(spent[0].client).toBe(63);
    expect(spent[0].handed).toBeNull();
    // The literal sentence, not a pattern: this is the wording the timeline is pinned with
    // (tests/soak-diagnose.test.ts), and the two readings of one loss have to agree on it.
    expect(describeSwap(lost.report)).toContain(
      '1 lost (the 63rd client handed to the door (`_client=63` in the app\'s own request log) — ' +
        'the 1st of the 1 client(s) the swap had at the door)',
    );
    // One function builds it for both readers, so the line says exactly the name the timeline
    // would: nothing here is spelled a second time for the watch.
    expect(describeSwap(lost.report)).toContain(`1 lost (${nameSpent(spent[0])})`);

    // The absence is said here too, rather than printing the place with the handle missing: an
    // account whose clients were not the soak's own traffic carries no ordinal (a hand-made one).
    const handMade = watchedSwap(record, {
      index: 4,
      attachedAt: 100,
      answers: [{ phase: 'deploy', startedAt: 1_100, connectedAt: 1_105, finishedAt: 1_900, status: 503 }],
      held: across(),
    });
    expect(describeSwap(handMade.report)).toContain(
      '1 lost (a client this account names no `_client=` ordinal for — the 1st of the 1 client(s) the swap had at the door)',
    );
  });

  it('says WHY the loss looks the way it does, in the sentence the account prints afterwards', () => {
    // The client a swap cost is half a finding; the app's side of it is the other half. What
    // `watchDeploy` attaches to the loss at the instant it lands (`app`) is read here the way
    // the watch reads it: the client's own lines, classified. The line a person reads while the
    // deploy is still running then says what the downloaded account will say later — one
    // function (`describeAppLines`) words both.
    const lost = watchedSwap(record, {
      index: 3,
      attachedAt: 100,
      answers: [{ phase: 'deploy', startedAt: 1_100, connectedAt: 1_105, finishedAt: 1_900, opened: 63, status: 503 }],
      held: across(),
    });
    const spent = (lost.report.atTheDoor as { spent: Record<string, unknown>[] }).spent;
    // With no output read, the line is the one it has always been: the client named, not
    // explained — nothing is invented about a file nobody could open.
    expect(describeSwap(lost.report)).not.toContain("the app's own log");

    spent[0].app = { ...clientLogLines(' GET /?_client=63 503 in 4ms (next.js: 1ms)\n', 63), log: 'server.log' };
    expect(describeSwap(lost.report)).toContain(
      " — the app's own log (server.log) names this client on 1 line(s): GET /?_client=63 503 in 4ms (next.js: 1ms) — " +
        "ANSWERED (503): the client got an answer on every line it has here, so nothing was cut off on the app's side — " +
        'the loss is the status it got (503), not a silence',
    );

    // The other half of the reading, on the same line: the app was handed the request and
    // never finished it, which is what a client cut off at the swap leaves on its side.
    spent[0].app = {
      ...clientLogLines('[fake] run 2 cost a client its answer — /?_client=63 closed with no reply\n', 63),
      log: 'server.log',
    };
    expect(describeSwap(lost.report)).toContain(
      ' — NO ANSWER: not one line here carries a status, so the app was handed the request and never finished it',
    );

    // And the absence that is NOT the app's: nothing in the output names the client at all.
    spent[0].app = { ...clientLogLines(' GET /?_client=6 200 in 1ms (next.js: 1ms)\n', 63), log: 'server.log' };
    expect(describeSwap(lost.report)).toContain(
      "the app's own log (server.log) carries no line for this client — NO LINE AT ALL: the request never became a line",
    );

    // The other absence: the log itself could not be read whole, so zero lines is the LOG's
    // silence and not the app's — a fifth shape, and a different sentence on the same line.
    spent[0].app = {
      ...clientLogLines(' GET /?_client=6 200 in 1ms (next.js: 1ms)\n', 63, { gaps: [{ kind: 'rotated' }] }),
      log: 'server.log',
    };
    expect((spent[0].app as { classification: { shape: string } }).classification.shape).toBe('unseen');
    expect(describeSwap(lost.report)).toContain(
      "the app's own log (server.log) names no line for this client, and cannot be read whole — " +
        "UNSEEN: the app's own output was replaced (rotated or truncated) while the watch was reading it",
    );
    expect(describeSwap(lost.report)).not.toContain('NO LINE AT ALL');
  });
});

describe("the app's own output, kept across the file being replaced", () => {
  /** A reader over a map of paths, so a rotation is two writes rather than a race with a deploy. */
  const readerOf = (files: Record<string, string>) => (path: string) => {
    if (!(path in files)) throw new Error(`ENOENT: ${path}`);
    return files[path];
  };

  it('keeps what it read as the file grows, so a loss is answered from everything seen', () => {
    const files: Record<string, string> = { 'server.log': ' GET /?_client=63 503 in 4ms\n' };
    const view = startAppLogView('server.log', { read: readerOf(files) });
    expect(view.sample()).toMatchObject({ present: true, gaps: [] });
    files['server.log'] += ' GET /?_client=64 200 in 1ms\n';
    const seen = view.sample();
    expect(seen.gaps).toEqual([]);
    expect(clientLogLines(seen.text, 63)?.classification).toMatchObject({ shape: 'answered', statuses: [503] });
    expect(clientLogLines(seen.text, 64)?.total).toBe(1);
  });

  it('recovers a rename rotation from `<log>.1`, so the client answered before it is not reported absent', () => {
    // The deploy rotated `server.log` to `server.log.1` and started a new one. The lines written
    // after this reader's last look are in the renamed file's TAIL — the only place they exist —
    // and reading them is what keeps an ordinary rotation from costing a reading at all.
    const files: Record<string, string> = { 'server.log': ' warm\n GET /?_client=63 200 in 2ms\n' };
    const view = startAppLogView('server.log', { read: readerOf(files) });
    view.sample();
    files['server.log.1'] = `${files['server.log']} GET /?_client=64 200 in 3ms\n`;
    files['server.log'] = ' GET /?_client=65 200 in 4ms\n';
    const seen = view.sample();
    // Nothing was lost, so nothing is claimed to have been: no gap, and no UNSEEN after it.
    expect(seen.gaps).toEqual([]);
    expect(clientLogLines(seen.text, 63)?.classification.shape).toBe('answered');
    expect(clientLogLines(seen.text, 64)?.classification.shape).toBe('answered');
    expect(clientLogLines(seen.text, 65)?.classification.shape).toBe('answered');
  });

  it('says the file was replaced when there is no `.1` to recover, so absence is the LOG\'s', () => {
    const files: Record<string, string> = { 'server.log': ' GET /?_client=63 503 in 4ms\n' };
    const view = startAppLogView('server.log', { read: readerOf(files) });
    view.sample();
    // Truncated in place and rewritten (copytruncate): the old file is gone, not renamed.
    files['server.log'] = ' GET /?_warm=2 200 in 1ms\n';
    const seen = view.sample();
    expect(seen.gaps.map((gap: { kind: string }) => gap.kind)).toEqual(['rotated']);
    // What was already read is still evidence: the client this view saw answered is answered.
    expect(clientLogLines(seen.text, 63)?.classification.shape).toBe('answered');
    // A client it never saw is not called one the app never saw.
    const missing = clientLogLines(seen.text, 99, { gaps: seen.gaps });
    expect(missing).toMatchObject({ total: 0 });
    expect(missing?.classification).toMatchObject({ shape: 'unseen' });
    expect(describeAppLines(missing, 'server.log')).toContain('UNSEEN: the app\'s own output was replaced (rotated or truncated)');
    // …and the vocabulary says so once, so both readers print the same word.
    expect(classifyLogLines([], { gaps: seen.gaps })).toMatchObject({ shape: 'unseen' });
    expect(classifyLogLines([]).shape).toBe('absent');
  });

  it('notices a file cut back, and keeps the lines it had already read', () => {
    const files: Record<string, string> = { 'server.log': 'one\n GET /?_client=63 200 in 1ms\ntwo\n' };
    const view = startAppLogView('server.log', { read: readerOf(files) });
    view.sample();
    files['server.log'] = 'one\n';
    const seen = view.sample();
    expect(seen.gaps.map((gap: { kind: string }) => gap.kind)).toEqual(['truncated']);
    expect(clientLogLines(seen.text, 63)?.total).toBe(1);
    expect(seen.text).toContain('two');
  });

  it('recovers from a missing interval when `.1` proves it was an ordinary rotation', () => {
    const files: Record<string, string> = { 'server.log': 'before\n' };
    const view = startAppLogView('server.log', { read: readerOf(files) });
    view.sample();
    files['server.log.1'] = 'before\n GET /?_client=63 503 in 2ms\n';
    delete files['server.log'];
    expect(view.sample()).toMatchObject({ present: false, gaps: [{ kind: 'missing' }] });
    files['server.log'] = '';
    expect(view.sample()).toMatchObject({ gaps: [], text: expect.stringContaining('GET /?_client=63 503') });
    files['server.log'] = ' GET /?_client=64 200 in 3ms\n';
    const seen = view.sample();
    expect(seen.gaps).toEqual([]);
    expect(clientLogLines(seen.text, 63)?.classification.statuses).toEqual([503]);
    expect(clientLogLines(seen.text, 64)?.classification.statuses).toEqual([200]);
  });

  it('notices an empty truncation and advances the baseline for subsequent appends', () => {
    const files: Record<string, string> = { 'server.log': 'old\n GET /?_client=63 200 in 1ms\n' };
    const view = startAppLogView('server.log', { read: readerOf(files) });
    view.sample();
    files['server.log'] = '';
    expect(view.sample().gaps.map((gap: { kind: string }) => gap.kind)).toEqual(['truncated']);
    files['server.log'] = ' GET /?_client=64 503 in 2ms\n';
    const seen = view.sample();
    expect(seen.text).toContain('GET /?_client=64 503');
    expect(clientLogLines(seen.text, 63)?.classification.statuses).toEqual([200]);
    expect(clientLogLines(seen.text, 64)?.classification.statuses).toEqual([503]);
  });

  it('keeps the reading when the file is missing at the look, and says the file was missing', () => {
    const files: Record<string, string> = { 'server.log': ' GET /?_client=63 200 in 1ms\n' };
    const view = startAppLogView('server.log', { read: readerOf(files) });
    view.sample();
    delete files['server.log'];
    const seen = view.sample();
    expect(seen).toMatchObject({ present: false });
    expect(seen.gaps.map((gap: { kind: string }) => gap.kind)).toEqual(['missing']);
    expect(clientLogLines(seen.text, 63)?.classification.shape).toBe('answered');
  });

  it('is honest about its own cap: a line it dropped is a gap, not an absence', () => {
    const files: Record<string, string> = { 'server.log': ' GET /?_client=63 200 in 1ms\n' + `${'x'.repeat(20)}\n` };
    const view = startAppLogView('server.log', { read: readerOf(files), keepChars: 40 });
    const seen = view.sample();
    expect(seen.gaps.map((gap: { kind: string }) => gap.kind)).toEqual(['dropped']);
    const gone = clientLogLines(seen.text, 63, { gaps: seen.gaps });
    expect(gone?.total).toBe(0);
    expect(gone?.classification.shape).toBe('unseen');
  });
});

describe('the watch of a deploy that performs no swap', () => {
  it('ends as nothing to judge rather than as a failure, and says which nothing it was', async () => {
    // A deploy that is answering on its front door, and a history that gains the
    // record of a reload that changed nothing. The port never changes hands, so
    // there is nothing at the door to judge and nothing the deploy can be failed
    // for — the watch ends because nothing was judged (2), which is not a failure.
    const sockets = new Set<Socket>();
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('serving\n');
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    const port = await freePort();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
    const dir = mkdtempSync(join(tmpdir(), 'anybase-watch-kept-'));
    const history = join(dir, 'reloads.jsonl');
    const daemonLog = join(dir, 'swaps.jsonl');
    writeFileSync(history, '');
    let stdout = '';
    let stderr = '';
    try {
      const watching = watchDeploy(
        {
          attach: port,
          history,
          // Written down as well, because that is the half a deploy step reads:
          // the reload that changed nothing has to be a line it can follow.
          daemon: daemonLog,
          waitMs: 2_000,
          path: '/',
          busyRate: 4,
          maxInFlight: 2,
          requestTimeoutMs: 2_000,
        },
        {
          out: (text: string) => {
            stdout += text;
          },
          err: (text: string) => {
            stderr += text;
          },
        },
      );
      // The record lands AFTER the watch has read the history for the first time,
      // because everything already in the file is the deploy's past and none of it
      // is this watch's to report.
      await until(
        () => /waiting for the first swap|already in the history/.test(stderr),
        5_000,
        'the watch attached and read the history it was pointed at',
      );
      writeFileSync(
        history,
        historyOf(line({ outcome: 'kept', swappedAt: null, closedBy: null, windowUsedMs: null, leftoverConnections: 0 })),
      );

      const code = await watching;
      expect(code, `the watch exited ${code}\n${stderr}`).toBe(2);
      // Reported, with the reason, and with no problem against the deploy's name:
      // the door is the only thing that can fail this watch.
      expect(stderr).toMatch(/swap 1: NOT JUDGED — the reload never swapped the port \(kept\)/);
      expect(stderr).toMatch(/SWAP_VERDICT=NOTHING_JUDGED swaps=0\/1 watched=1 .* problems=0/);
      expect(stderr).toMatch(
        /1 reload\(s\) landed while the watch was up and not one of them was a swap it could judge — there is nothing to report about the door/,
      );
      expect(stderr).not.toMatch(/problem: /);
      expect(stdout).toMatch(/SWAP_VERDICT=NOTHING_JUDGED/);

      // The daemon log carries the same account: the reload that never swapped,
      // then the summary that ends it — and no problem anywhere in either.
      const logged = readFileSync(daemonLog, 'utf8').trim().split('\n').map((text) => JSON.parse(text) as Record<string, unknown>);
      expect(logged).toHaveLength(2);
      expect(logged[0]).toMatchObject({ swap: 1, judged: false, outcome: 'kept', swappedAt: null, problems: [] });
      expect((logged[0].why as string)).toMatch(/the reload never swapped the port \(kept\)/);
      expect(logged[1]).toMatchObject({ verdict: 'NOTHING_JUDGED', watched: 1, judged: 0, problems: [] });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it('fails the same watch when proof of a swap was demanded, because nothing to judge is not a yes', async () => {
    // The same deploy and the same reload that changes nothing — with a pipeline
    // that gave `--require-swap`, whose question is not "was the door kind?" but
    // "did this deploy prove it can swap the port under load?". A watch that judged
    // nothing cannot answer that yes, so it fails with the reason instead of
    // abstaining. Nothing about the reload changes: it is still reported as NOT
    // JUDGED, because the flag is about the watch's verdict and not about the
    // deploy's reload.
    const sockets = new Set<Socket>();
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('serving\n');
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    const port = await freePort();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
    const dir = mkdtempSync(join(tmpdir(), 'anybase-watch-required-'));
    const history = join(dir, 'reloads.jsonl');
    const daemonLog = join(dir, 'swaps.jsonl');
    writeFileSync(history, '');
    let stdout = '';
    let stderr = '';
    try {
      const watching = watchDeploy(
        {
          attach: port,
          history,
          daemon: daemonLog,
          requireSwap: true,
          waitMs: 2_000,
          path: '/',
          busyRate: 4,
          maxInFlight: 2,
          requestTimeoutMs: 2_000,
        },
        {
          out: (text: string) => {
            stdout += text;
          },
          err: (text: string) => {
            stderr += text;
          },
        },
      );
      await until(
        () => /waiting for the first swap|already in the history/.test(stderr),
        5_000,
        'the watch attached and read the history it was pointed at',
      );
      writeFileSync(
        history,
        historyOf(line({ outcome: 'kept', swappedAt: null, closedBy: null, windowUsedMs: null, leftoverConnections: 0 })),
      );

      const code = await watching;
      expect(code, `the watch exited ${code}\n${stderr}`).toBe(1);
      // It says at the start that it is holding the deploy to this, so a person
      // reading the log as it was written knows what the end of it will mean.
      expect(stderr).toMatch(/\[watch\] --require-swap: a watch that judges no swap at all will FAIL/);
      expect(stderr).toMatch(/swap 1: NOT JUDGED — the reload never swapped the port \(kept\)/);
      expect(stderr).toMatch(/SWAP_VERDICT=FAIL swaps=0\/1 watched=1 .* problems=1/);
      expect(stderr).toMatch(
        /problem: --require-swap asked this watch to prove the deploy swapped the port under load, and it judged no swap: 1 reload\(s\) landed while it was up and every one of them changed nothing at the door/,
      );
      expect(stdout).toMatch(/SWAP_VERDICT=FAIL/);

      // The daemon log carries the demand too, so a reader that only ever sees the
      // file knows why a FAIL arrived with nothing at the door in it.
      const logged = readFileSync(daemonLog, 'utf8').trim().split('\n').map((text) => JSON.parse(text) as Record<string, unknown>);
      expect(logged).toHaveLength(2);
      expect(logged[0]).toMatchObject({ swap: 1, judged: false, outcome: 'kept', problems: [] });
      expect(logged[1]).toMatchObject({
        verdict: 'FAIL',
        watched: 1,
        judged: 0,
        requireSwap: true,
        problems: [expect.stringContaining('--require-swap asked this watch to prove')],
      });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});

describe("the app's own side of a loss, read as it lands", () => {
  /** A door that answers, so the watch attaches to something real; nothing else is its job. */
  const serving = async () => {
    const sockets = new Set<Socket>();
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('serving\n');
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    const port = await freePort();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
    return {
      port,
      stop: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  };

  /** A pool that holds nothing: a loss is what these cases are about, not the hold. */
  const emptyPool: typeof startHeldPool = () => ({ across: () => null, entries: [], stop: async () => [] });

  /**
   * A traffic driver that is only an account of what the door did: the watch reads
   * `stats.answers` when it judges a swap, so the loss is placed by this test rather than
   * timed by a load generator.
   */
  const driverWith = (answers: Record<string, unknown>[]) => {
    const driver = {
      stats: { requests: answers.length, answers, byStatus: { 503: answers.length }, timeouts: 0, errors: 0 },
      stop: async () => null,
    };
    return { driver, traffic: (() => driver) as unknown as typeof startTraffic };
  };

  /** One client of this watch's own traffic, answered 503 at the swap — a lost client. */
  const lostClient = () => {
    const at = Date.now();
    return { phase: 'deploy', startedAt: at - 60, connectedAt: at - 55, finishedAt: at - 20, opened: 63, status: 503 };
  };

  it('writes what the app said on the live line, at the loss, and carries it in the account', async () => {
    // The line a person reads while the deploy is still going says WHY the loss looks the way
    // it does: here the app answered this client 503, so nothing was cut off on its side and
    // the loss is the answer the door would not carry back. That reading is the app's own
    // output — the file a deploy's supervisor writes beside its history — read at the instant
    // the loss lands rather than at the end of the watch.
    const doorServing = await serving();
    const dir = mkdtempSync(join(tmpdir(), 'anybase-watch-applog-'));
    const history = join(dir, 'reloads.jsonl');
    const appLog = join(dir, 'server.log');
    const daemonLog = join(dir, 'swaps.jsonl');
    writeFileSync(history, '');
    // The app's own output, as it stands when the swap happens: its request line for this
    // client, with the answer it gave it.
    writeFileSync(
      appLog,
      ' GET /?_warm=1 200 in 1ms (next.js: 1ms)\n GET /?_client=63 503 in 4ms (next.js: 1ms)\n',
    );
    const { driver, traffic } = driverWith([]);
    const pages: { endpoint: string; body: Record<string, any> }[] = [];
    let stdout = '';
    let stderr = '';
    try {
      const watching = watchDeploy(
        {
          attach: doorServing.port,
          history,
          daemon: daemonLog,
          alert: 'https://hooks.example.test/watch',
          swaps: 1,
          waitMs: 5_000,
          path: '/',
          busyRate: 4,
          maxInFlight: 1,
          requestTimeoutMs: 1_000,
          json: true,
        },
        {
          out: (text: string) => {
            stdout += text;
          },
          err: (text: string) => {
            stderr += text;
          },
          traffic,
          pool: emptyPool,
          deliver: async (endpoint, body) => {
            pages.push({ endpoint, body: body as Record<string, any> });
            return { delivered: true, status: 202, error: null, said: '' };
          },
        },
      );
      await until(
        () => /waiting for the first swap|already in the history/.test(stderr),
        5_000,
        'the watch attached and read the history it was pointed at',
      );
      driver.stats.answers.push(lostClient());
      appendFileSync(history, historyOf(line({ swappedAt: new Date().toISOString() })));
      const code = await watching;

      expect(code, `the watch exited ${code}\n${stderr}`).toBe(1);
      // Where the watch is reading from is said at the start, so a person following the log
      // knows a loss will be explained rather than only named.
      expect(stderr).toContain(`app output: ${appLog}`);
      // The line itself: the client named by its ordinal, then the app's own words, then the
      // reading — the same sentence the timeline prints under this loss afterwards.
      expect(stderr).toContain(
        "the app's own log (server.log) names this client on 1 line(s): GET /?_client=63 503 in 4ms (next.js: 1ms) — " +
          "ANSWERED (503): the client got an answer on every line it has here, so nothing was cut off on the app's side — " +
          'the loss is the status it got (503), not a silence',
      );

      // …and the account the pipeline reads says the same thing, rather than only the stderr
      // a person happened to be watching: the reading rides on the loss in the per-swap object.
      const summary = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '{}') as Record<string, any>;
      const spent = summary.swaps[0].atTheDoor.spent[0];
      expect(spent.client).toBe(63);
      expect(spent.app).toMatchObject({ log: 'server.log', total: 1 });
      expect(spent.app.lines).toEqual(['GET /?_client=63 503 in 4ms (next.js: 1ms)']);
      expect(spent.app.classification).toMatchObject({ shape: 'answered', statuses: [503] });
      expect(pages).toHaveLength(1);
      expect(pages[0].endpoint).toBe('https://hooks.example.test/watch');
      expect(pages[0].body.appSide).toEqual([
        { client: 63, reading: spent.app.classification.why },
      ]);
      expect(pages[0].body.text).toContain('app side: _client=63 — ANSWERED (503)');
      // The external alert carries the app-side reason too, but not the raw request line (which
      // might contain private URL/query data). Its compact client handle and classification are
      // enough to tell on-call whether the app answered or left the request unfinished.
      expect(JSON.stringify(pages[0].body)).not.toContain('GET /?_client=63');

      // The daemon log is the same object appended to a file, so a deploy step following it
      // gets the reading too rather than a named client it has to classify for itself.
      const logged = readFileSync(daemonLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((text) => JSON.parse(text) as Record<string, any>);
      const swapLine = logged.find((entry) => entry.swap === 1);
      expect(swapLine?.atTheDoor.spent[0].app.classification.shape).toBe('answered');
    } finally {
      await doorServing.stop();
    }
  }, 30_000);

  it('gives a client the output does not name yet one short second look before calling it the app\'s silence', async () => {
    // The app's lines reach the file through somebody else's pipe while the loss is read from
    // a record a different process wrote, so "nothing names this client" and "nothing has been
    // WRITTEN about it yet" are one short wait apart. Here the line arrives after the watch's
    // first read and inside its grace: the loss is still explained, as the answer the app gave
    // rather than as a silence it did not cause.
    const doorServing = await serving();
    const dir = mkdtempSync(join(tmpdir(), 'anybase-watch-applog-late-'));
    const history = join(dir, 'reloads.jsonl');
    const appLog = join(dir, 'server.log');
    writeFileSync(history, '');
    writeFileSync(appLog, ' GET /?_warm=1 200 in 1ms (next.js: 1ms)\n');
    const { driver, traffic } = driverWith([]);
    let stdout = '';
    let stderr = '';
    const late = setTimeout(() => {
      appendFileSync(appLog, ' GET /?_client=63 503 in 4ms (next.js: 1ms)\n');
    }, 150);
    try {
      const watching = watchDeploy(
        {
          attach: doorServing.port,
          history,
          swaps: 1,
          waitMs: 5_000,
          path: '/',
          busyRate: 4,
          maxInFlight: 1,
          requestTimeoutMs: 1_000,
          json: true,
        },
        {
          out: (text: string) => {
            stdout += text;
          },
          err: (text: string) => {
            stderr += text;
          },
          traffic,
          pool: emptyPool,
        },
      );
      await until(
        () => /waiting for the first swap|already in the history/.test(stderr),
        5_000,
        'the watch attached and read the history it was pointed at',
      );
      driver.stats.answers.push(lostClient());
      appendFileSync(history, historyOf(line({ swappedAt: new Date().toISOString() })));
      const code = await watching;
      clearTimeout(late);

      expect(code, `the watch exited ${code}\n${stderr}`).toBe(1);
      expect(stderr).toContain(
        "the app's own log (server.log) names this client on 1 line(s): GET /?_client=63 503 in 4ms (next.js: 1ms) — " +
          'ANSWERED (503)',
      );
      expect(stderr).not.toContain('NO LINE AT ALL');
      const summary = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '{}') as Record<string, any>;
      expect(summary.swaps[0].atTheDoor.spent[0].app.classification.shape).toBe('answered');
    } finally {
      clearTimeout(late);
      await doorServing.stop();
    }
  }, 30_000);

  it('reads the loss out of an output file the deploy rotated under it, rather than calling the client absent', async () => {
    // A deploy outlives the file it started in: `server.log` is renamed to `server.log.1` and a
    // new one is started. The line for the client this swap costs was written before the rename,
    // so a reader that opened the path afresh would find an empty file and say the request never
    // reached the app — the one finding the app's own answer contradicts.
    const doorServing = await serving();
    const dir = mkdtempSync(join(tmpdir(), 'anybase-watch-applog-rotated-'));
    const history = join(dir, 'reloads.jsonl');
    const appLog = join(dir, 'server.log');
    const daemonLog = join(dir, 'swaps.jsonl');
    writeFileSync(history, '');
    writeFileSync(appLog, ' GET /?_client=63 503 in 4ms (next.js: 1ms)\n');
    const { driver, traffic } = driverWith([]);
    let stdout = '';
    let stderr = '';
    try {
      const watching = watchDeploy(
        {
          attach: doorServing.port,
          history,
          daemon: daemonLog,
          swaps: 1,
          waitMs: 5_000,
          path: '/',
          busyRate: 4,
          maxInFlight: 1,
          requestTimeoutMs: 1_000,
          json: true,
        },
        {
          out: (text: string) => {
            stdout += text;
          },
          err: (text: string) => {
            stderr += text;
          },
          traffic,
          pool: emptyPool,
        },
      );
      await until(() => /app output: /.test(stderr), 5_000, 'the watch read the app output at the start');
      // The rotation, exactly as logrotate's create mode leaves it: the old file renamed, a new
      // one started. The client's line is only in the renamed file now.
      renameSync(appLog, `${appLog}.1`);
      writeFileSync(appLog, '');

      driver.stats.answers.push(lostClient());
      appendFileSync(history, historyOf(line({ swappedAt: new Date().toISOString() })));
      const code = await watching;

      expect(code, `the watch exited ${code}\n${stderr}`).toBe(1);
      expect(stderr).toContain(
        "the app's own log (server.log) names this client on 1 line(s): GET /?_client=63 503 in 4ms (next.js: 1ms) — " +
          'ANSWERED (503)',
      );
      expect(stderr).not.toContain('UNSEEN');
      expect(stderr).not.toContain('NO LINE AT ALL');

      const summary = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '{}') as Record<string, any>;
      const spent = summary.swaps[0].atTheDoor.spent[0];
      expect(spent.client).toBe(63);
      expect(spent.app.classification).toMatchObject({ shape: 'answered', statuses: [503] });
      expect(spent.app.gaps).toEqual([]);
      const alert = JSON.parse(stdout.trim().split('\n').filter(Boolean)[0] ?? '{}') as Record<string, any>;
      expect(alert).toMatchObject({
        alert: {
          destination: 'pagerduty',
          findings: 1,
        },
      });
      const logged = readFileSync(daemonLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((text) => JSON.parse(text) as Record<string, any>);
      expect(logged.find((entry) => entry.swap === 1)?.atTheDoor.spent[0].app.classification.shape).toBe('answered');
    } finally {
      await doorServing.stop();
    }
  }, 30_000);

  it('says the log was replaced when it was truncated under the watch, instead of blaming the app', async () => {
    // copytruncate leaves no `.1` behind: the lines written before the cut are simply gone. The
    // client this swap cost may have been answered into them, so the absence is the log's — and
    // the watch says `UNSEEN` rather than the `NO LINE AT ALL` that means the request never
    // reached the app at all.
    const doorServing = await serving();
    const dir = mkdtempSync(join(tmpdir(), 'anybase-watch-applog-truncated-'));
    const history = join(dir, 'reloads.jsonl');
    const appLog = join(dir, 'server.log');
    const daemonLog = join(dir, 'swaps.jsonl');
    writeFileSync(history, '');
    writeFileSync(appLog, ' GET /?_warm=1 200 in 1ms (next.js: 1ms)\n');
    const { driver, traffic } = driverWith([]);
    let stdout = '';
    let stderr = '';
    try {
      const watching = watchDeploy(
        {
          attach: doorServing.port,
          history,
          daemon: daemonLog,
          swaps: 1,
          waitMs: 5_000,
          path: '/',
          busyRate: 4,
          maxInFlight: 1,
          requestTimeoutMs: 1_000,
          json: true,
        },
        {
          out: (text: string) => {
            stdout += text;
          },
          err: (text: string) => {
            stderr += text;
          },
          traffic,
          pool: emptyPool,
        },
      );
      await until(() => /app output: /.test(stderr), 5_000, 'the watch read the app output at the start');
      // Cut in place and rewritten: the previous content is gone, not renamed.
      writeFileSync(appLog, ' GET /?_warm=2 200 in 1ms (next.js: 1ms)\n');

      driver.stats.answers.push(lostClient());
      appendFileSync(history, historyOf(line({ swappedAt: new Date().toISOString() })));
      const code = await watching;

      expect(code, `the watch exited ${code}\n${stderr}`).toBe(1);
      expect(stderr).toContain(
        "the app's own log (server.log) names no line for this client, and cannot be read whole — " +
          "UNSEEN: the app's own output was replaced (rotated or truncated) while the watch was reading it",
      );
      expect(stderr).not.toContain('NO LINE AT ALL');

      const summary = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '{}') as Record<string, any>;
      const spent = summary.swaps[0].atTheDoor.spent[0];
      expect(spent.app.classification).toMatchObject({ shape: 'unseen', total: 0 });
      expect(spent.app.gaps.map((gap: { kind: string }) => gap.kind)).toEqual(['rotated']);
      const logged = readFileSync(daemonLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((text) => JSON.parse(text) as Record<string, any>);
      expect(logged.find((entry) => entry.swap === 1)?.atTheDoor.spent[0].app.classification.shape).toBe('unseen');
    } finally {
      await doorServing.stop();
    }
  }, 30_000);
});

describe('where a person gets told when the door costs a client an answer', () => {
  /** The finding every case below is about: a client answered 503 at a swap. */
  const finding = {
    dedupKey: 'anybase-swap-watch:3000:./reloads.jsonl',
    frontPort: 3000,
    history: './reloads.jsonl',
    swap: 2,
    outcome: 'replaced',
    swappedAt: new Date(1_200).toISOString(),
    problem: 'swap 2: a client in flight across the port change was answered 503',
    judged: 2,
    watched: 2,
    inFlight: 3,
    lost: 1,
    appSide: [{ client: 63, reading: "ANSWERED (503): the loss is the status it got (503), not a silence" }],
  };
  type AlertBody = {
    routing_key?: string;
    event_action?: string;
    dedup_key?: string;
    dedupKey?: string;
    text?: string;
    problem?: string;
    appSide?: { client: number | null; reading: string }[];
    frontPort?: number;
    payload?: { summary?: string; source?: string; severity?: string; custom_details?: Record<string, unknown> };
  };
  /** A pool that holds nothing, so a swap under test has no connection across it. */
  const emptyPool: typeof startHeldPool = () => ({ across: () => null, entries: [], stop: async () => [] });

  it('builds a PagerDuty trigger, and the same account for any other endpoint', () => {
    const pager = swapAlertBody('pagerduty', 'RK', finding) as AlertBody;
    expect(pager.routing_key).toBe('RK');
    expect(pager.event_action).toBe('trigger');
    expect(pager.dedup_key).toBe(finding.dedupKey);
    expect(pager.payload?.summary).toMatch(/the front door on :3000 cost a client an answer at swap 2/);
    expect(pager.payload?.source).toBe('anybase-swap-watch:3000');
    // A client was cost an answer, which is not the same thing as the site being
    // down: the severity says so rather than crying wolf.
    expect(pager.payload?.severity).toBe('error');
    expect(pager.payload?.custom_details).toMatchObject({
      swap: 2,
      outcome: 'replaced',
      problem: finding.problem,
      lost: 1,
      dedupKey: finding.dedupKey,
      appSide: finding.appSide,
    });
    expect(pager.payload?.custom_details?.appSide).toEqual(finding.appSide);
    expect(JSON.stringify(pager.payload)).not.toContain("GET /?");
    // The routing key is a credential: it is in the body it has to be in, and nowhere
    // else in the alert — not in the payload, not in the details.
    expect(JSON.stringify(pager.payload)).not.toContain('RK');

    const generic = swapAlertBody('https://hooks.example.test/T1/B2', '', finding) as AlertBody;
    expect(generic.routing_key).toBeUndefined();
    // `text` is the field a chat webhook renders; the structure rides beside it.
    expect(generic.text).toContain('cost a client an answer at swap 2 — swap 2: a client in flight across the port change was answered 503');
    expect(generic.text).toContain('app side: _client=63 — ANSWERED (503): the loss is the status it got (503), not a silence');
    expect(generic.problem).toBe(finding.problem);
    expect(generic.appSide).toEqual(finding.appSide);
    // The account's own vocabulary, not PagerDuty's: the generic body is the same
    // object the summary and the daemon log carry.
    expect(generic.dedupKey).toBe(finding.dedupKey);
    expect(generic.dedup_key).toBeUndefined();

    // Only PagerDuty has a resolve: a plain endpoint has no idea what one means.
    expect(swapAlertResolution('pagerduty', 'RK', finding.dedupKey)).toEqual({
      routing_key: 'RK',
      event_action: 'resolve',
      dedup_key: finding.dedupKey,
    });
    expect(swapAlertResolution('https://hooks.example.test/T1/B2', '', finding.dedupKey)).toBeNull();
  });

  it('posts it to a real endpoint, and only asks again when asking again could help', async () => {
    const seen: { url?: string; body: string; contentType?: string }[] = [];
    let answer = 202;
    // Answers this sink owes the NEXT requests, in order: a sequence rather than a
    // timer, so what a POST is answered is decided by the harness's own bookkeeping
    // and not by the clock. A timer here is a race against a loaded machine — the
    // first POST arriving after the flag had already flipped would read as "the
    // retry never happened" when it is the test that never asked for one.
    const owed: number[] = [];
    const sockets = new Set<Socket>();
    const sink = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        const status = owed.length > 0 ? (owed.shift() as number) : answer;
        seen.push({ url: req.url, body, contentType: req.headers['content-type'] });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: status === 202 ? 'success' : 'nope' }));
      });
    });
    sink.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    const port = await freePort();
    await new Promise<void>((resolve) => sink.listen(port, '127.0.0.1', () => resolve()));
    const dead = await freePort();
    const url = `http://127.0.0.1:${port}/v2/enqueue`;
    const body = { routing_key: 'RK', event_action: 'trigger', dedup_key: finding.dedupKey };
    try {
      const accepted = await deliverSwapAlert(url, body, { retryMs: 5 });
      expect(accepted).toMatchObject({ delivered: true, status: 202, error: null });
      expect(seen).toHaveLength(1);
      expect(seen[0].contentType).toBe('application/json');
      expect(JSON.parse(seen[0].body)).toEqual(body);

      // Their side having a moment is worth one more ask: 500 for this POST, 202 for
      // the one the retry makes.
      owed.push(500, 202);
      seen.length = 0;
      expect((await deliverSwapAlert(url, body, { retryMs: 250 })).delivered).toBe(true);
      expect(seen).toHaveLength(2);

      // This watch's own mistake (a dead URL, a revoked key) is not: asking again
      // repeats it, and the answer is reported rather than swallowed.
      answer = 400;
      seen.length = 0;
      const refused = await deliverSwapAlert(url, body, { retryMs: 250 });
      expect(refused).toMatchObject({ delivered: false, status: 400 });
      expect(refused.error).toMatch(/400/);
      expect(seen).toHaveLength(1);

      // Nothing listening at all: said, not thrown — the watch is attached to
      // somebody's live deploy and must survive its own pager being unreachable.
      const unreachable = await deliverSwapAlert(`http://127.0.0.1:${dead}/v2/enqueue`, body, { retryMs: 5, timeoutMs: 500 });
      expect(unreachable.delivered).toBe(false);
      expect(unreachable.error).toBeTruthy();
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => sink.close(() => resolve()));
    }
  }, 30_000);

  it('pages the moment the door costs a client an answer, and says so in the account', async () => {
    // A watch on a serving door, with the routing key in the environment and the
    // delivery injected: WHEN it fires and WHAT it sends is what is being tested here
    // (the wire has its own case above). The pool is faked to hold nothing, which is
    // one of the door's own findings — a swap no client was carried across — and
    // therefore a thing to page about.
    const calls: { endpoint: string; body: AlertBody }[] = [];
    const sockets = new Set<Socket>();
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('serving\n');
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    const port = await freePort();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
    const dir = mkdtempSync(join(tmpdir(), 'anybase-watch-alert-'));
    const history = join(dir, 'reloads.jsonl');
    writeFileSync(history, '');
    let stdout = '';
    let stderr = '';
    try {
      const watching = watchDeploy(
        {
          attach: port,
          history,
          alert: 'pagerduty',
          json: true,
          waitMs: 2_500,
          path: '/',
          busyRate: 6,
          maxInFlight: 2,
          requestTimeoutMs: 2_000,
        },
        {
          out: (text: string) => {
            stdout += text;
          },
          err: (text: string) => {
            stderr += text;
          },
          env: { [PAGERDUTY_ROUTING_KEY_ENV]: 'rk-under-test' },
          deliver: async (endpoint, body) => {
            calls.push({ endpoint, body: body as AlertBody });
            return { delivered: true, status: 202, error: null, said: '{"status":"success"}' };
          },
          pool: emptyPool,
        },
      );
      await until(
        () => /waiting for the first swap|already in the history/.test(stderr),
        5_000,
        'the watch attached and read the history it was pointed at',
      );
      writeFileSync(history, historyOf(line({ swappedAt: new Date().toISOString() })));

      const code = await watching;
      expect(calls, `the watch said:\n${stderr}`).toHaveLength(1);
      expect(calls[0].endpoint).toBe(PAGERDUTY_EVENTS_URL);
      expect(calls[0].body.routing_key).toBe('rk-under-test');
      expect(calls[0].body.event_action).toBe('trigger');
      expect(calls[0].body.payload?.severity).toBe('error');
      // The finding itself travels: whoever is woken can read what happened without
      // opening the log on the machine that paged them.

      expect(calls[0].body.payload?.custom_details?.appSide).toEqual([]);
      expect(stderr).toMatch(/alert delivered for swap 1/);
      // The page changed nothing about the verdict: the door's own finding already
      // made it a failure, and a page that could not be sent would not have.
      expect(code, stderr).toBe(1);

      const summary = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>;
      expect(summary.alert).toMatchObject({
        destination: PAGERDUTY_EVENTS_URL,
        sent: 1,
        failed: 0,
        error: null,
        // Nothing to resolve: this run found the door costing a client an answer.
        resolved: false,
      });
      expect((summary.alert as { findings: number }).findings).toBeGreaterThanOrEqual(1);
      expect(stderr).toMatch(/alerting: 1 of 1 finding\(s\) alerted/);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it('does not page for a demand with nothing to judge — that is the pipeline\'s business, not on-call\'s', async () => {
    const calls: string[] = [];
    const sockets = new Set<Socket>();
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('serving\n');
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    const port = await freePort();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
    const dir = mkdtempSync(join(tmpdir(), 'anybase-watch-alert-silent-'));
    const history = join(dir, 'reloads.jsonl');
    writeFileSync(history, '');
    let stdout = '';
    let stderr = '';
    try {
      const watching = watchDeploy(
        {
          attach: port,
          history,
          alert: 'pagerduty',
          requireSwap: true,
          json: true,
          waitMs: 2_000,
          path: '/',
          busyRate: 4,
          maxInFlight: 2,
          requestTimeoutMs: 2_000,
        },
        {
          out: (text: string) => {
            stdout += text;
          },
          err: (text: string) => {
            stderr += text;
          },
          env: { [PAGERDUTY_ROUTING_KEY_ENV]: 'rk-under-test' },
          deliver: async (endpoint) => {
            calls.push(endpoint);
            return { delivered: true, status: 202, error: null, said: '' };
          },
          pool: emptyPool,
        },
      );
      await until(() => /waiting for the first swap|already in the history/.test(stderr), 5_000, 'attached');
      // A reload that changed nothing, and a pipeline that demanded proof: the run
      // fails, and nobody is woken for it.
      writeFileSync(
        history,
        historyOf(line({ outcome: 'kept', swappedAt: null, closedBy: null, windowUsedMs: null, leftoverConnections: 0 })),
      );

      const code = await watching;
      expect(code, stderr).toBe(1);
      expect(calls).toEqual([]);
      expect(stderr).toMatch(/nothing else does/);
      const summary = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>;
      expect(summary.alert).toMatchObject({ findings: 0, sent: 0, failed: 0, resolved: false });
      expect(JSON.stringify(summary)).not.toMatch(/rk-under-test/);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it('refuses to start a PagerDuty watch with no routing key rather than start one that cannot page', () => {
    const result = spawnSync(
      process.execPath,
      ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', SOAK_SCRIPT, '--attach', '1', '--history', 'reloads.jsonl', '--alert', 'pagerduty'],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, [PAGERDUTY_ROUTING_KEY_ENV]: '' } },
    );
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toMatch(/--alert pagerduty: no routing key in PAGERDUTY_ROUTING_KEY/);
  });

  it(
    'pages a real endpoint from the real command line when a real door costs a client an answer',
    { timeout: 120_000 },
    async () => {
      // The whole thing, as a deploy would meet it: the watch as a process, a front
      // door it did not start, and a sink on the wire — the door is told to hold
      // nothing, which is the 503 this feature exists to be woken by.
      const pages: { body: AlertBody }[] = [];
      const sinkSockets = new Set<Socket>();
      const sink = createHttpServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          pages.push({ body: JSON.parse(body || '{}') as AlertBody });
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'success', message: 'Event processed' }));
        });
      });
      sink.on('connection', (socket) => {
        sinkSockets.add(socket);
        socket.on('close', () => sinkSockets.delete(socket));
      });
      const sinkPort = await freePort();
      await new Promise<void>((resolve) => sink.listen(sinkPort, '127.0.0.1', () => resolve()));
      const sinkUrl = `http://127.0.0.1:${sinkPort}/page`;

      const backendSockets = new Set<Socket>();
      const backend = createHttpServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('serving\n');
      });
      backend.on('connection', (socket) => {
        backendSockets.add(socket);
        socket.on('close', () => backendSockets.delete(socket));
      });
      const backendPort = await freePort();
      await new Promise<void>((resolve) => backend.listen(backendPort, '127.0.0.1', () => resolve()));

      const port = await freePort();
      const front = new FrontDoor({ port, host: '127.0.0.1' });
      await front.listen();
      front.setTarget(backendPort);
      const dir = mkdtempSync(join(tmpdir(), 'anybase-watch-alert-live-'));
      const history = join(dir, 'reloads.jsonl');
      writeFileSync(history, '');
      const watch = spawn(
        process.execPath,
        [
          '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
          SOAK_SCRIPT,
          '--attach',
          String(port),
          '--history',
          history,
          '--alert',
          sinkUrl,
          // A client in the band the swap is judged over, so the finding is the one
          // this test is about rather than the watch failing to put one there.
          '--busy-rate',
          '20',
          '--wait',
          '12000',
          '--json',
        ],
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      watch.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      watch.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      try {
        await until(() => /watching the front door/.test(stderr), 30_000, 'the watch attached to the door');
        // The swap this feature is about: the door with nothing behind it, so the
        // clients at it are handed the 503 the watch is judged against.
        front.setTarget(null);
        appendFileSync(history, historyOf(line({ swappedAt: new Date().toISOString() })));
        await until(() => pages.length >= 1, 40_000, `the page arrived\n${stderr}`);

        expect(pages[0].body.text).toMatch(/cost a client an answer at swap 1/);
        // The door's own finding, in its own words: a client that had the port in its
        // hands while it changed hands, handed a 503.
        // The door's own finding, in its own words: a client that had the port in its
        // hands when it changed hands, answered 503. Which of the door's two names for
        // that arrives is the driver's own timing around the swap instant rather than
        // anything this test is about — a connection the door accepted before the
        // change and answered after it is "in flight across" it, one it accepted after
        // is "at" it, and with nothing behind the door both are the same 503 — so both
        // names read the same here and the page is pinned on the finding itself.
        expect(pages[0].body.problem).toMatch(/a client (in flight across|at) the port change was answered 503/);
        expect(pages[0].body.frontPort).toBe(port);
        expect(pages[0].body.dedupKey).toBe(`anybase-swap-watch:${port}:${history}`);
        // A plain endpoint gets the account and no PagerDuty credential field.
        expect(pages[0].body.routing_key).toBeUndefined();
        expect(pages[0].body.dedup_key).toBeUndefined();

        const code = await new Promise<number | null>((resolve) => watch.on('close', resolve));
        const summary = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '{}') as Record<string, unknown>;
        // The door did cost a client an answer, so the run failed — and the page went
        // out for it.
        expect(code, `the watch exited ${code}\n${stderr}`).toBe(1);
        expect(summary.alert).toMatchObject({ destination: sinkUrl, sent: 1, failed: 0, resolved: false });
        expect(summary.verdict).toBe('FAIL');
      } finally {
        stopTree(watch);
        for (const socket of sinkSockets) socket.destroy();
        await new Promise<void>((resolve) => sink.close(() => resolve()));
        for (const socket of backendSockets) socket.destroy();
        await new Promise<void>((resolve) => backend.close(() => resolve()));
        await front.close();
      }
    },
  );
});

describe('the pool of connections the watch keeps open', () => {
  it('hands back the connection that was across an instant, and holds one for the next swap', async () => {
    const backend = async (status: number) => {
      const sockets = new Set<Socket>();
      const server = createHttpServer((_req, res) => {
        res.writeHead(status, { 'content-type': 'text/plain' });
        res.end(`backend ${status}\n`);
      });
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      const port = await freePort();
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
      return {
        port,
        stop: async () => {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
      };
    };

    const serving = await backend(200);
    const replacement = await backend(404);
    const port = await freePort();
    const front = new FrontDoor({ port, host: '127.0.0.1' });
    await front.listen();
    const pool = startHeldPool(port, { pollMs: 20 });
    try {
      front.setTarget(serving.port);
      await until(() => pool.entries.length >= 1 && pool.entries[0].acceptedAt !== null, 5_000, 'a connection was held');
      const first = pool.entries[0];
      const swapAt = Date.now();
      expect(pool.across(swapAt)).toBe(first);

      // The swap, and the retirement of the run that connection was piped to.
      front.setTarget(replacement.port);
      await serving.stop();
      await until(() => first.endedAt !== null, 5_000, 'the retired run took its connection with it');
      // The connection that was open AT the swap is still the answer for it — that
      // is the whole reason the pool keeps the recent past.
      expect(pool.across(swapAt)).toBe(first);
      expect(pool.across(swapAt).final ?? null).toBeNull();
      // ...and by now there is one for the next swap, on the run serving it.
      await until(() => pool.entries.length >= 2 && pool.entries[1].acceptedAt !== null, 5_000, 'the pool held another connection');
      expect(pool.across(Date.now())).toBe(pool.entries[1]);
      // Nothing accepted after the instant is ever the answer for it.
      expect(pool.across(first.acceptedAt - 1)).toBeNull();
    } finally {
      await pool.stop();
      await front.close();
      await replacement.stop();
    }
  });
});

describe('the soak, end to end', () => {
  it(
    'performs reloads back to back through all three traffic phases and finds nothing leaked',
    { timeout: 180_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-soak-test-'));
      const counter = join(dir, 'runs.txt');
      const history = join(dir, 'reloads.jsonl');
      const child = spawn(
        process.execPath,
        [
          '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
          SOAK_SCRIPT,
          '--reloads',
          '5',
          // The soak's own, shorter ceiling: a quiet window does not have to cost
          // a minute and a half for the phase to be exercised.
          '--window-ms',
          '4000',
          '--min-ms',
          '1200',
          '--dir',
          dir,
          '--json',
          '--server',
          `"${process.execPath}" "${FIXTURE}"`,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            // The fixture is a long-running server for this: nothing here is
            // testing a crash, and a run that exited on its own would be one.
            FAKE_STAY_MS: '600000',
            FAKE_COUNTER_FILE: counter,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

      const summary = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>;
      expect(code, `soak exited ${code}\n${stderr}`).toBe(0);
      expect(summary.verdict).toBe('PASS');
      expect(summary.problems).toEqual([]);
      expect(summary.performed).toBe(5);
      expect(summary.records).toBe(5);
      expect(summary.byPhase).toEqual({ busy: 2, trickle: 2, quiet: 1 });
      expect(summary.outcomes).toEqual(['replaced']);
      // Every phase's own branch of the window was exercised, and the door never
      // cost a client its answer.
      expect(summary.closedBy).toMatchObject({ traffic: 2, clock: 3 });
      expect(summary.byStatus).toEqual({ 200: expect.any(Number) });
      expect(summary.timeouts).toBe(0);
      expect(summary.connectionErrors).toBe(0);
      expect(summary.requests).toBeGreaterThan(20);

      // Every swap reported what it had at the door, and nothing was lost at any of
      // them — a busy reload's clients are the ones the claim is about, so at least
      // one of the five had to have one.
      const swaps = summary.swapsAtTheDoor as { index: number; phase: string; band: number; inFlight: number; lost: number }[];
      expect(swaps).toHaveLength(5);
      expect(swaps.every((swap) => swap.lost === 0)).toBe(true);
      expect(swaps.filter((swap) => swap.phase === 'busy').every((swap) => swap.band > 0)).toBe(true);
      expect(summary.swapsWithAClient).toBeGreaterThanOrEqual(1);

      // And the connection the soak held open across every one of them was the
      // retired run's: the door's own account says that run was still holding it
      // when it was stopped, and it ended with the run rather than with the
      // replacement.
      // Every reload's hold is accounted for as the facts a door claim is judged on,
      // and the account is complete enough to diagnose one from it: whether a
      // connection was accepted at all, what was said to it while the run it was
      // piped to was serving, when it ended and why, whether that ending came before
      // the count the door took, and the count itself.
      const details = summary.reloadsDetail as {
        startedAt: string | null;
        swappedAt: string | null;
        held: {
          shape: string;
          accepted: boolean;
          acceptedAt: string | null;
          answered: { status: number | string; at: string }[];
          answeredBeforeSwap: boolean;
          endedAt: string | null;
          endedReason: string | null;
          endedBeforeSwap: boolean;
          endedBeforeCount: boolean | null;
          runGaveUp: boolean;
          afterStop: string;
          leftoverConnections: number;
        };
        retiredPort: number | null;
      }[];
      for (const detail of details) {
        expect(detail.held).toBeTruthy();
        // The block says which shape it is, so a reader knows rather than infers: this is
        // the marker both readers read the answers from (`HELD_SHAPE`).
        expect(detail.held.shape).toBe(HELD_SHAPE);
        expect(detail.held.accepted).toBe(true);
        expect(detail.held.endedBeforeSwap).toBe(false);
        // WHEN the door took the connection, which is a fact of its own: it is opened
        // BEFORE the reload is asked for (the run serving the port at that moment is the
        // run it is piped to), so an account can be read as one incident on one clock
        // rather than the hold being a clause on the swap.
        expect(Date.parse(String(detail.held.acceptedAt))).toBeLessThan(Date.parse(String(detail.startedAt)));
        // ...and each answer is one object with its own status and instant, so there is no
        // pairing to drift: the placement is what a timeline needs, while whether an answer
        // is a finding stays the aggregate flag's business, because a trend line has no swap
        // instant to compare one against (see `saidTo` in scripts/check-soak-trend.mjs).
        for (const answer of detail.held.answered) {
          expect(answer).toMatchObject({ status: expect.any(Number), at: expect.any(String) });
          expect(Number.isFinite(Date.parse(answer.at))).toBe(true);
          expect(Date.parse(answer.at)).toBeGreaterThanOrEqual(Date.parse(String(detail.swappedAt)) - 1);
        }
        expect(detail.held.leftoverConnections).toBeGreaterThanOrEqual(1);
        expect(detail.held.afterStop).not.toMatch(/^2\d\d$/);
        // The ordinary shape of a hold that was never disturbed: nothing was said to it
        // while the run it was piped to was serving — the door's retry-503 for a
        // connection whose run has gone is the one answer that is not a finding, and it
        // comes after the swap (see `heldConnectionProblems`) — the run did not give up
        // on the request it never finished, and it says how it ended and when.
        expect(detail.held.answered.map((answer) => answer.status).every((status) => status === 503)).toBe(true);
        expect(detail.held.answeredBeforeSwap).toBe(false);
        expect(detail.held.runGaveUp).toBe(false);
        expect(detail.held.endedAt).toEqual(expect.any(String));
        expect(typeof detail.held.endedReason).toBe('string');
      }

      // The history itself, read the way the gate reads it.
      expect(existsSync(history)).toBe(true);
      const records = readFileSync(history, 'utf8')
        .trim()
        .split('\n')
        .map((text) => JSON.parse(text) as { schema: string; outcome: string });
      expect(records).toHaveLength(5);
      expect(records.every((record) => record.schema === RELOAD_HISTORY_SCHEMA)).toBe(true);
      expect(records.every((record) => record.outcome === 'replaced')).toBe(true);

      // And the runs are all gone: five reloads started six servers in all.
      expect(readFileSync(counter, 'utf8')).toBe('6');

      // And the run recorded itself, beside the history it was measured from: the
      // per-reload cost a slow regression moves first, grouped by phase and in the
      // order the reloads happened, plus how they ended and what they ran on. One
      // run leaves one line — that is the whole accumulation mechanism, and the gate
      // in scripts/check-soak-trend.mjs is what reads a file of them.
      const trend = join(dir, 'soak-trend.jsonl');
      expect(existsSync(trend)).toBe(true);
      const trendRecords = readFileSync(trend, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, any>);
      expect(trendRecords).toHaveLength(1);
      expect(trendRecords[0]).toMatchObject({
        schema: SOAK_TREND_SCHEMA,
        verdict: 'PASS',
        profile: { platform: process.platform, arch: process.arch, node: process.versions.node.split('.')[0] },
        reloads: { asked: 5, performed: 5, records: 5 },
        outcomes: { replaced: 5 },
      });
      expect(Object.keys(trendRecords[0].durations).sort()).toEqual(['busy', 'quiet', 'trickle']);
      expect(trendRecords[0].durations.trickle.every((ms: number) => Number.isFinite(ms) && ms > 0)).toBe(true);
      // `floors` is present and empty at five reloads (a floor needs four readings of
      // a phase): the field is the trend's, and it does not borrow the soak's verdict.
      expect(trendRecords[0].floors).toEqual({});

      // ...and the trend line carries the same holds, per reload and in the run's own
      // order, with the port the door's count was about: the account that OUTLIVES the
      // run is what a red door claim has to be diagnosable from, without the summary
      // that only exists for the run that produced it.
      const trendHeld = trendRecords[0].held as {
        index: number;
        phase: string;
        retiredPort: number;
        shape: string;
        accepted: boolean;
        acceptedAt: string;
        answered: { status: number | string; at: string }[];
        leftoverConnections: number;
      }[];
      expect(trendHeld).toHaveLength(5);
      expect(trendHeld.map((entry) => entry.index)).toEqual([1, 2, 3, 4, 5]);
      // The marker is on the line too, so the trend file is readable without the summary
      // it was projected from.
      expect(trendHeld.every((entry) => entry.shape === HELD_SHAPE)).toBe(true);
      expect(trendHeld.map((entry) => entry.phase)).toEqual(summary.phases);
      expect(trendHeld.every((entry) => entry.accepted === true)).toBe(true);
      expect(trendHeld.map((entry) => entry.retiredPort)).toEqual(details.map((detail) => detail.retiredPort));
      expect(trendHeld.map((entry) => entry.leftoverConnections)).toEqual(details.map((detail) => detail.held.leftoverConnections));
      // The instants travel with the facts they belong to, because the line is a copy of
      // the reload's own block rather than a second reading of the same connection: a
      // timeline built from this file alone places the hold where it was taken.
      expect(trendHeld.map((entry) => entry.acceptedAt)).toEqual(details.map((detail) => detail.held.acceptedAt));
      expect(trendHeld.map((entry) => entry.answered)).toEqual(details.map((detail) => detail.held.answered));
    },
  );

  // The two loss shapes are COUNTED — the Nth client a run is handed — and the count is
  // where their safety lives: a request this tooling makes for itself is a check and not a
  // client, so it neither advances the count nor gets spent, which is what keeps a shape
  // from being spent on the soak's own readiness probe. Both facts are the fixture's own,
  // and it can be asked them directly: one process, no door, no supervisor, a second or
  // two. Everything the shapes are FOR is asserted on real soaks below.
  it(
    'counts the clients a loss shape spends, and never a check',
    { timeout: 30_000 },
    async () => {
      /**
       * The fixture, alone on a port of its own, up and answering. Its shapes are about
       * clients of the app, so this is what one is: an unmarked request, which is what the
       * soak's traffic asks and what the supervisor's probe and the soak's readiness probe
       * are not.
       */
      const serve = async (env: Record<string, string>) => {
        const child = spawn(process.execPath, [FIXTURE], {
          env: { ...process.env, FAKE_PORT: '0', FAKE_STAY_MS: '60000', ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (chunk) => (output += chunk.toString()));
        child.stderr.on('data', (chunk) => (output += chunk.toString()));
        await until(() => /listening on \d+/.test(output), 10_000, 'the fixture listened');
        return { child, output: () => output, port: Number(/listening on (\d+)/.exec(output)![1]) };
      };

      // The count itself, and the check that must not advance it.
      const answers = await serve({ FAKE_LOSE_RUNS: '1', FAKE_AFTER_CLIENTS: '2' });
      try {
        // A check — the marker the supervisor's probe and the soak's readiness probe both
        // carry — is answered like any other request and is NOT a client.
        expect((await untilAnswered(answers.port, '/?_warm=1', 5_000)).answer).toEqual({ status: 200 });
        // This is the run's FIRST client, and it is answered: had the check above advanced
        // the count, this one would have been the second and been spent instead.
        expect((await untilAnswered(answers.port, '/first-client', 5_000)).answer).toEqual({ status: 200 });
        // ...and the second client is the one the shape costs, with no answer at all.
        const spent = await untilAnswered(answers.port, '/second-client', 5_000);
        expect(spent.answer?.status).toBeNull();
        expect(spent.answer?.error).toMatch(/no status line|ECONNRESET|EPIPE|ECONNABORTED/);
        // The fixture says which client it cost, which is the count in its own words.
        await until(
          () => /\[fake\] run 1 cost a client its answer — \/second-client closed with no reply/.test(answers.output()),
          5_000,
          'the fixture named the client it cost',
        );
      } finally {
        stopTree(answers.child);
      }

      // The other shape: the Nth client's request is left STANDING — nothing written into
      // it and nothing ending it — and exactly one client is left that way, since the run
      // is otherwise as healthy as it ever was.
      const stalled = await serve({ FAKE_STALL_RUNS: '1' });
      try {
        const left = await untilAnswered(stalled.port, '/left-standing', 400);
        expect(left.answer).toBeNull();
        expect(left.ended()).toBeNull();
        await until(
          () => /\[fake\] run 1 stalled a client — \/left-standing left with no answer/.test(stalled.output()),
          5_000,
          'the fixture named the client it stalled',
        );
        left.close();
        // The client after it is served: one client, not every client.
        expect((await untilAnswered(stalled.port, '/after-the-stall', 5_000)).answer).toEqual({ status: 200 });
      } finally {
        stopTree(stalled.child);
      }
    },
  );

  // A soak through this fixture never loses a client, so the one count that says what the
  // door did to the clients AT a swap — `swapsAtTheDoor[].lost`, the number
  // `soak:diagnose` reads as `clients lost` — was a zero nothing in the suite ever moved.
  // Two fixture shapes move it, and they are the two halves of the door's own claim:
  // `FAKE_LOSE_RUNS` has the run behind the chosen swap close ONE client's request with no
  // reply, which costs a client AT the port change; `FAKE_STALL_RUNS` has the run a reload
  // IS RETIRING leave one request it was already piped standing, which costs a client IN
  // FLIGHT across it, cut off at the end of the drain. Both runs come up healthy and pass
  // every check the supervisor makes straight at them, and neither of them is timed: each
  // spends the Nth CLIENT its run is handed (`FAKE_AFTER_CLIENTS`), which is a client of
  // the app's rather than the supervisor's or the soak's own probes. So the same soak is
  // run three times
  // — once as it always runs, once with each knob — and every account is read the way a
  // person reads a downloaded artifact: the door's own finding, the client count behind it,
  // and the loss rate against the run that lost nothing.
  it(
    'costs one client its answer at a chosen swap, at the port change and in flight across it',
    { timeout: 300_000 },
    async () => {
      /**
       * One soak, as the command a person runs, leaving the account the CI job uploads:
       * the history and the trend the soak wrote itself, and the summary `--json` printed
       * beside them under the name those three files are downloaded as. `knob` is the
       * fixture environment of the shape being exercised, and empty for the run that
       * loses nothing.
       */
      const soak = async (name: string, knob: Record<string, string>) => {
        const dir = mkdtempSync(join(tmpdir(), `anybase-soak-${name}-`));
        const counter = join(dir, 'runs.txt');
        const child = spawn(
          process.execPath,
          [
            '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
            SOAK_SCRIPT,
            // Two reloads: the first is busy, so its swap has clients AT it, and the
            // second closes on the clock, so the run still goes through both a window
            // the traffic closed and one the clock did.
            '--reloads',
            '2',
            '--phases',
            'busy,trickle',
            '--window-ms',
            '4000',
            '--min-ms',
            '1200',
            '--dir',
            dir,
            '--json',
            '--server',
            `"${process.execPath}" "${FIXTURE}"`,
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              FAKE_STAY_MS: '600000',
              FAKE_COUNTER_FILE: counter,
              // Which swap a loss belongs to is decided by WHICH RUN is named, and which
              // client it costs by how many that run is handed (`FAKE_AFTER_CLIENTS`) —
              // there is no arm and no delay to land inside anything. Run 2 is the
              // replacement the FIRST reload swaps in, and the first client it is handed
              // IS the first client of that swap: before the swap every connection the
              // door takes is still piped to the run it is replacing, so a run behind the
              // door is handed nothing at all until the door points at it. Run 1 is the
              // run that same reload RETIRES, so the clients it is handed are ones already
              // piped to it.
              ...knob,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
        const summary = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Record<string, any>;
        writeFileSync(join(dir, 'soak-summary.json'), `${JSON.stringify(summary)}\n`);
        const trend = readFileSync(join(dir, 'soak-trend.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((text) => JSON.parse(text) as Record<string, any>)[0];
        return { dir, code, summary, stderr, trend };
      };

      const green = await soak('kept', {});
      expect(green.code, `the soak that loses nothing exited ${green.code}\n${green.stderr}`).toBe(0);
      expect(green.summary.verdict).toBe('PASS');
      expect(green.summary.problems).toEqual([]);
      // The run that is about to be made to lose a client behaves, without the knob,
      // exactly as it always does — so what the red run's account says below is the knob
      // and not the shape of the fixture.
      expect(green.summary.outcomes).toEqual(['replaced']);
      expect(green.summary.closedBy).toEqual({ traffic: 1, clock: 1 });

      // The default count, deliberately: the first client the run is handed is the one
      // this shape is about, and it takes no environment to ask for it.
      const red = await soak('lost-at-the-swap', { FAKE_LOSE_RUNS: '2' });
      expect(red.code, `the loss soak exited ${red.code}\n${red.stderr}`).toBe(1);
      const { summary } = red;
      expect(summary.verdict).toBe('FAIL');
      // ONE finding, and it is the door's own. That is the whole claim of this shape: the
      // run behind the door stayed healthy (its reload was replaced, not rolled back, and
      // no restart was spent), so nothing else is left to blame and nothing else is named.
      // The sentence carries WHICH client as well as what happened to it: the place it had in
      // the clients this swap had at the door, and the place it had in the clients the run it
      // handed them to was handed — the run behind the door is handed nothing until the door
      // points at it, so the client this shape costs is a client of THAT run.
      expect(summary.problems).toEqual([
        expect.stringMatching(
          /^reload 1 \(busy\): a client at the port change (was answered 503|was closed with no answer at all) — the \d+(?:st|nd|rd|th) of the \d+ client\(s\) the swap had at the door — the \d+(?:st|nd|rd|th) of the \d+ client\(s\) the run it handed them to \(port \d+\) was handed — the front door holds the port and never closes it, so a swap may not cost a client its answer$/,
        ),
      ]);
      expect(summary.outcomes).toEqual(['replaced']);
      expect(summary.closedBy).toEqual({ traffic: 1, clock: 1 });
      // Every request the door took came back 200 — bar the one client, which is the
      // count the problem above is the sentence for. `!no status line` is how a client
      // whose socket the door tore down is recorded, and a 503 is how the door answers a
      // connection whose run went away before it had written anything; which of the two it
      // is is the OS's business (a RST reaches the door as an error and a FIN as a close),
      // and either way the client did not come back 200.
      const byStatus = summary.byStatus as Record<string, number>;
      expect(byStatus[200]).toBe(summary.requests - 1);
      expect(Object.entries(byStatus).filter(([status]) => status !== '200')).toEqual([
        [expect.stringMatching(/^503$|^!no status line$/), 1],
      ]);

      // The count behind that sentence, at the reload it happened at: one client lost out
      // of the clients that reload had at the door, and nothing lost at the other swap.
      const swaps = summary.swapsAtTheDoor as {
        index: number;
        phase: string;
        band: number;
        inFlight: number;
        lost: number;
        spent: {
          client: number | null;
          acceptedAt: string;
          atTheDoor: { nth: number; of: number };
          handed: { side: string; port: number | null; nth: number; of: number } | null;
        }[];
      }[];
      expect(swaps).toHaveLength(2);
      expect(swaps[0]).toMatchObject({ index: 1, phase: 'busy', lost: 1 });
      expect(swaps[0].band).toBeGreaterThan(0);
      expect(swaps[1]).toMatchObject({ index: 2, phase: 'trickle', lost: 0 });

      // WHICH client that loss was, read off the account rather than off the sentence: the
      // swap's band says where it was of the clients the swap had at the door, and the run's
      // side says which RUN's clients it was one of — here the REPLACEMENT this swap points
      // at, port and all, because the client this shape costs is one that run was handed.
      const detail = summary.reloadsDetail as { retiredPort: number; replacementPort: number }[];
      const spentAtTheSwap = swaps[0].spent;
      expect(spentAtTheSwap).toHaveLength(1);
      expect(spentAtTheSwap[0].acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(spentAtTheSwap[0].atTheDoor.of).toBe(swaps[0].band);
      expect(spentAtTheSwap[0].atTheDoor.nth).toBeGreaterThanOrEqual(1);
      expect(spentAtTheSwap[0].atTheDoor.nth).toBeLessThanOrEqual(swaps[0].band);
      expect(spentAtTheSwap[0].handed).toMatchObject({ side: 'replacement', port: detail[0].replacementPort });
      expect(spentAtTheSwap[0].handed?.of).toBeGreaterThanOrEqual(1);
      expect(spentAtTheSwap[0].handed?.nth).toBeLessThanOrEqual(spentAtTheSwap[0].handed?.of ?? 0);
      // The other swap cost nothing and says so with the empty list it has, rather than with
      // a clause about a zero.
      expect(swaps[1].spent).toEqual([]);

      // …and the account a PERSON reads says it too: the timeline of the downloaded artifact
      // itself names which client the swap spent, so "how many were lost" is never the only
      // thing a downloaded run can be asked.
      const alone = spawnSync(
        process.execPath,
        ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', DIAGNOSE_SCRIPT, red.dir],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(alone.status, `soak:diagnose exited ${alone.status}\n${alone.stderr}`).toBe(1);
      // The line is read as TEXT rather than as JSON, because that is how a person reads it: the
      // ordinal comes out of the plain sentence, and it is the account's own handle for the loss
      // rather than a number written here — which is what makes the line usable against a log.
      const namedHandle = /the (\d+(?:st|nd|rd|th)) client handed to the door \(`_client=(\d+)` in the app's own request log\)/.exec(
        alone.stdout,
      );
      expect(namedHandle, `the timeline named no client by its handle:\n${alone.stdout}`).not.toBeNull();
      expect(Number(namedHandle?.[2])).toBe(spentAtTheSwap[0].client);
      // The whole sentence, in one line and one order: the count, the NAME (read back out of the
      // sentence itself above, marker and number included), then where the client was. Plain text
      // rather than a pattern, because that is what a person copies out of the report.
      expect(alone.stdout).toContain(
        "the swap cost 1 client(s): " + String(namedHandle?.[0]) + " — the " + String(spentAtTheSwap[0].atTheDoor.nth),
      );
      expect(alone.stdout).toMatch(/ — the \d+(?:st|nd|rd|th) of the \d+ client\(s\) the run it handed them to \(port \d+\) was handed/);

      // ...and the same count on the line that OUTLIVES the run, which is where
      // `soak:diagnose` reads the door from: the summary only exists for the run that
      // produced it, and a downloaded artifact is all three files.
      expect(red.trend.door).toMatchObject({ lost: 1 });
      expect(green.trend.door).toMatchObject({ lost: 0 });
      const lostAtTheDoor = red.trend.door.clientsAtTheDoor as number;
      const keptAtTheDoor = green.trend.door.clientsAtTheDoor as number;
      expect(lostAtTheDoor).toBeGreaterThan(0);
      expect(keptAtTheDoor).toBeGreaterThan(0);
      // The run that lost one is a run that HAD clients at its swaps: without that, one
      // client lost would be no share of anything, and there would be no rate below.
      expect(lostAtTheDoor).toBeGreaterThanOrEqual(swaps[0].band);

      // Read the pair the way a regression is read. The allowance on a loss is half a
      // client of the LARGER of the two runs' samples, so the sample the line explains
      // itself with is not necessarily the one the loss was counted in — and both sides of
      // it come off the two real artifacts rather than being written here.
      const diagnose = spawnSync(
        process.execPath,
        ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', DIAGNOSE_SCRIPT, green.dir, red.dir],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(diagnose.status, `soak:diagnose exited ${diagnose.status}\n${diagnose.stderr}`).toBe(0);
      expect(diagnose.stdout).toContain('SOAK_DIFF=DIFFERENT');
      const sample = Math.max(lostAtTheDoor, keptAtTheDoor);
      const whole = (100 / sample).toFixed(1);
      const allowed = (50 / sample).toFixed(1);
      const rate = ((100 * 1) / lostAtTheDoor).toFixed(1);
      expect(diagnose.stdout).toMatch(
        new RegExp(
          `clients lost\\s+0\\.0% \\(0/${keptAtTheDoor}\\)\\s+->\\s+${rate}% \\(1/${lostAtTheDoor}\\) ` +
            `\\(\\+${rate} points, more than the ${allowed} points allowed — half a client of the ` +
            `${sample} at the door, where a whole one is worth ${whole} points\\)`,
        ),
      );

      // The same count, moved by the OTHER half of the door's claim. This knob names the
      // run a reload RETIRES rather than the one it swaps in, and leaves one request that
      // was already PIPED to that run unanswered: the run never fails a check and never
      // exits, so what ends the client is the retirement at the end of the drain. It is
      // therefore a client IN FLIGHT ACROSS the swap rather than one at it, and that is
      // the one thing about this shape the words and the counts have to say.
      //
      // The default count, and it is load-bearing here: the first client the first run is
      // handed is the first request the soak's TRAFFIC asks it for, and the soak's own
      // readiness probe is not a client at all (it carries the marker the supervisor puts
      // on its checks). Counted, the probe would be that first client and this run would
      // spend itself on a check — nobody waits on a page from it, so nothing downstream
      // would move; it would leave the soak without a loss to report rather than fail it
      // in a place that names the cause. `isSelfRequest` in the fixture is the one rule.
      const stalled = await soak('lost-in-flight', { FAKE_STALL_RUNS: '1' });
      expect(stalled.code, `the in-flight soak exited ${stalled.code}\n${stalled.stderr}`).toBe(1);
      expect(stalled.summary.verdict).toBe('FAIL');
      expect(stalled.summary.problems).toHaveLength(1);
      // Which half of the claim it was is in the sentence, and nowhere else: ONE problem,
      // the same rule, and the wording this count exists to distinguish. How the client's
      // socket ENDED is the OS's business — the door answers a connection whose run went
      // away with its own retry-503, or the client reads the ending as a reset — and, on a
      // heavily loaded machine, the client's own patience could end it first, which is
      // still a loss in flight. So the ending is asserted as one of the endings there are.
      // …and WHICH client it was, on the other side of the same reading: this shape names the
      // run a reload RETIRES, so the client it spends is one that was already PIPED to that
      // run and belongs to it, rather than to the replacement the swap points at.
      expect(stalled.summary.problems[0]).toMatch(
        /^reload 1 \(busy\): a client in flight across the port change (was answered 503|was closed with no answer at all|was refused \(ECONNRESET\)|was never answered \(the door took the connection and hung\)) — the \d+(?:st|nd|rd|th) of the \d+ client\(s\) the swap had at the door — the \d+(?:st|nd|rd|th) of the \d+ client\(s\) the run this swap retired \(port \d+\) was handed — the front door holds the port and never closes it, so a swap may not cost a client its answer$/,
      );
      // Nothing else was blamed: the run that left a request standing passed every check
      // made straight at it, so its reload was a replacement rather than a restart.
      expect(stalled.summary.outcomes).toEqual(['replaced']);
      expect(stalled.summary.closedBy).toEqual({ traffic: 1, clock: 1 });
      const stalledStatus = stalled.summary.byStatus as Record<string, number>;
      expect(stalledStatus[200]).toBe(stalled.summary.requests - 1);
      expect(Object.entries(stalledStatus).filter(([status]) => status !== '200')).toHaveLength(1);

      // The count that makes it this shape rather than the other one: the client was open
      // BEFORE the port changed hands and its answer landed after it, which is the
      // condition `swapProblems` reads as "in flight across" — and the other swap lost
      // nothing, so the loss belongs to the swap that retired the run it was piped to.
      const stalledSwaps = stalled.summary.swapsAtTheDoor as {
        index: number;
        phase: string;
        band: number;
        inFlight: number;
        lost: number;
        spent: {
          atTheDoor: { nth: number; of: number };
          handed: { side: string; port: number | null; nth: number; of: number } | null;
        }[];
      }[];
      expect(stalledSwaps).toHaveLength(2);
      expect(stalledSwaps[0]).toMatchObject({ index: 1, phase: 'busy', lost: 1 });
      expect(stalledSwaps[0].inFlight).toBeGreaterThanOrEqual(1);
      expect(stalledSwaps[1]).toMatchObject({ index: 2, phase: 'trickle', lost: 0 });
      // …and WHICH client, from the same account and the other side of the reading: the
      // client this shape costs was already piped to the run the swap RETIRED, so the loss is
      // named as one of THAT run's clients, in that run's port — which is the difference
      // between this shape and the one above, said by the account rather than by the knobs.
      const stalledDetail = stalled.summary.reloadsDetail as { retiredPort: number; replacementPort: number }[];
      const stalledSpent = stalledSwaps[0].spent;
      expect(stalledSpent).toHaveLength(1);
      expect(stalledSpent[0].atTheDoor.of).toBe(stalledSwaps[0].band);
      expect(stalledSpent[0].handed).toMatchObject({ side: 'retired', port: stalledDetail[0].retiredPort });
      expect(stalledSpent[0].handed?.of).toBeGreaterThanOrEqual(1);
      expect(stalledSpent[0].handed?.nth).toBeLessThanOrEqual(stalledSpent[0].handed?.of ?? 0);
      expect(stalledSwaps[1].spent).toEqual([]);

      // ...and the door's own account of the retirement says the same thing from the other
      // side. The count of connections still on the run the door stopped is taken before
      // the drain, so the client this shape leaves standing is still on that run when the
      // count is read: the retirement has one MORE connection to its name than the green
      // run's did. The baseline is the green run's own rather than a number written here,
      // because a retirement always has other clients on it (the connection the soak holds)
      // and it is the DIFFERENCE this shape is.
      const leftoverAt = (run: { summary: Record<string, any> }) =>
        (run.summary.reloadsDetail as { held: { leftoverConnections: number } }[])[0].held.leftoverConnections;
      expect(leftoverAt(stalled)).toBeGreaterThanOrEqual(leftoverAt(green) + 1);

      // The artifact that outlives the run carries the loss, the way the other shape's
      // does: the trend line's door block is where `soak:diagnose` reads a rate from, and
      // the rate this shape moves is the same one — a client lost is a client lost.
      expect(stalled.trend.door).toMatchObject({ lost: 1 });
      const stalledAtTheDoor = stalled.trend.door.clientsAtTheDoor as number;
      expect(stalledAtTheDoor).toBeGreaterThanOrEqual(stalledSwaps[0].band);
      const stalledDiagnose = spawnSync(
        process.execPath,
        ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', DIAGNOSE_SCRIPT, green.dir, stalled.dir],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(stalledDiagnose.status, `soak:diagnose exited ${stalledDiagnose.status}\n${stalledDiagnose.stderr}`).toBe(0);
      expect(stalledDiagnose.stdout).toContain('SOAK_DIFF=DIFFERENT');
      expect(stalledDiagnose.stdout).toMatch(
        new RegExp(
          `clients lost\\s+0\\.0% \\(0/${keptAtTheDoor}\\)\\s+->\\s+${((100 * 1) / stalledAtTheDoor).toFixed(1)}% ` +
            `\\(1/${stalledAtTheDoor}\\)`,
        ),
      );
    },
  );

  // The fixture and the account name ONE client between them rather than two clients that
  // happen to hold the same place in two different counts, and the timeline says which one it
  // is in the terms the log is keyed by. The fixture spends the Nth client
  // its run is HANDED, counted as the run receives them; the account names a run's clients off
  // the DOOR's own accepts, tie-broken by the ordinal a client was handed over at — which the
  // client itself carries into the app (`_client=` on the path the traffic asks for, see
  // `asked` and `startTraffic`) and which the account writes down with the loss
  // (`spent[].client`). So a real soak can be read back through both witnesses at once: the
  // run's own request log, one line per client it was handed with the one it cost marked, and
  // the downloaded account.
  //
  // The CLIENT is the same on both sides whatever order they arrived in, because the ordinal
  // they are named by is the same number — and the PLACES agree here too, because this soak
  // hands one client over at a time (the default rate), so the order the run receives its
  // clients is the order the door took them. Both facts have a measured edge, and neither is
  // hidden: at a burst the run can RECEIVE two clients in the reverse of the order the door
  // took them — 6 clients a tick, and one run of six had the client handed over 77th arrive
  // before the one handed over 73rd, because the door's per-client upstream connection is its
  // own TCP connection and the two handshakes can complete either way round — so the places
  // each side publishes come from its own count of that run's clients, while the client they
  // name is pinned by the ordinal on both sides regardless.
  it(
    'spends the client the account says it cost, on a real soak',
    { timeout: 300_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-soak-which-client-'));
      const requests = join(dir, 'requests.txt');
      const child = spawn(
        process.execPath,
        [
          '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
          SOAK_SCRIPT,
          '--reloads',
          '2',
          '--phases',
          'busy,trickle',
          '--window-ms',
          '4000',
          '--min-ms',
          '1200',
          // The default rate rather than a burst — one client at a time, so the order the run
          // receives its clients is the order the door took them, and the places below are a
          // reading of the same order rather than of two (see the note above for the edge).
          '--dir',
          dir,
          '--json',
          '--server',
          `"${process.execPath}" "${FIXTURE}"`,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            FAKE_STAY_MS: '600000',
            FAKE_COUNTER_FILE: join(dir, 'runs.txt'),
            // The run's own record of the clients it was handed, in the order it was handed
            // them: one line per client request, with the one it spent marked (`(cost)`, the
            // way the standing shape's client is marked when it is left standing).
            FAKE_REQUEST_LOG: requests,
            // The replacement the FIRST reload swaps in, and the THIRD client it is handed.
            FAKE_LOSE_RUNS: '2',
            FAKE_AFTER_CLIENTS: '3',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
      expect(code, `the loss soak exited ${code}\n${stderr}`).toBe(1);
      const summary = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Record<string, any>;
      expect(summary.verdict).toBe('FAIL');
      // The run's stdout IS the third file of a downloaded account rather than a second way of
      // reading the run: the `soak` job in .github/workflows/ci.yml saves it as
      // `soak-summary.json` beside `reloads.jsonl` and `soak-trend.jsonl` from `--dir`, and
      // uploads the three together — so that is the shape the account below is read in.
      writeFileSync(join(dir, 'soak-summary.json'), `${JSON.stringify(summary)}\n`);

      // The account's side of it: one client lost, named twice over — by the ordinal it was
      // handed to the door at, and by its place among the clients of the run the swap handed
      // it to.
      const swaps = summary.swapsAtTheDoor as {
        index: number;
        phase: string;
        band: number;
        lost: number;
        spent: {
          client: number | null;
          acceptedAt: string;
          atTheDoor: { nth: number; of: number };
          handed: { side: string; port: number | null; nth: number; of: number } | null;
        }[];
      }[];
      expect(swaps[0]).toMatchObject({ index: 1, phase: 'busy', lost: 1 });
      const spent = swaps[0].spent[0];
      expect(spent.handed).toMatchObject({ side: 'replacement', nth: 3 });
      expect(spent.client).toBeGreaterThanOrEqual(1);

      // The run's side of it, in the run's own words: every client request run 2 was handed,
      // in the order it was handed them. The door's checks and its replays are in this file
      // too — carrying the marker that says they are not clients — and so is the connection
      // the soak holds, whose head is never finished and which no run ever dispatches.
      const log = readFileSync(requests, 'utf8').trim().split('\n');
      const handed = log.filter((line) => line.startsWith('2 ') && !line.includes('_warm=1'));
      const ordinalOf = (line: string) => Number(/_client=(\d+)/.exec(line)?.[1]);
      const spentLine = handed.findIndex((line) => line.endsWith('(cost)'));
      expect(
        spentLine,
        `the fixture's own log of run 2 named no client it cost:\n${handed.join('\n')}`,
      ).toBeGreaterThanOrEqual(0);

      // THE SAME CLIENT, by the one handle both sides carry: the ordinal the traffic driver
      // handed it to the door at, which the client carried into the app and the account wrote
      // down with the loss.
      expect(ordinalOf(handed[spentLine])).toBe(spent.client);
      // ...and the same PLACE, from both readings: the account says the loss was the 3rd client
      // that run was handed, and the run's own log has it as the 3rd client of the run.
      expect(spentLine + 1).toBe(spent.handed?.nth);
      // The two are one order, which is what makes those two places the same client rather than
      // a coincidence: the ordinals the run was handed its clients under run in the order it was
      // handed them — a client is handed over in the order the door accepted it, and the ordinal
      // is taken when its connection is ESTABLISHED, which is when the door's queue received it
      // — so the Nth in one reading is the Nth in the other. (Read up to the client the loss is
      // about, which is the claim being made.)
      const ordinals = handed.map(ordinalOf);
      expect(ordinals.slice(0, spentLine + 1)).toEqual([...ordinals.slice(0, spentLine + 1)].sort((a, b) => a - b));
      expect(new Set(ordinals).size).toBe(ordinals.length);
      // The account's denominator is that same set of clients — the clients the door handed
      // this run — up to the one client the boundary can move: the account reads a run's tenure
      // off the instant the port changed hands, which is a millisecond, and a client the door
      // took inside that millisecond can be counted to one run here and piped to the other.
      expect(Math.abs((spent.handed?.of ?? 0) - handed.length)).toBeLessThanOrEqual(1);
      expect(handed.length).toBeGreaterThanOrEqual(3);

      // AND A PERSON GETS THAT FAR WITHOUT OPENING THE JSON. The timeline of the downloaded
      // account is printed, the handle is read out of the printed LINE (not out of the summary),
      // and that handle alone finds the client — in the run's own request log, as the one line
      // marked with what it cost. That is the whole use of naming an ordinal here: the account
      // and the log are two artifacts, and this is the number they are joined by.
      const timeline = spawnSync(
        process.execPath,
        ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', DIAGNOSE_SCRIPT, dir],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(timeline.status, `soak:diagnose exited ${timeline.status}\n${timeline.stderr}`).toBe(1);
      const printed = /the \d+(?:st|nd|rd|th) client handed to the door \(`_client=(\d+)` in the app's own request log\)/.exec(
        timeline.stdout,
      );
      expect(printed, `the timeline named no client to look up:\n${timeline.stdout}`).not.toBeNull();
      expect(Number(printed?.[1])).toBe(spent.client);
      expect(log.filter((line) => line.includes(`_client=${printed?.[1]}`))).toEqual([handed[spentLine]]);

      // …AND THE ACCOUNT CARRIES THE APP'S OWN OUTPUT, so that lookup happens inside the
      // report instead of beside it. `server.log` is what the supervisor streamed from the app,
      // which is where its request log lives; the timeline finds this client's line in it by
      // the same ordinal and prints it, so a person reading a downloaded artifact never has to
      // open the JSON to find a number and then grep a second file they may not have.
      const serverLog = readFileSync(join(dir, 'server.log'), 'utf8');
      const appLines = serverLog
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => new RegExp(`[?&]_client=${printed?.[1]}(?:&|\\s|$)`).test(line));
      // The fixture says which client it cost on its own notice, and that notice is one of the
      // lines the app wrote — so the loss is followed to the very line that describes it.
      expect(appLines, `no line in the app's own output names client ${printed?.[1]}:\n${serverLog}`).toHaveLength(1);
      expect(appLines[0]).toContain('cost a client its answer');
      expect(timeline.stdout).toContain(
        `the app's own log (server.log) names this client on 1 line(s): ${appLines[0]}`,
      );
      // …AND THE LINE IS CLASSIFIED, which is the part a person cannot do from the quote alone:
      // the fixture's notice carries no status, so the app was handed the request and never
      // finished it — the reason this loss looks like a silence rather than a wrong answer.
      expect(appLines[0]).not.toMatch(/\s[1-5]\d\d(?:\s|$)/);
      expect(timeline.stdout).toContain(' — NO ANSWER: not one line here carries a status');
    },
  );

  it('is runnable as `npm run soak:supervisor`, and the watch as `npm run watch:swaps`', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    // The same `--disable-warning` flag every script here that imports a `.ts`
    // module is run with (this Node strips the types itself).
    expect(pkg.scripts['soak:supervisor']).toBe(
      'node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/soak-supervisor.mjs',
    );
    // The watch is the same file with `--attach`, so `npm run watch:swaps -- 3000
    // --history ...` reads the way the invocation it stands in for does.
    expect(pkg.scripts['watch:swaps']).toBe(
      'node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/soak-supervisor.mjs --attach',
    );
  });

  // The `soak` job in .github/workflows/ci.yml sends this script's stdout into a
  // build artifact (`soak-summary.json`), which makes the ENTRY POINT part of the
  // contract: plain `npm run` writes its own two-line banner to stdout before the
  // script runs, so the file would not be JSON while the job stayed green. `--silent`
  // is the whole difference, and it is measured here rather than trusted to the
  // workflow — `--json` alone is not enough, which is the trap this pins shut.
  //
  // `--help` rather than a soak: the banner is emitted BEFORE the script runs,
  // whatever the script turns out to do, and a soak would prove the same thing in
  // thirty seconds.
  it('writes nothing of its own to stdout through the npm entry point the CI job uses', () => {
    const via = (args: string) => spawnSync(`npm ${args}`, { shell: true, encoding: 'utf8', cwd: process.cwd() });

    const loud = via('run soak:supervisor -- --help');
    expect(loud.stdout).toContain('> anybase@'); // npm's banner, and it is on stdout

    const quiet = via('run --silent soak:supervisor -- --help');
    // Where the script's OWN output starts is the claim: nothing of npm's came
    // first. (The usage path exits 2 by this script's own convention — asking what
    // the options are and using one wrongly share an exit code — so this test is
    // about stdout rather than about the status, which is asserted as it is.)
    expect(quiet.stdout.startsWith('Usage: node scripts/soak-supervisor.mjs')).toBe(true);
    expect(quiet.stdout).not.toContain('> anybase@');
    expect(quiet.status).toBe(2);
  });

  // The trend is the one thing here that is about RUNS rather than about one run, so
  // this pins both halves of it: that the runs accumulate in one file (the same
  // `--dir`, two soaks, two lines) and that the gate REFUSES a series that cannot
  // support a verdict. Three reloads a run is one reading a phase, and a floor needs
  // four — the exact case the `soak` job's own comment in ci.yml cites, because a
  // check that ran and judged nothing is the thing that looks green while it rots.
  it(
    'leaves a line per run for the trend gate, which refuses to read a floor from too few',
    { timeout: 240_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-soak-trend-test-'));
      const counter = join(dir, 'runs.txt');
      const soakOnce = async () => {
        const child = spawn(
          process.execPath,
          [
            '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
            SOAK_SCRIPT,
            '--reloads',
            '3',
            '--window-ms',
            '2000',
            '--min-ms',
            '1200',
            '--dir',
            dir,
            '--json',
            '--server',
            `"${process.execPath}" "${FIXTURE}"`,
          ],
          {
            cwd: process.cwd(),
            env: { ...process.env, FAKE_STAY_MS: '600000', FAKE_COUNTER_FILE: counter },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stderr = '';
        child.stderr!.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        child.stdout!.on('data', () => {});
        const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
        expect(code, `soak exited ${code}\n${stderr}`).toBe(0);
      };

      await soakOnce();
      await soakOnce();

      const trend = join(dir, 'soak-trend.jsonl');
      const records = readFileSync(trend, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, any>);
      expect(records).toHaveLength(2);
      expect(records[0].at).not.toBe(records[1].at);
      expect(records.every((record) => record.schema === SOAK_TREND_SCHEMA && record.verdict === 'PASS')).toBe(true);
      expect(records.every((record) => record.reloads.performed === 3)).toBe(true);

      const gate = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', TREND_SCRIPT, trend], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(gate.status).toBe(2);
      expect(gate.stdout).toContain('SOAK_TREND=NOT_JUDGED');
      expect(gate.stdout).toMatch(/4 readings is what the halves rule needs/);
    },
  );

  it('documents --trend where its own usage sends a reader looking, and names its reader', () => {
    // This script's `--help` is a stub that points at its header, which is where the
    // options are documented — so that header is what has to carry the flag.
    const source = readFileSync(SOAK_SCRIPT, 'utf8');
    expect(source).toContain('--trend PATH');
    expect(source).toContain('scripts/check-soak-trend.mjs');

    const result = spawnSync(
      process.execPath,
      ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', SOAK_SCRIPT, '--help'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(result.stdout).toContain('See the header of scripts/soak-supervisor.mjs');
  });

  it(
    'reports each swap of a deploy it did not start, as it lands',
    { timeout: 180_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-watch-test-'));
      const sentinel = join(dir, 'reload');
      const history = join(dir, 'reloads.jsonl');
      const counter = join(dir, 'runs.txt');
      const port = await freePort();
      // A deploy this test starts and owns: a real supervisor, a real front door,
      // performing real swaps — none of it the watch's doing, which is the point.
      const supervisor = spawn(process.execPath, [START_SCRIPT, '--port', String(port)], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PROD_RELOAD_FILE: sentinel,
          PROD_RELOAD_HISTORY: history,
          PROD_ROLLBACK_MS: '3000',
          PROD_ROLLBACK_MIN_MS: '1000',
          PROD_ROLLBACK_CONNECTIONS: '2',
          PROD_BACKOFF_MS: '20',
          PROD_BACKOFF_MAX_MS: '40',
          PROD_SERVER_CMD: `"${process.execPath}" "${FIXTURE}"`,
          FAKE_STAY_MS: '600000',
          FAKE_COUNTER_FILE: counter,
          // Run 3 — the second replacement — never listens, which is a reload that
          // changes NOTHING: the deploy keeps serving the run it already had. That
          // is a legitimate reload for the deploy to perform and it must not be a
          // finding for the watch, which is what the middle record below pins.
          FAKE_MUTE_RUNS: '3',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let supervisorLog = '';
      supervisor.stdout.on('data', (chunk) => {
        supervisorLog += chunk.toString();
      });
      supervisor.stderr.on('data', (chunk) => {
        supervisorLog += chunk.toString();
      });
      try {
        await until(
          async () => await fetch(`http://127.0.0.1:${port}/`).then((answer) => answer.status === 200).catch(() => false),
          30_000,
          'the deploy answered on its front door',
        );

        const watch = spawn(
          process.execPath,
          [
            '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
            SOAK_SCRIPT,
            '--attach',
            String(port),
            '--history',
            history,
            '--swaps',
            '2',
            '--wait',
            '90000',
            '--json',
          ],
          { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdout = '';
        let stderr = '';
        watch.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        watch.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        const lines = () => stdout.trim().split('\n').filter(Boolean);
        try {
          // Let the watch attach and get its connection open before the deploy is
          // asked to do anything: a connection accepted after a swap is not one the
          // swap can be judged on.
          await new Promise((resolve) => setTimeout(resolve, 900));
          writeFileSync(sentinel, 'reload\n');
          // The first swap has to be REPORTED while the deploy is still going to
          // perform the second: that is what makes it a watch rather than a summary.
          await until(() => lines().length >= 1, 60_000, `the first swap was reported\n${stderr}`);
          // The reload that changes nothing: real, performed by the deploy, and
          // reported by the watch — as NOT JUDGED, because the port never changed
          // hands and there is nothing at the door to judge.
          writeFileSync(sentinel, 'reload\n');
          await until(() => lines().length >= 2, 60_000, `the reload that changed nothing was reported\n${stderr}`);
          writeFileSync(sentinel, 'reload\n');
          const code = await new Promise<number | null>((resolve) => watch.on('close', resolve));

          // One object per reload as it landed, then the summary: JSONL, so a pipeline
          // can read each one without waiting for the deploy to finish.
          expect(lines(), stderr).toHaveLength(4);
          const [first, changedNothing, second, summary] = lines().map(
            (line) => JSON.parse(line) as Record<string, unknown>,
          );
          expect(code, `the watch exited ${code}\n${stderr}\n${supervisorLog}`).toBe(0);
          expect(summary.verdict).toBe('PASS');
          expect(summary.judged).toBe(2);
          // Watched, and deliberately NOT judged: the deploy reloaded and the port
          // never changed hands, so there was nothing for the door to carry and
          // nothing for the watch to fail. Only the door can fail this watch.
          expect(summary.watched).toBe(3);
          expect(summary.problems).toEqual([]);
          expect(stderr).toMatch(/SWAP_VERDICT=PASS swaps=2\/3/);
          expect(stderr).toMatch(/swap 2: NOT JUDGED — the reload never swapped the port \(kept\)/);
          expect(changedNothing.schema).toBe(SWAP_WATCH_SCHEMA);
          expect(changedNothing.judged).toBe(false);
          expect(changedNothing.outcome).toBe('kept');
          expect(changedNothing.swappedAt).toBeNull();
          expect(changedNothing.problems).toEqual([]);
          expect(changedNothing.why).toMatch(/there was no change at the door to judge/);
          for (const swap of [first, second]) {
            expect(swap.schema).toBe(SWAP_WATCH_SCHEMA);
            expect(swap.judged).toBe(true);
            expect(swap.outcome).toBe('replaced');
            // The load was on, so there were clients at the door of both swaps.
            expect((swap.atTheDoor as { band: number }).band).toBeGreaterThan(0);
            expect((swap.atTheDoor as { lost: number }).lost).toBe(0);
            // And the connection the watch was holding was the retired run's: the
            // door still had it when it stopped that run, and it ended with it.
            expect(swap.leftoverConnections as number).toBeGreaterThanOrEqual(1);
            expect((swap.held as { afterStop: string }).afterStop).not.toMatch(/^2\d\d$/);
          }
          // Three reloads, four servers started (the third one muted, so it never
          // served), and the deploy was never this test's.
          expect(readFileSync(counter, 'utf8')).toBe('4');

          // Attached to a deploy that performs no swap at all: there is nothing to
          // report about the door, and that is not a pass.
          const idle = spawnSync(
            process.execPath,
            ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', SOAK_SCRIPT, '--attach', String(port), '--history', history, '--wait', '1500'],
            { cwd: process.cwd(), encoding: 'utf8' },
          );
          expect(idle.status).toBe(2);
          expect(`${idle.stdout}${idle.stderr}`).toMatch(/no swap was judged/);

          // The same watch against the same deploy, told to demand proof: the
          // abstention becomes the failure it was asked about, and the reason
          // travels with it.
          const demanded = spawnSync(
            process.execPath,
            [
              '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
              SOAK_SCRIPT,
              '--attach',
              String(port),
              '--history',
              history,
              '--wait',
              '1500',
              '--require-swap',
            ],
            { cwd: process.cwd(), encoding: 'utf8' },
          );
          expect(demanded.status, `${demanded.stdout}${demanded.stderr}`).toBe(1);
          expect(`${demanded.stdout}${demanded.stderr}`).toMatch(/SWAP_VERDICT=FAIL/);
          expect(`${demanded.stdout}${demanded.stderr}`).toMatch(
            /problem: --require-swap asked this watch to prove the deploy swapped the port under load, and it judged no swap/,
          );
        } finally {
          stopTree(watch);
        }
      } finally {
        stopTree(supervisor);
      }
    },
  );

  it(
    "explains a real loss from the deploy's own output as it lands",
    { timeout: 120_000 },
    async () => {
      // The whole thing, on a real deploy rather than a placed answer: the deploy's own
      // output is captured to the file `--server-log` names, the swap costs a real client its
      // answer, and the watch reads the app's words about that client at the moment the loss
      // lands — not at the end of the deploy, and not out of the account afterwards.
      const dir = mkdtempSync(join(tmpdir(), 'anybase-watch-applog-live-'));
      const sentinel = join(dir, 'reload');
      const history = join(dir, 'reloads.jsonl');
      const counter = join(dir, 'runs.txt');
      const deployLog = join(dir, 'deploy.log');
      writeFileSync(deployLog, '');
      const port = await freePort();
      const supervisor = spawn(process.execPath, [START_SCRIPT, '--port', String(port)], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PROD_RELOAD_FILE: sentinel,
          PROD_RELOAD_HISTORY: history,
          PROD_ROLLBACK_MS: '3000',
          PROD_ROLLBACK_MIN_MS: '1000',
          PROD_ROLLBACK_CONNECTIONS: '2',
          PROD_BACKOFF_MS: '20',
          PROD_BACKOFF_MAX_MS: '40',
          PROD_SERVER_CMD: `"${process.execPath}" "${FIXTURE}"`,
          FAKE_STAY_MS: '600000',
          FAKE_COUNTER_FILE: counter,
          // The replacement the first reload swaps in costs the FIRST client it is handed its
          // answer — which is the client the swap itself hands it, so the loss is that
          // swap's and the app says so in its own words.
          FAKE_LOSE_RUNS: '2',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // The deploy's output, where a supervisor running it writes it down: this is the file
      // the watch is pointed at, and the only place the app's words exist for it.
      const keep = (chunk: Buffer) => {
        appendFileSync(deployLog, chunk.toString());
      };
      supervisor.stdout.on('data', keep);
      supervisor.stderr.on('data', keep);
      try {
        await until(
          async () => await fetch(`http://127.0.0.1:${port}/`).then((answer) => answer.status === 200).catch(() => false),
          30_000,
          'the deploy answered on its front door',
        );

        const watch = spawn(
          process.execPath,
          [
            '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
            SOAK_SCRIPT,
            '--attach',
            String(port),
            '--history',
            history,
            '--server-log',
            deployLog,
            '--swaps',
            '1',
            '--wait',
            '60000',
            // Enough clients that the swap has one in the band it is judged over — the one the
            // fixture spends is the first this replacement is handed.
            '--busy-rate',
            '20',
            '--json',
          ],
          { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdout = '';
        let stderr = '';
        watch.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        watch.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        try {
          await until(
            () => /app output: /.test(stderr),
            30_000,
            `the watch said where the app's output is\n${stderr}`,
          );
          await new Promise((resolve) => setTimeout(resolve, 900));
          writeFileSync(sentinel, 'reload\n');

          const code = await new Promise<number | null>((resolve) => watch.on('close', resolve));
          expect(code, `the watch exited ${code}\n${stderr}`).toBe(1);

          const summary = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '{}') as Record<string, any>;
          const spent = summary.swaps[0].atTheDoor.spent[0];
          expect(spent, `no client was lost in this run\n${stderr}`).toBeDefined();
          // The fixture's notice carries no status, so the app was handed the request and never
          // finished it: the loss is a silence on the app's side, not a wrong answer.
          expect(spent.app.classification).toMatchObject({ shape: 'unanswered' });
          expect(spent.app.lines).toHaveLength(1);
          expect(spent.app.lines[0]).toContain('cost a client its answer');

          // …and the line a person reads while the deploy is still going says the same thing,
          // quoting the app's own sentence and the ordinal that joins it to the account.
          expect(stderr).toContain(`app output: ${deployLog}`);
          const quoted = /the app's own log \(deploy\.log\) names this client on 1 line\(s\): (.*) — NO ANSWER: /.exec(stderr);
          expect(quoted, `the live line quoted no app line:\n${stderr}`).not.toBeNull();
          expect(quoted?.[1]).toBe(spent.app.lines[0]);
          expect(quoted?.[1]).toContain(`_client=${spent.client}`);
          expect(stderr).toContain('NO ANSWER: not one line here carries a status');
        } finally {
          stopTree(watch);
        }
      } finally {
        stopTree(supervisor);
      }
    },
  );

  it(
    'holds the watch open as a daemon, appending a verdict per swap to a log a deploy step can follow',
    { timeout: 180_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'anybase-watch-daemon-'));
      const sentinel = join(dir, 'reload');
      const history = join(dir, 'reloads.jsonl');
      const counter = join(dir, 'runs.txt');
      const daemonLog = join(dir, 'swaps.jsonl');
      const port = await freePort();
      // A line this test wrote itself, before the daemon existed: the log has to be
      // ADDED to (a redeployed watch continues the account) rather than started
      // again, and this is what says which of the two happened.
      const marker = JSON.stringify({ schema: SWAP_WATCH_SCHEMA, swap: 0, judged: false });
      writeFileSync(daemonLog, `${marker}\n`);
      const supervisor = spawn(process.execPath, [START_SCRIPT, '--port', String(port)], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PROD_RELOAD_FILE: sentinel,
          PROD_RELOAD_HISTORY: history,
          PROD_ROLLBACK_MS: '3000',
          PROD_ROLLBACK_MIN_MS: '1000',
          PROD_ROLLBACK_CONNECTIONS: '2',
          PROD_BACKOFF_MS: '20',
          PROD_BACKOFF_MAX_MS: '40',
          PROD_SERVER_CMD: `"${process.execPath}" "${FIXTURE}"`,
          FAKE_STAY_MS: '600000',
          FAKE_COUNTER_FILE: counter,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      try {
        await until(
          async () => await fetch(`http://127.0.0.1:${port}/`).then((answer) => answer.status === 200).catch(() => false),
          30_000,
          'the deploy answered on its front door',
        );

        const daemon = spawn(
          process.execPath,
          [
            '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
            SOAK_SCRIPT,
            '--attach',
            String(port),
            '--history',
            history,
            '--daemon',
            daemonLog,
            // A window, so the daemon ends on its own and this test can read what it
            // left behind. There is no count: that is the difference being pinned.
            '--wait',
            '30000',
          ],
          { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stderr = '';
        daemon.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        /** The log as a deploy step reads it: one JSON object per line, at any moment. */
        const logged = () =>
          readFileSync(daemonLog, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((text) => JSON.parse(text) as Record<string, unknown>);
        try {
          // Both opening lines, not just the first: each `log()` is its own write to
          // stderr, so asserting the second the moment the first arrives is a race
          // with the pipe rather than a check of anything.
          await until(
            () => /watching the front door/.test(stderr) && /daemon: appending a verdict per swap/.test(stderr),
            30_000,
            `the daemon attached and said where its verdicts are going\n${stderr}`,
          );
          expect(stderr).toMatch(/daemon: appending a verdict per swap to .* — no stopping count/);
          writeFileSync(sentinel, 'reload\n');
          // The verdict is in the FILE while the daemon is still running — followed
          // rather than waited for, which is the whole reason a log exists here.
          await until(() => logged().length >= 2, 60_000, `the first swap reached the daemon log\n${stderr}`);
          expect(daemon.exitCode).toBeNull();
          expect(logged()[0]).toEqual({ schema: SWAP_WATCH_SCHEMA, swap: 0, judged: false });

          writeFileSync(sentinel, 'reload\n');
          await until(() => logged().length >= 3, 60_000, `the second swap reached the daemon log\n${stderr}`);
          // Two swaps judged and it is still watching: no count ends this one.
          expect(daemon.exitCode).toBeNull();

          const code = await new Promise<number | null>((resolve) => daemon.on('close', resolve));
          const lines = logged();
          expect(code, `the daemon exited ${code}\n${stderr}`).toBe(0);
          // The marker the test wrote, then one line per swap, then the summary:
          // nothing was truncated, and the account ends where a reader can see it end.
          expect(lines).toHaveLength(4);
          const [first, second, summary] = lines.slice(1);
          for (const swap of [first, second]) {
            expect(swap.schema).toBe(SWAP_WATCH_SCHEMA);
            expect(swap.judged).toBe(true);
            expect(swap.outcome).toBe('replaced');
          }
          expect(summary.verdict).toBe('PASS');
          expect(summary.judged).toBe(2);
          expect(summary.watched).toBe(2);
          expect(summary.problems).toEqual([]);
          expect(summary.swaps).toHaveLength(2);
          expect(stderr).toMatch(/SWAP_VERDICT=PASS swaps=2\/2/);
        } finally {
          stopTree(daemon);
        }
      } finally {
        stopTree(supervisor);
      }
    },
  );

  it('attaches to nothing rather than reporting on a port that is not a deploy', () => {
    const port = spawnSync(process.execPath, ['-e', 'const {createServer}=require("net");const s=createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();})'], {
      encoding: 'utf8',
    });
    const dead = Number(port.stdout.trim());
    const result = spawnSync(
      process.execPath,
      ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', SOAK_SCRIPT, '--attach', String(dead), '--history', 'nowhere.jsonl', '--wait', '1000'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toMatch(/nothing is serving on \d+ \(ECONNREFUSED\)/);

    // Still a 2 with `--require-swap`: this is a watch that never got as far as a
    // verdict, so there is no "nothing to judge" for the demand to turn into a
    // failure — the check could not be run, rather than ran and answered no.
    const demanded = spawnSync(
      process.execPath,
      ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', SOAK_SCRIPT, '--attach', String(dead), '--history', 'nowhere.jsonl', '--wait', '1000', '--require-swap'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(demanded.status).toBe(2);
    expect(`${demanded.stdout}${demanded.stderr}`).toMatch(/nothing is serving on \d+ \(ECONNREFUSED\)/);
  });

  it('refuses to soak what it cannot supervise, rather than reporting a pass', () => {
    // A build is what the default server needs, and this is the same door the
    // real run goes through: pointed at a directory with no .next, it says so.
    const empty = mkdtempSync(join(tmpdir(), 'anybase-soak-nobuild-'));
    writeFileSync(join(empty, 'keep'), '');
    const result = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', SOAK_SCRIPT, '--reloads', '1'], {
      cwd: empty,
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toMatch(/there is no production build to soak/);
  });
});
