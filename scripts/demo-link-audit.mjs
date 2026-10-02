#!/usr/bin/env node
/**
 * Link audit for the cached template demos.
 *
 * The gallery renders a demo's FIRST page, so nothing in the UI can tell you
 * that its navbar goes nowhere. This walks every cached demo's whole file
 * set and resolves every link against the files the demo actually emitted:
 *
 *   DEAD TOTAL 0  — every href/src resolves to an emitted file
 *   INERT TOTAL 0 — no `href="#"` names a page the demo emitted
 *
 * The inert check is the one that matters. An earlier audit asked only
 * "does this href resolve?", and a navbar of `href="#"` passed it — "#" is a
 * legal target. Four real pages, zero navigable, audit green.
 *
 * The generation gate (demoLooksNavigable) is the real enforcement; this is
 * the human-facing pass over what is already cached, which is how a demo
 * generated before a rule existed gets measured. projects-data/ is
 * gitignored, so CI has no demos to walk — the rules themselves are pinned in
 * tests/demo-link-audit.test.ts and run on every push.
 *
 * Usage:
 *   npm run audit:demos
 *   node scripts/demo-link-audit.mjs [template-id ...]
 *
 * The two totals are NOT the same severity, and the exit code follows that:
 *
 *   INERT — fatal, and fatal to GENERATION. A `href="#"` naming a page the
 *           demo emitted has a knowable target, so shipping it is a bug.
 *   DEAD  — reported, not fatal. Ordinary model sloppiness (a footer linking
 *           to `#terms` on a one-pager that has no terms section). Failing a
 *           generation over it would throw away a good demo, not improve it,
 *           so `demoNavIsWired` gates on the inert class only.
 *
 * The cache holds the bytes as generated; the promote path re-runs the
 * sanitizer on copy, so a demo generated before a repair rule existed is
 * repaired for the user even when this reports it. That is why INERT is a
 * number to trust and not a verdict on what a user sees.
 *
 * Exit: 0 = no inert link, 1 = an inert link, 2 = no demos found.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { auditDemoLinks, formatDemoLinkProblem } from "../src/lib/demo-link-audit.ts";

const DATA_DIR = path.resolve(process.cwd(), "projects-data");
const SKIP = new Set(["project.json"]);

function readDemo(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || SKIP.has(entry.name)) continue;
    files.push({
      path: entry.name,
      content: fs.readFileSync(path.join(dir, entry.name), "utf8"),
    });
  }
  return files;
}

const only = process.argv.slice(2);
const dirs = fs.existsSync(DATA_DIR)
  ? fs
      .readdirSync(DATA_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("tpl-"))
      .map((e) => e.name)
      .filter((name) => only.length === 0 || only.includes(name.slice(4)))
      .sort()
  : [];

if (dirs.length === 0) {
  console.log("DEMO_LINK_AUDIT NO_DEMOS (no cached template demos found)");
  process.exit(2);
}

let deadTotal = 0;
let inertTotal = 0;
let linksTotal = 0;
let failed = false;

for (const name of dirs) {
  const files = readDemo(path.join(DATA_DIR, name));
  const audit = auditDemoLinks(files);
  deadTotal += audit.dead.length;
  inertTotal += audit.inert.length;
  linksTotal += audit.checked;
  const verdict = audit.inert.length > 0 ? "FAIL" : audit.dead.length > 0 ? "WARN" : "PASS";
  console.log(
    `  ${name.padEnd(16)} ${String(audit.checked).padStart(3)} links  ` +
      `${audit.dead.length} dead  ${audit.inert.length} inert  ${verdict}`,
  );
  for (const problem of audit.problems) {
    console.log(
      `      ${problem.reason === "inert" ? "INERT" : "dead "} ${formatDemoLinkProblem(problem)}`,
    );
  }
  if (audit.inert.length > 0) failed = true;
}

console.log("");
if (failed) {
  console.log(
    `DEMO_LINK_AUDIT FAIL — ${linksTotal} link(s) across ${dirs.length} demo(s): ` +
      `INERT TOTAL ${inertTotal} (fatal), DEAD TOTAL ${deadTotal} (reported)`,
  );
  console.log(
    "Regenerate the named demos: a placeholder nav that names a real page is a bug.",
  );
  process.exit(1);
}
console.log(
  `DEMO_LINK_AUDIT PASS — ${linksTotal} link(s) across ${dirs.length} demo(s): ` +
    `INERT TOTAL 0, DEAD TOTAL ${deadTotal}` +
    (deadTotal > 0 ? " (reported, not fatal — see the header)" : ""),
);
