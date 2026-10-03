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
import {
  GRACE_HEADROOM,
  MAX_PATIENT_MISSED_DAYS,
  ABSOLUTE_FLOOR_MS,
  matchRunsToSlots,
  slotsBetween,
  scheduleBaseline,
  deriveGrace,
  gradeSlot,
  parseCron,
  prevFireBefore,
  formatLag,
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