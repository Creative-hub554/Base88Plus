/**
 * The cross-engine rehearsal parity check, pinned.
 *
 * `scripts/rehearsal-parity.mjs` compares the sentinel and lifecycle rehearsals'
 * output across the PowerShell lines the `rehearsals` job in ci.yml runs, so a
 * behaviour that lives in the ENGINE rather than in the scripts cannot pass
 * unnoticed. That is not hypothetical: `ConvertFrom-Json` converts an ISO instant
 * to `[DateTime]` on every PowerShell 7 and never did on Windows PowerShell 5.1,
 * and a rehearsal that had only ever run on 5.1 therefore never saw the window
 * slide by the machine's UTC offset — one engine's green was read as both
 * engines' verdict.
 *
 * What is pinned here is the part that could rot silently, because none of it is
 * visible in CI's own logs when it works:
 *
 *   - the comparison's THREE normalisation rules are the whole of it — a pipe's
 *     line endings, the directory a failing run names as its evidence, and the
 *     directory of a `fixture=` path — so a fourth one cannot be slipped in to
 *     make a real disagreement pass;
 *   - a content difference FAILS, naming the suite, the two engines and the line,
 *     because a parity check that reports "somewhere, something differs" is a
 *     parity check nobody can act on;
 *   - ONE INPUT IS NOT A CHECK: a single engine's output fails the run, which is
 *     what makes the version matrix load-bearing rather than decorative;
 *   - the COMMITTED BASELINE, which is the half a cross-engine comparison cannot
 *     be: two legs run the same test on the same commit, so a change that moves
 *     both engines together — a scenario renamed, a verdict flipped, a count
 *     edited — passes that comparison by construction. The baseline is the
 *     rehearsal's own report lines with the machine's directories masked, pinned
 *     here against the fixture that declares the scenarios, and pinned to be
 *     portable (no CR, no absolute path) because it is read on whatever machine
 *     runs the check;
 *   - the legs upload their output and a separate job compares it, and that job is
 *     a blocker — the wiring, not just the script;
 *   - the suite list itself is read out of the workflow's legs (LEG_SUITES), so
 *     every pin below fails for a FOURTH rehearsal nobody declared with a marker
 *     and a committed baseline — not only for the suites listed here today.
 *
 * The comparison over real engines is the executable half: the matrix runs it in
 * CI, and the three engines this repo can reach locally (pwsh 7.4, pwsh 7.6,
 * Windows PowerShell 5.1) were compared by hand before this file existed — all
 * three matching the committed baseline, and both suites passing against it from a
 * Windows capture (CRLF, `C:\…` paths) and from a POSIX one, with a warning line
 * appended that the baseline must not have to carry.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseWorkflow } from '../scripts/check-workflows.mjs';
import {
  DEFAULT_GOLDEN_DIR,
  EVIDENCE_PATH_LINES,
  FIXTURE_DIRECTORY,
  REPORT_MARKERS,
  collect,
  collectGolden,
  compare,
  compareToBaseline,
  firstDifference,
  formatReport,
  normalize,
  project,
} from '../scripts/rehearsal-parity.mjs';

const CI = path.join(process.cwd(), '.github', 'workflows', 'ci.yml');
const ciText = () => readFileSync(CI, 'utf8');
const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/** The committed baseline, and the fixtures that declare what it must contain. */
const GOLDEN = path.join(process.cwd(), 'scripts', 'rehearsal-golden');
const goldenText = (suite: string) => readFileSync(path.join(GOLDEN, `rehearsal-${suite}.txt`), 'utf8');
const readJson = (file: string) =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'scripts', file), 'utf8')) as {
    scenarios?: { name: string }[];
    steps?: { name: string }[];
    cases?: { name: string }[];
  };

/**
 * The suites the `rehearsals` job ACTUALLY runs, read out of the workflow rather than
 * listed here.
 *
 * A leg and a suite are the same thing — every step writes
 * `$RUNNER_TEMP/rehearsal-output/rehearsal-<suite>.txt` — so reading the legs is what
 * makes the pins below (`has a marker`, `has an npm script`, `has a committed
 * baseline`) fail for a rehearsal somebody adds to CI next month, instead of only for
 * the three that exist while this file is being written. The literal check at the end
 * keeps the derivation honest: a regex that matched nothing would satisfy every loop.
 */
const LEG_SUITES = [...ciText().matchAll(/rehearsal-output\/rehearsal-([a-z0-9-]+)\.txt/g)]
  .map((match) => match[1])
  .sort();

/**
 * A leg's captured output as CI records it: npm's banner, the fixture named from a
 * real checkout, the stream as the pipe delivered it, and whatever the engine
 * printed alongside the report.
 */
function capture(report: string, { crlf = false, warning = false, root = '/home/runner/work/b/x/scripts' } = {}) {
  const sep = root.includes('\\') ? '\\' : '/';
  const body = report.replace(
    /^(REHEARSAL|LIFECYCLE|TRANSPORT) fixture=(\S+)/gm,
    (_match, marker: string, name: string) => `${marker} fixture=${root}${sep}${name}`,
  );
  const banner = '\n> anybase@0.10.0 rehearse:whatever\n> node scripts/rehearse-something.mjs\n\n';
  const text = `${banner}${body}${warning ? 'WARNING: Resulting JSON is truncated as serialization has exceeded the set depth of 2.\n' : ''}`;
  return crlf ? text.replace(/\n/g, '\r\n') : text;
}

/** The two-scenario sample above as it would be committed: report lines only, LF. */
const SENTINELS_BASELINE =
  'REHEARSAL fixture=sentinel-rehearsal.json scenarios=2\n' +
  'REHEARSAL OK   oct29: a PASS landed, so the trip never happens\n' +
  'REHEARSAL OK   oct29: a PASS recorded BEFORE promotion day does not clear it\n' +
  'REHEARSAL_DONE scenarios=2 failed=0 roundtrip=10 recognised=8\n';

/** A rehearsal output, real in shape: the summary the two harnesses print. */
const SENTINELS = [
  'REHEARSAL fixture=/w/scripts/sentinel-rehearsal.json scenarios=2',
  'REHEARSAL OK   oct29: a PASS landed, so the trip never happens',
  'REHEARSAL OK   oct29: a PASS recorded BEFORE promotion day does not clear it',
  '',
  'REHEARSAL_DONE scenarios=2 failed=0 roundtrip=10 recognised=8',
  '',
].join('\n');

/** One engine's copy, in the artifact layout the parity job downloads. */
function layout(dir: string, engine: string, suite: string, text: string) {
  const at = path.join(dir, `rehearsal-output-${engine}`);
  mkdirSync(at, { recursive: true });
  writeFileSync(path.join(at, `rehearsal-${suite}.txt`), text);
}

/**
 * A COMPLETE leg, as CI captures it: every suite the `rehearsals` job runs, in the
 * artifact layout the parity job downloads — the same set LEG_SUITES reads out of the
 * workflow.
 *
 * Derived rather than listed, because a baseline is only checked when a leg uploaded
 * that suite: a fixture that quietly left the third one out is no longer a passing
 * run (it reports the baseline as covering nothing), so the tests that are ABOUT a
 * missing suite lay their own capture out instead of leaning on this one.
 */
function completeLeg(dir: string, engine: string, options: Parameters<typeof capture>[1] = {}) {
  for (const suite of LEG_SUITES) layout(dir, engine, suite, capture(goldenText(suite), options));
}

const tmps: string[] = [];
function fixtureDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'parity-'));
  tmps.push(dir);
  return dir;
}
const cleanUp = () => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
};

describe('what counts as a difference', () => {
  it('normalises exactly three things, and all three are the capture rather than the engine', () => {
    // A pipe's line endings: Windows PowerShell re-emits a child's stdout with
    // CRLF, pwsh on Linux does not. The local three-engine comparison first
    // reported a difference on the harness's own first line, and the whole
    // disagreement was a \r.
    expect(normalize('a\r\nb\r\n')).toBe(normalize('a\nb\n'));
    // The directory a FAILING run names as its evidence: a machine fact, not a
    // verdict. The list is exported so a third entry has to be a deliberate edit.
    expect(EVIDENCE_PATH_LINES).toEqual(['REHEARSAL_LOGS ', 'REHEARSAL_WORLDS ']);
    expect(normalize('REHEARSAL_WORLDS /home/runner/_temp/worlds\n')).toBe(
      normalize('REHEARSAL_WORLDS C:/somewhere/else/worlds\n'),
    );
    for (const marker of EVIDENCE_PATH_LINES) {
      expect(normalize(`${marker}/tmp/one\n`), marker).toBe(`${marker}<machine-specific directory>\n`);
    }
    // The third exists because the baseline is COMMITTED: the same run captured on
    // the runner and on the author's box names the same fixture from different
    // checkouts. Only the directory goes; the file name is what a reviewer reads
    // and what tells one fixture from another.
    const fixture = (p: string) => normalize(`REHEARSAL fixture=${p} scenarios=16\n`);
    expect(fixture('C:\\Workspace\\Base88\\scripts\\sentinel-rehearsal.json')).toBe(
      fixture('/home/runner/work/b/x/scripts/sentinel-rehearsal.json'),
    );
    expect(fixture('C:\\Workspace\\Base88\\scripts\\sentinel-rehearsal.json')).toBe(
      'REHEARSAL fixture=sentinel-rehearsal.json scenarios=16\n',
    );
    // The rule is pinned by its source rather than with `.test()`, because the
    // regex carries /g: a second `.test()` on the same instance would read stale
    // lastIndex and answer false. `normalize` uses it through `String.replace`,
    // which resets that state.
    expect(String(FIXTURE_DIRECTORY)).toBe('/fixture=(?:[A-Za-z]:)?[^\\s]*[\\\\/]/g');
    // ...the NAME is not masked, and a path that is already only a name (or a
    // verdict line that merely mentions a directory) is left alone.
    expect(fixture('C:\\Workspace\\Base88\\scripts\\oct29-sentinel.json')).not.toBe(
      fixture('C:\\Workspace\\Base88\\scripts\\sentinel-rehearsal.json'),
    );
    expect(normalize('REHEARSAL fixture=x.json scenarios=16\n')).toBe('REHEARSAL fixture=x.json scenarios=16\n');
    // ...and nothing else is smoothed over: a verdict, a scenario name, a count or
    // a path printed anywhere but at the start of a declared marker still differs.
    expect(normalize('REHEARSAL FAIL oct29: a PASS landed\n')).not.toBe(
      normalize('REHEARSAL OK   oct29: a PASS landed\n'),
    );
    expect(normalize('REHEARSAL OK   oct29: a PASS landed, see /tmp/worlds\n')).not.toBe(
      normalize('REHEARSAL OK   oct29: a PASS landed, see /other/worlds\n'),
    );
    expect(normalize('REHEARSAL_DONE scenarios=2 failed=0\n')).not.toBe(
      normalize('REHEARSAL_DONE scenarios=2 failed=1\n'),
    );
  });

  it('keeps the rehearsal\'s own report for the baseline, and nothing that merely shared the pipe', () => {
    // A whitelist, because the baseline is a FILE in the repository: npm's banner
    // would make every version bump a baseline failure, and an engine's warning
    // would make the baseline fail on whichever engine does not emit it.
    const raw = [
      '',
      '> anybase@0.10.0 rehearse:sentinels',
      '> node scripts/rehearse-pwsh.mjs -File scripts/rehearse-sentinels.ps1',
      '',
      ...SENTINELS.split('\n'),
      'WARNING: Resulting JSON is truncated as serialization has exceeded the set depth of 2.',
      '',
    ].join('\n');
    expect(project('sentinels', raw)).toBe(SENTINELS_BASELINE);
    // The markers are declared per suite, and the pin below ties them to the
    // suites the rehearsals job actually writes.
    expect(REPORT_MARKERS).toEqual({
      sentinels: 'REHEARSAL',
      lifecycle: 'LIFECYCLE',
      transports: 'TRANSPORT',
    });
    expect(project('lifecycle', 'LIFECYCLE OK   one\n  9000000000  2026-10-04T01:00:12Z  a comment\nnoise\n')).toBe(
      'LIFECYCLE OK   one\n  9000000000  2026-10-04T01:00:12Z  a comment\n',
    );
    // A report that is not there at all projects to nothing - which is how a
    // rehearsal that printed only noise fails against a baseline that has content.
    expect(project('sentinels', '> anybase@0.10.0 rehearse:sentinels\nWARNING: nothing ran\n')).toBe('');
    // A suite with NO declared marker projects to nothing, whatever it printed:
    // what counts as its report is unknown, so neither answer is safe — keeping
    // everything freezes a banner and an engine's warning into a committed file,
    // and comparing nothing passes vacuously. Both consumers refuse instead, which
    // is what makes a third rehearsal fail loudly until its marker is declared.
    expect(project('something-new', 'A new report\r\n')).toBe('');
    expect(project('something-new', '> anybase@0.10.0 rehearse:third\nWARNING: nothing ran\n')).toBe('');
    // Exactly one trailing newline, so what was written can be read back and
    // compared as-is: project(project(x)) is project(x).
    for (const text of [raw, SENTINELS, SENTINELS.replace(/\n/g, '\r\n'), '']) {
      expect(project('sentinels', project('sentinels', text))).toBe(project('sentinels', text));
    }
    expect(project('sentinels', SENTINELS)).toMatch(/\n$/);
  });

  it('reports the first differing line, so a failure points somewhere', () => {
    const drifted = SENTINELS.replace(
      'a PASS recorded BEFORE promotion day does not clear it',
      'a PASS recorded BEFORE promotion day clears it',
    );
    expect(firstDifference(SENTINELS, drifted)).toEqual({
      line: 3,
      reference: 'REHEARSAL OK   oct29: a PASS recorded BEFORE promotion day does not clear it',
      actual: 'REHEARSAL OK   oct29: a PASS recorded BEFORE promotion day clears it',
    });
    // A truncated output is a difference too, and the report says which side ran
    // out of lines - an engine whose rehearsal stopped half way through is exactly
    // what a comparison like this exists to surface.
    expect(firstDifference(SENTINELS, `${SENTINELS.split('\n')[0]}\n`)).toMatchObject({
      line: 2,
      reference: 'REHEARSAL OK   oct29: a PASS landed, so the trip never happens',
      actual: '',
    });
    expect(firstDifference('a\nb\nc', 'a')).toMatchObject({
      line: 2,
      reference: 'b',
      actual: '<no line - the output ended>',
    });
    expect(firstDifference(SENTINELS, SENTINELS)).toBeNull();
  });

  it('agrees across engines when the engines agree', () => {
    const dir = fixtureDir();
    layout(dir, '7.4.20', 'sentinels', SENTINELS.replace(/\n/g, '\r\n'));
    layout(dir, '7.6.6', 'sentinels', SENTINELS);
    const result = compare(collect(dir));
    expect(result.failures).toEqual([]);
    expect(result.agreed).toEqual([{ suite: 'sentinels', engines: ['7.4.20', '7.6.6'] }]);
    cleanUp();
  });

  it('fails a content difference, naming the suite, both engines and the line', () => {
    const dir = fixtureDir();
    layout(dir, '7.4.20', 'sentinels', SENTINELS);
    // The shape of the defect this whole mechanism exists for: one engine's run
    // says the promotion-day window held no verdict, the other's does not.
    layout(dir, '7.6.6', 'sentinels', SENTINELS.replace('failed=0', 'failed=1'));
    const result = compare(collect(dir));
    expect(result.agreed).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      kind: 'differs',
      suite: 'sentinels',
      engines: ['7.4.20', '7.6.6'],
      line: 5,
      reference: 'REHEARSAL_DONE scenarios=2 failed=0 roundtrip=10 recognised=8',
      actual: 'REHEARSAL_DONE scenarios=2 failed=1 roundtrip=10 recognised=8',
    });
    cleanUp();
  });

  it('treats one engine as a vacuous comparison rather than a pass', () => {
    const dir = fixtureDir();
    layout(dir, '7.6.6', 'sentinels', SENTINELS);
    layout(dir, '7.6.6', 'lifecycle', 'LIFECYCLE_DONE steps=8 failed=0 recovered=1\n');
    const result = compare(collect(dir));
    expect(result.agreed).toEqual([]);
    expect(result.failures.map((f) => [f.kind, f.suite])).toEqual([
      ['vacuous', 'lifecycle'],
      ['vacuous', 'sentinels'],
    ]);
    cleanUp();
  });

  it('is strict about noise: an engine that printed something the other did not', () => {
    // A warning is not a verdict, but it IS a difference between two engines, and
    // this comparison is the only place it can be seen. The baseline is what does
    // NOT have to carry it - see `project`.
    const dir = fixtureDir();
    layout(dir, '7.4.20', 'sentinels', `${SENTINELS}WARNING: Resulting JSON is truncated.\n`);
    layout(dir, '7.6.6', 'sentinels', SENTINELS);
    const result = compare(collect(dir));
    expect(result.agreed).toEqual([]);
    expect(result.failures[0]).toMatchObject({ kind: 'differs', suite: 'sentinels', line: 6 });
    expect(result.failures[0].reference).toBe('WARNING: Resulting JSON is truncated.');
    // What the other engine printed there: nothing (its report ends with a blank
    // line), so the failure shows the extra line rather than inventing one.
    expect(result.failures[0].actual).toBe('');
    cleanUp();
  });

  it('fails a suite only one engine uploaded, even when another suite agreed', () => {
    // A leg that crashed before the second rehearsal would otherwise leave the
    // suite it did upload looking verified.
    const dir = fixtureDir();
    for (const engine of ['7.4.20', '7.6.6']) layout(dir, engine, 'sentinels', SENTINELS);
    layout(dir, '7.4.20', 'lifecycle', 'LIFECYCLE_DONE steps=8 failed=0 recovered=1\n');
    const result = compare(collect(dir));
    expect(result.agreed).toEqual([{ suite: 'sentinels', engines: ['7.4.20', '7.6.6'] }]);
    expect(result.failures).toEqual([{ kind: 'vacuous', suite: 'lifecycle', engines: ['7.4.20'] }]);
    cleanUp();
  });

  it('finds nothing in an empty directory instead of passing one', () => {
    const dir = fixtureDir();
    expect(collect(dir)).toEqual([]);
    expect(compare([]).failures).toEqual([]);
    expect(compare([]).suites).toEqual([]);
    // No failures and nothing compared: the CLI treats that as a FAILURE (no
    // output at all means the comparison never happened), which is why the report
    // has to say so rather than print an empty PASS.
    const report = formatReport(compare([]), dir);
    expect(report).toContain('no rehearsal output found at all');
    expect(report).toContain('REHEARSAL_PARITY FAIL');
    cleanUp();
  });
});

describe('the committed baseline', () => {
  it('is where the default says it is, and is read through the same comparison', () => {
    expect(DEFAULT_GOLDEN_DIR.toLowerCase()).toBe(GOLDEN.toLowerCase());
    const found = collectGolden(DEFAULT_GOLDEN_DIR);
    // Read from the workflow, not from a list here: a committed baseline exists
    // because a LEG writes one, and it is the legs that are the set under check.
    expect(found.map((file) => file.suite).sort()).toEqual(LEG_SUITES);
    // Not a copy of a leg's output: what is committed is the projection, so the
    // check compares like with like and a reviewer reads the verdicts, not a banner.
    for (const { suite, text } of found) {
      expect(project(suite, text), suite).toBe(text);
    }
  });

  it('holds every scenario and step the fixtures declare, in order', () => {
    // The baseline is pinned to the FIXTURES rather than to itself: a scenario
    // added to (or removed from) a fixture fails here until the baseline is
    // regenerated, which is what makes an edit to what the rehearsals observe a
    // diff somebody had to choose.
    const sentinels = goldenText('sentinels').split('\n').filter(Boolean);
    const scenarioNames = sentinels.filter((line) => line.startsWith('REHEARSAL OK')).map((l) => l.replace(/^REHEARSAL OK\s+/, ''));
    const sentinelFixture = readJson('sentinel-rehearsal.json').scenarios ?? [];
    expect(scenarioNames).toEqual(sentinelFixture.map((scenario) => scenario.name));
    expect(sentinels.at(-1)).toBe(
      `REHEARSAL_DONE scenarios=${sentinelFixture.length} failed=0 roundtrip=10 recognised=8`,
    );

    const lifecycle = goldenText('lifecycle').split('\n').filter(Boolean);
    const stepNames = lifecycle.filter((line) => line.startsWith('LIFECYCLE OK')).map((l) => l.replace(/^LIFECYCLE OK\s+/, ''));
    const lifecycleFixture = readJson('rehearsal-lifecycle.json').steps ?? [];
    expect(stepNames).toEqual(lifecycleFixture.map((step) => step.name));
    expect(lifecycle.at(-1)).toBe(`LIFECYCLE_DONE steps=${lifecycleFixture.length} failed=0 recovered=1`);
    // The #18 comment trail is part of what the lifecycle rehearsal observers, so
    // it is part of the baseline.
    expect(lifecycle.some((line) => line.startsWith('LIFECYCLE trail'))).toBe(true);
    expect(lifecycle.filter((line) => /^\s{2}9\d{9}\s/.test(line)).length).toBeGreaterThanOrEqual(3);

    // The transport rehearsal against ITS fixture, the same way: one line per case,
    // in the fixture's order, so a case added to transport-rehearsal.json fails here
    // until the transports have been asked it and the baseline regenerated.
    const transports = goldenText('transports').split('\n').filter(Boolean);
    const caseNames = transports
      .filter((line) => line.startsWith('TRANSPORT OK'))
      .map((line) => line.replace(/^TRANSPORT OK\s+/, '').split(':')[0]);
    const transportFixture = readJson('transport-rehearsal.json').cases ?? [];
    expect(caseNames).toEqual(transportFixture.map((testCase) => testCase.name));
    expect(transports.at(-1)).toBe(`TRANSPORT_DONE cases=${transportFixture.length} failed=0`);
    // Not a copy of one engine's capture: the fixture path is masked and the ledger a
    // failing run points at is not part of the report at all.
    expect(transports[0]).toBe(`TRANSPORT fixture=transport-rehearsal.json cases=${transportFixture.length}`);
  });

  it('is portable, because a baseline that names its author\'s machine can never match', () => {
    for (const suite of LEG_SUITES) {
      const text = goldenText(suite);
      expect(text, `${suite}: CRLF`).not.toContain('\r');
      expect(text.endsWith('\n'), `${suite}: one trailing newline`).toBe(true);
      expect(text, `${suite}: no absolute path`).not.toMatch(/(^|[\s=])(?:[A-Za-z]:[\\/]|\/(?:home|Users|tmp|runner)\b)/m);
      expect(text, `${suite}: no machine directory marker`).not.toContain('<machine-specific directory>');
    }
  });

  it('matches an engine, and fails one that drifted, naming the line', () => {
    const dir = fixtureDir();
    // Two captures of the same run that do not look alike: one machine's Windows
    // checkout and CRLF, the other a POSIX one, and a warning both engines emit.
    layout(dir, '7.4.20', 'sentinels', capture(goldenText('sentinels'), { crlf: true, warning: true, root: 'C:\\W\\b\\scripts' }));
    layout(dir, '7.6.6', 'sentinels', capture(goldenText('sentinels'), { warning: true }));
    const baselines = [{ suite: 'sentinels', path: path.join(GOLDEN, 'rehearsal-sentinels.txt'), text: goldenText('sentinels') }];
    expect(compareToBaseline(collect(dir), baselines).failures).toEqual([]);
    expect(compareToBaseline(collect(dir), baselines).matched).toEqual([
      { suite: 'sentinels', engines: ['7.4.20', '7.6.6'] },
    ]);

    // The change a cross-engine comparison cannot see: EVERY engine moves with the
    // same edit, so the legs still agree with each other.
    const drifted = fixtureDir();
    for (const engine of ['7.4.20', '7.6.6']) {
      layout(drifted, engine, 'sentinels', capture(goldenText('sentinels').replace('does not clear it', 'clears it')));
    }
    const both = compare(collect(drifted), baselines);
    expect(both.agreed).toEqual([{ suite: 'sentinels', engines: ['7.4.20', '7.6.6'] }]);
    expect(both.failures.map((failure) => [failure.kind, failure.line, failure.engines])).toEqual([
      ['baseline', 9, ['7.4.20']],
      ['baseline', 9, ['7.6.6']],
    ]);
    expect(both.failures[0].reference).toContain('a PASS recorded BEFORE promotion day does not clear it');
    expect(both.failures[0].actual).toContain('a PASS recorded BEFORE promotion day clears it');
    expect(formatReport(both, drifted)).toContain('no longer matches the committed baseline');

    // And a suite with no baseline at all is not silently uncovered.
    const missing = compare(collect(dir), []);
    expect(missing.failures).toEqual([{ kind: 'baseline-missing', suite: 'sentinels', engines: [] }]);
    expect(formatReport(missing, dir, '/nowhere')).toContain('no committed baseline at');
    cleanUp();
  });

  it('refuses a suite whose report grammar is undeclared, rather than passing it', () => {
    // A third rehearsal added to the job with no REPORT_MARKERS entry: comparing it
    // would be comparing two empty projections, and writing it would freeze its raw
    // capture (npm's banner, the engine's warning) into a committed baseline — the
    // very things the projection exists to keep out.
    const dir = fixtureDir();
    layout(dir, '7.6.6', 'sentinels', capture(goldenText('sentinels')));
    layout(dir, '7.6.6', 'third', '> anybase@0.10.0 rehearse:third\nWARNING: nothing ran\n');
    // Only the baseline the leg could actually have: the point here is the
    // undeclared suite, not the committed set.
    const baselines = collectGolden(DEFAULT_GOLDEN_DIR).filter((file) => file.suite === 'sentinels');
    const undeclared = compareToBaseline(collect(dir), baselines);
    expect(undeclared.failures).toEqual([{ kind: 'baseline-undeclared', suite: 'third', engines: [] }]);
    // The declared suite is still compared, so the refusal is about the suite
    // nobody can describe rather than about the run as a whole.
    expect(undeclared.matched).toEqual([{ suite: 'sentinels', engines: ['7.6.6'] }]);
    expect(formatReport(compare(collect(dir), baselines), dir)).toContain(
      'no report marker declared for this suite',
    );
    cleanUp();
  });

  it('reports a baseline that no leg uploaded as covering nothing', () => {
    // Two legs losing a whole suite produces no cross-engine failure either, so
    // without this the pin would go quiet exactly when it stopped working.
    const dir = fixtureDir();
    // Every suite but one, so exactly the loss under test is reported: the legs that
    // did upload their files are compared normally.
    for (const engine of ['7.4.20', '7.6.6']) {
      completeLeg(dir, engine);
      rmSync(path.join(dir, `rehearsal-output-${engine}`, 'rehearsal-lifecycle.txt'));
    }
    const baselines = collectGolden(DEFAULT_GOLDEN_DIR);
    const result = compare(collect(dir), baselines);
    expect(result.failures).toEqual([{ kind: 'baseline-unchecked', suite: 'lifecycle', engines: [] }]);
    expect(formatReport(result, dir)).toContain('was never compared');
    cleanUp();
  });

  it('compares the engines only when no baseline was passed', () => {
    // `compare(outputs)` is what a caller holding engine output alone can
    // honestly do; an EMPTY list is the claim that no baseline exists, and says so.
    const dir = fixtureDir();
    for (const engine of ['7.4.20', '7.6.6']) layout(dir, engine, 'sentinels', capture(goldenText('sentinels')));
    expect(compare(collect(dir)).failures).toEqual([]);
    expect(compare(collect(dir)).baseline).toEqual([]);
    expect(compare(collect(dir), []).failures).toEqual([{ kind: 'baseline-missing', suite: 'sentinels', engines: [] }]);
    cleanUp();
  });
});

describe('the CLI, end to end', () => {
  const script = path.join(process.cwd(), 'scripts', 'rehearsal-parity.mjs');
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  it('passes two engines\' real-shaped captures against the committed baseline', () => {
    const dir = fixtureDir();
    // The Windows leg's capture: npm's banner, the fixture path of that machine,
    // CRLF from the pipe, and a warning PowerShell 7 emits.
    completeLeg(dir, '7.4.20', { crlf: true, warning: true, root: 'C:\\Workspace\\Base88\\scripts' });
    // The Linux leg's: a POSIX checkout, LF, and the same warning - because the
    // cross-engine comparison is the one that notices a warning only ONE engine
    // emits, deliberately.
    completeLeg(dir, '7.6.6', { warning: true });
    const result = run('--dir', dir);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('✓ baseline sentinels: matched by 7.4.20, 7.6.6');
    // Every suite the job runs is in the report, not only the two that were here
    // first: a fourth leg with no baseline of its own still fails this run.
    for (const suite of LEG_SUITES) {
      expect(result.stdout, `${suite}: not compared against the baseline`).toContain(`✓ baseline ${suite}: matched by`);
    }
    expect(result.stdout).toContain('REHEARSAL_PARITY PASS');
    expect(result.status, result.stdout).toBe(0);
    cleanUp();
  });

  it('fails one strayed engine, and says which line and which side', () => {
    const dir = fixtureDir();
    for (const engine of ['7.4.20', '7.6.6']) completeLeg(dir, engine);
    layout(dir, '7.4.20', 'lifecycle', capture(goldenText('lifecycle').replace('recovered=1', 'recovered=0')));
    const result = run('--dir', dir);
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain('7.4.20 no longer matches the committed baseline');
    expect(result.stdout).toContain('baseline: LIFECYCLE_DONE steps=8 failed=0 recovered=1');
    expect(result.stdout).toContain('7.4.20: LIFECYCLE_DONE steps=8 failed=0 recovered=0');
    expect(result.stdout).toContain('at line 14');
    // ...the suite that did not stray is still reported as matching, so a reader can
    // see what the failure is NOT.
    expect(result.stdout).toContain('✓ baseline sentinels: matched by 7.4.20, 7.6.6');
    expect(result.stdout).toContain('✓ baseline lifecycle: matched by 7.6.6');
    expect(result.stdout).toContain('✗ lifecycle: 7.4.20 and 7.6.6 disagree at line 18');
    cleanUp();
  });

  it('writes a baseline that is the report rather than the capture', () => {
    // What --write-golden commits is the projection, so npm's banner, an engine's
    // warning and a machine path cannot end up frozen into the repository.
    const dir = fixtureDir();
    const golden = fixtureDir();
    layout(dir, '7.6.6', 'sentinels', capture(goldenText('sentinels'), { crlf: true, warning: true }));
    const written = run('--dir', dir, '--golden', golden, '--write-golden');
    expect(written.stderr).toBe('');
    expect(written.stdout).toContain('wrote ');
    expect(readFileSync(path.join(golden, 'rehearsal-sentinels.txt'), 'utf8')).toBe(goldenText('sentinels'));
    // ...and the command that wrote it also checks it, so a baseline that does not
    // match the run it came from is not left for CI to find.
    expect(written.stdout).toContain('✓ baseline sentinels: matched by 7.6.6');
    // One engine is still a vacuous cross-engine comparison, which is why the write
    // run exits non-zero with a single leg - the point of the flag is the file.
    expect(written.status).toBe(1);
    expect(written.stdout).toContain('a comparison with one input is not a comparison');
    cleanUp();
  });

  it('writes nothing at all when one suite cannot be written', () => {
    // Half a baseline directory is worse than none: it would leave one suite
    // regenerated by a run that failed, next to a stale sibling.
    const dir = fixtureDir();
    const golden = fixtureDir();
    layout(dir, '7.6.6', 'sentinels', capture(goldenText('sentinels')));
    layout(dir, '7.6.6', 'third', '> anybase@0.10.0 rehearse:third\nWARNING: nothing ran\n');
    const refused = run('--dir', dir, '--golden', golden, '--write-golden');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('no report marker declared for third');
    expect(collectGolden(golden), 'nothing may be written when a suite is refused').toEqual([]);

    // And the declared suite alone is still written, which is what makes the above
    // a refusal rather than a broken writer.
    const only = fixtureDir();
    layout(only, '7.6.6', 'sentinels', capture(goldenText('sentinels')));
    const written = run('--dir', only, '--golden', golden, '--write-golden');
    expect(written.stdout).toContain('wrote ');
    expect(readFileSync(path.join(golden, 'rehearsal-sentinels.txt'), 'utf8')).toBe(goldenText('sentinels'));
    cleanUp();
  });

  it('refuses to write a baseline with nothing to write, or from nothing', () => {
    const empty = fixtureDir();
    const golden = fixtureDir();
    const noOutput = run('--dir', empty, '--golden', golden, '--write-golden');
    expect(noOutput.status).toBe(1);
    expect(noOutput.stderr).toContain('nothing to write down');
    expect(collectGolden(golden)).toEqual([]);

    // Output that is only foreign noise has no report to write down either: a
    // baseline of nothing would be a file that can never fail.
    layout(empty, '7.6.6', 'sentinels', '> anybase@0.10.0 rehearse:sentinels\nWARNING: nothing ran\n');
    const noReport = run('--dir', empty, '--golden', golden, '--write-golden');
    expect(noReport.status).toBe(1);
    expect(noReport.stderr).toContain('a baseline of nothing is not a baseline');
    expect(collectGolden(golden)).toEqual([]);
    cleanUp();
  });
});

describe('the comparison is wired where it blocks merges', () => {
  it('has an npm script to call', () => {
    expect(packageJson.scripts['check:rehearsal-parity']).toBe('node scripts/rehearsal-parity.mjs');
  });

  it('is a job in ci.yml that needs the rehearsals and may not fail quietly', () => {
    const { js } = parseWorkflow(ciText());
    const job = js?.jobs?.['rehearsal-parity'];
    expect(job, 'ci.yml has no rehearsal-parity job').toBeDefined();
    expect(job.needs).toBe('rehearsals');
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['continue-on-error'], 'a parity check that cannot block is decoration').toBeUndefined();
    const steps = JSON.stringify(job.steps);
    expect(steps, 'the job must run the comparison').toContain('check:rehearsal-parity');
    expect(steps, 'and read what the legs uploaded').toContain('rehearsal-output-');
    // The baseline is committed, so a comparison job without a checkout would fail
    // at run time on a missing file rather than here.
    expect(steps, 'the committed baseline is read from the checkout').toContain('actions/checkout@');
  });

  it('is reached through ci-ok, so a disagreement blocks the merge', () => {
    const text = ciText();
    // The whole blocking set, not just this job: parity is listed here because it
    // IS waited on, and the list is spelled out so that a blocker dropped from
    // `needs` — the quiet way to un-gate something — fails here.
    expect(text).toMatch(/needs:\s*\[matrix,\s*gates,\s*perf-gate,\s*soak,\s*rehearsals,\s*rehearsal-parity\]/);
    expect(text).toMatch(/if \[ "\$\{\{ needs\.rehearsal-parity\.result \}\}" != "success" \]/);
  });

  it('gets the output from every leg, uploaded even when a rehearsal failed', () => {
    const text = ciText();
    const { js } = parseWorkflow(text);
    const steps = (js?.jobs?.rehearsals?.steps ?? []) as Array<Record<string, unknown>>;
    const upload = steps.find((step) => String(step.uses ?? '').startsWith('actions/upload-artifact'));
    expect(upload, 'the rehearsals job must upload its output').toBeDefined();
    const withInputs = (upload?.with ?? {}) as Record<string, unknown>;
    // Per engine: the artifact NAME carries the version, which is how the parity
    // job can say which two engines disagreed.
    expect(String(withInputs.name)).toContain('${{ steps.pwsh.outputs.version }}');
    // always(): a FAILING rehearsal is the one whose output most needs comparing.
    expect(String(upload?.if ?? '')).toContain('always()');
    // ...and the files it uploads are the files the legs write: the same directory,
    // the same `rehearsal-<suite>.txt` names the comparison looks for. A rename on
    // either side would leave the parity job with one input (or none), which it
    // reports as a vacuous comparison rather than as agreement.
    const files = String(withInputs.path ?? '');
    expect(files, 'the upload must take the files the legs write').toMatch(/rehearsal-\*\.txt$/);
    const legs = JSON.stringify(steps);
    for (const suite of LEG_SUITES) {
      expect(legs, `${suite}: no leg writes rehearsal-${suite}.txt`).toContain(
        `rehearsal-output/rehearsal-${suite}.txt`,
      );
      expect(packageJson.scripts[`rehearse:${suite}`], suite).toBeDefined();
    }
    // Every suite a leg writes has a declared marker AND a committed baseline: a
    // third rehearsal cannot slip in with no marker (projecting to nothing) or with
    // no baseline (uncovered) — and the list is the workflow's, so this holds for a
    // fourth one too rather than for the suites that exist today.
    for (const suite of LEG_SUITES) {
      expect(REPORT_MARKERS[suite as keyof typeof REPORT_MARKERS], `${suite}: no report marker`).toBeDefined();
      expect(collectGolden(DEFAULT_GOLDEN_DIR).map((file) => file.suite), `${suite}: no baseline`).toContain(suite);
    }
    expect(Object.keys(REPORT_MARKERS).sort()).toEqual(LEG_SUITES);
    expect(LEG_SUITES).toEqual(['lifecycle', 'sentinels', 'transports']);
  });
});
