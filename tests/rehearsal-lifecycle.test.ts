/**
 * The record lifecycle rehearsal, pinned.
 *
 * `scripts/rehearse-lifecycle.mjs` runs a verifier, a sentinel, the heartbeat
 * auditor and the recovery pass against the ONE world declared in
 * scripts/rehearsal-lifecycle.json, so a record can go computed -> filed -> lost
 * -> recovered -> retired with every handoff between those tools exercised. The
 * execution is the `rehearsals` job in .github/workflows/ci.yml (ubuntu-latest,
 * where the cron's own `pwsh` lives - see the last describe below); what these
 * pins hold is the part that could rot silently.
 *
 *   - every record identity the rehearsal compares against is the one the
 *     DECLARATION renders (scripts/verdict-contract.mjs, i.e. the same string the
 *     PowerShell door renders on the other side): the identity is what a record is
 *     written under AND searched for, so the two languages disagreeing here is the
 *     duplicate-record bug this whole contract exists to prevent;
 *   - the world is shaped like the API's, and it registers every workflow the
 *     recovery pass enumerates - it walks the CONTRACT's list, not the API's, so a
 *     world that skipped one would 404 a run query and read as "nothing to recover"
 *     (the rehearsal found that the hard way, on its first run);
 *   - every workflow the world declares exists on disk with the crons the
 *     auditor reads from the checkout, and every schedule the world seeds has a run
 *     for its most recent due slot: the auditor grades slots, not runs, so a world
 *     whose clock drifted past its own evidence would report a dead schedule - and
 *     a rehearsal of "the record was lost" would be a rehearsal of something else;
 *   - the clocks form a timeline (each step at or after the last), because the
 *     handoffs are only meaningful in order: a fingerprint of the audit's clock is
 *     a different world from a fingerprint of the record it audits.
 *
 * What is NOT pinned here: that the four tools agree. That is the rehearsal's own
 * job - `npm run rehearse:lifecycle`, eight steps, exit 1 on any mismatch.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectCrons, parseWorkflow } from '../scripts/check-workflows.mjs';
import { parseCron, prevFireBefore } from '../scripts/heartbeat-audit.mjs';
// The recovery pass's own header renderer, imported the way the rehearsal imports
// what it checks: these pins are about the two halves agreeing, so neither side may
// be a copy of the other.
import { recordHeader } from '../scripts/recover-verdicts.mjs';
import { RECOVERABLE, WORKFLOWS, contractFor, renderHeader } from '../scripts/verdict-contract.mjs';

type Step = {
  phase: string;
  name: string;
  actor: string;
  chain?: string;
  clock: string;
  gnomon?: string;
  token?: string;
  from?: string;
  workflow?: string;
  verdict?: string;
  artifact?: string;
  log?: string;
  runs?: number[];
  expect: {
    exit?: number;
    stdout?: string[];
    record?: { workflow: string; run: number | string; day: string; verdict: string };
    recordLine?: string;
    postAttempted?: boolean;
    commentsAdded?: number;
    artifactsOn?: number[];
    roundtrip?: boolean;
    findings?: number;
    auditorCommentIsNotARecord?: boolean;
    unreceiptedAfter?: number;
    matchesRoundTrip?: boolean;
    mentionsRecoveredComment?: boolean;
  };
};

type World = {
  issue: { number: number; state: string; closed_at: string | null };
  workflows: Array<{ file: string; name: string; path: string; state: string; created_at: string }>;
  runs: Array<Record<string, unknown> & { id: number; workflow: string; created_at: string; status: string }>;
  artifacts: Array<{ id: number; run: number; name: string }>;
};

const FIXTURE = join(process.cwd(), 'scripts', 'rehearsal-lifecycle.json');
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { steps: Step[]; world: World };
const { steps, world } = fixture;
const source = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8');
const scriptSource = source('scripts/rehearse-lifecycle.mjs');

/** The phases the lifecycle is about, in the order a record passes through them. */
const PHASES = ['computed', 'filed', 'lost', 'recovered', 'retired'];

describe('the lifecycle walks one record through every phase', () => {
  it('declares all five phases, in order', () => {
    const seen = steps.map((s) => s.phase);
    for (const phase of PHASES) expect(seen, phase).toContain(phase);
    // Not a sort of the array: the lifecycle is a sequence, and a step that runs
    // before the one it reads is not the same rehearsal.
    const firstAt = PHASES.map((phase) => seen.indexOf(phase));
    expect([...firstAt].sort((a, b) => a - b), seen.join(' -> ')).toEqual(firstAt);
    expect(seen.indexOf('filed'), 'the record is filed into its artifact before it is lost').toBeLessThan(
      seen.indexOf('lost'),
    );
    expect(seen.indexOf('lost'), 'a gap is noticed before it is recovered').toBeLessThan(seen.indexOf('recovered'));
    expect(seen.indexOf('recovered'), 'the record is recovered before anything retires').toBeLessThan(
      seen.indexOf('retired'),
    );
  });

  it('runs all four tools, and says for each step who would run it', () => {
    const actors = new Set(steps.map((s) => s.actor));
    expect([...actors].sort()).toEqual(['heartbeat', 'oct4-sentinel', 'recover', 'upload', 'verify-oct3']);
    // Every actor the fixture names has to be one this file knows how to reach, and
    // the two transports are the rehearsal's whole premise: PowerShell through the
    // stub, Node through the world's fetch shim.
    for (const actor of actors) {
      expect(scriptSource, `the rehearsal does not know how to run ${actor}`).toMatch(
        new RegExp(`["']?${actor}["']?\\s*:\\s*\\{`),
      );
    }
    expect(scriptSource).toContain('REHEARSAL_STUB');
    expect(scriptSource).toContain('REHEARSAL_SHIM');
  });

  it('expects a filed record exactly when a step files one', () => {
    for (const step of steps) {
      const e = step.expect;
      if (e.recordLine || e.record) expect(e.recordLine, step.name).toBeTruthy();
      if (e.recordLine) {
        expect(e.record, `${step.name}: a record identity needs the record it names`).toBeTruthy();
        expect(e.recordLine, `${step.name}`).toBe(
          recordHeader(RECOVERABLE[e.record!.workflow], { id: e.record!.run }, e.record!.day, e.record!.verdict),
        );
        // ...and the identity is phrased from the template the declaration holds, so
        // a step cannot pass while the two languages disagree about it.
        expect(e.recordLine, step.name).toContain(
          renderHeader(contractFor(e.record!.workflow), { run: e.record!.run, day: e.record!.day }),
        );
      }
      if (e.commentsAdded !== undefined) expect(e.commentsAdded, step.name).toBeGreaterThanOrEqual(0);
    }
  });

  it('reads every would-be verdict off stdout, and every finding off the audit', () => {
    for (const step of steps) {
      for (const needle of step.expect.stdout ?? []) {
        expect(needle.length, `${step.name}: an empty needle asserts nothing`).toBeGreaterThan(0);
      }
      if (step.actor === 'heartbeat') {
        expect(step.expect.findings, `${step.name}: an audit step must say how many findings it expects`).toBeTypeOf('number');
      }
    }
  });

  it('never forces the dry path', () => {
    // The lifecycle exists to exercise the POST: a world where a record is filed is
    // the only world in which "the auditor says the record never landed" means
    // anything. DRY_RUN is therefore cleared, not set - and the rehearsal's own
    // guard (a faked date is honoured only with a simulated transport) is why that
    // is safe.
    expect(scriptSource).toMatch(/DRY_RUN: ""/);
    expect(scriptSource).not.toMatch(/DRY_RUN: "1"/);
    expect(scriptSource).not.toContain('VERIFY_FORCE: "1"');
  });

  it('checks the record with the recovery pass own code, not a copy of it', () => {
    expect(scriptSource).toMatch(/from "\.\/recover-verdicts\.mjs"/);
    expect(scriptSource).toContain('selectUnreceipted');
    expect(scriptSource).not.toMatch(/function\s+selectUnreceipted\b/);
    // The rebuild is the round-trip checker's, which imports parseRecordLog and
    // buildRecoveredBody from the pass itself.
    expect(scriptSource).toContain('rehearse-roundtrip.mjs');
  });
});

describe("the lifecycle's world is shaped like the API's", () => {
  it('gives every run the fields the tools read', () => {
    for (const run of world.runs) {
      for (const field of ['id', 'workflow', 'status', 'conclusion', 'created_at', 'html_url']) {
        expect(Object.keys(run), `run ${run.id} needs ${field}`).toContain(field);
      }
      expect(run.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(['completed', 'in_progress'], String(run.status)).toContain(String(run.status));
    }
  });

  it('gives every artifact the fields the recovery pass reads', () => {
    for (const artifact of world.artifacts) {
      for (const field of ['id', 'run', 'name']) {
        expect(Object.keys(artifact), `artifact ${artifact.id} needs ${field}`).toContain(field);
      }
    }
    expect(['open', 'closed']).toContain(world.issue.state);
  });

  it('registers every workflow the recovery pass enumerates', () => {
    // The pass iterates the CONTRACT's RECOVERABLE set, not the API's workflow list:
    // a world that omitted one would answer 404 to its run query, and the pass would
    // fail loudly (which is right) on a rehearsal that meant to say "nothing to
    // recover". The auditor, by contrast, audits exactly what the API lists - so the
    // world also must not list a workflow the fixture gives no runs for.
    const registered = world.workflows.map((w) => w.file);
    for (const workflow of Object.keys(RECOVERABLE)) expect(registered, workflow).toContain(workflow);
    // A schedule that keeps no records is fair game - the auditor audits whatever the
    // API lists, and the ci.yml cron is the run the Oct 3 verdict is ABOUT - but the
    // world must not leave a record-keeper undeclared, or a receipt obligation would
    // exist that no step of the lifecycle could see.
    const undeclared = registered.filter((w) => !WORKFLOWS[w]);
    for (const workflow of undeclared) {
      expect(
        source(join('.github', 'workflows', workflow)),
        `${workflow} posts to #18 but is not a declared workflow`,
      ).not.toMatch(/issues\/\d+\/comments/);
    }
    expect(undeclared, 'the world registers the observed CI schedule besides the record-keepers').toEqual(['ci.yml']);
  });

  it('checks out every workflow it declares, so the auditor can read its crons', () => {
    // The auditor learns a schedule by parsing the file in the checkout; a world
    // that named a workflow the repo does not have would be auditing a phantom.
    for (const workflow of world.workflows) {
      expect(workflow.path, workflow.file).toBe(`.github/workflows/${workflow.file}`);
      expect(existsSync(join(process.cwd(), workflow.path)), workflow.path).toBe(true);
      expect(workflow.state).toBe('active');
      expect(workflow.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('seeds a run for the most recent due slot of every schedule, at every audit clock', () => {
    // The auditor grades the SLOT a run could have claimed, not the run: a schedule
    // whose last due slot has no run started at or after it is reported dead, and a
    // lifecycle rehearsal would then be rehearsing a dead cron instead of a lost
    // record. The slots come from the REAL crons in the checkout, through the
    // auditor's own cron parser, so this pin breaks the moment a schedule moves.
    const audits = steps.filter((s) => s.actor === 'heartbeat');
    expect(audits.length, 'no audit step would leave the receipt contract untested').toBeGreaterThanOrEqual(2);
    for (const audit of audits) {
      const clockMs = Date.parse(audit.gnomon!);
      expect(Number.isNaN(clockMs), `${audit.name}: gnomon must be a date`).toBe(false);
      for (const workflow of world.workflows) {
        const { js } = parseWorkflow(source(workflow.path));
        const crons = collectCrons(js);
        if (crons.length === 0) continue; // event-driven: nothing to grade
        const due = crons
          .map(({ expr }) => prevFireBefore(parseCron(String(expr)), clockMs))
          .filter((at): at is number => at !== null);
        if (due.length === 0) continue;
        const createdMs = Date.parse(workflow.created_at);
        const lastDue = Math.max(...due);
        if (lastDue < createdMs) continue; // not yet due: the auditor says so, in a note
        const runs = world.runs.filter((r) => r.workflow === workflow.file);
        expect(
          runs.some((r) => Date.parse(r.created_at) >= lastDue && Date.parse(r.created_at) <= clockMs),
          `${audit.name}: ${workflow.file} was due ${new Date(lastDue).toISOString()} with no run after it`,
        ).toBe(true);
      }
    }
  });

  it('names a chain with runs for every step that asserts a receipt fact', () => {
    // The receipt assertions ask the recovery pass's own contract about a chain's
    // runs. A chain the world has no runs for makes them vacuously true - a check
    // that cannot fail, which is worse than no check, because it reads like one.
    for (const step of steps) {
      const e = step.expect;
      if (e.auditorCommentIsNotARecord === undefined && e.unreceiptedAfter === undefined) continue;
      const chain = step.chain ?? WORKFLOWS[step.actor]?.workflow ?? null;
      expect(chain, `${step.name}: no chain named`).toBeTruthy();
      const runs = world.runs.filter((r) => r.workflow === chain);
      expect(runs.length, `${step.name}: ${chain} has no runs to judge`).toBeGreaterThan(0);
      if (e.unreceiptedAfter !== undefined) {
        expect(runs.length, `${step.name}: more runs than the world declares`).toBeGreaterThanOrEqual(e.unreceiptedAfter);
      }
    }
  });

  it('keeps every clock in order, so the handoffs happen in sequence', () => {
    let previous = 0;
    for (const step of steps) {
      const at = Date.parse(step.clock);
      expect(Number.isNaN(at), `${step.name}: clock must be a date`).toBe(false);
      expect(at, `${step.name} runs before the step it reads`).toBeGreaterThanOrEqual(previous);
      previous = at;
      // A PowerShell actor's fake day gates what it is allowed to judge at all, so it
      // must be a day, not an instant (the scripts compare it as a string).
      if (step.actor === 'verify-oct3' || step.actor === 'oct4-sentinel') {
        expect(step.gnomon, `${step.name}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(at, `${step.name}: the world is on a different day from the tool`).toBe(
          Date.parse(`${step.gnomon}T00:00:00Z`) + (at % 86400000),
        );
      }
    }
  });

  it('uploads the log the workflow uploads, for the runs the workflow ran', () => {
    const uploads = steps.filter((s) => s.actor === 'upload');
    expect(uploads.length).toBeGreaterThan(0);
    for (const upload of uploads) {
      const spec = RECOVERABLE[upload.workflow!];
      expect(spec, `${upload.name}: unknown workflow`).toBeDefined();
      // The artifact name and the file inside it are the contract's, because that is
      // what the recovery pass looks for when it reads a run's zip.
      expect(upload.artifact, upload.name).toBe(spec.artifact);
      expect(upload.log, upload.name).toBe(spec.log);
      expect(upload.expect.artifactsOn!.length, upload.name).toBe(upload.runs!.length);
      for (const runId of upload.runs!) {
        expect(world.runs.map((r) => r.id), `${upload.name}: run ${runId}`).toContain(runId);
      }
      // The workflow really does pipe the script's stdout into that file.
      const yml = source(join('.github', 'workflows', upload.workflow!));
      expect(yml, upload.workflow!).toContain(`tee ${upload.log}`);
      expect(yml, upload.workflow!).toContain(`name: ${upload.artifact}`);
    }
    // The step that uploads must be the step whose log it uploads.
    for (const upload of uploads) {
      expect(steps.map((s) => s.name), upload.from!).toContain(upload.from);
    }
  });
});

describe('the rehearsal runs in CI, on the engine the cron workflows use', () => {
  const pkg = JSON.parse(source('package.json')) as { scripts: Record<string, string> };
  const ci = source(join('.github', 'workflows', 'ci.yml'));

  it('is the command CI runs, as a blocker', () => {
    // This rehearsal needs a PowerShell engine, and for as long as it only ran by
    // hand that engine was whatever the maintainer had. It now runs where the cron
    // runs, and through ci-ok: a rehearsal that can be skipped is the local habit
    // it was written to replace.
    expect(ci, 'ci.yml must run the lifecycle rehearsal').toContain('npm run rehearse:lifecycle');
    expect(ci, 'in a job that offers no continue-on-error')
      .toMatch(/rehearsals:[\s\S]*?runs-on: ubuntu-latest/);
    // The whole blocking set, in full: the matrix, the per-leg gates, and the
    // three checks that were each created because the thing they cover had no home
    // in CI (the superlinearity gate, the real-build soak, the rehearsals and their
    // cross-engine comparison). A list that quietly loses one of them is what this
    // pin is for.
    expect(ci, 'that ci-ok waits on').toMatch(
      /needs:\s*\[matrix,\s*gates,\s*perf-gate,\s*soak,\s*rehearsals,\s*rehearsal-parity\]/,
    );
    expect(ci, 'and fails when it did not pass').toMatch(/needs\.rehearsals\.result/);
  });

  it('spawns PowerShell through the one engine picker, not a hardcoded name', () => {
    // PowerShell 7 first, in both worlds on purpose: that is the engine the cron
    // workflows and CI use, so a rehearsal that ran on Windows PowerShell 5.1
    // locally would be rehearsing a different engine from the one that fires at
    // 07:17 UTC. One choice, read in one place, so this file and the sentinel
    // rehearsal cannot drift apart about it.
    expect(scriptSource).toMatch(/import \{ powerShell \} from "\.\/rehearse-pwsh\.mjs"/);
    expect(scriptSource).toMatch(/powerShell\(\)/);
    expect(scriptSource, 'no second copy of the engine name')
      .not.toMatch(/"powershell"\s*,\s*\[/);
    expect(pkg.scripts['rehearse:lifecycle']).toBe('node scripts/rehearse-lifecycle.mjs');
  });

  it('fails the step, not the process, when the machine has no engine at all', () => {
    // A missing engine is the one prerequisite the rehearsal cannot supply, and an
    // unhandled throw would read as a bug in the rehearsal rather than what it is.
    // So the step fails with its reason (REHEARSE_PWSH_MISSING, from the picker)
    // and the run keeps going, which is why the engine is resolved inside the try.
    expect(scriptSource).toMatch(
      /try \{\n\s+engine = powerShell\(\);[\s\S]{0,500}?catch[\s\S]{0,500}?no PowerShell to run this step with/,
    );
  });
});
