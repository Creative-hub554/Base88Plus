// Weekly schedule heartbeat: audits every scheduled workflow in the repo so a
// silently skipped cron (GitHub auto-disables schedules on 60-day repo
// inactivity, schedules can be disabled manually, the runner queue can stall)
// is caught within days, all year - not just by the date-specific sentinels
// on their single morning after.
//
// Per workflow with a `schedule:` trigger, five checks:
//   1. API state   - state must be `active`; disabled_inactivity /
//                    disabled_manually is an instant finding (this is the
//                    60-day-rule tripwire the cron-day verifiers cannot give).
//   2. Cron syntax - every cron line must have 5 fields with sane ranges.
//   3. Satisfiable - forward search (1500 days = a full 4-year leap cycle;
//                    400 would miss Feb-29 crons half the time) must find a
//                    fire time; a typo'd never-matching cron is flagged.
//   4. Last fire   - the most recent DUE fire time (real cron semantics:
//                    dom/dow OR rule, month/weekday names, steps, vixie
//                    N/step = N-max/step). A scheduled run must exist at or
//                    after that instant (the run a cron fires starts AT the
//                    due minute, so >= due is the evidence; runs from the
//                    previous slot are naturally excluded), floored by the
//                    workflow's created_at (date-gated chains like the Oct 3
//                    / Oct 28 verifiers are NOT_YET_DUE before their first
//                    due date - dead-on-arrival would be false). An
//                    in-progress run counts. MISSED = the silent-skip signal,
//                    but only after SCHEDULE_GRACE_MS has elapsed since the
//                    due instant - GitHub starts scheduled runs late, so a
//                    slot that is merely late is a note, not a finding. The
//                    note then says WHY it is still empty: a schedule that
//                    has fired before is quoted its own measured lag, a
//                    schedule with no run ever recorded is called out as the
//                    60-day signature, so patience is never silent.
//   5. Receipt     - a run that STARTED is not a verdict that LANDED. Every
//                    workflow in RECEIPTS promises a durable record on the
//                    issue, so the promised marker must actually be there for
//                    this period. A green run whose verdict failed to post is
//                    a finding, not a pass: silence is the failure this whole
//                    file exists to catch, and on 2026-10-03 that failure
//                    arrived wearing a green checkmark.
//
// This script audits ITSELF too: heartbeat.yml's own cron is in the audited
// set, so a dead heartbeat is caught by the drill/CI surface instead of
// rotting silently.
//
// Lookback limitation (deliberate): 62 days - covers weekly and monthly
// crons (the house cadences). A quarterly cron would false-MISS; none exist.
//
// Usage:
//   node scripts/heartbeat-audit.mjs                       # audit, exit 0/1
//   HEARTBEAT_TOKEN=<tok> node scripts/heartbeat-audit.mjs # token override
//   HEARTBEAT_DRY_RUN=1 node scripts/heartbeat-audit.mjs   # print, never post
//   (GITHUB_TOKEN / VERIFY_TOKEN honored as fallback token sources; CI passes
//   github.token, local runs use the CredMan token.)
//
// Exit: 0 all healthy (or only NOT_YET_DUE notes), 1 findings that need
//       attention (posted as one deduped comment on #18 unless dry-run).
//       Tests import the cron math and the grace boundary:
//       tests/heartbeat-schedule-grace.test.ts

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'Creative-hub554/Base88Plus';
const API = `https://api.github.com/repos/${REPO}`;
const ISSUE = 18;
const FORWARD_DAYS = 1500; // satisfiability horizon: full 4-year leap cycle + slack
const LOOKBACK_DAYS = 62;  // backward walk horizon: weekly + monthly cadences

// ---------------------------------------------------------------------------
// The health model
//
// The auditor's whole job is to answer one question about a missing run: is
// the queue slow, or is the schedule dying? In a run list those are
// indistinguishable, so the answer cannot come from a constant. It has to
// come from the schedule's OWN history, reconstructed from data already on
// hand. Everything below is that reconstruction, kept pure so it is testable
// without the Actions API.

// Patience is a multiple of the worst lag THIS schedule has actually shown,
// never a wall-clock guess. 1.5 leaves room for the queue being a little
// worse than its worst recorded day without waving through a silent schedule.
export const GRACE_HEADROOM = 1.5;

// Consecutive DISTINCT DAYS on which a slot came due and no scheduled run
// appeared at all. Days, not slots: the Oct 3 verifier declares three retry
// crons for one morning, and three retries are one missed opportunity, not
// three. Past this, elapsed time stops being an argument for waiting.
export const MAX_PATIENT_MISSED_DAYS = 3;

// Last resort for a repo where NOTHING has ever fired on a schedule. Reached
// only when every scheduled workflow has an empty run list, which is itself
// the finding - so this number only has to avoid crying wolf, not be right.
export const ABSOLUTE_FLOOR_MS = 12 * 60 * 60 * 1000;

// Assign scheduled runs to the slots they satisfied.
//
// A workflow's runs are workflow-level, not cron-level: one workflow may
// declare several crons, and GitHub queues a run per trigger. So the pairing
// is resolved by claiming: each run, walking ascending, takes the LATEST
// slot it could possibly satisfy, and no slot is ever claimed twice.
//
// Latest, not earliest, is the load-bearing word. A run that starts hours
// after its slot satisfies THAT slot - claiming the oldest one instead would
// leave the recent slot looking missed, which is the exact inverse of the
// truth and would report a healthy schedule as a dead streak.
// Both inputs ascending.
export function matchRunsToSlots(slotsMs, runStartsMs) {
  const slots = [...slotsMs].sort((a, b) => a - b);
  const starts = [...runStartsMs].sort((a, b) => a - b);
  const claimed = new Array(slots.length).fill(false);
  const matched = [];
  let i = 0;
  for (const start of starts) {
    while (i < slots.length && slots[i] <= start) i++;
    if (i === 0) continue; // predates every slot under audit
    const idx = i - 1;
    if (claimed[idx]) continue;
    claimed[idx] = true;
    matched.push({ slot: slots[idx], start, lag: start - slots[idx] });
  }
  const missed = slots.filter((_, idx) => !claimed[idx]);
  return { matched, missed };
}

// Every due instant this workflow owed a run for, walking back from `now`.
// The union across its crons, never before the workflow existed - a
// date-gated chain registered yesterday has not missed the slots before it
// was registered.
export function slotsBetween(crons, createdMs, nowMs) {
  const slots = new Set();
  for (const c of crons) {
    let cursor = nowMs;
    for (let guard = 0; guard < 400; guard++) {
      const t = prevFireBefore(c, cursor);
      if (t === null || t < createdMs) break;
      slots.add(t);
      cursor = t - 1;
    }
  }
  return [...slots].sort((a, b) => a - b);
}

// What this schedule teaches us about itself: how late it has ever run, and
// on how many separate days it simply did not run at all.
export function scheduleBaseline(slotsMs, runStartsMs) {
  const { matched, missed } = matchRunsToSlots(slotsMs, runStartsMs);
  // A slot older than the oldest run we fetched is UNPROVEN, not missed: the
  // run that satisfied it may simply be past the end of the page. Without this
  // filter a shallow history manufactures a dead-streak verdict out of slots
  // we never had evidence about.
  // With an empty run list nothing could have satisfied any slot, so every
  // one of them is provable - the filter must not swallow them.
  const earliestRun = runStartsMs.length ? Math.min(...runStartsMs) : -Infinity;
  const provableMisses = missed.filter((m) => m >= earliestRun);
  const lags = matched.map((m) => m.lag);
  const sorted = [...lags].sort((a, b) => a - b);
  return {
    worstLagMs: lags.length ? sorted[sorted.length - 1] : null,
    medianLagMs: lags.length ? sorted[Math.floor(lags.length / 2)] : null,
    matchedCount: matched.length,
    missedDays: new Set(provableMisses.map((m) => new Date(m).toISOString().slice(0, 10))).size,
    slotCount: slotsMs.length,
  };
}

// How long to wait before calling this schedule silent. A schedule with its
// own history is judged by its own worst day; only a schedule with NO history
// falls back to the repo-wide floor, because then that floor is the only
// evidence available about this runner queue.
export function deriveGrace(worstLagMs, floorMs) {
  if (worstLagMs === null || worstLagMs === undefined) return floorMs;
  return Math.round(worstLagMs * GRACE_HEADROOM);
}

// Grade the most recent due slot against its workflow's learned baseline.
// Returns the verdict AND the numbers behind it, so the note can show its
// work rather than assert a conclusion.
//
//   within-history    silent, but no longer than this schedule has ever been
//   beyond-any-history  silent for longer than anything in its own record,
//                     still inside the headroom above that
//   no-baseline       nothing to judge against; judged on the repo floor
//   dead              past its grace
//   dead-streak       too many consecutive days with no run at all - fires
//                     regardless of elapsed time, because a cron that misses
//                     every week never outruns any time-based grace
export function gradeSlot({ baseline, lastDueMs, nowMs, floorMs }) {
  const graceMs = deriveGrace(baseline.worstLagMs, floorMs);
  const elapsed = nowMs - lastDueMs;
  const shared = { graceMs, elapsed, missDays: baseline.missedDays, baseline };
  if (baseline.missedDays >= MAX_PATIENT_MISSED_DAYS) return { verdict: 'dead-streak', ...shared };
  if (elapsed >= graceMs) return { verdict: 'dead', ...shared };
  if (baseline.worstLagMs === null) return { verdict: 'no-baseline', ...shared };
  if (elapsed > baseline.worstLagMs) return { verdict: 'beyond-any-history', ...shared };
  return { verdict: 'within-history', ...shared };
}

// When a receipt for this period must have been posted: the first due slot,
// falling back to now when the workflow has never been due. A receipt is about
// the whole period, so the boundary is the period's opening, not the slot being
// graded - see the Oct 28 four-retry case.
export function periodStart(slotsMs, nowMs) {
  return slotsMs.length ? slotsMs[0] : nowMs;
}

// Which rows actually need a receipt check: one per RUN, not one per cron.
//
// A workflow's runs are workflow-level, so the Oct 3 chain's three retries all
// match the same run and would otherwise file the same lost verdict three times
// on #18 - and a reader who has seen the same paragraph three times learns to
// skip it. Runs still in progress are excluded: they may not have posted yet.
export function receiptTargets(rows) {
  const seen = new Set();
  const targets = [];
  for (const r of rows) {
    if (!r.receipt || !r.okRun || r.okRun.status !== 'completed') continue;
    if (seen.has(r.okRun.id)) continue;
    seen.add(r.okRun.id);
    targets.push(r);
  }
  return targets;
}

// Where a row's outcome belongs in the report. assessReceipt says WHAT is
// true; this says how loudly to say it, and main() cannot be tested without a
// GitHub token, so the routing would otherwise be the one untested line in the
// chain that produces the finding this whole file exists for.
/**
 * A red run is only a verdict when the workflow promises that red means
 * something. Returns { verdict, finding?, note? } in the same shape
 * assessReceipt uses, so reportAs() routes both without knowing which is which.
 */
export function assessTrip({ contract, run }) {
  if (!contract) return { verdict: 'no-contract' };
  if (!run || run.status !== 'completed') return { verdict: 'run-incomplete' };
  if (run.conclusion === 'success') {
    return {
      verdict: 'clear',
      note: `ran and did not trip - ${contract.what} looked healthy at ${run.run_started_at || run.created_at}.`,
    };
  }
  return {
    verdict: 'tripped',
    finding: `TRIPPED - run ${run.id} concluded \`${run.conclusion}\`, which for this sentinel is ` +
      `the report: ${contract.what}. The schedule is provably alive, so this is the opposite of a ` +
      `dead cron - the gap this sentinel exists to watch for is present right now. The evidence it ` +
      `posted is on #${ISSUE}; fix what it named, then re-run the sentinel to clear.`,
  };
}

export function reportAs(ra) {
  if (ra.finding) return 'finding';
  if (ra.note) return 'note';
  return 'silent';
}

// The wiring decision, extracted so it is testable at all.
//
// gradeReceipt answers "is the record there?"; this answers "does that matter
// for THIS run?", which is a separate question with its own traps:
//   - no contract -> nobody was promised anything, stay quiet;
//   - run not completed -> it may not have posted yet, and racing your own
//     subject manufactures false findings;
//   - receipted -> say where it landed, so the verdict is findable;
//   - otherwise -> the finding, and the finding is the whole point.
//
// Returning the text rather than pushing it into a findings[] array keeps the
// word choice pinned: this sentence is the alert a human reads about a lost
// verdict, and it should not be able to rot untested.
export function assessReceipt({ contract, run, comments, periodStartMs }) {
  if (!contract) return { verdict: 'no-contract' };
  if (!run || run.status !== 'completed') return { verdict: 'run-incomplete' };
  const g = gradeReceipt(contract.marker, comments, periodStartMs);
  if (g.verdict === 'receipted') {
    return {
      verdict: 'receipted',
      note: `recorded ${contract.what} on #${ISSUE} (comment ${g.first.id}, ${g.first.created_at}).`,
    };
  }
  return {
    verdict: 'unrecorded',
    finding: `DID run - run ${run.id} finished \`${run.conclusion}\` - but ${contract.what} was ` +
      `never recorded on #${ISSUE} (no comment carrying \`${contract.marker}\` since ` +
      `${new Date(periodStartMs).toISOString()}). A green run is not a verdict: the schedule is ` +
      `alive and the RECORD is dead. The run's own log is the only copy and workflow logs expire, ` +
      `so treat this as a lost result and re-run the verifier by hand (\`workflow_dispatch\`, smoke ` +
      `input where one exists) rather than trusting the conclusion.`,
  };
}

// Human-readable lag for the note. Minutes are the useful unit here: this
// repo's schedule lag is hours, and '8h26m' says what '30200000ms' hides.
export function formatLag(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return 'an unmeasured amount';
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

// ---------------------------------------------------------------------------
// Receipts: a run that started is not a verdict that landed.
//
// Everything above answers "did a scheduled run appear?". That is necessary and
// it is not sufficient, and the 2026-10-03 cron day is why. The three Oct 3
// crons fired for the first time ever - ~5h and ~14h late, so the schedule
// model correctly called them healthy - and the run finished GREEN while
// recording nothing anywhere: verify-oct3.ps1 computed VERDICT=PASS_REFRESHED,
// its POST /issues/18/comments returned 403 "Resource not accessible by
// integration", the script printed COMMENT_FAILED and then exited 0 on the
// strength of the PASS it had failed to record. Every layer of this auditor
// read that run as proof of life. The verdict existed only in a workflow log
// that expires in 90 days.
//
// Silence is the failure this whole file exists to catch, and that failure did
// not arrive as silence. It arrived wearing a green checkmark. So each workflow
// that PROMISES a durable record declares the marker it promises, and a run
// that starts without leaving that marker is a finding in its own right -
// the loudest kind, because nothing else in the repo will ever say it.
//
// Deliberately absent: oct4-sentinel and oct29-sentinel post ONLY when they
// trip. A sentinel that returns SATISFIED is silent by design, so giving one a
// receipt would manufacture a permanent false positive. Absence from this table
// is a real claim - "this workflow owes nobody a record" - not an oversight.
export const RECEIPTS = {
  'oct3-verify.yml': { marker: 'post-Oct-3 verifier', what: 'the Oct 3 verdict' },
  'oct28-verify.yml': { marker: 'post-Oct-28 verifier', what: 'the Oct 28 promotion verdict' },
};

// The mirror image of RECEIPTS, and the third thing a scheduled run can mean.
//
// RECEIPTS answers "did the verdict LAND?". The schedule model answers "did a
// run START?". Neither asks what happens when the run is RED - and for a
// sentinel, red is the whole point: oct4-sentinel.yml ends its happy path with
// `SENTINEL TRIPPED - gap posted on issue #18"; exit 1`, so a non-success exit
// IS the finding, reported rather than swallowed.
//
// It was swallowed. Run 37183204922 (the Oct 4 sentinel, 2026-10-04T06:34:35Z)
// concluded `failure` because the Oct 3 chain had recorded no receipt - and the
// auditor graded that slot `ok`, on the deliberate rule that "a RED run is
// still evidence the schedule fired". That rule is right for liveness and wrong
// here: a sentinel that fires has proven the schedule is alive AND that the
// condition it watches is present. Only one of those is worth reporting.
//
/**
 * Typed as a Record rather than left to inference: a pin asserts that the
 * verifier workflows are ABSENT from this table, and absence cannot be
 * expressed on an inferred literal type.
 *
 * @type {Record<string, { what: string }>}
 */
export const TRIPPERS = {
  'oct4-sentinel.yml': { what: 'the Oct 3 chain landed no receipt on #18' },
  'oct29-sentinel.yml': { what: 'the Oct 28 promotion crons landed no receipt on #18' },
};

// Deliberately NOT listed: the verifier workflows. oct3/oct28-verify exit 0
// even when they fail to record (the #129 bug), so their conclusion carries no
// signal either way - RECEIPTS is the contract that holds them to account.
// verifier-drill is a weekly self-test rather than a witness to one day's
// chain, so a red drill is a finding about the drill, not about a schedule.

// Did the promised record actually land, for the period this audit covers?
//
// `comments` is every comment on the record issue, unfiltered; the two tests
// that matter are the marker (this workflow kept its promise) and the window
// (it kept it about THIS period, not about a day last month).
//
// The window starts at the FIRST due slot of the period, not the most recent
// one. The Oct 28 chain declares four retries for one morning: a verdict
// recorded by the 07:23 attempt must still count when the 19:33 attempt is the
// one being audited, or every retry would read as an unrecorded verdict. The
// per-cron `lastDue` is the wrong boundary for a receipt - a receipt is about
// the whole day, a slot is about one moment.
//
// Pure and comment-shaped so it is testable without the Issues API.
export function gradeReceipt(marker, comments, periodStartMs) {
  if (!marker) return { verdict: 'no-contract' };
  const landed = [];
  for (const c of comments) {
    if (!c || typeof c.body !== 'string' || !c.body.includes(marker)) continue;
    const at = Date.parse(c.created_at);
    if (Number.isNaN(at) || at < periodStartMs) continue; // about some other day
    landed.push({ id: c.id, created_at: c.created_at });
  }
  if (landed.length === 0) return { verdict: 'unrecorded' };
  landed.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  return { verdict: 'receipted', count: landed.length, first: landed[0] };
}

// ---------------------------------------------------------------- cron math
const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseField(raw, min, max, names = {}) {
  // One cron field -> Set of integers. Forms: * | */s | a | a/s | a-b | a-b/s
  // (vixie semantics: a/s == a-max/s; names where provided; dow 7 == 0 is
  // normalized later in dayMatches).
  const out = new Set();
  const norm = (v) => {
    if (/^\d+$/.test(v)) return parseInt(v, 10);
    const key = v.toLowerCase();
    if (!(key in names)) throw new SyntaxError(`unknown name "${v}"`);
    return names[key];
  };
  for (const part of raw.split(',')) {
    let lo = min, hi = max, step = 1;
    if (part === '*') {
      // defaults already min..max
    } else if (part.startsWith('*/')) {
      step = parseInt(part.slice(2), 10);
      if (!Number.isInteger(step) || step < 1) throw new SyntaxError(`bad step in "${raw}"`);
    } else {
      const slash = part.indexOf('/');
      const range = slash === -1 ? part : part.slice(0, slash);
      if (slash !== -1) {
        step = parseInt(part.slice(slash + 1), 10);
        if (!Number.isInteger(step) || step < 1) throw new SyntaxError(`bad step in "${raw}"`);
      }
      const dash = range.indexOf('-');
      if (dash !== -1) { lo = norm(range.slice(0, dash)); hi = norm(range.slice(dash + 1)); }
      else if (slash !== -1) { lo = norm(range); hi = max; } // vixie a/s = a-max/s
      else { lo = norm(range); hi = lo; }                     // plain single value
    }
    if (lo < min || hi > max || lo > hi) throw new SyntaxError(`field "${raw}" out of range`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new SyntaxError(`empty field "${raw}"`);
  return out;
}

export function parseCron(expr) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new SyntaxError(`cron "${expr}" must have 5 fields`);
  return {
    expr,
    minutes: parseField(f[0], 0, 59),
    hours: parseField(f[1], 0, 23),
    doms: parseField(f[2], 1, 31),
    months: parseField(f[3], 1, 12, MONTH_NAMES),
    dows: parseField(f[4], 0, 7, DOW_NAMES),
    domRestricted: f[2] !== '*',
    dowRestricted: f[4] !== '*',
  };
}

// POSIX dom/dow: when BOTH are restricted, a day matches if EITHER matches.
function dayMatches(c, y, m, d) {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const domOk = c.doms.has(d);
  const dowOk = c.dows.has(dow === 0 && c.dows.has(7) ? 7 : dow);
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk;
  if (c.domRestricted) return domOk;
  if (c.dowRestricted) return dowOk;
  return true;
}

export function nextFireAfter(c, utcMs) {
  // First fire strictly after utcMs, or null beyond the horizon. The walk
  // INCLUDES the start day: later-today slots count (10:15 counts for a
  // */15 cron asked at 10:00).
  const start = new Date(utcMs);
  let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  for (let i = 0; i < FORWARD_DAYS; i++) {
    if (c.months.has(d.getUTCMonth() + 1) && dayMatches(c, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())) {
      const times = [...c.hours].flatMap((hh) => [...c.minutes].map((mm) =>
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm)));
      const cand = times.filter((t) => t > utcMs).sort((a, b) => a - b)[0];
      if (cand !== undefined) return cand;
    }
    d = new Date(d.getTime() + 86400000);
  }
  return null;
}

export function prevFireBefore(c, utcMs) {
  // Most recent fire strictly before utcMs, or null beyond the lookback.
  const start = new Date(utcMs);
  let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    if (c.months.has(d.getUTCMonth() + 1) && dayMatches(c, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())) {
      const times = [...c.hours].flatMap((hh) => [...c.minutes].map((mm) =>
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm)));
      const cand = times.filter((t) => t < utcMs).sort((a, b) => b - a)[0];
      if (cand !== undefined) return cand;
    }
    d = new Date(d.getTime() - 86400000);
  }
  return null;
}

// ------------------------------------------------------------ yaml scanning
// Minimal scanner for `on: schedule: - cron: '...'` shapes. No YAML
// dependency: we only need the cron literals (GitHub accepts the PyYAML
// boolean-True rendering of a bare `on:` too, so both are recognized).
// Landmines rehearsed in the first dry run: comment lines INSIDE the
// schedule block must not reset the state machine, the cron value spans to
// the end of the line (first-token capture made `47 7 3 10 *` parse as
// `47`), and the synthetic Dependabot entry (path dynamic/dependabot/...)
// never has a file.
function extractCrons(text) {
  const crons = [];
  const lines = text.split(/\r?\n/);
  let inOn = false, inSchedule = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(on|true):\s*(#.*)?$/.test(line)) { inOn = true; inSchedule = false; continue; }
    if (inOn) {
      if (/^\s+schedule:\s*(#.*)?$/.test(line)) { inSchedule = true; continue; }
      if (inSchedule) {
        if (/^\s*#/.test(line)) continue; // comment inside the block: keep state
        const cm = line.match(/^\s+(?:-\s+)?cron:\s*(.+)$/);
        if (cm) {
          const expr = cm[1].split('#')[0].trim().replace(/^['"]+|['"]+$/g, '').trim();
          if (expr) crons.push({ expr, line: i + 1 });
          continue;
        }
        if (!/^\s*-\s/.test(line) && /\S/.test(line)) inSchedule = false;
      }
      if (/^\S/.test(line) && /\S/.test(line)) { inOn = false; inSchedule = false; }
    }
  }
  return crons;
}

// ------------------------------------------------------------------- main
async function main() {
  const now = Date.now();
  const findings = [];
  const notes = [];

  const token = process.env.HEARTBEAT_TOKEN || process.env.VERIFY_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!token) { console.error('NO_TOKEN'); process.exit(1); }
  const H = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const api = async (path) => {
    const r = await fetch(`${API}${path}`, { headers: H });
    if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
    return r.json();
  };

  const rows = [];
  let globalWorstLagMs = null;

  const wfs = await api('/actions/workflows?per_page=100');
  // Only real repo workflows: exclude GitHub-managed synthetic entries like
  // "Dependabot Updates" (path dynamic/dependabot/... - no file to audit).
  const scheduled = wfs.workflows.filter((w) => w.path.startsWith('.github/workflows/') && (w.state === 'active' || w.state.startsWith('disabled')));

  for (const wf of scheduled) {
    const label = `${wf.name} (${wf.path})`;
    const file = join('.github', 'workflows', wf.path.split('/').pop());
    if (wf.state !== 'active') {
      findings.push(`\`${label}\` workflow state is **${wf.state}** - GitHub has disabled it (60-day repo inactivity auto-disable or a manual disable). Re-enable it (Settings > Actions, or push repo activity) before its next due date.`);
      continue;
    }
    if (!existsSync(file)) {
      findings.push(`\`${label}\` is active on the API but \`${file}\` is missing from the checkout (deleted on main since registration?).`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    const crons = extractCrons(text);
    if (crons.length === 0) continue; // event-driven (push/PR/workflow_run) - not our business

    // per_page=100, not 20. A baseline learned from two samples is the very
    // guess this audit was rebuilt to stop making.
    const runs = await api(`/actions/workflows/${wf.path.split('/').pop()}/runs?event=schedule&per_page=100`);
    const runObjs = runs.workflow_runs;
    const runStarts = runObjs.map((r) => Date.parse(r.run_started_at || r.created_at)).filter((t) => !Number.isNaN(t));
    const createdMs = Date.parse(wf.created_at);

    const parsed = [];
    for (const { expr, line } of crons) {
      let c;
      try { c = parseCron(expr); } catch (e) {
        findings.push(`\`${label}\` line ${line}: cron \`${expr}\` is not parseable (${e.message}). Fix the expression.`);
        continue;
      }
      parsed.push({ expr, line, c });
    }
    if (parsed.length === 0) continue;

    // ---- PASS 1: learn. Every due slot this workflow owed is reconstructed
    // and matched against the runs that satisfied it. Nothing is judged yet:
    // the patience floor is repo-wide, so verdicts must wait until every
    // workflow has been measured.
    const slotsMs = slotsBetween(parsed.map((p) => p.c), createdMs, now);
    const baseline = scheduleBaseline(slotsMs, runStarts);
    // First due slot of the period: the boundary a receipt must post after.
    // FIRST, not last - the Oct 28 chain declares four retries for one morning
    // and a verdict posted by the 07:23 attempt must still count when the
    // 19:33 slot is the one under audit.
    const periodStartMs = periodStart(slotsMs, now);
    if (baseline.worstLagMs !== null) {
      globalWorstLagMs = globalWorstLagMs === null ? baseline.worstLagMs : Math.max(globalWorstLagMs, baseline.worstLagMs);
    }

    for (const { expr, c } of parsed) {
      const next = nextFireAfter(c, now);
      if (next === null) {
        findings.push(`\`${label}\` cron \`${expr}\` has NO fire time in the next ${FORWARD_DAYS} days - it can never run (unsatisfiable expression). Fix or remove it.`);
        continue;
      }
      const lastDue = prevFireBefore(c, now);
      if (lastDue === null || lastDue < createdMs) {
        const nn = new Date(next).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
        notes.push(`\`${label}\` cron \`${expr}\` has never been due yet (next fire ~${nn}; workflow created ${wf.created_at.slice(0, 10)}) - nothing to audit until then.`);
        continue;
      }
      rows.push({
        label, expr, lastDue, baseline, runObjs, periodStartMs,
        receipt: RECEIPTS[wf.path.split('/').pop()] || null,
        tripper: TRIPPERS[wf.path.split('/').pop()] || null,
        // Resolved here, not in pass 2, so `receiptTargets` below can be a pure
        // function of the rows rather than a loop the tests cannot reach.
        okRun: runObjs.find((r) => Date.parse(r.run_started_at || r.created_at) >= lastDue) || null,
      });
    }
  }

  // The floor a historyless schedule is judged against: the slowest anything
  // in this repo has ever actually run, with headroom. Derived rather than
  // assumed - it reproduces the 12h that used to be hardcoded (8h26m x 1.5)
  // without pretending one observation speaks for every cron.
  const floorMs = globalWorstLagMs === null
    ? ABSOLUTE_FLOOR_MS
    : Math.max(Math.round(globalWorstLagMs * GRACE_HEADROOM), ABSOLUTE_FLOOR_MS);

  // ---- PASS 2: judge.
  // #18 comments are fetched at most once, and only if some row could need
  // them. A healthy audit of event-driven workflows must not pay for an
  // Issues call it will never read.
  let recordComments = null;
  const comments = async () => {
    if (recordComments === null) {
      recordComments = await api(`/issues/${ISSUE}/comments?per_page=100`);
      if (!Array.isArray(recordComments)) recordComments = [];
    }
    return recordComments;
  };
  const receiptRows = receiptTargets(rows);
  for (const row of rows) {
    const { label, expr, lastDue, baseline, periodStartMs, receipt } = row;
    const dueIso = new Date(lastDue).toISOString();
    // Any scheduled attempt started at/after the due instant counts:
    // completed (any conclusion - a RED run is still evidence the schedule
    // fired) or in progress (cron-day mornings). Runs from the previous slot
    // started before lastDue and are excluded by the comparison.
    const okRun = row.okRun;
    if (okRun) {
      const state = okRun.status === 'completed' ? okRun.conclusion : 'in progress';
      notes.push(`\`${label}\` cron \`${expr}\` last due ${dueIso} -> run ${okRun.id} ${state} (started ${okRun.run_started_at || okRun.created_at}).`);
      // A run that is still going may not have posted yet; asking now would
      // be the auditor racing its own subject. Only a COMPLETED run owes us a
      // receipt, and only a workflow that promised one in the first place.
      // A tripped sentinel is judged first and reported on its own: it is the
      // loudest thing in this report, and it is exactly what the old
      // any-conclusion-counts-as-fired rule used to discard.
      const trip = assessTrip({ contract: row.tripper, run: okRun });
      if (reportAs(trip) === 'finding') {
        findings.push(`\`${label}\` cron \`${expr}\` ${trip.finding}`);
        continue;
      }
      const ra = receiptRows.includes(row)
        ? assessReceipt({ contract: receipt, run: okRun, comments: await comments(), periodStartMs })
        : { verdict: 'run-incomplete' };
      const where = reportAs(trip) === 'note' ? trip : ra;
      if (reportAs(where) === 'finding') findings.push(`\`${label}\` cron \`${expr}\` ${where.finding}`);
      else if (reportAs(where) === 'note') notes.push(`\`${label}\` ${where.note}`);
      continue;
    }

    const g = gradeSlot({ baseline, lastDueMs: lastDue, nowMs: now, floorMs });
    const deadline = new Date(lastDue + g.graceMs).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
    const graceH = Math.round(g.graceMs / 360000) / 10;
    const evidence = baseline.worstLagMs === null
      ? `this workflow has never produced a scheduled run, so there is no baseline of its own to judge against`
      : `its own record shows a worst start ${formatLag(baseline.worstLagMs)} after a slot came due (median ${formatLag(baseline.medianLagMs)}), so it gets ${graceH}h of patience rather than this repo's floor`;

    if (g.verdict === 'within-history' || g.verdict === 'beyond-any-history' || g.verdict === 'no-baseline') {
      const how = g.verdict === 'within-history'
        ? `no run yet, but that is still no worse than its own worst start`
        : g.verdict === 'beyond-any-history'
          ? `no run yet and now past every start in its own record, though still inside the ${graceH}h headroom above that`
          : `judged against the repo floor of ${graceH}h, derived from the slowest any schedule here has ever run, because it has no history of its own`;
      notes.push(`\`${label}\` cron \`${expr}\` was due ${dueIso} and no scheduled run has started at/after that instant yet - ${how}. Silent for ${formatLag(g.elapsed)}; re-audit after ${deadline}.`);
      continue;
    }

    const streak = g.verdict === 'dead-streak'
      ? ` It has now missed ${g.missDays} consecutive days with no run at all, which no amount of elapsed time excuses.`
      : ` Silent for ${formatLag(g.elapsed)}, past the ${graceH}h patience derived from ${baseline.worstLagMs === null ? 'the repo floor' : 'its own worst start'}.`;
    findings.push(`\`${label}\` cron \`${expr}\` was due at **${dueIso}** but no scheduled run started at/after that instant.${streak} ${evidence}. The schedule looks dead: check the workflow state above, the 60-day inactivity rule, and the run list; the date-specific sentinels only cover their own mornings.`);
  }

  if (scheduled.length === 0) findings.push('No workflows returned by the Actions API - the query failed or every workflow is gone.');

  // ------------------------------------------------------------------ report
  const stamp = new Date(now).toISOString().slice(0, 10);
  const receipted = rows.filter((r) => r.receipt).length;
  console.log(`HEARTBEAT_AUDIT ${stamp} workflows=${scheduled.length} findings=${findings.length} ` +
    `receipt_contracts=${receipted}/${rows.length}`);
  for (const n of notes) console.log(`  ok   ${n}`);
  for (const f of findings) console.log(`  DEAD ${f}`);

  if (findings.length === 0) {
    console.log('HEARTBEAT_HEALTHY');
    process.exit(0);
  }

  const body = `Weekly schedule heartbeat (${stamp}): **${findings.length} finding(s)** - a schedule looks dead or disabled.` +
    `\n\n${findings.map((f) => `- ${f}`).join('\n')}` +
    (notes.length ? `\n\n<details><summary>Healthy / not-yet-due / inside the queue grace (${notes.length})</summary>\n\n${notes.map((n) => `- ${n}`).join('\n')}\n\n</details>` : '') +
    `\nAudit run: ${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID || '<local>'}`;

  const marker = `Weekly schedule heartbeat (${stamp})`;
  const prior = await api(`/issues/${ISSUE}/comments?since=${new Date(now - 8 * 86400000).toISOString()}&per_page=50`);
  if (Array.isArray(prior) && prior.some((c) => c.body && c.body.includes(marker))) {
    console.log(`ALREADY_RECORDED (${marker})`);
    process.exit(1);
  }
  if (process.env.HEARTBEAT_DRY_RUN === '1') {
    console.log('--- DRY RUN: comment body below (not posted) ---');
    console.log(body);
    process.exit(1);
  }
  const r = await fetch(`${API}/issues/${ISSUE}/comments`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!r.ok) {
    console.error(`COMMENT_FAILED ${r.status}: ${await r.text()}`);
    process.exit(1);
  }
  const created = await r.json();
  console.log(`COMMENT_POSTED id=${created.id}`);
  process.exit(1);
}

// Run the audit only when executed directly (tests import the cron math).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
