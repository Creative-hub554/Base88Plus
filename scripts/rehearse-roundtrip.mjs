#!/usr/bin/env node
/**
 * rehearse-roundtrip.mjs: the recovery pass, pointed at a rehearsal's own log.
 *
 * WHY THIS EXISTS
 * ---------------
 * scripts/recover-verdicts.mjs exists to re-post a record a workflow computed and
 * then failed to record, and the only thing that makes that safe is that the text
 * it posts is the text the owning script composed. The sentinels print their
 * composed comment after `--- VERDICT BODY ---` for exactly that reason, and
 * `.github/workflows/oct4-sentinel.yml` pipes that stdout into the
 * `oct4-sentinel-log` artifact (`pwsh ... | tee oct4-sentinel.log`, then
 * `echo "exit=$code" >> oct4-sentinel.log`).
 *
 * Each half already has its own rehearsal: the sentinel's (does every path that
 * files a record print the marker and the body?) and the recovery pass's (does it
 * rebuild one from a log?). Neither answers the question that decides whether a
 * lost record comes back as itself: pointed at THIS sentinel's log, does the
 * recovery pass rebuild the record THIS sentinel wrote?
 *
 * So this asks that question with the shipped code rather than a reimplementation:
 * parseRecordLog and buildRecoveredBody are imported from recover-verdicts.mjs,
 * and selectUnreceipted judges the result - so what is asserted here is an
 * agreement between the two consumers, not between a test and its own copy of one.
 * The harness then hands the rebuilt comment back to the sentinel in turn (see
 * rehearse-sentinels.ps1), where the script that wrote the original has to
 * recognise it as its own work.
 *
 * Usage (normally from a rehearsal, never by hand) - two ways in:
 *
 *   # a scenario of the sentinel fixture: witness, day and verdict come from it
 *   node scripts/rehearse-roundtrip.mjs --log <captured stdout> \
 *     --fixture scripts/sentinel-rehearsal.json --scenario "<scenario name>" \
 *     --comment-out <path to write the recovered comment as JSON>
 *
 *   # any other run of any other workflow, stated outright (the lifecycle
 *   # rehearsal uses this for the verifiers, whose records the pass rebuilds too)
 *   node scripts/rehearse-roundtrip.mjs --log <captured stdout> \
 *     --workflow oct3-verify.yml --run-id 37123811425 \
 *     --run-created-at 2026-10-03T12:43:49Z --expect-verdict PASS_REFRESHED
 *
 * Exit: 0 every assertion held, 1 at least one did not (reasons are printed).
 */
import { readFileSync, writeFileSync } from "node:fs";

import { buildRecoveredBody, parseRecordLog, selectUnreceipted } from "./recover-verdicts.mjs";
import { AUDITOR_MARKER, LOG, RECOVERABLE } from "./verdict-contract.mjs";

/** `--name value`, or null. A missing value (next flag) reads as missing. */
function argv(name) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return null;
  const value = process.argv[at + 1];
  return value && !value.startsWith("--") ? value : null;
}

const logPath = argv("log");
const commentOut = argv("comment-out");
const fixturePath = argv("fixture");
const scenarioName = argv("scenario");
const label = scenarioName ?? argv("workflow") ?? "(unnamed)";

/** A usage error is a failure of this check, not a reason to skip it quietly. */
function bail(reason) {
  console.log(`ROUNDTRIP FAIL ${label}`);
  console.log(`  ${reason}`);
  process.exit(1);
}

if (!logPath) bail("--log is required");

/** The sentinel fixture's scenario, when this check is being run for one. */
let scenario = null;
if (fixturePath || scenarioName) {
  if (!fixturePath || !scenarioName) bail("--fixture and --scenario go together");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  scenario = (fixture.scenarios ?? []).find((s) => s.name === scenarioName);
  if (!scenario) bail(`no scenario named ${JSON.stringify(scenarioName)} in ${fixturePath}`);
}

const workflow = scenario ? scenario.sentinel : argv("workflow");
if (!workflow) bail("--workflow is required (or --fixture/--scenario)");
const spec = RECOVERABLE[workflow];
if (!spec) bail(`${workflow} is not in the recovery contract, so no pass could ever re-post its record`);

const day = scenario ? scenario.gnomon : String(argv("run-created-at") ?? "").slice(0, 10);
if (!day) bail("--run-created-at is required (or --fixture/--scenario)");
const filed = scenario ? scenario.expect.verdict : argv("expect-verdict");
const problems = [];

/**
 * The run this artifact belongs to, as the recovery pass finds it in the run list.
 * For a scenario it is synthesised - created on the day the sentinel fires (01:00
 * UTC), completed, concluding non-success (which for a sentinel IS the report) -
 * and its id is there to be IGNORED: a sentinel's identity names no run, so if a
 * header ever grew a {run} placeholder that fabricated id would surface in the
 * recovered header and the comparison below would fail, rather than quietly dating
 * the record to a lost run. For any other workflow the caller states the run it
 * really is, because there the id IS load-bearing: a verifier's record names the
 * run it inspected.
 */
const run = scenario
  ? { id: 9910000001, created_at: `${day}T01:00:00Z`, status: "completed", conclusion: "failure" }
  : {
      id: Number(argv("run-id") ?? NaN),
      created_at: argv("run-created-at"),
      status: "completed",
      conclusion: "failure",
    };
if (!Number.isFinite(run.id) || !run.created_at) bail("--run-id and --run-created-at are required with --workflow");

// The artifact, exactly as the workflow uploads it: the script's stdout with the
// workflow's own exit line appended (oct4-sentinel.yml: `pwsh ... | tee
// oct4-sentinel.log; code=$?; echo "exit=$code" >> oct4-sentinel.log`).
const log = readFileSync(logPath, "utf8");

const markers = log.split(LOG.body).length - 1;
if (markers !== 1) {
  problems.push(`the artifact carries ${markers} ${JSON.stringify(LOG.body)} line(s); exactly one is expected`);
}

const lines = log.split("\n");
const at = lines.indexOf(LOG.body);
const printedHeaderLine = at === -1 ? null : lines[at + 1];
// Everything the sentinel printed after its marker line: its composed comment,
// followed by whatever else that path logs (the dry-run restatement in a
// rehearsal, the executor's exit line in a real artifact).
const printedBody = at === -1 ? null : lines.slice(at + 1).join("\n").trim();

const record = parseRecordLog(log);
if (!record.verbatim) {
  problems.push(
    "the log carries no composed body after the marker, so the pass would rebuild this record (quoting the log) instead of re-posting it",
  );
}
if (!record.verdict) {
  problems.push(
    "the pass derives no VERDICT= line from this log, so a lost record would be reported unrecoverable and wait for a human",
  );
} else if (record.verdict !== filed) {
  problems.push(`the pass derives ${record.verdict}, but the workflow filed ${filed}`);
}

const rebuilt = buildRecoveredBody({ run, spec, record });

// --- the assertion this file exists for -------------------------------------
// The record the pass would post, and the record the sentinel printed: the same
// text. The left side is the JS loader and the recovery builder; the right side is
// PowerShell's own rendering, captured off the sentinel's stdout. Nothing but the
// identity line and the body is added - so a rebuilt comment that carried the
// reconstruction preamble instead of the sentinel's own words, or an identity
// phrased a word differently, or a body truncated at its first line, fails here
// rather than on the day a real record is lost.
const expected = printedBody === null ? null : `${printedHeaderLine}\n\n${printedBody}\n`;
if (expected !== null && rebuilt !== expected) {
  const identity =
    rebuilt.split("\n")[0] === printedHeaderLine
      ? `the identity is right (${JSON.stringify(printedHeaderLine)}), so the body is not`
      : `the identity is wrong: it starts ${JSON.stringify(rebuilt.split("\n")[0])}, ` +
        `the log's record starts ${JSON.stringify(printedHeaderLine)}`;
  problems.push(`the recovered comment is not the record the sentinel printed - ${identity}`);
  problems.push(`  (recovered ${rebuilt.length} chars, the printed record is ${expected.length})`);
}

// --- and the pass must still recognise it as a record ------------------------
// The receipt contract is the pass's own: a comment it wrote and then refused to
// read would be recovered again on the next run, forever.
if (!spec.shape.test(rebuilt)) {
  problems.push(`the recovered body does not match ${workflow}'s declared record shape, so the pass would not read it as a record`);
}
if (!rebuilt.includes(spec.marker)) {
  problems.push(`the recovered body does not carry the marker ${JSON.stringify(spec.marker)}`);
}
if (rebuilt.includes(AUDITOR_MARKER)) {
  problems.push("the recovered body carries the auditor's marker, which is never a record");
}

/**
 * The comment the harness will put on the simulated issue, timed as the post that
 * follows the run it recovers - a receipt must be created at or after the run
 * started, or it is not a receipt for that run (see isReceipted). Derived rather
 * than fixed at "01:00:30" so both ways in get it right: a scenario's run is
 * synthesised at 01:00:00 on the day, while a verifier's own run can be any hour of
 * it, and a hardcoded 01:00:30 would silently make the recovered record look like it
 * predated the run - failing a check whose message says the opposite.
 */
const comment = { id: 999000001, created_at: new Date(Date.parse(run.created_at) + 30_000).toISOString(), body: rebuilt };

const owing = selectUnreceipted([run], [], spec);
if (owing.length !== 1) {
  problems.push("the pass does not select this run as owing a record, so this log would never be recovered at all");
}
const settled = selectUnreceipted([run], [comment], spec);
if (settled.length !== 0) {
  problems.push("posting the recovered record does not discharge the obligation, so the pass would post it again on every run");
}

// The dedupe half, for the scenarios about it: the record already sitting on the
// issue has to BE the record this pass would write, or the two halves disagree
// about which string counts as "already recorded".
if (scenario?.expect.alreadyRecorded && printedHeaderLine) {
  if (!(scenario.comments ?? []).some((c) => String(c.body).includes(printedHeaderLine))) {
    problems.push(
      `no comment on the issue carries the identity this sentinel searches for (${JSON.stringify(printedHeaderLine)})`,
    );
  }
}

if (problems.length) {
  console.log(`ROUNDTRIP FAIL ${label}`);
  for (const problem of problems) console.log(`  ${problem}`);
  process.exit(1);
}

if (commentOut) {
  writeFileSync(commentOut, `${JSON.stringify({ comments: [comment] }, null, 2)}\n`);
}

console.log(
  `ROUNDTRIP OK ${label} verdict=${record.verdict} identity=${JSON.stringify(printedHeaderLine)} chars=${rebuilt.length}`,
);
