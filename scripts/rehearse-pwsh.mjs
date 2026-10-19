#!/usr/bin/env node
/**
 * rehearse-pwsh.mjs: run a PowerShell script with whichever PowerShell this
 * machine actually has, so a rehearsal is one command on a maintainer's Windows
 * box and on the Linux runner that gates merges.
 *
 * WHY THIS EXISTS
 * ---------------
 * CI is ubuntu-latest, where the executable is `pwsh` (PowerShell 7) and
 * `powershell` does not exist - and the cron workflows already run the SAME
 * scripts that way (`oct3-verify.yml`: `pwsh -NoProfile -File
 * scripts/verify-oct3.ps1`). A rehearsal that only exists as `powershell ...`
 * therefore cannot run where the code it rehearses really runs, which is how a
 * gate quietly becomes a local habit: green on the author's box, absent from
 * every merge. This file is the one place that decides the engine, so the
 * harness, the lifecycle and the npm scripts cannot disagree about it.
 *
 * PWSh FIRST, in both worlds on purpose. PowerShell 7 is the engine CI uses and
 * the engine the scheduled workflows use, so a rehearsal that ran on Windows
 * PowerShell 5.1 locally would be rehearsing a different engine from the one
 * that fires at 07:17 UTC. 5.1 stays available as the fallback for a Windows box
 * with no PowerShell 7 installed. (`-ExecutionPolicy` is passed on Windows only:
 * the policy exists there, and PowerShell on Linux rejects the parameter.)
 *
 * The live checkers (`check:oct3`, `check:oct28`, `check:oct4`, `check:oct29`)
 * deliberately still call `powershell` directly: they need the Windows
 * Credential Manager token path, and they are for an operator at a keyboard.
 * The rehearsals are the ones that must run unattended, anywhere.
 *
 * Usage:
 *   node scripts/rehearse-pwsh.mjs -File scripts/rehearse-sentinels.ps1 [-Only oct4]
 *   npm run rehearse:sentinels -- -Only oct4
 *   node scripts/rehearse-pwsh.mjs --which      # print the engine and version
 *
 * `npm run rehearse:which` is the first step of the rehearsals job in
 * .github/workflows/ci.yml, so a runner with no PowerShell says so (exit 2,
 * REHEARSE_PWSH_MISSING) before a rehearsal can be counted as passed.
 *
 * Exit: whatever the script exits with (so a wrapper never reports success for
 *       a rehearsal that failed).
 */
import { spawnSync } from "node:child_process";

/** Is `command` on PATH? A missing binary is an error, not a non-zero exit. */
function exists(command) {
  const probe = spawnSync(command, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" });
  return !probe.error;
}

/**
 * The PowerShell to run, and the flags that go before any caller's arguments.
 *
 * Exported because scripts/rehearse-lifecycle.mjs spawns the same scripts for
 * its PowerShell actors: one choice, read in two places, rather than a second
 * copy of the engine name that can drift.
 *
 * @returns {{ command: string, args: string[] }}
 */
export function powerShell() {
  const candidates = process.platform === "win32" ? ["pwsh", "powershell"] : ["pwsh"];
  const command = candidates.find(exists);
  if (!command) {
    throw new Error(
      `no PowerShell found (tried ${candidates.join(", ")}). On Linux install PowerShell 7: ` +
        `the rehearsals run the same scripts the cron workflows run, and those run under pwsh.`,
    );
  }
  const args = ["-NoProfile", "-NonInteractive"];
  if (process.platform === "win32") args.push("-ExecutionPolicy", "Bypass");
  return { command, args };
}

if (process.argv[1]?.endsWith("rehearse-pwsh.mjs")) {
  const rest = process.argv.slice(2);
  if (rest[0] === "--which") {
    // The same failure message the file path prints, because this is the call a
    // CI step makes: a runner without PowerShell must fail with the reason, not
    // with a stack trace nobody reads.
    let engine;
    try {
      engine = powerShell();
    } catch (e) {
      console.error(`REHEARSE_PWSH_MISSING ${e.message}`);
      process.exit(2);
    }
    const version = spawnSync(engine.command, [...engine.args, "-Command", "$PSVersionTable.PSVersion.ToString()"], {
      encoding: "utf8",
    });
    console.log(`${engine.command} ${String(version.stdout ?? "").trim()}`);
    process.exit(0);
  }
  if (rest.length === 0) {
    console.error("usage: node scripts/rehearse-pwsh.mjs -File <script.ps1> [args...] | --which");
    process.exit(2);
  }
  let engine;
  try {
    engine = powerShell();
  } catch (e) {
    console.error(`REHEARSE_PWSH_MISSING ${e.message}`);
    process.exit(2);
  }
  const result = spawnSync(engine.command, [...engine.args, ...rest], { stdio: "inherit" });
  // No output capture: the rehearsal's own stdout/stderr is the evidence, and it
  // is streamed live so a CI log shows which scenario failed and why.
  process.exit(result.status ?? (result.signal ? 1 : 0));
}
