#!/usr/bin/env node
/**
 * rehearse-lifecycle.mjs: one record, one world, every tool that touches it.
 *
 * WHY THIS EXISTS
 * ---------------
 * This repo keeps four things honest about a verdict (scripts/verdict-contract.json
 * is what all of them read):
 *
 *   computed   a VERIFIER derives a verdict on its cron day and posts it to #18
 *              (scripts/verify-oct3.ps1, scripts/verify-oct28.ps1);
 *   filed      the workflow uploads the run's log as an artifact - the record's
 *              only durable home once its POST has failed;
 *   lost       the HEARTBEAT AUDITOR asks whether a run that owed a record
 *              recorded it (scripts/heartbeat-audit.mjs), and the day-after
 *              SENTINEL trips when it did not (scripts/oct4-sentinel.ps1);
 *   recovered  the RECOVERY PASS re-posts the record from that artifact while it
 *              still exists (scripts/recover-verdicts.mjs);
 *   retired    the receipt lands, the alarm that was waiting for it stands down,
 *              and the trip it filed is graded stale instead of re-filed.
 *
 * Each tool had a rehearsal of its own, and each built a little world of its own -
 * so the thing that actually breaks in production, a HANDOFF between two of them
 * (the pass reading an artifact the workflow wrote; the auditor crediting, or
 * refusing to credit, a comment the pass posted; the sentinel recognising a record
 * the pass rebuilt), had nowhere to be exercised. This file runs all four against
 * the ONE world declared in scripts/rehearsal-lifecycle.json.
 * scripts/rehearse-world.mjs is its only interpreter - the PowerShell tools reach it
 * through scripts/rehearse-sentinel-stub.ps1, the Node tools through its fetch shim -
 * so a fact about the world cannot mean two things depending on which language asked.
 * Nothing here reaches the network, and nothing can: an unrouted request is an error.
 *
 * WITH WHOSE CODE IT CHECKS
 * -------------------------
 * Nothing here reimplements what it is checking. The record's rebuild is asserted by
 * scripts/rehearse-roundtrip.mjs, which imports the pass's own parseRecordLog and
 * buildRecoveredBody; the receipt question is asked of the pass's own
 * selectUnreceipted; the auditor's finding count is read out of its own report and
 * the sentinel's standing-down is read off its own stdout. A rehearsal that
 * reimplements its subject proves only that it agrees with itself.
 *
 * Usage:  node scripts/rehearse-lifecycle.mjs              (npm run rehearse:lifecycle)
 *         node scripts/rehearse-lifecycle.mjs --only lost  (one phase, for debugging)
 *
 * Exit: 0 every step's handoff held, 1 at least one did not (the reasons and the
 *       actor's full output are printed for each failure, and every file the run
 *       produced - the world, the captured logs, the ledger - is kept).
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { selectUnreceipted } from "./recover-verdicts.mjs";
// The PowerShell to run, decided in one place (pwsh first: that is what CI and
// the cron workflows use). See scripts/rehearse-pwsh.mjs.
import { powerShell } from "./rehearse-pwsh.mjs";
import { loadWorld, saveWorld } from "./rehearse-world.mjs";
import { LOG, RECOVERABLE, WORKFLOWS } from "./verdict-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const WORLD_SCRIPT = join(HERE, "rehearse-world.mjs");
const ROUNDTRIP_SCRIPT = join(HERE, "rehearse-roundtrip.mjs");
const STUB = join(HERE, "rehearse-sentinel-stub.ps1");
const FIXTURE = join(HERE, "rehearsal-lifecycle.json");

/**
 * Who might run a step, and how this file reaches them.
 *
 * A PowerShell actor is run the way its workflow runs it - the script itself, with
 * scripts/rehearse-sentinel-stub.ps1 dot-sourced in front of it, so
 * `Invoke-RestMethod` answers out of the world (and throws for anything the world
 * does not describe). A Node actor is run with the world's fetch shim preloaded
 * (`--import scripts/rehearse-world.mjs`): the same trick in the other language.
 * `harness` is this file playing the WORKFLOW, because uploading a run's log is a
 * step of oct3-verify.yml, not something a tool of ours does.
 */
const ACTORS = {
  "verify-oct3": { kind: "powershell", workflow: "oct3-verify.yml" },
  "oct4-sentinel": { kind: "powershell", workflow: "oct4-sentinel.yml" },
  heartbeat: { kind: "node", tool: "scripts/heartbeat-audit.mjs" },
  recover: { kind: "node", tool: "scripts/recover-verdicts.mjs" },
  upload: { kind: "harness" },
};

/** A command whose exit status is data, not an exception. */
function capture(command, args, options) {
  try {
    return { code: 0, out: execFileSync(command, args, { encoding: "utf8", ...options }) };
  } catch (e) {
    return { code: typeof e.status === "number" ? e.status : null, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const lf = (text) => String(text ?? "").replace(/\r\n/g, "\n");
const firstLine = (body) => lf(body).split("\n")[0];

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1];
}

/**
 * The artifact text as the WORKFLOW writes it: the script's stdout, its exit line
 * appended, no BOM, LF endings (oct3-verify.yml: `pwsh ... | tee oct3-verify.log`,
 * then `echo "exit=$code" >> oct3-verify.log`). The recovery pass parses exact
 * lines, so a tidied copy would rehearse a different artifact.
 */
function artifactText(out, code) {
  const exitLine = code === null ? "" : `exit=${code}\n`;
  return `${lf(out).replace(/\n+$/, "")}\n${exitLine}`;
}

// --------------------------------------------------------------------- the run

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
const steps = fixture.steps ?? [];
if (!Array.isArray(steps) || steps.length === 0) {
  console.error(`LIFECYCLE_EMPTY ${FIXTURE}`);
  process.exit(2);
}

const only = arg("only");
const chosen = only ? steps.filter((s) => s.phase === only || s.name.includes(only)) : steps;
if (chosen.length === 0) {
  console.error(`LIFECYCLE_NO_STEPS match --only ${only}`);
  process.exit(2);
}

const workDir = mkdtempSync(join(tmpdir(), "record-lifecycle-"));
const worldPath = join(workDir, "world.json");
const ledgerPath = join(workDir, "ledger.txt");
/** step name -> the artifact the step produced (declared for the `upload` actor). */
const producedLogs = new Map();
const trail = [];
/** The record the round-trip checker rebuilt out of the artifact the pass will read. */
let roundTripRecord = null;
/** The record the pass actually posted: what the retirement steps must recognise. */
let recovered = null;
let failed = 0;
// A copy, so the fixture file stays the seed and every step's mutations land in the
// world file alone. The round trip is honest here because a world IS JSON - there is
// nothing in it that a deep clone would have to preserve and a JSON copy would not.
let world = JSON.parse(JSON.stringify(fixture.world));
saveWorld(worldPath, world);

/**
 * The run's ONE node child, owned here and reached over a local endpoint by the actors.
 *
 * The PowerShell actors below dot-source the stub, and through it
 * scripts/rehearse-world-session.ps1. With no endpoint in the environment each of them is an OWNER
 * and starts a child of its own - which is what this run used to do: ONE CHILD PER STEP, four
 * boots of the same file for one record's life, measured from the process table (`peak=1` but
 * `distinct_pids=4`) before this line existed. The endpoint is this harness's to choose, publish
 * and stop, exactly as scripts/rehearse-sentinels.ps1 does it for its own run: a client closing a
 * connection is a client leaving, not the run ending, and the child goes when this process closes
 * its lifetime pipe.
 */
const endpoint =
  process.platform === "win32"
    ? `\\\\.\\pipe\\rehearsal-lifecycle-${basename(workDir)}`
    : join(workDir, "sock", "world.sock");
const worldChild = spawn(process.execPath, [WORLD_SCRIPT, "session", "--endpoint", endpoint], {
  // stdin is the LIFETIME pipe; stdout and stderr are inherited, because every answer travels on
  // the endpoint and the child's own diagnostics belong in this log.
  stdio: ["pipe", "inherit", "inherit"],
});

/**
 * Wait until the child is listening, so the first actor CONNECTS instead of finding no endpoint.
 *
 * A connection is the only readiness probe that works on both platforms: on Unix the socket file is
 * a file that may not exist yet, and a named pipe is not a file at all. Connecting and closing is
 * harmless to the child - it answers frames, and there are none.
 */
async function waitForWorldChild() {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const listening = await new Promise((resolve) => {
      const probe = connect(endpoint);
      probe.once("connect", () => {
        probe.end();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });
    if (listening) return;
    if (worldChild.exitCode !== null) {
      throw new Error(`the world child exited ${worldChild.exitCode} before it listened on ${endpoint}`);
    }
    if (Date.now() > deadline) throw new Error(`no world child listening on ${endpoint} after 20s`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
await waitForWorldChild();

console.log(`LIFECYCLE fixture=${FIXTURE} steps=${chosen.length}`);

for (const step of chosen) {
  const actor = ACTORS[step.actor];
  if (!actor) {
    failed++;
    console.log(`LIFECYCLE FAIL ${step.name}`);
    console.log(`  - unknown actor ${JSON.stringify(step.actor)}`);
    continue;
  }
  const problems = [];
  const expect = step.expect ?? {};

  // The world's clock stamps whatever the step posts, which is how a scenario walks
  // a timeline without any tool being told what day it is.
  world = loadWorld(worldPath);
  world.clock = step.clock;
  saveWorld(worldPath, world);
  const commentsBefore = (world.comments ?? []).length;
  const artifactsBefore = (world.artifacts ?? []).length;
  // The chain whose receipt is at stake in this step: a PowerShell actor always runs
  // one, and a Node actor (the auditor, the pass) is told which one by the fixture -
  // because the receipt questions below are only meaningful about a chain that has
  // runs in this world, and a filter over an undefined chain silently returns none.
  const chain = actor.workflow ?? step.chain ?? null;
  const runs = chain ? (world.runs ?? []).filter((r) => r.workflow === chain) : [];
  const spec = chain ? RECOVERABLE[chain] : null;
  if ((expect.auditorCommentIsNotARecord !== undefined || expect.unreceiptedAfter !== undefined) && runs.length === 0) {
    problems.push(
      `this step asserts something about a receipt, but its chain (${JSON.stringify(chain)}) has no runs in the world - ` +
        `the assertion would hold no matter what the tool did`,
    );
  }

  let out = "";
  let code = null;
  let ledger = [];

  if (actor.kind === "powershell") {
    // No DRY_RUN, deliberately: the transport is the simulated world, so a record
    // filed here lands in the world and nowhere else. A rehearsal that forces the
    // dry path cannot rehearse the POST - which is the step this whole file exists
    // to exercise. (The scripts' own guard agrees: a faked date is honoured only
    // while the only transport is a rehearsal's world.)
    writeFileSync(ledgerPath, "");
    // $ProgressPreference first: Windows PowerShell writes progress records as a
    // CLIXML blob on the child's stderr, which is noise about module loading and not
    // a word about the script under rehearsal. Errors still come through, because
    // the progress stream is the only thing being silenced.
    const child =
      "$ProgressPreference = 'SilentlyContinue'; . $env:REHEARSAL_STUB; & $env:REHEARSAL_SENTINEL; " +
      'Write-Output ("REHEARSAL_EXIT=" + $LASTEXITCODE)';
    const encoded = Buffer.from(child, "utf16le").toString("base64");
    // A machine with no PowerShell is a FAILED STEP, not a crash: the engine is the
    // one prerequisite this rehearsal cannot supply, and the message has to say so
    // (see REHEARSE_PWSH_MISSING in scripts/rehearse-pwsh.mjs).
    let engine;
    try {
      engine = powerShell();
    } catch (e) {
      problems.push(`no PowerShell to run this step with: ${e.message}`);
      failed++;
      console.log(`LIFECYCLE FAIL ${step.name}`);
      for (const problem of problems) console.log(`  - ${problem}`);
      continue;
    }
    const result = capture(engine.command, [...engine.args, "-EncodedCommand", encoded], {
      cwd: ROOT,
      env: {
        ...process.env,
        REHEARSAL_STUB: STUB,
        REHEARSAL_SENTINEL: join(ROOT, WORKFLOWS[actor.workflow].script),
        REHEARSAL_WORLD: worldPath,
        REHEARSAL_WORLD_SCRIPT: WORLD_SCRIPT,
        // This run's child, published to the actor the way the sentinel harness publishes it to
        // its host: the actor connects to the ONE child instead of starting one of its own.
        REHEARSAL_WORLD_SESSION: endpoint,
        REHEARSAL_LEDGER: ledgerPath,
        VERIFY_TOKEN: step.token,
        VERIFY_GNOMON: step.gnomon,
        DRY_RUN: "",
        VERIFY_FORCE: "",
      },
    });
    out = lf(result.out);
    code = result.code;
    // The exit code is read from INSIDE the child: `exit N` in a script invoked with
    // `&` leaves the code in $LASTEXITCODE, and a throw (an unrouted request) skips
    // the marker line entirely - a step that never reached a verdict.
    const marker = /^REHEARSAL_EXIT=(\d+)\s*$/m.exec(out);
    if (marker) {
      code = Number(marker[1]);
      out = out.replace(/REHEARSAL_EXIT=\d+\s*\n?/g, "");
    }
    ledger = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
    producedLogs.set(step.name, artifactText(out, code));
  } else if (actor.kind === "node") {
    // `--import` takes a specifier, and on Windows an absolute path is not one: it
    // has to arrive as a file:// URL or the loader refuses the scheme.
    const result = capture(process.execPath, ["--import", pathToFileURL(WORLD_SCRIPT).href, join(ROOT, actor.tool)], {
      cwd: ROOT,
      env: {
        ...process.env,
        REHEARSAL_SHIM: "1",
        REHEARSAL_WORLD: worldPath,
        HEARTBEAT_TOKEN: "rehearsal-heartbeat-token",
        HEARTBEAT_GNOMON: step.gnomon,
        HEARTBEAT_DRY_RUN: "",
        RECOVER_TOKEN: "rehearsal-recover-token",
        RECOVER_GNOMON: step.gnomon,
        RECOVER_DRY_RUN: "",
      },
    });
    out = lf(result.out);
    code = result.code;
  } else {
    // The harness, playing the workflow's own upload step.
    const log = producedLogs.get(step.from);
    if (!log) {
      problems.push(`no captured log from ${JSON.stringify(step.from)} to upload - run the whole lifecycle`);
    } else {
      const logPath = join(workDir, step.log);
      writeFileSync(logPath, log);
      world = loadWorld(worldPath);
      for (const runId of step.runs) {
        world.artifacts = [
          ...(world.artifacts ?? []),
          {
            id: 99000001000 + runId,
            run: runId,
            name: step.artifact,
            size_in_bytes: Buffer.byteLength(log, "utf8"),
            expired: false,
            log: step.log,
            body: log,
          },
        ];
      }
      saveWorld(worldPath, world);
      // Is that artifact recoverable? Ask the recovery pass's own parser, through the
      // round-trip checker - the same checker the sentinel rehearsal runs.
      const commentPath = join(workDir, "roundtrip.comment.json");
      const first = (world.runs ?? []).find((r) => r.id === step.runs[0]);
      const trip = capture(
        process.execPath,
        [
          ROUNDTRIP_SCRIPT,
          "--log", logPath,
          "--workflow", step.workflow,
          "--run-id", String(first.id),
          "--run-created-at", first.created_at,
          "--expect-verdict", step.verdict,
          "--comment-out", commentPath,
        ],
        { cwd: ROOT },
      );
      out = lf(trip.out);
      code = trip.code;
      if (out.includes("ROUNDTRIP OK")) {
        roundTripRecord = JSON.parse(readFileSync(commentPath, "utf8")).comments[0];
      }
    }
  }

  // --- what the step said -----------------------------------------------------
  if (code === null) {
    problems.push("the actor never reached a verdict (no exit code; it threw)");
  } else if (expect.exit !== undefined && code !== expect.exit) {
    problems.push(`exit ${code}, expected ${expect.exit}`);
  }
  for (const needle of expect.stdout ?? []) {
    if (!out.includes(needle)) problems.push(`output does not contain: ${needle}`);
  }

  const outLines = out.split("\n");
  if (actor.kind === "powershell") {
    // Every REQUEST carried a credential. Only the `METHOD <url> auth=...` lines are
    // requests: the ledger also records the bodies of writes, which are multi-line
    // JSON and would otherwise read as a dozen header-less calls.
    const requests = ledger.filter((line) => /^\w+ \S+ auth=/.test(line));
    for (const line of requests) {
      if (!line.includes("auth=True")) problems.push(`request without an Authorization header: ${line}`);
    }
    if (requests.length === 0) problems.push("the actor made no request at all");
    if (expect.postAttempted !== undefined) {
      const attempted = ledger.some((line) => line.startsWith("POSTBODY"));
      if (attempted !== expect.postAttempted) {
        problems.push(
          expect.postAttempted
            ? "the record was never sent (no POST in the transport ledger)"
            : "it reached the posting path although nothing was left to file",
        );
      }
    }
  }
  if (expect.roundtrip) {
    if (!out.includes("ROUNDTRIP OK")) problems.push("the recovery pass cannot rebuild this record from its own artifact");
  }

  // --- what the world now holds ----------------------------------------------
  const after = loadWorld(worldPath);
  const added = (after.comments ?? []).slice(commentsBefore);
  const addedArtifacts = (after.artifacts ?? []).slice(artifactsBefore);

  // The record the step composed, straight off the log: the line after the marker.
  // The identity AND the verdict in one string - the text the script wrote, the text
  // the recovery pass searches for, and the text the heartbeat audits against.
  if (expect.recordLine && actor.kind === "powershell") {
    const markers = out.split(LOG.body).length - 1;
    const at = outLines.indexOf(LOG.body);
    if (markers !== 1) problems.push(`the log carries ${markers} ${JSON.stringify(LOG.body)} line(s); exactly one is expected`);
    const composed = at === -1 ? null : outLines[at + 1];
    if (composed !== expect.recordLine) {
      problems.push(`the record it composed is ${JSON.stringify(composed)}, expected ${JSON.stringify(expect.recordLine)}`);
    }
  }
  if (expect.recordLine && step.actor === "recover") {
    const posted = added.find((c) => firstLine(c.body) === expect.recordLine);
    if (!posted) {
      problems.push(
        `the pass posted no record starting ${JSON.stringify(expect.recordLine)} ` +
          `(it posted ${added.map((c) => JSON.stringify(firstLine(c.body))).join(", ") || "nothing"})`,
      );
    } else {
      recovered = posted;
      if (expect.matchesRoundTrip) {
        if (!roundTripRecord) {
          problems.push("the artifact was never round-tripped, so there is nothing to compare the post against");
        } else if (posted.body !== roundTripRecord.body) {
          problems.push(
            `the record the pass posted is not the record it rebuilt from the artifact ` +
              `(${posted.body.length} chars vs ${roundTripRecord.body.length})`,
          );
        }
      }
    }
  }
  if (expect.commentsAdded !== undefined && added.length !== expect.commentsAdded) {
    problems.push(
      `${added.length} comment(s) landed on #18, expected ${expect.commentsAdded}` +
        (added.length && added.length !== expect.commentsAdded
          ? ` - it posted ${added.map((c) => JSON.stringify(firstLine(c.body))).join(", ")}`
          : ""),
    );
  }
  if (expect.artifactsOn) {
    for (const runId of expect.artifactsOn) {
      const found = (after.artifacts ?? []).filter((a) => a.run === runId && a.name === step.artifact);
      if (found.length !== 1) problems.push(`run ${runId} carries ${found.length} ${JSON.stringify(step.artifact)} artifact(s), expected exactly one`);
      else if (!found[0].body.includes(LOG.body)) problems.push(`run ${runId}: the uploaded artifact does not carry ${JSON.stringify(LOG.body)}`);
    }
    if (addedArtifacts.length !== expect.artifactsOn.length) {
      problems.push(`${addedArtifacts.length} artifact(s) were uploaded, expected ${expect.artifactsOn.length}`);
    }
  }
  if (expect.findings !== undefined) {
    const m = /HEARTBEAT_AUDIT .* findings=(\d+)/.exec(out);
    if (!m) problems.push("the audit printed no HEARTBEAT_AUDIT line");
    else if (Number(m[1]) !== expect.findings) problems.push(`the audit reported ${m[1]} finding(s), expected ${expect.findings}`);
  }
  if (expect.auditorCommentIsNotARecord) {
    // The receipt test, asked of the pass's own code: a comment ABOUT a missing
    // record must not satisfy the contract that the record is present. The 2026-10-05
    // heartbeat comment quoted the verifier's marker while reporting it missing, and
    // was credited as the receipt.
    const owing = selectUnreceipted(runs, after.comments ?? [], spec);
    if (owing.length !== runs.length) {
      problems.push(
        `after the auditor spoke, the recovery pass reads ${runs.length - owing.length} of ${runs.length} runs as already recorded - ` +
          `its own complaint was credited as the record`,
      );
    }
  }
  if (expect.unreceiptedAfter !== undefined) {
    const owing = selectUnreceipted(runs, after.comments ?? [], spec);
    if (owing.length !== expect.unreceiptedAfter) {
      problems.push(`${owing.length} run(s) still owe a record, expected ${expect.unreceiptedAfter}`);
    }
  }
  if (expect.mentionsRecoveredComment) {
    if (!recovered) problems.push("no recovered record for this step to recognise");
    else if (!out.includes(`comment ${recovered.id}`)) {
      problems.push(`it does not name the record the pass posted (comment ${recovered.id}, ${JSON.stringify(firstLine(recovered.body))})`);
    }
  }

  // --- report ----------------------------------------------------------------
  if (problems.length === 0) {
    console.log(`LIFECYCLE OK   ${step.phase}: ${step.name.replace(/^[^:]*:\s*/, "")}`);
  } else {
    failed++;
    console.log(`LIFECYCLE FAIL ${step.name}`);
    for (const problem of problems) console.log(`  - ${problem}`);
    console.log("  --- the actor said ---");
    for (const line of outLines) if (line.trim()) console.log(`  | ${line}`);
  }
  trail.push(...added.map((c) => ({ ...c, step: step.name })));
}

// The run is over: let go of its child before anything else, because closing the lifetime pipe IS
// the stop and the world directory this child's socket lives in is removed on the success path.
worldChild.stdin?.end();

// The record's life, as the issue now reads it: the clearest statement of what this
// run just rehearsed is the comment trail it left behind.
const finalWorld = loadWorld(worldPath);
console.log("");
if (trail.length) {
  console.log(`LIFECYCLE trail (#${finalWorld.issue?.number ?? "?"}, ${trail.length} comment(s)):`);
  for (const c of finalWorld.comments ?? []) {
    console.log(`  ${c.id}  ${c.created_at}  ${firstLine(c.body).slice(0, 96)}`);
  }
  console.log("");
}
console.log(`LIFECYCLE_DONE steps=${chosen.length} failed=${failed} recovered=${recovered ? 1 : 0}`);

if (failed > 0) {
  // The world, the captured logs and the ledger are the only copy of a failing
  // step's evidence, so they are kept exactly when there is something to look at.
  console.log(`LIFECYCLE_WORLD ${worldPath}`);
  console.log(`LIFECYCLE_LEDGER ${ledgerPath}`);
  process.exit(1);
}
rmSync(workDir, { recursive: true, force: true });
process.exit(0);
