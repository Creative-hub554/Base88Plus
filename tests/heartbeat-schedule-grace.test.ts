// Pins the schedule heartbeat's queue grace.
//
// The auditor catches a SILENTLY SKIPPED cron by comparing the most recent
// due fire time against the scheduled runs that actually started. The naive
// version of that check calls a slot DEAD the instant its due minute passes,
// which is wrong in this repo: GitHub queues scheduled runs at low priority
// and starts them much later. Both schedules that have ever fired here came
// in ~8.4h late, so a zero-grace check reports live schedules as dead.
//
// These tests pin the grace boundary, pin it against the measured lag so it
// cannot be quietly shrunk below what GitHub actually does, and pin the
// concrete regression: the 2026-10-03 audit run that flagged three healthy
// date-gated crons three hours after they were due.

import { describe, it, expect } from 'vitest';
import {
  SCHEDULE_GRACE_MS,
  classifyMiss,
  formatLag,
  overdueState,
  parseCron,
  prevFireBefore,
} from '../scripts/heartbeat-audit.mjs';

// Run-list shapes, newest first, exactly as the Actions API returns them.
const RUN = (id: string, startedAt: string) => ({
  id,
  status: 'completed',
  conclusion: 'success',
  run_started_at: startedAt,
  created_at: startedAt,
});

const HOUR = 60 * 60 * 1000;

// Measured, not guessed: the two scheduled runs this repo has ever recorded,
// from the Actions run history.
//
//   CodeQL        due 2026-09-28T09:23:00Z, started 17:41:38Z -> 8h18m38s
//   Verifier drill due 2026-09-28T08:23:00Z, started 16:48:54Z -> 8h25m54s
//
// The grace has to clear the WORST of these, with room to spare, or the
// heartbeat manufactures false positives on schedules that are merely late.
const OBSERVED_LAGS_MS = [
  Date.parse('2026-09-28T17:41:38Z') - Date.parse('2026-09-28T09:23:00Z'),
  Date.parse('2026-09-28T16:48:54Z') - Date.parse('2026-09-28T08:23:00Z'),
];
const WORST_OBSERVED_LAG_MS = Math.max(...OBSERVED_LAGS_MS);

describe('schedule heartbeat queue grace', () => {
  it('is set to 12 hours', () => {
    expect(SCHEDULE_GRACE_MS).toBe(12 * HOUR);
  });

  it('clears the worst schedule lag actually observed in this repo', () => {
    // Guard the guard: if GitHub gets slower, this test fails rather than
    // letting the grace fall behind reality.
    expect(WORST_OBSERVED_LAG_MS).toBeGreaterThan(8 * HOUR);
    expect(SCHEDULE_GRACE_MS).toBeGreaterThan(WORST_OBSERVED_LAG_MS);
  });

  it('keeps meaningful headroom over the observed lag', () => {
    expect(SCHEDULE_GRACE_MS - WORST_OBSERVED_LAG_MS).toBeGreaterThan(HOUR);
  });

  it('reports a due slot as grace until the boundary, then dead', () => {
    const due = Date.parse('2026-10-03T07:17:00Z');
    expect(overdueState(due, due)).toBe('grace');
    expect(overdueState(due, due + SCHEDULE_GRACE_MS - 1)).toBe('grace');
    expect(overdueState(due, due + SCHEDULE_GRACE_MS)).toBe('dead');
    expect(overdueState(due, due + SCHEDULE_GRACE_MS + 1)).toBe('dead');
  });

  it('treats a slot that is hours late as grace, not dead', () => {
    const due = Date.parse('2026-10-03T07:17:00Z');
    // The worst lag GitHub has actually shown here is still inside the grace.
    expect(overdueState(due, due + WORST_OBSERVED_LAG_MS)).toBe('grace');
    expect(overdueState(due, due + 3 * HOUR)).toBe('grace');
    expect(overdueState(due, due + 13 * HOUR)).toBe('dead');
  });

  // The regression this change exists for. On 2026-10-03 the auditor ran at
  // 10:59Z and filed DEAD findings against ci.yml's `17 7 3 * *` and two
  // oct3-verify.yml slots that were only 3h42m / 3h12m / 1h52m past due -
  // every workflow active, and the day's last slot (19:17Z) still ahead.
  it('does not call the 2026-10-03 cron day dead three hours in', () => {
    const now = Date.parse('2026-10-03T10:59:30Z');
    for (const expr of ['17 7 3 * *', '47 7 3 10 *', '7 9 3 10 *']) {
      const c = parseCron(expr);
      const lastDue = prevFireBefore(c, now);
      expect(lastDue, `${expr} should have a due slot before now`).not.toBeNull();
      expect(lastDue!).toBeLessThanOrEqual(now);
      expect(overdueState(lastDue!, now), `${expr} must not read as dead`).toBe('grace');
    }
  });

  it('still catches a schedule that never fires', () => {
    // Same day, but now past the grace for every slot: this is the real
    // silent-skip signal, and it must survive as a finding.
    const now = Date.parse('2026-10-04T12:00:00Z');
    const c = parseCron('17 7 3 * *');
    const lastDue = prevFireBefore(c, now);
    expect(lastDue).not.toBeNull();
    expect(overdueState(lastDue!, now)).toBe('dead');
  });
});
// A grace turns silence into patience, but silence alone cannot tell a slow
// queue from a dying schedule. The note therefore classifies the miss from the
// schedule's own history - and the two classes deserve very different amounts
// of trust, so they are pinned separately.
describe('schedule heartbeat miss classification', () => {
  const LAST_DUE = Date.parse('2026-10-03T07:17:00Z');
  const PREV_DUE = Date.parse('2026-09-03T07:17:00Z');

  it('calls an empty run list the 60-day signature, not queue lag', () => {
    const miss = classifyMiss([], LAST_DUE, PREV_DUE);
    expect(miss.kind).toBe('never-fired');
    expect(miss.priorLagMs).toBeNull();
  });

  it('treats a missing run list the same as an empty one', () => {
    expect(classifyMiss(undefined, LAST_DUE, PREV_DUE).kind).toBe('never-fired');
  });

  it('measures the previous slot lag when the schedule has fired before', () => {
    // The real Verifier drill run: due 08:23Z, started 16:48Z = 8h25m54s.
    const runs = [RUN('36453738808', '2026-09-28T16:48:54Z')];
    const miss = classifyMiss(runs, LAST_DUE, PREV_DUE);
    expect(miss.kind).toBe('has-history');
    expect(miss.priorLagMs).toBe(Date.parse('2026-09-28T16:48:54Z') - PREV_DUE);
  });

  it('does not report a lag for a run at or after the due slot', () => {
    // Defensive: if a run DOES cover lastDue the caller takes the ok branch,
    // so classifyMiss must never quote a negative "lag" if that ever changes.
    const runs = [RUN('999', '2026-10-03T19:00:00Z')];
    expect(classifyMiss(runs, LAST_DUE, PREV_DUE).priorLagMs).toBeNull();
  });

  it('has no lag to quote when there is no previous slot to compare against', () => {
    const runs = [RUN('1', '2026-09-29T07:20:00Z')];
    expect(classifyMiss(runs, LAST_DUE, null).priorLagMs).toBeNull();
  });

  it('survives an unparseable run timestamp', () => {
    const runs = [{ id: '2', status: 'completed', conclusion: null, run_started_at: 'not-a-date', created_at: 'not-a-date' }];
    const miss = classifyMiss(runs, LAST_DUE, PREV_DUE);
    expect(miss.kind).toBe('has-history');
    expect(miss.priorLagMs).toBeNull();
  });

  it('formats lag in the unit a human can act on', () => {
    expect(formatLag(8 * HOUR + 25 * 60 * 1000 + 54000)).toBe('8h26m');
    expect(formatLag(90 * 60 * 1000)).toBe('1h30m');
    expect(formatLag(45 * 60 * 1000)).toBe('45m');
    expect(formatLag(0)).toBe('0m');
  });

  it('never prints NaN or undefined into the note', () => {
    expect(formatLag(null)).not.toMatch(/NaN|undefined/);
    expect(formatLag(undefined)).not.toMatch(/NaN|undefined/);
    expect(formatLag(Number.NaN)).not.toMatch(/NaN|undefined/);
  });
});
