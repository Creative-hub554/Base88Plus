/**
 * The contract itself, pinned.
 *
 * `scripts/verdict-contract.json` exists so that the PowerShell scripts that
 * WRITE the records, the recovery pass that re-posts a lost one, and the
 * heartbeat auditor that asks whether it landed can no longer disagree about what
 * a record is. A declaration nobody is held to is a comment, so these pins hold
 * all three consumers to it - structurally, because that is the only way to prove
 * a consumer is not carrying its own copy.
 *
 * What is proven here:
 *   - every declared workflow has a script that READS the contract, and none of
 *     them restates a marker, a window, the record issue or a verdict shape;
 *   - a sentinel does not declare its own window (it inherits its witness's),
 *   - the three views the consumers import agree, because they are derived;
 *   - the run-log grammar the writers print is the one the reader parses.
 *
 * What is NOT proven here, and is verified by rehearsal instead: that PowerShell
 * resolves the same values. The loader was exercised directly -
 * `Format-VerdictHeader` renders `post-Oct-3 verifier (run none, 2026-10-04)` and
 * `post-Oct-28 verifier (2026-10-04)` from the same JSON the JS loader reads - and
 * all six scripts were run dry before and after with byte-identical output.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AUDITOR_MARKER,
  LOG,
  RECEIPTS,
  RECOVERABLE,
  REPO,
  ISSUE,
  SCRIPT_OWNERS,
  TRIPPERS,
  WORKFLOWS,
  contractFor,
  renderHeader,
} from '../scripts/verdict-contract.mjs';

const SCRIPT_DIR = 'scripts';

/** Every script that reads the contract, by its path in the declaration. */
const CONSUMERS = Object.entries(WORKFLOWS).map(([workflow, e]) => [workflow, e.script] as const);

/** The scripts that do not write records but still read the contract. */
const READERS = ['scripts/oct3-check.ps1', 'scripts/oct28-check.ps1'];

const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

describe('the declaration is the only owner of every contract fact', () => {
  it('names a script for each workflow, and that script exists', () => {
    expect(CONSUMERS.length).toBeGreaterThan(0);
    for (const [workflow, script] of CONSUMERS) {
      expect(script, workflow).toMatch(/^scripts\/[a-z0-9-]+\.ps1$/);
      expect(source(script).length, `${workflow} -> ${script}`).toBeGreaterThan(0);
    }
    // The map is derived, so it cannot list a script the declaration does not.
    expect(Object.keys(SCRIPT_OWNERS).sort()).toEqual(CONSUMERS.map(([, s]) => s).sort());
  });

  it('gives every workflow its own marker', () => {
    const markers = Object.values(WORKFLOWS).map((e) => e.marker);
    expect(new Set(markers).size).toBe(markers.length);
    for (const [workflow, e] of Object.entries(WORKFLOWS)) {
      expect(e.marker.length, workflow).toBeGreaterThan(0);
      expect(e.shape.test(`**${e.kind === 'sentinel' ? 'SENTINEL_X' : 'PASS_X'}**`), workflow).toBe(true);
    }
  });

  // A sentinel that declared its own window could drift from the chain it
  // witnesses, and the trip would then never retire.
  it('makes a sentinel inherit its window instead of declaring one', () => {
    for (const [workflow, e] of Object.entries(WORKFLOWS)) {
      if (!e.witnesses) continue;
      const raw = JSON.parse(source('scripts/verdict-contract.json')).workflows[workflow];
      expect(raw.readsSince, `${workflow} must not restate its witness window`).toBeUndefined();
      expect(e.readsSince).toBe(contractFor(e.witnesses).readsSince);
      expect(e.witness?.marker).toBe(contractFor(e.witnesses).marker);
    }
  });

  it('keeps the three derived views in agreement by construction', () => {
    for (const [workflow, e] of Object.entries(WORKFLOWS)) {
      expect(RECOVERABLE[workflow].marker).toBe(e.marker);
      expect(RECOVERABLE[workflow].shape.source).toBe(e.recordShape);
      if (e.kind === 'verifier') {
        expect(RECEIPTS[workflow].marker).toBe(e.marker);
        expect(RECEIPTS[workflow].shape).toBe(RECOVERABLE[workflow].shape);
      } else {
        // The clearance is the WITNESS's, never a copy of it.
        expect(TRIPPERS[workflow].cleared.marker).toBe(e.witness!.marker);
        expect(TRIPPERS[workflow].cleared.since).toBe(e.witness!.readsSince);
        expect(TRIPPERS[workflow].cleared.shape).toBe(e.witness!.satisfied);
      }
    }
    expect(Object.keys(RECEIPTS).sort()).toEqual(
      Object.values(WORKFLOWS).filter((e) => e.kind === 'verifier').map((e) => e.workflow).sort(),
    );
  });

  it('separates the record facts from the run-log grammar, and pins both', () => {
    expect(REPO).toBe('Creative-hub554/Base88Plus');
    expect(ISSUE).toBe(18);
    expect(LOG.body).toBe('--- VERDICT BODY ---');
    expect(LOG.verdict).toBe('VERDICT=');
    expect(LOG.commentFailed).toBe('COMMENT_FAILED ');
  });
});

describe('every consumer reads the contract instead of restating it', () => {
  it('dot-sources the PowerShell loader', () => {
    for (const file of [...CONSUMERS.map(([, s]) => s), ...READERS]) {
      expect(source(file), file).toContain(". (Join-Path $PSScriptRoot 'verdict-contract.ps1')");
      expect(source(file), file).toContain('Get-VerdictContract');
    }
  });

  it('resolves its own entry rather than holding a table', () => {
    for (const [workflow, script] of CONSUMERS) {
      const src = source(script);
      expect(src, `${workflow}: must resolve its record from the contract`)
        .toContain('Get-VerdictRecord -Contract $contract -ScriptPath $PSCommandPath');
    }
    // The checkers are not record owners: they name the workflow they CHECK,
    // which is their own subject, then derive everything else from it.
    for (const file of READERS) {
      const src = source(file);
      expect(src, file).toMatch(/\$watched = \$contract\.workflows\.'(oct3|oct28)-verify\.yml'/);
    }
  });

  // The pins that make the derivation real. Each of these strings was, before
  // this change, a second copy of a fact the declaration already owned - and in
  // the case of the -like patterns, a copy that had drifted from the text the
  // script itself wrote.
  it('restates no marker, window, day, issue or verdict shape', () => {
    for (const [workflow, script] of [...CONSUMERS, ...READERS.map((f) => ['(checker)', f] as const)]) {
      const src = source(script);
      const entry = workflow === '(checker)' ? null : WORKFLOWS[workflow];
      const offenders: string[] = [];

      if (src.includes('issues/18')) offenders.push('issues/18 (use $issue / $issueNumber)');
      if (/since=2026-\d\d-\d\dT/.test(src)) offenders.push('a hardcoded since= window');
      if (/created=2026-\d\d-\d\d\.\./.test(src)) offenders.push('a hardcoded created= range');
      if (/\\\*\\\*PASS_\[A-Z_\]/.test(src)) offenders.push('a hand-written PASS shape');
      if (src.includes('Creative-hub554/Base88Plus')) offenders.push('the repo slug');
      if (src.includes("Write-Output \"VERDICT=$verdict\"")) offenders.push('a hand-written VERDICT= prefix');
      if (src.includes("'--- VERDICT BODY ---'")) offenders.push('a hand-written body marker');
      if (entry) {
        for (const e of [entry, ...(entry.witness ? [entry.witness] : [])]) {
          if (src.includes(`*${e.marker}*`)) offenders.push(`the -like pattern for ${e.marker}`);
        }
      }
      expect(offenders, `${script} still restates: ${offenders.join(', ')}`).toEqual([]);
    }
  });

  // The workflow file name is a declaration KEY, so no script may spell one out:
  // verify-oct3 queried `.../workflows/oct3-verify.yml/runs` while already holding
  // its own entry. The only legitimate literal is a checker naming the workflow it
  // checks - that name IS its subject - and then deriving everything from it.
  it('names no workflow file as a literal, except a checker naming its subject', () => {
    const names = Object.keys(WORKFLOWS);
    const codeLines = (src: string) => src.split(/\r?\n/).filter((l) => !/^\s*(#|<#)/.test(l));

    for (const [workflow, script] of CONSUMERS) {
      const hits = codeLines(source(script)).flatMap((l) => names.filter((n) => l.includes(n)).map((n) => `${n} in: ${l.trim()}`));
      expect(hits, `${workflow} -> ${script}`).toEqual([]);
    }
    for (const file of READERS) {
      const hits = codeLines(source(file)).filter((l) => names.some((n) => l.includes(n)));
      expect(hits.length, `${file}: ${hits.join(' | ')}`).toBe(1);
      expect(hits[0], file).toContain('$watched = $contract.workflows.');
    }
  });

  it('prints no window range as a literal', () => {
    // A diagnostic line that names the window is a second copy of the query's
    // bounds: oct29- sentinel printed `... in 2026-10-28..2026-10-29` while
    // querying `$windowStart..$windowEnd`. The fire schedule and operator
    // commands in the scripts' prose are a different thing - they are the cron
    // grid and the recommended commands, not this contract's window.
    for (const [workflow, script] of CONSUMERS) {
      const code = source(script).split(/\r?\n/).filter((l) => !/^\s*(#|<#)/.test(l)).join('\n');
      expect(code, `${workflow} -> ${script}`).not.toMatch(/in 2026-\d\d-\d\d\.\./);
    }
  });

  it('renders its record identity from the contract, both sides of the guard', () => {
    for (const [workflow, script] of CONSUMERS) {
      const src = source(script);
      // What is written and what is searched for are the same rendered header...
      expect(src, `${workflow}: header of the record`).toContain('Format-VerdictHeader');
      expect(src, `${workflow}: guard searches the same header`).toMatch(/\$_.body -like "\*\$header\*"/);
      // ...and the old inline template is gone.
      expect(src, workflow).not.toContain('run $($run.id), $today): **');
    }
  });

  it('prints the run-log grammar the reader parses', () => {
    for (const [workflow, script] of CONSUMERS) {
      const src = source(script);
      expect(src, `${workflow}: body marker`).toContain('$contract.logSyntax.body');
      expect(src, `${workflow}: verdict line`).toContain('$contract.logSyntax.verdict');
      expect(src, `${workflow}: failure line`).toContain('$contract.logSyntax.commentFailed');
    }
  });
});

describe('the record identity is one string, rendered once', () => {
  it('renders the phrasing each script actually writes', () => {
    // Verbatim from the scripts' own dry runs on 2026-10-09.
    expect(renderHeader(contractFor('oct3-verify.yml'), { run: 37157439771, day: '2026-10-03' }))
      .toBe('post-Oct-3 verifier (run 37157439771, 2026-10-03)');
    expect(renderHeader(contractFor('oct3-verify.yml'), { run: 'none', day: '2026-10-03' }))
      .toBe('post-Oct-3 verifier (run none, 2026-10-03)');
    // The one record with no run segment at all: declared, not normalised away.
    expect(renderHeader(contractFor('oct28-verify.yml'), { run: 'none', day: '2026-10-09' }))
      .toBe('post-Oct-28 verifier (2026-10-09)');
    expect(renderHeader(contractFor('oct28-verify.yml'), { run: 37123382655, day: '2026-10-28' }))
      .toBe('post-Oct-28 verifier (run 37123382655, 2026-10-28)');
    expect(renderHeader(contractFor('oct4-sentinel.yml'), { run: 'none', day: '2026-10-04' }))
      .toBe('post-Oct-3 sentinel (checked 2026-10-04)');
    expect(renderHeader(contractFor('oct29-sentinel.yml'), { run: 'none', day: '2026-10-29' }))
      .toBe('post-Oct-28 sentinel (checked 2026-10-29)');
  });

  it('is what the sentinels search for, so a recovered record still counts', () => {
    // recover-verdicts builds a sentinel's recovered header from this same
    // function, and the sentinel searches for the rendered header of its own day.
    // If either side moved, a re-run would post a second copy of a gap.
    const oct4 = contractFor('oct4-sentinel.yml');
    const day = '2026-10-04';
    const recovered = `post-Oct-3 sentinel (checked ${day}): **SENTINEL_RUN_NO_PASS**`;
    expect(recovered).toContain(renderHeader(oct4, { run: 'none', day }));
  });

  it('keeps the auditor recognizable as a non-witness by both consumers', () => {
    expect(AUDITOR_MARKER.length).toBeGreaterThan(0);
    // Both JS consumers refuse the auditor's own prose as a record, from the same
    // declaration: the heartbeat through SELF_MARKER, recovery directly.
    expect(source('scripts/heartbeat-audit.mjs')).toContain('export const SELF_MARKER = AUDITOR_MARKER;');
    expect(source('scripts/recover-verdicts.mjs')).toContain('if (c.body.includes(AUDITOR_MARKER)) return false;');
  });
});
