/**
 * The gate is only as good as its list — this test keeps the list honest.
 *
 * `tests/perf/scaling-gate.test.ts` pins a CURATED set of hot paths for
 * superlinear growth. A curated set has one failure mode that no amount of
 * measurement catches: somebody exports a new function from a hot-path module,
 * it goes on a latency path, and it is simply not in the list. Nothing fails.
 * The function is unguarded forever, and the gate keeps reporting green while
 * covering less and less of the surface it claims to cover.
 *
 * Written down in a test, that failure is loud: every exported function in the
 * modules below must either be probed by the gate, or appear in LEDGER with a
 * reason saying why it is covered some other way. Adding a hot-path function is
 * now a two-line decision in review — probe it, or say why not.
 *
 * This is the same move as the `anybase/no-markup-sanitiser-replace` lint rule
 * from #104 and the architecture guards in
 * tests/architecture-cloudflare-access.test.ts: catch at commit time what would
 * otherwise be caught much later, if at all.
 *
 * WHY IT CHECKS THE GATE'S SOURCE TEXT rather than importing the gate. The
 * gate is a timing test; importing it to ask "which functions do you probe"
 * would mean RUNNING it. Reading its source and looking for each identifier is
 * enough to answer the question, and it has a useful property: if someone
 * deletes a probe, the name stops appearing and THIS fails. A ledger that only
 * checked its own bookkeeping could be satisfied by a stale, wrong list.
 * Comment text AND import statements are stripped before matching, so neither a
 * name mentioned in prose nor a name merely imported can stand in for a probe
 * that does not exist. (The import case was not hypothetical: widening the
 * gate's import list turned this guard green with six probes missing.)
 *
 * WHY ONLY FOUR MODULES. These are the ones whose exports are all pure and
 * input-proportional — where "could this be superlinear in its argument" is a
 * real question for every single export. `template-generation.ts` and
 * `store.ts` are persistence and generation modules: mostly fs I/O and async,
 * where a growth argument does not apply, and scanning them would demand ~30
 * exemptions, which is a list nobody reads and therefore a guard nobody
 * trusts. The pure helpers those modules contribute to the parse path
 * (`sanitizeDemoFiles`, `demoLooksComplete`, `slugify`) are probed by the gate
 * anyway. A module earns its way in here by being pure, not by being big.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "src", "lib");
const GATE = path.join(process.cwd(), "tests", "perf", "scaling-gate.test.ts");

/**
 * Modules whose exports are all pure and input-proportional. See the header on
 * why the list is short.
 */
const TRACKED_MODULES = [
  "markdown.ts",
  "prompt.ts",
  "demo-link-audit.ts",
  "demo-gates.ts",
] as const;

/**
 * Why a hot-path export is NOT timing-probed.
 *
 * Three kinds of answer are legitimate here, and all three are worth writing
 * down rather than leaving implicit:
 *
 *  - COUNTED, not timed. Something deterministic already pins the work, which
 *    is a stronger claim than a timing ratio and cannot flake. The streaming
 *    markdown parser is the important case: it runs on every token of every
 *    reply and is pinned by counting characters parsed. Since #120 there is a
 *    second counting mechanism, `tests/perf-work-counters.test.ts`, which pins
 *    growth AND constant factors for six more functions — but every one of
 *    those is ALSO timing-probed by the gate, so none of them belongs in this
 *    ledger. It is a second opinion on functions already listed, not a
 *    substitute for being listed. The two counting mechanisms are not
 *    interchangeable: `stats().charsParsed` is an intrinsic part of the
 *    streaming parser's own API, while the work counter is an opt-in
 *    instrument charged at scan exits in the functions it covers.
 *  - REACHED, not probed. The function sits in the inner loop of a function
 *    the gate already probes, so a regression here moves that probe's ratio.
 *  - NOT INPUT-PROPORTIONAL. It cannot grow superlinearly in its argument, so
 *    there is nothing for a growth gate to say about it.
 *  - UNCALLED. It has no callers at all, so no growth in it can hurt anybody.
 *    That is a deletion candidate, not an endorsement — the category exists so
 *    the ledger can tell the truth about it instead of pretending it is used.
 *
 * What is NOT acceptable is an entry with no reason, and an entry naming a
 * function that no longer exists — the stale case fails below, because a ledger
 * that accumulates dead entries stops being read.
 */
const LEDGER = new Map<string, string>([
  // ---- counted elsewhere, deterministically ----
  [
    "safeLineCount",
    "COUNTED: tests/markdown-streaming.test.tsx pins its monotonicity, and tests/perf-work-counters.test.ts counts its per-call work exactly AND measures what it costs across a whole stream — which is quadratic, because it reads the whole buffer once per token. The hole was real and it was two files away from the coverage claim",
  ],
  [
    "createStreamingMarkdownParser",
    "COUNTED: tests/markdown-streaming.test.tsx pins charsParsed < length x 10 across a whole stream, plus per-tail proportionality. This is the #114 hot path and it is counted, not timed",
  ],

  // ---- reached by an existing probe, in its inner loop ----
  [
    "indexOfCloseAnchor",
    "REACHED: called per placeholder anchor inside the sanitizeDemoFiles nav probe, which is gated",
  ],
  [
    "anchorLabelAt",
    "REACHED: called per anchor inside the auditDemoLinks probes, which are gated",
  ],
  [
    "linkPageSlug",
    "REACHED: called per label inside the auditDemoLinks and sanitizeDemoFiles probes, which are gated",
  ],
  [
    "buildPageSlugIndex",
    "REACHED: called once per auditDemoLinks/sanitizeDemoFiles probe run, so a growth regression moves those ratios",
  ],
  [
    "pageForLabelIn",
    "REACHED: called per placeholder link inside the auditDemoLinks and sanitizeDemoFiles probes, which are gated",
  ],
  [
    "pageForLabel",
    "REACHED: the un-indexed wrapper of pageForLabelIn. src/ has no callers — only the test suite does — because every production path builds an index first",
  ],

  // ---- not input-proportional ----
  [
    "formatDemoLinkProblem",
    "NOT INPUT-PROPORTIONAL: renders one already-found problem; its input is a fixed-size record, not the document",
  ],
  [
    "formatDemoLinkAudit",
    "NOT INPUT-PROPORTIONAL: renders a result object whose problems array is already bounded by the audit; the scan that built it is gated",
  ],
  [
    "formatGateProblem",
    "NOT INPUT-PROPORTIONAL: renders one gate finding",
  ],
  [
    "formatGateResult",
    "NOT INPUT-PROPORTIONAL: renders a result object; the gates that produced it are gated",
  ],
]);

/** Exported `function` names — i.e. callable exports, not types or constants. */
function exportedFunctions(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  const names: string[] = [];
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
    names.push(m[1]!);
  }
  return names;
}

/**
 * Identifiers the gate actually USES.
 *
 * Comments are stripped so prose cannot stand in for a probe, and import
 * statements are stripped so an unused import cannot either. An import is a
 * statement of intent, not evidence of a probe, so only real usage counts.
 */
function gateIdentifiers(): Set<string> {
  const src = fs
    .readFileSync(GATE, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/import\s+[^;]*?from\s*["'][^"']+["'];?/g, " ")
    .replace(/import\s+type\s+[^;]*?;?$/gm, " ");
  return new Set(src.match(/[A-Za-z_$][\w$]*/g) ?? []);
}

describe("every hot-path export is either probed or accounted for", () => {
  const probed = gateIdentifiers();

  for (const mod of TRACKED_MODULES) {
    it(`${mod} has no untracked export`, () => {
      const untracked = exportedFunctions(path.join(ROOT, mod)).filter(
        (name) => !probed.has(name) && !LEDGER.has(name),
      );
      expect(
        untracked,
        untracked.length === 0
          ? ""
          : `${mod} exports ${untracked.join(", ")}, which the perf gate does not probe ` +
            `and the ledger does not explain.\n\n` +
            `Either add a probe for it in tests/perf/scaling-gate.test.ts (see the PROBES ` +
            `array — every entry needs make(), inputSize() and preferably assertLive()), ` +
            `or add an entry to LEDGER in tests/perf-tracked-surface.test.ts saying which ` +
            `of the three reasons applies: COUNTED, REACHED, or NOT INPUT-PROPORTIONAL.`,
      ).toEqual([]);
    });
  }
});

describe("the ledger does not rot", () => {
  it("names no function that has since been removed or renamed", () => {
    const real = new Set(
      TRACKED_MODULES.flatMap((mod) => exportedFunctions(path.join(ROOT, mod))),
    );
    const stale = [...LEDGER.keys()].filter((name) => !real.has(name));
    expect(
      stale,
      stale.length === 0
        ? ""
        : `LEDGER names ${stale.join(", ")}, which no longer exists. A ledger that keeps ` +
          `dead entries stops being read, so a removed function must lose its entry here too.`,
    ).toEqual([]);
  });

  it("gives every entry a reason, not just a name", () => {
    const unreasoned = [...LEDGER].filter(
      ([, reason]) =>
        reason.trim().length < 20 || !/^(COUNTED|REACHED|NOT INPUT-PROPORTIONAL|UNCALLED)/.test(reason),
    );
    expect(
      unreasoned.map(([name]) => name),
      "every ledger entry must open with COUNTED, REACHED, NOT INPUT-PROPORTIONAL or UNCALLED, then say something specific",
    ).toEqual([]);
  });
});

describe("the tracked module list itself", () => {
  it("still points at files that exist", () => {
    for (const mod of TRACKED_MODULES) {
      expect(fs.existsSync(path.join(ROOT, mod)), `${mod} is missing`).toBe(true);
    }
  });

  it("still finds exports to check — a broken scanner would pass vacuously", () => {
    // If the regex stopped matching (a refactor to `export const f = () => {}`,
    // say), every module would report zero untracked exports and this guard
    // would be a test that always passes. So it asserts the scanner works.
    for (const mod of TRACKED_MODULES) {
      expect(
        exportedFunctions(path.join(ROOT, mod)).length,
        `${mod} yielded no exports — the scanner in this file has stopped matching`,
      ).toBeGreaterThan(0);
    }
  });
});
