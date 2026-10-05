#!/usr/bin/env node
/**
 * Workflow contract check — the gate for a class CI does not otherwise cover.
 *
 * Every other gate in this repo inspects CODE. Nothing inspects the workflow
 * files themselves, so all nine CI legs can be green while a workflow file is
 * invalid. That is not hypothetical: oct3-verify.yml and oct28-verify.yml
 * carried three comments glued to a quoted cron (`'17 19 3 10 *'# note`) with
 * no separating space, since PR #58. GitHub's parser tolerates them — the
 * crons still fire — so the defect is invisible until a stricter reader, a
 * reformat, or a future parser change turns it into a hard failure at the
 * worst possible moment. Three comments, one space each, and nothing noticed
 * for weeks: the definition of a green run that is not a verdict.
 *
 * Three checks, all on the PARSED document rather than the text:
 *
 *   1. PARSE   — strict YAML with unique keys. Catches malformed structure,
 *                duplicate keys, and comments glued to a value (MISSING_CHAR).
 *   2. CRON    — every `on.schedule[].cron` is five fields, each in range.
 *                GitHub SILENTLY ignores a malformed cron: no error, no run,
 *                no notification. A typo'd cron is a scheduled job that
 *                simply does not exist, which is the same class of silent
 *                death as the missing `issues: write` in #129.
 *   3. PERMS   — a workflow that posts an issue comment must be able to.
 *                Resolved from the parsed tree (workflow-level `permissions`,
 *                or a job-level override), so a permission granted anywhere
 *                that actually applies counts. A missing grant is the exact
 *                403 that lost the Oct 3 verdict.
 *
 * Parsed, not regexed, on purpose: tests/heartbeat-schedule-grace.test.ts
 * already greps the raw text for the `issues: write` case. That grep cannot
 * tell a top-level grant from a comment mentioning one, nor resolve a
 * job-level override, so it answers a weaker question. This answers the
 * question GitHub actually asks at run time.
 *
 * Usage:
 *   npm run check:workflows
 *   node scripts/check-workflows.mjs [--dir .github/workflows] [--json]
 *
 * Exit: 0 = every workflow parses and holds its contract, 1 = a violation.
 * Findings are reported per file and line so the fix is obvious; a malformed
 * file does not stop the remaining files from being checked, because a gate
 * that reports only the first problem is a gate that needs N round trips.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");
export const DEFAULT_DIR = path.join(REPO_ROOT, ".github", "workflows");

/**
 * One finding. `where` locates it inside the file (a cron index, a job name)
 * and `line` inside the text; either may be absent when a check cannot say.
 */
/**
 * Build a finding. Typed rather than inlined at each call site so the shape
 * (and therefore what a caller may read off a finding) is stated once.
 *
 * @param {string} check
 * @param {string} message
 * @param {{ where?: string, line?: number, file?: string }} [extra]
 * @returns {Finding}
 */
export function finding(check, message, extra = {}) {
  return { check, message, ...extra };
}

/** API path whose use implies a need to write to issues. */
const ISSUE_COMMENT_PATH = /issues\/\d+\/comments/;
/** Per-field bounds for a 5-field cron: minute hour dom month dow. */
const CRON_FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

/**
 * Parse one workflow's text. Returns the document plus a list of problems
 * rather than throwing: a caller auditing a directory wants every file's
 * verdict, not the first exception.
 */
/**
 * @typedef {{ check: string, message: string, where?: string, line?: number,
 *   file?: string }} Finding
 */

/**
 * Parse `text` as a workflow. `js` is null only when the tree is unreadable.
 *
 * @param {string} text
 * @returns {{ doc: unknown, problems: Finding[], js: Record<string, any> | null }}
 */
export function parseWorkflow(text) {
  const doc = YAML.parseDocument(text, {
    prettyErrors: true,
    uniqueKeys: true,
    strict: true,
  });
  const problems = doc.errors.map((err) =>
    finding("parse", `${err.code ? `${err.code}: ` : ""}${firstLine(err.message)}`, {
      ...(err.linePos?.[0]?.line ? { line: err.linePos[0].line } : {}),
    }),
  );
  // Most parse errors are RECOVERABLE and still yield a usable tree — a
  // glued comment (MISSING_CHAR) parses fine and keeps every cron, which is
  // exactly the defect this gate exists for. So the tree is kept whenever
  // toJS() succeeds, and the remaining checks still run: one file with three
  // defects should report three findings, not one and four round trips.
  // Only a genuinely broken document (an unresolved alias, say) withholds it.
  let js = null;
  try {
    const value = doc.toJS();
    if (value && typeof value === "object") js = value;
  } catch {
    js = null;
  }
  return { doc, problems, js };
}

/** The yaml lib quotes its multi-line error message; keep the first line. */
function firstLine(message) {
  return String(message).split("\n")[0].trim();
}

/** True when `permissions` grants issues:write, at any level that applies. */
function grantsIssuesWrite(value) {
  if (!value || typeof value !== "object") return false;
  return value.issues === "write";
}

/** Every string in the parsed tree, so a run step's inline script counts. */
function collectStrings(node, out = []) {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const v of node) collectStrings(v, out);
  else if (node && typeof node === "object")
    for (const v of Object.values(node)) collectStrings(v, out);
  return out;
}

/** The `on:` block. `on` is a plain string key under YAML 1.2 (verified). */
function triggers(js) {
  if (!js || typeof js !== "object") return {};
  const on = js.on;
  if (typeof on === "string") return { [on]: null };
  return on && typeof on === "object" ? on : {};
}

/**
 * Cron syntax check. GitHub ignores a cron it cannot parse, so a bad field
 * count or an out-of-range value is a job that never runs and never says so.
 */
/**
 * @param {unknown} expr the cron expression
 * @param {string} where location label for the finding
 * @returns {Finding[]}
 */
export function validateCron(expr, where) {
  const problems = [];
  if (typeof expr !== "string" || expr.trim() === "") {
    return [finding("cron", "cron is missing or not a string", { where })];
  }
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return [
      finding(
        "cron",
        `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}: ${JSON.stringify(expr)}`,
        { where },
      ),
    ];
  }
  fields.forEach((field, i) => {
    const spec = CRON_FIELDS[i];
    // `*`, ranges, lists, and steps are all legal; a literal value is not.
    if (field === "*" || /^[\d,-/]+$/.test(field) === false) return;
    for (const part of field.split(",")) {
      const base = part.split("/")[0];
      if (base === "*") continue;
      const n = Number(base);
      if (!Number.isInteger(n)) continue;
      if (n < spec.min || n > spec.max) {
        problems.push(finding(
          "cron",
          `${spec.name} ${n} is outside ${spec.min}-${spec.max} in ${JSON.stringify(expr)}`,
          { where },
        ));
      }
    }
  });
  return problems;
}

/** All crons declared by a workflow, as {expr, where} pairs. */
/**
 * Every `on.schedule` entry, in order, labelled by index.
 *
 * @param {Record<string, any> | null} js
 * @returns {{ expr: unknown, where: string }[]}
 */
export function collectCrons(js) {
  const on = triggers(js);
  const list = Array.isArray(on.schedule) ? on.schedule : [];
  return list
    .map((entry, i) => ({
      expr: entry && typeof entry === "object" ? entry.cron : entry,
      where: `on.schedule[${i}].cron`,
    }))
    .filter((c) => c.expr !== undefined);
}

/**
 * A workflow that posts an issue comment needs issues: write, resolved from
 * the parsed tree. A job-level `permissions` block OVERRIDES the workflow
 * level, so a job that posts must be judged by the permissions that actually
 * apply to it — not by a grant that some sibling job happens to carry.
 */
export function assessPermissions(js) {
  const problems = [];
  if (!js || typeof js !== "object") return problems;
  const workflowPerms = js.permissions;
  const posts = collectStrings(js).some((s) => ISSUE_COMMENT_PATH.test(s));
  if (!posts) return problems;
  const jobs = js.jobs && typeof js.jobs === "object" ? js.jobs : {};
  for (const [jobName, job] of Object.entries(jobs)) {
    if (!job || typeof job !== "object") continue;
    const jobStrings = collectStrings(job);
    if (!jobStrings.some((s) => ISSUE_COMMENT_PATH.test(s))) continue;
    // A job-level `permissions` block REPLACES the workflow-level one; it
    // does not merge with it. So a job that declares its own block is
    // judged by that block alone, and falling back to the workflow level
    // would resurrect a grant GitHub never applies to it.
    const effective =
      job.permissions && typeof job.permissions === "object"
        ? job.permissions
        : workflowPerms;
    if (!grantsIssuesWrite(effective)) {
      problems.push(
        finding(
          "perms",
          "posts an issue comment but has no issues: write (the run will 403 " +
            '"Resource not accessible by integration" and still exit 0)',
          { where: `jobs.${jobName}` },
        ),
      );
    }
  }
  return problems;
}

/** Run every check over one parsed workflow. */
export function checkWorkflow(name, text) {
  const { problems, js } = parseWorkflow(text);
  // No usable tree (unresolved alias, say): the parse problems above are all
  // the honest report, and every other finding would be noise off a
  // half-read document.
  if (!js) return problems;
  const crons = collectCrons(js);
  for (const { expr, where } of crons) {
    problems.push(...validateCron(expr, where));
  }
  problems.push(...assessPermissions(js));
  return problems.map((p) => ({ ...p, file: name }));
}

/** List the workflow files in `dir` (.yml and .yaml). */
export function listWorkflows(dir = DEFAULT_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f) && fs.statSync(path.join(dir, f)).isFile())
    .sort();
}

/** Check every workflow in `dir`. Returns {files, checked, failures}. */
export function checkAll(dir = DEFAULT_DIR) {
  const files = listWorkflows(dir);
  const failures = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    const problems = checkWorkflow(file, text);
    if (problems.length > 0) failures.push({ file, problems });
  }
  return { files, checked: files.length, failures };
}

export function formatReport(result, dir = DEFAULT_DIR) {
  const rel = path.relative(REPO_ROOT, dir) || dir;
  const lines = [`workflow contract — ${result.checked} file(s) in ${rel}`];
  for (const { file, problems } of result.failures) {
    lines.push(`  ${file}`);
    for (const p of problems) {
      const at = p.line ? `:${p.line}` : "";
      const where = p.where ? ` ${p.where}` : "";
      lines.push(`    [${p.check}]${where}${at} — ${p.message}`);
    }
  }
  if (result.failures.length === 0) {
    lines.push("  every workflow parses, every cron is well-formed, every comment poster is permitted");
    lines.push("WORKFLOW_CONTRACT PASS");
  } else {
    const count = result.failures.reduce((n, f) => n + f.problems.length, 0);
    lines.push(
      `WORKFLOW_CONTRACT FAIL — ${count} problem(s) in ${result.failures.length} file(s): ` +
        "a workflow that does not parse is a scheduled job that may never run",
    );
  }
  return lines.join("\n");
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "usage: node scripts/check-workflows.mjs [--dir <workflows-dir>] [--json]",
    );
    return 0;
  }
  const dirIdx = args.indexOf("--dir");
  const dir = dirIdx >= 0 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : DEFAULT_DIR;
  const result = checkAll(dir);
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(formatReport(result, dir));
  return result.failures.length === 0 ? 0 : 1;
}

// Only run when invoked directly, so tests can import the pure helpers.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
