/**
 * THE SUPERLINEARITY GATE — fails the build when a tracked hot path's cost
 * grows faster than its input.
 *
 * This exists because the three perf bugs this repo has already fixed were all
 * the same shape and none of them announced themselves. `parseInline` re-scanned
 * the remainder of a message for every `[` (#113), the streaming parser re-parsed
 * the whole reply on every token (#114), and five HTML scanners re-tried a `<`
 * with no `>` ahead at the next bracket — one of them cubically (#115). Each was
 * invisible in review, invisible in review, and invisible to every existing
 * test, because "returns the right answer" and "returns the right answer in
 * linear time" are different properties and only the first was pinned.
 *
 * So this file pins the second property, for a curated list of hot paths, by
 * MEASURING rather than by counting. Work-counting would be the stronger claim
 * and is used in tests/scanner-scaling.test.ts where the scan frontier is
 * observable, but it needs a probe-specific instrument per function and does
 * not generalise to a whole corpus. Timing does, badly but generally — and a
 * badly-measured gate that never fails is still worth more than nothing,
 * provided it CAN fail. Which is the load-bearing design decision here:
 *
 *   THE GATE CALIBRATES ITSELF AGAINST A KNOWN-QUADRATIC PROBE.
 *
 * Every run first measures a deliberately quadratic function and a
 * deliberately linear one. If the harness cannot see ~4x growth on the former,
 * or reports ~4x on the latter, the run FAILS with a calibration error instead
 * of reporting a pass. Without that, a gate on a noisy shared CI runner
 * degrades silently into a test that always passes, and everyone assumes the
 * hot paths are still linear because the check is green. That is the exact
 * failure mode this file exists to prevent, so it is the one thing this file
 * refuses to be. A green gate here means "the harness was shown to be able to
 * detect quadratic growth, and then it did not see any."
 *
 * WHY RATIOS AND NOT ABSOLUTE MS: a GitHub runner is 2-5x slower than a laptop
 * and shares the box. An absolute "must parse in < 50ms" bound is a coin flip
 * on runner load and gets muted within a month. A RATIO between two sizes
 * measured back to back on the same runner, same process, same JIT state, is
 * largely independent of how fast the machine is. Linear work doubles the
 * input and roughly doubles the time (ratio 2.0); quadratic work quadruples it
 * (ratio 4.0). The threshold sits at 3.0: far enough above 2.0 to absorb timer
 * noise and a garbage-collection pause on a loaded runner, far enough below 4.0
 * that the actual regression being guarded cannot slip through.
 *
 * WHY BEST-OF-N AND NOT THE MEAN: the noise in a single timing sample is
 * one-sided — a GC pause, a descheduled worker, another job on the runner can
 * only ever make a sample SLOWER. So the minimum over N trials is the closest
 * estimate of the true cost, and the mean is contaminated by exactly the events
 * this gate must not be confused by. Each size is measured 3x and the fastest
 * kept.
 *
 * WHY EVERY PROBE IS PINNED FOR INPUT SIZE: the first version of this file had
 * a probe that scaled the page count AND the links-per-page, so its input grew
 * as n-squared — and a perfectly linear implementation dutifully reported a
 * ratio of 4.36 and got reported as a superlinear regression that did not
 * exist. A gate that can be broken by writing a bad probe is a gate that will
 * be broken by writing a bad probe. So each probe declares how big its input
 * is, and a pin below asserts that input itself grows at most ~2.5x per
 * doubling. Reviewers no longer have to remember this rule; the suite does.
 *
 * WHY THE PROBES ARE TRACKED HERE RATHER THAN DISCOVERED: the point of a gate
 * is a stable, reviewable list. A probe that silently stops exercising its
 * function (a regex that never matches, a gate whose corpus stops being
 * adversarial) would go quiet forever, so every probe asserts its own
 * non-vacuity — see `assertLive` below. A probe that is no longer doing work
 * fails the gate instead of passing it.
 *
 * The corpus is the set of functions that sit on a user-visible latency path or
 * a build-blocking gate: markdown parsing (rendered on every assistant reply),
 * the demo scanners and gates (run over every generated app), the anybase block
 * parser (runs on every streamed model token), and the slug helper. New hot
 * paths get added to PROBES below; that list is the tracked surface, and it is
 * meant to be read in review.
 */
import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, safeUrl } from "@/lib/markdown";
import {
  buildWorkspaceContext,
  extractFiles,
  extractPartialFiles,
  isEmptyFenceOutput,
  isSummaryImitation,
  localRefsFromHtml,
  relativePathList,
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
  type DemoAuditFile,
} from "@/lib/demo-link-audit";
import {
  fillerHits,
  missingBriefFiles,
  runDemoGates,
  selectorProblems,
  visibleText,
  type GateFile,
} from "@/lib/demo-gates";
import { demoLooksComplete, sanitizeDemoFiles } from "@/lib/template-generation";
import { slugify } from "@/lib/store";
import type { ProjectFile } from "@/lib/types";

/* ------------------------------------------------------------------ *
 * The measurement
 * ------------------------------------------------------------------ */

/**
 * Time-doubling ratio above which a probe is called superlinear.
 *
 * 2.0 is exactly linear, 4.0 is exactly quadratic. 3.0 is the geometric mean of
 * the two: a genuine regression to quadratic overshoots it by 33%, and ordinary
 * timing noise on a loaded runner undershoots linear-2.0 by well under that.
 */
const MAX_RATIO = 3;

/** Sizes each probe is measured at. Doubling, so each step's ratio is a doubling ratio. */
const SIZES = [200, 400, 800, 1600] as const;

/**
 * Rounds over the whole size ladder. Each round samples every size once, and
 * the per-size minimum is kept across rounds.
 *
 * This is the difference between a gate that works and one that gets muted, so
 * it is worth being explicit about why the obvious implementation is wrong.
 * Sampling all reps of size 200, then all of size 400, and so on — the obvious
 * loop — means a single garbage collection has an entire size's sample set to
 * land in. Taking the minimum within a size does not save you: the pause makes
 * EVERY sample at that size slow, so the minimum is still slow, and the ratio
 * for that step reads high. The first version of this gate did exactly that
 * and reported a 5.18x doubling ratio for `auditDemoLinks`, a function measured
 * elsewhere in this repo at a flat ~815 microseconds per link.
 *
 * Interleaving spreads one pause across one sample of EVERY size instead, so
 * the minimum discards it everywhere at once. Measured over repeated runs, the
 * worst reading on a known-linear probe fell from 2.66 (sequential, 5 samples)
 * to 2.24 (interleaved, 5) to 2.23 (interleaved, 9). Nine rounds is where it
 * stopped moving, so that is what ships — a gate that needs a lucky run is not
 * a gate.
 */
const ROUNDS = 9;

/**
 * Each sample runs the probe until it has done at least this much work.
 *
 * This must stay well clear of the clock's own granularity, a scheduler tick,
 * and the length of a typical GC pause. At 4ms this harness reported a 6.8x
 * doubling ratio for `parseInline` on unclosed brackets — an input measured at
 * 0.017ms/call, where the timing loop and the timer resolution are the same
 * order as the work being timed. 40ms x 9 rounds x 4 sizes is ~1.4s per probe;
 * the corpus is a few tens of seconds, which is affordable for a gate that
 * runs once per build and blocks the merge.
 */
const BUDGET_MS = 40;

/**
 * How fast a probe's own input is allowed to grow, per doubling.
 *
 * 2.5 is a deliberate margin over 2.0: the inputs here are built by repeating
 * a unit and appending digits to names, so the true ratio is 2.0 plus a little
 * decimal-widening, never more. Anything above this means the probe is scaling
 * two dimensions at once and would report a linear implementation as
 * superlinear.
 */
const MAX_INPUT_RATIO = 2.5;

/**
 * A measurement of one probe at one size: the ms/call, and the rep count that
 * produced it.
 */
type Sample = { ms: number; reps: number };

/**
 * Runs `fn` until it has consumed `budgetMs`, then returns ms per call.
 *
 * The alternative — call it once and time that — is hopeless at these sizes: a
 * single parse of a 200-char document is tens of microseconds, which is the
 * same order as clock granularity and a hundred times below a scheduler tick.
 * Timing one call measures the timer, not the code. Repeating until a real
 * budget is spent amortises both away, and the doubling below means the extra
 * cost of overshooting the budget is at most 2x — paid to buy a measurement
 * worth trusting.
 *
 * `repsHint` is the rep count that satisfied the budget last time. The search
 * doubles from 1 every time it is called, so without a hint every sample pays
 * for a fresh search — roughly 2x the budget in discarded work — and the whole
 * gate takes about three times as long as it needs to. Reusing the previous
 * count is free: the function's cost does not change between rounds, so the
 * count that filled the budget last round fills it again.
 */
function perCallMs(fn: () => void, repsHint = 0, budgetMs = BUDGET_MS): Sample {
  // Warm up first: the very first calls include JIT tiering, and a cold
  // measurement at the SMALLEST size would inflate it and make a linear
  // function look superlinear.
  for (let i = 0; i < 3; i++) fn();
  let reps = Math.max(1, repsHint);
  for (;;) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < reps; i++) fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms >= budgetMs || reps > MAX_REPS) return { ms: ms / reps, reps };
    reps *= 2;
  }
}

/**
 * Ceiling on the search, so a pathological probe cannot spin here forever.
 * Far above what any probe here needs: the fastest is ~0.02ms/call, so 40ms of
 * budget is about 2000 reps, and the slowest is bounded by SIZES.
 */
const MAX_REPS = 1 << 22;

type Measurement = {
  /** ms/call at each size, parallel to `SIZES`. */
  ms: number[];
  /** The worst time-doubling ratio between adjacent sizes. */
  worstRatio: number;
};

/** Measures one probe across the size ladder. */
function measure(make: (n: number) => () => void): Measurement {
  // Built once per size, outside every timed region: constructing a
  // 1600-anchor document is itself linear work and would otherwise be counted
  // as part of the probe's cost, adding a constant that flatters the ratio.
  // Building them ALL up front, before any timing starts, also means the
  // garbage from constructing one size cannot be collected inside another
  // size's measurement.
  const runs = SIZES.map((n) => make(n));

  // Interleaved: one sample of every size per round, keeping each size's
  // fastest reading. See ROUNDS for why the obvious ordering is wrong.
  const best = SIZES.map(() => Infinity);
  const reps = SIZES.map(() => 0);
  for (let round = 0; round < ROUNDS; round++) {
    for (let i = 0; i < runs.length; i++) {
      const sample = perCallMs(runs[i]!, reps[i]);
      reps[i] = sample.reps;
      best[i] = Math.min(best[i]!, sample.ms);
    }
  }

  let worstRatio = 0;
  for (let i = 1; i < best.length; i++) {
    worstRatio = Math.max(worstRatio, best[i]! / best[i - 1]!);
  }
  return { ms: best, worstRatio };
}

function describeMeasurement(m: Measurement): string {
  return (
    `worst time-doubling ratio ${m.worstRatio.toFixed(2)} ` +
    `(limit ${MAX_RATIO.toFixed(2)}); ms/call by size ` +
    SIZES.map((n, i) => `${n}:${m.ms[i].toFixed(4)}`).join(" ")
  );
}

/* ------------------------------------------------------------------ *
 * Probes
 * ------------------------------------------------------------------ */

type Probe = {
  /** What is being measured, for the failure message. */
  name: string;
  /**
   * Builds a probe at size n. Returns a thunk so the timed region is only the
   * work itself, never the setup.
   */
  make: (n: number) => () => void;
  /**
   * Size of the INPUT at n, in characters. Pinned below to grow at most
   * ~linearly, because a probe whose input is n-squared reports a linear
   * implementation as a 4x-per-doubling regression. This is not decoration: the
   * first draft of this file had exactly that bug and it read as a real
   * superlinear finding in `auditDemoLinks`.
   */
  inputSize: (n: number) => number;
  /**
   * Proves the probe is still doing work at `n`. Without it, a probe whose
   * regex stopped matching (or whose early-return now short-circuits) would
   * time an empty function, look beautifully linear, and guard nothing.
   * This is the pin that keeps the corpus honest.
   */
  assertLive?: (n: number) => void;
};

/** Repeats `unit` n times. The workhorse for every string-shaped probe. */
const rep = (unit: string, n: number) => unit.repeat(n);

/** A page with n well-formed links into `target`. */
function linksPage(n: number, target = "page.html"): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`<a href="${target}">Page ${i}</a>`);
  return out.join("\n");
}

/** `n` pages, each linking to the next (a ring, so no link is dead). */
function linkedPages(n: number): DemoAuditFile[] {
  const files: DemoAuditFile[] = [];
  for (let i = 0; i < n; i++) {
    files.push({ path: `p${i}.html`, content: linksPage(1, `p${(i + 1) % n}.html`) });
  }
  return files;
}

const PROBES: Probe[] = [
  /* ---- markdown: rendered on every assistant reply ---- */
  {
    name: "markdown / parseMarkdown: a realistic long reply",
    make: (n) => {
      const unit = [
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
      const src = rep(unit, n);
      return () => void parseMarkdown(src);
    },
    inputSize: (n) => rep("x", 1).length * 0 + n * 135,
    assertLive: (n) => {
      expect(parseMarkdown(rep("para\n\n", n))).toHaveLength(n);
    },
  },
  {
    // The exact input from #113, where the old closer scan was 592ms at 76800
    // chars. Every `[` with no `]` after it used to cost a full pass of the
    // remainder, so this was the quadratic shape the fix removed.
    name: "markdown / parseInline: unclosed brackets (the #113 shape)",
    make: (n) => {
      const src = rep("[a", n);
      return () => void parseInline(src);
    },
    inputSize: (n) => 2 * n,
    assertLive: (n) => {
      // With no `]` anywhere the whole run is ONE text node — the point is
      // that it is still scanned end to end, not that it produces n nodes.
      const src = rep("[a", n);
      const out = parseInline(src);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ kind: "text", value: src });
    },
  },
  {
    name: "markdown / parseInline: many complete links",
    make: (n) => {
      const src = rep("[label](https://example.com/target) ", n);
      return () => void parseInline(src);
    },
    inputSize: (n) => 39 * n,
    assertLive: (n) => {
      // A link node plus the trailing-space text node, per repetition.
      const out = parseInline(rep("[label](https://example.com/target) ", n));
      expect(out).toHaveLength(2 * n);
      expect(out.filter((node) => node.kind === "link")).toHaveLength(n);
    },
  },
  {
    name: "markdown / safeUrl: long URL with a scheme",
    make: (n) => {
      const url = "https://example.com/" + rep("p", n * 8);
      return () => void safeUrl(url);
    },
    inputSize: (n) => 20 + 8 * n,
    assertLive: () => {
      expect(safeUrl("https://example.com/x")).toBe("https://example.com/x");
    },
  },

  /* ---- demo link audit: runs over every generated app ---- */
  {
    name: "link-audit / auditDemoLinks: many links on one page",
    make: (n) => {
      const files: DemoAuditFile[] = [
        { path: "index.html", content: linksPage(n) },
        { path: "page.html", content: "<p>target</p>" },
      ];
      return () => void auditDemoLinks(files);
    },
    inputSize: (n) => linksPage(n).length + 32,
    assertLive: (n) => {
      const a = auditDemoLinks([
        { path: "index.html", content: linksPage(n) },
        { path: "page.html", content: "<p>t</p>" },
      ]);
      expect(a.checked).toBe(n);
    },
  },
  {
    // n PAGES, one link each. The per-file page-slug rebuild this replaced was
    // O(files x pages) and measured at 4x per doubling (#115), so it is exactly
    // this shape — pages growing, links-per-page pinned at one — that would
    // catch its return. Scaling the link count too would have made the INPUT
    // quadratic and masked it.
    name: "link-audit / auditDemoLinks: many pages x many links (the #115 shape)",
    make: (n) => {
      const files = linkedPages(n);
      return () => void auditDemoLinks(files);
    },
    inputSize: (n) => linkedPages(n).reduce((sum, f) => sum + f.content.length + f.path.length, 0),
    assertLive: (n) => {
      const a = auditDemoLinks(linkedPages(n));
      expect(a.checked).toBe(n);
      // And the ring resolves: a real audit finding nothing means the probe
      // stopped doing the label/page work we care about.
      expect(a.dead).toHaveLength(0);
    },
  },
  {
    // Unterminated tags are the case that made the old `/<[^>]*>/g` quadratic
    // and BROKEN_TAG_RE cubic: 730ms for 800 of these (#115).
    //
    // The unterminated tail is preceded by four REAL links on purpose. A page
    // of nothing but `<a href="x"` finds no complete tag at all, so the audit
    // does almost no work and the probe times a near no-op — the first version
    // of this probe did exactly that and its liveness pin caught it. With real
    // links up front the audit has genuine per-anchor work AND still walks the
    // adversarial tail, which is the combination worth timing.
    name: "link-audit / auditDemoLinks: real links then unterminated tags (the #115 shape)",
    make: (n) => {
      const files: DemoAuditFile[] = [
        { path: "index.html", content: linksPage(4) + rep('<a href="x"', n) },
        { path: "page.html", content: "<p>t</p>" },
      ];
      return () => void auditDemoLinks(files);
    },
    inputSize: (n) => 4 * 28 + 11 * n + 32,
    assertLive: (n) => {
      const a = auditDemoLinks([
        { path: "index.html", content: linksPage(4) + rep('<a href="x"', n) },
        { path: "page.html", content: "<p>t</p>" },
      ]);
      // The four real links are still found — the fix stopped the scan RETRYING
      // at each bracket, it did not stop it scanning.
      expect(a.checked).toBe(4);
    },
  },
  {
    name: "link-audit / forEachTag: well-formed tags",
    make: (n) => {
      const html = rep('<a href="x">y</a>', n);
      return () => {
        let seen = 0;
        forEachTag(html, () => {
          seen++;
        });
      };
    },
    inputSize: (n) => 18 * n,
    assertLive: (n) => {
      // One match per unit: the scan is for opening tags, and `</a>` is not
      // one (that is what forEachTagRun is for).
      let seen = 0;
      forEachTag(rep('<a href="x">y</a>', n), () => {
        seen++;
      });
      expect(seen).toBe(n);
    },
  },
  {
    // The #115 shape with a `>` present: n terminated runs followed by one
    // unterminated `<`. The old regex retried at the final `<` once per
    // character to its right; the fix ends the scan. Kept WITH a terminator so
    // there is real per-tag work to do — the pure `"<div".repeat(n)` version
    // short-circuits on the first bracket and would time a no-op.
    name: "link-audit / forEachTagRun: terminated runs then an unterminated tag",
    make: (n) => {
      const html = rep("<div>", n) + "<div";
      return () => {
        let seen = 0;
        forEachTagRun(html, () => {
          seen++;
        });
      };
    },
    inputSize: (n) => 5 * n + 4,
    assertLive: (n) => {
      let seen = 0;
      forEachTagRun(rep("<div>", n) + "<div", () => {
        seen++;
      });
      // n terminated runs are visited; the trailing unterminated one ends the
      // scan instead of being retried. That is the whole fix.
      expect(seen).toBe(n);
    },
  },
  {
    name: "link-audit / textBetween: many anchors",
    make: (n) => {
      const html = rep('<a href="x">label</a> ', n);
      return () => void textBetween(html, 0, html.length);
    },
    inputSize: (n) => 22 * n,
    assertLive: (n) => {
      // One word per anchor, all of it surviving the tag strip.
      const html = rep("<a>label</a> ", n);
      expect(textBetween(html, 0, html.length).split(" ")).toHaveLength(n);
    },
  },

  /* ---- demo gates: run over every generated app, block the build ---- */
  {
    name: "gates / visibleText: many tags",
    make: (n) => {
      const html = rep("<p>hello world</p>", n);
      return () => void visibleText(html);
    },
    inputSize: (n) => 21 * n,
    assertLive: (n) => {
      // Two words per unit, joined by single spaces.
      expect(visibleText(rep("<p>hello world</p>", n)).split(" ")).toHaveLength(2 * n);
    },
  },
  {
    // `"<div".repeat(n)` has no `>` at all, so the scan ends on the first
    // bracket and this measures a bounded prefix rather than the whole input.
    // That IS the #115 fix, but as a timing probe it would look flat for the
    // uninteresting reason, so the input carries terminated tags too.
    name: "gates / visibleText: tags then an unterminated one (the #115 shape)",
    make: (n) => {
      const html = rep("<p>hello world</p>", n) + "<div";
      return () => void visibleText(html);
    },
    inputSize: (n) => 21 * n + 4,
    assertLive: (n) => {
      // 2 words per terminated paragraph, plus the trailing `<div` — which
      // survives as literal text precisely because it has no `>` to scan to.
      // That is the fixed behaviour, so it is pinned here rather than left to
      // look like a bug later.
      const words = visibleText(rep("<p>hello world</p>", n) + "<div").split(" ");
      expect(words).toHaveLength(2 * n + 1);
      expect(words[words.length - 1]).toBe("<div");
    },
  },
  {
    name: "gates / fillerHits: many files with filler copy",
    make: (n) => {
      const files: GateFile[] = [];
      for (let i = 0; i < n; i++) {
        files.push({ path: `p${i}.html`, content: "<p>Feature 1 and Project 2</p>" });
      }
      return () => void fillerHits(files);
    },
    inputSize: (n) => n * 38,
    assertLive: (n) => {
      const files: GateFile[] = [];
      for (let i = 0; i < n; i++) {
        files.push({ path: `p${i}.html`, content: "<p>Feature 1 and Project 2</p>" });
      }
      expect(fillerHits(files)).toEqual(["Feature 1", "Project 2"]);
    },
  },
  {
    // The gate that produced the `saas` finding: one app.js linked from every
    // page, selected against every page. Cost is pages x selectors, so this is
    // the probe that would catch the per-page index being dropped.
    //
    // The selector is deliberately UNGUARDED. `isGuarded` looks 400 chars
    // ahead for a null check, and the natural `if (el) { ... }` makes this
    // report nothing — a version of this probe with a guard in it times the
    // guard scan and guards nothing.
    name: "gates / selectorProblems: many pages sharing one script",
    make: (n) => {
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
    assertLive: (n) => {
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
      // One problem per page: each page lacks #absent.
      expect(selectorProblems(files)).toHaveLength(n);
    },
  },
  {
    name: "gates / runDemoGates: full gate run over many pages",
    make: (n) => {
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
    assertLive: (n) => {
      const r = runDemoGates("p0.html", [
        { path: "p0.html", content: "<body><p>Feature 1</p></body>" },
      ]);
      // Not ok: the brief names p0.html (emitted) but the filler gate fires.
      expect(r.problems.length).toBeGreaterThan(0);
    },
  },
  {
    name: "gates / missingBriefFiles: a brief naming many files",
    make: (n) => {
      const names: string[] = [];
      for (let i = 0; i < n; i++) names.push(`mod${i}.js`);
      const brief = names.join(" ");
      return () => void missingBriefFiles(brief, []);
    },
    inputSize: (n) => n * 9,
    assertLive: (n) => {
      const names: string[] = [];
      for (let i = 0; i < n; i++) names.push(`mod${i}.js`);
      expect(missingBriefFiles(names.join(" "), [])).toHaveLength(n);
    },
  },

  /* ---- the sanitiser: highest behaviour risk in the repo ---- */
  {
    name: "sanitiser / sanitizeDemoFiles: well-formed page",
    make: (n) => {
      const files: ProjectFile[] = [
        { path: "index.html", content: rep("<p>hello</p>", n) },
      ];
      return () => void sanitizeDemoFiles(files);
    },
    inputSize: (n) => 12 * n + 12,
    assertLive: (n) => {
      const out = sanitizeDemoFiles([{ path: "index.html", content: rep("<p>hello</p>", n) }]);
      expect(out[0].content).toContain("<p>hello</p>");
    },
  },
  {
    // The 730ms cubic case: unterminated anchors. This one is genuinely a
    // no-op-shaped probe (no `>` to find), so its liveness assertion checks the
    // fixed point SETTLED rather than that output changed.
    name: "sanitiser / sanitizeDemoFiles: unterminated anchors (the #115 shape)",
    make: (n) => {
      const files: ProjectFile[] = [
        { path: "index.html", content: rep('<a href="x"', n) },
      ];
      return () => void sanitizeDemoFiles(files);
    },
    inputSize: (n) => 11 * n + 12,
    assertLive: (n) => {
      // Sanitising twice must equal sanitising once — the fixed-point loop
      // terminates, which is the property the 730ms case violated.
      const files: ProjectFile[] = [{ path: "index.html", content: rep('<a href="x"', n) }];
      const once = sanitizeDemoFiles(files);
      const twice = sanitizeDemoFiles(once);
      expect(twice[0].content).toBe(once[0].content);
    },
  },
  {
    name: "sanitiser / sanitizeDemoFiles: broken refs to neutralise",
    make: (n) => {
      const content = rep('<img src="pic.png" alt="x">', n);
      const files: ProjectFile[] = [{ path: "index.html", content }];
      return () => void sanitizeDemoFiles(files);
    },
    inputSize: (n) => 28 * n + 12,
    assertLive: (n) => {
      const out = sanitizeDemoFiles([
        { path: "index.html", content: rep('<img src="pic.png" alt="x">', n) },
      ]);
      // The ref is dropped — pic.png was never emitted, so the whole tag goes.
      expect(out[0].content).not.toContain("pic.png");
    },
  },
  {
    // Placeholder nav: n pages whose `href="#"` labels name real pages. This is
    // the relink path, and the O(files x pages) shape #115 removed. The label
    // must actually SLUG to the page stem ("Page 0" -> "page-0") or relink
    // never fires and the probe times a walk that does nothing.
    name: "sanitiser / sanitizeDemoFiles: placeholder nav across many pages",
    make: (n) => {
      const files: ProjectFile[] = [];
      for (let i = 0; i < n; i++) {
        files.push({ path: "index.html", content: `<a href="#">Page ${i}</a>` });
        files.push({ path: `page-${i}.html`, content: "<body><p>page</p></body>" });
      }
      return () => void sanitizeDemoFiles(files);
    },
    inputSize: (n) => n * 48,
    assertLive: (n) => {
      const files: ProjectFile[] = [];
      for (let i = 0; i < n; i++) {
        files.push({ path: "index.html", content: `<a href="#">Page ${i}</a>` });
        files.push({ path: `page-${i}.html`, content: "<body><p>page</p></body>" });
      }
      const out = sanitizeDemoFiles(files);
      // The placeholder was rewired to a page that really was emitted.
      expect(out[0].content).toContain("page-0.html");
      expect(out[0].content).not.toContain('href="#"');
    },
  },
  {
    name: "sanitiser / demoLooksComplete: many files",
    make: (n) => {
      const files: ProjectFile[] = [];
      for (let i = 0; i < n; i++) {
        files.push({ path: `p${i}.html`, content: "<body><p>x</p></body>" });
      }
      files.push({ path: "style.css", content: "body{}" });
      return () => void demoLooksComplete(files);
    },
    inputSize: (n) => n * 31 + 22,
    assertLive: (n) => {
      // Styled via the CSS file, not a <style> block.
      expect(
        demoLooksComplete([
          ...Array.from({ length: n }, (_, i) => ({
            path: `p${i}.html`,
            content: "<body><p>x</p></body>",
          })),
          { path: "s.css", content: "body{}" },
        ]),
      ).toBe(true);
      // And the negative case still returns false — otherwise the `some()`
      // short-circuits and the loop above never runs.
      expect(demoLooksComplete([{ path: "a.html", content: "<body><p>x</p></body>" }])).toBe(false);
    },
  },

  /* ---- the anybase block parser: runs on every streamed token ---- */
  {
    name: "prompt / extractFiles: many files in one block",
    make: (n) => {
      let body = "";
      for (let i = 0; i < n; i++) body += `=== f${i}.html ===\n<p>body ${i}</p>\n`;
      const text = "```anybase\n" + body + "```";
      return () => void extractFiles(text);
    },
    inputSize: (n) => n * 30,
    assertLive: (n) => {
      let body = "";
      for (let i = 0; i < n; i++) body += `=== f${i}.html ===\n<p>body ${i}</p>\n`;
      const out = extractFiles("```anybase\n" + body + "```");
      expect(out).toHaveLength(n);
      expect(out?.[0].content).toContain("body 0");
    },
  },
  {
    name: "prompt / extractPartialFiles: streaming a block with no closing fence",
    make: (n) => {
      let body = "";
      for (let i = 0; i < n; i++) body += `=== f${i}.html ===\n<p>body ${i}</p>\n`;
      const text = "```anybase\n" + body;
      return () => void extractPartialFiles(text);
    },
    inputSize: (n) => n * 30,
    assertLive: (n) => {
      let body = "";
      for (let i = 0; i < n; i++) body += `=== f${i}.html ===\n<p>body ${i}</p>\n`;
      // The last section is withheld (it can still grow); the rest are final.
      const out = extractPartialFiles("```anybase\n" + body);
      expect(out).toHaveLength(n - 1);
    },
  },
  {
    name: "prompt / stripCodeBlocks: many blocks in a reply",
    make: (n) => {
      const text = rep("prose\n```anybase\n<p>x</p>\n```\nmore prose\n", n);
      return () => void stripCodeBlocks(text);
    },
    inputSize: (n) => 36 * n,
    assertLive: (n) => {
      expect(stripCodeBlocks(rep("prose\n```anybase\n<p>x</p>\n```\n", n))).not.toContain("anybase");
    },
  },
  {
    name: "prompt / localRefsFromHtml: many local refs",
    make: (n) => {
      const html = rep('<link href="s.css"><script src="a.js"></script>', n);
      return () => void localRefsFromHtml(html);
    },
    inputSize: (n) => 48 * n,
    assertLive: (n) => {
      // De-duplicated, so two refs survive n repetitions — the Set is working,
      // and a regex that stopped matching would return [].
      expect(localRefsFromHtml(rep('<link href="s.css"><script src="a.js"></script>', n))).toEqual([
        "s.css",
        "a.js",
      ]);
    },
  },
  {
    // Content is kept SHORT on purpose: buildWorkspaceContext has a 60k total
    // budget and stops early once it is spent, so long files would make the
    // top of the ladder cheaper-per-link and flatter the ratio.
    name: "prompt / buildWorkspaceContext: many files",
    make: (n) => {
      const files: ProjectFile[] = [];
      for (let i = 0; i < n; i++) {
        files.push({ path: `f${i}.html`, content: "<p>c</p>" });
      }
      return () => void buildWorkspaceContext(files);
    },
    inputSize: (n) => n * 25,
    assertLive: (n) => {
      const files: ProjectFile[] = [];
      for (let i = 0; i < n; i++) {
        files.push({ path: `f${i}.html`, content: "<p>c</p>" });
      }
      const out = buildWorkspaceContext(files);
      expect(out).toContain("f0.html");
      expect(out).toContain(`f${n - 1}.html`);
    },
  },

  /* ---- the per-turn predicates: one regex over the reply, per generation ---- */
  {
    // These run once per generation turn, not per token, so they are not on the
    // streaming hot path — but each is a regex over the whole narration, which
    // is exactly the shape that goes quadratic when a pattern backtracks.
    name: "prompt / isEmptyFenceOutput: narration full of fence markers",
    make: (n) => {
      const narration = rep("```\n", n);
      return () => void isEmptyFenceOutput(narration);
    },
    inputSize: (n) => 4 * n,
    assertLive: (n) => {
      // Every marker, nothing else: the whole thing is whitespace, so the
      // empty-fence answer is true however many markers there are.
      expect(isEmptyFenceOutput(rep("```\n", n))).toBe(true);
      // And the negative still works — otherwise the `true` above proves nothing.
      expect(isEmptyFenceOutput("```anybase\nreal content\n```")).toBe(false);
    },
  },
  {
    // The narration is all fence markers and nothing else, which is the shape
    // that makes the empty-fence scan the DECIDING branch: with no files, no
    // fence and no error, `isEmptyFenceOutput` is the only thing that can
    // answer true. Narration without a marker would short-circuit to false
    // before the scan mattered, and the probe would time almost nothing —
    // which is exactly how the first version of this probe was wrong.
    name: "prompt / shouldOfferContinue: a long narration that is all fence markers",
    make: (n) => {
      const narrationText = rep("```\n", n);
      const attempt = { hadFence: false, files: null, error: null, narrationText };
      return () => void shouldOfferContinue(attempt);
    },
    inputSize: (n) => 4 * n,
    assertLive: () => {
      // All markers, nothing else: true, and only via the empty-fence scan.
      expect(
        shouldOfferContinue({
          hadFence: false,
          files: null,
          error: null,
          narrationText: rep("```\n", 20),
        }),
      ).toBe(true);
      // Real prose after the markers leaves content, so the answer is false.
      expect(
        shouldOfferContinue({
          hadFence: false,
          files: null,
          error: null,
          narrationText: "```anybase\nreal content\n```",
        }),
      ).toBe(false);
      // Files present short-circuits it — the common case, and the reason the
      // hot path usually never reaches the scan at all.
      expect(
        shouldOfferContinue({
          hadFence: true,
          files: [{ path: "a.html" }],
          error: null,
          narrationText: rep("```\n", 20),
        }),
      ).toBe(false);
    },
  },
  {
    name: "prompt / isSummaryImitation: narration full of imitation notes",
    make: (n) => {
      const narrationText = rep("[wrote 3 file(s)] ", n);
      const attempt = { hadFence: false, files: null, narrationText };
      return () => void isSummaryImitation(attempt);
    },
    inputSize: (n) => 17 * n,
    assertLive: (n) => {
      const narrationText = rep("[wrote 3 file(s)] ", n);
      expect(isSummaryImitation({ hadFence: false, files: null, narrationText })).toBe(true);
      // A real fence means the degenerate retry already covers it.
      expect(isSummaryImitation({ hadFence: true, files: null, narrationText })).toBe(false);
    },
  },
  {
    name: "prompt / relativePathList: the workspace listing sent to the model",
    make: (n) => {
      const files: ProjectFile[] = [];
      for (let i = 0; i < n; i++) {
        files.push({ path: `dir${i}/file${i}.html`, content: "x" });
      }
      return () => void relativePathList(files);
    },
    inputSize: (n) => n * 30,
    assertLive: (n) => {
      const files: ProjectFile[] = [];
      for (let i = 0; i < n; i++) {
        files.push({ path: `dir${i}/file${i}.html`, content: "x" });
      }
      const out = relativePathList(files);
      // One line per file, with the real byte count reported.
      expect(out.split("\n")).toHaveLength(n);
      expect(out).toContain("dir0/file0.html (1 bytes)");
    },
  },

  /* ---- demo nav: a second entry point over the same audit ---- */
  {
    // `demoNavIsWired` is what scripts/demo-link-audit.mjs actually calls, so
    // it is an entry point in its own right rather than something the
    // auditDemoLinks probes reach — hence a probe of its own.
    name: "link-audit / demoNavIsWired: many pages of nav to one target",
    make: (n) => {
      const files: DemoAuditFile[] = [];
      for (let i = 0; i < n; i++) {
        files.push({ path: "index.html", content: linksPage(1, "page.html") });
        files.push({ path: "page.html", content: "<p>t</p>" });
      }
      return () => void demoNavIsWired(files);
    },
    inputSize: (n) => n * 90,
    assertLive: () => {
      // Both answers proven, because a probe that can only ever return true
      // guards nothing.
      expect(
        demoNavIsWired([
          { path: "index.html", content: linksPage(1, "page.html") },
          { path: "page.html", content: "<p>t</p>" },
        ]),
      ).toBe(true);
      expect(
        demoNavIsWired([
          { path: "index.html", content: '<a href="#">Page</a>' },
          { path: "page.html", content: "<p>t</p>" },
        ]),
      ).toBe(false);
    },
  },
  {
    // Called once per link by the audit and by the sanitiser. A path with many
    // segments exercises the `..`/`.` handling instead of short-circuiting on a
    // bare filename.
    name: "link-audit / resolveDemoPath: a deeply segmented target",
    make: (n) => {
      const rawPath = Array.from({ length: n }, (_, i) => `seg${i}`).join("/") + "/page.html";
      return () => void resolveDemoPath("a/b/c/index.html", rawPath);
    },
    inputSize: (n) => n * 7 + 20,
    assertLive: (n) => {
      const rawPath = Array.from({ length: n }, (_, i) => `seg${i}`).join("/") + "/page.html";
      const expected = ["a", "b", "c", ...Array.from({ length: n }, (_, i) => `seg${i}`), "page.html"];
      expect(resolveDemoPath("a/b/c/index.html", rawPath)).toBe(expected.join("/"));
      // `..` pops, a rooted path ignores the base, and nothing means index.html
      // — the three shapes that make this a resolver and not a string concat.
      expect(resolveDemoPath("a/b/index.html", "../c.html")).toBe("a/c.html");
      expect(resolveDemoPath("a/b/index.html", "/rooted.html")).toBe("rooted.html");
      expect(resolveDemoPath("index.html", "")).toBe("index.html");
    },
  },

  /* ---- misc hot helpers ---- */
  {
    name: "store / slugify: long name",
    make: (n) => {
      const name = rep("Some Very Long Project Name ", n);
      return () => void slugify(name);
    },
    inputSize: (n) => 29 * n,
    assertLive: (n) => {
      expect(slugify("My Great App")).toBe("my-great-app");
      // The RESULT is capped at 48 chars, but the scan over the input is not,
      // and that scan is what this probe times.
      expect(slugify(rep("x", n * 30)).length).toBeLessThanOrEqual(48);
    },
  },
];

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

describe("the scaling gate can tell quadratic from linear", () => {
  // These two are the gate's own teeth. If either fails, every other assertion
  // in this file is untrustworthy, so they are the first thing that runs and
  // they name themselves as a calibration failure rather than a perf
  // regression. A CI box too slow or too noisy to resolve a 2x-vs-4x difference
  // is a legitimate thing to report; silently passing would not be.
  it("detects a deliberately quadratic function", () => {
    // The canonical quadratic: n^2 work. Deliberately not one of the repo's
    // functions, so it cannot be "accidentally" linear.
    //
    // Measured on a smaller ladder than the real probes. This one does n^2
    // work, so at the top size it is ~2.5M inner iterations per call and it
    // dominates the gate's wall clock for no benefit: its job is to prove the
    // harness can SEE a 4x, which needs a clear signal, not a long one. 8
    // reads ~2.5x per doubling from n=2, so it lands about 1000x below the
    // cost of the real corpus.
    const LADDER = [8, 16, 32, 64, 128] as const;
    const samples = LADDER.map(() => Infinity);
    const reps = LADDER.map(() => 0);
    const runs = LADDER.map((n) => () => {
      let acc = 0;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) acc += i ^ j;
      }
      return acc;
    });
    for (let round = 0; round < ROUNDS; round++) {
      for (let i = 0; i < runs.length; i++) {
        const sample = perCallMs(runs[i]!, reps[i]);
        reps[i] = sample.reps;
        samples[i] = Math.min(samples[i]!, sample.ms);
      }
    }
    let worst = 0;
    for (let i = 1; i < samples.length; i++) {
      worst = Math.max(worst, samples[i]! / samples[i - 1]!);
    }
    expect(
      worst,
      `calibration: the harness must see ~4x per doubling on a quadratic function. ` +
        `worst ${worst.toFixed(2)}; ms/call by size ` +
        LADDER.map((n, i) => `${n}:${samples[i]!.toFixed(4)}`).join(" "),
    ).toBeGreaterThan(MAX_RATIO);
  });

  it("does not flag a deliberately linear function", () => {
    // The other half of the calibration: a gate that flags everything is just
    // as useless as one that flags nothing.
    const m = measure((n) => {
      const src = rep("a", n);
      const run = () => {
        let acc = 0;
        for (let i = 0; i < src.length; i++) acc += src.charCodeAt(i);
        return acc;
      };
      return run;
    });
    expect(
      m.worstRatio,
      `calibration: the harness must NOT flag a linear function. ${describeMeasurement(m)}`,
    ).toBeLessThanOrEqual(MAX_RATIO);
  });
});

describe("no tracked hot path grows superlinearly with its input", () => {
  // One `it` per probe, not one aggregate assertion, so a regression names the
  // function that caused it instead of dumping the whole corpus.
  for (const probe of PROBES) {
    it(probe.name, () => {
      const m = measure(probe.make);
      expect(m.worstRatio, describeMeasurement(m)).toBeLessThanOrEqual(MAX_RATIO);
    });
  }
});

describe("every probe's input grows only linearly", () => {
  // The pin that stops a badly-written probe from reading as a regression.
  // This is not hypothetical: see the header.
  for (const probe of PROBES) {
    it(probe.name, () => {
      const sizes = SIZES.map((n) => probe.inputSize(n));
      for (let i = 1; i < sizes.length; i++) {
        expect(
          sizes[i] / sizes[i - 1],
          `input grew ${(sizes[i] / sizes[i - 1]).toFixed(2)}x between size ${SIZES[i - 1]} and ${SIZES[i]} ` +
            `(${sizes[i - 1]} -> ${sizes[i]} chars); a probe that scales two dimensions at once makes a linear ` +
            `implementation look like a 4x regression`,
        ).toBeLessThanOrEqual(MAX_INPUT_RATIO);
      }
    });
  }
});

describe("every probe still exercises its function", () => {
  // The anti-rot pin. A probe that stops matching stops guarding, and would do
  // so silently — it would just get faster. These fail loudly instead.
  for (const probe of PROBES) {
    if (!probe.assertLive) continue;
    it(probe.name, () => {
      for (const n of [1, 3, 25]) probe.assertLive!(n);
    });
  }
});
