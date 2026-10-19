#!/usr/bin/env node
/**
 * The Node legs of `ci-ok`, run locally — so "green here" means what "green
 * there" means.
 *
 * WHY THIS EXISTS. `npm test` runs on whatever Node you happen to have. The
 * gate that decides a merge runs the same suite on EVERY BLOCKING LEG of the
 * release schedule (today 22 and 24), and those are not the version most people
 * work on: a maintainer on the newest release is running the CANARY, which is
 * deliberately non-blocking. So a green `npm test` was evidence about the
 * engine least likely to gate anyone — and the failure mode is the quiet one: a
 * suite that passes on 26 and fails on 22 is a red PR nobody saw coming, from a
 * machine that reported success.
 *
 * WHAT IT RUNS. The legs are COMPUTED, never hardcoded: the same
 * scripts/node-schedule.js classification CI's matrix job consumes, so a
 * promotion or an EOL demotion changes what this runs on the day it happens
 * (and a schedule that classifies to zero legs is refused, exactly as
 * scripts/ci-compute-matrix.js refuses it). The steps are READ OUT OF CI'S OWN
 * COMPOSITE ACTION (.github/actions/gates-steps/action.yml) rather than
 * transcribed: install, node contract, workflow contract, typecheck, lint,
 * tests, generated-app pins — in that order, because that is the order in the
 * file. A step that this tool cannot execute AS WRITTEN is a refusal (exit 2),
 * never a skip: an unrun check reported as a pass is the one failure mode a
 * verification tool must not have. The superlinearity gate is the one sequence
 * not in that action (CI runs it as its own job, pinned to the OLDEST leg, which
 * is why the oldest leg is where it runs here too); its commands are pinned
 * against ci.yml's `perf-gate` job, whose leg-resolution shell step is replaced
 * by this tool's own classification rather than shelled out to.
 *
 * WHAT IT DOES NOT RUN, said here rather than left to be assumed: the
 * rehearsals and rehearsal-parity are an ENGINE axis (PowerShell 7.x vs Windows
 * PowerShell 5.1), not a Node axis — a machine has one of each engine and CI
 * has both, so no runner can manufacture the second line locally. Run
 * `npm run rehearse:sentinels`, `rehearse:lifecycle` and `rehearse:transports`
 * for the engine you have. And the canary leg is `--canary`, ADVISORY: it can
 * never fail this run, because it can never fail a merge.
 *
 * WHERE THE RUNTIMES COME FROM, and why that is not a curl in a trench coat.
 * No version manager is required, because requiring one makes this tool useless
 * on the machine that needs it. Each leg's newest released patch is resolved
 * from nodejs.org's own index (the same document `nodejs.org/download` reads),
 * the official archive for this platform is downloaded into a gitignored cache,
 * and it is CHECKSUM-VERIFIED against the published SHASUMS256.txt before
 * anything is extracted or executed — a runtime with no published digest is
 * refused rather than run, and a mismatch deletes the download instead of
 * caching it. The extracted binary is then asked its own version and must
 * answer with the version that was resolved, so "the node 22 leg" is a fact
 * about the process that runs the tests rather than a label on a directory.
 * The limit of that chain is worth naming: the digest is fetched over TLS from
 * nodejs.org, so it is transport-trusted, not GPG-signed by this tool.
 *
 * `--node-bin <major>=<dir>` uses an install you already have instead (nvm,
 * fnm, volta, a system Node) — the major must match, and the patch is reported
 * as whatever that install answers, because a runtime this tool did not
 * download is a runtime it cannot vouch for beyond that.
 *
 * Exit: 0 every selected check passed on every leg; 1 a check failed on a leg
 * (with the step, the leg, and the output that says so); 2 it could not be run
 * — a usage error, no classifiable schedule, a platform with no published
 * build, a refusal to execute a step as written.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import semver from "semver";
import YAML from "yaml";

const require = createRequire(import.meta.url);
const { loadSchedule, classify } = require("./node-schedule.js");

/** Where a leg's newest patch is resolved from, and where its archive lives. */
const DEFAULT_INDEX = "https://nodejs.org/dist/index.json";
const DEFAULT_DIST = "https://nodejs.org/dist";
/** The cache, relative to the package root; gitignored, disposable, per-leg. */
const CACHE_DIRNAME = ".node-legs";
/** CI's own gate sequence: the single source of the steps this tool runs. */
const GATES_ACTION = path.join(".github", "actions", "gates-steps", "action.yml");
const CI_WORKFLOW = path.join(".github", "workflows", "ci.yml");
/**
 * The perf-gate job's commands, in its order. Pinned against ci.yml by
 * tests/check-legs.test.ts AND re-read at run time (perfCommands): a job that
 * grows an npm step this list does not have is a refusal, not a silent
 * half-run of somebody's required check.
 */
const PERF_COMMANDS = [["ci"], ["run", "check:perf"]];
/** How much failing output is kept to explain a failure. */
const TAIL_LINES = 60;

export const USAGE = `usage: node scripts/check-legs.mjs [options]

Runs CI's own gate sequence — and, on the oldest leg, the superlinearity gate —
on every BLOCKING Node leg the release schedule computes, each with a runtime
that is downloaded, checksum-verified, and asked its own version.

  --legs <list>          legs to run, comma-separated (default: the computed blocking legs)
  --canary               also run the computed canary leg, advisory (never fails this run)
  --only <step|list>     run one step of a leg's sequence; "list" names them
  --no-install           skip \`npm ci\` (reuses whatever node_modules holds now)
  --no-perf              skip the superlinearity gate (CI's perf-gate job, oldest leg)
  --node-bin <M>=<dir>   use an already-installed Node for major M instead of downloading
  --index <path|url>     release index to resolve versions from (default: nodejs.org/dist/index.json)
  --dist <base>          dist base for archives + SHASUMS256.txt (default: nodejs.org/dist)
  --cache <dir>          where downloaded runtimes are kept (default: <root>/.node-legs)
  --clean                delete the cached runtimes and exit
  --json                 one JSON object on stdout, and no step output on it either
  --keep-npm-env         keep the npm_config_* variables the launching npm exported (dropped by default)
  --help

exit 0: every selected check passed on every leg
exit 1: a check failed on a leg (the step, the leg, and its output are reported)
exit 2: it could not be run — usage error, no classifiable schedule, no published
        build for this platform, or a step this tool refuses to execute as written`;

/** A usage error (exit 2) — never a check's verdict. */
export class UsageError extends Error {}
/** A setup error (exit 2) — the run could not be made to mean anything. */
export class SetupError extends Error {}

/**
 * The environment a leg's steps run in: the caller's, minus the variables the
 * npm that launched this run put there.
 *
 * WHY THIS IS NOT PEDANTRY. A parent npm exports its own config as
 * `npm_config_*` into everything it spawns, and one of those —
 * `npm_config_allow_scripts`, added in npm 11.19 — is read by a NESTED npm as a
 * project-scoped `--allow-scripts`, which npm then refuses outright:
 *
 *     npm error code EALLOWSCRIPTS --allow-scripts is not allowed in
 *     project-scoped installs
 *
 * Measured here: `npm run check:legs` installs on the node 22 leg (npm 10,
 * which does not know the setting) and dies on the node 24 leg (npm 11), from
 * an environment CI cannot have — a runner has a `node` and an `npm`, not an
 * npm inside an npm. So they are dropped, and the names are PRINTED rather than
 * dropped quietly: a contributor who configured npm through the environment on
 * purpose can see what went and name it back with --keep-npm-env.
 *
 * What is NOT dropped: everything else, `PATH` above all, and `.npmrc` is
 * untouched — this is about inherited variables, not about the project's
 * configuration, which CI reads exactly as it is.
 */
/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ env: Record<string, string | undefined>, dropped: string[] }}
 */
export function scrubNpmEnv(env) {
  const kept = {};
  const dropped = [];
  for (const [key, value] of Object.entries(env)) {
    if (/^npm_config_/i.test(key)) dropped.push(key);
    else kept[key] = value;
  }
  dropped.sort();
  return { env: kept, dropped };
}

/**
 * Options, and nothing else: no I/O happens here, which is what lets the
 * command line be tested without a network or a runtime.
 */
export function parseArgs(argv) {
  const options = {
    legs: null,
    canary: false,
    only: null,
    install: true,
    perf: true,
    nodeBin: new Map(),
    index: null,
    dist: null,
    cache: null,
    clean: false,
    json: false,
    keepNpmEnv: false,
    help: false,
  };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    const value = () => {
      const next = argv[at + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`${arg} needs a value`);
      }
      at += 1;
      return next;
    };
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--legs":
        options.legs = parseLegList(value());
        break;
      case "--canary":
        options.canary = true;
        break;
      case "--only":
        options.only = value();
        break;
      case "--no-install":
        options.install = false;
        break;
      case "--no-perf":
        options.perf = false;
        break;
      case "--node-bin": {
        const [major, dir] = parseNodeBin(value());
        options.nodeBin.set(major, dir);
        break;
      }
      case "--index":
        options.index = value();
        break;
      case "--dist":
        options.dist = value();
        break;
      case "--cache":
        options.cache = path.resolve(value());
        break;
      case "--clean":
        options.clean = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--keep-npm-env":
        // The escape hatch for a machine that needs one of those variables
        // (an internal registry, a proxy) — named rather than assumed, because
        // dropping a setting a contributor relied on would be its own surprise.
        options.keepNpmEnv = true;
        break;
      default:
        throw new UsageError(`unknown option ${arg}`);
    }
  }
  return options;
}

/** `--legs 22,24` — a list of majors, deduped and ascending, or a refusal. */
export function parseLegList(text) {
  const majors = [];
  for (const part of String(text).split(",")) {
    const trimmed = part.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new UsageError(`--legs takes comma-separated major versions, got ${JSON.stringify(trimmed)}`);
    }
    const major = Number(trimmed);
    if (!majors.includes(major)) majors.push(major);
  }
  if (majors.length === 0) throw new UsageError("--legs names no leg");
  return majors.sort((a, b) => a - b);
}

/** `--node-bin 22=/path/to/install` — one leg, one install. */
export function parseNodeBin(text) {
  const at = String(text).indexOf("=");
  if (at <= 0) throw new UsageError(`--node-bin takes <major>=<dir>, got ${JSON.stringify(text)}`);
  const major = String(text).slice(0, at).trim();
  const dir = String(text).slice(at + 1).trim();
  if (!/^\d+$/.test(major)) {
    throw new UsageError(`--node-bin needs a major version before the "=", got ${JSON.stringify(major)}`);
  }
  if (dir === "") throw new UsageError("--node-bin needs a directory after the \"=\"");
  return [Number(major), path.resolve(dir)];
}

/**
 * The legs CI would run right now, from CI's own policy. Never a literal list:
 * a hardcoded [22, 24] here would be exactly the drift scripts/
 * check-node-contract.js exists to fail on, one file over.
 */
export async function classifyLegs({ schedule, now } = {}) {
  const source = schedule ?? (await loadSchedule());
  const { today, blocking, canary } = classify(source, now ?? process.env.NOW ?? undefined);
  if (blocking.length === 0) {
    throw new SetupError(
      `${today}: the release schedule classifies to ZERO blocking legs, so there is nothing a green run could mean ` +
        `(scripts/ci-compute-matrix.js refuses the same way)`,
    );
  }
  return { today, blocking, canary };
}

/**
 * CI's gate sequence, read out of the composite action BOTH the gates job and
 * the canary job use. Returning the file's own commands is the point: a tool
 * that transcribes a sequence is a tool that reports on last month's sequence.
 */
export function gateSteps(root) {
  const file = path.join(root, GATES_ACTION);
  let parsed;
  try {
    parsed = YAML.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new SetupError(`cannot read CI's gate steps from ${GATES_ACTION}: ${error.message}`);
  }
  const steps = parsed?.runs?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new SetupError(`${GATES_ACTION} has no runs.steps — the sequence this tool exists to run is gone`);
  }
  const commands = [];
  for (const step of steps) {
    if (typeof step?.run !== "string") continue; // `uses:` — set up by this tool's own runtime instead
    commands.push(shellCommand(step.run, `${GATES_ACTION} step ${JSON.stringify(step.name ?? "?")}`));
  }
  if (commands.length === 0) {
    throw new SetupError(`${GATES_ACTION} runs no commands — a green run there would gate nothing`);
  }
  return commands;
}

/**
 * The perf-gate job's npm commands, checked against ci.yml rather than assumed.
 *
 * The job's FIRST run step resolves the oldest blocking leg in shell and calls
 * it `version` — this tool computes the oldest leg itself (min of the
 * classification), so that step is not run; its OUTCOME is reproduced instead.
 * Any OTHER non-npm step in that job appears here as a refusal: CI would be
 * running something this tool does not, and quietly doing less than the gate is
 * the only real way for a local run to lie.
 */
export function perfCommands(root) {
  const file = path.join(root, CI_WORKFLOW);
  let parsed;
  try {
    parsed = YAML.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new SetupError(`cannot read ${CI_WORKFLOW}: ${error.message}`);
  }
  const job = parsed?.jobs?.["perf-gate"];
  if (!job || !Array.isArray(job.steps)) {
    throw new SetupError(`${CI_WORKFLOW} has no perf-gate job — the superlinearity gate this tool mirrors is gone`);
  }
  const commands = [];
  for (const step of job.steps) {
    if (typeof step?.run !== "string") continue;
    if (isLegResolution(step.run)) continue;
    commands.push(shellCommand(step.run, `${CI_WORKFLOW} perf-gate step ${JSON.stringify(step.name ?? "?")}`));
  }
  const shape = JSON.stringify(commands);
  if (shape !== JSON.stringify(PERF_COMMANDS)) {
    throw new SetupError(
      `the perf-gate job no longer runs ${JSON.stringify(PERF_COMMANDS)} but ${shape} — update PERF_COMMANDS (and its pin in ` +
        `tests/check-legs.test.ts) rather than letting this tool measure less than the gate does`,
    );
  }
  return commands;
}

/**
 * What one leg runs, in order.
 *
 * The whole sequence — including the perf job's own `npm ci`, which is not
 * redundant in a full run: CI installs afresh in that job too, and the point of
 * this tool is to run what CI runs rather than a tidied version of it. `--only`
 * is where that stops: a step NAMED by the operator is named once, and the
 * `ci` that both sequences start with is the same command on the same leg, so
 * running it twice would prove nothing twice.
 *
 * @param {{ steps: string[][], perf: string[][], leg: number, oldest: number,
 *   only?: string | null, install?: boolean }} selection
 * @returns {string[][]}
 */
export function selectSteps({ steps, perf, leg, oldest, only = null, install = true }) {
  const sequence = [...steps, ...(leg === oldest ? perf : [])].filter((argv) => install || stepId(argv) !== "ci");
  if (only === null) return sequence;
  const named = sequence.filter((argv) => stepId(argv) === only);
  const seen = new Set();
  return named.filter((argv) => {
    const id = stepId(argv);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** The one shell step in a job that is a choice of leg rather than a check. */
function isLegResolution(run) {
  return run.includes("GITHUB_OUTPUT") && run.includes("outputs.legs");
}

/**
 * One `run:` line as an argv, or a refusal.
 *
 * This tool spawns a command directly instead of handing the line to a shell:
 * no shell means no quoting surprises and no platform-specific `set -e`
 * semantics, and it means a line carrying shell syntax (a pipe, a variable, a
 * `&&`) is refused BY NAME rather than half-run. Every step CI uses today is a
 * plain npm invocation; the refusal is for the day one is not.
 */
export function shellCommand(run, where) {
  const line = run.replace(/\r?\n/g, " ").trim();
  if (/[|&;<>$()`]/.test(line)) {
    throw new SetupError(
      `${where} is not a plain command (${JSON.stringify(line)}) — this tool does not run shell syntax, and running a ` +
        `step it cannot reproduce as written would report on something other than the gate`,
    );
  }
  const argv = line.split(/\s+/).filter(Boolean);
  if (argv[0] !== "npm") {
    throw new SetupError(`${where} runs ${JSON.stringify(argv[0])}, not npm — this tool only executes npm steps`);
  }
  // `npm run <script> -- <args>` keeps its separator: the args after it belong
  // to the script, and dropping the `--` would hand them to npm instead.
  return argv.slice(1);
}

/** What a step is called in the summary and in `--only`: its npm script name. */
export function stepId(argv) {
  return argv[0] === "run" && argv[1] ? argv[1] : argv[0];
}

/** The newest released patch of each major, from the index nodejs.org publishes. */
export function resolveVersions(indexText, majors) {
  let rows;
  try {
    rows = JSON.parse(indexText);
  } catch (error) {
    throw new SetupError(`the release index is not JSON: ${error.message}`);
  }
  if (!Array.isArray(rows)) throw new SetupError("the release index is not an array of releases");
  const newest = new Map();
  for (const row of rows) {
    const parsed = semver.parse(row?.version);
    // A pre-release is not what a gate runs, whatever the index happens to hold.
    if (!parsed || parsed.prerelease.length > 0) continue;
    if (!majors.includes(parsed.major)) continue;
    const seen = newest.get(parsed.major);
    if (!seen || semver.gt(parsed, seen)) newest.set(parsed.major, parsed);
  }
  const resolved = new Map();
  for (const major of majors) {
    const parsed = newest.get(major);
    if (!parsed) {
      throw new SetupError(
        `the release index has no released ${major}.x — node ${major} cannot be run, and skipping it would leave the ` +
          `leg CI blocks on untested here`,
      );
    }
    resolved.set(major, parsed.version);
  }
  return resolved;
}

/**
 * The official archive for this platform, or a refusal naming why none exists.
 *
 * The dist's own platform id is not Node's: Windows is `win` in a filename and
 * `win32` to Node (`node-v22.23.3-win-x64.zip`), which is the kind of thing a
 * name assembled by hand gets wrong exactly once, silently, as a 404.
 */
export function archiveFor(version, platform = process.platform, arch = process.arch) {
  const distPlatform = { win32: "win", linux: "linux", darwin: "darwin" }[platform];
  if (!distPlatform) {
    throw new SetupError(`no official Node build is published for platform ${platform}`);
  }
  if (!["x64", "arm64"].includes(arch)) {
    throw new SetupError(`no official Node build is published for architecture ${arch}`);
  }
  const base = `node-v${version}-${distPlatform}-${arch}`;
  const kind = platform === "win32" ? "zip" : "tar.gz";
  return { base, file: `${base}.${kind}`, kind };
}

/** Where the executable is inside an extracted official runtime. */
export function runtimeBin(dir, platform = process.platform) {
  return platform === "win32" ? path.join(dir, "node.exe") : path.join(dir, "bin", "node");
}

/** The npm that came with a runtime, invoked through that runtime's own node. */
export function runtimeNpm(dir, platform = process.platform) {
  const node = runtimeBin(dir, platform);
  const cli = path.join(dir, "node_modules", "npm", "bin", "npm-cli.js");
  if (!fs.existsSync(cli)) {
    throw new SetupError(`${dir} has no bundled npm (${path.relative(dir, cli)}) — cannot run npm steps with it`);
  }
  return [node, cli];
}

/** The digest of a file, and the published one for it — or a refusal. */
export function verifyDigest(file, shasumsText, fileName) {
  const published = new Map();
  for (const line of String(shasumsText).split(/\r?\n/)) {
    const [digest, name] = line.trim().split(/\s+/);
    if (digest && name) published.set(name.replace(/^\*/, ""), digest.toLowerCase());
  }
  const expected = published.get(fileName);
  if (!expected) {
    throw new SetupError(
      `SHASUMS256.txt publishes no digest for ${fileName} — refusing to execute a runtime whose bytes nothing vouches for`,
    );
  }
  const actual = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (actual !== expected) {
    throw new SetupError(`${fileName} does not match its published digest (published ${expected}, downloaded ${actual})`);
  }
  return actual;
}

/**
 * The commands that could unpack an archive here, best first.
 *
 * Which one comes first is a PLATFORM fact, not a preference. On Windows the
 * zip is unpacked by PowerShell, deliberately not by the `unzip` that ships
 * with Git Bash: a Windows path handed to an MSYS binary by a Node `spawn`
 * (no shell to translate it) is read as `host:path`, and GNU tar answers
 * `Cannot connect to C: resolve failed` — a whole family of failures that
 * simply does not exist when PowerShell is asked to do it, since PowerShell
 * speaks Windows paths natively. `powershell` (5.1, present on every Windows)
 * is tried after `pwsh` (7, present on some) and before giving up.
 */
export function extractCommands(kind, file, dest, platform = process.platform) {
  if (kind === "tar.gz") return [{ program: "tar", args: ["-xzf", file, "-C", dest] }];
  if (platform === "win32") {
    const quote = (value) => value.replace(/'/g, "''");
    const expand = (program) => ({
      program,
      args: [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${quote(file)}' -DestinationPath '${quote(dest)}' -Force`,
      ],
    });
    return [expand("pwsh"), expand("powershell")];
  }
  return [{ program: "unzip", args: ["-q", "-o", file, "-d", dest] }];
}

/**
 * Run an argv, streaming it and keeping the tail. A missing program is
 * reported as such (code 127) rather than as a failing command, because the
 * difference between "the tool is not here" and "the tool said no" is the
 * difference between trying the next one and stopping.
 */
export function runCommand(argv, { cwd, env, onLine } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const tail = [];
    const push = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line === "") continue;
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
        if (onLine) onLine(line);
      }
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("error", (error) => {
      if (onLine) onLine(`${argv[0]}: ${error.message}`);
      finish({ code: error.code === "ENOENT" ? 127 : 126, error, tail });
    });
    child.on("close", (code, signal) => finish({ code: code === null ? 128 : code, signal, tail }));
  });
}

/**
 * Every selected step, in order, with the leg's runtime FIRST on PATH — because
 * a step is free to spawn `node` (vitest workers, next) and the whole point is
 * that it spawns the leg's, the way actions/setup-node arranges on a runner.
 *
 * A failing step stops THAT leg (a CI job stops at its first failing step) but
 * not the run: the other legs still run, matching the gates matrix's
 * fail-fast: false. A leg that stopped early reports the steps it never reached
 * as not run, which is not the same thing as passing.
 */
/**
 * @param {{ steps: string[][], runtime: string, cwd: string,
 *   env: Record<string, string | undefined>,
 *   onStep?: ((event: { phase: string, id: string, argv?: string[], index?: number,
 *     step?: { id: string, code: number, signal?: string | null, ms: number, tail: string[] } }) => void) | null,
 *   stream?: ((line: string) => void) | null }=} options
 */
export async function runSteps({ steps, runtime, cwd, env, onStep = null, stream = null } = {}) {
  const pathEnv = `${runtime}${path.delimiter}${env.PATH ?? env.Path ?? ""}`;
  const results = [];
  for (const [index, argv] of steps.entries()) {
    const id = stepId(argv);
    const startedAt = Date.now();
    if (onStep) onStep({ phase: "start", id, argv, index });
    const result = await runCommand([...runtimeNpm(runtime), ...argv], {
      cwd,
      env: { ...env, PATH: pathEnv, Path: pathEnv },
      onLine: stream,
    });
    const step = { id, argv, code: result.code, signal: result.signal, ms: Date.now() - startedAt, tail: result.tail };
    results.push(step);
    if (onStep) onStep({ phase: "end", step });
    if (result.code !== 0) {
      return { results, failed: step, remaining: steps.slice(index + 1) };
    }
  }
  return { results, failed: null, remaining: [] };
}

/** Where a leg's runtime comes from, and what it says it is. */
/**
 * @param {{ base: string, file: string, kind: string, version: string, cacheDir: string, distBase: string,
 *   cwd: string, env: Record<string, string | undefined>,
 *   fetchText: (source: string) => Promise<string>,
 *   stream?: ((line: string) => void) | null }=} options
 */
export async function ensureRuntime({
  base,
  file,
  kind,
  version,
  cacheDir,
  distBase,
  cwd,
  env,
  fetchText,
  stream = null,
} = {}) {
  const dir = path.join(cacheDir, base);
  if (fs.existsSync(runtimeBin(dir))) return { dir, downloaded: false };

  fs.mkdirSync(cacheDir, { recursive: true });
  const url = `${distBase}/v${version}/${file}`;
  if (stream) stream(`  downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new SetupError(`GET ${url} → HTTP ${response.status}`);
  const archive = path.join(cacheDir, file);
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));

  const digests = await fetchText(`${distBase}/v${version}/SHASUMS256.txt`);
  try {
    verifyDigest(archive, digests, file);
  } catch (error) {
    fs.rmSync(archive, { force: true }); // a bad download is not cached as a usable one
    throw error;
  }

  // Unpack beside the cache and move the tree in whole, so a directory in the
  // cache is a COMPLETE runtime rather than however far an interrupted extract
  // happened to get.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-leg-"));
  const commands = extractCommands(kind, archive, staging);
  let extracted = null;
  const attempts = [];
  for (const command of commands) {
    const result = await runCommand([command.program, ...command.args], { cwd, env });
    if (result.code === 0) {
      extracted = command.program;
      break;
    }
    attempts.push(`${command.program} exited ${result.code}`);
    if (!result.error || result.error.code !== "ENOENT") break; // present but failed: not a tool to switch away from
  }
  if (extracted === null) {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
    throw new SetupError(`could not unpack ${file} (${attempts.join("; ")})`);
  }
  fs.rmSync(archive, { force: true }); // the runtime is what is cached, not the archive
  const unpacked = path.join(staging, base);
  if (!fs.existsSync(unpacked)) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new SetupError(`${file} did not contain ${base}/ — the published archive is not shaped as expected`);
  }
  fs.renameSync(unpacked, dir);
  fs.rmSync(staging, { recursive: true, force: true });
  return { dir, downloaded: true };
}

/** A runtime's own answer about itself, and the assertion that it is the leg's. */
/**
 * @param {{ dir: string, major: number, version?: string | null, cwd: string,
 *   env: Record<string, string | undefined>, onLine?: ((line: string) => void) | null }=} options
 */
export async function assertRuntime({ dir, major, version = null, cwd, env, onLine = null } = {}) {
  const node = runtimeBin(dir);
  if (!fs.existsSync(node)) throw new SetupError(`${dir} has no node executable at ${path.basename(node)}`);
  const result = await runCommand([node, "-v"], { cwd, env, onLine });
  if (result.code !== 0) {
    throw new SetupError(`${node} -v exited ${result.code} — this runtime cannot be used to run a leg`);
  }
  const reported = (result.tail.join("") || "").trim();
  const parsed = semver.parse(reported.replace(/^v/, ""));
  if (!parsed) throw new SetupError(`${node} -v printed ${JSON.stringify(reported)}, which is not a version`);
  if (parsed.major !== major) {
    throw new SetupError(`${node} is node ${parsed.major}, not the node ${major} leg it was chosen for`);
  }
  if (version && parsed.version !== version) {
    throw new SetupError(
      `${node} is node ${parsed.version} but node ${version} was resolved and downloaded — refusing to report on a ` +
        `runtime other than the one the index named`,
    );
  }
  return parsed.version;
}

/** main(), in the order a run happens: parse, classify, acquire, execute, judge. */
export async function main(argv) {
  const out = (line) => process.stdout.write(`${line}\n`);
  const err = (line) => process.stderr.write(`${line}\n`);

  let options;
  try {
    options = parseArgs(argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      err(`CHECK_LEGS FAIL — ${error.message}`);
      err(USAGE);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    out(USAGE);
    return 0;
  }

  const root = process.cwd();
  const cacheDir = options.cache ?? path.join(root, CACHE_DIRNAME);
  const stream = options.json ? null : (line) => out(line);
  const say = options.json ? err : out;

  if (options.clean) {
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      say(`✓ removed ${cacheDir}`);
    } else {
      say(`✓ nothing cached at ${cacheDir}`);
    }
    return 0;
  }

  if (!fs.existsSync(path.join(root, "package.json"))) {
    throw new SetupError(`${root} has no package.json — run this from the package root, the way the npm scripts do`);
  }

  const fetchText = async (source) => {
    if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source);
      if (!response.ok) throw new SetupError(`GET ${source} → HTTP ${response.status}`);
      return response.text();
    }
    return fs.readFileSync(source, "utf8");
  };

  const indexSource = options.index ?? DEFAULT_INDEX;
  const distBase = (options.dist ?? DEFAULT_DIST).replace(/\/+$/, "");

  const steps = gateSteps(root);
  // Read even under `--only`, so a perf-gate job that grew a step this tool does
  // not have is a refusal on every run rather than only the long ones.
  const perf = options.perf ? perfCommands(root) : [];
  const only = options.only ?? null;
  // Before the schedule is asked for anything: naming the steps is not a run.
  if (only === "list") {
    for (const argv of [...steps, ...perf]) out(stepId(argv));
    return 0;
  }

  const { today, blocking, canary } = await classifyLegs();
  const legs = options.legs ?? blocking;
  const advisory = options.canary && canary !== null ? [canary] : [];
  const oldest = Math.min(...legs);

  say(
    `check legs — schedule as of ${today}: blocking [${blocking.join(", ")}]` +
      (canary === null ? ", no canary" : `, canary ${canary}`) +
      `${options.legs ? `; running the ${legs.join(", ")} you named` : ""}`,
  );
  say(`  CI's steps, from ${GATES_ACTION}: ${steps.map(stepId).join(" → ")}`);
  say(
    `  superlinearity gate: ${perf.length ? `on the oldest leg (node ${oldest}), as the perf-gate job runs it` : "skipped"}` +
      (advisory.length ? `; canary node ${advisory[0]} is advisory and cannot fail this run` : ""),
  );

  const versionSource = [...legs, ...advisory].filter((leg) => !options.nodeBin.has(leg));
  const versions =
    versionSource.length === 0 ? new Map() : resolveVersions(await fetchText(indexSource), versionSource);

  const { env, dropped } = options.keepNpmEnv ? { env: { ...process.env }, dropped: [] } : scrubNpmEnv(process.env);
  if (dropped.length > 0) {
    say(
      `  npm environment: dropped ${dropped.length} npm_config_* variable(s) the launching npm exported ` +
        `(${dropped.join(", ")}) — a nested npm reads them as flags CI never passes (--keep-npm-env keeps them)`,
    );
  }
  const legsReport = [];
  // Two kinds of bad news, and they are not the same exit code: a CHECK that
  // failed is the gate answering no (1), while a leg that could not be run at
  // all is this tool answering nothing (2). Reporting the second as the first
  // would be a verdict on a check that never happened.
  let checkFailed = null;
  let setupFailed = null;

  for (const leg of [...legs, ...advisory]) {
    const isAdvisory = advisory.includes(leg);
    const selected = selectSteps({ steps, perf, leg, oldest, only, install: options.install });
    say("");
    if (selected.length === 0) {
      say(`node ${leg}: no step selected — nothing run for this leg`);
      legsReport.push({ leg, advisory: isAdvisory, steps: [], skipped: true });
      continue;
    }

    const injected = options.nodeBin.get(leg) ?? null;
    const version = versions.get(leg) ?? null;
    const archive = version ? archiveFor(version) : null;
    let dir = injected;
    try {
      if (!injected) {
        const runtime = await ensureRuntime({
          ...archive,
          version,
          cacheDir,
          distBase,
          cwd: root,
          env,
          fetchText,
          stream,
        });
        dir = runtime.dir;
      }
      // The version is asked for and reported rather than streamed: it is this
      // tool's own question, and the answer is the header line below.
      const reported = await assertRuntime({
        dir,
        major: leg,
        version: injected ? null : version,
        cwd: root,
        env,
      });
      const origin = injected ? `${dir} (yours — not verified beyond its major)` : `${dir} (checksum-verified)`;
      say(`node ${leg} → v${reported}  ${origin}`);
      say(`  steps: ${selected.map(stepId).join(" → ")}`);

      const run = await runSteps({
        steps: selected,
        runtime: dir,
        cwd: root,
        env,
        stream,
        onStep: ({ phase, id, step }) => {
          const name = step ? step.id : id;
          if (phase === "end") {
            say(`  ${step.code === 0 ? "✓" : "✗"} node ${leg}: ${name} (${(step.ms / 1000).toFixed(1)}s)`);
          } else {
            say(`  … node ${leg}: ${name}`);
          }
        },
      });

      if (run.failed) {
        say(`  the output that says so (last ${run.failed.tail.length} line(s) of ${run.failed.id}):`);
        for (const line of run.failed.tail) say(`    ${line}`);
        if (run.remaining.length) {
          say(`  not run on this leg (a CI job stops at its first failing step): ${run.remaining.map(stepId).join(", ")}`);
        }
      }
      legsReport.push({
        leg,
        advisory: isAdvisory,
        version: reported,
        runtime: dir,
        steps: run.results.map(({ id, code, ms }) => ({ id, code, ms })),
        notRun: run.remaining.map(stepId),
        failed: run.failed ? run.failed.id : null,
      });
      // An advisory leg is reported and cannot fail the run — the canary's whole
      // definition (continue-on-error) and the reason a maintainer's own Node is
      // not evidence about the legs that gate.
      if (run.failed && !isAdvisory && !checkFailed) checkFailed = { leg, id: run.failed.id };
    } catch (error) {
      if (!(error instanceof SetupError)) throw error;
      if (!isAdvisory && !setupFailed) setupFailed = { leg, message: error.message };
      say(`✗ node ${leg}: ${error.message}`);
      legsReport.push({ leg, advisory: isAdvisory, error: error.message, steps: [] });
    }
  }

  const ranSteps = legsReport.reduce((total, leg) => total + leg.steps.length, 0);
  const summary = {
    date: today,
    blocking,
    canary,
    legs: legsReport,
    stepsPerLeg: steps.map(stepId),
    perfOnOldestLeg: oldest,
    passed: checkFailed === null && setupFailed === null,
    couldNotRun: setupFailed === null ? null : setupFailed.message,
  };
  if (options.json) out(JSON.stringify(summary, null, 2));

  say("");
  if (checkFailed) {
    err(
      `CHECK_LEGS FAIL — node ${checkFailed.leg}: ${checkFailed.id} failed; a check that fails here fails the gate ` +
        `(the other legs were still run, so a version-specific difference is visible above)`,
    );
    return 1;
  }
  if (setupFailed) {
    err(
      `CHECK_LEGS FAIL — node ${setupFailed.leg} could not be run: ${setupFailed.message}. Nothing was proved about ` +
        `that leg, which is not the same as it passing`,
    );
    return 2;
  }
  say(
    `CHECK_LEGS PASS — ${legs.length} leg(s), ${ranSteps} step(s): every check CI gates a merge on passed on ` +
      `[${legs.join(", ")}]` +
      (advisory.length ? `, and the advisory canary node ${advisory[0]} did not (which cannot fail this run)` : ""),
  );
  say(
    `not measured here: the rehearsals and rehearsal-parity (a PowerShell ENGINE axis, not a Node one) — ` +
      `npm run rehearse:sentinels && npm run rehearse:lifecycle && npm run rehearse:transports`,
  );
  if (!options.install) {
    say(`note: --no-install skipped \`npm ci\`, so the install step is not part of this verdict`);
  } else if (legsReport.some((leg) => leg.steps.some((step) => step.id === "ci"))) {
    // A CI runner is thrown away after its leg, so the install it left behind
    // never matters there. Here it does: the tree it is in is yours.
    const last = legsReport[legsReport.length - 1];
    say(
      `note: \`npm ci\` ran on the legs, so node_modules is now node ${last.leg}'s install (the last leg) — ` +
        `\`npm install\` puts it back under your own npm if you want that`,
    );
  }
  return 0;
}

if (process.argv[1] && path.basename(process.argv[1]) === "check-legs.mjs") {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((error) => {
      const message = error instanceof SetupError ? error.message : (error?.stack ?? String(error));
      process.stderr.write(`CHECK_LEGS FAIL — ${message}\n`);
      process.exit(2);
    });
}
