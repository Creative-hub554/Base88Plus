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
 * single regex call. The characters V8 steps through are not observable from
 * JavaScript, and no charge site can see them without rewriting the function
 * as a hand-written loop.
 *
 * That is no longer hypothetical for this corpus — it WAS the reason
 * `isEmptyFenceOutput` could not be counted at all, and it was also the
 * worst-reading probe in the timing gate, with the least headroom of all 33.
 * Rewriting it as an explicit scan (#121) made it countable AND removed two
 * full-length copies from a per-turn path, so the gap closed from the
 * implementation side rather than by pretending it away. The lesson generalises:
 * when the deterministic instrument wants a rewrite the code can afford, do the
 * rewrite instead of documenting the hole.
 *
 * The demo scanners joined in #122, which took the coverage from eight
 * functions to twenty-seven of the timing gate's thirty-three probes: the tag
 * walk, the link audit, the three demo gates and the sanitiser. What they
 * needed is the point of their entries — these are hand-written loops already,
 * so the honest question was not whether their work is visible but WHICH
 * number to charge. Progress would have been useless: every quadratic scanner
 * this repo has shipped advances one character per `<` while re-reading the
 * remainder, so a progress count reads linear while the work goes quadratic.
 * What is charged is the distance each `indexOf` SEARCHED, remainder included
 * when it finds nothing. Restoring the #115 retry in `forEachTag` — one line —
 * takes the audit entries to 3.87x here while every ratio-only instrument in
 * the repo stays at 2.00x.
 *
 * THE WHOLE-REPLY RENDER PATH is budgeted here, and it is the entry that
 * answers the question a user would actually ask: what does it cost to render
 * a reply of this size. Every other markdown entry measures a fragment; this
 * one measures the document, and its answer is exact — 461 charged units per
 * 132 characters of a realistic reply, whatever the length.
 *
 * Getting there meant charging the three terms between the source string and
 * the rendered blocks that nothing was counting: `toLines`, the block pass, and
 * `safeUrl` (one per link, which is why the many-links cap moved from 2.2 to
 * 3.7 — a URL that gets validated is work the old count did not know about).
 *
 * AND THE BUDGET FOUND THE HOLE IN ITS OWN PATH. `safeLineCount` is charged
 * one pass over the buffer, which is linear per call — so it is a normal entry
 * in the table — but the streaming parser asks it once per token over the
 * whole reply, which is quadratic across a stream. Measured: ratio 4.00,
 * per-character cost 560 -> 17,610. The block parser is innocent; its
 * `charsParsed` is bounded per tail and stays linear, which is exactly why
 * #114's streaming work landed and this went unnoticed next to it. The test
 * after the table measures it on purpose. The FIX is a change to the parser
 * (resuming `safeLineCount` needs the fence state at the resume point), and it
 * wants its own PR rather than a quiet change to an instrument.
 *
 * One function still cannot be counted — `isSummaryImitation`, whose work is
 * one anchored regex `test()` — and there is a test that pins that fact, so
 * the gap cannot quietly grow back.
 *
 * THE COST OF THE WHOLE FILE is a few microseconds: it is counting, not
 * timing, so there is no warm-up, no repeated sampling and no budget to spend.
 * That is why it lives in the main suite and not under `tests/perf/`, which
 * `npm run check:perf` runs serially in a single fork. This file needs none of
 * that machinery, so it should not wait for the perf job: it runs on every
 * `npm test`, on every PR, in milliseconds, and it cannot flake.
 */
import { describe, expect, it } from "vitest";
import {
  createStreamingMarkdownParser,
  parseInline,
  parseMarkdown,
  safeLineCount,
  safeUrl,
} from "@/lib/markdown";
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
import {
  auditDemoLinks,
  demoNavIsWired,
  forEachTag,
  forEachTagRun,
  resolveDemoPath,
  textBetween,
} from "@/lib/demo-link-audit";
import {
  fillerHits,
  missingBriefFiles,
  runDemoGates,
  selectorProblems,
  visibleText,
} from "@/lib/demo-gates";
import { demoLooksComplete, sanitizeDemoFiles } from "@/lib/template-generation";
import type { DemoAuditFile } from "@/lib/demo-link-audit";
import type { GateFile } from "@/lib/demo-gates";
import type { ProjectFile } from "@/lib/types";

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

/**
 * One block of a realistic model reply — heading, prose with every inline
 * construct, a list, a quote — and nothing exotic in it. The length is asked
 * of the string rather than written down, because an `inputSize` that drifts
 * from the input is a drift this file would report as the code getting worse.
 */
function realisticUnit(): string {
  return [
    "## Section heading",
    "",
    "Some prose with **bold**, `code`, and a [link](https://example.com/x).",
    "",
    "- a list item",
    "- another item",
    "",
    "> a quote",
    "",
  ].join("\n");
}

/** The brief `missingBriefFiles` is handed: real length, digits and all. */
function briefOf(n: number): string {
  const names: string[] = [];
  for (let i = 0; i < n; i++) names.push(`mod${i}.js`);
  return names.join(" ");
}

/** A path with n segments, for the resolvers. */
function segPathOf(n: number): string {
  return Array.from({ length: n }, (_, i) => `d${i}`).join("/") + "/file.html";
}

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
    // Per link: the label scan (6), the href scan (26), the recursive parse
    // of the label (5), and — since the render-path work budget — `safeUrl`
    // reading the URL twice (the strip loop and the lowercasing), over 39
    // characters of input. The cap MOVED here, from 2.2 to 3.7, when that
    // charge site was added, and the move is the point: a URL that gets
    // validated is work the old count did not know about. The per-character
    // assertion above is what made it visible; no ratio in the repo would have.
    maxWorkPerChar: 3.7,
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
    // THE ONE THAT COULD NOT BE COUNTED UNTIL IT WAS REWRITTEN. Its work used
    // to be `replace(/```[a-zA-Z]*/g, "").trim().length === 0`, and the
    // characters a regex walks are not observable from JavaScript, so there was
    // nothing to charge. It is now an explicit character scan (#121).
    //
    // The count is worth reading rather than skimming: it is NOT a fixed
    // multiple of the input. On this all-fence input the scan reads every
    // character, so it charges 2 x input — the pre-pass and the loop. On a
    // healthy reply it would charge the pre-pass plus the handful of characters
    // before the first real prose, which is the property the rewrite was for.
    name: "prompt / isEmptyFenceOutput: narration full of fence markers",
    build: (n) => {
      const narration = "```\n".repeat(n);
      return () => void isEmptyFenceOutput(narration);
    },
    inputSize: (n) => 4 * n,
    // The `includes` pre-pass reads the whole string; the scan reads all of it
    // again on this input, because every character is part of a marker.
    exactWork: (n) => 8 * n,
    maxWorkPerChar: 2.2,
  },
  {
    // Counted THROUGH its callee, not in its own body: this function charges
    // nothing itself and reaches the scan only because `hadFence` is false and
    // there is no error — which is exactly the case it exists to catch. Worth
    // listing anyway, because the two short-circuits above it are the common
    // path and the third is the interesting one.
    //
    // It also gives the liveness pin something to do here: if
    // `isEmptyFenceOutput` ever stops charging, this entry's count drops to
    // zero and the work > 0 assertion fails, naming a function that looks fine.
    name: "prompt / shouldOfferContinue: a long narration that is all fence markers",
    build: (n) => {
      const narrationText = "```\n".repeat(n);
      return () =>
        void shouldOfferContinue({ hadFence: false, files: null, error: null, narrationText });
    },
    inputSize: (n) => 4 * n,
    maxWorkPerChar: 2.2,
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

  {
    // The shared tag walk, and the reason these scanners are countable at all:
    // they were rewritten away from `/<[a-zA-Z][^>]*>/g` in #115, and a loop
    // is something JavaScript can be told how much of. The count is NOT the
    // distance the walk advanced — it is the distance each `indexOf` searched,
    // because the quadratic shape this instrument exists to catch advanced by
    // one character per `<` while re-reading the whole remainder.
    //
    // 17 characters per `<a href="x">y</a>` unit: the search to each `<`, the
    // search to each `>`, and the trailing `</a>` that is not an opening tag.
    name: "link-audit / forEachTag: well-formed tags",
    build: (n) => {
      const html = '<a href="x">y</a>'.repeat(n);
      return () => {
        forEachTag(html, () => {});
      };
    },
    inputSize: (n) => 18 * n,
    exactWork: (n) => 17 * n,
    maxWorkPerChar: 1.09,
  },
  {
    // The #115 shape with a terminator: n terminated runs and then one tag with
    // no `>`. The final search reads the whole remainder and finds nothing,
    // which is the +4 and +1 the exact count carries.
    name: "link-audit / forEachTagRun: terminated runs then an unterminated tag",
    build: (n) => {
      const html = "<div>".repeat(n) + "<div";
      return () => {
        forEachTagRun(html, () => {});
      };
    },
    inputSize: (n) => 5 * n + 4,
    exactWork: (n) => 5 * n + 5,
    maxWorkPerChar: 1.16,
  },
  {
    // Two passes over the window: the tag walk `forEachTagRun` charges for
    // itself, and then the rebuild reads it again. Exactly 2x, which makes it
    // the cleanest statement in this file of what a "pass" costs.
    name: "link-audit / textBetween: many anchors",
    build: (n) => {
      const html = '<a href="x">label</a> '.repeat(n);
      return () => void textBetween(html, 0, html.length);
    },
    inputSize: (n) => 22 * n,
    exactWork: (n) => 44 * n,
    maxWorkPerChar: 2.3,
  },
  {
    // The audit, on the shape that once hid a quadratic: a page whose tail is
    // one unterminated anchor after another. No exact count here, because the
    // four real links before it are a fixed cost the ladder cannot divide out.
    name: "link-audit / auditDemoLinks: real links then unterminated tags (the #115 shape)",
    build: (n) => {
      const content = '<a href="x">y</a>'.repeat(4) + "<div".repeat(n);
      return () => void auditDemoLinks([{ path: "index.html", content }]);
    },
    inputSize: (n) => 72 + 4 * n,
    maxWorkPerChar: 2.65,
  },
  {
    // Many pages, many links each. The per-char figure drifts gently UPWARD
    // across the ladder — the page stems in the filenames gain digits — which
    // is why the drift pin exists next to the ratio pin.
    name: "link-audit / auditDemoLinks: many pages x many links (the #115 shape)",
    build: (n) => {
      const files: DemoAuditFile[] = [];
      for (let i = 0; i < n; i++) {
        files.push({ path: `p${i}.html`, content: '<a href="x">y</a>'.repeat(4) });
      }
      return () => void auditDemoLinks(files);
    },
    inputSize: (n) => n * 73,
    maxWorkPerChar: 4.45,
  },
  {
    // One page, real links then a long unterminated tail: the walk stops at the
    // first `<` with no `>` ahead instead of retrying at every bracket.
    name: "link-audit / auditDemoLinks: many links on one page",
    build: (n) => {
      const content = linksPage(4) + '<a href="x"'.repeat(n);
      return () =>
        void auditDemoLinks([
          { path: "index.html", content },
          { path: "page.html", content: "<p>t</p>" },
        ]);
    },
    inputSize: (n) => linksPage(4).length + 11 * n + 8,
    maxWorkPerChar: 2.6,
  },
  {
    // Three passes over the document: the script/style strip, the tag walk, and
    // the whitespace collapse `split`/`join`. 49 characters of work per
    // 21-character `<p>hello world</p>`, exactly, forever.
    name: "gates / visibleText: many tags",
    build: (n) => {
      const html = "<p>hello world</p>".repeat(n);
      return () => void visibleText(html);
    },
    inputSize: (n) => 21 * n,
    exactWork: (n) => 49 * n,
    maxWorkPerChar: 2.69,
  },
  {
    // The #115 shape, kept with a terminator so there is real per-tag work to
    // do: the trailing `<div` survives as text because no `>` follows it.
    name: "gates / visibleText: tags then an unterminated one (the #115 shape)",
    build: (n) => {
      const html = "<p>hello world</p>".repeat(n) + "<div";
      return () => void visibleText(html);
    },
    inputSize: (n) => 21 * n + 4,
    exactWork: (n) => 49 * n + 13,
    maxWorkPerChar: 2.69,
  },
  {
    // Both filler regexes read the visible text of every page, and
    // `visibleText` itself charges three passes — so this is the composition,
    // and it is the honest figure: a gate that ran the filler scan twice would
    // show up here immediately.
    name: "gates / fillerHits: many files with filler copy",
    build: (n) => {
      const files: GateFile[] = [];
      for (let i = 0; i < n; i++) {
        files.push({ path: `p${i}.html`, content: "<p>Feature 1 and Project 2</p>" });
      }
      return () => void fillerHits(files);
    },
    inputSize: (n) => 38 * n,
    exactWork: (n) => 108 * n,
    maxWorkPerChar: 3.27,
  },
  {
    // The gate that produced the `saas` finding: one app.js linked from every
    // page, selected against every page. Cost is pages x selectors, and the
    // highest per-char figure in this file — two passes per page plus a whole
    // script read and a 400-character guard window, for every selector.
    name: "gates / selectorProblems: many pages sharing one script",
    build: (n) => {
      const files: GateFile[] = [];
      for (let i = 0; i < n; i++) {
        files.push({
          path: `p${i}.html`,
          content: `<body><script src="app.js"></script><p id="only${i}">x</p></body>`,
        });
      }
      files.push({
        path: "app.js",
        content: 'const el = document.querySelector("#absent");\nel.addEventListener("click", () => {});',
      });
      return () => void selectorProblems(files);
    },
    inputSize: (n) => n * 78 + 90,
    maxWorkPerChar: 9.05,
  },
  {
    // Counted through its three gates, not in its own body — `runDemoGates`
    // charges nothing itself and is exactly the composition of the entries
    // above, which is what makes it the best single number in this file for
    // "what does one full gate run cost".
    name: "gates / runDemoGates: full gate run over many pages",
    build: (n) => {
      const files: GateFile[] = [];
      for (let i = 0; i < n; i++) {
        files.push({
          path: `p${i}.html`,
          content: `<body><script src="app.js"></script><p>Feature 1</p></body>`,
        });
      }
      files.push({ path: "app.js", content: "const el = document.getElementById('x');" });
      return () => void runDemoGates("p0.html", files);
    },
    inputSize: (n) => n * 76 + 60,
    maxWorkPerChar: 10.1,
  },
  {
    // One pass over the brief and nothing else — so the count IS the input
    // length, to the character. The input size is the brief's real length
    // rather than a formula for it: an estimate that drifts is a drift this
    // file would report as the function getting worse.
    name: "gates / missingBriefFiles: a brief naming many files",
    build: (n) => {
      const brief = briefOf(n);
      return () => void missingBriefFiles(brief, []);
    },
    inputSize: (n) => briefOf(n).length,
    maxWorkPerChar: 1.15,
  },
  {
    // The sanitiser, on a page with nothing to fix. Five passes per unit: the
    // strip walk, the fixed-point loop's second pass, the unescape rebuild,
    // the relink tag walk and the relink rebuild. The +25 is the page's own
    // opening tag and the constant tail of those walks.
    name: "sanitiser / sanitizeDemoFiles: well-formed page",
    build: (n) => {
      const files: ProjectFile[] = [{ path: "index.html", content: "<p>hello</p>".repeat(n) }];
      return () => void sanitizeDemoFiles(files);
    },
    inputSize: (n) => 12 * n + 12,
    exactWork: (n) => 60 * n + 25,
    maxWorkPerChar: 5.75,
  },
  {
    // The 730ms case: unterminated anchors. The point of counting it is that
    // the quadratic it used to have was INVISIBLE here — every `<` advanced the
    // walk by one character, so a count taken from progress would have read
    // linear. This count is taken from search distance, and it is linear.
    name: "sanitiser / sanitizeDemoFiles: unterminated anchors (the #115 shape)",
    build: (n) => {
      const files: ProjectFile[] = [{ path: "index.html", content: '<a href="x"'.repeat(n) }];
      return () => void sanitizeDemoFiles(files);
    },
    inputSize: (n) => 11 * n + 12,
    exactWork: (n) => 55 * n + 28,
    maxWorkPerChar: 5.75,
  },
  {
    // The pass that actually changes something: a broken `<img src>` per unit,
    // dropped from the output. The lowest per-char figure in the file, because
    // a page of broken refs never reaches the relink walk's per-anchor work.
    name: "sanitiser / sanitizeDemoFiles: broken refs to neutralise",
    build: (n) => {
      const files: ProjectFile[] = [
        { path: "index.html", content: '<img src="pic.png" alt="x">'.repeat(n) },
      ];
      return () => void sanitizeDemoFiles(files);
    },
    inputSize: (n) => 28 * n + 12,
    exactWork: (n) => 35 * n + 25,
    maxWorkPerChar: 1.44,
  },
  {
    // The relink path, and the O(files x pages) shape #115 removed. The drift
    // is the page stems in the filenames gaining digits; the cap is set from
    // the top of the ladder, not from the middle of it.
    name: "sanitiser / sanitizeDemoFiles: placeholder nav across many pages",
    build: (n) => {
      const files: ProjectFile[] = [];
      for (let i = 0; i < n; i++) {
        files.push({ path: "index.html", content: `<a href="#">Page ${i}</a>` });
        files.push({ path: `page-${i}.html`, content: "<body><p>page</p></body>" });
      }
      return () => void sanitizeDemoFiles(files);
    },
    inputSize: (n) => n * 48,
    maxWorkPerChar: 8.9,
  },
  {
    // The generation gate. One pass per file, so the count is the total content
    // of the demo — charged as the documents, because what a regex reads
    // inside is not observable from JavaScript and the document is the honest
    // upper bound on it.
    name: "sanitiser / demoLooksComplete: many files",
    build: (n) => {
      const files: ProjectFile[] = [];
      for (let i = 0; i < n; i++) {
        files.push({ path: `p${i}.html`, content: "<body><p>x</p></body>" });
      }
      files.push({ path: "style.css", content: "body{}" });
      return () => void demoLooksComplete(files);
    },
    inputSize: (n) => n * 31 + 22,
    exactWork: (n) => 21 * n + 6,
    maxWorkPerChar: 0.78,
  },
  {
    // Counted through `auditDemoLinks`, like `shouldOfferContinue` is counted
    // through `isEmptyFenceOutput`: the wrapper charges nothing and exists only
    // to ask the question below it.
    name: "link-audit / demoNavIsWired: many pages of nav to one target",
    build: (n) => {
      const files: DemoAuditFile[] = [];
      for (let i = 0; i < n; i++) {
        files.push({ path: `p${i}.html`, content: `<a href="#">Page ${i}</a>` });
        files.push({ path: `page-${i}.html`, content: "<body><p>page</p></body>" });
      }
      return () => void demoNavIsWired(files);
    },
    inputSize: (n) => n * 48,
    maxWorkPerChar: 6.2,
  },
  {
    // The cheapest probe in the corpus, and counted like any other: two splits
    // and a join over the two strings it was handed. The count is those two
    // lengths, summed, which is why it can be pinned exactly.
    name: "link-audit / resolveDemoPath: a deeply segmented target",
    build: (n) => {
      const target = segPathOf(n);
      return () => void resolveDemoPath("a/b/c/page.html", target);
    },
    inputSize: (n) => segPathOf(n).length + "a/b/c/page.html".length,
    exactWork: (n) => segPathOf(n).length + "a/b/c/page.html".length,
    maxWorkPerChar: 1.2,
  },

  {
    // THE WHOLE-REPLY RENDER PATH, and the answer to "what does it cost to
    // render a reply of this size". Every other markdown entry here measures a
    // FRAGMENT — the inline pass, a bracket, a link. This one measures the
    // document: line splitting, the block pass over every line, and the inline
    // parse of every block inside it.
    //
    // 461 charged units per 132-character unit, measured, with the exact count
    // pinned so a charge site cannot quietly move. Three passes per character
    // is what this costs: `toLines` reads the source, the block pass reads
    // each line it classifies, and `parseInline` reads the block's text.
    name: "markdown / parseMarkdown: a realistic long reply",
    build: (n) => {
      const src = realisticUnit().repeat(n);
      return () => void parseMarkdown(src);
    },
    inputSize: (n) => realisticUnit().length * n,
    exactWork: (n) => 461 * n,
    maxWorkPerChar: 4,
  },
  {
    // A link's scheme check, on the input the parser hands it: the strip loop
    // walks every code unit and the lowercasing reads what is left, so the
    // count is `raw.length + cleaned.length` and lands at exactly 2 per
    // character. It was one of the six probes the work gate could not reach,
    // because a `for...of` with `codePointAt` inside is opaque both to a
    // reader and to a count.
    name: "markdown / safeUrl: long URL with a scheme",
    build: (n) => {
      const url = "https://example.com/" + "p".repeat(n * 8);
      return () => void safeUrl(url);
    },
    inputSize: (n) => 20 + 8 * n,
    // 16 per character of URL, plus the 40 the constant prefix costs twice.
    exactWork: (n) => 16 * n + 40,
    maxWorkPerChar: 2.3,
  },
  {
    // The one term in the render path proportional to the BUFFER rather than
    // to the tail: the streaming parser asks it once per token, over the whole
    // reply so far. Per call it is exactly one pass, which is why it belongs
    // in this file rather than in a note about the parser.
    //
    // And that is why it is worth an entry of its own. Per call: linear.
    // Across a stream: n calls over a buffer of n, which is quadratic — and
    // the next test in this file is what says so out loud.
    name: "markdown / safeLineCount: the whole buffer, asked once",
    build: (n) => {
      const src = realisticUnit().repeat(n);
      return () => void safeLineCount(src);
    },
    inputSize: (n) => realisticUnit().length * n,
    exactWork: (n) => realisticUnit().length * n,
    maxWorkPerChar: 1.15,
  },
];
;


/** Four real links with placeholder hrefs, for the audit entries. */
function linksPage(k: number): string {
  return Array.from({ length: k }, (_, i) => `<a href="#">Page ${i}</a>`).join("");
}
;


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
 * The same path, streamed: a different question, a different answer
 * ------------------------------------------------------------------ */

/**
 * THE WHOLE-STREAM COST IS QUADRATIC, and this test exists to say so.
 *
 * Everything above measures one render of a complete reply, and that is
 * linear: `parseMarkdown` costs 461 units per 132 characters, forever, and
 * that is the budget. This measures the other question — what a reply costs
 * to watch ARRIVE — and the answer is not linear, for a reason no single-call
 * measurement could show.
 *
 * `safeLineCount` is called once per token over the WHOLE buffer, from offset
 * zero every time. Per call that is one pass, which is why it can sit in the
 * table above as a linear entry. Across a stream of n tokens it is n passes
 * over a buffer that grows to n, so the total climbs as n-squared: measured
 * at a ratio of 4.00 and a per-character cost rising from 560 to 17,610 over
 * the ladder below. At the largest size the whole reply costs about 7.4
 * BILLION charged units to render.
 *
 * The block parser is not the culprit and never was: `stats().charsParsed`
 * is bounded per TAIL and stays linear, which is why #114's streaming work
 * landed and why nothing noticed this. The uncounted term sits next to it.
 *
 * THE FIX IS NOT IN THIS FILE. Making `safeLineCount` resumable needs the
 * fence state at the resume point, and a boundary claimed from the wrong
 * fence state is a boundary the streaming contract cannot have — so it is a
 * change to the parser, not to an instrument, and it wants its own PR.
 *
 * IF THIS TEST FAILS because the ratio dropped below the threshold, that is
 * good news: the path became linear. Replace this with a budget like the one
 * above rather than lowering the number.
 */
describe("the render path measured across a whole stream, which is not the same question", () => {
  it("is quadratic in reply length — per call it is linear, and the calls do not stop", () => {
    /** Feed a reply a token at a time and return the thunk that does it. */
    const streamOf = (n: number) => {
      const full = realisticUnit().repeat(n);
      // One parse per 24 characters, which is about what a token stream looks
      // like: the reply arrives in pieces, not in one write.
      const step = Math.max(1, Math.floor(full.length / Math.max(1, Math.floor(full.length / 24))));
      return () => {
        const parser = createStreamingMarkdownParser();
        for (let end = step; end < full.length; end += step) parser.parse(full.slice(0, end));
        parser.parse(full);
      };
    };

    // A much smaller ladder than SIZES, and deliberately: this one really does
    // the work. At n=3200 it renders a 422,000-character reply one token at a
    // time, which is the quadratic talking — it took 57 seconds here, against
    // this file's promise that it runs in milliseconds on every `npm test`. A
    // shape does not need a big ladder to show itself; four doublings is four
    // more than it takes to separate 4.0 from 2.0.
    const STREAM_SIZES = [4, 8, 16, 32, 64] as const;
    const works = STREAM_SIZES.map((n) => measureWork(streamOf(n)).work);
    const sizes = STREAM_SIZES.map((n) => realisticUnit().length * n);
    const perChar = works.map((w, i) => w / sizes[i]!);

    expect(works[0]!, "the stream charged nothing at all").toBeGreaterThan(0);

    const worst = Math.max(
      ...works.slice(1).map((w, i) => w / works[i]!),
    );
    // Quadratic is 4.00. Anything below this means the shape changed and the
    // comment above is now wrong in the good direction.
    expect(
      worst,
      `the streamed whole-reply render path grew ${worst.toFixed(2)}x per doubling ` +
        `(quadratic is 4.00). Work by size: ` +
        STREAM_SIZES.map((n, k) => `${n}:${works[k]}`).join(" ") +
        `. Per input character it now runs ` +
        perChar.map((v) => v.toFixed(0)).join(" -> ") +
        `.`,
    ).toBeGreaterThanOrEqual(3.5);

    // And the per-character cost is what makes it a cost rather than a
    // curiosity: it must be growing, not merely large.
    expect(
      perChar[perChar.length - 1]! / perChar[0]!,
      "the streamed cost per character stopped growing — if the path is now linear, replace this test" +
        + " with a budget rather than deleting the pin",
    ).toBeGreaterThan(8);
  });
});

/* ------------------------------------------------------------------ *
 * The gap, pinned
 * ------------------------------------------------------------------ */

describe("the functions counting cannot reach are named, not assumed", () => {
  // ONE function is left, and this test exists so it stays exactly one.
  // `isSummaryImitation` does its work inside one anchored regex `test()`,
  // where the characters V8 steps through are not observable from JavaScript.
  // There is no charge site that could see them without rewriting it as a
  // hand-written scan — which is what #121 did for its neighbour
  // `isEmptyFenceOutput`, and which would be worth doing here too if the
  // rewrite were wanted on its own merit rather than to satisfy an instrument.
  //
  // So it stays on the timing gate, and this assertion fails the moment anyone
  // DOES instrument it. That is deliberate: the fix is to add it to COUNTED
  // above and delete this, not to relax the assertion. A coverage gap nobody
  // checks is a coverage gap that grows.
  it("charges nothing for isSummaryImitation, so its cover is still timing", () => {
    expect(
      measureWork(() =>
        isSummaryImitation({
          hadFence: false,
          files: null,
          narrationText: "[wrote 3 file(s)] ".repeat(500),
        }),
      ).work,
    ).toBe(0);
    // Sanity on the input, so a future edit that makes this vacuous is
    // visible: the predicate really does answer true on this narration.
    expect(
      isSummaryImitation({
        hadFence: false,
        files: null,
        narrationText: "[wrote 3 file(s)] ".repeat(500),
      }),
    ).toBe(true);
  });
});
