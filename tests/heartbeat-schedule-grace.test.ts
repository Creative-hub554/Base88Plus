// Pins for the schedule heartbeat's health model.
//
// The auditor answers one question about a missing scheduled run: is the
// queue slow, or is the schedule dying? A run list cannot tell those apart,
// so the answer is reconstructed from each schedule's OWN fire history -
// which due slots the workflow owed, and which runs actually satisfied them.
//
// Three properties earn the shape. Each has a pin here, because each was a
// failure of the shape this replaced:
//   1. Patience is per schedule, derived from its own worst observed lag.
//   2. The diagnosis IS the verdict - they read the same numbers.
//   3. Repeated missed days escalate on their own, because a cron that
//      misses every week never outruns any time-based grace.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  GRACE_HEADROOM,
  MAX_PATIENT_MISSED_DAYS,
  ABSOLUTE_FLOOR_MS,
  matchRunsToSlots,
  slotsBetween,
  scheduleBaseline,
  deriveGrace,
  gradeSlot,
  RECEIPTS,
  gradeReceipt,
  assessReceipt,
  reportAs,
  periodStart,
  receiptTargets,
  parseCron,
  prevFireBefore,
  formatLag,
  TRIPPERS,
  assessTrip,
} from '../scripts/heartbeat-audit.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// The only two scheduled runs this repo has ever recorded, from the Actions
// run history. These are real, not invented - the model learns from them at
// runtime, and these are the values it must reproduce.
const CODEQL_DUE = Date.parse('2026-09-28T09:23:00Z');
const CODEQL_START = Date.parse('2026-09-28T17:41:38Z'); // 8h18m38s late
const DRILL_DUE = Date.parse('2026-09-28T08:23:00Z');
const DRILL_START = Date.parse('2026-09-28T16:48:54Z'); // 8h25m54s late
const WORST_OBSERVED_LAG_MS = DRILL_START - DRILL_DUE;

describe('slot/run matching', () => {
  it('claims the LATEST slot a run could satisfy, not the oldest', () => {
    // The bug this replaces: claiming the earliest slot left the recent one
    // looking missed, which is the inverse of the truth.
    const slots = [DRILL_DUE - 7 * DAY, DRILL_DUE];
    const { matched, missed } = matchRunsToSlots(slots, [DRILL_START]);
    expect(matched).toEqual([{ slot: DRILL_DUE, start: DRILL_START, lag: WORST_OBSERVED_LAG_MS }]);
    expect(missed).toEqual([DRILL_DUE - 7 * DAY]);
  });

  it('measures the real observed lag', () => {
    const { matched } = matchRunsToSlots([DRILL_DUE], [DRILL_START]);
    expect(matched[0].lag).toBe(WORST_OBSERVED_LAG_MS);
    expect(WORST_OBSERVED_LAG_MS).toBe(8 * HOUR + 25 * MIN + 54_000);
  });

  it('never lets two runs claim one slot', () => {
    const slots = [DRILL_DUE];
    const { matched, missed } = matchRunsToSlots(slots, [DRILL_START, DRILL_START + MIN]);
    expect(matched).toHaveLength(1);
    expect(missed).toEqual([]);
  });

  it('ignores runs that predate every slot under audit', () => {
    const { matched, missed } = matchRunsToSlots([DRILL_DUE], [DRILL_DUE - 30 * DAY]);
    expect(matched).toEqual([]);
    expect(missed).toEqual([DRILL_DUE]);
  });

  it('reports every unmatched slot', () => {
    const slots = [DRILL_DUE - 21 * DAY, DRILL_DUE - 14 * DAY, DRILL_DUE];
    const { missed } = matchRunsToSlots(slots, [DRILL_START]);
    expect(missed).toHaveLength(2);
  });

  it('accepts unsorted input', () => {
    const slots = [DRILL_DUE, DRILL_DUE - 7 * DAY];
    const { matched } = matchRunsToSlots(slots, [DRILL_START]);
    expect(matched[0].slot).toBe(DRILL_DUE);
  });
});

describe('baseline learning', () => {
  it('learns worst and median lag from its own history', () => {
    const slots = [DRILL_DUE - 14 * DAY, DRILL_DUE - 7 * DAY, DRILL_DUE];
    const starts = [DRILL_DUE - 14 * DAY + 3 * MIN, DRILL_DUE - 7 * DAY + 9 * MIN, DRILL_START];
    const b = scheduleBaseline(slots, starts);
    expect(b.matchedCount).toBe(3);
    expect(b.medianLagMs).toBe(9 * MIN);
    expect(b.worstLagMs).toBe(WORST_OBSERVED_LAG_MS);
  });

  it('reports no baseline when nothing has ever run', () => {
    const b = scheduleBaseline([DRILL_DUE], []);
    expect(b.worstLagMs).toBeNull();
    expect(b.medianLagMs).toBeNull();
    expect(b.matchedCount).toBe(0);
  });

  // The Oct 3 verifier declares three retry crons for one morning. Those are
  // one missed opportunity, not three - counting slots would have escalated
  // a single quiet morning into a dead streak.
  it('counts a retried morning as ONE missed day', () => {
    const d = Date.parse('2026-10-03T00:00:00Z');
    const slots = [d + 7 * HOUR + 47 * MIN, d + 9 * HOUR + 7 * MIN];
    expect(scheduleBaseline(slots, []).missedDays).toBe(1);
  });

  it('counts distinct days, not slots', () => {
    const slots = [
      Date.parse('2026-10-01T07:00:00Z'),
      Date.parse('2026-10-01T09:00:00Z'),
      Date.parse('2026-10-02T07:00:00Z'),
      Date.parse('2026-10-03T07:00:00Z'),
    ];
    expect(scheduleBaseline(slots, []).missedDays).toBe(3);
  });

  it('does not call a slot a miss when it predates the run history we fetched', () => {
    // Otherwise a shallow page manufactures a dead streak out of slots we
    // never had evidence about.
    const slots = [DRILL_DUE - 30 * DAY, DRILL_DUE - 20 * DAY, DRILL_DUE];
    const b = scheduleBaseline(slots, [DRILL_START]);
    expect(b.matchedCount).toBe(1);
    expect(b.missedDays).toBe(0); // the two older slots are unproven, not missed
  });
});

describe('per-schedule patience', () => {
  it('gives a historyless schedule the repo floor', () => {
    expect(deriveGrace(null, 12 * HOUR)).toBe(12 * HOUR);
  });

  it('gives a schedule with history its OWN worst lag plus headroom', () => {
    expect(deriveGrace(WORST_OBSERVED_LAG_MS, 12 * HOUR)).toBe(Math.round(WORST_OBSERVED_LAG_MS * GRACE_HEADROOM));
  });

  // The property the hardcoded constant could not have: a punctual schedule
  // gets minutes, not the slow schedule's hours.
  it('treats a punctual schedule and a slow one completely differently', () => {
    const punctual = deriveGrace(4 * MIN, 12 * HOUR);
    const slow = deriveGrace(WORST_OBSERVED_LAG_MS, 12 * HOUR);
    expect(punctual).toBe(6 * MIN);
    expect(punctual).toBeLessThan(slow / 100);
  });

  it('reproduces the floor this repo actually measures', () => {
    // 8h25m54s x 1.5 = 12.64h, which is what the live audit reports.
    expect(Math.round(deriveGrace(WORST_OBSERVED_LAG_MS, 0) / HOUR * 10) / 10).toBe(12.6);
  });

  it('keeps an absolute floor when the repo has no history at all', () => {
    expect(deriveGrace(null, ABSOLUTE_FLOOR_MS)).toBe(ABSOLUTE_FLOOR_MS);
  });
});

describe('grading a silent slot', () => {
  const base = { worstLagMs: WORST_OBSERVED_LAG_MS, medianLagMs: 9 * MIN, matchedCount: 3, missedDays: 0, slotCount: 3 };
  const floorMs = 12 * HOUR;

  it('is quiet while no worse than its own worst start', () => {
    const g = gradeSlot({ baseline: base, lastDueMs: DRILL_DUE, nowMs: DRILL_DUE + 5 * HOUR, floorMs });
    expect(g.verdict).toBe('within-history');
  });

  it('escalates its wording once past every start in its own record', () => {
    const g = gradeSlot({ baseline: base, lastDueMs: DRILL_DUE, nowMs: DRILL_DUE + 9 * HOUR, floorMs });
    expect(g.verdict).toBe('beyond-any-history');
  });

  it('says so plainly when there is no baseline to judge against', () => {
    const g = gradeSlot({
      baseline: { ...base, worstLagMs: null, matchedCount: 0 },
      lastDueMs: DRILL_DUE, nowMs: DRILL_DUE + 3 * HOUR, floorMs,
    });
    expect(g.verdict).toBe('no-baseline');
  });

  it('calls it dead once past its own grace', () => {
    const g = gradeSlot({ baseline: base, lastDueMs: DRILL_DUE, nowMs: DRILL_DUE + 13 * HOUR, floorMs });
    expect(g.verdict).toBe('dead');
    expect(g.graceMs).toBe(Math.round(WORST_OBSERVED_LAG_MS * GRACE_HEADROOM));
  });

  // THE reason the shape changed. A schedule with a punctual record gets a
  // grace of minutes, but a cron that misses EVERY slot is still silent for
  // only a few minutes after the latest one came due - shorter than its own
  // grace. No timer of any length catches that; the streak does.
  it('catches a cron missing every slot, which its own timer cannot', () => {
    const punctualRecord = { worstLagMs: 4 * MIN, medianLagMs: 3 * MIN, matchedCount: 20, missedDays: MAX_PATIENT_MISSED_DAYS, slotCount: 23 };
    const g = gradeSlot({ baseline: punctualRecord, lastDueMs: DRILL_DUE, nowMs: DRILL_DUE + 5 * MIN, floorMs });
    expect(g.graceMs).toBe(6 * MIN);        // 4m worst start x 1.5
    expect(g.elapsed).toBeLessThan(g.graceMs); // a time-based check would pass this
    expect(g.verdict).toBe('dead-streak');
  });

  it('stays patient one day below the streak threshold', () => {
    const nearly = { ...base, worstLagMs: null, missedDays: MAX_PATIENT_MISSED_DAYS - 1 };
    const g = gradeSlot({ baseline: nearly, lastDueMs: DRILL_DUE, nowMs: DRILL_DUE + 2 * HOUR, floorMs });
    expect(g.verdict).toBe('no-baseline');
  });
});

// Regression carried forward: on 2026-10-03 the audit ran at 10:59Z and
// filed DEAD findings against the CI snapshot cron and two Oct 3 verifier
// slots, a few hours after they came due, on workflows that were all active.
describe('the 2026-10-03 cron day, at the moment it used to be misjudged', () => {
  const now = Date.parse('2026-10-03T10:59:30Z');
  const createdMs = Date.parse('2026-09-29T00:00:00Z');
  const floorMs = Math.round(WORST_OBSERVED_LAG_MS * GRACE_HEADROOM);

  it('does not call the cron day dead a few hours in', () => {
    for (const expr of ['17 7 3 * *', '47 7 3 10 *', '7 9 3 10 *']) {
      const c = parseCron(expr);
      const lastDue = prevFireBefore(c, now)!;
      const slots = slotsBetween([c], createdMs, now);
      const b = scheduleBaseline(slots, []);
      const g = gradeSlot({ baseline: b, lastDueMs: lastDue, nowMs: now, floorMs });
      expect(['within-history', 'beyond-any-history', 'no-baseline'], `${expr} -> ${g.verdict}`).toContain(g.verdict);
    }
  });

  it('treats the whole retried Oct 3 morning as a single missed day', () => {
    const crons = ['47 7 3 10 *', '7 9 3 10 *', '17 19 3 10 *'].map(parseCron);
    const b = scheduleBaseline(slotsBetween(crons, createdMs, now), []);
    expect(b.slotCount).toBe(2); // the 19:17 backstop has not come due
    expect(b.missedDays).toBe(1);
  });
});

describe('lag formatting', () => {
  it('formats lag in the unit a human can act on', () => {
    expect(formatLag(8 * HOUR + 25 * MIN + 54_000)).toBe('8h26m'); // rounds to the minute
    expect(formatLag(90 * MIN)).toBe('1h30m');
    expect(formatLag(45 * MIN)).toBe('45m');
    expect(formatLag(0)).toBe('0m');
  });

  it('never prints NaN or undefined into the note', () => {
    for (const v of [null, undefined, Number.NaN]) {
      expect(formatLag(v)).not.toMatch(/NaN|undefined/);
    }
  });
});

// The 2026-10-03 cron day taught the auditor something the schedule model
// could not know: all three Oct 3 crons DID fire - 5h and 14h late, so the
// schedule correctly called them healthy - and run 37157439771 finished green
// while recording nothing anywhere. verify-oct3.ps1 computed
// VERDICT=PASS_REFRESHED, its POST to #18 returned 403 "Resource not
// accessible by integration" (oct3-verify.yml was the one workflow that posts
// to #18 without declaring issues: write), it printed COMMENT_FAILED, and then
// exited 0 on the strength of the PASS it had failed to record. Silence is the
// failure this file exists to catch, and that failure wore a green checkmark.
describe('receipts: a run that started is not a verdict that landed', () => {
  const PERIOD_START = Date.parse('2026-10-03T07:47:00Z'); // first Oct 3 slot
  const comment = (id: number, created_at: string, body: string) => ({ id, created_at, body });

  it('catches the real incident: a green run whose verdict never landed', () => {
    const receipt = RECEIPTS['oct3-verify.yml'];
    expect(receipt.marker).toBe('post-Oct-3 verifier');
    // The run exists and succeeded. #18 has nothing. That is the finding.
    const g = gradeReceipt(receipt.marker, [
      comment(1, '2026-09-28T16:00:00Z', 'Weekly verifier drill FAILED (schedule)'),
    ], PERIOD_START);
    expect(g.verdict).toBe('unrecorded');
  });

  it('is satisfied by the verdict actually landing', () => {
    const g = gradeReceipt(RECEIPTS['oct3-verify.yml'].marker, [
      comment(5910053613, '2026-10-03T22:12:00Z', 'post-Oct-3 verifier (run 37157439771, 2026-10-03): **PASS_REFRESHED**'),
    ], PERIOD_START);
    expect(g.verdict).toBe('receipted');
    expect(g.count).toBe(1);
    expect(g.first?.id).toBe(5910053613);
  });

  it('will not accept a verdict from some other day as this day\'s receipt', () => {
    // The whole point of the window: last month\'s PASS is not October\'s.
    const g = gradeReceipt(RECEIPTS['oct3-verify.yml'].marker, [
      comment(7, '2026-09-30T11:15:51Z', 'post-Oct-3 verifier (run 123, 2026-09-30): **PASS_REFRESHED**'),
    ], PERIOD_START);
    expect(g.verdict).toBe('unrecorded');
  });

  it('credits a verdict recorded by the FIRST attempt, not only the last', () => {
    // The Oct 28 chain declares four retries for one morning. A verdict posted
    // at 07:30 must still count when the 19:33 slot is the one under audit,
    // or every retry would read as a lost verdict. periodStart is the FIRST
    // due slot for exactly this reason.
    const first = Date.parse('2026-10-28T07:23:00Z');
    const g = gradeReceipt(RECEIPTS['oct28-verify.yml'].marker, [
      comment(9, '2026-10-28T07:31:00Z', 'post-Oct-28 verifier (run 37157439771, 2026-10-28): **NO_DISPATCH_RUN**'),
    ], first);
    expect(g.verdict).toBe('receipted');
  });

  it('ignores comments from other workflows that share the issue', () => {
    // #18 is a shared runway. A drill comment is not the Oct 3 verdict.
    const g = gradeReceipt(RECEIPTS['oct3-verify.yml'].marker, [
      comment(5856439891, '2026-09-27T13:50:33Z', 'Weekly verifier drill FAILED'),
      comment(5910053613, '2026-10-03T22:12:00Z', 'post-Oct-28 verifier (run 1, 2026-10-03): **PASS**'),
    ], PERIOD_START);
    expect(g.verdict).toBe('unrecorded');
  });

  it('owes nobody a receipt when no contract is declared', () => {
    // The sentinels are absent from RECEIPTS on purpose: they post ONLY when
    // they trip, so a satisfied sentinel is silent BY DESIGN. Giving one a
    // contract would manufacture a permanent false positive.
    // Indexed through Record<string, ...> so the ABSENCE is expressible: a
    // direct key would be a compile error, which is the opposite of what this
    // pin is about.
    const table = RECEIPTS as Record<string, { marker: string }>;
    expect(table['oct4-sentinel.yml']).toBeUndefined();
    expect(table['oct29-sentinel.yml']).toBeUndefined();
    expect(gradeReceipt(null, [], PERIOD_START).verdict).toBe('no-contract');
  });

  it('survives a malformed comment rather than throwing mid-audit', () => {
    const g = gradeReceipt(RECEIPTS['oct3-verify.yml'].marker, [
      null as never,
      { id: 1 } as never,
      comment(2, 'not-a-date', 'post-Oct-3 verifier'),
      comment(3, '2026-10-03T22:12:00Z', 'post-Oct-3 verifier: **PASS_REFRESHED**'),
    ], PERIOD_START);
    expect(g.verdict).toBe('receipted');
    expect(g.count).toBe(1);
  });

  it('counts a re-posted duplicate honestly rather than inflating the count', () => {
    const g = gradeReceipt(RECEIPTS['oct3-verify.yml'].marker, [
      comment(1, '2026-10-03T22:12:00Z', 'post-Oct-3 verifier: **PASS_REFRESHED**'),
      comment(2, '2026-10-03T22:12:30Z', 'post-Oct-3 verifier: **PASS_REFRESHED**'),
    ], PERIOD_START);
    expect(g.verdict).toBe('receipted');
    expect(g.count).toBe(2);
    expect(g.first?.id).toBe(1); // the earliest is the one actually recorded
  });

  it('declares a contract for every cron-day workflow that posts a verdict', () => {
    // Drift guard: if a future verifier workflow starts recording on #18 and
    // is not added here, its lost verdict stays invisible - the exact failure
    // this model exists to catch.
    const expected = ['oct3-verify.yml', 'oct28-verify.yml'];
    expect(Object.keys(RECEIPTS).sort()).toEqual([...expected].sort());
    for (const [file, r] of Object.entries(RECEIPTS)) {
      expect(r.marker, file).toMatch(/^post-Oct-\d+ /);
      expect(r.what, file).toBeTruthy();
    }
  });
});

// gradeReceipt asks "is the record there?". assessReceipt asks the question
// main() actually asks, and it is the one with the traps: a run that has not
// finished may not have posted yet, and a workflow with no contract was never
// promised anything. Neither trap is visible from gradeReceipt alone, which is
// exactly why this layer exists as its own function with its own pins.
describe('assessReceipt: the decision main() actually makes', () => {
  const PERIOD_START = Date.parse('2026-10-03T07:47:00Z');
  const contract = RECEIPTS['oct3-verify.yml'];
  const landed = { id: 1, created_at: '2026-10-03T22:12:00Z', body: 'post-Oct-3 verifier: **PASS_REFRESHED**' };
  const green = { id: 37157439771, status: 'completed', conclusion: 'success' };

  it('finds the incident: green run, empty issue', () => {
    const r = assessReceipt({ contract, run: green, comments: [], periodStartMs: PERIOD_START });
    expect(r.verdict).toBe('unrecorded');
    expect(r.finding).toContain('run 37157439771');
    expect(r.finding).toContain('post-Oct-3 verifier');
    expect(r.finding).toContain('2026-10-03T07:47:00.000Z');
    expect(r.note).toBeUndefined();
  });

  it('says where a landed verdict is, so it is findable', () => {
    const r = assessReceipt({ contract, run: green, comments: [landed], periodStartMs: PERIOD_START });
    expect(r.verdict).toBe('receipted');
    expect(r.note).toContain('comment 1');
    expect(r.finding).toBeUndefined();
  });

  it('does not race a run that has not finished yet', () => {
    // The 19:17 backstop can be in progress while the auditor walks the rows.
    // Asking then would file a finding against a run that is mid-post.
    for (const run of [
      { id: 1, status: 'in_progress', conclusion: null },
      { id: 2, status: 'queued', conclusion: null },
      null,
    ]) {
      const r = assessReceipt({ contract, run: run as never, comments: [], periodStartMs: PERIOD_START });
      expect(r.verdict, JSON.stringify(run)).toBe('run-incomplete');
      expect(r.finding).toBeUndefined();
    }
  });

  it('stays silent about a workflow that promised nothing', () => {
    const r = assessReceipt({ contract: null, run: green, comments: [], periodStartMs: PERIOD_START });
    expect(r.verdict).toBe('no-contract');
    expect(r.finding).toBeUndefined();
  });

  it('reports a RED run as a lost verdict too', () => {
    // The conclusion being failure is the run's own red; what the record is
    // missing is a separate loss, and it is the one nobody else will say.
    const r = assessReceipt({
      contract, run: { id: 5, status: 'completed', conclusion: 'failure' },
      comments: [], periodStartMs: PERIOD_START,
    });
    expect(r.verdict).toBe('unrecorded');
    expect(r.finding).toContain('finished `failure`');
  });

  it('never lets the wording rot into something that understates the loss', () => {
    const r = assessReceipt({ contract, run: green, comments: [], periodStartMs: PERIOD_START });
    // The whole value of the sentence is that it refuses to read a green run
    // as a pass, and tells the operator the log expires.
    expect(r.finding).toMatch(/A green run is not a verdict/);
    expect(r.finding).toMatch(/logs expire/);
    expect(r.finding).toMatch(/re-run the verifier by hand/);
  });
});

// One lost verdict must be ONE finding. All three Oct 3 crons match the same
// run, and three identical paragraphs on #18 would train the reader to skip
// the one that matters. This was a live regression: the first wiring filed the
// finding once per cron, and only the live dry run revealed it.
describe('receiptTargets: one check per run, not per cron', () => {
  const contract = RECEIPTS['oct3-verify.yml'];
  const okRun = { id: 37157439771, status: 'completed', conclusion: 'success' };
  const row = (over: Record<string, unknown> = {}) => ({ receipt: contract, okRun, ...over });

  it('collapses a multi-cron morning onto the single run that served it', () => {
    const rows = [row({ expr: '47 7 3 10 *' }), row({ expr: '7 9 3 10 *' }), row({ expr: '17 19 3 10 *' })];
    const targets = receiptTargets(rows);
    expect(targets).toHaveLength(1);
    expect(targets[0].okRun.id).toBe(37157439771);
  });

  it('still checks each genuinely distinct run', () => {
    const rows = [
      row({ okRun }),
      row({ okRun: { id: 37157439999, status: 'completed', conclusion: 'failure' } }),
    ];
    expect(receiptTargets(rows).map((r) => r.okRun.id)).toEqual([37157439771, 37157439999]);
  });

  it('skips a run that has not finished, because it may not have posted yet', () => {
    for (const status of ['in_progress', 'queued']) {
      expect(receiptTargets([row({ okRun: { id: 1, status } })])).toHaveLength(0);
    }
  });

  it('skips a workflow that promised no record', () => {
    // The sentinels post only when they trip; auditing them would file a
    // permanent false finding against a healthy, deliberately silent chain.
    expect(receiptTargets([row({ receipt: null })])).toHaveLength(0);
    expect(receiptTargets([row({ receipt: undefined })])).toHaveLength(0);
  });

  it('skips a slot with no run at all - that is the schedule check, not this one', () => {
    expect(receiptTargets([row({ okRun: null })])).toHaveLength(0);
  });
});

// main() needs a GitHub token, so the two lines that decide how loudly the audit
// speaks were untested even though they are the ones that decide whether the
// lost verdict becomes a red run. Two mutations survived until these existed:
// demoting the finding to a note, and swapping the period boundary for the
// most recent slot.
describe('report routing: a lost verdict must reach findings', () => {
  const finding = { verdict: 'unrecorded', finding: 'the Oct 3 verdict was never recorded' };
  const note = { verdict: 'receipted', note: 'recorded the Oct 3 verdict (comment 1)' };
  const silent = { verdict: 'no-contract' };

  it('escalates a lost verdict to a finding, not a note', () => {
    expect(reportAs(finding)).toBe('finding');
    expect(reportAs(note)).toBe('note');
    expect(reportAs(silent)).toBe('silent');
  });

  it('prefers the finding when a result somehow carries both', () => {
    expect(reportAs({ ...finding, ...note })).toBe('finding');
  });
});

describe('the receipt window opens at the period\'s FIRST due slot', () => {
  const oct28 = ['23 7 28 10 *', '33 9 28 10 *', '33 13 28 10 *', '33 19 28 10 *'].map(parseCron);
  const slots = slotsBetween(oct28, Date.parse('2026-09-29T00:00:00Z'), Date.parse('2026-10-28T20:00:00Z'));

  it('takes the first of the four Oct 28 slots, not the last', () => {
    expect(slots).toHaveLength(4);
    expect(new Date(periodStart(slots, 0)).toISOString()).toBe('2026-10-28T07:23:00.000Z');
  });

  it('keeps a verdict posted by the first attempt visible to the last slot', () => {
    // The bug this boundary prevents: grading the 19:33 retry against the
    // 19:33 slot would discard the verdict the 07:23 attempt already recorded,
    // and file a lost-verdict finding against a healthy chain.
    const first = periodStart(slots, 0);
    const g = gradeReceipt(RECEIPTS['oct28-verify.yml'].marker, [
      { id: 1, created_at: '2026-10-28T07:31:00Z', body: 'post-Oct-28 verifier: **NO_DISPATCH_RUN**' },
    ], first);
    expect(g.verdict).toBe('receipted');
    // ...and the same comment judged against the LAST slot is not:
    const wrong = gradeReceipt(RECEIPTS['oct28-verify.yml'].marker, [
      { id: 1, created_at: '2026-10-28T07:31:00Z', body: 'post-Oct-28 verifier: **NO_DISPATCH_RUN**' },
    ], slots[slots.length - 1]);
    expect(wrong.verdict).toBe('unrecorded');
  });

  it('falls back to now for a workflow that has never been due', () => {
    expect(periodStart([], 1234)).toBe(1234);
  });
});

// The fix that makes the receipt landable at all. oct3-verify.yml was the only
// workflow posting to #18 without issues: write, which is the 403.
describe('receipt contracts are backed by the permission that permits them', () => {
  const readme = (f: string) => readFileSync(join('.github', 'workflows', f), 'utf8');

  it('grants issues: write to every workflow that has a receipt contract', () => {
    for (const file of Object.keys(RECEIPTS)) {
      const text = readme(file);
      const block = text.match(/^permissions:\n((?:[ \t]+.*\n?)*)/m);
      expect(block, `${file} has no permissions block`).toBeTruthy();
      expect(block![1], `${file} must declare issues: write to post its verdict`).toMatch(/issues:\s*write/);
    }
  });

  it('has no workflow posting to #18 without the permission', () => {
    // The general form of the bug, so the next one is caught at review time.
    for (const f of readdirSync(join('.github', 'workflows'))) {
      if (!f.endsWith('.yml')) continue;
      const text = readFileSync(join('.github', 'workflows', f), 'utf8');
      const postsTo18 = /issues\/18\/comments/.test(text);
      if (!postsTo18) continue;
      const block = text.match(/^permissions:\n((?:[ \t]+.*\n?)*)/m);
      expect(block?.[1] ?? '', `${f} posts to #18`).toMatch(/issues:\s*write/);
    }
  });
});

// The third thing a scheduled run can mean. RECEIPTS asks whether a verdict
// LANDED; the schedule model asks whether a run STARTED. Neither asked what a
// RED run means - and run 37183204922 (the Oct 4 sentinel, concluded
// `failure` because the Oct 3 chain recorded no receipt) was graded `ok` by
// the rule that "a RED run is still evidence the schedule fired". That rule is
// right for liveness and wrong for a sentinel: oct4-sentinel.yml ends its
// happy path with `SENTINEL TRIPPED - gap posted on issue #18"; exit 1`, so red
// IS the report.
describe('a tripped sentinel is a verdict, not a dead cron', () => {
  // The real run, verbatim in shape: scheduled, completed, conclusion failure.
  const TRIPPED_RUN = {
    id: 37183204922,
    status: 'completed',
    conclusion: 'failure',
    run_started_at: '2026-10-04T06:34:35Z',
  };

  it('files a finding naming the run and the gap', () => {
    const t = assessTrip({ contract: TRIPPERS['oct4-sentinel.yml'], run: TRIPPED_RUN });
    expect(t.verdict).toBe('tripped');
    expect(t.finding).toContain('37183204922');
    expect(t.finding).toContain('failure');
    expect(t.finding).toMatch(/opposite of a dead cron/);
    expect(reportAs(t)).toBe('finding');
  });

  // The finding must carry WHAT tripped. A run id alone leaves the operator to
  // go re-derive the gap, which is the work the sentinel already did.
  it("quotes the contract's own description of the gap", () => {
    const contract = TRIPPERS['oct4-sentinel.yml'];
    const t = assessTrip({ contract, run: TRIPPED_RUN });
    expect(t.finding).toContain(contract.what);
    // ...and the note quotes it too, so a clear sentinel still says what it watched.
    const clear = assessTrip({ contract, run: { ...TRIPPED_RUN, conclusion: 'success' } });
    expect(clear.note).toContain(contract.what);
  });

  // The bug in one line: any conclusion used to count as "the schedule fired",
  // so a tripped sentinel was indistinguishable from a healthy one.
  it('does NOT call a tripped sentinel healthy', () => {
    const t = assessTrip({ contract: TRIPPERS['oct4-sentinel.yml'], run: TRIPPED_RUN });
    expect(t.note).toBeUndefined();
  });

  it('reports a clean sentinel as a note, not a finding', () => {
    const t = assessTrip({
      contract: TRIPPERS['oct4-sentinel.yml'],
      run: { ...TRIPPED_RUN, conclusion: 'success' },
    });
    expect(t.verdict).toBe('clear');
    expect(reportAs(t)).toBe('note');
    expect(t.finding).toBeUndefined();
  });

  it('stays silent for a workflow with no trip contract', () => {
    expect(assessTrip({ contract: null, run: TRIPPED_RUN })).toEqual({ verdict: 'no-contract' });
    // The verifiers are NOT trippers: oct3/oct28 exit 0 even when they fail to
    // record, so their conclusion carries no signal. RECEIPTS holds them to
    // account instead.
    expect(TRIPPERS['oct3-verify.yml']).toBeUndefined();
    expect(TRIPPERS['oct28-verify.yml']).toBeUndefined();
  });

  it('stays silent while the run is still in progress', () => {
    const t = assessTrip({
      contract: TRIPPERS['oct4-sentinel.yml'],
      run: { ...TRIPPED_RUN, status: 'in_progress' },
    });
    expect(t.verdict).toBe('run-incomplete');
    expect(reportAs(t)).toBe('silent');
  });

  it('treats every non-success conclusion as a trip', () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']) {
      const t = assessTrip({ contract: TRIPPERS['oct4-sentinel.yml'], run: { ...TRIPPED_RUN, conclusion } });
      expect(t.verdict, conclusion).toBe('tripped');
    }
  });

  // The description is what tells an operator WHICH gap fired, so it is pinned
  // literally. Without this the mutation that rewrites it to something generic
  // is equivalent - it changes the contract and the finding together - and the
  // report degrades to "something tripped" while every other pin stays green.
  it('describes each gap specifically enough to act on', () => {
    expect(TRIPPERS['oct4-sentinel.yml'].what).toBe('the Oct 3 chain landed no receipt on #18');
    expect(TRIPPERS['oct29-sentinel.yml'].what).toBe('the Oct 28 promotion crons landed no receipt on #18');
  });

  // The table is the contract, so it is pinned against the real files: every
  // workflow named here must still exist and still exit non-zero when it trips.
  it('only names sentinels that really do exit non-zero when they trip', () => {
    for (const file of Object.keys(TRIPPERS)) {
      const text = readFileSync(join('.github', 'workflows', file), 'utf8');
      expect(text, file).toMatch(/SENTINEL TRIPPED[^\n]*exit 1|exit 1[^\n]*TRIPPED/);
    }
  });
});

// assessTrip is pure, so it is fully pinned above - which is exactly why the
// two mutations below SURVIVED it: nothing asserted that main() actually hands
// the contract to the helper, or reports what comes back. These are structural
// pins over the source, the same shape this file already uses for the CI
// permission guard. The functional proof is the live dry run, which reports
// 2 findings against the real repo; with either line removed it reports 1.
describe('main() reports a trip instead of dropping it', () => {
  const src = () => readFileSync(join('scripts', 'heartbeat-audit.mjs'), 'utf8');

  it('carries the trip contract onto every row', () => {
    expect(src()).toMatch(/tripper:\s*TRIPPERS\[wf\.path\.split\('\/'\)\.pop\(\)\]/);
  });

  it('pushes a tripped sentinel into findings, not into the notes', () => {
    const text = src();
    const block = text.match(/const trip = assessTrip\([\s\S]*?\n {6}\}/);
    expect(block, 'the trip assessment must exist in main()').toBeTruthy();
    expect(block![0]).toMatch(/reportAs\(trip\) === 'finding'/);
    expect(block![0]).toMatch(/findings\.push/);
    // The `continue` matters as much as the push: without it the receipt check
    // below would also grade the slot and file a second, vaguer finding.
    expect(block![0]).toMatch(/continue;/);
  });
});
