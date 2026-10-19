#!/usr/bin/env node
/**
 * recover-verdicts - re-post a record that a workflow computed but never recorded.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-10-03 the Oct 3 verifier fired three times and derived
 * `PASS_REFRESHED` three times, and all three POSTs failed with
 * `403 "Resource not accessible by integration"` because `oct3-verify.yml` was
 * the only workflow in this repo that posts to #18 without declaring
 * `issues: write`. Each run printed `COMMENT_FAILED` and then exited 0 on the
 * strength of the PASS it had failed to record, so every surface the repo
 * watches read the run as green. The verdict was real; the only copy of it was
 * a run artifact that expires after 90 days.
 *
 * The recovery of that verdict was done by hand, six days later, by reading the
 * run's own artifact. Doing it by hand is what introduced a transcription error
 * (the artifact said the snapshot was `age=1d`; the hand transcription said 0).
 * The fix for both problems is the same: let the machine read the artifact, and
 * only while the artifact still exists.
 *
 * WHO OWES A RECORD
 * -----------------
 * Two shapes of obligation, and they are not the same shape:
 *
 *   - the VERIFIERS post a verdict every time they derive one
 *     (`postsWhen: 'always'`), so any completed run without a record on #18 is
 *     a lost record;
 *   - the SENTINELS post only when they trip (`postsWhen: 'tripped'`), so a
 *     green run is silent BY DESIGN and is not a gap. Only a run that concluded
 *     non-success owes a comment - and a tripped sentinel's comment is the whole
 *     diagnosis, because the red run itself only says "check #18".
 *
 * THE RECEIPT TEST IS DELIBERATELY STRICT
 * ---------------------------------------
 * "Already recorded" means: a comment on the record issue that contains the
 * workflow's marker AND carries that workflow's record shape in it AND was
 * created at or after the run started AND is not the auditor's own comment. All
 * four facts come from scripts/verdict-contract.json; none is restated here.
 *
 * The shape is not decoration. Without it, the audit's own complaint that a
 * record is missing satisfies the contract that it is present - which is exactly
 * what happened to this repo, where the 2026-10-05 heartbeat comment ("the Oct 3
 * verdict was never recorded on #18", quoting the marker while saying so) was
 * credited as the Oct 3 receipt. A prophylactic that can be satisfied by a
 * description of the condition it prevents is not a prophylactic.
 *
 * The vocabulary is PER WORKFLOW rather than one global regex, because it has to
 * be: oct28-verify posts `NO_DISPATCH_RUN` and `PRE_PROMO_*` by design, and a
 * global shape listing only PASS/ATTENTION/FAIL/CRON declares those records
 * missing - the mirror image of the same bug, and the one that would have had
 * this pass re-post over a record that was already on the issue.
 *
 * The time comparison is deliberately loose in one direction: a receipt
 * recorded after the run covers that run. That is what stops a retry chain from
 * producing three duplicate comments for one day's verdict - the Oct 3 chain
 * declares three attempts, and one landed verdict is the whole ask.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It will not fabricate a record. If a run's log carries neither the composed
 * body nor an explicit `VERDICT=` line, the run is reported as unrecoverable and
 * nothing is posted. Runs that legitimately produce no verdict (the verifier's
 * date gate exiting 2, `RUN_IN_PROGRESS`) are not our business - the difference
 * between "no verdict was computed" and "a verdict was computed and lost" is
 * exactly the presence of that line.
 *
 * It also will not pretend a recovered sentinel is news. A sentinel's comment
 * describes a condition at one moment; re-posting it days later could be read as
 * an alert about now. Recovered sentinel records say so in as many words, and
 * name re-running the sentinel as the way to clear the gap.
 *
 * Zero dependencies, like its sibling heartbeat-audit.mjs: it must run on a
 * bare checkout with no npm install. Reading an Actions artifact means reading a
 * zip, so the zip reader below is ours, over node:zlib.
 *
 * Usage:  node scripts/recover-verdicts.mjs        (RECOVER_TOKEN, or a git
 *         credential helper; RECOVER_DRY_RUN=1 prints instead of posting)
 *         RECOVER_GNOMON=<ISO instant>  the lifecycle rehearsal only: honoured
 *         only while the transport is a rehearsal's simulated world.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import {
  AUDITOR_MARKER,
  ISSUE,
  LOG,
  RECOVERABLE,
  REPO,
  RETENTION_DAYS,
  renderHeader,
  simulatedNow,
} from "./verdict-contract.mjs";

export { ISSUE, RECOVERABLE, REPO, RETENTION_DAYS };

export const API = `https://api.github.com/repos/${REPO}`;

/** How much of a run's log to quote. Artifacts hold a script's stdout, which is small. */
export const MAX_QUOTE = 6000;

/**
 * Every workflow that promises a durable record, imported straight from the
 * declaration (scripts/verdict-contract.json, via verdict-contract.mjs).
 *
 * There is no local table to keep in step any more. The marker, the record
 * shape, the run-log artifact, the posting obligation and the header phrasing
 * are all the contract's, shared with the heartbeat auditor and with the
 * PowerShell scripts that write the records in the first place - so "did the
 * record land?" has exactly one answer in this repo.
 *
 * `header` is the TEMPLATE `renderHeader` fills in, so a recovered comment
 * carries the same words a real one would - and, more importantly, the same
 * words the owning script searches for when it asks whether it already posted.
 */

/**
 * The sentinel a run prints before its composed comment body, so a future log
 * can be re-posted verbatim instead of reconstructed. Reconstruction is the
 * thing that introduced the transcription error on 2026-10-09; when this marker
 * is present the body is copied byte for byte and nothing is rebuilt.
 */
export const BODY_MARKER = LOG.body;

/** The marker workflow for each entry, for pins and messages. */
export function scriptFor(workflow) {
  return Object.entries(RECOVERABLE).find(([wf]) => wf === workflow)?.[1];
}

/**
 * Read a run's log.
 *
 * The whole log is returned, and the recovered comment quotes all of it. An
 * earlier draft filtered to a whitelist of "interesting" prefixes, which was
 * wrong twice over: the oct4 sentinel's most useful lines ("scheduled
 * oct3-verify attempts ...", "#18 verifier comments since Oct 3: ...") match no
 * such prefix, and a whitelist silently drops whatever a future script adds.
 * The artifact is small and it is the evidence - so it is quoted, not curated.
 *
 * `inspectedRunId` is NOT the owning run's id: `verify-oct3.ps1` prints
 * `RUN id=<id>` for the CI run it inspected, and the sentinels list the runs
 * they found. Associating an artifact with the run that produced it is the
 * caller's job, and the caller has it (it enumerated the run first).
 */
export function parseRecordLog(text) {
  const s = String(text ?? "");
  const at = s.indexOf(BODY_MARKER);
  const verbatim = at === -1 ? null : s.slice(at + BODY_MARKER.length).trim() || null;
  const grab = (re) => {
    const m = re.exec(s);
    return m ? m[1].trim() : null;
  };
  // The line prefixes the scripts print are the contract's too, so a script that
  // renames its own output cannot quietly become unreadable to this pass.
  const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const inspect = grab(/^RUN id=(\d+)/m);
  return {
    verbatim,
    log: s.trim(),
    verdict: grab(new RegExp(`^${esc(LOG.verdict)}([A-Z_]+)\\s*$`, "m")),
    inspectedRunId: inspect === null ? null : Number(inspect),
    commentFailed: grab(new RegExp(`^${esc(LOG.commentFailed)}(.*)$`, "m")),
  };
}

/** Did this workflow's record for this run already land on the issue? */
export function isReceipted(comments, spec, runCreatedAtMs) {
  return (comments ?? []).some((c) => {
    if (!c || typeof c.body !== "string") return false;
    if (!c.body.includes(spec.marker)) return false;
    if (!spec.shape.test(c.body)) return false;
    // The auditor is never a witness to the record it audits: its complaint
    // quotes markers and verdicts by name, so crediting it would let the report
    // that a record is missing be read as the record arriving. Same rule the
    // heartbeat applies to its own comment, from the same declaration.
    if (c.body.includes(AUDITOR_MARKER)) return false;
    const at = Date.parse(c.created_at);
    return !Number.isNaN(at) && at >= runCreatedAtMs;
  });
}

/**
 * Which runs computed a record that never landed?
 *
 * `postsWhen: 'tripped'` is the load-bearing bit for the sentinels: they are
 * silent when satisfied, so a green run owes nothing and only a non-success
 * conclusion is a candidate. Treating a satisfied sentinel as "missing a
 * comment" would have this pass manufacture a gap out of good news.
 */
export function selectUnreceipted(runs, comments, spec) {
  const out = [];
  for (const run of runs ?? []) {
    if (!run || run.status !== "completed") continue;
    if (spec.postsWhen === "tripped" && run.conclusion === "success") continue;
    const startedAt = Date.parse(run.created_at ?? run.run_started_at ?? "");
    if (Number.isNaN(startedAt)) continue;
    if (isReceipted(comments, spec, startedAt)) continue;
    out.push(run);
  }
  // Oldest first, so the record reads in the order the verdicts were derived.
  return out.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/**
 * The header line, phrased exactly the way the owning script phrases it.
 *
 * Exactness is not cosmetic: each script dedupes on its own header text -
 * `verifier run ${id}` for a verifier, `sentinel (checked ${day})` for a
 * sentinel - and inserting anything inside those parentheses (a run id, say)
 * puts the recovered comment outside the string the sender greps for, so a
 * re-run would double-post. A pin caught exactly that.
 *
 * The `run` handed in is the run being RECOVERED - the verifier's or the
 * sentinel's own - which a sentinel's identity does not name at all, and which a
 * verifier's identity names only when its log says nothing about the run it
 * inspected: buildRecoveredBody always names the run the RECORD names.
 *
 * The recovered run's id is not lost either way: it is named in the recovery note
 * below.
 */
export function recordHeader(spec, run, day, verdict) {
  return `${renderHeader(spec, { run: run.id, day })}: **${verdict}**`;
}

/**
 * The comment to post. Verbatim when the run printed a body; otherwise the
 * header plus the run's log quoted in full - the recovery of 2026-10-09
 * paraphrased one line of it and got it wrong, which is why nothing here is
 * paraphrased.
 */
export function buildRecoveredBody({ run, spec, record }) {
  const day = String(run.created_at ?? "").slice(0, 10);
  // The identity belongs to the run the RECORD names, which is not always the run
  // that wrote it: both verifiers name the CI run they inspected (`-Run $run.id`,
  // and `RUN id=` in their log says which that was), while the run being recovered
  // here is the verifier's own. Naming the inspected run is what makes the
  // recovered comment the record the SENDER would have written - the string its
  // ALREADY_RECORDED guard searches for - instead of one this pass invented. A
  // log that predates the line has only the recovered run to go on.
  const named = record.inspectedRunId ?? run.id;
  const header = recordHeader(spec, { ...run, id: named }, day, record.verdict);
  if (record.verbatim) return `${header}\n\n${record.verbatim}\n`;

  const quote =
    record.log.length > MAX_QUOTE
      ? `${record.log.slice(0, MAX_QUOTE)}\n... [truncated; full log in the ${spec.artifact} artifact]`
      : record.log;

  // A sentinel loudens about a condition at one moment. Re-posted days later it
  // must not read as an alert about today, and it must not claim to clear
  // itself - only a fresh sentinel run can do that.
  const staleness =
    spec.postsWhen === "tripped"
      ? `**This is a historical report, not a new alert.** The condition above was ` +
        `observed by run ${run.id} on ${day}; it may have changed since. Re-run ` +
        `the sentinel to clear it.\n\n`
      : "";

  return (
    `${header}\n\n` +
    `> **Automatically recovered.** This run computed the record above and ` +
    `failed to record it. It is re-posted here from the run's own ` +
    `\`${spec.artifact}\` artifact, quoted in full, before the ` +
    `${RETENTION_DAYS}-day retention window closes.\n\n` +
    staleness +
    "```\n" +
    quote +
    "\n```\n"
  );
}

/**
 * Pull one entry out of a zip using only node:zlib.
 *
 * The audit scripts here are deliberately dependency-free (they run on a bare
 * checkout), and an Actions artifact is a zip. Reading the central directory is
 * what makes this correct rather than lucky: when an entry is streamed with a
 * data descriptor its local header carries zeroed sizes, so the local header
 * alone cannot tell you where the compressed bytes end.
 */
export function unzipEntry(buf, name) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a zip: no end-of-central-directory");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = buf.readUInt16LE(off + 10);
    const compressed = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const entryName = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (entryName === name) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compressed);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported zip compression method ${method}`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// --------------------------------------------------------------------- io

/**
 * Failing here must be LOUD. A recovery pass with no credentials would find
 * nothing to recover and could report a clean exit, which is the same
 * green-checkmark failure mode as the 2026-10-03 run that exited 0 on the PASS
 * it had just failed to record. So: no token, no quietly-healthy run.
 */
function token() {
  const fromEnv = process.env.RECOVER_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  let out;
  try {
    out = execFileSync("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new Error(
      "NO_TOKEN - set RECOVER_TOKEN (the workflow passes github.token), or run where " +
        "a git credential helper can fill https://github.com",
    );
  }
  const line = out.split(/\r?\n/).find((l) => l.startsWith("password="));
  if (!line) throw new Error("NO_TOKEN - the git credential helper returned no password");
  return line.slice("password=".length);
}

let TOK = null;
function headers() {
  return {
    Authorization: `Bearer ${TOK}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function api(path, init = {}) {
  const res = await fetch(API + path, { ...init, headers: { ...headers(), ...init.headers } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** Follow a 302 to a pre-signed blob URL WITHOUT the bearer token. */
async function download(url) {
  const first = await fetch(url, { headers: headers(), redirect: "manual" });
  if (first.status < 300 || first.status >= 400) {
    if (!first.ok) throw new Error(`download ${url} -> ${first.status}`);
    return Buffer.from(await first.arrayBuffer());
  }
  const loc = first.headers.get("location");
  if (!loc) throw new Error(`download ${url} -> ${first.status} with no Location`);
  const second = await fetch(loc);
  if (!second.ok) throw new Error(`blob download -> ${second.status}`);
  return Buffer.from(await second.arrayBuffer());
}

async function artifactLog(runId, spec) {
  const arts = await api(`/actions/runs/${runId}/artifacts?per_page=100`);
  const art = (arts.artifacts ?? []).find((a) => a.name === spec.artifact);
  if (!art) return null;
  const zip = await download(`${API}/actions/artifacts/${art.id}/zip`);
  const entry = unzipEntry(zip, spec.log);
  if (!entry) return null;
  return entry.toString("utf8");
}

export async function main() {
  TOK = token();
  // The retention cutoff is a date, so it reads the clock through the fake-day seam:
  // a rehearsal pinned to the days a real chain fired would otherwise fall out of
  // its own 90-day window the moment the wall clock passed it (see simulatedNow;
  // RECOVER_GNOMON is honoured only with a rehearsal's simulated transport).
  const now = simulatedNow("RECOVER_GNOMON");
  const since = new Date(now - RETENTION_DAYS * 86400000).toISOString();
  const comments = await api(`/issues/${ISSUE}/comments?per_page=100`);
  const dry = process.env.RECOVER_DRY_RUN === "1";

  let recovered = 0;
  let unrec = 0;
  const notes = [];

  for (const [workflow, spec] of Object.entries(RECOVERABLE)) {
    // No `created=` filter: the query syntax has several dialects (ranges vs
    // comparators) and a silently-ignored filter would widen the window without
    // anyone noticing. These workflows fire a handful of times a year, so 100
    // newest-first runs covers everything and the cutoff is applied here.
    const res = await api(`/actions/workflows/${workflow}/runs?event=schedule&per_page=100`);
    const runs = (res.workflow_runs ?? []).filter((r) => (r.created_at ?? "") >= since);
    const todo = selectUnreceipted(runs, comments, spec);
    notes.push(
      `${workflow}: ${runs.length} scheduled run(s) inside retention` +
        `${spec.postsWhen === "tripped" ? " (only tripped runs owe a record)" : ""}, ` +
        `${todo.length} without a record`,
    );

    for (const run of todo) {
      // Re-check the receipt against the comments as they now stand, INCLUDING the
      // ones this pass has just posted. `todo` was selected from a list fetched
      // before any post, so without this a day the chain retried three times (Oct 3
      // did exactly that) yields the same record three times over: each retry is
      // judged unreceipted by a list that predates the post which already covers it.
      // A receipt recorded after a run covers that run - the contract's own rule,
      // and the reason a retry chain is one comment and not three. Rehearsed as the
      // `recovered` step of scripts/rehearse-lifecycle.mjs, which failed on this
      // exact duplicate before it was fixed.
      if (isReceipted(comments, spec, Date.parse(run.created_at ?? run.run_started_at ?? ""))) {
        notes.push(`  run ${run.id}: covered - this chain's record is already on #${ISSUE} (a same-day retry)`);
        continue;
      }
      let log = null;
      try {
        log = await artifactLog(run.id, spec);
      } catch (e) {
        notes.push(`  run ${run.id}: artifact unreadable (${e.message})`);
      }
      const record = parseRecordLog(log ?? "");
      if (!log || !record.verdict) {
        unrec += 1;
        notes.push(
          `  run ${run.id}: NOT RECOVERABLE - ${log ? "the artifact carries no VERDICT= line" : "no " + spec.artifact + " artifact"} ` +
            `(a date-gated or in-progress run legitimately has none; anything else needs a human)`,
        );
        continue;
      }
      const body = buildRecoveredBody({ run, spec, record });
      if (dry) {
        notes.push(`  run ${run.id}: WOULD POST ${record.verdict} (${body.length} chars)`);
        continue;
      }
      const posted = await api(`/issues/${ISSUE}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      // Keep the world's own view of what it just accepted, so the NEXT run in this
      // loop is judged against a receipt that exists rather than one that is about
      // to. The response is the created comment; if it arrived in a shape this pass
      // cannot read back, the record is still a receipt - dated now, with the body
      // it just sent - because a post whose evidence is unreadable is not a post
      // that has to happen twice.
      if (Array.isArray(comments)) {
        comments.push(
          posted && typeof posted === "object"
            ? { id: posted.id ?? 0, created_at: posted.created_at ?? new Date(now).toISOString(), body: posted.body ?? body }
            : { id: 0, created_at: new Date(now).toISOString(), body },
        );
      }
      recovered += 1;
      notes.push(`  run ${run.id}: RECOVERED ${record.verdict} from ${spec.artifact}`);
    }
  }

  console.log(`RECOVER_RECORDS issue=#${ISSUE} dry=${dry} recovered=${recovered} unrecoverable=${unrec}`);
  for (const n of notes) console.log(`  ${n}`);
  // A run we could neither receipt nor recover is a finding: the record is still
  // missing something this pass was built to restore.
  return unrec === 0 ? 0 : 1;
}

// Run only when executed directly (the tests import the pure functions).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main());
}
