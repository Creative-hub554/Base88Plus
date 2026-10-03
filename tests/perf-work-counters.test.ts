/**
 * THE WORK GATE — deterministic superlinearity detection, by counting.
 *
 * `tests/perf/scaling-gate.test.ts` is the primary instrument for this repo
 * and stays that way. Timing is the only thing that generalises across a whole
 * corpus of functions without a bespoke probe for each one, and nothing here is
 * meant to replace it. But timing has two limits, both of them measured, both
 * written down in that file's own header, and this file is the answer to both —
 * for the functions where the counter can see what the clock cannot.
 *
 * LIMIT 1: A REGRESSION TO n^1.5 IS INVISIBLE TO TIMING. Driving synthetic
 * probes of known exponent through that harness, n^1.5 reads 2.70 against a
 * 3.00 limit and passes, while n^1.65 reads 3.62 and fails. So the timing
 * gate's detection floor is about n^1.65. That is arithmetic, not a tuning
 * mistake: catching 2.70 would need a limit near 2.5, and a linear function
 * already measures 2.09-2.16, so the margin would sit inside the noise the
 * harness is built to tolerate. A gate that flakes is worse than one with a
 * documented gap, and that file refuses to be the latter.
 *
 * This file's floor is log2(2.5) = n^1.32, because the quantity is an integer
 * count and has no variance to hide in: n^1.5 work doubles-plus-a-half per
 * doubling, i.e. 2.83, and 2.83 > 2.5 fails. That claim is not asserted in
 * prose, it is pinned by a test below, alongside the exponent it still misses
 * (n^1.25, at 2.38). Counting does not close the gap. It halves it.
 *
 * LIMIT 2: THE CHEAP FUNCTIONS ARE THE FLAKY ONES. A probe doing tens of
 * microseconds of work per call is mostly measuring the clock, and the timing
 * gate has the receipt in its own history: `prompt / extractFiles` read 3.22
 * against the 3.00 limit on a run where a focused 64x-ladder measurement of
 * the same probe gave 2.40. It was linear. The gate was wrong. Confirm-before-
 * fail papers over that; counting removes it.
 *
 * And the noise is not hypothetical at this size. Measuring the SAME build
 * twice gave 0.0644 and 0.0693 ms/call for `stripCodeBlocks` — a 7.5% spread
 * with nothing changed. An instrument whose run-to-run spread is larger than
 * the effect it is looking for is not measuring; this one is.
 *
 * WHAT IS COUNTED, AND THE LIMIT THAT MATTERS MOST: characters handed to a
 * scanner, charged once per call out of a local accumulator. That last part is
 * not a style preference, it is a measurement: charging per character cost
 * 2ns/char and read +6.8% on the `parseInline` hot loop, and charging per
 * match cost 19ns/match and read +10.9% on `localRefsFromHtml`. Both were
 * measured against a baseline, both were restructured, and the final form is
 * within the noise described above. An instrument for tests does not get to
 * cost the product 7%.
 *
 * WHAT CANNOT BE COUNTED, stated here so it is not discovered later by
 * assuming this file covers more than it does: work that happens inside a
 * single regex call. `isEmptyFenceOutput` is one `.replace()`; the characters
 * V8 steps through are not observable from JavaScript, and no charge site can
 * see them. The same goes for the anchored `test()` calls in
 * `isSummaryImitation` and the `replace` chain in `stripCodeBlocks` below the
 * line the counter charges. There is a test that pins this gap rather than
 * leaving it to prose, because a coverage claim that is never checked decays
 * into a coverage claim that is wrong.
 *
 * THE COST OF THE WHOLE FILE is a few microseconds: it is counting, not
 * timing, so there is no warm-up, no repeated sampling and no budget to spend.
 * That is why it lives in the main suite and not under `tests/perf/`, which
 * `npm run check:perf` runs serially in a single fork. This file needs none of
 * that machinery, so it should not wait for the perf job: it runs on every
 * `npm test`, on every PR, in milliseconds, and it cannot flake.
 */
import { describe, expect, it } from "vitest";
import { parseInline } from "@/lib/markdown";
import { chargeWork, measureWork } from "@/lib/perf-counter";
import {
  extractFiles,
  extractPartialFiles,
  isEmptyFenceOutput,
  isSummaryImitation,
  localRefsFromHtml,
  shouldOfferContinue,
  stripCodeBlocks,
} from "@/lib/prompt";

/**
 * How fast a function's WORK may grow per doubling of its input.
 *
 * Exactly 2.0 is linear, exactly 4.0 is quadratic. Unlike the timing gate's
 * 3.0 this is not placed between noisy readings of those two things — an
 * integer count has no noise, so the limit could in principle sit much closer
 * to 2.0. It does not, for the same reason the timing limit is 3.0 rather than
 * 2.1: a probe whose real growth is exactly linear can still report slightly
 * more than 2.0 (a name that gains a digit between n and 2n widens the input
 * a little), and a gate that fails on a true linear implementation is a gate
 * that gets muted. 2.5 is the same margin the timing gate's input-growth pin
 * uses, and it puts the detection floor at n^1.32.
 */
const MAX_WORK_RATIO = 2.5;

/**
 * Ladder for the work measurements. Bigger than the timing gate's, and free:
 * counting an input costs the same whether it is 200 units or 3200, so there
 * is no reason to keep the numbers small. Six steps rather than three, because
 * with no noise to average out there is nothing to gain from few samples and
 * a longer ladder catches a slow drift that only shows up past the first few
 * doublings.
 */
const SIZES = [100, 200, 400, 800, 1600, 3200] as const;

/**
 * How far the work-per-input-character may drift from the smallest size to the
 * largest. A ratio check alone can be satisfied by a function that is linear
 * for four doublings and then turns; pinning the per-character cost as well
 * catches drift that never crosses a single step's limit.
 *
 * 1.3 is generous because a few of these counts carry a small constant (a
 * header line here, a fence marker there) which genuinely does not scale, and
 * a constant is worth a little slack at the smallest size. It is far below the
 * 1.41x a doubling of a linear-but-slightly-concentrated workload would show.
 */
const WORK_PER_CHAR_SLACK = 1.3;

/**
 * The other half of the drift pin, and the one place counting is strictly
 * better than timing rather than merely more sensitive.
 *
 * Every other assertion in this file is about GROWTH, and growth is blind to
 * a constant factor: make `extractFiles` scan the reply twice and every ratio
 * in the file stays at 2.00, because doubling both sides of a quotient
 * changes nothing. Verified — that mutation is green here. It is also green
 * in the timing gate, where a flat 2x is likewise a ratio of 2.0, and it is
 * green forever after: nothing that measures growth can see it.
 *
 * A work count can, exactly and with no noise to argue about. Six units of
 * work per input character on a function that needs three is not a judgement
 * call, it is arithmetic. So each entry declares the most work per input
 * character it is allowed to do, and these are measured with ~15% of slack
 * rather than guessed — the failure message prints the real figure so a
 * regression names its own size.
 *
 * The trade is that this is the assertion that breaks first on a legitimate
 * optimisation-free change, e.g. a function that starts charging a pass it
 * did not charge before. That is a comment to update, not a mystery: the
 * charge sites are in the source, in the same file as the function.
 */

/* ------------------------------------------------------------------ *
 * The instrument itself
 * ------------------------------------------------------------------ */

describe("the work counter counts what it says it counts", () => {
  // The counter is a few lines of module state, and module state is exactly
  // the kind of thing that works in one test and silently contaminates the
  // next. These three are the failure modes that would produce a WRONG PASS:
  // a leaked count makes a linear function look quadratic, which at least
  // fails loudly — but a count that never accumulates makes every function
  // look perfectly linear, which is the failure this whole file exists to
  // prevent.
  it("accumulates while a measurement is running", () => {
    const { work } = measureWork(() => {
      chargeWork(10);
      chargeWork(32);
    });
    expect(work).toBe(42);
  });

  it("ignores charges made outside a measurement, so counts cannot leak between tests", () => {
    chargeWork(1_000_000);
    const { work } = measureWork(() => chargeWork(7));
    // If the un-measured charge leaked in, this would be 1000007 and every
    // ratio in the file would be meaningless.
    expect(work).toBe(7);
  });

  it("gives back the count it borrowed when the measured function throws", () => {
    expect(() =>
      measureWork(() => {
        chargeWork(5);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(measureWork(() => chargeWork(3)).work).toBe(3);
  });

  it("does not lose the outer count to a nested measurement", () => {
    const { work } = measureWork(() => {
      chargeWork(100);
      measureWork(() => chargeWork(7));
      chargeWork(5);
    });
    expect(work).toBe(105);
  });
});

/* ------------------------------------------------------------------ *
 * The gate's own teeth
 * ------------------------------------------------------------------ */

describe("the work gate can tell superlinear from linear", () => {
  // Same three-part calibration the timing gate runs, for the same reason: a
  // gate that cannot fail is not a gate. Only the third is interesting here,
  // since a quadratic charge is exactly 4.0 and a linear one exactly 2.0 by
  // construction — the assertion is that the RATIO MACHINERY is sound, not
  // that the arithmetic is.
  const chargeFor = (inputSize: number, exponent: number): number =>
    measureWork(() => chargeWork(Math.round(inputSize ** exponent))).work;

  it("flags a quadratic amount of work and does not flag a linear one", () => {
    const ratios = (exponent: number) => {
      let worst = 0;
      for (let i = 1; i < SIZES.length; i++) {
        worst = Math.max(worst, chargeFor(SIZES[i]!, exponent) / chargeFor(SIZES[i - 1]!, exponent));
      }
      return worst;
    };
    const quadratic = ratios(2);
    const linear = ratios(1);
    expect(quadratic).toBeGreaterThan(MAX_WORK_RATIO);
    expect(linear).toBeLessThanOrEqual(MAX_WORK_RATIO);
    // Well clear of 1.5, which is the timing gate's floor. Counting has room
    // to be tight precisely because it is not measuring time.
    expect(quadratic / linear).toBeGreaterThanOrEqual(1.5);
  });

  it("sees n^1.5, which the timing gate provably cannot", () => {
    // This is the whole reason this file exists, so it is pinned rather than
    // described. Timing reads 2.70 for this exponent against a 3.00 limit and
    // passes; see the table in tests/perf/scaling-gate.test.ts.
    let worst = 0;
    for (let i = 1; i < SIZES.length; i++) {
      worst = Math.max(worst, chargeFor(SIZES[i]!, 1.5) / chargeFor(SIZES[i - 1]!, 1.5));
    }
    // 2^1.5 = 2.83, comfortably over the 2.5 limit.
    expect(worst).toBeGreaterThan(MAX_WORK_RATIO);
  });

  it("still misses n^1.25, because counting is not magic either", () => {
    // log2(2.5) = 1.32. Anything shallower than that passes, here exactly as it
    // does in the timing gate below n^1.65. The gap is halved, not closed, and
    // a file that claimed otherwise would be lying in the direction that costs
    // someone a regression.
    let worst = 0;
    for (let i = 1; i < SIZES.length; i++) {
      worst = Math.max(worst, chargeFor(SIZES[i]!, 1.25) / chargeFor(SIZES[i - 1]!, 1.25));
    }
    // 2^1.25 = 2.38, under the limit — and asserted here so that anyone who
    // tightens MAX_WORK_RATIO past it has to think about what they lose.
    expect(worst).toBeLessThanOrEqual(MAX_WORK_RATIO);
  });
});

/* ------------------------------------------------------------------ *
 * The counted functions
 * ------------------------------------------------------------------ */

type Counted = {
  name: string;
  /** Builds the thunk measured at size n. */
  build: (n: number) => () => unknown;
  /** Characters handed to the function at n — the denominator for both caps. */
  inputSize: (n: number) => number;
  /**
   * The most work per input character this function may do, measured with
   * ~15% of slack over what it actually does today. Required rather than
   * defaulted: a default is a number nobody chose.
   */
  maxWorkPerChar: number;
  /**
   * An EXACT expected count, where one is available. At least one per module,
   * because these are the pins that make the rest meaningful: a charge site
   * that was deleted would leave every ratio in this file reading 0 — perfectly
   * linear, perfectly green, guarding nothing.
   */
  exactWork?: (n: number) => number;
};

const COUNTED: Counted[] = [
  {
    // The #113 shape, and the clearest case for counting in this repo. With the
    // memo, ONE scan of the remainder is charged and the rest of the brackets
    // are answered from it, so the count is exactly 4n-1. Remove the memo and
    // the first term is charged once per bracket: n/2 scans of n characters,
    // which is n-squared and a 4.0 ratio — deterministic, with no timing, no
    // runner and no threshold to argue about.
    name: "markdown / parseInline: unclosed brackets (the #113 shape)",
    build: (n) => {
      const src = "[a".repeat(n);
      return () => parseInline(src);
    },
    inputSize: (n) => 2 * n,
    exactWork: (n) => 4 * n - 1,
    // One scan of the remainder (2n-1) plus the outer pass (2n) over 2n
    // characters of input.
    maxWorkPerChar: 2.2,
  },
  {
    // The everyday case: every delimiter is present, so the nested scans each
    // find their closer after a bounded hop. The per-link recursion is charged
    // too, which is what keeps a nested parse from hiding its own growth.
    name: "markdown / parseInline: many complete links",
    build: (n) => {
      const src = "[label](https://example.com/target) ".repeat(n);
      return () => parseInline(src);
    },
    inputSize: (n) => 39 * n,
    // Per link: the label scan (6), the href scan (26) and the recursive parse
    // of the label (5), over 39 characters of input.
    maxWorkPerChar: 2.2,
  },
  {
    // The flake the timing gate hit: 3.22 against a 3.00 limit, on a function
    // that is linear. It is 23 microseconds per call, so its ratio was mostly
    // clock. Here it is three passes over the block and the parts, and a
    // second pass over `body` — the regression this count would catch — shows
    // up as a third of the total going missing, deterministically.
    name: "prompt / extractFiles: many files in one block",
    build: (n) => {
      let body = "";
      for (let i = 0; i < n; i++) body += `=== f${i}.html ===\n<p>body ${i}</p>\n`;
      const text = "```anybase\n" + body + "```";
      return () => void extractFiles(text);
    },
    inputSize: (n) => n * 30,
    // The reply, the block body, and every part's trim: three passes.
    maxWorkPerChar: 3.6,
  },
  {
    // Called on EVERY streamed token, so the one in this module where a second
    // pass would hurt most. Its input during a stream is a prefix of the final
    // reply, re-scanned on every token, which is exactly how #114 got in.
    name: "prompt / extractPartialFiles: streaming a block with no closing fence",
    build: (n) => {
      let body = "";
      for (let i = 0; i < n; i++) body += `=== f${i}.html ===\n<p>body ${i}</p>\n`;
      const text = "```anybase\n" + body;
      return () => void extractPartialFiles(text);
    },
    inputSize: (n) => n * 30,
    // The same three passes extractFiles makes.
    maxWorkPerChar: 3.6,
  },
  {
    // One regex pass, so the count is the input length and nothing else: 41
    // characters per repetition, so exactly 41n. This is the cheapest exact
    // pin in the file, and it is the one that fails if the single charge site
    // is ever dropped.
    name: "prompt / stripCodeBlocks: many blocks in a reply",
    build: (n) => {
      const text = "prose\n```anybase\n<p>x</p>\n```\nmore prose\n".repeat(n);
      return () => void stripCodeBlocks(text);
    },
    inputSize: (n) => 41 * n,
    exactWork: (n) => 41 * n,
    // Exactly one pass, and nothing else.
    maxWorkPerChar: 1.1,
  },
  {
    // The per-match term is what makes this worth counting: the document is
    // charged once, and each match is charged again on its own length, so a
    // per-match rescan of the whole document — the #115 shape, in a function
    // that walks every src/href — inflates the count instead of hiding in it.
    // 48 characters of input per repetition, plus `href="s.css"` (12+1) and
    // `src="a.js"` (9+1) of matched text per repetition: 71n exactly. Both
    // figures were counted off the real strings rather than estimated, after
    // a first draft of this comment had them 7% high.
    name: "prompt / localRefsFromHtml: many local refs",
    build: (n) => {
      const html = '<link href="s.css"><script src="a.js"></script>'.repeat(n);
      return () => void localRefsFromHtml(html);
    },
    inputSize: (n) => 48 * n,
    exactWork: (n) => 71 * n,
    // 48n of document plus 23n of matched text.
    maxWorkPerChar: 1.6,
  },
];

describe("no counted hot path does superlinear work", () => {
  for (const entry of COUNTED) {
    it(entry.name, () => {
      const works = SIZES.map((n) => measureWork(entry.build(n)).work);
      const sizes = SIZES.map((n) => entry.inputSize(n));

      // Liveness, first and separately: a counter with no charge sites reads
      // 0 at every size, every ratio below is 0, and this file passes while
      // guarding nothing at all.
      expect(works[0]!, `${entry.name} charged nothing at all`).toBeGreaterThan(0);
      for (let i = 1; i < works.length; i++) {
        expect(
          works[i]!,
          `${entry.name} did LESS work on a ${sizes[i]}-char input ` +
            `(${works[i]}) than on a ${sizes[i - 1]}-char one (${works[i - 1]})`,
        ).toBeGreaterThan(works[i - 1]!);
      }

      for (let i = 1; i < works.length; i++) {
        const ratio = works[i]! / works[i - 1]!;
        expect(
          ratio,
          `${entry.name} did ${ratio.toFixed(2)}x the work on a ${sizes[i]}-char input ` +
            `(${sizes[i - 1]} -> ${sizes[i]} chars) against a ${MAX_WORK_RATIO} limit. ` +
            `Linear is 2.00, quadratic is 4.00. Work by size: ` +
            SIZES.map((n, k) => `${n}:${works[k]}`).join(" "),
        ).toBeLessThanOrEqual(MAX_WORK_RATIO);
      }

      // And no slow drift: the work per input character must not climb across
      // the ladder even where no single step crosses the limit.
      const perChar = works.map((w, k) => w / sizes[k]!);
      expect(
        perChar[perChar.length - 1]! / perChar[0]!,
        `${entry.name} costs ${perChar[perChar.length - 1]!.toFixed(3)} work per input ` +
          `character at ${sizes[sizes.length - 1]} against ${perChar[0]!.toFixed(3)} at ` +
          `${sizes[0]} — it is drifting upward, which is what superlinearity looks like ` +
          `before it is visible in any single step`,
      ).toBeLessThanOrEqual(WORK_PER_CHAR_SLACK);

      for (let i = 0; i < SIZES.length; i++) {
        const perChar = works[i]! / sizes[i]!;
        expect(
          perChar,
          `${entry.name} did ${perChar.toFixed(2)} units of work per input character at ` +
            `n=${SIZES[i]}, over a ${entry.maxWorkPerChar} cap. A constant factor ` +
            `costs no growth, so no ratio anywhere — here or in the timing gate — ` +
            `would notice; only the count does`,
        ).toBeLessThanOrEqual(entry.maxWorkPerChar);
      }

      if (entry.exactWork) {
        for (let i = 0; i < SIZES.length; i++) {
          expect(
            works[i],
            `${entry.name} charged ${works[i]} at n=${SIZES[i]}, expected exactly ` +
              `${entry.exactWork(SIZES[i]!)}. An exact count is the anti-vacuity pin: if a ` +
              `charge site was removed or moved, this fails instead of reading a ` +
              `comfortably linear zero`,
          ).toBe(entry.exactWork(SIZES[i]!));
        }
      }
    });
  }
});

/* ------------------------------------------------------------------ *
 * The gap, pinned
 * ------------------------------------------------------------------ */

describe("the functions counting cannot reach are named, not assumed", () => {
  // Each of these does its work inside a single regex call, where the
  // characters V8 steps through are not observable from JavaScript. There is no
  // charge site that could see them without rewriting the function as a hand-
  // written loop, which is a change to shipped code made only to make a test
  // able to see it — a bad trade unless the rewrite is wanted on its own merit.
  //
  // So they stay on the timing gate, and this test exists to keep that
  // statement honest. It fails the moment someone DOES instrument one, which
  // is the point: the fix is to add it to COUNTED above and delete this, not to
  // relax the assertion.
  //
  // This is not a comfortable gap. The timing gate's own envelope report, on
  // the run that prompted this file, put `isEmptyFenceOutput` at the TOP of its
  // 33 probes at 2.45-2.53 against the 3.00 limit — the least headroom in the
  // corpus — and it is one of the three this file cannot count. So the one
  // function with the weakest timing margin is the one with no deterministic
  // backstop at all. One run is not a pattern and the ordering moves between
  // runs, but the direction is the wrong way, and the honest response is to
  // name it rather than to let the coverage map look tidier than it is.
  // The real fix is to rewrite `isEmptyFenceOutput` as an explicit scan, which
  // would make it countable AND remove a regex from a per-turn path — worth
  // doing on its own merits, not as an instrument.
  it("charges nothing for the per-turn predicates, so their cover is still timing", () => {
    const narration = "```\n".repeat(500);
    expect(measureWork(() => isEmptyFenceOutput(narration)).work).toBe(0);
    expect(
      measureWork(() =>
        shouldOfferContinue({ hadFence: false, files: null, error: null, narrationText: narration }),
      ).work,
    ).toBe(0);
    expect(
      measureWork(() =>
        isSummaryImitation({
          hadFence: false,
          files: null,
          narrationText: "[wrote 3 file(s)] ".repeat(500),
        }),
      ).work,
    ).toBe(0);
  });
});
