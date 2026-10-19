#!/usr/bin/env node
/**
 * rehearsal-parity.mjs: the cross-engine pin — every PowerShell line that
 * rehearses these tools must produce the SAME output, byte for byte.
 *
 * WHY THIS EXISTS
 * ---------------
 * The `rehearsals` job in .github/workflows/ci.yml runs each rehearsal once per
 * PowerShell line (pwsh 7.4 and 7.6) — the sentinel and lifecycle rehearsals, and
 * the transport rehearsal that asks the two simulated-GitHub transports the same
 * questions — and each leg
 * asserts which engine it got. That still leaves the real question unanswered:
 * do they AGREE? They did not, and the disagreement was not a bug in a script but
 * a property of the ENGINE — ConvertFrom-Json converts an ISO instant to
 * [DateTime] on every PowerShell 7 and never did on Windows PowerShell 5.1, so
 * `since=$($watched.readsSince)` went out as a culture string, the window slid by
 * the machine's UTC offset, and the Oct 29 sentinel cleared a promotion day whose
 * record predated it. A version-blind rehearsal reports on behaviour it has never
 * seen; a version-AWARE one that never compares its legs reports on both and
 * notices nothing when they diverge.
 *
 * So each leg uploads its output and this compares them. What it compares is
 * BYTES, on purpose: the rehearsals print their verdicts, the scenarios they ran
 * and the records they composed, and "these two engines said the same thing" is
 * exactly the property nobody can maintain by reading. The two things that are not
 * a difference — a pipe's line endings, and the directory a failing run names as
 * its evidence — are normalised and named in `normalize`; a difference nobody
 * named fails the run.
 *
 * ONE INPUT IS NOT A CHECK. A single engine's output, or a suite only one leg
 * happened to upload, is reported as vacuous and FAILS: a comparison that cannot
 * fail is worse than none, because it reads like one. That is also what makes the
 * matrix load-bearing rather than decorative — if a leg is ever dropped, this
 * says so instead of comparing an engine with itself.
 *
 * AND THE BASELINE, because two legs only catch the engines DIVERGING. Both run
 * the same test on the same commit, so the ordinary change — a scenario renamed,
 * a verdict flipped, a summary count edited — moves them TOGETHER and passes a
 * cross-engine comparison by construction. scripts/rehearsal-golden/ is the other
 * half: the projected report each suite is expected to print, committed, so any
 * change to what the rehearsals observe shows up as a diff on a file somebody has
 * to read (`--write-golden` refreshes it from a real run). The two comparisons
 * have different universes on purpose — the cross-engine one compares everything
 * a leg printed, including a warning that only one engine emits, while the
 * baseline is the rehearsal's OWN report lines with the machine's directories
 * masked, which is what makes it something a repository can hold — and both have
 * to hold.
 *
 * Usage:
 *   node scripts/rehearsal-parity.mjs                  # ./engines vs scripts/rehearsal-golden
 *   node scripts/rehearsal-parity.mjs --dir <dir>
 *   node scripts/rehearsal-parity.mjs --golden <dir>
 *   node scripts/rehearsal-parity.mjs --write-golden   # refresh the committed baseline
 *
 * The directory is the layout actions/download-artifact produces for
 * `pattern: rehearsal-output-*`: one directory per engine (named after the
 * artifact, i.e. the engine version), each holding the files the legs wrote.
 * Locally, make one directory per engine yourself and run it — that is how the
 * three engines this repo can reach (pwsh 7.4, pwsh 7.6, Windows PowerShell 5.1)
 * were first compared.
 *
 * Exit: 0 when every engine agreed with every other AND with the committed
 * baseline; 1 for any engine difference, a vacuous comparison, or a baseline that
 * is missing, unchecked, or no longer matched.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

/**
 * Where the committed baseline lives: next to this script rather than under the
 * working directory, so the same command works from the repo root (CI) and from
 * anywhere a maintainer happens to be. Same shape as scripts/check-workflows.mjs.
 */
export const DEFAULT_GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "rehearsal-golden");

/** Files a leg uploads are named `rehearsal-<suite>.txt`; the suite is the name. */
const FILE_PATTERN = /^rehearsal-([a-z0-9-]+)\.txt$/;

/**
 * One engine's rehearsal output, as found on disk.
 *
 * @typedef {object} RehearsalOutput
 * @property {string} engine  the directory that held it (the artifact name's version)
 * @property {string} suite   which rehearsal it is (`sentinels`, `lifecycle`, `transports`)
 * @property {string} path
 * @property {string} text
 */

/**
 * One reason the engines are not in agreement — declared rather than left to be
 * inferred, because a consumer that has to guess the shape stops reading it.
 *
 * @typedef {object} ParityFailure
 * @property {'differs'|'vacuous'|'baseline'|'baseline-missing'|'baseline-unchecked'|'baseline-undeclared'} kind
 * @property {string} suite
 * @property {string[]} engines  one entry for a vacuous comparison or a baseline
 *   difference, two for a difference between engines, none when a suite has no
 *   committed baseline at all
 * @property {number} [line]     where the first difference is, 1-based
 * @property {string} [reference] the baseline's line, for a baseline difference
 * @property {string} [actual]    the engine's line
 */

/**
 * @typedef {object} BaselineFile
 * @property {string} suite
 * @property {string} path
 * @property {string} text
 */

/**
 * @typedef {object} ParityResult
 * @property {string[]} engines
 * @property {string[]} suites
 * @property {{suite: string, engines: string[]}[]} agreed
 * @property {{suite: string, engines: string[]}[]} baseline  engines that matched the committed baseline
 * @property {ParityFailure[]} failures
 */

/**
 * Lines that name WHERE a failing run kept its evidence, not what it decided.
 *
 * A runner's temp directory is a machine fact — the same two legs on a different
 * runner print a different path for the very same failure — so comparing it would
 * report a difference where there is no disagreement. Nothing else is normalised
 * here: adding an entry should be a deliberate act with a reason, which is why the
 * list is short, exported, and pinned by tests/rehearsal-parity.test.ts.
 */
export const EVIDENCE_PATH_LINES = ["REHEARSAL_LOGS ", "REHEARSAL_WORLDS "];

/**
 * The directory of a `fixture=<path>` value — `C:\repo\scripts\x.json` here is
 * `/home/runner/work/r/x/scripts/x.json` on the runner.
 *
 * This one exists for the BASELINE rather than for the engines, which is why it
 * was not here at first: two legs on one runner share a checkout, so the path
 * never made them disagree. A committed baseline is read on a machine nobody chose,
 * and one carrying its author's `C:\Workspace\…` could never match there. The FILE
 * NAME is kept, so which fixture a rehearsal read is still compared — only the
 * directory it lives in is declared a machine fact.
 */
export const FIXTURE_DIRECTORY = /fixture=(?:[A-Za-z]:)?[^\s]*[\\/]/g;

/**
 * One engine's output in comparable form. Exactly three things are normalised, and
 * all three are properties of the capture rather than of the engine:
 *
 *   1. line endings - a CRLF is what the PIPE emitted (Windows PowerShell re-emits
 *      a child's stdout with its own newline, `pwsh` on Linux does not), the same
 *      bytes either way. Found the hard way: the first local three-engine
 *      comparison reported a difference on the harness's own first line, and the
 *      whole disagreement was a `\r`;
 *   2. the directories a FAILING run names as its evidence (EVIDENCE_PATH_LINES);
 *   3. the directory of a `fixture=` path (FIXTURE_DIRECTORY), because the
 *      baseline is committed and read on whatever machine is checking out.
 *
 * Nothing else. Line-based rather than a blind regex over the text: a path can only
 * be dropped where it starts a line with a declared marker, so a rehearsal that
 * printed a directory in the middle of a verdict has still changed its output. The
 * third rule is the one exception and it is deliberately narrow: it rewrites the
 * directory of one named field and keeps the file name in it.
 */
export function normalize(text) {
  return String(text)
    .replace(/\r\n/g, "\n")
    .replace(FIXTURE_DIRECTORY, "fixture=")
    .split("\n")
    .map((line) => {
      const marker = EVIDENCE_PATH_LINES.find((m) => line.startsWith(m));
      return marker ? `${marker}<machine-specific directory>` : line;
    })
    .join("\n");
}

/**
 * Every rehearsal output under `dir`, as `{ engine, suite, path, text }` — the
 * engine being the directory that holds the file (the artifact name, which the
 * workflow makes the version).
 *
 * @param {string} dir
 * @returns {RehearsalOutput[]}
 */
export function collect(dir) {
  const outputs = [];
  const walk = (at) => {
    for (const entry of readdirSync(at)) {
      const full = join(at, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const match = FILE_PATTERN.exec(entry);
      if (!match) continue;
      const relativePath = relative(dir, full);
      const segments = relativePath.split(/[\\/]/);
      if (segments.length < 2) continue; // no engine directory: not an artifact
      // `rehearsal-output-7.4.20` is the artifact name the workflow chose; the
      // engine is the part a reader wants to see in a failure.
      const engine = segments[0].replace(/^rehearsal-output-/, "");
      outputs.push({ engine, suite: match[1], path: full, text: readFileSync(full, "utf8") });
    }
  };
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) walk(dir);
  return outputs.sort((a, b) => a.suite.localeCompare(b.suite) || a.engine.localeCompare(b.engine));
}

/**
 * The marker each rehearsal's own printer puts at the start of its report lines,
 * and the indentation its continuation lines (the #18 comment trail) use.
 *
 * Declared per suite rather than guessed, because `project` uses it to decide what
 * is the rehearsal's output and what merely arrived on the same pipe — npm's banner
 * (`> anybase@0.10.0 …`, which would otherwise make every version bump a baseline
 * failure) and PowerShell's warnings (`WARNING: …`, which one engine can emit and
 * another not, so a baseline carrying one would fail on the runner it is not). A
 * suite with no entry here has no declared marker: see `project`.
 *
 * tests/rehearsal-parity.test.ts pins these keys to the suites the rehearsals job
 * actually writes, so a third rehearsal has to declare its marker rather than
 * silently project to nothing.
 */
export const REPORT_MARKERS = { sentinels: "REHEARSAL", lifecycle: "LIFECYCLE", transports: "TRANSPORT" };

/** Continuation lines of a report: the comment trail, indented under its header. */
const REPORT_CONTINUATION = /^\s{2,}\S/;

/**
 * The part of a leg's output that is the REHEARSAL's report — what the committed
 * baseline holds.
 *
 * A whitelist rather than a blacklist, so the baseline is portable by
 * construction: everything the rehearsal itself prints is kept, and everything
 * else on the pipe (npm's banner, an engine's warning) is dropped instead of being
 * frozen into a file that has to match on three engines and a runner.
 *
 * A suite with NO declared marker projects to nothing, whatever it printed: what
 * counts as its report is unknown, so neither answer is safe — keeping everything
 * freezes a banner and an engine's warning into a committed file (the exact things
 * this projection exists to keep out), and comparing against nothing passes
 * vacuously. Both consumers therefore refuse instead: `--write-golden` will not
 * write an empty baseline, and the comparison reports the suite as undeclared.
 *
 * Ends with exactly one newline, which makes `project(project(x)) === project(x)`
 * for any input: the file that was written can be read back and compared as-is.
 *
 * @param {string} suite
 * @param {string} text
 * @returns {string}
 */
export function project(suite, text) {
  const marker = REPORT_MARKERS[suite];
  if (!marker) return "";
  const normalized = normalize(text);
  const kept = normalized
    .split("\n")
    .filter((line) => line.startsWith(marker) || REPORT_CONTINUATION.test(line));
  return kept.length ? `${kept.join("\n")}\n` : "";
}

/**
 * Every committed baseline under `dir`, as `{ suite, path, text }` — the same
 * `rehearsal-<suite>.txt` names, one per suite, with no engine level: a baseline is
 * the answer for all of them.
 *
 * @param {string} dir
 * @returns {BaselineFile[]}
 */
export function collectGolden(dir) {
  const found = [];
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return found;
  for (const entry of readdirSync(dir).sort()) {
    const match = FILE_PATTERN.exec(entry);
    if (!match) continue;
    const path = join(dir, entry);
    found.push({ suite: match[1], path, text: readFileSync(path, "utf8") });
  }
  return found;
}

/**
 * The first line that differs, so a failure points at a line and not at a file.
 *
 * @param {string} reference
 * @param {string} actual
 * @returns {{line: number, reference: string, actual: string} | null}
 */
export function firstDifference(reference, actual) {
  const a = normalize(reference).split("\n");
  const b = normalize(actual).split("\n");
  const lines = Math.max(a.length, b.length);
  for (let i = 0; i < lines; i += 1) {
    if (a[i] === b[i]) continue;
    return {
      line: i + 1,
      reference: a[i] ?? "<no line - the output ended>",
      actual: b[i] ?? "<no line - the output ended>",
    };
  }
  return null;
}

/**
 * Compare every suite against the committed baseline, and against the baseline
 * being there at all.
 *
 * Both directions of absence fail, because each is coverage that quietly stopped:
 * a suite that rehearsed with no baseline is a rehearsal nobody wrote down, and a
 * baseline no leg uploaded is a pin comparing nothing — the second would otherwise
 * be invisible, since a suite missing from BOTH legs produces no cross-engine
 * failure either.
 *
 * @param {RehearsalOutput[]} outputs
 * @param {BaselineFile[]} baselines
 * @returns {{failures: ParityFailure[], matched: {suite: string, engines: string[]}[]}}
 */
export function compareToBaseline(outputs, baselines) {
  const failures = [];
  const matched = [];
  const suites = [...new Set(outputs.map((o) => o.suite))].sort();
  for (const suite of suites) {
    const baseline = baselines.find((candidate) => candidate.suite === suite);
    const group = outputs.filter((o) => o.suite === suite);
    if (!REPORT_MARKERS[suite]) {
      // A leg wrote a suite nobody has declared a report grammar for. Comparing it
      // would be comparing two empty projections, i.e. passing on nothing.
      failures.push({ kind: "baseline-undeclared", suite, engines: [] });
      continue;
    }
    if (!baseline) {
      failures.push({ kind: "baseline-missing", suite, engines: [] });
      continue;
    }
    const wanted = project(suite, baseline.text);
    const ok = [];
    for (const output of group) {
      const difference = firstDifference(wanted, project(suite, output.text));
      if (difference) failures.push({ kind: "baseline", suite, engines: [output.engine], ...difference });
      else ok.push(output.engine);
    }
    if (ok.length) matched.push({ suite, engines: ok });
  }
  for (const baseline of baselines) {
    if (suites.includes(baseline.suite)) continue;
    failures.push({ kind: "baseline-unchecked", suite: baseline.suite, engines: [] });
  }
  return { failures, matched };
}

/**
 * Compare every suite across every engine that uploaded it — and, when a baseline
 * is passed, against that too.
 *
 * `baselines` is deliberately not defaulted: absent means "compare the engines"
 * (which is what a caller holding only engine output can honestly do), while an
 * empty list is a claim that no baseline exists and every suite is reported as
 * missing one.
 *
 * @param {RehearsalOutput[]} outputs
 * @param {BaselineFile[]} [baselines]
 * @returns {ParityResult}
 */
export function compare(outputs, baselines) {
  const engines = [...new Set(outputs.map((o) => o.engine))].sort();
  const suites = [...new Set(outputs.map((o) => o.suite))].sort();
  const agreed = [];
  const failures = [];
  for (const suite of suites) {
    // Sorted so the REPORT is stable too: a comparison whose reference changes
    // between runs is a comparison that says different things about the same tree.
    const group = outputs
      .filter((o) => o.suite === suite)
      .sort((a, b) => a.engine.localeCompare(b.engine, undefined, { numeric: true }));
    if (group.length < 2) {
      failures.push({
        kind: "vacuous",
        suite,
        engines: group.map((o) => o.engine),
      });
      continue;
    }
    const reference = group[0];
    for (const other of group.slice(1)) {
      const difference = firstDifference(reference.text, other.text);
      if (difference) {
        failures.push({
          kind: "differs",
          suite,
          engines: [reference.engine, other.engine],
          ...difference,
        });
      } else {
        agreed.push({ suite, engines: [reference.engine, other.engine] });
      }
    }
  }
  const baseline = baselines === undefined ? { failures: [], matched: [] } : compareToBaseline(outputs, baselines);
  return { engines, suites, agreed, baseline: baseline.matched, failures: [...failures, ...baseline.failures] };
}

/**
 * The report, in the order a reader needs it: who was compared, who agreed, and
 * every disagreement with the line it happened on.
 *
 * @param {ParityResult} result
 * @param {string} dir
 * @param {string} [goldenDir]  where the baseline was read from
 * @returns {string}
 */
export function formatReport(result, dir, goldenDir = DEFAULT_GOLDEN_DIR) {
  const lines = [`rehearsal parity — ${result.engines.length} engine(s) in ${dir}: ${result.engines.join(", ") || "none"}`];
  for (const { suite, engines } of result.agreed) {
    lines.push(`  ✓ ${suite}: ${engines.join(" and ")} agree, byte for byte`);
  }
  for (const { suite, engines } of result.baseline) {
    lines.push(`  ✓ baseline ${suite}: matched by ${engines.join(", ")}`);
  }
  for (const failure of result.failures) {
    if (failure.kind === "vacuous") {
      lines.push(
        `  ✗ ${failure.suite}: ${failure.engines.length} engine(s) uploaded this ` +
          `(${failure.engines.join(", ") || "none"}) — a comparison with one input is not a comparison`,
      );
      continue;
    }
    if (failure.kind === "baseline-undeclared") {
      lines.push(
        `  ✗ ${failure.suite}: no report marker declared for this suite — its output cannot be ` +
          `projected, so it is neither written nor compared (declare it in REPORT_MARKERS)`,
      );
      continue;
    }
    if (failure.kind === "baseline-missing") {
      lines.push(
        `  ✗ ${failure.suite}: no committed baseline at ${join(goldenDir, `rehearsal-${failure.suite}.txt`)} — ` +
          `a suite with no baseline is a rehearsal nobody wrote down (--write-golden writes one from a real run)`,
      );
      continue;
    }
    if (failure.kind === "baseline-unchecked") {
      lines.push(
        `  ✗ ${failure.suite}: the committed baseline was never compared — no engine uploaded it, ` +
          `so this pin is covering nothing`,
      );
      continue;
    }
    if (failure.kind === "baseline") {
      lines.push(
        `  ✗ ${failure.suite}: ${failure.engines[0]} no longer matches the committed baseline ` +
          `(${join(goldenDir, `rehearsal-${failure.suite}.txt`)}) at line ${failure.line}`,
      );
      lines.push(`      baseline: ${failure.reference}`);
      lines.push(`      ${failure.engines[0]}: ${failure.actual}`);
      continue;
    }
    lines.push(`  ✗ ${failure.suite}: ${failure.engines[0]} and ${failure.engines[1]} disagree at line ${failure.line}`);
    lines.push(`      ${failure.engines[0]}: ${failure.reference}`);
    lines.push(`      ${failure.engines[1]}: ${failure.actual}`);
  }
  if (result.suites.length === 0) {
    lines.push("  ✗ no rehearsal output found at all — did the rehearsals job upload anything?");
  }
  lines.push(
    result.failures.length === 0 && result.suites.length > 0
      ? "REHEARSAL_PARITY PASS — every engine that rehearsed these tools said the same thing, and it is what the repository says"
      : `REHEARSAL_PARITY FAIL — ${result.failures.length} problem(s); a rehearsal is only evidence about the engine it ran on, and only until the report it prints changes`,
  );
  return lines.join("\n");
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "usage: node scripts/rehearsal-parity.mjs [--dir <directory>] [--golden <directory>] [--write-golden]",
    );
    return 0;
  }
  const at = args.indexOf("--dir");
  const dir = at >= 0 && args[at + 1] ? args[at + 1] : join(process.cwd(), "engines");
  const goldenAt = args.indexOf("--golden");
  const goldenDir = goldenAt >= 0 && args[goldenAt + 1] ? args[goldenAt + 1] : DEFAULT_GOLDEN_DIR;
  const outputs = collect(dir);
  if (args.includes("--write-golden")) {
    if (!outputs.length) {
      console.error(`--write-golden: no rehearsal output under ${dir}, so there is nothing to write down`);
      return 1;
    }
    // Every suite is projected BEFORE anything is written: a refusal half way
    // through would leave a baseline directory that is part new and part old.
    const pending = [...new Set(outputs.map((o) => o.suite))].sort().map((suite) => {
      const from = outputs.find((o) => o.suite === suite);
      return { suite, engine: from.engine, text: project(suite, from.text) };
    });
    for (const { suite, text } of pending) {
      if (text) continue;
      console.error(
        REPORT_MARKERS[suite]
          ? `--write-golden: ${suite} produced no report lines, and a baseline of nothing is not a baseline`
          : `--write-golden: no report marker declared for ${suite}, so what its baseline is cannot be known ` +
              "(declare it in REPORT_MARKERS)",
      );
      return 1;
    }
    mkdirSync(goldenDir, { recursive: true });
    for (const { suite, engine, text } of pending) {
      const path = join(goldenDir, `rehearsal-${suite}.txt`);
      writeFileSync(path, text);
      console.log(`wrote ${path} — ${text.split("\n").length - 1} line(s) from ${engine}`);
    }
    // Falls through on purpose: a baseline that does not match the run it was
    // written from is a mistake worth catching in the same command.
  }
  const result = compare(outputs, collectGolden(goldenDir));
  console.log(formatReport(result, dir, goldenDir));
  return result.failures.length === 0 && result.suites.length > 0 ? 0 : 1;
}

if (process.argv[1] && basename(process.argv[1]) === "rehearsal-parity.mjs") {
  process.exit(main(process.argv));
}
