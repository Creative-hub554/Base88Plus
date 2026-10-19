// Pins for the workflow contract gate: scripts/check-workflows.mjs.
//
// Every other gate in this repo inspects CODE. Nothing inspected the workflow
// files, so all nine CI legs could be green while a workflow was invalid —
// which is exactly what happened: three comments sat glued to a quoted cron
// (`'17 19 3 10 *'# note`) since PR #58, tolerated by GitHub's lenient parser
// and invisible to every check. A green run that is not a verdict, the same
// class as the lost Oct 3 verdict in #129.
//
// The five checks, and the real failure each one exists for:
//   1. PARSE — the glued comments (MISSING_CHAR), plus duplicate keys, which
//      a lenient parser resolves by silently keeping the last value.
//   2. CRON  — GitHub IGNORES a cron it cannot parse: no run, no error, no
//      notification. A malformed cron is a scheduled job that does not exist.
//   3. PERMS — a workflow posting an issue comment without issues: write gets
//      403 "Resource not accessible by integration" and still exits 0. That
//      is the Oct 3 verdict, lost.
//   4. WRITE — a workflow that REGENERATES a committed record instead of
//      checking it: the rehearsal baseline (`--write-golden`) or the generated
//      pins (`new:pin`). A runner's checkout is discarded, so a job that rewrote
//      a record and then checked it reports PASS about a file nobody has, and a
//      job that committed it would be re-making the pin with the very run it
//      judges — `verify:generated --strict` reading a pin this run wrote.
//   5. REFRESH — the one pin CI DOES rewrite, the upstream schedule snapshot,
//      may only be refreshed where the result can be committed: unguarded it
//      also runs on push and PR, where the file is thrown away.
//
// Each negative case below is a FIXTURE, not a mutation of the real tree: the
// gate must be proven to have teeth without ever writing an invalid workflow
// into .github/workflows/ where a scheduled run could read it.

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_DIR,
  PIN_WRITERS,
  REFRESHABLE_PIN,
  assessPermissions,
  assessPinWrites,
  checkAll,
  checkWorkflow,
  collectCrons,
  formatReport,
  listWorkflows,
  parseWorkflow,
  validateCron,
} from '../scripts/check-workflows.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const CRON_FIELD_NAMES = [
  'minute',
  'hour',
  'day-of-month',
  'month',
  'day-of-week',
];

/**
 * Parse and require a usable tree. The gate withholds `js` only when a
 * document is unreadable, so a pin that wants to read the tree says so here
 * rather than asserting on a possibly-null value.
 */
function tree(text: string): Record<string, any> {
  const { js, problems } = parseWorkflow(text);
  expect(problems, 'fixture must be free of findings').toEqual([]);
  expect(js, 'fixture must yield a readable tree').toBeTruthy();
  return js as Record<string, any>;
}

/** A minimal valid workflow; `opts` overrides individual keys. */
function workflow(opts: { permissions?: string; jobs?: string; cron?: string } = {}): string {
  const permissions =
    opts.permissions ?? 'permissions:\n  contents: read\n  issues: write\n';
  const cron = opts.cron ?? "    - cron: '0 1 4 10 *' # Oct 4 sentinel\n";
  const jobs =
    opts.jobs ??
    `jobs:
  go:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
  return `name: Fixture\non:\n  schedule:\n${cron}  workflow_dispatch:\n${permissions}${jobs}`;
}

/** A workflow that posts to an issue, with the given permission lines. */
function poster(permissions: string): string {
  return `name: Poster
on:
  workflow_dispatch:
permissions:
${permissions}jobs:
  post:
    runs-on: ubuntu-latest
    steps:
      - run: gh api repos/o/r/issues/18/comments -f body=verdict
`;
}

describe('parseWorkflow: the defect GitHub tolerates', () => {
  // The real defect, verbatim in shape. GitHub parses this happily and the
  // cron still fires, which is why nothing caught it for weeks.
  it("rejects a comment glued to a quoted cron", () => {
    const problems = parseWorkflow(
      `on:\n  schedule:\n    - cron: '17 19 3 10 *'# evening backstop\njobs:\n  a:\n    runs-on: x\n`,
    ).problems;
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0].check).toBe('parse');
    expect(problems[0].message).toMatch(/MISSING_CHAR|comment/i);
    expect(problems[0].line).toBe(3);
  });

  // A lenient parser keeps the LAST value for a duplicate key, so a
  // mistyped permission or a duplicated cron is invisible in the run list.
  it('rejects duplicate keys', () => {
    const problems = parseWorkflow('on:\n  push:\npermissions: {}\npermissions: {}\n').problems;
    expect(problems.some((p) => /unique/i.test(p.message))).toBe(true);
  });

  it('withholds the tree only when the document is genuinely unreadable', () => {
    // An unresolved alias makes toJS() throw: there is nothing to check, and
    // the parse problems are the whole honest report.
    const broken = parseWorkflow('on:\n  schedule:\n   - cron: *\n  - broken: [\n');
    expect(broken.problems.length).toBeGreaterThan(0);
    expect(broken.js).toBeNull();
    // ...but a glued comment parses, so the tree is kept and the remaining
    // checks still run. Reporting only the parse problem would cost the
    // author a round trip to learn about the bad cron in the same file.
    const recoverable = parseWorkflow(
      "on:\n  schedule:\n    - cron: '99 7 * * *'# glued\njobs:\n  a:\n    runs-on: x\n",
    );
    expect(recoverable.problems).toHaveLength(1);
    expect(recoverable.js).toBeTruthy();
    expect(Object.keys(recoverable.js!.jobs)).toEqual(['a']);
  });

  it('accepts a well-formed workflow and exposes the tree', () => {
    const parsed = parseWorkflow(workflow());
    expect(parsed.problems).toEqual([]);
    expect(parsed.js).toBeTruthy();
  });

  it("keeps `on` a string key, not the YAML 1.1 boolean true", () => {
    // If this ever flips, every trigger lookup silently finds nothing and the
    // gate passes vacuously on every file.
    const js = tree(workflow());
    expect(typeof js.on).toBe('object');
    expect(typeof js.on).not.toBe('boolean');
  });
});

describe('validateCron: a cron GitHub ignores is a job that never runs', () => {
  it('accepts every shape the repo actually uses', () => {
    for (const expr of [
      '17 7 3 * *',
      '23 9 * * 1',
      '53 7 * * 1',
      '0 1 29 10 *',
      '17 19 3 10 *',
      '*/15 * * * *',
      '0 0 1 1 0',
      '0,30 9-17 * * 1-5',
    ]) {
      expect(validateCron(expr, 'test'), expr).toEqual([]);
    }
  });

  it('rejects the wrong field count', () => {
    const problems = validateCron('17 7 3 *', 'on.schedule[0].cron');
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toMatch(/5 fields/);
  });

  it('rejects an out-of-range field, naming the field', () => {
    const problems = validateCron('70 25 32 13 9', 'on.schedule[0].cron');
    expect(problems.map((p) => p.message)).toEqual([
      expect.stringContaining('minute 70 is outside 0-59'),
      expect.stringContaining('hour 25 is outside 0-23'),
      expect.stringContaining('day-of-month 32 is outside 1-31'),
      expect.stringContaining('month 13 is outside 1-12'),
      expect.stringContaining('day-of-week 9 is outside 0-7'),
    ]);
    expect(problems).toHaveLength(CRON_FIELD_NAMES.length);
  });

  // Both ends of day-of-week matter: 0 and 7 are both Sunday in GitHub's
  // cron, so neither may be flagged, and 8 is genuinely out of range.
  it('treats day-of-week 0 and 7 as legal and 8 as not', () => {
    expect(validateCron('0 0 1 1 0', 'x')).toEqual([]);
    expect(validateCron('0 0 1 1 7', 'x')).toEqual([]);
    expect(validateCron('0 0 1 1 8', 'x')[0].message).toMatch(/day-of-week 8/);
  });

  it('rejects a missing or empty cron instead of passing vacuously', () => {
    expect(validateCron(undefined, 'x')[0].message).toMatch(/missing/);
    expect(validateCron('   ', 'x')[0].message).toMatch(/missing/);
  });

  it('reads bounds per field, so a valid hour is not judged as a minute', () => {
    expect(validateCron('23 7 * * *', 'x')).toEqual([]);
    expect(validateCron('0 23 * * *', 'x')).toEqual([]);
  });
});

describe('assessPermissions: resolved from the tree, not grepped', () => {
  it('passes a workflow-level issues: write', () => {
    expect(assessPermissions(parseWorkflow(poster('  contents: read\n  issues: write\n')).js)).toEqual([]);
  });

  // The Oct 3 bug exactly: no issues: write anywhere.
  it('fails the Oct 3 bug — a comment poster with no issues: write', () => {
    const problems = assessPermissions(parseWorkflow(poster('  contents: read\n')).js);
    expect(problems).toHaveLength(1);
    expect(problems[0].where).toBe('jobs.post');
    expect(problems[0].message).toMatch(/403|issues: write/);
  });

  // Weaker than the check in heartbeat-schedule-grace.test.ts, which greps
  // raw text: a job-level override is what GitHub actually applies.
  it('honours a job-level grant that overrides the workflow level', () => {
    const text = `on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  post:
    permissions:
      issues: write
    runs-on: ubuntu-latest
    steps:
      - run: gh api repos/o/r/issues/18/comments
  quiet:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    expect(assessPermissions(parseWorkflow(text).js)).toEqual([]);
  });

  // The inverse: a grant on a SIBLING job does not cover the posting job,
  // and a workflow-level grant is overridden by a job that lacks the scope.
  it('does not credit a grant held by a sibling job', () => {
    const text = `on:
  workflow_dispatch:
permissions:
  contents: read
  issues: write
jobs:
  quiet:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
  post:
    permissions:
      contents: read
    runs-on: ubuntu-latest
    steps:
      - run: gh api repos/o/r/issues/18/comments
`;
    const problems = assessPermissions(parseWorkflow(text).js);
    expect(problems).toHaveLength(1);
    expect(problems[0].where).toBe('jobs.post');
  });

  it('does not flag a workflow that never posts a comment', () => {
    const text = `on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo "no posting here"
`;
    expect(assessPermissions(parseWorkflow(text).js)).toEqual([]);
  });

  it('is inert on an unparseable document', () => {
    expect(assessPermissions(null)).toEqual([]);
  });
});

describe('collectCrons', () => {
  it('reads every schedule entry with its index', () => {
    const crons = collectCrons(parseWorkflow(workflow()).js);
    expect(crons).toEqual([{ expr: '0 1 4 10 *', where: 'on.schedule[0].cron' }]);
  });

  it('returns nothing for a workflow with no schedule', () => {
    expect(collectCrons(parseWorkflow('on:\n  workflow_dispatch:\njobs: {}\n').js)).toEqual([]);
  });
});

describe('assessPinWrites: CI checks a record, it never regenerates one', () => {
  /** A workflow whose only step is the parity check, with the args under test. */
  const parity = (args: string) =>
    workflow({
      jobs:
        'jobs:\n  compare:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run check:rehearsal-parity' +
        ` -- --dir engines ${args}\n`,
    });

  /** A workflow whose step runs `command`, under `if`, in a job with `contents`. */
  const runner = (command: string, guard?: string, contents = 'read') =>
    workflow({
      permissions: `permissions:\n  contents: ${contents}\n  issues: write\n`,
      jobs:
        `jobs:\n  refresh:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: ${contents}\n    steps:\n` +
        `      - run: ${command}\n${guard ? `        if: ${guard}\n` : ''}`,
    });

  it('passes the steps CI actually runs', () => {
    expect(assessPinWrites(tree(parity('')))).toEqual([]);
    // The snapshot refresh, gated to the runs that can commit it.
    expect(
      assessPinWrites(
        tree(runner('npm run update:schedule', "github.event_name == 'schedule'", 'write')),
      ),
    ).toEqual([]);
  });

  it('fails a step that regenerates the baseline, naming the job and the step', () => {
    const problems = assessPinWrites(tree(parity('--write-golden')));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ check: 'write', where: 'jobs.compare.steps[0]' });
    expect(problems[0].message).toContain('never');
    // Through the gate as well, so the helper being right is not the whole claim:
    // a finding nobody collects is a finding nobody sees.
    expect(checkWorkflow('x.yml', parity('--write-golden')).map((p) => p.check)).toContain('write');
  });

  it('fails a step that generates a pin, which is the same self-approval', () => {
    // `verify:generated --strict` reads tests/generated/, so a CI step that made a
    // pin would be writing the evidence it then passes on.
    for (const command of ['npm run new:pin -- projects-data/x', 'node scripts/new-generated-pin.mjs']) {
      const problems = assessPinWrites(tree(runner(command)));
      expect(problems, command).toHaveLength(1);
      expect(problems[0]).toMatchObject({ check: 'write', where: 'jobs.refresh.steps[0]' });
      expect(problems[0].message, command).toContain('tests/generated/');
    }
  });

  it('reads the parsed tree, so a comment naming either is not a finding', () => {
    // A comment is how a workflow explains itself. Only a step can run something.
    const explained =
      '# never run --write-golden or new:pin here: the pins are the point\n' + parity('');
    expect(checkWorkflow('x.yml', explained)).toEqual([]);
  });

  it('is inert on a document with no tree', () => {
    expect(assessPinWrites(null)).toEqual([]);
    expect(assessPinWrites('not an object')).toEqual([]);
  });

  it('allows the snapshot refresh only where it can be committed', () => {
    // The exception is declared, not assumed: the mirror is refreshed, the
    // result has to land somewhere. Unguarded it also runs on push and PR (where
    // a push would additionally be self-triggering).
    const unguarded = assessPinWrites(tree(runner('npm run update:schedule', undefined, 'write')));
    expect(unguarded).toHaveLength(1);
    expect(unguarded[0]).toMatchObject({ check: 'refresh', where: 'jobs.refresh.steps[0]' });
    expect(unguarded[0].message).toContain('no trigger guard');

    const onPush = assessPinWrites(tree(runner('npm run update:schedule', "github.event_name == 'push'", 'write')));
    expect(onPush.map((p) => p.check)).toEqual(['refresh']);

    // A guard is not enough on its own: a job that cannot push the refresh makes
    // it a rewrite of a file the runner discards.
    const readOnly = assessPinWrites(
      tree(runner('npm run update:schedule', "github.event_name == 'schedule'", 'read')),
    );
    expect(readOnly).toHaveLength(1);
    expect(readOnly[0].message).toContain('contents: write');

    // A dispatch on main is the other declared trigger.
    expect(
      assessPinWrites(
        tree(
          runner(
            'npm run update:schedule',
            "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
            'write',
          ),
        ),
      ),
    ).toEqual([]);
  });

  it('pins the policy itself rather than merely its absence', () => {
    // A new pattern or a new exception has to be a deliberate edit here.
    expect(PIN_WRITERS.map((entry) => entry.patterns)).toEqual([
      ['--write-golden'],
      ['new:pin', 'new-generated-pin'],
    ]);
    expect(REFRESHABLE_PIN).toMatchObject({
      patterns: ['update:schedule'],
      triggers: ['schedule', 'workflow_dispatch'],
    });
    expect(PIN_WRITERS.map((entry) => entry.pin).join()).toContain('scripts/rehearsal-golden/');
  });
});

describe('the real tree: this gate is green TODAY, for a reason', () => {
  it('holds for every workflow in .github/workflows', () => {
    const result = checkAll();
    expect(result.failures).toEqual([]);
    expect(result.checked).toBe(result.files.length);
    expect(result.checked).toBeGreaterThanOrEqual(9);
    expect(formatReport(result)).toContain('WORKFLOW_CONTRACT PASS');
  });

  // The specific state PR #58 left behind: three glued comments, two files.
  // These are the pins that would have failed before this change.
  it('has no comment glued to a cron (the oct3/oct28 defect)', () => {
    for (const file of ['oct3-verify.yml', 'oct28-verify.yml']) {
      const text = fs.readFileSync(path.join(DEFAULT_DIR, file), 'utf8');
      expect(text, file).not.toMatch(/cron:\s*'[^']*'#/);
    }
  });

  it('keeps every cron the scheduled verifiers depend on', () => {
    const expected: Record<string, string[]> = {
      'oct3-verify.yml': ['47 7 3 10 *', '7 9 3 10 *', '17 19 3 10 *'],
      'oct28-verify.yml': ['23 7 28 10 *', '33 9 28 10 *', '33 13 28 10 *', '33 19 28 10 *'],
      'oct4-sentinel.yml': ['0 1 4 10 *'],
      'oct29-sentinel.yml': ['0 1 29 10 *'],
      'heartbeat.yml': ['53 7 * * 1'],
      'ci.yml': ['17 7 3 * *'],
    };
    for (const [file, crons] of Object.entries(expected)) {
      const { js, problems } = parseWorkflow(
        fs.readFileSync(path.join(DEFAULT_DIR, file), 'utf8'),
      );
      expect(problems, file).toEqual([]);
      expect(collectCrons(js).map((c) => c.expr), file).toEqual(crons);
    }
  });

  // The smoke dispatch inputs are the operator's only way to test the
  // verifiers on any other day, and they are easy to lose in a reformat.
  it('keeps the verifier smoke dispatch inputs', () => {
    for (const file of ['oct3-verify.yml', 'oct28-verify.yml']) {
      const js = tree(fs.readFileSync(path.join(DEFAULT_DIR, file), 'utf8'));
      expect(Object.keys(js.on.workflow_dispatch.inputs), file).toEqual(['smoke']);
    }
  });

  // The fourth and fifth checks, applied to the tree as it stands: the parity job
  // reads the committed baseline out of the checkout, no job may regenerate a
  // record there, and the one mirror CI refreshes stays inside its guard.
  it('has no workflow that rewrites a committed record, and none that refreshes the snapshot unguarded', () => {
    for (const file of listWorkflows()) {
      const { js } = parseWorkflow(fs.readFileSync(path.join(DEFAULT_DIR, file), 'utf8'));
      expect(assessPinWrites(js), file).toEqual([]);
    }
  });

  it('refreshes the schedule snapshot in exactly one place, on the cron branch of ci.yml', () => {
    // If the refresh ever moves or gains a second home, the guard it carries has
    // to move with it - and the pair below is what would notice.
    const found: string[] = [];
    for (const file of listWorkflows()) {
      const { js } = parseWorkflow(fs.readFileSync(path.join(DEFAULT_DIR, file), 'utf8'));
      const jobs = (js?.jobs ?? {}) as Record<string, any>;
      for (const [jobName, job] of Object.entries(jobs)) {
        for (const step of (job?.steps ?? []) as Array<Record<string, any>>) {
          if (String(step?.run ?? '').includes('update:schedule')) found.push(`${file}:${jobName}`);
        }
      }
    }
    expect(found).toEqual(['ci.yml:matrix']);
  });

  it('finds only workflow files', () => {
    const files = listWorkflows();
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const f of files) expect(f).toMatch(/\.ya?ml$/);
    expect(listWorkflows(path.join(os.tmpdir(), 'no-such-dir-xyz'))).toEqual([]);
  });

  // The repo happens to use .yml everywhere, so a `.yaml` regression would be
  // invisible here and would silently stop auditing a whole workflow file.
  it('discovers .yaml as well as .yml, and ignores everything else', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ext-'));
    try {
      for (const name of ['a.yml', 'b.yaml', 'README.md', 'notes.txt', 'x.YML']) {
        fs.writeFileSync(path.join(dir, name), workflow());
      }
      fs.mkdirSync(path.join(dir, 'nested.yml'));
      const files = listWorkflows(dir);
      expect(files).toEqual(['a.yml', 'b.yaml']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A gate that nothing runs is documentation. These pins exist because every
// pin above would still pass if someone deleted the step from CI.
describe('the gate is wired where it blocks merges', () => {
  const actionText = () =>
    fs.readFileSync(path.join(DEFAULT_DIR, '..', 'actions', 'gates-steps', 'action.yml'), 'utf8');

  it('is a step in the shared gates-steps action', () => {
    // gates-steps is used by BOTH the blocking gates job and the canary, so
    // one step here covers both and they cannot drift apart.
    expect(actionText()).toContain('run: npm run check:workflows');
  });

  it('runs before the tests, so a bad workflow fails fast', () => {
    const text = actionText();
    expect(text.indexOf('check:workflows')).toBeGreaterThan(-1);
    expect(text.indexOf('check:workflows')).toBeLessThan(text.indexOf('run: npm test'));
  });

  it('has an npm script to call', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
    expect(pkg.scripts['check:workflows']).toBe('node scripts/check-workflows.mjs');
  });

  it('is reachable from ci-ok through the blocking gates job', () => {
    // ci-ok needs [matrix, gates, perf-gate, soak, rehearsals, rehearsal-parity]
    // and fails unless `gates` succeeded; gates runs gates-steps. That is the
    // whole blocking chain.
    const ci = fs.readFileSync(path.join(DEFAULT_DIR, 'ci.yml'), 'utf8');
    expect(ci).toMatch(
      /needs:\s*\[matrix,\s*gates,\s*perf-gate,\s*soak,\s*rehearsals,\s*rehearsal-parity\]/,
    );
    expect(ci).toMatch(/if \[ "\$\{\{ needs\.gates\.result \}\}" != "success" \]/);
    expect(ci).toMatch(/uses:\s*\.\/\.github\/actions\/gates-steps/);
  });

  // The rehearsals (scripts/rehearse-sentinels.ps1,
  // scripts/rehearse-lifecycle.mjs) exercise the PowerShell tools that decide a
  // verdict, and they used to run on a maintainer's Windows box or nowhere. Their
  // own pins live beside them; what is pinned HERE is the wiring that makes them
  // blockers - a job that exists but that nothing waits on is the local habit the
  // job was created to replace, and deleting it would leave every other pin here
  // green.
  it('gates the rehearsals job through ci-ok, and fails when it did not pass', () => {
    const ci = fs.readFileSync(path.join(DEFAULT_DIR, 'ci.yml'), 'utf8');
    expect(ci).toMatch(/if \[ "\$\{\{ needs\.rehearsals\.result \}\}" != "success" \]/);
    // ...and the same for the cross-engine comparison those legs feed (its own,
    // fuller pins live in tests/rehearsal-parity.test.ts).
    expect(ci).toMatch(/if \[ "\$\{\{ needs\.rehearsal-parity\.result \}\}" != "success" \]/);
    // The job itself: on a runner with PowerShell (pwsh is preinstalled on
    // ubuntu-latest, which is why the rehearsals can be blockers at all), and
    // without continue-on-error, which would make the verdict advisory.
    const { js } = parseWorkflow(ci);
    const job = js?.jobs?.rehearsals;
    expect(job, 'ci.yml has no rehearsals job').toBeDefined();
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['continue-on-error']).toBeUndefined();
    const steps = JSON.stringify(job.steps);
    expect(steps, 'the rehearsals job must run every rehearsal').toContain('npm run rehearse:sentinels');
    expect(steps, 'the rehearsals job must run every rehearsal').toContain('npm run rehearse:lifecycle');
    expect(steps, 'the rehearsals job must run every rehearsal').toContain('npm run rehearse:transports');
    // ...and name the engine first, so a runner with no PowerShell fails with
    // REHEARSE_PWSH_MISSING instead of leaving a green job that ran nothing.
    // (The step may quieten npm's banner, which is why this looks for the script
    // name rather than for one exact invocation.)
    expect(steps, 'the engine must be reported before anything is rehearsed').toContain('rehearse:which');
    expect(steps.indexOf('rehearse:which')).toBeLessThan(steps.indexOf('rehearse:sentinels'));
  });

  // The soak (scripts/soak-supervisor.mjs) is the reload-leak checking, run
  // against a REAL build. Its own pins live beside it in
  // tests/soak-supervisor.test.ts, which soaks the same tool against a FIXTURE —
  // a suite cannot demand that somebody ran `npm run build` first. What is pinned
  // HERE is the wiring that makes the real run happen at all: a job that nothing
  // builds for, or that nothing waits on, is the local habit it replaced.
  it('gates the soak job through ci-ok, and fails when it did not pass', () => {
    const ci = fs.readFileSync(path.join(DEFAULT_DIR, 'ci.yml'), 'utf8');
    expect(ci).toMatch(/if \[ "\$\{\{ needs\.soak\.result \}\}" != "success" \]/);
    const { js } = parseWorkflow(ci);
    const job = js?.jobs?.soak as Record<string, any> | undefined;
    expect(job, 'ci.yml has no soak job').toBeDefined();
    expect(job!['runs-on']).toBe('ubuntu-latest');
    // Not continue-on-error: a leak is a verdict, and an advisory one is the
    // silent-death shape this job exists to avoid.
    expect(job!['continue-on-error']).toBeUndefined();
    // Bounded like every other job here, so a soak that hangs ends as a failure
    // rather than as a runner that runs until the limit.
    expect(Number(job!['timeout-minutes'])).toBeGreaterThan(0);

    const steps = (job!.steps ?? []) as Array<Record<string, any>>;
    const text = JSON.stringify(steps);
    // The soak supervises the real `next start` over `.next`, so the job has to
    // build first: without a build the tool refuses to start at all (exit 2), and
    // that would be a red job proving nothing.
    expect(text).toContain('npm run build');
    expect(text.indexOf('npm run build')).toBeLessThan(text.indexOf('soak:supervisor'));
    // TWELVE reloads: the smallest count at which every phase's descriptor floor
    // is judged (four readings each — at three, the check reports itself as NOT
    // JUDGED), and the count `--handle-slack` was measured against. A smaller
    // number here would be a soak that runs and checks less than it claims.
    expect(text, 'the soak must run enough reloads to judge every phase').toContain('--reloads 12');
    // ...and reached through `--silent`, because this step REDIRECTS stdout into the
    // artifact below: plain `npm run` prefixes its banner to stdout, which turns a
    // green job's summary into a file nothing can parse. (The behavior itself is
    // pinned beside the soak, in tests/soak-supervisor.test.ts.)
    expect(text, 'the summary is redirected to a file, so npm must not write on stdout').toContain(
      'npm run --silent soak:supervisor',
    );
    // Pinned to the oldest blocking leg, resolved the way the perf gate resolves
    // it, so the two cannot drift into measuring different Nodes.
    expect(steps.some((step) => String(step?.id ?? '') === 'node')).toBe(true);
    expect(text).toContain('needs.matrix.outputs.legs');
    expect(text).toContain('steps.node.outputs.version');
    // And the account survives the run: a FAILING soak's summary, and the history
    // the gate reads, are what a diagnosis needs most.
    const upload = steps.find((step) => String(step?.uses ?? '').includes('upload-artifact'));
    expect(upload, 'the soak job must upload the account of its run').toBeDefined();
    expect(String(upload?.if)).toContain('always()');
    expect(JSON.stringify(upload)).toContain('soak-summary.json');

    // THE TREND, read after the soak wrote it: the record of what the run COST, which
    // is the thing no single run's leak verdict can see. The path matters as much as
    // the command — the gate has to read the file the soak wrote, so both name the
    // run's own `--dir`, and the artifact carries that file forward.
    expect(text, 'the job must judge the trend its own soak wrote').toContain('check:soak-trend');
    expect(text).toContain('${{ runner.temp }}/soak/soak-trend.jsonl');
    expect(text.indexOf('soak:supervisor')).toBeLessThan(text.indexOf('check:soak-trend'));
    expect(JSON.stringify(upload)).toContain('soak-trend.jsonl');

    // The app's OWN output travels with the account: a lost client is named by the ordinal it
    // was handed to the door at, and that ordinal is on the request the client asked with — so
    // the line that answers "what did the app do with it" is in the server's log, and an
    // artifact without it names the client and stops there.
    expect(text).toContain('${{ runner.temp }}/soak/server.log');
    expect(JSON.stringify(upload)).toContain('server.log');
  });

  it('rehearses more than one PowerShell line, and each leg proves which one it got', () => {
    // The defect this job caught was not a bug in a script but a property of the
    // engine: ConvertFrom-Json converts an ISO instant to [DateTime] on every
    // PowerShell 7, while Windows PowerShell 5.1 - the only engine the rehearsals
    // had ever run on - leaves it a string. So a matrix of one line would report
    // on engines it never saw, which is how a version-blind rehearsal passes.
    const ci = fs.readFileSync(path.join(DEFAULT_DIR, 'ci.yml'), 'utf8');
    const { js } = parseWorkflow(ci);
    const engines: unknown = js?.jobs?.rehearsals?.strategy?.matrix?.pwsh;
    expect(Array.isArray(engines), `no pwsh matrix in ci.yml: ${JSON.stringify(engines)}`).toBe(true);
    const series = (engines as string[]).map(String);
    expect(series.length, `one line is not a matrix: ${series}`).toBeGreaterThanOrEqual(2);
    expect(new Set(series).size, `the legs must name distinct lines: ${series}`).toBe(series.length);
    for (const s of series) expect(s, `a series, not a patch version: ${s}`).toMatch(/^7\.\d+$/);
    // ...and each leg proves WHICH engine it got, through the rehearsals' own
    // reporter rather than a second copy of the version check, and against the
    // exact patch it installed rather than only the series: a leg that fell back to
    // the image's pwsh - even one of the same series - would be a single engine
    // wearing two version numbers, and the matrix would be decoration.
    expect(ci, 'the leg must ask the rehearsals which engine they resolve').toMatch(
      /npm run --silent rehearse:which/,
    );
    expect(ci, '...and compare it with the engine it installed').toMatch(
      /steps\.pwsh\.outputs\.version/,
    );
    expect(ci, '...and fail when they differ').toMatch(/if \[ "\$got" != "\$want" \]/);
    // The install step is what makes the matrix real: without it every leg would
    // run the image's single engine.
    expect(ci, 'the leg must install the engine it claims').toMatch(
      /powershell-\$version-linux-x64\.tar\.gz/,
    );
  });
});

describe('checkWorkflow and checkAll: the failure path', () => {
  it('reports parse, cron, and perms problems against a fixture dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-check-'));
    try {
      // One file, three defects at once — a gate reporting only the first
      // problem would need three round trips to fix one file.
      fs.writeFileSync(
        path.join(dir, 'bad.yml'),
        `on:
  schedule:
    - cron: '99 7 * * *'# glued
  workflow_dispatch:
permissions:
  contents: read
jobs:
  post:
    runs-on: ubuntu-latest
    steps:
      - run: gh api repos/o/r/issues/18/comments
`,
      );
      fs.writeFileSync(path.join(dir, 'good.yml'), workflow());
      const result = checkAll(dir);
      expect(result.checked).toBe(2);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].file).toBe('bad.yml');
      const checks = result.failures[0].problems.map((p) => p.check);
      expect(checks).toContain('parse');
      expect(checks).toContain('cron');
      expect(checks).toContain('perms');
      const report = formatReport(result, dir);
      expect(report).toContain('WORKFLOW_CONTRACT FAIL');
      expect(report).toContain('bad.yml');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the check and location on every finding', () => {
    const problems = checkWorkflow('bad.yml', poster('  contents: read\n'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ file: 'bad.yml', check: 'perms' });
    expect(problems[0].where).toBeTruthy();
  });

  it('exits 0 on the real tree from the command line', () => {
    // The gate has to work as a process, not only as an import.
    const out = execFileSync(process.execPath, ['scripts/check-workflows.mjs'], {
      cwd: path.join(HERE, '..'),
      encoding: 'utf8',
    });
    expect(out).toContain('WORKFLOW_CONTRACT PASS');
  });

  // THE point of the gate: a non-zero exit is what blocks ci-ok. A gate that
  // always exits 0 reports problems and blocks nothing, so this is pinned
  // against a fixture dir rather than the real tree (which must stay green).
  it('exits NON-ZERO on a failing tree, which is what blocks ci-ok', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-exit-'));
    try {
      fs.writeFileSync(path.join(dir, 'ok.yml'), workflow());
      const green = spawnSync(
        process.execPath,
        ['scripts/check-workflows.mjs', '--dir', dir],
        { cwd: path.join(HERE, '..'), encoding: 'utf8' },
      );
      expect(green.status).toBe(0);

      fs.writeFileSync(
        path.join(dir, 'bad.yml'),
        "on:\n  schedule:\n    - cron: '99 7 * * *'# glued\njobs:\n  a:\n    runs-on: x\n",
      );
      const red = spawnSync(
        process.execPath,
        ['scripts/check-workflows.mjs', '--dir', dir],
        { cwd: path.join(HERE, '..'), encoding: 'utf8' },
      );
      expect(red.status).toBe(1);
      expect(red.stdout).toContain('WORKFLOW_CONTRACT FAIL');
      expect(red.stdout).toContain('bad.yml');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints machine-readable findings with --json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-json-'));
    try {
      fs.writeFileSync(path.join(dir, 'bad.yml'), "on:\n  schedule:\n    - cron: '1 2'\njobs: {}\n");
      const r = spawnSync(
        process.execPath,
        ['scripts/check-workflows.mjs', '--dir', dir, '--json'],
        { cwd: path.join(HERE, '..'), encoding: 'utf8' },
      );
      expect(r.status).toBe(1);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.failures[0].file).toBe('bad.yml');
      expect(parsed.failures[0].problems[0].check).toBe('cron');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});