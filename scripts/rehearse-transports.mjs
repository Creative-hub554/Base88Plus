#!/usr/bin/env node
/**
 * rehearse-transports.mjs: the two transports of the simulated GitHub, asked the same
 * questions and compared.
 *
 * WHY THIS EXISTS
 * ---------------
 * scripts/rehearse-world.mjs is ONE interpreter with TWO transports. The PowerShell
 * tools reach it through scripts/rehearse-sentinel-stub.ps1, which defines
 * Invoke-RestMethod and marshals every call into the router in a child process; the Node
 * tools reach it through installFetchShim(), which replaces global fetch in their process.
 * The claim written on that arrangement is "a fact about the world cannot mean two things
 * depending on which language asked" — and until this suite, it had never been rehearsed.
 * It was the exact shape of the defects this repo keeps meeting: the sentinel rehearsal
 * drove one transport, the lifecycle drove the other, and BOTH WERE GREEN, which is what
 * "green on each, disagreeing with each other" looks like. Nothing asked whether a
 * one-element array unrolls the same way, whether a 403 carries the same body, or whether
 * an instant survives the trip intact on the engine a leg installed.
 *
 * WHAT IS COMPARED
 * ----------------
 * Per case, one OBSERVATION from each side, and the observations are compared as
 * canonicalised JSON (object keys sorted), so no difference in how `ConvertTo-Json` and
 * `JSON.stringify` render the same value can pass for agreement — and none of the
 * differences that matter can hide inside one:
 *
 *   - `items`: the array the CALLER's own `@(...)` wrap sees, plus that count. This is the
 *     load-bearing part. The real API hands a one-element array to PowerShell as a single
 *     object with no `.Count`, and to Node as an array of one; both transports must
 *     therefore report the same items, one as an object and one as an array, because that
 *     is what the scripts' wraps are for. A transport that "tidied" that into a consistent
 *     array would rehearse a kinder GitHub than the real one, and a script that forgot its
 *     wrap would stop being rehearsed at all;
 *   - `content`: a raw file (the verifiers' upstream compare, via Invoke-WebRequest);
 *   - `message` and `details`: a refusal, which is how a lost record's artifact learns it
 *     was refused and why;
 *   - `bytes`: AN ARTIFACT ZIP, the case that is not a comparison of two answers. Bytes are
 *     what the recovery pass downloads, `unzipEntry` is the reader it downloads them with,
 *     and no PowerShell tool here asks for one - so what is compared is that each side does
 *     what its own transport CAN: Node hands back the world's log, read out of the zip with
 *     that same reader, and PowerShell REFUSES the bytes instead of answering
 *     `@{ Content = $null; StatusCode = 200 }`, because a successful download of nothing is
 *     a rehearsal of the wrong thing. The case names the reason it must give.
 *
 * The artifact case is therefore the ONE exception to "the two observations are compared
 * with each other", and it is declared in the fixture rather than inferred. Both halves are
 * checked against what their own transport must do - the Node half against the world's own
 * log, character for character - because the honest question for a route one side cannot
 * carry is not whether the two answers look alike. A case that declares nothing gets the
 * equality comparison, so the exception cannot spread by accident; the fixture is written so
 * that it is the only one, and tests/transport-rehearsal.test.ts pins that.
 *
 * Both halves are the shipped code, not a copy of it: the PowerShell side is
 * scripts/rehearse-transport-actor.ps1, which dot-sources the stub the cron scripts run
 * against, and the Node side is the same installFetchShim() the lifecycle and the
 * recovery pass load. Each side gets its OWN world file, so a mutation on one side cannot
 * be read as agreement on the other.
 *
 * ONE ENGINE LAUNCH FOR EVERY CASE, and one node child for the session. An engine costs the
 * better part of a second and a node boot is most of the cost of a small question, so all ten
 * cases go to one PowerShell session, which answers them in order and names each answer (see
 * observePowerShell), and the transport under rehearsal asks the one world child that session
 * keeps rather than booting a node per request (see scripts/rehearse-world-session.ps1). What
 * is compared does not depend on any of that: the report is unchanged by the batching, which
 * is what the committed baseline proves.
 *
 * Usage:
 *   npm run rehearse:transports
 *   npm run rehearse:transports -- --only comments-window-one
 *   node scripts/rehearse-transports.mjs [--only <case>] [--keep]
 *
 * `--keep` leaves the worlds, ledgers and case files in place and prints where to stderr
 * (stdout stays the report, so it never reads as a different result). The engine is
 * chosen by scripts/rehearse-pwsh.mjs, the one place that decides it — and the engine's
 * NAME is deliberately not printed, because the report has to be identical on every line
 * for the parity of the legs' output to mean anything.
 *
 * Exit: 0 every case agreed; 1 a disagreement, a case that could not be run, or no
 * PowerShell at all.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { powerShell } from "./rehearse-pwsh.mjs";
// The recovery pass's own zip reader, imported rather than re-implemented: the case is about
// whether the bytes arrive intact, so the thing that must open them is the thing that opens
// a real artifact.
import { unzipEntry } from "./recover-verdicts.mjs";
import { installFetchShim } from "./rehearse-world.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "transport-rehearsal.json");
const WORLD_SCRIPT = join(HERE, "rehearse-world.mjs");
const ACTOR = join(HERE, "rehearse-transport-actor.ps1");

/** The world file the router reads: the fixture, minus what is the rehearsal's own. */
const WORLD_KEYS = [
  "clock",
  "issue",
  "comments",
  "workflows",
  "runs",
  "artifacts",
  "post",
  "raw",
  "next_comment_id",
];

/** Windows PowerShell re-emits a child's stdout as CRLF; the report is compared as text. */
const lf = (text) => String(text).replace(/\r\n/g, "\n");

/** Keys sorted, so two renderings of the same value compare equal. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The first place two observations disagree, as a path a reader can follow.
 *
 * Returning the PATH rather than a boolean matters: "these two disagree" is a report
 * nobody can act on, and the failure this suite exists for is a single field — an instant,
 * a count, the details of a refusal.
 */
function firstDifference(ps, node, at = "") {
  const bothObjects =
    ps && node && typeof ps === "object" && typeof node === "object" && !Array.isArray(ps) && !Array.isArray(node);
  if (bothObjects) {
    for (const key of [...new Set([...Object.keys(ps), ...Object.keys(node)])].sort()) {
      const where = firstDifference(ps[key], node[key], at ? `${at}.${key}` : key);
      if (where) return where;
    }
    return null;
  }
  if (Array.isArray(ps) && Array.isArray(node)) {
    if (ps.length !== node.length) return at || "(root)";
    for (let i = 0; i < ps.length; i += 1) {
      const where = firstDifference(ps[i], node[i], `${at}[${i}]`);
      if (where) return where;
    }
    return null;
  }
  return canonical(ps) === canonical(node) ? null : at || "(root)";
}

/** What both transports should have delivered, in one phrase, for the OK line. */
function delivered(observation) {
  if (observation.kind === "items") return `${observation.count} item(s)`;
  if (observation.kind === "web") return `the same file (status ${observation.status})`;
  if (observation.kind === "bytes") {
    return (
      `the world's log out of a ${observation.length}-byte zip ` +
      `(${observation.entry}, ${observation.text?.length ?? 0} character(s)), ` +
      `and powershell refusing the bytes it cannot carry`
    );
  }
  return "the same refusal";
}

/**
 * The text the world put in an artifact, found by the id in the request.
 *
 * This is what the Node side has to recover, and it is why the artifact case compares
 * against the WORLD rather than against the other transport's answer: the question is
 * whether a download survives the trip, not whether two sides agree about having skipped it.
 */
function artifactText(world, uri) {
  const id = /\/artifacts\/(\d+)\/zip/.exec(uri)?.[1];
  const artifact = (world.artifacts ?? []).find((candidate) => String(candidate.id) === id);
  return artifact ? artifact.body ?? "" : null;
}

/**
 * The Node transport's view of one case: the shipped fetch shim, read the way the Node
 * tools read it (`json()` for a value, `text()` for the details of a refusal).
 */
async function observeNode(worldPath, spec) {
  installFetchShim(worldPath);
  const init = { method: spec.method ?? "GET", headers: { Authorization: `Bearer ${spec.token}` } };
  if (spec.body) init.body = spec.body;
  const response = await fetch(spec.uri, init);
  if (!response.ok) {
    let message = null;
    try {
      await response.json();
    } catch (error) {
      message = error.message;
    }
    return { kind: "error", message, details: (await response.text()) || null };
  }
  // `bytes` first: a case that reads a download is also asked through Invoke-WebRequest on
  // the PowerShell side (`web`), and on this side there is only one fetch either way. What
  // the two flags mean is which SURFACE the other transport uses, not two kinds of reading.
  if (spec.bytes) {
    // Read the way the recovery pass reads a download: bytes, then its own zip reader.
    // Going through `unzipEntry` rather than checking a length is the point - whatever the
    // transport delivered has to be a zip the pass can actually open and read.
    const zip = Buffer.from(await response.arrayBuffer());
    const entry = unzipEntry(zip, spec.bytes.entry);
    return {
      kind: "bytes",
      length: zip.length,
      entry: spec.bytes.entry,
      text: entry ? entry.toString("utf8") : null,
    };
  }
  if (spec.web) return { kind: "web", status: response.status, content: await response.text() };
  const value = await response.json();
  const items = value === null ? [] : Array.isArray(value) ? value : [value];
  return { kind: "items", count: items.length, items };
}

/**
 * The PowerShell transport's answers to EVERY case, from ONE session.
 *
 * One engine launch for the whole leg instead of one per case: an engine launch is the
 * better part of a second and each case was paying it, for ten questions the same session
 * can ask. The transport under rehearsal (scripts/rehearse-sentinel-stub.ps1) does the same
 * thing one level down - one node child for the process rather than one per request - so the
 * cases share that too, and so does the sentinel rehearsal, whose worlds are built by that
 * same child.
 *
 * Nothing about what is COMPARED changes: the actor dot-sources the same stub, asks each
 * case in its own scope, and prints the same observation it would have printed alone - the
 * committed baseline is unchanged by this, which is the evidence that it did.
 *
 * Observations are keyed by the case they NAME rather than by the order the lines arrived
 * in: pairing by position would let a session that lost one case compare one case's answer
 * with another's question, which is exactly the kind of agreement this rehearsal exists to
 * catch. A case with no observation is reported as a failed CASE.
 *
 * The case files reach the actor through a LIST FILE rather than as arguments: PowerShell's
 * `-File` mode binds only one value to an array parameter and takes the rest as positionals,
 * which fails on the second case (found on the first run of the batched version).
 *
 * @returns {{observations: Map<string, Record<string, any>>, error?: string, noise?: string}}
 */
function observePowerShell(engine, caseListPath, env) {
  const result = spawnSync(engine.command, [...engine.args, "-File", ACTOR, "-CaseList", caseListPath], {
    cwd: HERE,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // Generous, but bounded: one session for every case means something that hangs now
    // hangs the whole leg, and a run that never returns leaves nothing to read.
    timeout: 5 * 60 * 1000,
  });
  if (result.error) return { observations: new Map(), error: `could not run ${engine.command}: ${result.error.message}` };
  const out = lf(result.stdout ?? "");
  const observations = new Map();
  // Everything that is NOT an observation is kept as the reason a case may be missing: an
  // engine's warning, an error, the tail of a session that died. Printing the other cases'
  // observations there instead would bury the one line that says what happened.
  const strays = [];
  for (const line of out.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      strays.push(text);
      continue;
    }
    if (parsed && typeof parsed === "object" && typeof parsed.name === "string" && "observation" in parsed) {
      observations.set(parsed.name, parsed.observation);
      continue;
    }
    strays.push(text);
  }
  const stray = [...strays, ...lf(result.stderr ?? "").split("\n")]
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" | ");
  return { observations, noise: (stray || `<exit ${result.status}>`).slice(0, 400) };
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("usage: node scripts/rehearse-transports.mjs [--only <case>] [--keep]");
    return 0;
  }
  const onlyAt = args.indexOf("--only");
  const only = onlyAt >= 0 ? args[onlyAt + 1] : null;
  const keep = args.includes("--keep");
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const cases = only ? (fixture.cases ?? []).filter((c) => c.name === only) : fixture.cases ?? [];
  if (cases.length === 0) {
    console.error(
      only
        ? `--only ${JSON.stringify(only)} matches no case (have: ${(fixture.cases ?? []).map((c) => c.name).join(", ")})`
        : `no cases in ${FIXTURE}`,
    );
    return 2;
  }

  const world = {};
  for (const key of WORLD_KEYS) if (key in fixture) world[key] = fixture[key];
  const workDir = mkdtempSync(join(tmpdir(), "transport-rehearsal-"));
  const writeWorld = (name) => {
    const path = join(workDir, `${name}.world.json`);
    writeFileSync(path, `${JSON.stringify(world, null, 2)}\n`);
    return path;
  };
  const psWorld = writeWorld("powershell");
  const nodeWorld = writeWorld("node");

  // A machine with no PowerShell is a FAILED RUN, not a crash: the engine is the one
  // prerequisite this rehearsal cannot supply, and the message has to say so.
  let engine = null;
  try {
    engine = powerShell();
  } catch (error) {
    console.log(`TRANSPORT fixture=${FIXTURE} cases=${cases.length}`);
    console.log(`TRANSPORT FAIL (engine) no PowerShell to run the transport with: ${error.message}`);
    console.log(`TRANSPORT_DONE cases=${cases.length} failed=${cases.length}`);
    return 1;
  }
  const psEnv = {
    ...process.env,
    REHEARSAL_WORLD: psWorld,
    REHEARSAL_WORLD_SCRIPT: WORLD_SCRIPT,
    REHEARSAL_LEDGER: join(workDir, "powershell.ledger"),
  };

  console.log(`TRANSPORT fixture=${FIXTURE} cases=${cases.length}`);

  // Every case file first, then ONE session for all of them: the actor reads them in the
  // order given and names each answer, so the report does not depend on how many engines
  // were launched to produce it.
  const casePaths = cases.map((spec) => {
    const casePath = join(workDir, `${spec.name}.case.json`);
    writeFileSync(
      casePath,
      `${JSON.stringify(
        {
          name: spec.name,
          method: spec.method ?? "GET",
          uri: spec.uri,
          token: spec.token ?? "rehearsal-token",
          body: spec.body,
          web: Boolean(spec.web),
        },
        null,
        2,
      )}\n`,
    );
    return casePath;
  });
  // The list the actor reads, one case file per line, in the order the report reads.
  const caseListPath = join(workDir, "cases.txt");
  writeFileSync(caseListPath, `${casePaths.join("\n")}\n`);
  const session = observePowerShell(engine, caseListPath, psEnv);

  let failed = 0;
  for (const spec of cases) {
    // A session that could not run at all is a failed CASE for every case, so the report
    // names them the way the baseline's own lines do rather than collapsing into one line.
    if (session.error) {
      failed += 1;
      console.log(`TRANSPORT FAIL ${spec.name}: ${session.error}`);
      continue;
    }
    const observation = session.observations.get(spec.name);
    if (!observation) {
      failed += 1;
      console.log(
        `TRANSPORT FAIL ${spec.name}: the PowerShell session printed no observation for it - ${session.noise}`,
      );
      continue;
    }
    let node;
    try {
      node = await observeNode(nodeWorld, spec);
    } catch (error) {
      // A transport that answers with something unreadable is a FAILED CASE, not a crashed
      // rehearsal: a stack trace here would skip the report and the evidence lines below,
      // which are the one thing a failing run has to leave behind for whoever reads it.
      failed += 1;
      console.log(`TRANSPORT FAIL ${spec.name}: the node transport could not be read: ${error.message}`);
      continue;
    }
    if (spec.bytes) {
      // The declared asymmetry: each side is measured against what its own transport must
      // do with bytes, and the Node half against the world, not against the other's answer.
      const wanted = artifactText(world, spec.uri);
      const problems = [];
      if (wanted === null) problems.push(`the world has no artifact for ${spec.uri}, so the case proves nothing`);
      const must = spec.bytes.powershellMust;
      const refusal = observation.kind === "error" ? String(observation.message ?? "") : "";
      if (!refusal.includes(must)) {
        problems.push(`powershell should have refused with ${must}, but answered ${canonical(observation)}`);
      }
      if (node.kind !== "bytes" || node.text !== wanted) {
        problems.push(`node did not recover the world's log from the zip: ${canonical(node)}`);
      }
      if (problems.length) {
        failed += 1;
        console.log(`TRANSPORT FAIL ${spec.name}: ${problems.join("; ")}`);
        continue;
      }
      console.log(`TRANSPORT OK   ${spec.name}: ${delivered(node)}`);
      continue;
    }
    const where = firstDifference(observation, node);
    if (where) {
      failed += 1;
      console.log(`TRANSPORT FAIL ${spec.name}: the transports disagree at ${where}`);
      console.log(`  - powershell: ${canonical(observation)}`);
      console.log(`  - node:       ${canonical(node)}`);
      continue;
    }
    console.log(`TRANSPORT OK   ${spec.name}: both transports delivered ${delivered(node)}`);
  }

  if (failed > 0) {
    // The worlds and the ledger are the only copy of what was asked and answered, so they
    // are kept exactly when there is something to look at - and pointed at, in the report,
    // as the two declared machine-specific lines the parity comparison masks.
    console.log(`REHEARSAL_WORLDS ${workDir}`);
    console.log(`REHEARSAL_LOGS ${join(workDir, "powershell.ledger")}`);
  } else if (keep) {
    // To stderr, deliberately: stdout is the report, and a debugging flag must not make a
    // passing run read as a different result than the one every leg uploads.
    console.error(`--keep: left ${workDir} in place`);
  } else {
    rmSync(workDir, { recursive: true, force: true });
  }

  console.log("");
  console.log(`TRANSPORT_DONE cases=${cases.length} failed=${failed}`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1]?.endsWith("rehearse-transports.mjs")) {
  process.exit(await main(process.argv));
}
