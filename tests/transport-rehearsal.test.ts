/**
 * The transport rehearsal, pinned.
 *
 * `scripts/rehearse-transports.mjs` asks the two transports of the simulated GitHub
 * (`scripts/rehearse-sentinel-stub.ps1` for PowerShell, `installFetchShim()` for Node)
 * the same questions and compares the answers, because the claim those transports are
 * written on — a fact about the world cannot mean two things depending on which
 * language asked — had never been rehearsed. The sentinel rehearsal drove one, the
 * lifecycle drove the other, and BOTH WERE GREEN, which is what "green on each, and
 * disagreeing with each other" looks like.
 *
 * The execution is a leg of the `rehearsals` job in ci.yml (see the last describe);
 * what these pins hold is the part that could rot silently:
 *
 *   - the fixture asks the questions where the two transports CAN disagree — a
 *     one-element array (which PowerShell unrolls into a single object with no
 *     `.Count`), an empty one, and a refusal — read off the committed baseline rather
 *     than listed here, so the load-bearing shapes cannot be edited away;
 *   - both halves are the SHIPPED code, not a copy of it, and each side reads its own
 *     world file: a mutation on one side must not be readable as agreement on the
 *     other;
 *   - a real run reproduces the committed baseline, line for line, which is the claim
 *     the parity job makes in CI.
 *
 * What is NOT pinned here: that the transports agree on all nine cases. That is the
 * rehearsal's own job — `npm run rehearse:transports`, exit 1 on any disagreement —
 * and the leg of the `rehearsals` job runs it in CI. The live check below is scoped to
 * one case on purpose: each case boots a PowerShell engine AND the node child it asks,
 * so all nine would add ten seconds to every run of this suite to re-derive what the
 * pins above already hold and CI already executes.
 */

import { describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_GOLDEN_DIR,
  EVIDENCE_PATH_LINES,
  REPORT_MARKERS,
  collect,
  collectGolden,
  compareToBaseline,
  project,
} from '../scripts/rehearsal-parity.mjs';
// The world's own zip writer and wire form, so the artifact case can be checked against what
// the world really serves rather than against a length typed into a test.
import { envelope, zipEntry } from '../scripts/rehearse-world.mjs';
// And the recovery pass's zip reader, which is what has to be able to open it.
import { unzipEntry } from '../scripts/recover-verdicts.mjs';

const root = process.cwd();
const source = (file: string) => readFileSync(path.join(root, file), 'utf8');
const script = path.join(root, 'scripts', 'rehearse-transports.mjs');
const parity = path.join(root, 'scripts', 'rehearsal-parity.mjs');
const scriptSource = source(path.join('scripts', 'rehearse-transports.mjs'));
const actorSource = source(path.join('scripts', 'rehearse-transport-actor.ps1'));
// DEFAULT_GOLDEN_DIR is already absolute: joining it onto the root would double the
// path on Windows, where path.join does not treat the second half as a root.
const baseline = readFileSync(path.join(DEFAULT_GOLDEN_DIR, 'rehearsal-transports.txt'), 'utf8');

type Case = {
  name: string;
  about: string;
  uri: string;
  method?: string;
  web?: boolean;
  /** The one case that is not a comparison of two answers: see the driver's header. */
  bytes?: { entry: string; powershellMust: string };
};
const fixture = JSON.parse(source(path.join('scripts', 'transport-rehearsal.json'))) as {
  raw: Record<string, string>;
  artifacts: { id: number; run: number; log: string; body: string }[];
  cases: Case[];
};

/**
 * The engine the rehearsal would resolve, or nothing on a machine with no PowerShell —
 * where the leg reports its reason instead of rehearsing, and this file skips rather
 * than failing for a missing prerequisite (the same reason rehearse-pwsh.mjs exits 2
 * there rather than 0).
 */
const engine = ['pwsh', 'powershell'].find(
  (command) => !spawnSync(command, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).error,
);
const run = (...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', timeout: 120_000 });

/** The lines the committed baseline holds that report what a case delivered. */
const delivered = baseline.split('\n').filter((line) => line.startsWith('TRANSPORT OK'));

describe('the transport rehearsal declares what it compares', () => {
  it('names every case, once, and says what each one is about', () => {
    const names = fixture.cases.map((testCase) => testCase.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size, 'a name is how a failure points at a case').toBe(names.length);
    for (const testCase of fixture.cases) {
      expect(testCase.about, `${testCase.name}: no about`).toBeTruthy();
      expect(typeof testCase.uri, `${testCase.name}: no uri`).toBe('string');
    }
    // Read off the baseline rather than listed here: the rehearsal exists for the
    // shapes where the two transports CAN disagree, so the report has to show it asked
    // for at least one response of each of them. Dropping the one-element case would
    // leave the unrolling hazard — the reason every script wraps a response in
    // `@(...)` — rehearsed by nothing.
    expect(delivered.filter((line) => line.endsWith('1 item(s)')).length, 'no one-element response').toBeGreaterThan(0);
    expect(delivered.some((line) => line.endsWith('0 item(s)')), 'no empty response').toBe(true);
    expect(delivered.some((line) => line.includes('the same refusal')), 'no refusal').toBe(true);
    expect(delivered.some((line) => line.includes('the same file')), 'no raw file').toBe(true);
    expect(delivered.some((line) => line.includes('refusing the bytes')), 'no download').toBe(true);
  });

  it('asks for bytes in exactly one case, and names the reason PowerShell must give', () => {
    // The one case that is not a comparison of two answers. It is DECLARED rather than
    // inferred: a future case that quietly stopped being compared with the other transport's
    // answer would leave this suite reporting "both sides did something" for a route both
    // sides can carry, which is the kind of agreement that hides a difference.
    expect(fixture.cases.filter((testCase) => testCase.bytes).map((testCase) => testCase.name)).toEqual([
      'artifact-zip',
    ]);
    const declared = fixture.cases.find((testCase) => testCase.bytes)!.bytes!;
    // The reason is the STUB's, not the fixture's invention: a transport that stopped
    // refusing bytes would have to be met by rewriting this case, not by it passing anyway.
    const stub = source(path.join('scripts', 'rehearse-sentinel-stub.ps1'));
    expect(stub, `${declared.powershellMust}: the fixture names a reason the transport does not give`).toContain(
      declared.powershellMust,
    );
    // And the entry it pulls out is the world's, so the recovered text is the log the world
    // put there rather than whatever arrived: the case finds it by the id in the request.
    const id = /\/artifacts\/(\d+)\/zip/.exec(fixture.cases.find((testCase) => testCase.bytes)!.uri)?.[1];
    const artifact = fixture.artifacts.find((candidate) => String(candidate.id) === id);
    expect(artifact, 'the fixture has no artifact for the bytes case').toBeDefined();
    expect(artifact!.log).toBe(declared.entry);
  });

  it('pins the artifact case to the world, so a fixture edit cannot leave a stale baseline', () => {
    // This case compares Node against the WORLD rather than against the other transport, so
    // changing what the world's log says still passes the case — and only the committed
    // baseline notices. That makes the baseline's byte count part of the pin: computed here
    // through the same zipEntry the world serves, so the file and the fixture cannot drift.
    const artifact = fixture.artifacts[0];
    const zip = zipEntry(artifact.log, artifact.body);
    const line = delivered.find((candidate) => candidate.includes('artifact-zip'));
    expect(line, 'the baseline does not record the artifact case').toBeDefined();
    expect(line).toContain(`a ${zip.length}-byte zip`);
    expect(line).toContain(`${artifact.body.length} character(s)`);
    expect(line).toContain(artifact.log);
  });

  it('is the only route in the fixture one transport cannot carry', () => {
    // The asymmetry is about BYTES, not about the suite tolerating disagreement: every other
    // case must still be asked of both transports and compared with each other.
    const world = fixture.cases.filter((testCase) => !testCase.bytes);
    expect(world.length).toBeGreaterThan(5);
    expect(fixture.cases.filter((testCase) => testCase.bytes).length).toBe(1);
  });

  it('only asks for bytes the world actually serves, and raw files it holds', () => {
    // `web` is which SURFACE the request is made through (Invoke-WebRequest against a raw
    // URL), not where the world answers it from: a raw-file case is served out of `raw`,
    // and the download out of `artifacts` (pinned by the bytes case below). A case the
    // world has no entry for is an unrouted request — it would rehearse both transports
    // failing, a far weaker question than the verifiers' live upstream compare.
    const rawCases = fixture.cases.filter((testCase) => testCase.web && !testCase.bytes);
    expect(rawCases.length, 'the verifiers read raw files; nothing does here').toBeGreaterThan(0);
    for (const testCase of rawCases) {
      expect(Object.keys(fixture.raw ?? {}), `${testCase.name}: the world cannot serve it`).toContain(testCase.uri);
    }
    for (const testCase of fixture.cases.filter((candidate) => candidate.bytes)) {
      expect(Object.keys(fixture.raw ?? {}), `${testCase.name}: a download is not a raw file`).not.toContain(
        testCase.uri,
      );
    }
  });
});

describe('both halves are the transports the tools really run against', () => {
  it('dot-sources the PowerShell stub and loads the Node shim, rather than copying either', () => {
    expect(actorSource, 'the PowerShell half must be the stub the cron tools run against').toContain(
      ". (Join-Path $PSScriptRoot 'rehearse-sentinel-stub.ps1')",
    );
    expect(scriptSource, 'the Node half must be the shim the Node tools run against').toMatch(
      /import \{ installFetchShim \} from "\.\/rehearse-world\.mjs"/,
    );
    expect(scriptSource, 'and must load it').toMatch(/installFetchShim\(/);
    // The driver asks through the transports, never through the router directly: a
    // driver that imported `route` would be comparing a copy of the transport with
    // the transport.
    expect(scriptSource, 'the driver must not call the router itself').not.toMatch(/\broute\(/);
  });

  it('gives each side its own world, so agreement cannot be an echo', () => {
    expect(scriptSource).toMatch(/const psWorld = writeWorld\("powershell"\)/);
    expect(scriptSource).toMatch(/const nodeWorld = writeWorld\("node"\)/);
    expect(scriptSource, 'the two sides must not share a ledger either').toMatch(/powershell\.ledger/);
  });

  it('reads what the CALLER received, because that is the claim under rehearsal', () => {
    // `@($value)` is what every script does with a response, so it is what is
    // compared: one element arrives as ONE object here and as an array of one in
    // Node, and the count must be 1 on both sides. A transport that tidied that into
    // a consistent array would rehearse a kinder GitHub than the real one.
    expect(actorSource).toMatch(/\$items = @\(\$value\)/);
    expect(actorSource).toMatch(/count = \$items\.Count/);
  });

  it('carries one binary fact two ways, and both decode to the same openable zip', () => {
    // Bytes leave the world as base64 in the envelope (the PowerShell side's wire form) and
    // as raw bytes through the fetch shim (the Node side's), and nothing compared the two
    // DECODINGS of the same download. They are one fact in two encodings, so a change to
    // either would leave one transport reading a different artifact than the other — which
    // is the difference this whole rehearsal exists to make visible.
    const artifact = fixture.artifacts[0];
    const zip = zipEntry(artifact.log, artifact.body);
    const decoded = Buffer.from(JSON.parse(envelope({ status: 200, kind: "binary", data: zip })).base64, "base64");
    expect(decoded.equals(zip), 'the envelope does not carry the zip').toBe(true);
    // Opening it is the standard the artifact case holds the Node side to: the recovery pass
    // is what reads a real download, so "the bytes arrived" has to mean "this is openable".
    expect(unzipEntry(decoded, artifact.log)?.toString('utf8')).toBe(artifact.body);
  });

  const WORLD = path.join(root, 'scripts', 'rehearse-world.mjs');
  const SENTINEL_FIXTURE = path.join(root, 'scripts', 'sentinel-rehearsal.json');
  // A child boot plus a connect, on a machine the whole suite is competing for.
  const SESSION = 30_000;

  type SessionAnswer = { kind: string; out?: string; error?: string; envelope?: { status: number } };

  /**
   * A world child this test owns, on its own endpoint, with its own lifetime pipe.
   *
   * The endpoint is what a rehearsal's processes use, so the test uses it too: a pipe belongs
   * to the caller that started the process, and the claim this leg needs to reach is that ANY
   * process in the run can ask the child directly.
   */
  const startSession = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'world-endpoint-'));
    // Windows named pipes live in their own namespace; elsewhere the endpoint is a socket FILE,
    // in a directory the child creates for itself with 0700 - hence the nested path, which the
    // session has to make rather than the test.
    const endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\rehearsal-world-${path.basename(dir)}`
        : path.join(dir, 'sock', 'world.sock');
    const child = spawn(process.execPath, [WORLD, 'session', '--endpoint', endpoint], {
      // stdin is the lifetime pipe; stdout and stderr are INHERITED because they are not wires
      // any more - every answer travels on the endpoint - and a bind failure has to be visible
      // instead of written into a buffer nobody reads.
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    return {
      endpoint,
      child,
      /** Close the lifetime pipe - the whole of the stop - and hand back the exit code. */
      stop: async () => {
        child.stdin?.end();
        const [code] = (await once(child, 'exit')) as [number | null, unknown];
        rmSync(dir, { recursive: true, force: true });
        return code;
      },
    };
  };

  /**
   * One client of a session, over the endpoint the run published - the wire
   * scripts/rehearse-world-session.ps1 opens: one frame per line, one answer per line, each
   * base64 of UTF-8 JSON. A connection of its own per caller is the point of the endpoint.
   */
  const connectSession = async (owned: { endpoint: string; child: ChildProcess }) => {
    const deadline = Date.now() + 20_000;
    let client: Socket | null = null;
    while (!client) {
      try {
        client = await new Promise<Socket>((resolve, reject) => {
          const attempt = connect(owned.endpoint);
          attempt.once('connect', () => resolve(attempt));
          attempt.once('error', reject);
        });
      } catch (error) {
        // A child that is still binding is not a failure; a child that has EXITED is, and naming
        // which of the two it was is the difference between a slow machine and a broken run.
        if (owned.child.exitCode !== null) throw error;
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const socket = client;
    let buffered = '';
    const waiting: Array<{ resolve: (answer: SessionAnswer) => void; reject: (error: Error) => void }> = [];
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      let at = buffered.indexOf('\n');
      while (at !== -1) {
        const pending = waiting.shift();
        const line = buffered.slice(0, at).trim();
        buffered = buffered.slice(at + 1);
        at = buffered.indexOf('\n');
        if (pending) pending.resolve(JSON.parse(Buffer.from(line, 'base64').toString('utf8')) as SessionAnswer);
      }
    });
    socket.on('error', (error: Error) => {
      let pending = waiting.shift();
      while (pending) {
        pending.reject(error);
        pending = waiting.shift();
      }
    });
    return {
      /** One question, one answer. A string is a raw line, which is how the refusal is asked for. */
      ask: (frame: unknown) =>
        new Promise<SessionAnswer>((resolve, reject) => {
          waiting.push({ resolve, reject });
          const line =
            typeof frame === 'string' ? frame : Buffer.from(JSON.stringify(frame), 'utf8').toString('base64');
          socket.write(`${line}\n`);
        }),
      close: () => socket.end(),
    };
  };

  it('reaches ONE world child as a CLIENT, on the endpoint the run published', () => {
    const stub = source(path.join('scripts', 'rehearse-sentinel-stub.ps1'));
    const session = source(path.join('scripts', 'rehearse-world-session.ps1'));
    // One node boot per REQUEST was most of the cost of a small question, and the rehearsals ask
    // hundreds; one child per WORLD was almost as bad - the sentinel rehearsal walks seventeen of
    // them, and kept a materialiser beside them running the same file for the same run. ONE child
    // answers both roles now, and the transport reaches it as a CLIENT: it connects to the run's
    // endpoint and neither starts nor stops anything (that is the owner's business).
    expect(stub, 'the transport must not boot node per request').not.toMatch(/& node @arguments/);
    expect(stub, 'the transport owns no child of its own').not.toMatch(/ProcessStartInfo/);
    expect(stub, 'it asks the session instead').toMatch(/'rehearse-world-session\.ps1'/);
    // One CONNECTION per process, reused for every question: a client that reconnected per
    // question would pay the connect (and, on a named pipe, the handshake) for each one, which
    // is one level down the same cost this file exists to remove.
    expect(session, 'and the session must reuse one connection').toMatch(
      /if \(\$null -ne \$global:RehearsalWorldClient\) \{ return \$global:RehearsalWorldClient \}/,
    );
    // NOT `$script:` scope. These functions are dot-sourced into a scope the CALLER sets up
    // and discards - the rehearsal's host (scripts/rehearse-sentinel-host.ps1) dot-sources the
    // stub inside a per-request command scope and invokes the sentinel from there - while the
    // connection has to outlive that request. A `$script:` variable is not where a function
    // called from the sentinel resolves, which is how this change's first version read its
    // timeout back empty and timed every request out. The scope is pinned, not just the name.
    expect(session, 'the connection must survive the scopes its callers throw away').not.toMatch(/\$script:RehearsalWorld/);
    // And loading is idempotent for the same reason: that per-request dot-source re-runs this
    // file, so a load that reset its state would forget the run's endpoint and its connection -
    // one connect per scenario, which is the cost the connection exists to remove.
    expect(session, 'loading must be idempotent').toMatch(/if \(-not \$global:RehearsalWorldSessionLoaded\)/);
    // ONE OWNER, everyone else a client: the rule is one environment variable, and a client that
    // finds no child says the run is broken rather than quietly starting a second one.
    expect(session, 'the owner is the process the run did not hand an endpoint').toMatch(/return -not \$env:REHEARSAL_WORLD_SESSION/);
    expect(session, 'a client that finds no child names the reason').toMatch(/REHEARSAL_ROUTER_UNAVAILABLE \(no world child for this run/);
    // The world is not an argument the child is started with: it travels with each question.
    // That is what makes one child enough for a rehearsal that moves the world between
    // scenarios, where a child holding the world it was started with would have to be replaced.
    expect(session, 'the world travels with the question').toMatch(/world  = \$World/);
    expect(session, 'and no world is baked into the child').not.toMatch(/--world/);
    // The endpoint is LOCAL on both platforms and unique per run: no port is opened, nothing
    // leaves the machine, and two concurrent rehearsals cannot reach each other's child.
    expect(session, 'a named pipe on Windows, reachable only by this user').toMatch(/System\.IO\.Pipes\.NamedPipeClientStream/);
    // And the pipe's NAME is taken off the endpoint by hand, never with Split-Path: asked for the
    // leaf of `\\.\pipe\<name>`, Windows PowerShell 5.1 answers with an EMPTY string, and the
    // client then fails to construct (`pipeName cannot be an empty string`) for every request -
    // a fallback engine that could not reach the run's child at all, found by running the
    // rehearsal on it rather than by reading this file.
    expect(session, 'the pipe name may not depend on the engine').not.toMatch(/Split-Path -Leaf \$endpoint/);
    expect(session, 'it is the endpoint without its namespace prefix').toMatch(/Substring\('[^']*pipe[^']*'\.Length\)/);
    expect(session, 'a Unix socket everywhere else').toMatch(/AddressFamily\]::Unix/);
    expect(session, 'under a name no other run holds').toMatch(/rehearsal-world-\$\(\[guid\]/);
    // Bounded, so a child that stops answering is a failed request with a reason rather
    // than a rehearsal that hangs until the job gives up on it.
    expect(session).toMatch(/ReadLineAsync\(\)/);
    expect(session).toMatch(/REHEARSAL_ROUTER_TIMEOUT/);
  });

  it('is answered on its endpoint: one client leaves, the child keeps answering the next', async () => {
    // The protocol the persistent child depends on, checked without an engine so the shape holds
    // on a machine with no PowerShell. Both kinds of question are asked here because they are now
    // the same child: a routing one, and a world-building one - refused on the same wire, with
    // its reason, which is what the sentinel rehearsal asks this child for and this leg does not.
    const session = startSession();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'world-endpoint-'));
    let code: number | null = null;
    try {
      const world = path.join(dir, 'world.json');
      const from = fixture as unknown as Record<string, unknown>;
      const keys = ['clock', 'issue', 'comments', 'workflows', 'runs', 'artifacts', 'post', 'raw', 'next_comment_id'];
      writeFileSync(world, JSON.stringify(Object.fromEntries(keys.filter((key) => key in from).map((key) => [key, from[key]]))));

      // One connection, three questions - the last of them a line no reader can parse, sent raw
      // (ask frames objects and passes strings through), which is exactly what the refusal is for.
      const first = await connectSession(session);
      const answers = [
        await first.ask({ kind: 'route', world, method: 'GET', uri: 'https://api.github.com/repos/Creative-hub554/Base88Plus/issues/18' }),
        await first.ask({ kind: 'route', world, method: 'GET', uri: 'https://api.github.com/repos/Creative-hub554/Base88Plus/actions/runs?per_page=100' }),
        await first.ask('not json'),
      ];
      // A routed request, one the world does not describe, and a line the protocol cannot
      // read: answered, refused, refused - never a dead child, which is what the sending
      // form did with a bad request.
      expect(answers.map((answer) => answer.envelope?.status)).toEqual([200, 404, 400]);
      // The unreadable line is phrased for BOTH readers of this wire - the transport throws on
      // the envelope, whatever asked for a world reports the text - which is the whole reason one
      // child can serve the two roles.
      expect(answers[2].kind).toBe('refusal');
      expect(answers[2].error).toContain('REHEARSAL_ROUTER_BAD_REQUEST');
      // The second role, on that same wire: a world that cannot be built is a reason in an
      // answer, not a dead child, and nothing is written for it.
      const refused = await first.ask({
        kind: 'materialize',
        fixture: SENTINEL_FIXTURE,
        scenario: 'no-such-scenario',
        witness: 'oct28-verify',
        clock: '2026-10-29T01:00:00Z',
        out: path.join(dir, 'never.json'),
      });
      expect(refused.kind).toBe('materialize');
      expect(refused.error).toContain('REHEARSAL_WORLD_FAILED');
      expect(existsSync(path.join(dir, 'never.json')), 'a refused world must not be written').toBe(false);
      // A client leaving is a client leaving, not the run ending: this is the property a pipe
      // could not have, and it is why the worlds no longer need a relay through the host.
      first.close();
      const second = await connectSession(session);
      const later = await second.ask({
        kind: 'route',
        world,
        method: 'GET',
        uri: 'https://api.github.com/repos/Creative-hub554/Base88Plus/issues/18',
      });
      expect(later.envelope?.status, 'the child answered a client that arrived after the first left').toBe(200);
      second.close();
    } finally {
      code = await session.stop();
    }
    // The stop is the OWNER's pipe: closing it ends the child, and on Unix the socket file goes
    // with it (a named pipe is not a file and needs no removing).
    expect(code).toBe(0);
    if (process.platform !== 'win32') expect(existsSync(session.endpoint)).toBe(false);
  }, SESSION);

  it('names its evidence on the failure path, in the lines the parity harness masks', () => {
    // A failing leg prints the directory it kept its worlds and ledger in, which is a
    // machine fact: the harness normalises exactly those lines away so two engines
    // can agree about everything else. If this leg named them differently, a failure
    // on one runner would read as a difference between engines.
    for (const marker of EVIDENCE_PATH_LINES) {
      expect(scriptSource, `${marker}: the failure path must name its evidence`).toContain(`${marker}$`);
    }
  });

  it('asks every case through ONE engine launch, and pairs the answers by name', () => {
    // The leg's runtime is (cases x engine launch) unless it is one launch, and an engine
    // costs the better part of a second: ten cases were paying it ten times. A regression
    // here fails nothing — it just makes the leg slow enough that somebody weakens it — so
    // the shape is pinned instead of the stopwatch.
    expect(scriptSource.match(/spawnSync\(engine\.command/g) ?? []).toHaveLength(1);
    expect(scriptSource, 'the cases must reach the actor as a list').toContain('"-CaseList"');
    expect(actorSource, 'and the actor must read that list').toMatch(/\[string\]\$CaseList/);
    expect(actorSource, 'asking every case in it').toMatch(/foreach \(\$case in \$cases\)/);
    // Every line names its case and the driver looks each answer up by that name: pairing by
    // position would let a session that lost one case compare one case's answer with
    // another's question, which is exactly the agreement this rehearsal exists to catch.
    expect(actorSource, 'each observation must name its case').toMatch(/name\s+= \$spec\.name/);
    expect(scriptSource).toMatch(/session\.observations\.get\(spec\.name\)/);
    expect(scriptSource, 'a missing observation must fail its case, not skip it').toContain(
      'printed no observation for it',
    );
  });

  it('fails the run, not the process, when the machine has no engine at all', () => {
    expect(scriptSource).toMatch(/engine = powerShell\(\)/);
    expect(scriptSource).toMatch(/no PowerShell to run the transport with/);
  });
});

describe('the transport rehearsal is wired like the other two', () => {
  const ci = source(path.join('.github', 'workflows', 'ci.yml'));
  const pkg = JSON.parse(source('package.json')) as { scripts: Record<string, string> };

  it('is an npm script, a leg CI runs, and a suite the harness has a grammar for', () => {
    expect(pkg.scripts['rehearse:transports']).toBe('node scripts/rehearse-transports.mjs');
    expect(ci).toContain('rehearsal-output/rehearsal-transports.txt');
    expect(REPORT_MARKERS.transports).toBe('TRANSPORT');
    // The committed baseline is a projection, not a captured stream, and it reads back
    // as itself: a version with npm's banner or a machine path in it could never match
    // on the runner.
    expect(project('transports', baseline)).toBe(baseline);
  });

  it('is documented where the other rehearsals are', () => {
    const playbooks = source(path.join('docs', 'playbooks.md'));
    expect(playbooks, 'no npm script documented').toContain('npm run rehearse:transports');
    expect(playbooks, 'no cross-engine recipe for it').toContain('rehearsal-transports.txt');
  });
});

describe.skipIf(!engine)('the rehearsal itself, run for real', () => {
  // These spawn PowerShell and its node child, and the whole suite runs its files in
  // parallel: ~2s alone, ~12s with sixty-odd other files competing for the machine.
  // The default 5s timeout is a statement about the runner, not about the rehearsal.
  const SLOW = 60_000;

  it('prints, for a live case, the very line the committed baseline holds', () => {
    // The whole point of the leg: what a real run prints projects onto the file the
    // repository holds, so the baseline is the rehearsal's own report rather than a
    // transcription of one. Byte for byte, because the projection is what the parity
    // job will compare - npm's banner and the evidence lines are not part of a report.
    const one = run('--only', 'comments-window-one');
    expect(one.stderr, one.stdout).toBe('');
    expect(one.status, one.stdout).toBe(0);
    const report = project('transports', one.stdout).split('\n').filter(Boolean);
    expect(report[0]).toContain('fixture=transport-rehearsal.json cases=1');
    expect(report).toContain(delivered.find((line) => line.includes('comments-window-one')));
    expect(report.at(-1)).toBe('TRANSPORT_DONE cases=1 failed=0');
  }, SLOW);

  it('refuses a name that is not a case, rather than running nothing and passing', () => {
    const missing = run('--only', 'no-such-case');
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('matches no case');
  }, SLOW);

  it('cannot become a baseline under a suite name no marker describes', () => {
    // The undeclared-suite path, driven by the REAL bytes this leg prints rather than
    // by a hand-written fake: what the projection has to keep out of the repository —
    // npm's banner, the world's directory, the engine's chatter — is exactly what a
    // captured stream carries. A baseline of `transport` (one letter off the suite the
    // workflow uploads) must be refused, not written from the capture.
    const one = run('--only', 'comments-window-one');
    expect(one.status, one.stdout).toBe(0);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'transport-undeclared-'));
    const golden = mkdtempSync(path.join(os.tmpdir(), 'transport-golden-'));
    try {
      const at = path.join(dir, 'rehearsal-output-7.6.6');
      mkdirSync(at, { recursive: true });
      writeFileSync(path.join(at, 'rehearsal-transport.txt'), one.stdout);
      // Reported as undeclared rather than compared as two empty projections, which
      // is what would happen if the projection silently returned "".
      expect(compareToBaseline(collect(dir), [])).toEqual({
        failures: [{ kind: 'baseline-undeclared', suite: 'transport', engines: [] }],
        matched: [],
      });
      const refused = spawnSync(process.execPath, [parity, '--dir', dir, '--golden', golden, '--write-golden'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('no report marker declared for transport');
      expect(collectGolden(golden), 'a capture nobody can project must not become a baseline').toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(golden, { recursive: true, force: true });
    }
  }, SLOW);
});
