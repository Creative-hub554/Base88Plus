/**
 * The sentinel rehearsal, pinned.
 *
 * `scripts/rehearse-sentinels.ps1` runs both day-after sentinels against a
 * simulated promotion day (scripts/sentinel-rehearsal.json) so their trip and
 * clear paths are exercised before their dates arrive. The execution is
 * PowerShell's; what these pins hold is the part that could rot silently:
 *
 *   - every verdict a sentinel can file has a scenario that expects it, so a new
 *     trip state cannot ship without a rehearsal of it;
 *   - every scenario's expected record identity is the one the DECLARATION
 *     renders for that day - the same string the recovery pass searches for and
 *     the heartbeat audits against, in the other language;
 *   - the fixture's world is shaped like the API's (the fields the scripts read),
 *     because a fixture that omits one rehearses a kinder GitHub;
 *   - both sentinels have a clear path rehearsed, which is the whole point: a
 *     clear path that has never run is a clear path nobody has tested.
 *
 * What is NOT pinned here: that PowerShell agrees. That is the rehearsal's own
 * job - `npm run rehearse:sentinels`, 16 scenarios, exit 1 on any mismatch,
 * run on ubuntu-latest by the `rehearsals` job in .github/workflows/ci.yml
 * (see the last describe below).
 */

import { describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { RECOVERABLE, WORKFLOWS, contractFor, renderHeader } from '../scripts/verdict-contract.mjs';
// The recovery pass, imported the way the round-trip checker imports it: these pins
// are about the two halves agreeing, so neither side may be a copy of the other.
import { recordHeader } from '../scripts/recover-verdicts.mjs';

type Scenario = {
  name: string;
  sentinel: string;
  gnomon: string;
  issue: { state: string; closed_at: string | null; comments: number };
  runs: Array<Record<string, unknown>>;
  comments: Array<Record<string, unknown>>;
  expect: {
    exit: number;
    verdict: string | null;
    posts: boolean;
    alreadyRecorded?: boolean;
    bodyHeader: string | null;
    stdoutContains: string[];
  };
};

const FIXTURE = join(process.cwd(), 'scripts', 'sentinel-rehearsal.json');
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  scenarios: Scenario[];
};
const scenarios = fixture.scenarios;
const sentinelSource = (workflow: string) =>
  readFileSync(join(process.cwd(), WORKFLOWS[workflow].script), 'utf8');
const scriptSource = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8');

describe('the rehearsal covers what the sentinels can decide', () => {
  it('declares scenarios for both sentinels, and they are declared workflows', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(14);
    for (const s of scenarios) {
      expect(WORKFLOWS[s.sentinel], `${s.name}: ${s.sentinel}`).toBeDefined();
      expect(WORKFLOWS[s.sentinel].kind, `${s.name}`).toBe('sentinel');
    }
    for (const workflow of Object.keys(WORKFLOWS)) {
      if (WORKFLOWS[workflow].kind !== 'sentinel') continue;
      expect(scenarios.filter((s) => s.sentinel === workflow).length, workflow).toBeGreaterThan(0);
    }
  });

  it('has a scenario for every SENTINEL_ verdict either script can emit', () => {
    // Derived from the scripting, not from the list we happen to remember: a new
    // trip state that ships without a rehearsal of it fails here.
    for (const workflow of Object.keys(WORKFLOWS)) {
      if (WORKFLOWS[workflow].kind !== 'sentinel') continue;
      const emitted = new Set([...sentinelSource(workflow).matchAll(/SENTINEL_[A-Z_]+/g)].map((m) => m[0]));
      expect(emitted.size, `${workflow} emits sentinel verdicts`).toBeGreaterThan(0);
      for (const verdict of emitted) {
        // Either the scenario expects it as the FILED verdict, or it expects the
        // token on stdout: SENTINEL_IN_PROGRESS is a state a sentinel reports and
        // exits 0 on, not a record it posts, so demanding it as a `verdict` would
        // be demanding a comment that must never exist.
        const rehearsed = scenarios.some(
          (s) =>
            s.sentinel === workflow &&
            (s.expect.verdict === verdict || s.expect.stdoutContains.some((n) => n.includes(verdict))),
        );
        expect(rehearsed, `${workflow}: no scenario exercises ${verdict}`).toBe(true);
      }
    }
  });

  it('rehearses a clear path and a trip path for each sentinel', () => {
    for (const workflow of Object.keys(WORKFLOWS)) {
      if (WORKFLOWS[workflow].kind !== 'sentinel') continue;
      const mine = scenarios.filter((s) => s.sentinel === workflow);
      const trips = mine.filter((s) => s.expect.posts);
      const clears = mine.filter((s) => s.expect.exit === 0);
      expect(trips.length, `${workflow}: trip paths`).toBeGreaterThan(0);
      expect(clears.length, `${workflow}: clear paths`).toBeGreaterThan(0);
      // A clear says WHY in the log, so a rehearsal of it cannot pass by the
      // sentinel silently doing nothing.
      for (const clear of clears) {
        expect(clear.expect.verdict, `${clear.name}`).toBeNull();
        expect(clear.expect.stdoutContains.join(' '), `${clear.name}`).toMatch(/SENTINEL_OK|SENTINEL_IN_PROGRESS/);
      }
      // ...and every trip that files a comment is checked against the identity
      // the declaration renders for that day, not just against its verdict token.
      for (const trip of trips) {
        expect(trip.expect.verdict, `${trip.name}`).toBeTruthy();
        expect(trip.expect.bodyHeader, `${trip.name}: a filed trip must have its record identity checked`).toBeTruthy();
      }
    }
  });

  it('tests the paths that exist because something already went wrong', () => {
    const names = scenarios.map((s) => s.name).join(' | ');
    // The idempotence guard, and the record that pre-dates the chain it judges.
    expect(scenarios.some((s) => s.expect.alreadyRecorded), names).toBe(true);
    expect(scenarios.some((s) => s.comments.some((c) => String(c.created_at) < s.gnomon)), names).toBe(true);
    expect(scenarios.some((s) => s.issue.closed_at !== null), names).toBe(true);
    expect(scenarios.some((s) => s.runs.some((r) => r.status !== 'completed')), names).toBe(true);
  });

  it('never lets a rehearsal post: every scenario is dry, and none may assert a comment was sent', () => {
    for (const s of scenarios) {
      expect(s.expect.stdoutContains.join(' '), `${s.name}`).not.toMatch(/COMMENT_POSTED/);
      expect(s.gnomon, `${s.name}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('the rehearsal runs where the cron runs, not only where its author sits', () => {
  const pkg = JSON.parse(scriptSource('package.json')) as { scripts: Record<string, string> };
  const ci = scriptSource(join('.github', 'workflows', 'ci.yml'));

  it('is the command CI runs, as a blocker', () => {
    // The rehearsal used to be a maintainer's Windows ritual. The cron workflows
    // fire on ubuntu-latest under pwsh, so the rehearsal has to run there too - and
    // through ci-ok, because a gate nobody has to pass is the habit it replaced.
    expect(ci, 'ci.yml must run the sentinel rehearsal').toContain('npm run rehearse:sentinels');
    // The whole blocking set, spelled out: the point is that ci-ok waits on
    // THIS job, and a list that is written down is one a dropped blocker has to
    // change rather than silently satisfy.
    expect(ci, 'ci-ok must wait on it').toMatch(
      /needs:\s*\[matrix,\s*gates,\s*perf-gate,\s*soak,\s*rehearsals,\s*rehearsal-parity\]/,
    );
    expect(ci, 'and fail when it did not pass').toMatch(/needs\.rehearsals\.result/);
  });

  it('runs under pwsh, with Windows PowerShell only as the fallback', () => {
    // The npm script goes through the one place that picks an engine, so this
    // rehearsal and the lifecycle cannot disagree about which PowerShell they ran
    // on - and neither can silently rehearse on 5.1 what the cron runs on 7.
    expect(pkg.scripts['rehearse:sentinels']).toBe(
      'node scripts/rehearse-pwsh.mjs -File scripts/rehearse-sentinels.ps1',
    );
    expect(pkg.scripts['rehearse:which']).toBe('node scripts/rehearse-pwsh.mjs --which');
    const picker = scriptSource('scripts/rehearse-pwsh.mjs');
    expect(picker, 'pwsh is the first candidate').toMatch(/\["pwsh", "powershell"\]/);
    expect(picker, 'and the only candidate off Windows').toMatch(/: \["pwsh"\]/);
    // The harness spawns its children with the SAME choice, rather than a second
    // copy of the engine name that could drift from the picker's.
    expect(scriptSource('scripts/rehearse-sentinels.ps1')).toMatch(/\$pwshCommand = if \(Get-Command pwsh/);
  });
});

describe("the fixture's world is shaped like GitHub's", () => {
  it('gives every run the fields the sentinels read', () => {
    for (const s of scenarios) {
      for (const run of s.runs) {
        for (const field of ['id', 'status', 'conclusion', 'created_at', 'html_url']) {
          expect(Object.keys(run), `${s.name}: run ${run.id} needs ${field}`).toContain(field);
        }
        expect(run.created_at, `${s.name}`).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    }
  });

  it('gives every comment an id, a body and a created_at', () => {
    for (const s of scenarios) {
      for (const c of s.comments) {
        for (const field of ['id', 'body', 'created_at']) {
          expect(Object.keys(c), `${s.name}: comment needs ${field}`).toContain(field);
        }
      }
      expect(['open', 'closed'], `${s.name}.issue.state`).toContain(s.issue.state);
      if (s.issue.state === 'closed') expect(s.issue.closed_at, `${s.name}`).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('expects a verdict line exactly when the scenario files one', () => {
    for (const s of scenarios) {
      // The rehearsal asserts the two together, so a fixture that named a verdict
      // without a filing (or the reverse) would rehearse a different script.
      expect(s.expect.posts === Boolean(s.expect.verdict) || s.expect.alreadyRecorded === true, s.name).toBe(true);
      // The would-post path is the tripped path; the satisfied and refused paths
      // never compose a comment.
      if (s.expect.posts) expect(s.expect.exit, s.name).toBe(1);
      if (s.expect.alreadyRecorded) expect(s.expect.posts, s.name).toBe(false);
    }
  });
});

describe('every rehearsed record identity is the declared one', () => {
  it('renders each expected header from the declaration, in this language', () => {
    // The rehearsal compares the sentinel's printed body against these literals;
    // this compares the literals against the loader the recovery pass and the
    // heartbeat use. Both halves are needed: the header is the string a record is
    // written under AND searched for, so the two languages disagreeing here is
    // exactly the duplicate-record bug this contract exists to prevent.
    let checked = 0;
    for (const s of scenarios) {
      if (!s.expect.bodyHeader) continue;
      checked++;
      expect(s.expect.bodyHeader, `${s.name}: but it posts nothing`).toBe(
        renderHeader(contractFor(s.sentinel), { run: 'none', day: s.gnomon }),
      );
    }
    expect(checked, 'scenarios that post a comment and therefore render an identity').toBeGreaterThanOrEqual(6);
  });

  it('never expects a trip verdict its own record shape cannot see', () => {
    for (const s of scenarios) {
      if (!s.expect.verdict) continue;
      expect(contractFor(s.sentinel).shape.test(`**${s.expect.verdict}**`), `${s.name}: ${s.expect.verdict}`).toBe(true);
    }
  });

  it('keeps every scenario on a day the sentinel is allowed to judge', () => {
    for (const s of scenarios) {
      const entry = contractFor(s.sentinel);
      const refusal = s.expect.stdoutContains.some((n) => n.startsWith('REFUSED_DATE_GATE'));
      if (refusal) {
        expect(s.gnomon < entry.recordsOn, `${s.name}: a refusal must predate ${entry.recordsOn}`).toBe(true);
        expect(s.expect.exit, s.name).toBe(2);
      } else {
        expect(s.gnomon >= entry.recordsOn, `${s.name}: ${s.gnomon} vs ${entry.recordsOn}`).toBe(true);
      }
    }
  });

  it('judges verdicts inside the witness window the declaration names', () => {
    // A scenario whose PASS sits before the witnessed chain's window is the one
    // that proves the sentinel honours `readsSince` instead of taking any PASS it
    // can see - and it has to exist, or that property is only asserted in prose.
    let stale = 0;
    for (const s of scenarios) {
      const witness = contractFor(contractFor(s.sentinel).witnesses as string);
      for (const c of s.comments) {
        if (String(c.created_at) < witness.readsSince && String(c.body).includes(witness.marker)) stale++;
      }
    }
    expect(stale, 'a verdict recorded before the chain it is judged against').toBeGreaterThan(0);
  });
});

describe('the log round trip: each half reads the record the other wrote', () => {
  /**
   * A sentinel's stdout is the artifact its workflow uploads, and the recovery pass
   * re-posts a record out of that artifact when the POST failed. The rehearsal
   * executes that round trip (PowerShell runs the sentinel, Node runs the pass, the
   * sentinel is then handed the result back), and what is pinned here is the part a
   * rehearser in either language could otherwise get away with:
   *
   *   - the identity the pass renders names no run, because a sentinel's does not -
   *     otherwise the recovered comment would be phrased with a run id the sentinel
   *     never wrote, and its own dedupe guard would read it as a foreign record;
   *   - the round trip imports the shipped parser and builder instead of
   *     reimplementing them, or it would prove only self-consistency;
   *   - the captured log really is what the workflow uploads, and the recovered
   *     comment really is fed back to the script that wrote the original.
   */
  it('rebuilds every filed record under an identity that names no run', () => {
    let checked = 0;
    for (const s of scenarios) {
      if (!s.expect.bodyHeader || !s.expect.verdict) continue;
      checked++;
      expect(contractFor(s.sentinel).header, `${s.name}: a sentinel identity must not name a run`).not.toContain('{run}');
      // The pass names a run it found in the run list; the sentinel names none. The
      // two identities have to come out identical anyway, or the record returns as a
      // stranger and gets filed a second time.
      expect(recordHeader(RECOVERABLE[s.sentinel], { id: 9910000001 }, s.gnomon, s.expect.verdict), s.name).toBe(
        `${s.expect.bodyHeader}: **${s.expect.verdict}**`,
      );
    }
    // Every scenario that composes a record: the eight trips that file one, plus the
    // two that compose one and find it already on the issue.
    expect(checked, 'scenarios whose record is round-tripped').toBeGreaterThanOrEqual(10);
  });

  it('round-trips through the shipped recovery pass, not a reimplementation of it', () => {
    const source = scriptSource('scripts/rehearse-roundtrip.mjs');
    expect(source).toMatch(/from "\.\/recover-verdicts\.mjs"/);
    for (const name of ['parseRecordLog', 'buildRecoveredBody', 'selectUnreceipted']) {
      expect(source, `${name} must come from the recovery pass`).toContain(name);
    }
    for (const name of ['parseRecordLog', 'buildRecoveredBody', 'selectUnreceipted', 'recordHeader']) {
      expect(source, `${name} must not be redefined here`).not.toMatch(new RegExp(`function\\s+${name}\\b`));
    }
  });

  it('feeds the recovered comment back to the sentinel that wrote the original', () => {
    const harness = scriptSource('scripts/rehearse-sentinels.ps1');
    expect(harness).toContain('rehearse-roundtrip.mjs');
    // The comment the pass says it would post is put on the issue and the scenario is
    // run again: only the script that wrote a record can say whether that record is
    // its own, and ALREADY_RECORDED is how it says so.
    expect(harness).toMatch(/ALREADY_RECORDED/);
    // It reaches the sentinel the way any other comment does - as a comment on the
    // world's issue, built by the ONE router that defines what a world is (see
    // worldFromScenario). A harness that assembled the world itself, in its own
    // language, is the copy this refactor exists to prevent: the record the pass
    // posts and the record the sentinel reads would be two shapes that drift.
    // The recovered comment is handed to the world builder as extra comments - by the
    // writer's own parameter for it, so the harness still composes no world and no comment.
    expect(harness).toMatch(/-ExtraComments \$commentPath/);
    expect(scriptSource('scripts/rehearse-world.mjs')).toContain('extraComments');
    const stub = scriptSource('scripts/rehearse-sentinel-stub.ps1');
    expect(stub, 'the transport marshals to the router').toContain('rehearse-world.mjs');
    expect(stub, 'the stub must interpret no world of its own').not.toContain('sentinel-rehearsal.json');
    // And the log the pass reads is the one the workflow uploads - so if a workflow
    // stopped writing the script's output to the artifact, the round trip's premise
    // would be gone and these pins would still pass.
    for (const workflow of ['oct4-sentinel.yml', 'oct29-sentinel.yml']) {
      const yml = scriptSource(join('.github', 'workflows', workflow));
      expect(yml, workflow).toMatch(/tee oct\d+-sentinel\.log/);
    }
  });
});

describe('the rehearsal runs the scenarios in one interpreter', () => {
  /**
   * A PowerShell boot is ~1.2 s and this rehearsal used to make ~25 of them for 16 scenarios,
   * so ~36 s of a ~40 s run was interpreter starts. The command, the environment it reads, the
   * marker line and the exit code are what they were; the interpreter is now started ONCE
   * (scripts/rehearse-sentinel-host.ps1) and asked to run that command per scenario.
   *
   * What the rehearsal OBSERVES is pinned by the committed baseline the parity job compares
   * (scripts/rehearsal-golden/rehearsal-sentinels.txt) - that is the check that would catch a
   * scenario quietly reading a different world or a different day. What is pinned HERE is the
   * part no baseline can see: that there really is one interpreter, that a scenario cannot
   * inherit another's environment through it, and that a broken frame fails loudly instead of
   * being read as a verdict.
   */
  const harness = scriptSource('scripts/rehearse-sentinels.ps1');
  const host = scriptSource('scripts/rehearse-sentinel-host.ps1');

  it('asks one host to run the scenario command, instead of booting an interpreter per scenario', () => {
    expect(harness, 'the harness drives the host').toContain("'rehearse-sentinel-host.ps1'");
    expect(harness, 'and no longer hands the command to a fresh interpreter').not.toContain('-EncodedCommand');
    // Started lazily - a run filtered down to no scenarios must not start one - and stopped by
    // closing its pipe, so a run cannot leave a process, or that process's node world child,
    // behind.
    expect(harness).toMatch(/function Start-SentinelHost/);
    expect(harness).toMatch(/function Stop-SentinelHost/);
    expect(harness).toMatch(/\$script:SentinelHost = \$null/);
    expect(harness).toMatch(/^Stop-SentinelHost$/m);
    // The one command shape both designs ran, in the file that runs it now, with the marker
    // line the exit code is read out of.
    expect(host).toContain('. $env:REHEARSAL_STUB; & $env:REHEARSAL_SENTINEL');
    expect(host).toContain('REHEARSAL_EXIT=');
    // Reset before each run: a run that throws must not print a marker line it did not earn by
    // inheriting the scenario before it.
    expect(host).toMatch(/\$global:LASTEXITCODE = \$null/);
  });

  it("sends the child's environment as data, so no scenario can inherit another's", () => {
    // A fresh process gets a fresh environment; a reused session does not. So the whole
    // environment travels with the request - including VERIFY_FORCE, which bypasses the date
    // gate the fixture is built around and must be absent however the operator's shell was
    // set up.
    expect(harness, 'the harness must not configure its children through its own environment').not.toMatch(/\$env:REHEARSAL_STUB =/);
    expect(harness).toMatch(/function Get-SentinelChildEnv/);
    expect(harness).toMatch(/unset = @\('VERIFY_FORCE'\)/);
    expect(host, 'and the host clears what a request does not name').toMatch(/SetEnvironmentVariable\(\$name, \$null\)/);
  });

  it('reads one framed line per request, and fails loudly instead of guessing', () => {
    // A stray write to the host's stdout would put a sentence where a verdict is expected, and
    // a shifted frame would be read as the NEXT scenario's answer. Both are failed rehearsals
    // here, not wrong ones.
    expect(host, 'a request the host cannot read is a refusal, not a verdict').toContain('HOST_ERROR');
    expect(harness).toMatch(/REHEARSAL_HOST_PROTOCOL/);
    // Every answer, from either child, is read through one bounded reader: a process that
    // stops answering is a failed scenario with a reason, not a rehearsal that hangs until
    // the job gives up on it.
    expect(harness, 'a child that stops answering is bounded, not a hang').toMatch(/function Read-RehearsalChildLine/);
    expect(harness).toMatch(/Wait\(\$script:ChildTimeoutMs\)/);
    // Progress records render to the HOST's console, and the host's console is the pipe
    // carrying that frame: the one stream that cannot be captured has to be silenced.
    expect(host, 'progress records would land in the frame').toMatch(/\$ProgressPreference = 'SilentlyContinue'/);
    // A script writing straight to the console would step outside the frame entirely, so the
    // scripts this host runs are pinned not to. (The host itself is not in this list: writing
    // the frame through [Console]::Out is the one thing it is FOR.)
    for (const file of [
      'scripts/rehearse-sentinel-stub.ps1',
      'scripts/verdict-contract.ps1',
      'scripts/oct4-sentinel.ps1',
      'scripts/oct29-sentinel.ps1',
    ]) {
      expect(scriptSource(file), `${file} writes to a stream the host cannot frame`).not.toMatch(
        /Write-Host|\[Console\]::(Out|Write|Error)/,
      );
    }
  });
});

describe('the world child is the run\'s one node process, and every process in the run reaches it directly', () => {
  /**
   * The worlds used to be 24 node boots of ~120 ms each, then ONE materialiser child of their
   * own, plus a router child per world inside the transport. All three roles are this ONE child
   * now (scripts/rehearse-world-session.ps1, started and owned by this harness, which is the
   * run's driver), and what lets one child serve all of them is the ENDPOINT: it listens on a
   * local one, so the harness and the transport inside the host are both clients of it.
   *
   * That is the part worth stating, because the design it replaces could not do it: a pipe
   * belongs to whoever STARTED the process, so a world could only be built by asking the host
   * to ask the child on the caller's behalf - a relay whose only job was to hold a pipe. With
   * the child listening, nobody relays anything: the harness asks it for its worlds and the
   * transport asks it for its routes, each on a connection of its own.
   *
   * What makes one child enough is pinned below rather than assumed: the world and the fixture
   * are not arguments the child is started with, they travel in the request - so nothing has to
   * be restarted when either moves, and a run that walks two chains (Oct 28 for its Oct 29
   * scenarios, Oct 3 for its Oct 4 ones, each with an echo world) is still one process.
   *
   * A world is the INPUT every assertion in this file is about, so "the child stays up" may not
   * mean "and produces something else": the two shapes are compared on disk here, and the
   * report comparison is what holds the rest of it (rehearsal-parity.mjs).
   */
  const harness = scriptSource('scripts/rehearse-sentinels.ps1');
  const host = scriptSource('scripts/rehearse-sentinel-host.ps1');
  const stub = scriptSource('scripts/rehearse-sentinel-stub.ps1');
  const session = scriptSource('scripts/rehearse-world-session.ps1');
  const world = scriptSource('scripts/rehearse-world.mjs');
  const WORLD = join(process.cwd(), 'scripts', 'rehearse-world.mjs');
  const scenario = scenarios[0];
  const witness = 'oct28-verify';
  const clock = `${scenario.gnomon}T01:00:00Z`;
  // Starting a child and connecting to it is a process boot plus a socket, and the whole suite
  // runs its files in parallel: the default timeout would be a statement about the machine.
  const SLOW = 30_000;

  type SessionAnswer = { kind: string; out?: string; error?: string; envelope?: { status: number } };

  /**
   * A world child this test owns: its own endpoint, its own lifetime pipe.
   *
   * The endpoint is what the rehearsals use, so the tests use it too. A test that held the
   * child's stdin instead would be the one client a pipe can have - and the claim worth
   * rehearsing is that ANY process in the run can ask the same child directly.
   */
  const startSession = () => {
    const dir = mkdtempSync(join(tmpdir(), 'world-endpoint-'));
    // Windows named pipes live in their own namespace; elsewhere the endpoint is a socket FILE,
    // in a directory the child creates for itself with 0700 - hence the nested path, which the
    // session has to make rather than the test.
    const endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\rehearsal-world-${basename(dir)}`
        : join(dir, 'sock', 'world.sock');
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
   * base64 of UTF-8 JSON.
   *
   * A connection of its OWN per caller is the point, so a test can open two and have the driver
   * and the transport ask one child at the same time, which is what a pipe could not offer.
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
        // A child that is still binding is not a failure - the run's own client waits the same
        // way - but a child that has EXITED is, and naming which of the two it was is the
        // difference between a slow machine and a broken rehearsal.
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
    // A connection that faults takes its own questions down with it, as a reason: a test left
    // hanging would report the runner rather than the protocol.
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

  it('keeps ONE node child for the run, owned by this harness, with no relay between its processes', () => {
    // The harness owns the run's child because it is the run's driver: it starts the child,
    // publishes the endpoint in its own environment, and every process it starts - the host,
    // and the transport inside it - inherits that endpoint and becomes a client of the SAME
    // child. Nothing in between: the worlds are asked for here.
    expect(harness, 'the harness must not boot node per world').not.toMatch(/& node \$worldScript materialize/);
    expect(harness, 'it owns the run\'s child').toMatch(/'rehearse-world-session\.ps1'/);
    expect(harness, 'and asks it for a world itself').toMatch(/New-RehearsalWorld -Fixture \$fixturePath/);
    expect(harness, 'with nobody in the middle to ask').not.toMatch(/materialize = \[pscustomobject\]/);
    // The host is a CLIENT: it opens a connection for the routes its stub asks, and stops
    // nothing that belongs to the run.
    expect(host, 'the host owns no world child').not.toMatch(/Start-RehearsalWorldSession/);
    expect(host, 'it is a client of the run\'s child').toMatch(/'rehearse-world-session\.ps1'/);
    expect(host, 'and lets go of its own connection on the way out').toMatch(/Stop-RehearsalWorldSession/);
    // The world kind is GONE, not merely unused: a host that still answered one would be a
    // relay nothing exercises, and the harness would have two ways to ask for a world. (The
    // word survives in this file's header, where it explains what was removed; what may not
    // survive is a host that replies with one.)
    expect(host, 'the host relays no world').not.toMatch(/New-RehearsalWorld|-Kind 'WORLD'/);
    expect(host, 'it runs the command and answers with its output').toMatch(/ValidateSet\('RUN', 'HOST_ERROR'\)/);
    // ONE OWNER, everyone else a client: the rule is one environment variable, and it is set by
    // the process that owns the child rather than by its callers.
    expect(session, 'the owner is the process the run did not hand an endpoint').toMatch(/Test-RehearsalWorldOwnership/);
    expect(session, 'it draws an endpoint no other run can be holding').toMatch(/New-RehearsalWorldEndpoint/);
    expect(session, 'and starts the child listening on it').toMatch(/'session', '--endpoint', \$endpoint/);
    expect(session, 'publishing it to every process it starts').toMatch(/\$env:REHEARSAL_WORLD_SESSION = \$endpoint/);
    expect(session, 'the stop is the owner\'s own pipe, not a request').toMatch(/\$info\.RedirectStandardInput = \$true/);
    expect(session, 'a client starts nothing: it connects, or says the run is broken').toMatch(
      /REHEARSAL_ROUTER_UNAVAILABLE \(no world child for this run/,
    );
    // ONE child, with no world in it: this rehearsal walks two chains, so a child that had been
    // started for one of them could not build the other's worlds without being restarted.
    expect(session, 'no world is baked into the child').not.toMatch(/--world/);
    expect(world, 'it is a request field, not a startup argument').toMatch(/kind: "route", world, method, uri, token, body/);
    expect(world).toMatch(/witness: request\.witness/);
    expect(world, 'the child listens rather than reading its own stdin').toMatch(/function serveSession/);
    expect(world, 'on a local endpoint, never a port').toMatch(/server\.listen\(endpoint\)/);
    expect(world, 'and its stdin is the lifetime pipe').toMatch(/const keepAlive = createInterface\(\{ input: process\.stdin \}\)/);
    // The stub runs INSIDE the host, and asks the same child: the run's routing and its worlds
    // are one process, not two roles.
    expect(stub).toMatch(/Invoke-RehearsalRoute -World \$env:REHEARSAL_WORLD/);
    expect(stub, 'and starts nothing: the run\'s child is not the transport\'s to own').not.toMatch(/ProcessStartInfo/);
  });

  it('survives being dot-sourced once per request, so the connection it holds is the run\'s', () => {
    // The host dot-sources the stub - and through it this file - inside the per-request command
    // scope it then discards, so the session is re-executed while the child it is a client of
    // has to outlive the request. A load that re-ran its state would forget the run's endpoint
    // and its own connection: one connect per scenario, and a process that no longer knows
    // which child it was talking to.
    expect(session, 'loading must be idempotent').toMatch(/if \(-not \$global:RehearsalWorldSessionLoaded\)/);
    expect(session).toMatch(/\$global:RehearsalWorldSessionLoaded = \$true/);
    // The connection is a GLOBAL for the same reason (a `$script:` variable resolves, inside the
    // sentinel's own scope chain, to a scope where none of this was ever set), which
    // tests/transport-rehearsal.test.ts pins where the scrub would break the transport.
    expect(session, 'it lives where the discarded scopes cannot reach it').toMatch(/\$global:RehearsalWorldClient/);
    // And the file asks for the contract's own reader rather than assuming a caller loaded one:
    // the harness and the host both do, but a process that only needs a world should not have to
    // know that a world's instants have to survive PowerShell's own JSON reader.
    expect(session, 'the file stands on its own').toMatch(/\. \(Join-Path \$PSScriptRoot 'verdict-contract\.ps1'\)/);
  });

  it('builds every world through the one builder, from a copy of the scenario', () => {
    // Two callers and one builder: an edit that taught the endpoint to build a world its own way
    // would make the printed reports differ, which is exactly the failure this file exists to
    // make impossible.
    expect(world).toMatch(/function writeScenarioWorld/);
    expect(world, 'the CLI path goes through it').toMatch(/writeScenarioWorld\(arg\("out"\)/);
    expect(world, 'and so does the endpoint').toMatch(/writeScenarioWorld\(request\.out/);
    // The fixture is parsed once and lives as long as the process, so each request is built
    // from a COPY: a builder that mutated a scenario would otherwise make a scenario's second
    // world (the echo) depend on its first, which no per-boot CLI could do.
    expect(world).toMatch(/JSON\.parse\(JSON\.stringify\(scenario\)\)/);
    // A refusal is an ANSWER on the connection the request came in on, not a dead child: one bad
    // request must not take a rehearsal's remaining worlds with it.
    expect(world).toMatch(/REHEARSAL_WORLD_FAILED/);
    expect(world, 'a refusal is answered, not fatal').toMatch(/connection\.write\(answer\)/);
    // The stop is the LIFETIME pipe, and the only one: a client closing its connection is a
    // client leaving, which the session's other clients must not notice.
    expect(world, 'the child ends when its OWNER closes the pipe').toMatch(/keepAlive\.on\("close"/);
    expect(world, 'and leaves no socket behind for the next run to find').toMatch(/unlinkSync\(endpoint\)/);
    expect(harness, 'and the harness turns a refusal into a failed scenario').toMatch(/\$materialized \+= \$_\.Exception\.Message/);
  });

  /** A world file built the way the harness used to: one `materialize` boot per world. */
  const viaCli = (out: string, extra: string | null) => {
    const args = [WORLD, 'materialize', '--fixture', FIXTURE, '--scenario', scenario.name, '--witness', witness, '--clock', clock, '--out', out];
    if (extra) args.push('--extra-comments', extra);
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(out, 'utf8');
  };

  /** The same world, asked of the run's child on the endpoint it listens on. */
  const viaSession = async (
    owned: { endpoint: string; child: ChildProcess },
    out: string,
    extra: string | null,
  ) => {
    const client = await connectSession(owned);
    const answer = await client.ask({
      kind: 'materialize',
      fixture: FIXTURE,
      scenario: scenario.name,
      witness,
      clock,
      out,
      extraComments: extra,
    });
    client.close();
    expect(answer.error ?? null, 'the child refused the request').toBeNull();
    expect(answer.out, 'the child names the file it wrote').toBe(out);
    return readFileSync(out, 'utf8');
  };

  it('produces the world the CLI produces, byte for byte', async () => {
    const session = startSession();
    const dir = mkdtempSync(join(tmpdir(), 'world-writer-'));
    let code: number | null = null;
    try {
      expect(await viaSession(session, join(dir, 'session.json'), null)).toBe(viaCli(join(dir, 'cli.json'), null));
    } finally {
      code = await session.stop();
    }
    expect(code, 'closing the lifetime pipe is the stop').toBe(0);
  }, SLOW);

  it('and the world with the recovered record on it - the scenario\'s second world, built after the first', async () => {
    // The echo run: the same scenario with the recovery pass's own comment added. Built twice by
    // ONE child, one request apart, which is the case a per-boot CLI could never reach - and the
    // case a child that held the scenario would get wrong, because its second world would carry
    // the first's changes.
    const session = startSession();
    const dir = mkdtempSync(join(tmpdir(), 'world-echo-'));
    const extra = join(dir, 'comment.json');
    writeFileSync(
      extra,
      JSON.stringify({
        comments: [
          {
            id: 9000000003,
            body: 'post-Oct-28 verifier (run none, 2026-10-29): **SENTINEL_RUN_NO_PASS**',
            created_at: '2026-10-29T01:00:05Z',
          },
        ],
      }),
    );
    let code: number | null = null;
    try {
      expect(await viaSession(session, join(dir, 'plain.json'), null)).toBe(viaCli(join(dir, 'plain.cli.json'), null));
      expect(await viaSession(session, join(dir, 'session.json'), extra)).toBe(viaCli(join(dir, 'cli.json'), extra));
      // And the echo world is the plain one PLUS the record: a child that answered its first
      // world twice would make these the same file, which is what the compare above cannot see.
      expect(readFileSync(join(dir, 'session.json'), 'utf8')).not.toBe(
        readFileSync(join(dir, 'plain.json'), 'utf8'),
      );
    } finally {
      code = await session.stop();
    }
    expect(code, 'closing the lifetime pipe is the stop').toBe(0);
  }, SLOW);

  it('builds both chains\' worlds and answers their requests in ONE process, for any number of clients', async () => {
    // The claim the split into a router child and a materialiser could not state: the same
    // process builds a world and then answers against it - for both chains this rehearsal walks.
    // TWO clients ask it, each on its own connection, which is what a pipe could not offer: the
    // driver's questions and the transport's questions belong to different processes.
    const chains = new Map<string, string>();
    for (const s of scenarios) {
      const chain = contractFor(s.sentinel).witnesses as string;
      if (!chains.has(chain)) chains.set(chain, s.name);
    }
    expect(chains.size, 'this rehearsal walks more than one chain').toBeGreaterThanOrEqual(2);
    const session = startSession();
    const dir = mkdtempSync(join(tmpdir(), 'world-one-child-'));
    const plans = [...chains].map(([chain, name], i) => ({
      chain,
      name,
      clock: `${scenarios.find((s) => s.name === name)?.gnomon}T01:00:00Z`,
      out: join(dir, `w${i}.json`),
    }));

    let code: number | null = null;
    try {
      // The driver's connection: one world per chain.
      const driver = await connectSession(session);
      for (const plan of plans) {
        const answer = await driver.ask({
          kind: 'materialize',
          fixture: FIXTURE,
          scenario: plan.name,
          witness: plan.chain,
          clock: plan.clock,
          out: plan.out,
          extraComments: null,
        });
        expect(answer.kind, `${plan.name}: answered with a ${answer.kind}`).toBe('materialize');
        expect(answer.out).toBe(plan.out);
      }
      driver.close();

      // The transport's connection, opened AFTER the driver's closed: the child outlives its
      // clients (it ends when its OWNER's pipe does), and the world it answers from is the one
      // just built rather than one baked in when it started.
      const transport = await connectSession(session);
      for (const plan of plans) {
        const answer = await transport.ask({
          kind: 'route',
          world: plan.out,
          method: 'GET',
          uri: 'https://api.github.com/repos/Creative-hub554/Base88Plus/issues/18',
        });
        expect(answer.kind).toBe('route');
        expect(answer.envelope?.status, `${plan.chain}: routed against its own world`).toBe(200);
      }
      transport.close();

      // Each world is the one the CLI writes for the same inputs, and the two are not the same
      // world: a witness that was ignored would make this pass on two copies of one world.
      plans.forEach((plan) => {
        const cliOut = join(dir, `${plan.chain}.cli.json`);
        const cli = spawnSync(process.execPath, [WORLD, 'materialize', '--fixture', FIXTURE, '--scenario', plan.name, '--witness', plan.chain, '--clock', plan.clock, '--out', cliOut], {
          encoding: 'utf8',
        });
        expect(cli.status, cli.stderr).toBe(0);
        expect(readFileSync(plan.out, 'utf8'), `${plan.chain}: the child's world`).toBe(readFileSync(cliOut, 'utf8'));
      });
      const worlds = plans.map((plan) => readFileSync(plan.out, 'utf8'));
      expect(worlds[0], 'the two worlds are not the same world').not.toBe(worlds[1]);
      plans.forEach((plan, i) => expect(worlds[i], `${plan.chain} in world ${i}`).toContain(plan.chain));
    } finally {
      code = await session.stop();
    }
    expect(code, 'the child outlived both its clients and stopped with its owner\'s pipe').toBe(0);
  }, SLOW);
});

describe('the process claim is measured from outside the run, and fails when it moves', () => {
  /**
   * Every rehearsal here keeps ONE node child for its whole length, and the evidence the repository
   * holds cannot show it: the reports are byte-identical whether a run keeps one child or twenty.
   * Measured rather than argued: with the ownership rule broken so that each process starts a child
   * of its own (scripts/rehearse-world-session.ps1, `Test-RehearsalWorldOwnership` answering
   * `$true`), all 16 scenarios stayed GREEN - every baseline would still have matched - while the
   * run held TWO children at once.
   *
   * So the number is measured from OUTSIDE the run (the process table, never the run's own word)
   * and scripts/check-rehearsal-children.mjs is that measurement as a gate, run by the rehearsals
   * job on both engine lines. Pinned here: it exists, CI runs it, it reads no report, either count
   * fails it, and it refuses to pass when it could not look or when the leg it watched failed.
   *
   * The live half below rehearses the FAILING direction only. Other files in this suite run
   * rehearsals of their own in parallel, and a watcher that counted THEIR children would report a
   * count this file did not cause - a direction collisions only reinforce, never hide, which is why
   * "one child, and it passed" is left to the check's own run in CI.
   */
  const check = scriptSource('scripts/check-rehearsal-children.mjs');
  const pkg = JSON.parse(scriptSource('package.json')) as { scripts: Record<string, string> };
  const ci = scriptSource('.github/workflows/ci.yml');
  const WORLD = join(process.cwd(), 'scripts', 'rehearse-world.mjs');
  const SLOW = 60_000;

  it('is an npm script the rehearsals job runs, and it uploads nothing of its own', () => {
    expect(pkg.scripts['check:rehearse-children']).toBe('node scripts/check-rehearsal-children.mjs');
    const from = ci.indexOf('  rehearsals:');
    const to = ci.indexOf('\n  rehearsal-parity:');
    expect(from, 'ci.yml has no rehearsals job').toBeGreaterThan(-1);
    const job = ci.slice(from, to === -1 ? undefined : to);
    expect(job, 'the rehearsals job must run the count').toContain('npm run check:rehearse-children');
    // It runs a leg itself, so it must not write a `rehearsal-<suite>.txt`: the parity job reads
    // the suite list out of exactly those paths, and a count is not a rehearsal report.
    expect(job, 'a count is not a suite').not.toMatch(/rehearsal-children\.txt/);
    // ...and after the three legs, so its own run cannot land in their artifacts.
    expect(job.indexOf('check:rehearse-children')).toBeGreaterThan(job.indexOf('rehearse:transports'));
  });

  it('measures the process table rather than reading the run\'s report', () => {
    // POSIX reads /proc directly; Windows has no door but PowerShell's CIM, kept alive for the run
    // because a process start per sample costs more than the interval it samples at.
    expect(check).toMatch(/readdirSync\(procRoot\)/);
    expect(check).toMatch(/join\(procRoot, name, "cmdline"\)/);
    expect(check).toMatch(/Win32_Process/);
    // Either count fails it, because either one can be the only visible half: a boot per request
    // can be gone before the next sample (the peak), and a boot per world is many processes even
    // when no two overlap (the count).
    expect(check).toMatch(/if \(result\.peak > 1 \|\| result\.distinct > 1\)/);
    expect(check).toMatch(/peak=\$\{result\.peak\} distinct_pids=\$\{result\.distinct\}/);
    // A check that could not look, or whose leg failed, must not report a pass.
    expect(check).toMatch(/CHILDREN_UNREADABLE/);
    expect(check).toMatch(/not evidence about a full run/);
    // ...and it can be pointed at something other than a leg, which is how the gate itself is
    // rehearsed - the live case below is that path.
    expect(check).toMatch(/--command/);
    // The preload flags are skipped with their values, because a preloaded file is not an entry
    // point: that distinction is what the test below drives directly.
    expect(check).toMatch(/PRELOAD_FLAGS\.has\(args\[at\]\)/);
  });

  it('decides what a child IS, from a process table this test can hand it', async () => {
    // The POSIX reading runs on CI and not here, so the RULE it applies is driven directly — with a
    // /proc-shaped directory this test writes. That is also the only way the rule's own distinctions
    // are pinned: a tool that merely PRELOADS the world script (`node --import .../rehearse-world.mjs
    // scripts/recover-verdicts.mjs`, which is how the Node actors reach the world) names the same
    // file and is not a child of it; a shell whose command line mentions the script started a child
    // rather than being one. Both were real false positives in this check before they were
    // distinguished — the first read as a second child in the lifecycle leg.
    const { procChildren } = (await import('../scripts/check-rehearsal-children.mjs')) as {
      procChildren: (root?: string) => number[];
    };
    const root = mkdtempSync(join(tmpdir(), 'proc-root-'));
    const put = (pid: number, argv: string[]) => {
      mkdirSync(join(root, String(pid)));
      writeFileSync(join(root, String(pid), 'cmdline'), `${argv.join('\0')}\0`);
    };
    put(4242, ['/usr/bin/node', WORLD, 'session', '--endpoint', '/tmp/x/world.sock']);
    put(4343, ['/usr/bin/node', '--import', `file://${WORLD}`, 'scripts/recover-verdicts.mjs']);
    put(4444, ['/bin/sh', '-c', `node ${WORLD} serve --world /tmp/x.json`]);
    put(4545, ['/usr/bin/node', '/workspace/scripts/rehearse-roundtrip.mjs', '--log', 'x']);
    // A directory that is not a pid, and an entry whose cmdline has gone: neither is an error.
    writeFileSync(join(root, 'not-a-pid'), '');
    mkdirSync(join(root, '5555'));
    expect(procChildren(root), 'only the process RUN AS the world script counts').toEqual([4242]);
    rmSync(root, { recursive: true, force: true });
  });

  it('fails a command that keeps two world children, and says how many it saw', async () => {
    // The failing direction, rehearsed: two children of the world script alive at once must fail
    // the gate. A check that can only pass is the "one input, nothing to compare" failure the
    // parity harness refuses, so this is what shows the gate is able to fail.
    const dir = mkdtempSync(join(tmpdir(), 'children-gate-'));
    const fixture = join(dir, 'two-children.mjs');
    // ESM, because `.mjs` is ESM whatever it contains: the first draft of this fixture used
    // `require` and node refused it, which the gate reported as a run that could not be counted
    // (exit 2, "not evidence about a full run") rather than as one child too many.
    writeFileSync(
      fixture,
      [
        "import { spawn } from 'node:child_process';",
        '// argv: <world script> <endpoint> <endpoint> — held, so the sampler sees both at once.',
        'const [script, ...endpoints] = process.argv.slice(2);',
        'for (const endpoint of endpoints) {',
        "  spawn(process.execPath, [script, 'session', '--endpoint', endpoint], { stdio: ['pipe', 'inherit', 'inherit'] });",
        '}',
        // Long enough that a sample lands inside their life on a loaded machine: the sampler's
        // first sample is the expensive one (a PowerShell start), which is why the check takes it
        // BEFORE the command it watches.
        'setTimeout(() => process.exit(0), 3000);',
      ].join('\n'),
    );
    const endpoints =
      process.platform === 'win32'
        ? ['\\\\.\\pipe\\rehearsal-gate-a', '\\\\.\\pipe\\rehearsal-gate-b']
        : [join(dir, 'a', 'world.sock'), join(dir, 'b', 'world.sock')];
    const command = [process.execPath, fixture, WORLD, ...endpoints].map((part) => `"${part}"`).join(' ');
    let result;
    try {
      result = spawnSync(process.execPath, [join(process.cwd(), 'scripts', 'check-rehearsal-children.mjs'), '--command', command], {
        encoding: 'utf8',
        timeout: 40_000,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const said = `${result.stdout}${result.stderr}`;
    expect(result.status, said).toBe(1);
    expect(said, 'the count it saw belongs in the failure').toMatch(/peak=[2-9]/);
    expect(said).toMatch(/distinct_pids=[2-9]/);
    // ...and it says how much it looked: a count taken zero times is not a count.
    expect(said).toMatch(/samples=[1-9]/);
    expect(said.substring(said.indexOf('CHILDREN'))).toContain('CHECK_REHEARSAL_CHILDREN FAIL');
  }, SLOW);
});