#!/usr/bin/env node
/**
 * check-rehearsal-children.mjs: the process claim, as a check instead of a paragraph.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every rehearsal in this repo now rests on one number that no report can show and no stopwatch
 * can pin: a run keeps exactly ONE node child for its whole length — `scripts/rehearse-world.mjs
 * session --endpoint <path>`, the child that answers the harness's 24 worlds and the transport's
 * REST calls as two clients of one process. That is what the endpoint bought, and it is invisible
 * in the evidence the repository holds: the reports are byte-identical whether the run keeps one
 * child or a hundred, which is exactly why every baseline stayed put when the relay was removed.
 *
 * Measured by hand it was `peak=1 distinct_pids=1`; measured by hand it also caught a leak of one
 * child per scenario that no assertion in the suite would have noticed. A claim that is only ever
 * measured by hand is one nobody re-measures, so this file is that measurement run as a gate: it
 * watches from OUTSIDE the run — the process table, never the run's own word about itself — and it
 * fails when the count moves.
 *
 * WHAT IT CHECKS
 * --------------
 * It starts a leg (`npm run rehearse:<leg>`, the sentinel rehearsal by default) and samples the
 * process table for every process whose command line names the world script:
 *
 *   PEAK           the most world children alive AT ONCE. Above 1 means something started a second
 *                  child while the run's was still there — a per-world or per-request boot, or a
 *                  second OWNER: scripts/rehearse-world-session.ps1 hands the run's endpoint to
 *                  everything the owner starts, so a process that is not handed one starts a child
 *                  of its own.
 *   DISTINCT PIDS  every child the run used at all, whether or not two overlapped. A boot per world
 *                  or per request lands here even when the sampler happens to miss the overlap,
 *                  which is why BOTH numbers are reported and either one fails: a sampler can miss
 *                  a moment, it cannot miss a process that existed.
 *
 * WHAT IT DOES NOT DO: decide WHY a child was there. A second child is reported with the two
 * numbers, and the run's own output is what names the scenario or the process it came from.
 *
 * Self-test: `--command` runs something else instead of a leg, which is how this check is itself
 * rehearsed — a command that starts two world children must make it exit 1.
 *
 * Portability: POSIX reads /proc directly (no engine needed, and that is what CI runs); Windows
 * asks the process table through pwsh's CIM, which the rehearsal needs anyway. The POSIX reading is
 * exported and takes a `/proc`-shaped directory, so `tests/sentinel-rehearsal.test.ts` can drive the
 * rule that decides WHAT a child is from any platform - including the rule's own entry-point test,
 * which is what keeps a tool that merely preloads the world's fetch shim from reading as a child.
 *
 * Exit: 0 when the run kept one child. 1 when it kept more than one, with the numbers. 2 for a
 *       usage error, a leg that failed, or a machine whose process table cannot be read — a check
 *       that could not look must not report a pass.
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";

/** The child every rehearsal keeps, and the marker that finds it in a command line. */
const WORLD_SCRIPT = "rehearse-world.mjs";
/** How often the table is sampled on POSIX: fast enough that a boot of any real length is seen. */
const SAMPLE_MS = 25;
/** Flags that take the next argument as something to LOAD, so it is not the process's entry point. */
const PRELOAD_FLAGS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader"]);

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The PIDs naming the world script, right now, read from this process (POSIX).
 *
 * A process that exited between the listing and the read is not an error — it is a process that is
 * gone, and the next sample is the truth about what is running.
 */
export function procChildren(procRoot = "/proc") {
  const pids = [];
  for (const name of readdirSync(procRoot)) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    let cmdline;
    try {
      cmdline = readFileSync(join(procRoot, name, "cmdline"), "utf8");
    } catch {
      continue;
    }
    // NUL-separated argv: what the process was actually run with, which a command line only
    // approximates. The marker has to be named by a NODE process (a shell whose command line
    // merely mentions the script is the thing that STARTED a child, not a child) and the script has
    // to be its ENTRY POINT (a tool that only preloads the fetch shim — `node --import
    // .../rehearse-world.mjs scripts/recover-verdicts.mjs` — names the same file and is not a child
    // of it; measured, that false positive read as a second child in the lifecycle leg).
    const argv = cmdline.split("\0").filter(Boolean);
    if (!/(^|[\\/])node(\.exe)?$/.test(argv[0] ?? "")) continue;
    // Walk to the entry point: the first argument that is neither a flag nor a flag's VALUE. The
    // value matters for the preload flags - `--import file:///.../rehearse-world.mjs <tool>` is how
    // every Node actor here reaches the world's fetch shim, and the URL it names contains the script
    // (measured: without this the lifecycle leg read as a second child).
    const args = argv.slice(1);
    let entry = null;
    for (let at = 0; at < args.length && entry === null; at += 1) {
      if (!args[at].startsWith("-")) entry = args[at];
      else if (PRELOAD_FLAGS.has(args[at])) at += 1;
    }
    if (entry && entry.includes(WORLD_SCRIPT)) pids.push(pid);
  }
  return pids;
}

/**
 * A stream of samples — one array of PIDs per sample — for as long as it is read.
 *
 * On Windows the process table has no door but PowerShell, and asking it per sample would cost a
 * process start per sample (measured: more than the polling interval, which is how a short-lived
 * child gets missed). So ONE watcher is kept for the run and asked to poll for itself: the query's
 * own command line cannot match the marker because the marker is ASSEMBLED in it — `'*rehearse-' +
 * 'world.mjs*'` is never the contiguous string it looks for — so the watcher never counts itself
 * as a child of the run. It prints one PID per line and an empty line to end each sample.
 *
 * The engine is chosen the way scripts/rehearse-pwsh.mjs chooses a rehearsal's engine (pwsh first,
 * Windows PowerShell as the fallback) plus the `.exe` spellings: a caller that is not npm can fail
 * to resolve a bare `pwsh` (measured: from a Git Bash shell, `powershell` resolves and `pwsh` does
 * not). Either engine can read the process table, and a machine with neither says so instead of
 * reporting a count it never took.
 */
async function* samples() {
  if (process.platform !== "win32") {
    for (;;) {
      yield procChildren();
      await sleep(SAMPLE_MS);
    }
  }

  const [stem, rest] = WORLD_SCRIPT.split("-");
  // The same rule as the POSIX branch, said in a language Windows can answer: the process must BE
  // node (`Name = 'node.exe'`, so a shell that merely mentions the script is not a child — measured:
  // three matches for a command naming the script as an argument, only two of them node processes)
  // and the script must be its ENTRY POINT — the first argument after the executable. Windows hands
  // over a command line rather than an argv, so the first two tokens are matched out of it: that is
  // what excludes `node --import .../rehearse-world.mjs scripts/recover-verdicts.mjs`, a tool that
  // preloads the world's fetch shim (measured as a false second child) and the fixture a caller
  // passes the script path to. Flags before the entry point are not matched, and nothing in this
  // repository starts a world child that way.
  const query =
    "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" |" +
    " ForEach-Object {" +
    " $entry = [regex]::Match($_.CommandLine, '^\\s*(?:\"[^\"]*\"|\\S+)\\s+(?:\"([^\"]*)\"|(\\S+))');" +
    " if (-not $entry.Success) { return }" +
    " $named = if ($entry.Groups[1].Success) { $entry.Groups[1].Value } else { $entry.Groups[2].Value }" +
    ` if ($named -like ('*${stem}-' + '${rest}*')) { $_.ProcessId }` +
    " }; ''";
  const loop = `$ErrorActionPreference='Stop'; while ($true) { ${query}; Start-Sleep -Milliseconds 15 }`;
  let watcher = null;
  for (const engine of ["pwsh", "pwsh.exe", "powershell", "powershell.exe"]) {
    const attempt = spawn(engine, ["-NoProfile", "-NonInteractive", "-Command", loop], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const started = await new Promise((resolve) => {
      attempt.once("spawn", () => resolve(true));
      attempt.once("error", () => resolve(false));
    });
    if (started) {
      watcher = attempt;
      break;
    }
  }
  if (!watcher) {
    throw new Error("CHILDREN_UNREADABLE (no PowerShell to read the process table with)");
  }

  try {
    let buffer = "";
    let current = [];
    watcher.stdout.setEncoding("utf8");
    for await (const chunk of watcher.stdout) {
      buffer += chunk;
      let at = buffer.indexOf("\n");
      while (at !== -1) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf("\n");
        if (line === "") {
          yield current;
          current = [];
          continue;
        }
        const pid = Number.parseInt(line, 10);
        // The watcher cannot match itself, but its CALLER can: a shell command line carrying the
        // marker is not a world child.
        if (Number.isInteger(pid) && pid !== process.pid && pid !== watcher.pid) current.push(pid);
      }
    }
  } finally {
    watcher.kill();
  }
}

/**
 * Run one command to completion while sampling, and hand back its exit and the two counts.
 *
 * The command is spawned with a shell (so a caller can name an npm script or a small pipeline) and
 * its output is INHERITED: a leg that fails has its own report in the log, above this summary,
 * rather than swallowed by the watcher.
 */
async function watch(command) {
  let peak = 0;
  let taken = 0;
  const seen = new Set();
  let running = null;
  let firstSample = null;
  const reading = new Promise((resolve) => {
    firstSample = resolve;
  });

  // The watcher comes up FIRST, and the command starts only once a sample has been taken. A run
  // watched from its second sample on is a run whose first child can be missed, and that is not
  // hypothetical: on a loaded machine the first Windows sample took longer than a 1.5 s fixture
  // lived, and the gate reported zero children and PASSED.
  const sampling = (async () => {
    for await (const children of samples()) {
      taken += 1;
      if (children.length > peak) peak = children.length;
      for (const pid of children) seen.add(pid);
      firstSample();
      // The command has exited: one more sample is not going to tell us anything, and the stream
      // never ends by itself.
      if (running && (running.exitCode !== null || running.signalCode !== null)) return;
    }
  })();

  const watching = await Promise.race([reading.then(() => true), sleep(20_000).then(() => false)]);
  if (!watching) {
    console.error("CHECK_REHEARSAL_CHILDREN FAIL — CHILDREN_UNREADABLE (not one sample of the process table in 20s)");
    process.exit(2);
  }

  running = spawn(command, { shell: true, stdio: "inherit" });
  const during = taken;
  const state = await new Promise((resolve) => running.on("exit", (code, signal) => resolve({ code, signal })));
  await sampling;
  return { ...state, peak, distinct: seen.size, samples: taken - during };
}

/**
 * The check, as the command line runs it.
 *
 * A function rather than top-level statements because this module is IMPORTED by its own test (the
 * POSIX reading above): importing a check must not run one, and a check whose deciding code can only
 * be reached by running the whole thing is a check whose deciding code is never tested.
 */
async function main() {
  const leg = arg("leg") ?? "sentinels";
  const override = arg("command");
  if (override && arg("leg")) {
    console.error("usage: node scripts/check-rehearsal-children.mjs [--leg <name> | --command \"<command line>\"]");
    process.exit(2);
  }
  const label = override ? "command" : leg;
  const command = override ?? `npm run rehearse:${leg} --silent`;

  let result;
  try {
    result = await watch(command);
  } catch (error) {
    console.error(`CHECK_REHEARSAL_CHILDREN FAIL — ${error?.message ?? error}`);
    process.exit(2);
  }

  console.log(`CHILDREN ${label} peak=${result.peak} distinct_pids=${result.distinct} samples=${result.samples}`);

  // A check that looked too rarely to see anything is not evidence, whatever the counts say (this is
  // the failure that made the watcher start first: zero samples used to read as "no children").
  if (result.samples < 1) {
    console.error(
      "CHECK_REHEARSAL_CHILDREN FAIL — CHILDREN_UNREADABLE (not one sample of the process table while the run was alive, so nothing above is evidence about it)",
    );
    process.exit(2);
  }

  if (result.code !== 0) {
    // Reported separately from the counts: a leg that failed is not evidence about the counts, and
    // saying "one child" for a run that died half way through would be the wrong kind of green.
    console.error(
      `CHECK_REHEARSAL_CHILDREN FAIL — the run exited ${result.code ?? result.signal}, so the counts above are not evidence about a full run`,
    );
    process.exit(2);
  }

  if (result.peak > 1 || result.distinct > 1) {
    console.error(
      `CHECK_REHEARSAL_CHILDREN FAIL — the run used ${result.distinct} world child(ren), ${result.peak} of them at once, where a rehearsal keeps ONE ` +
        `(scripts/rehearse-world-session.ps1: the process that starts the child publishes its endpoint, and everything the run starts connects as a client of it rather than starting another)`,
    );
    process.exit(1);
  }

  console.log(`CHECK_REHEARSAL_CHILDREN OK — one world child, for the whole run (${label})`);
}

if (process.argv[1] && basename(process.argv[1]) === "check-rehearsal-children.mjs") {
  await main();
}
