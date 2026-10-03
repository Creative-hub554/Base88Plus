/**
 * An opt-in, deterministic work counter.
 *
 * WHY THIS EXISTS. The superlinearity gate in `tests/perf/scaling-gate.test.ts`
 * measures cost by TIMING, because timing is the only thing that generalises
 * across a whole corpus of functions without a bespoke instrument each. But
 * timing has two measured limits, both recorded in that file's own header, and
 * both of which are fixed here:
 *
 *  1. A REGRESSION TO n^1.5 IS INVISIBLE TO IT. Driving synthetic probes of
 *     known exponent through that harness, n^1.5 reads 2.70 against a 3.00
 *     limit and passes. Catching it would need a limit near 2.5, and a linear
 *     function already measures 2.09-2.16 — the margin would sit inside the
 *     noise the harness is built to tolerate. That gap is arithmetic, not a
 *     tuning mistake, and no threshold can close it.
 *
 *  2. THE CHEAP FUNCTIONS ARE THE FLAKY ONES. A probe whose work per call is
 *     tens of microseconds is mostly measuring the clock. The gate's own
 *     history has the receipt: `prompt / extractFiles` read 3.22 against the
 *     3.00 limit on a run where a focused 64x-ladder measurement of the same
 *     probe gave 2.40. It is linear; the gate was wrong. Confirm-before-fail
 *     papers over that, it does not fix it.
 *
 * Both come from the same root: TIME is a proxy for WORK. Where work is
 * directly observable, count it and the noise and the sub-quadratic blind spot
 * both disappear, because an integer count has no variance at all.
 *
 * THE PRECEDENT IS ALREADY IN THIS REPO. `stats().charsParsed` on
 * `createStreamingMarkdownParser` counts the characters handed to the block
 * parser, and `tests/markdown-streaming.test.tsx` pins that count rather than a
 * time — which is why the #114 regression was caught. This module generalises
 * that instrument to the functions where the gate's timing is least reliable.
 *
 * WHAT IS COUNTED: characters handed to a scanner, charged ONCE per scan
 * rather than per character. That is the quantity that grows when an algorithm
 * rescans, and it is charged at the scan's exits — never inside the scan loop.
 * A charge inside a per-character loop would add a function call to the hottest
 * loop in the renderer, which is the one cost this instrument must not have.
 *
 * WHAT IS NOT COUNTED, stated plainly rather than left to be discovered:
 *  - Work that happens inside a single regex call. The characters V8 steps
 *    through are not observable from JavaScript, and no charge site can see
 *    them. `isEmptyFenceOutput` was the standing example for a while — it
 *    was also the worst-reading probe in the timing gate, with the least
 *    headroom of the whole corpus, so the two facts were not a
 *    coincidence. It was rewritten as an explicit character scan in #121,
 *    which closed the gap AND removed two full-length copies of the reply
 *    from a per-turn path. When this instrument wants a rewrite the code
 *    can afford, rewrite the code; the counting is not the only reason,
 *    and the diff turned out to be worth having on its own. One function is
 *    still unreachable — `isSummaryImitation`, one anchored regex `test()` —
 *    and tests/perf-work-counters.test.ts names it in a test.
 *  - Anything not charged by a call site. The counter is only as complete as
 *    the charge sites, and a charge site inside an early return is a hole.
 *
 * WHAT IS NOW COUNTED, after #122 finished the job #120 started:
 * NOW THE WHOLE-REPLY RENDER PATH HAS A BUDGET, which is the claim that
 * matters most to a user: rendering a reply of length n costs at most 461
 * units per 132 characters, forever, counted rather than timed.
 * `tests/perf-work-counters.test.ts` pins it exactly, and it took charging
 * `toLines`, the block pass and `safeUrl` — the three terms between the
 * source string and the rendered blocks that nothing had been counting.
 *
 * And the budget immediately paid for itself by finding the one term that is
 * NOT proportional: `safeLineCount` reads the WHOLE buffer once per token, so
 * it is linear per call and quadratic across a stream. Measured at a ratio of
 * 4.00, per-character cost rising 560 -> 17,610. That is pinned as a measured
 * fact with its own test, because the fix is a change to the streaming parser
 * and not something an instrument should quietly paper over.
 *
 * TWENTY-NINE of the timing gate's thirty-three probes. The markdown parser
 * and the reply helpers were first, then the demo scanners — `forEachTag`,
 * `forEachTagRun`, `indexOfCloseAnchor`, `textBetween`, the link audit, the
 * three demo gates and the sanitiser. That corpus was not chosen for convenience: it is the set
 * of functions this repo has actually shipped a superlinearity bug in, four of
 * them in a single afternoon.
 *
 * The demo scanners needed one idea the reply helpers did not. They are
 * already hand-written loops, so their work is visible — but charging how far
 * a WALK ADVANCED would have been worse than not counting them at all. Every
 * quadratic scanner this repo has had advanced one character per `<` while
 * re-reading the remainder, so a progress-based count reads perfectly linear
 * while the work goes quadratic. What is charged instead is the distance each
 * `indexOf` SEARCHED, the whole remainder included when it finds nothing.
 * Reintroducing the #115 retry in `forEachTag` now reads 3.87x on the work gate
 * and 2.00x on every ratio-based instrument in the repo.
 *
 * THE COST WHEN DISARMED is one boolean test per charge site, and charge sites
 * are placed at scan exits rather than in loops, so a disarmed charge is off
 * the hot path entirely. Measured directly, over 20 million calls in a tight
 * loop: **10.1 ns per call disarmed**, 15.6 ns armed — the armed half is paid
 * only inside a `measureWork`, which is tests. Against the smallest function
 * instrumented in #122 that is under 0.005% of its own runtime, which is why
 * the A/B that motivated the direct measurement could not resolve it: with a
 * per-call charge at 10ns, a `visibleText` call measured at 4.0ms for 20,000
 * tags cannot move. Reading the A/B instead reports noise in both directions
 * across identical runs (-4.7% to +7.2% for the same pair), consistent with
 * the 7.5% spread this repo measures on an UNCHANGED build. The streaming
 * parser already counts unconditionally in production (`stats().charsParsed`),
 * so this is strictly cheaper than a precedent the repo accepted for the same
 * reason.
 *
 * NOT PRODUCTION INFRASTRUCTURE. Nothing in `src/` calls `measureWork`; only
 * tests do. If that ever changes the counting is a per-call cost on a user path
 * and this module should be deleted instead.
 */

let armed = false;
let total = 0;

/**
 * Charge `units` of scanned characters to the innermost active measurement.
 *
 * A no-op unless a `measureWork` is running, so a caller can place charges on
 * the real path without a guard of its own.
 */
export function chargeWork(units: number): void {
  if (armed) total += units;
}

/**
 * Run `fn` and report the work it did, in charged units.
 *
 * Restores the previous counter state on the way out, including on a throw, so
 * nested and repeated measurements do not accumulate into each other.
 */
export function measureWork<T>(fn: () => T): { value: T; work: number } {
  const wasArmed = armed;
  const before = total;
  armed = true;
  total = 0;
  try {
    const value = fn();
    return { value, work: total };
  } finally {
    armed = wasArmed;
    total = before;
  }
}
