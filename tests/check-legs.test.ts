/**
 * Pins for scripts/check-legs.mjs — the tool that lets a green local run mean
 * what a green gate means.
 *
 * The load-bearing pins are two, and both are about NOT trusting this tool:
 *
 *  - THE SEQUENCE IS CI'S, PINNED AGAINST CI. `gateSteps` reads the steps out of
 *    .github/actions/gates-steps/action.yml instead of transcribing them, and the
 *    first case below asserts what that file says TODAY. A workflow edit that
 *    changes the gate therefore lands as a failing test rather than as a local
 *    runner quietly reporting on last month's sequence — and a step carrying
 *    shell syntax this tool cannot execute is a refusal, not a skip, because a
 *    check that was never run must never be part of a green verdict.
 *
 *  - THE LEGS ARE COMPUTED, PINNED AGAINST THE SCHEDULE. Not one case here
 *    assumes node 22 and 24 are the blocking set: they are classified from a
 *    fixture schedule, with a second schedule whose blocking set is different, so
 *    a hardcoded list would fail the test that exists to catch it.
 *
 * The rest pins what a runtime has to survive before anything is run with it
 * (a published digest, a matching digest, an unpacked tree, its own answer about
 * its version), and that a leg's steps run with THAT leg's Node first on PATH —
 * which is the whole claim: the suite runs on the leg, not on whatever `node`
 * the shell would have found.
 *
 * Everything here is hermetic: no release index is fetched (the index is a
 * fixture string), the runtime "download" is a tar this test builds in a temp
 * directory and serves from a stubbed fetch, and the one process-level case runs
 * with SCHEDULE_JSON inline, which is the documented way to keep a schedule test
 * off the network. The real thing — two real legs, 35MB archives, the whole gate
 * — is `npm run check:legs`, run by hand.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, delimiter as pathDelimiter } from "node:path";
import process from "node:process";

import { describe, expect, it, vi } from "vitest";

import {
  SetupError,
  UsageError,
  archiveFor,
  scrubNpmEnv,
  assertRuntime,
  classifyLegs,
  ensureRuntime,
  extractCommands,
  gateSteps,
  parseArgs,
  parseLegList,
  parseNodeBin,
  perfCommands,
  resolveVersions,
  runSteps,
  runtimeBin,
  selectSteps,
  runtimeNpm,
  shellCommand,
  stepId,
  verifyDigest,
} from "../scripts/check-legs.mjs";

const HERE = process.cwd();
const SCRIPT = join(HERE, "scripts", "check-legs.mjs");
/** The install running these tests, used as an "already installed" runtime. */
const NODE_DIR = dirname(process.execPath);
const NODE_MAJOR = Number(process.version.slice(1).split(".")[0]);

const scratch = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/**
 * A tree shaped like this repo where it matters: a package root with one gate
 * step that the tool can actually run, and the action file that declares it.
 */
function legFixture(): string {
  const dir = scratch("anybase-legs-cli-");
  writeFile(
    dir,
    "package.json",
    JSON.stringify({
      name: "fixture",
      private: true,
      scripts: { "check:node": 'node -e "console.log(\'fixture leg ok\')"' },
    }),
  );
  writeFile(dir, join(".github", "actions", "gates-steps", "action.yml"), gateAction(["npm run check:node"]));
  return dir;
}

/**
 * Whichever PowerShell this machine has, tried the way the script tries them —
 * `pwsh` first, then the 5.1 that is always installed on Windows. On this
 * maintainer's box `pwsh` is on PATH and still answers ENOENT to a spawn with
 * no shell in front of it, which is exactly why the script carries two
 * candidates instead of one name.
 */
function powershell(script: string) {
  let last = "";
  for (const command of ["pwsh", "powershell"]) {
    const result = spawnSync(command, ["-NoProfile", "-Command", script], { encoding: "utf8" });
    if (!result.error) return result;
    last = `${command}: ${result.error.message}`;
  }
  throw new Error(`no PowerShell on this machine (${last})`);
}

function writeFile(dir: string, relative: string, text: string): string {
  const file = join(dir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/** A schedule shaped like nodejs/Release's, for legs the tests choose. */
const schedule = (rows: Record<number, { start: string; lts?: string; end: string }>) =>
  Object.fromEntries(Object.entries(rows).map(([major, entry]) => [`v${major}`, entry]));

const LTS_22_24 = schedule({
  22: { start: "2024-04-24", lts: "2024-10-29", end: "2027-04-30" },
  24: { start: "2025-05-06", lts: "2025-10-28", end: "2028-04-30" },
  26: { start: "2026-04-15", lts: "2026-10-28", end: "2029-04-30" },
});

/** A gate action with the steps named, for the parsing cases. */
const gateAction = (steps: string[]) =>
  [
    "name: gates-steps",
    "runs:",
    "  using: composite",
    "  steps:",
    ...steps.flatMap((run) => ["    - name: step", `      run: ${run}`]),
    "",
  ].join("\n");

describe("the sequence CI gates on, read from CI", () => {
  it("is the gates action's own steps, in the action's own order", () => {
    // Pinned deliberately as literals: this is what the file says today, and a
    // change to the gate must arrive here as a failing expectation.
    expect(gateSteps(HERE)).toEqual([
      ["ci"],
      ["run", "check:node"],
      ["run", "check:workflows"],
      ["run", "typecheck"],
      ["run", "lint"],
      // `npm test` is npm's own shorthand: the argv keeps the shorthand, since
      // that is what the workflow file asks npm for.
      ["test"],
      ["run", "verify:generated", "--", "--strict"],
    ]);
  });

  it("reads the steps out of the tree it is pointed at, not out of itself", () => {
    const dir = scratch("anybase-legs-action-");
    writeFile(dir, join(".github", "actions", "gates-steps", "action.yml"), gateAction(["npm run only-step"]));
    expect(gateSteps(dir)).toEqual([["run", "only-step"]]);
  });

  it("skips a `uses:` step, which is this tool's own runtime to arrange", () => {
    const dir = scratch("anybase-legs-uses-");
    writeFile(
      dir,
      join(".github", "actions", "gates-steps", "action.yml"),
      [
        "name: gates-steps",
        "runs:",
        "  using: composite",
        "  steps:",
        "    - uses: actions/setup-node@v7",
        "      with:",
        "        node-version: 22",
        "    - name: Tests",
        "      shell: bash",
        "      run: npm test",
        "",
      ].join("\n"),
    );
    expect(gateSteps(dir)).toEqual([["test"]]);
  });

  it("refuses a step it cannot execute as written instead of skipping it", () => {
    expect(() => shellCommand("npm run test | tee log", "a step")).toThrow(/does not run shell syntax/);
    expect(() => shellCommand("npm run test && npm run lint", "a step")).toThrow(SetupError);
    expect(() => shellCommand("echo $(date); npm test", "a step")).toThrow(SetupError);
    expect(() => shellCommand("pwsh -File scripts/x.ps1", "a step")).toThrow(/not npm/);
  });

  it("refuses an action with no commands at all — there would be nothing to pass", () => {
    // A step list of nothing but `uses:` installs a runtime and checks nothing.
    const dir = scratch("anybase-legs-empty-");
    writeFile(
      dir,
      join(".github", "actions", "gates-steps", "action.yml"),
      ["name: gates-steps", "runs:", "  using: composite", "  steps:", "    - uses: actions/setup-node@v7", ""].join("\n"),
    );
    expect(() => gateSteps(dir)).toThrow(/runs no commands/);
    // And a tree with no steps list at all is not a tree with nothing to run: it
    // is a sequence this tool cannot see, which is a refusal either way.
    writeFile(dir, join(".github", "actions", "gates-steps", "action.yml"), "name: gates-steps\nruns:\n  using: composite\n");
    expect(() => gateSteps(dir)).toThrow(/no runs.steps/);
    const missing = scratch("anybase-legs-missing-");
    expect(() => gateSteps(missing)).toThrow(/cannot read CI's gate steps/);
  });

  it("names a step by its npm script, which is what --only takes", () => {
    expect(stepId(["run", "verify:generated", "--", "--strict"])).toBe("verify:generated");
    expect(stepId(["ci"])).toBe("ci");
  });
});

describe("what one leg runs", () => {
  const steps = [
    ["ci"],
    ["run", "check:node"],
    ["test"],
  ];
  const perf = [
    ["ci"],
    ["run", "check:perf"],
  ];

  it("is the gate's steps, with the perf job's appended on the oldest leg only", () => {
    // The perf job installs afresh on a runner, so its `npm ci` is not
    // redundant here either: a full run is CI's, not a tidied version of it.
    expect(selectSteps({ steps, perf, leg: 22, oldest: 22 })).toEqual([
      ["ci"],
      ["run", "check:node"],
      ["test"],
      ["ci"],
      ["run", "check:perf"],
    ]);
    expect(selectSteps({ steps, perf, leg: 24, oldest: 22 })).toEqual(steps);
  });

  it("drops the install when it is switched off, on every leg and in the perf job too", () => {
    expect(selectSteps({ steps, perf, leg: 22, oldest: 22, install: false })).toEqual([
      ["run", "check:node"],
      ["test"],
      ["run", "check:perf"],
    ]);
  });

  it("runs a step the operator names ONCE, even where both sequences start with it", () => {
    expect(selectSteps({ steps, perf, leg: 22, oldest: 22, only: "ci" })).toEqual([["ci"]]);
    expect(selectSteps({ steps, perf, leg: 22, oldest: 22, only: "test" })).toEqual([["test"]]);
    expect(selectSteps({ steps, perf, leg: 24, oldest: 22, only: "check:perf" })).toEqual([]);
  });
});

describe("the superlinearity gate, pinned against the perf-gate job", () => {
  it("is that job's commands, without the step that only chooses a leg", () => {
    expect(perfCommands(HERE)).toEqual([["ci"], ["run", "check:perf"]]);
  });

  it("refuses a perf-gate job that grew a step this tool does not have", () => {
    const dir = scratch("anybase-legs-perf-");
    writeFile(
      dir,
      join(".github", "workflows", "ci.yml"),
      [
        "jobs:",
        "  perf-gate:",
        "    steps:",
        "      - name: Resolve the oldest blocking leg",
        "        run: |",
        "          legs='${{ needs.matrix.outputs.legs }}'",
        "          echo \"version=$oldest\" >> \"$GITHUB_OUTPUT\"",
        "      - run: npm ci",
        "      - run: npm run check:perf",
        "      - run: npm run something-new",
        "",
      ].join("\n"),
    );
    expect(() => perfCommands(dir)).toThrow(/no longer runs/);
  });

  it("refuses a tree whose perf-gate job is gone", () => {
    const dir = scratch("anybase-legs-noperf-");
    writeFile(dir, join(".github", "workflows", "ci.yml"), "jobs:\n  gates:\n    steps: []\n");
    expect(() => perfCommands(dir)).toThrow(/no perf-gate job/);
  });
});

describe("the legs come from the release schedule, not from a list", () => {
  it("classifies the blocking set, and follows it when it changes", async () => {
    const first = await classifyLegs({ schedule: LTS_22_24, now: "2026-10-15" });
    expect(first.blocking).toEqual([22, 24]);
    expect(first.canary).toBe(26);

    // A DIFFERENT schedule: 22 has reached EOL and 26 has graduated. A hardcoded
    // [22, 24] anywhere in the runner fails here, which is the point.
    const later = await classifyLegs({
      schedule: schedule({
        22: { start: "2024-04-24", lts: "2024-10-29", end: "2027-04-30" },
        24: { start: "2025-05-06", lts: "2025-10-28", end: "2028-04-30" },
        26: { start: "2026-04-15", lts: "2026-10-28", end: "2029-04-30" },
      }),
      now: "2027-05-10",
    });
    expect(later.blocking).toEqual([24, 26]);
  });

  it("refuses a schedule that classifies to no blocking leg", async () => {
    await expect(
      classifyLegs({
        schedule: schedule({ 22: { start: "2024-04-24", lts: "2024-10-29", end: "2027-04-30" } }),
        now: "2027-06-01",
      }),
    ).rejects.toThrow(/ZERO blocking legs/);
  });
});

describe("the runtime a leg runs is the one it says it is", () => {
  const index = JSON.stringify([
    { version: "v26.8.1", lts: false, date: "2026-10-14" },
    { version: "v24.22.0", lts: "Krypton", date: "2026-10-14" },
    { version: "v24.21.0", lts: "Krypton", date: "2026-09-30" },
    { version: "v24.0.0-rc.1", lts: false, date: "2025-04-01" },
    { version: "v22.23.3", lts: "Jod", date: "2026-09-23" },
  ]);

  it("resolves a leg to the newest released patch of that major", () => {
    const resolved = resolveVersions(index, [22, 24]);
    expect(resolved.get(22)).toBe("22.23.3");
    expect(resolved.get(24)).toBe("24.22.0"); // not 24.21.0, and not the rc
  });

  it("refuses a leg the index has no release for, rather than skipping it", () => {
    expect(() => resolveVersions(index, [22, 20])).toThrow(/no released 20\.x/);
    expect(() => resolveVersions("{}", [22])).toThrow(/not an array/);
    expect(() => resolveVersions("<html>", [22])).toThrow(/not JSON/);
  });

  it("names the official archive for this platform, or refuses the platform", () => {
    // `win`, not `win32`: the dist's own id for Windows, which is what a name
    // assembled from process.platform gets wrong (as a 404 nobody sees).
    expect(archiveFor("22.23.3", "win32", "x64")).toMatchObject({ file: "node-v22.23.3-win-x64.zip", kind: "zip" });
    expect(archiveFor("22.23.3", "linux", "x64")).toMatchObject({ file: "node-v22.23.3-linux-x64.tar.gz", kind: "tar.gz" });
    expect(archiveFor("22.23.3", "darwin", "arm64")).toMatchObject({ file: "node-v22.23.3-darwin-arm64.tar.gz" });
    expect(() => archiveFor("22.23.3", "aix", "x64")).toThrow(/no official Node build/);
    expect(() => archiveFor("22.23.3", "linux", "ia32")).toThrow(/no official Node build/);
  });

  it("finds the executable and the bundled npm inside an extracted runtime", () => {
    expect(runtimeBin("/legs/node-v22.23.3-win-x64", "win32")).toBe(join("/legs/node-v22.23.3-win-x64", "node.exe"));
    expect(runtimeBin("/legs/node-v22.23.3-linux-x64", "linux")).toBe(
      join("/legs/node-v22.23.3-linux-x64", "bin", "node"),
    );
    const dir = scratch("anybase-legs-nonpm-");
    expect(() => runtimeNpm(dir)).toThrow(/no bundled npm/);
  });

  it("verifies a digest, and refuses one that is wrong or not published", () => {
    const dir = scratch("anybase-legs-digest-");
    const file = writeFile(dir, "node-v22.23.3-win-x64.zip", "pretend this is 35MB of node\n");
    const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
    const name = "node-v22.23.3-win-x64.zip";
    expect(verifyDigest(file, `${digest}  ${name}\n`, name)).toBe(digest);
    // The published file lists every artefact; only this one's line matters.
    expect(verifyDigest(file, `deadbeef  other.tar.gz\n${digest} *${name}\n`, name)).toBe(digest);
    expect(() => verifyDigest(file, `deadbeef  ${name}\n`, name)).toThrow(/does not match its published digest/);
    // No entry at all is a refusal, never a pass: an unverified runtime is not
    // something to execute a test suite with.
    expect(() => verifyDigest(file, "deadbeef  other.tar.gz\n", name)).toThrow(/publishes no digest/);
  });

  it("unpacks each archive with the tool that platform actually has", () => {
    // Windows goes through PowerShell, deliberately not through the `unzip` in
    // Git Bash: a Windows path spawned into an MSYS binary with no shell to
    // translate it is read as host:path (`Cannot connect to C: resolve failed`).
    const win = extractCommands("zip", "/tmp/a.zip", "/tmp/dest", "win32");
    expect(win.map((command) => command.program)).toEqual(["pwsh", "powershell"]);
    expect(win[0].args.join(" ")).toContain("Expand-Archive -LiteralPath '/tmp/a.zip' -DestinationPath '/tmp/dest' -Force");
    // A path with a quote in it is escaped for PowerShell rather than breaking it.
    expect(extractCommands("zip", "/tmp/it's a.zip", "/tmp/dest", "win32")[0].args.join(" ")).toContain("'/tmp/it''s a.zip'");
    expect(extractCommands("zip", "/tmp/a.zip", "/tmp/dest", "linux")).toEqual([
      { program: "unzip", args: ["-q", "-o", "/tmp/a.zip", "-d", "/tmp/dest"] },
    ]);
    expect(extractCommands("tar.gz", "/tmp/a.tar.gz", "/tmp/dest", "linux")).toEqual([
      { program: "tar", args: ["-xzf", "/tmp/a.tar.gz", "-C", "/tmp/dest"] },
    ]);
  });

  it("answers with its own version, and is refused when it is not the leg's", SPAWNING, async () => {
    const env = { ...process.env };
    await expect(
      assertRuntime({ dir: NODE_DIR, major: NODE_MAJOR, version: process.version.slice(1), cwd: HERE, env }),
    ).resolves.toBe(process.version.slice(1));
    await expect(assertRuntime({ dir: NODE_DIR, major: NODE_MAJOR + 1, cwd: HERE, env })).rejects.toThrow(
      new RegExp(`is node ${NODE_MAJOR}, not the node ${NODE_MAJOR + 1} leg`),
    );
    // Downloaded by version: a runtime that answers something else is refused
    // rather than reported on, because the leg label would be a lie.
    await expect(
      assertRuntime({ dir: NODE_DIR, major: NODE_MAJOR, version: "0.0.1", cwd: HERE, env }),
    ).rejects.toThrow(/refusing to report on a runtime other than the one the index named/);
  });
});

describe("a downloaded runtime is verified, unpacked, and cached whole", () => {
  /**
   * An archive shaped like the official one for THIS platform: every entry
   * under `<base>/`, an executable where the runtime puts it, and the bundled
   * npm, so the unpacking path under test is the one a real download walks.
   */
  function fakeRuntimeArchive(version: string) {
    const root = scratch("anybase-legs-archive-");
    const { base, kind } = archiveFor(version);
    const payload = join(root, "payload");
    writeFile(payload, join(base, "node.exe"), "not a real node\n");
    writeFile(payload, join(base, "bin", "node"), "not a real node either\n");
    writeFile(payload, join(base, "node_modules", "npm", "bin", "npm-cli.js"), "// npm\n");
    const archive = join(payload, `runtime.${kind}`);
    if (kind === "zip") {
      // Compress-Archive puts the directory itself at the archive's root, which
      // is how the official zips are laid out.
      const quote = (value: string) => value.replace(/'/g, "''");
      powershell(
        `Compress-Archive -Path '${quote(join(payload, base))}' -DestinationPath '${quote(archive)}' -Force`,
      );
    } else {
      execFileSync("tar", ["-czf", `runtime.${kind}`, base], { cwd: payload });
    }
    const file = `${base}.${kind}`;
    const bytes = readFileSync(archive);
    const digest = createHash("sha256").update(bytes).digest("hex");
    return { base, file, kind, bytes, shasums: `${digest}  ${file}\n` };
  }

  // A generous timeout: a real unpack here is a real PowerShell starting up to
  // expand a real archive, which is seconds even when nothing is wrong, and a
  // test that fails on a slow machine teaches nothing.
  it("downloads, verifies, unpacks, and reports the cache on the second call", async () => {
    const version = "9.9.9";
    const { base, file, kind, bytes, shasums } = fakeRuntimeArchive(version);
    const cacheDir = join(scratch("anybase-legs-cache-"), CACHE_DIRNAME);
    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array(bytes) }));
    vi.stubGlobal("fetch", fetchMock);
    const env = { ...process.env };
    try {
      const first = await ensureRuntime({
        base,
        file,
        kind,
        version,
        cacheDir,
        distBase: "http://dist.invalid",
        cwd: HERE,
        env,
        fetchText: async () => shasums,
        stream: null,
      });
      expect(first.downloaded).toBe(true);
      expect(existsSync(runtimeBin(first.dir))).toBe(true);
      expect(runtimeNpm(first.dir)).toHaveLength(2); // the tree is complete, npm included

      const second = await ensureRuntime({
        base,
        file,
        kind,
        version,
        cacheDir,
        distBase: "http://dist.invalid",
        cwd: HERE,
        env,
        fetchText: async () => {
          throw new Error("a cached runtime must not be fetched again");
        },
        stream: null,
      });
      expect(second).toEqual({ dir: first.dir, downloaded: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);

  it("refuses a download whose digest does not match, and caches nothing", async () => {
    const version = "8.8.8";
    const { base, file, kind, bytes } = fakeRuntimeArchive(version);
    const cacheDir = join(scratch("anybase-legs-badcache-"), CACHE_DIRNAME);
    vi.stubGlobal("fetch", async () => ({ ok: true, arrayBuffer: async () => new Uint8Array(bytes) }));
    try {
      await expect(
        ensureRuntime({
          base,
          file,
          kind,
          version,
          cacheDir,
          distBase: "http://dist.invalid",
          cwd: HERE,
          env: { ...process.env },
          fetchText: async () => `deadbeef  ${file}\n`,
          stream: null,
        }),
      ).rejects.toThrow(/does not match its published digest/);
      // Nothing usable left behind: neither the tree nor the archive.
      expect(readdirSync(cacheDir)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a leg's steps run with that leg's Node first on PATH", () => {
  it("puts the runtime ahead of what was already on PATH, and stops the leg at its first failing step", SPAWNING, async () => {
    const dir = scratch("anybase-legs-run-");
    writeFile(
      dir,
      "package.json",
      JSON.stringify({
        name: "fixture",
        private: true,
        scripts: {
          where: 'node -e "console.log(process.env.PATH)"',
          boom: 'node -e "process.exit(3)"',
        },
      }),
    );
    // A decoy standing in for another Node install further down the PATH: the
    // leg's runtime has to come first, or "the node 22 leg" is a label on a
    // directory rather than a fact about the process that ran the tests.
    const decoy = scratch("anybase-legs-decoy-");
    const inherited = `${decoy}${pathDelimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
    const run = await runSteps({
      steps: [
        ["run", "where"],
        ["run", "boom"],
        ["run", "where"],
      ],
      runtime: NODE_DIR,
      cwd: dir,
      env: { ...process.env, PATH: inherited, Path: inherited },
      stream: null,
    });

    expect(run.results.map((step) => step.id)).toEqual(["where", "boom"]);
    expect(run.results[0].code).toBe(0);
    const printed = (run.results[0].tail as string[])
      .map((line: string) => line.split(pathDelimiter))
      .find((entries: string[]) => entries.includes(NODE_DIR));
    expect(printed).toBeDefined();
    expect(printed!.indexOf(NODE_DIR)).toBeLessThan(printed!.indexOf(decoy));
    // A failing step is the step's code, not a swallowed one, and the steps
    // after it are reported as not run rather than as passed.
    expect(run.failed?.id).toBe("boom");
    expect(run.failed?.code).toBe(3);
    expect(run.remaining.map((argv: string[]) => stepId(argv))).toEqual(["where"]);
  });
});

/**
 * A process-level case here starts at least one Node, and the ones that run a leg
 * start npm under it — seconds of work, on a machine that the rest of this suite is
 * running on at the same time. The default 5s is a timeout for a unit assertion,
 * and it was measured flaking HERE rather than in CI: the two cases below passed
 * alone in ~1s each and timed out inside the full parallel suite. The assertions
 * are unchanged; only the time they are allowed is.
 */
const SPAWNING = { timeout: 30_000 } as const;

describe("the command line, through the process", () => {
  const run = (args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: options.cwd ?? HERE,
      env: { ...process.env, ...options.env },
      encoding: "utf8",
    });

  it("prints its usage and exits 0 for --help", SPAWNING, () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("usage: node scripts/check-legs.mjs");
  });

  it("exits 2 for a usage error, which is not a verdict about a check", SPAWNING, () => {
    expect(run(["--nope"]).status).toBe(2);
    expect(run(["--legs", "22,many"]).status).toBe(2);
    expect(run(["--node-bin", "22"]).status).toBe(2);
    expect(run(["--legs"]).status).toBe(2);
  });

  it("lists the steps without asking the schedule for anything", SPAWNING, () => {
    // SCHEDULE_JSON here classifies to zero blocking legs, which is a refusal —
    // so a listing that still succeeds is a listing that never classified.
    const result = run(["--only", "list"], { env: { SCHEDULE_JSON: "{}" } });
    expect(result.status).toBe(0);
    const steps = result.stdout.trim().split(/\r?\n/);
    expect(steps).toContain("check:node");
    expect(steps).toContain("check:perf");
  });

  it("runs a leg against an install you already have", SPAWNING, () => {
    const dir = legFixture();
    const env = { SCHEDULE_JSON: JSON.stringify(LTS_22_24) };

    const ok = run(
      ["--legs", String(NODE_MAJOR), "--node-bin", `${NODE_MAJOR}=${NODE_DIR}`, "--only", "check:node", "--no-perf"],
      { cwd: dir, env },
    );
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain(`node ${NODE_MAJOR} → v${process.version.slice(1)}`);
    expect(ok.stdout).toContain("yours — not verified beyond its major");
    expect(ok.stdout).toContain("CHECK_LEGS PASS");
    expect(ok.stdout).toContain("rehearsals");

    // The wrong install for the leg is a setup error (exit 2), not a pass.
    const wrong = run(
      [
        "--legs",
        String(NODE_MAJOR + 1),
        "--node-bin",
        `${NODE_MAJOR + 1}=${NODE_DIR}`,
        "--only",
        "check:node",
        "--no-perf",
      ],
      { cwd: dir, env },
    );
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain("not the node");
  });

  it("drops the npm_config_* a launching npm exported, and says which", SPAWNING, () => {
    // The variables are the parent npm's, not CI's: CI has a node and an npm,
    // never an npm inside an npm. One of them (allow-scripts, npm >= 11.19) is
    // read by a NESTED npm as a project-scoped flag, and the install dies with
    // EALLOWSCRIPTS — measured on this repo's own node 24 leg.
    const dir = legFixture();
    const env = { SCHEDULE_JSON: JSON.stringify(LTS_22_24), npm_config_allow_scripts: "false" };
    const common = ["--legs", String(NODE_MAJOR), "--node-bin", `${NODE_MAJOR}=${NODE_DIR}`, "--only", "check:node", "--no-perf"];

    // The count is whatever the launch exported (vitest under `npx` exports
    // some of its own), and the casing is whatever Windows' case-insensitive
    // environment layer decided — so it is the NOTICE and the name that are
    // pinned, not a number nothing here controls.
    const scrubbed = run(common, { cwd: dir, env });
    expect(scrubbed.status).toBe(0);
    expect(scrubbed.stdout).toMatch(/dropped \d+ npm_config_\* variable\(s\)/);
    expect(scrubbed.stdout.toLowerCase()).toContain("npm_config_allow_scripts");

    const kept = run([...common, "--keep-npm-env"], { cwd: dir, env });
    expect(kept.status).toBe(0);
    expect(kept.stdout).not.toMatch(/dropped \d+ npm_config_\*/);
  });

  it("refuses to run from a tree that is not the package root", SPAWNING, () => {
    const dir = scratch("anybase-legs-nopkg-");
    const result = run(["--legs", "22", "--only", "check:node", "--no-perf"], {
      cwd: dir,
      env: { SCHEDULE_JSON: JSON.stringify(LTS_22_24) },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no package.json");
  });

  it("parses the flags it documents, and refuses what it does not", () => {
    expect(parseArgs(["--legs", "24,22,24", "--no-install", "--json"])).toMatchObject({
      legs: [22, 24],
      install: false,
      json: true,
    });
    expect(parseLegList("22,24")).toEqual([22, 24]);
    expect(() => parseLegList("22,x")).toThrow(UsageError);
    const [major, dir] = parseNodeBin(`22=${NODE_DIR}`);
    expect(major).toBe(22);
    expect(dir).toBe(NODE_DIR);
    expect(() => parseNodeBin("twenty=dir")).toThrow(UsageError);
    expect(() => parseArgs(["--nope"])).toThrow(UsageError);
    // --node-bin is repeatable: one entry per leg.
    expect(parseArgs(["--node-bin", `22=${NODE_DIR}`, "--node-bin", "24=/legs/24"]).nodeBin.size).toBe(2);
  });
});

/** The cache directory name, asserted here so the gitignore entry cannot drift. */
const CACHE_DIRNAME = ".node-legs";
describe("the npm a run came from is not the npm a leg sees", () => {
  it("drops every npm_config_* variable, whatever its case, and keeps the rest", () => {
    const { env, dropped } = scrubNpmEnv({
      PATH: "/usr/bin",
      HOME: "/home/someone",
      npm_config_allow_scripts: "false",
      NPM_CONFIG_CACHE: "/tmp/cache",
      npm_config_user_agent: "npm/11.19.0",
    });
    expect(dropped).toEqual(["NPM_CONFIG_CACHE", "npm_config_allow_scripts", "npm_config_user_agent"]);
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
    expect(scrubNpmEnv({ PATH: "/usr/bin" }).dropped).toEqual([]);
  });
});

describe("the runtime cache is where the gitignore says", () => {
  it("is ignored, since it holds multi-hundred-megabyte runtimes", () => {
    expect(readFileSync(join(HERE, ".gitignore"), "utf8")).toContain(`${CACHE_DIRNAME}/`);
  });
});
