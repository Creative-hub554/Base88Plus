#!/usr/bin/env node
/**
 * rehearse-world.mjs: the simulated GitHub that every rehearsal reads.
 *
 * WHY THIS EXISTS
 * ---------------
 * The tools that keep this repo honest are a chain, not four islands: a verifier
 * computes a verdict and posts it to issue #18; the heartbeat auditor asks whether
 * that record landed; the recovery pass re-posts one that was computed and lost;
 * the day-after sentinels trip on the days the chain did not land and retire when
 * it does. Each of them had its own rehearsal, and each rehearsal built its own
 * little world - so the thing that actually fails in production, a HANDOFF between
 * two of them, had nowhere to be exercised.
 *
 * This file is that world, once. It is a router over a JSON world file: the runs,
 * the issue, its comments, the workflow list, run jobs, artifacts, commits,
 * contents, pulls. The PowerShell tools reach it through
 * scripts/rehearse-sentinel-stub.ps1 (which marshals Invoke-RestMethod into the `serve` CLI
 * below); the Node tools reach it through installFetchShim(), which
 * replaces global fetch in their process. One interpreter, two transports - so a
 * fact about the world cannot mean two things depending on which language asked.
 *
 * The world file is also where time lives. `clock` stamps whatever a tool posts,
 * so a scenario can walk a timeline (the cron day, the morning after, the day the
 * recovery ran) without any tool being told what day it is.
 *
 * NOTHING HERE REACHES THE NETWORK, and nothing can: an unrouted request is an
 * error, not a forward. The token a rehearsal passes is fake on purpose, so even
 * a mis-wired run fails at the far end rather than posting a false record.
 *
 * Usage
 *   node scripts/rehearse-world.mjs serve --world <file> --method GET --uri <url> \
 *     [--body-file <request body>]
 *   node scripts/rehearse-world.mjs session --endpoint <path>   # the ONE child: see below
 *   node scripts/rehearse-world.mjs materialize --fixture <f> --scenario <name> \
 *     --witness <wf> --clock <iso> --out <file> [--extra-comments <f>]
 *
 * `session` is the child a rehearsal KEEPS, and it answers both questions the rehearsals ask
 * of this file: the REST calls a simulated transport marshals (a `route` request) and the
 * world those calls are answered from (a `materialize` request). It used to be two children -
 * the transport kept one router per WORLD, because the world was an argument the child was
 * started with and the sentinel rehearsal walks seventeen of them, and the rehearsal kept a
 * second child to write those worlds. What makes one child enough is the same thing that made
 * the second one necessary: everything a question needs travels IN it (the world, the method,
 * the URI, the body; or the fixture, the scenario, the witness, the clock and the output
 * path), so the only thing this process holds is parsed fixtures, by path - one per run, and
 * the run's worlds are all built from a COPY of their scenario.
 *
 * It is reached over a LOCAL ENDPOINT rather than over its own stdin, and that is what lets
 * more than one process ask it: a rehearsal's driver and the transport inside its child are
 * different processes, and neither has to relay a question for the other. The endpoint is a
 * named pipe on Windows and a Unix socket in the run's own directory elsewhere; no IP socket
 * is ever opened, and only processes on this machine can reach it. Its stdin is the LIFETIME
 * pipe instead - the owner holds it, and closing it stops the child, so a rehearsal that dies
 * cannot leave one behind.
 *
 * One line in, one line out, both base64 of UTF-8 JSON: a request carries filesystem paths
 * and comment bodies, and a frame whose meaning depended on a codepage would be a rehearsal
 * rehearsing the wrong world. The shape is stated where its clients are
 * (scripts/rehearse-world-session.ps1 for PowerShell, answerFrame below), and the lifecycle
 * rehearsal reads the same file through installFetchShim() instead.
 *
 * Every path builds the world through the SAME function (writeScenarioWorld below), so the
 * command, the endpoint and the fetch shim cannot produce three shapes of world.
 *
 * The CLI prints one JSON envelope: { status, kind, value | items | content |
 * base64 | message, mutated }. `kind` is what the caller must reshape - "array"
 * is a top-level JSON array (which PowerShell unrolls item by item, the Hazard the
 * scripts' @(...) wraps exist to survive), "object" is a JSON object, "web" is a
 * raw file (Invoke-WebRequest), "binary" is bytes (an artifact zip). The session
 * frames the same envelope (see serveSession) rather than redefining it.
 *
 * The `--import` shim:
 *   REHEARSAL_WORLD=<file> REHEARSAL_SHIM=1 node --import ./scripts/rehearse-world.mjs \
 *     scripts/recover-verdicts.mjs
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

/** The API root every consumer builds its URLs from. */
const API_ROOT = /^https?:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+/;

/** Read a world. Throws rather than inventing one: a missing world is a broken rehearsal. */
export function loadWorld(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Write a world back. The router is the only writer while a step runs. */
export function saveWorld(path, world) {
  writeFileSync(path, `${JSON.stringify(world, null, 2)}\n`);
}

// ------------------------------------------------------------------- replies

const okObject = (value) => ({ status: 200, kind: "object", value });
const okArray = (items) => ({ status: 200, kind: "array", items });
const okWeb = (content) => ({ status: 200, kind: "web", content });
const okBinary = (data) => ({ status: 200, kind: "binary", data });

/** A refusal, phrased the way the API phrases it - the scripts parse that text. */
function refuse(status, reason, details) {
  return {
    status,
    kind: "error",
    message: `Response status code does not indicate success: ${status} (${reason}).`,
    details: details ?? null,
  };
}

// ------------------------------------------------------------------- queries

/**
 * GitHub's `created=` filter: a bare date, `A..B`, or a mix. Day-granularity
 * endpoints are inclusive at both ends, which is why a date-only bound expands to
 * the whole day - the sentinels' windows are written that way.
 */
export function inCreatedWindow(instant, spec) {
  if (!spec) return true;
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return false;
  const [lo, hi] = String(spec).split("..");
  const lower = lo ? Date.parse(lo.includes("T") ? lo : `${lo}T00:00:00Z`) : null;
  const upper = hi ? Date.parse(hi.includes("T") ? hi : `${hi}T23:59:59.999Z`) : hi === "" ? null : lower;
  if (lower !== null && at < lower) return false;
  if (upper !== null && at > upper) return false;
  return true;
}

const inSpan = (instant, since, until) => {
  const at = Date.parse(instant);
  if (since && at < Date.parse(since)) return false;
  if (until && at > Date.parse(until)) return false;
  return true;
};

/** Newest first, the order the runs endpoint returns them in. */
const newestFirst = (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at);
/** Oldest first, the order the comments endpoint returns them in. */
const oldestFirst = (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at);

/**
 * A world entry as the API would send it.
 *
 * A world file carries more than the API does - which workflow a run belongs to,
 * what text an artifact holds - and those fields are how the router answers, not
 * what GitHub says. Serving them would let a script read something no real response
 * contains, so a rehearsal could pass on a field that does not exist.
 */
const without = (record, ours) => {
  const out = { ...record };
  for (const key of ours) delete out[key];
  return out;
};

// ------------------------------------------------------------------ the zip

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * One STORED entry, as an Actions artifact zip. Written rather than compressed
 * because the reader on the other side (recover-verdicts.mjs) has its own zip
 * reader over node:zlib, and what the rehearsal needs to exercise is the read
 * path, not our ability to deflate. The central directory is real, so the reader
 * finds the entry the same way it finds one GitHub produced.
 */
export function zipEntry(name, text) {
  const nameBuf = Buffer.from(name, "utf8");
  const data = Buffer.from(text, "utf8");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt16LE(0, 10); // mod time
  local.writeUInt16LE(0x2821, 12); // mod date: 2000-01-01
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x2821, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38); // internal attributes
  central.writeUInt32LE(0, 42); // local header offset

  const centralOffset = local.length + nameBuf.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}

// ------------------------------------------------------------------- routing

/**
 * Answer one request against `world`, mutating it in place when the request
 * writes. Returns the envelope described at the top of this file; `mutated` tells
 * the caller whether the world has to be written back.
 *
 * Every route the four tools actually ask for is here. Anything else is an error
 * and never a pass-through: a rehearsal that silently reached GitHub would be
 * worse than no rehearsal.
 */
/** The token a request carries, so the world can decide what it may write. */
export function tokenOf(headers) {
  if (!headers) return null;
  const raw = typeof headers.get === "function" ? headers.get("authorization") : headers.Authorization ?? headers.authorization;
  if (!raw) return null;
  return String(raw).replace(/^Bearer\s+/i, "");
}

export function route(world, method, rawUrl, body = null, token = null) {
  const verb = String(method ?? "GET").toUpperCase();

  // --- a raw file (Invoke-WebRequest against raw.githubusercontent.com) ---
  if (!API_ROOT.test(rawUrl)) {
    const content = (world.raw ?? {})[rawUrl];
    if (content === undefined) return { ...refuse(404, "Not Found"), message: `REHEARSAL_UNROUTED ${verb} ${rawUrl}` };
    return okWeb(content);
  }

  const url = new URL(rawUrl);
  // The repo prefix is on the HOST side of the URL, the routes on the path side.
  const path = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "") || "/";
  const q = url.searchParams;
  const perPage = Number(q.get("per_page") ?? 30) || 30;

  // --- workflows ---
  if (path === "/actions/workflows") {
    return okObject({ total_count: (world.workflows ?? []).length, workflows: world.workflows ?? [] });
  }
  if (path.startsWith("/actions/workflows/")) {
    const rest = path.slice("/actions/workflows/".length);
    const slash = rest.indexOf("/");
    const file = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
    const wf = (world.workflows ?? []).find((w) => w.file === file);
    if (!wf) return refuse(404, "Not Found");
    if (slash === -1) return okObject(wf);
    if (rest.slice(slash + 1) === "runs") {
      let runs = (world.runs ?? []).filter((r) => r.workflow === file);
      if (q.get("event")) runs = runs.filter((r) => r.event === q.get("event"));
      if (q.get("head_sha")) runs = runs.filter((r) => r.head_sha === q.get("head_sha"));
      if (q.get("created")) runs = runs.filter((r) => inCreatedWindow(r.created_at, q.get("created")));
      runs.sort(newestFirst);
      const page = runs.slice(0, perPage).map((r) => without(r, ["workflow"]));
      return okObject({ total_count: runs.length, workflow_runs: page });
    }
    return refuse(404, "Not Found");
  }

  // --- one run, its jobs, its artifacts ---
  let m = /^\/actions\/runs\/(\d+)$/.exec(path);
  if (m && verb === "GET") {
    const run = (world.runs ?? []).find((r) => String(r.id) === m[1]);
    if (!run) return refuse(404, "Not Found");
    return okObject(without(run, ["workflow"]));
  }
  m = /^\/actions\/runs\/(\d+)\/jobs$/.exec(path);
  if (m) return okObject({ total_count: 0, jobs: (world.run_detail?.[m[1]]?.jobs ?? []).slice(0, perPage) });
  m = /^\/actions\/runs\/(\d+)\/artifacts$/.exec(path);
  if (m) {
    const artifacts = (world.artifacts ?? [])
      .filter((a) => String(a.run) === m[1])
      .slice(0, perPage)
      .map((a) => without(a, ["run", "log", "body"]));
    return okObject({ total_count: artifacts.length, artifacts });
  }
  m = /^\/actions\/artifacts\/(\d+)\/zip$/.exec(path);
  if (m) {
    const artifact = (world.artifacts ?? []).find((a) => String(a.id) === m[1]);
    if (!artifact) return refuse(404, "Not Found");
    // The uploaded artifact is a zip holding the log; the workflow produced the
    // text, this wraps it the way actions/upload-artifact did.
    return okBinary(zipEntry(artifact.log ?? "run.log", artifact.body ?? ""));
  }

  // --- repo content ---
  if (path === "/commits") {
    let commits = (world.commits ?? {})[q.get("path") ?? ""] ?? [];
    commits = commits.filter((c) => inSpan(c.commit?.author?.date ?? c.created_at, q.get("since"), q.get("until")));
    return okArray(commits.slice(0, perPage));
  }
  if (path.startsWith("/contents/")) {
    const file = decodeURIComponent(path.slice("/contents/".length));
    const content = (world.contents ?? {})[file];
    if (!content) return refuse(404, "Not Found");
    return okObject({ ...content, content: Buffer.from(JSON.stringify(content.json ?? content.text ?? ""), "utf8").toString("base64") });
  }
  if (path === "/pulls") {
    const pulls = (world.pulls ?? []).filter((p) => !q.get("state") || p.state === q.get("state"));
    return okArray(pulls.slice(0, perPage));
  }

  // --- the issue, its comments ---
  m = /^\/issues\/(\d+)$/.exec(path);
  if (m) {
    if (verb === "PATCH") {
      const patch = body ? JSON.parse(body) : {};
      if (patch.state) world.issue.state = patch.state;
      world.issue.closed_at = patch.state === "closed" ? world.clock : null;
      return { ...okObject(world.issue), mutated: true };
    }
    return okObject({ ...world.issue, comments: (world.comments ?? []).length });
  }
  m = /^\/issues\/(\d+)\/comments$/.exec(path);
  if (m) {
    if (verb === "POST") {
      // What the issue does with a write is the WORLD's decision, not the
      // rehearsal's: a scenario where a record is lost has to be the API refusing,
      // and GitHub's refusal is about the TOKEN ("Resource not accessible by
      // integration" is a missing scope, which is literally what broke the Oct 3
      // chain: oct3-verify.yml posted without `issues: write`). So the world
      // decides per token, and a rehearsal walks the timeline by changing which
      // credential is posting - not by telling the tool to behave differently.
      if ((world.post?.deny ?? []).includes(token)) {
        return refuse(403, "Forbidden", JSON.stringify({ message: "Resource not accessible by integration" }, null, 2));
      }
      const comment = {
        id: world.next_comment_id ?? 9000000000,
        created_at: world.clock,
        body: body ? JSON.parse(body).body : "",
      };
      world.next_comment_id = comment.id + 1;
      world.comments = [...(world.comments ?? []), comment];
      return { ...okObject(comment), mutated: true };
    }
    const since = q.get("since");
    const comments = (world.comments ?? []).filter((c) => !since || Date.parse(c.created_at) >= Date.parse(since));
    return okArray(comments.slice(0, perPage).sort(oldestFirst));
  }

  return { ...refuse(404, "Not Found"), message: `REHEARSAL_UNROUTED ${verb} ${rawUrl}` };
}

// -------------------------------------------------------------- the fixtures

/**
 * Materialise a world for one scenario of scripts/sentinel-rehearsal.json.
 *
 * That fixture states a scenario as the CHANGES it makes to an otherwise empty
 * world - a few runs, a few comments, an issue state - because a day-after sentinel
 * reads little else. This turns it into a world file: the runs are attributed to
 * the chain that scenario's sentinel witnesses (the caller derives that from the
 * contract, so the fixture does not restate it), and nothing is invented.
 *
 * The same function materialises the world a scenario is RE-RUN against once the
 * recovery pass has posted the record it rebuilt: `extraComments` is that comment,
 * which is how "the sentinel recognises its own recovered record" is asked of the
 * sentinel rather than of a regex.
 */
export function worldFromScenario(scenario, { witness, clock, extraComments = [] }) {
  return {
    clock,
    issue: scenario.issue,
    comments: [...(scenario.comments ?? []), ...extraComments],
    // The chain this scenario's sentinel watches, registered the way the Actions
    // API registers a workflow: a sentinel that asks for a run list of a workflow
    // GitHub has never heard of gets a 404, not a run list. `created_at` is pinned
    // well before the scenario's dates - the heartbeat bounds its due slots by it.
    workflows: [
      {
        file: witness,
        name: witness.replace(/\.yml$/, ""),
        path: `.github/workflows/${witness}`,
        state: "active",
        created_at: "2026-08-01T00:00:00Z",
      },
    ],
    runs: (scenario.runs ?? []).map((run) => ({ ...run, workflow: witness, event: "schedule" })),
    post: { behavior: "accept" },
    next_comment_id: 9100000000,
  };
}

// ----------------------------------------------------------------------- CLI

/** The envelope the PowerShell stub consumes: JSON only, bytes as base64. */
export function envelope(result) {
  return JSON.stringify({
    status: result.status,
    kind: result.kind,
    value: result.value ?? null,
    items: result.items ?? null,
    content: result.content ?? null,
    base64: result.data ? Buffer.from(result.data).toString("base64") : null,
    message: result.message ?? null,
    details: result.details ?? null,
    mutated: Boolean(result.mutated),
  });
}

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1];
}

/**
 * A world file built from one scenario: the ONE place a rehearsal's world is written.
 *
 * The `materialize` CLI and the session that answers it on its endpoint both go through this,
 * so "the same world" is a property of the code rather than a promise kept by hand.
 */
function writeScenarioWorld(outPath, scenario, { witness, clock, extraComments = [] }) {
  saveWorld(outPath, worldFromScenario(scenario, { witness, clock, extraComments }));
  return outPath;
}

/** One frame of the writer's protocol: base64 of UTF-8 JSON, so the wire is ASCII. */
const frame = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

/**
 * The ONE child a rehearsal keeps, answering both roles until its owner closes its stdin:
 * `session --endpoint <path>`.
 *
 * A line in is base64 of one of two requests:
 *
 *   { kind: "route", world, method, uri, token, body }
 *   { kind: "materialize", fixture, scenario, witness, clock, out, extraComments }
 *
 * and a line out is base64 of the answer to that request:
 *
 *   { kind: "route", envelope }              the envelope the `serve` CLI prints
 *   { kind: "materialize", out }             the world file that was written
 *   { kind: "materialize", error }           why it could not be written
 *   { kind: "refusal", error, envelope }     the line or the kind could not be read at all
 *
 * The refusal carries BOTH readers' form of the same fact, which is the point of one child
 * for two callers: the transport parses the envelope and throws on its status (that is how a
 * rehearsal sees a reason instead of a dead child), and whatever asked for a world reports the
 * error text. The two roles are otherwise identical to the two children they replace, request
 * for request.
 *
 * The world and the fixture are per REQUEST rather than per process. That is what makes one
 * child possible: a session that held either at startup would have to be replaced whenever it
 * moved, and the sentinel rehearsal moves the world into a new file for each of its sixteen
 * scenarios (and a second time for the eight that file a record). A world is still re-read
 * from its FILE per request, so a scenario's timeline (a comment one tool posts, read by the
 * next) moves through the file and not through this process's memory.
 *
 * EVERY CLIENT GETS THE SAME ANSWER, whoever asks: one request line on a connection is
 * answered on that connection, and requests are handled one at a time because this process is
 * a single thread - a rehearsal's driver asking for a world and the transport in its child
 * asking a question are serialised by the protocol, not by a lock. The lifecycle rehearsal
 * drives its steps one at a time for the same reason.
 */

/** The parsed fixture for a path, held for the life of the session. */
const fixtures = new Map();

/** A line nobody can read, phrased for both readers of this wire. */
function refuseFrame(reason) {
  return { kind: "refusal", error: reason, envelope: { ...refuse(400, "Bad Request"), message: reason } };
}

/** One request line, one answer object - the whole protocol, in one place. */
function answerFrame(line) {
  let request;
  try {
    request = JSON.parse(Buffer.from(String(line).trim(), "base64").toString("utf8"));
  } catch (error) {
    return refuseFrame(`REHEARSAL_ROUTER_BAD_REQUEST (${String(error?.message ?? error)})`);
  }

  if (request.kind === "materialize") {
    try {
      // Parsed once per path, and each request is built from a COPY of its scenario: this
      // process outlives the boots that used to re-read the fixture, so a builder that mutated
      // a scenario would quietly make a scenario's SECOND world (the echo, with the recovered
      // record on it) depend on its first, which no per-boot CLI could ever do.
      if (!fixtures.has(request.fixture)) {
        fixtures.set(request.fixture, JSON.parse(readFileSync(request.fixture, "utf8")));
      }
      const scenario = (fixtures.get(request.fixture).scenarios ?? []).find((s) => s.name === request.scenario);
      if (!scenario) throw new Error(`no scenario named ${JSON.stringify(request.scenario)}`);
      const extra = request.extraComments
        ? (JSON.parse(readFileSync(request.extraComments, "utf8")).comments ?? [])
        : [];
      const out = writeScenarioWorld(request.out, JSON.parse(JSON.stringify(scenario)), {
        witness: request.witness,
        clock: request.clock,
        extraComments: extra,
      });
      return { kind: "materialize", out };
    } catch (error) {
      // A refusal is an ANSWER, not a dead child: the session carries on, and one bad request
      // does not take a rehearsal's remaining worlds with it.
      return { kind: "materialize", error: `REHEARSAL_WORLD_FAILED ${String(error?.message ?? error)}` };
    }
  }

  if (request.kind && request.kind !== "route") {
    return refuseFrame(`REHEARSAL_ROUTER_BAD_REQUEST (unknown request kind ${JSON.stringify(request.kind)})`);
  }

  try {
    const world = loadWorld(request.world);
    const result = route(world, request.method ?? "GET", request.uri, request.body ?? null, request.token ?? null);
    if (result.mutated) saveWorld(request.world, world);
    return { kind: "route", envelope: result };
  } catch (error) {
    // Neither a world file that is not there nor a URI the router cannot read is fatal: the
    // spawning form died here and the transport saw a dead child instead of a reason.
    return { kind: "route", envelope: refuse(500, "Internal Server Error", String(error?.stack ?? error)) };
  }
}

/**
 * Serve both roles on a local endpoint until the owner closes this process's stdin.
 *
 * The endpoint's directory is this process's to make, and the socket file in it is this
 * process's to remove: a Unix socket is a file, and a school of stale ones in a temp directory
 * is how "which child is answering me" becomes unanswerable. On Windows the endpoint is a
 * named pipe, which is not a file at all and needs neither.
 *
 * A bind failure is LOUD (stderr and a non-zero exit): a session that could not take its own
 * endpoint would otherwise be a child every client fails to reach for reasons of its own.
 */
function serveSession(endpoint) {
  if (!endpoint) {
    console.error("session needs --endpoint <path>");
    process.exit(2);
  }
  try {
    mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
  } catch (error) {
    // Reported the way a bind failure is, because it is one from the clients' side: a session that
    // never listened is a child every client fails to reach for reasons of its own. (Measured with
    // a malformed endpoint: the raw `mkdir` stack was what a maintainer got instead of this.)
    console.error(`REHEARSAL_SESSION_UNAVAILABLE (could not prepare ${endpoint}: ${error?.message ?? error})`);
    process.exit(1);
  }
  const server = createServer((connection) => {
    const lines = createInterface({ input: connection });
    lines.on("line", (line) => {
      const answer = `${frame(answerFrame(line))}\n`;
      // A client that hung up mid-answer is that client's problem, not the session's: the
      // remaining clients still have a child.
      try {
        connection.write(answer);
      } catch {
        /* the connection is gone; nothing to report to it */
      }
    });
    connection.on("error", () => {
      /* a client that broke its pipe is not a reason to stop answering others */
    });
  });
  server.on("error", (error) => {
    console.error(`REHEARSAL_SESSION_UNAVAILABLE (could not listen on ${endpoint}: ${error?.message ?? error})`);
    process.exit(1);
  });
  server.listen(endpoint);

  // The LIFETIME pipe, and the whole of the stop: the owner holds this process's stdin, and
  // closing it - because the rehearsal finished, or because it died and the handle closed with
  // it - ends the session. Nothing else can: a client closing its connection is a client
  // leaving, not the run ending.
  const keepAlive = createInterface({ input: process.stdin });
  keepAlive.on("close", () => {
    try {
      unlinkSync(endpoint);
    } catch {
      /* a named pipe has no file to remove, and a missing one needs no removing */
    }
    process.exit(0);
  });
}

function cli() {
  if (process.argv[2] === "materialize") {
    const fixturePath = arg("fixture");
    if (!fixturePath) {
      console.error("materialize needs --fixture, --scenario, --witness, --clock and --out");
      process.exit(2);
    }
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    const scenario = (fixture.scenarios ?? []).find((s) => s.name === arg("scenario"));
    if (!scenario) {
      console.error(`materialize: no scenario named ${JSON.stringify(arg("scenario"))}`);
      process.exit(2);
    }
    const extraFile = arg("extra-comments");
    const extra = extraFile ? (JSON.parse(readFileSync(extraFile, "utf8")).comments ?? []) : [];
    process.stdout.write(
      writeScenarioWorld(arg("out"), scenario, {
        witness: arg("witness"),
        clock: arg("clock"),
        extraComments: extra,
      }),
    );
    return;
  }
  // The rehearsals keep this process alive rather than booting one per question: same router,
  // same worlds, one line each way per client - and one child for both roles (see serveSession).
  if (process.argv[2] === "session") return serveSession(arg("endpoint"));
  if (process.argv[2] !== "serve") {
    console.error(
      "usage: rehearse-world.mjs serve --world <file> --method <M> --uri <url> [--body-file <f>]\n" +
        "       rehearse-world.mjs session --endpoint <path>              # the ONE child: routes and worlds\n" +
        "       rehearse-world.mjs materialize --fixture <f> --scenario <name> --witness <wf> --clock <iso> --out <file> [--extra-comments <f>]",
    );
    process.exit(2);
  }
  const worldPath = arg("world");
  if (!worldPath) {
    console.error("serve needs --world (the world file to answer from); the rehearsals keep `session --endpoint <path>` instead");
    process.exit(2);
  }
  const uri = arg("uri");
  if (!uri) {
    console.error("serve needs --uri (the request to answer)");
    process.exit(2);
  }
  const bodyFile = arg("body-file");
  const world = loadWorld(worldPath);
  const result = route(
    world,
    arg("method") ?? "GET",
    uri,
    bodyFile ? readFileSync(bodyFile, "utf8") : null,
    arg("token"),
  );
  if (result.mutated) saveWorld(worldPath, world);
  process.stdout.write(envelope(result));
}

// ------------------------------------------------------------------- the shim

/** A Response-shaped view of one routed request, for the Node tools. */
function responseFor(result) {
  // What a caller reads. A raw file is NOT a JSON document, so it is handed back as it
  // is: serialising it made `text()` return a JSON string QUOTING the file, and `json()`
  // parse that quoted string instead of the file - the same request meaning two things
  // depending on which transport asked, which is the one thing this shim exists not to
  // do. Nothing but a rehearsal reaches this branch today (the raw routes exist for the
  // verifiers' Invoke-WebRequest, and no Node tool fetches one), so the bug was invisible
  // until scripts/rehearse-transports.mjs asked both transports the same question.
  const text =
    result.kind === "error"
      ? result.message
      : result.kind === "binary"
        ? ""
        : result.kind === "web"
          ? result.content ?? ""
          : JSON.stringify(result.kind === "array" ? result.items : result.value ?? null);
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    headers: { get: () => null },
    async json() {
      if (result.kind === "error") throw new Error(result.message);
      return JSON.parse(text ?? "null");
    },
    async text() {
      return result.kind === "error" ? `${result.details ?? ""}` : (text ?? "");
    },
    async arrayBuffer() {
      const data = result.kind === "binary" ? result.data : Buffer.from(text ?? "", "utf8");
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    },
  };
}

/**
 * Replace global fetch with the world. Called through `node --import` before the
 * tool under rehearsal is loaded, so the tool's own code is untouched: the same
 * trick the PowerShell side plays by defining a function named Invoke-RestMethod.
 *
 * The world is re-read per request and written back when the request mutated it,
 * so a scenario's timeline (a comment posted by one tool, read by the next) is
 * shared with any PowerShell tool running against the same file.
 */
export function installFetchShim(worldPath) {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const world = loadWorld(worldPath);
    const result = route(world, init.method ?? "GET", url, init.body ?? null, tokenOf(init.headers));
    if (result.mutated) saveWorld(worldPath, world);
    return responseFor(result);
  };
}

if (process.env.REHEARSAL_SHIM === "1" && process.env.REHEARSAL_WORLD) {
  installFetchShim(process.env.REHEARSAL_WORLD);
}
// A subcommand is an explicit instruction and wins over the shim switch: a rehearsal that
// starts this file to keep it alive asks for `session`, and a REHEARSAL_SHIM it happened to
// inherit must not turn that into a process that never answers.
const asked = process.argv[2] === "serve" || process.argv[2] === "materialize" || process.argv[2] === "session";
if (process.argv[1]?.endsWith("rehearse-world.mjs") && (process.env.REHEARSAL_SHIM !== "1" || asked)) {
  cli();
}
