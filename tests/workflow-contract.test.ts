// Pins for the workflow contract gate: scripts/check-workflows.mjs.
//
// Every other gate in this repo inspects CODE. Nothing inspected the workflow
// files, so all nine CI legs could be green while a workflow was invalid —
// which is exactly what happened: three comments sat glued to a quoted cron
// (`'17 19 3 10 *'# note`) since PR #58, tolerated by GitHub's lenient parser
// and invisible to every check. A green run that is not a verdict, the same
// class as the lost Oct 3 verdict in #129.
//
// The three checks, and the real failure each one exists for:
//   1. PARSE — the glued comments (MISSING_CHAR), plus duplicate keys, which
//      a lenient parser resolves by silently keeping the last value.
//   2. CRON  — GitHub IGNORES a cron it cannot parse: no run, no error, no
//      notification. A malformed cron is a scheduled job that does not exist.
//   3. PERMS — a workflow posting an issue comment without issues: write gets
//      403 "Resource not accessible by integration" and still exits 0. That
//      is the Oct 3 verdict, lost.
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
  assessPermissions,
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
    // ci-ok needs [matrix, gates, perf-gate] and fails unless `gates`
    // succeeded; gates runs gates-steps. That is the whole blocking chain.
    const ci = fs.readFileSync(path.join(DEFAULT_DIR, 'ci.yml'), 'utf8');
    expect(ci).toMatch(/needs:\s*\[matrix,\s*gates,\s*perf-gate\]/);
    expect(ci).toMatch(/if \[ "\$\{\{ needs\.gates\.result \}\}" != "success" \]/);
    expect(ci).toMatch(/uses:\s*\.\/\.github\/actions\/gates-steps/);
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