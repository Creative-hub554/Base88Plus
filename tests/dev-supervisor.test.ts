/**
 * The dev supervisor: the policy in scripts/dev.mjs, and the mechanism it runs
 * under in scripts/supervise.mjs (the same loop the production entry uses, which
 * is why the probe, the tree kill, the audit, the backoff and the budget are
 * pinned here — there is one copy of each).
 *
 * Two layers, because the failure it exists for is not reproducible on demand:
 *
 *  - unit pins on the parts that decide things — the pool-death signature (the
 *    verbatim line from this repo's own dev log) and, just as important, the
 *    ordinary dev output that must NOT be mistaken for it, the argv handling,
 *    the restart budget and the tree kill on each platform;
 *  - an end-to-end run of the real supervisor against
 *    tests/fixtures/dev-death-server.mjs, which prints that same line and keeps
 *    serving from a real port — the same shape as the server that stayed up on
 *    the routes it had already compiled. It proves the restart happens, that
 *    the port is actually free again after the kill (a left-behind process
 *    would fail to listen), that recovery is only announced once the port
 *    answers HTTP, and that the supervisor still refuses to restart a server
 *    that exited cleanly or to loop forever on one that never gets through
 *    startup.
 *
 * What is NOT pinned: that Turbopack prints this line when its pool dies in a
 * given Next version. That is the observation the signature came from, not
 * something a test can manufacture.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { Agent, createServer, request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NO_RESTART, POOL_DEATH, classifyLine } from "../scripts/dev.mjs";
import {
  FrontDoor,
  RELOAD_HISTORY_SCHEMA,
  ReloadQueue,
  RestartBudget,
  WarmList,
  appendReloadRecord,
  backoffMs,
  descendantsOf,
  describeExit,
  formatGapMs,
  healthCheck,
  isWarmable,
  killPids,
  killTree,
  localUrlPort,
  meanGapMs,
  parseArgs,
  parseTaskkillReport,
  procProcessTable,
  probeUp,
  psProcessTable,
  reloadRecord,
  reservePort,
  rollbackWindowFor,
  servedRoute,
  stillAlive,
  terminate,
  tokenizeCommand,
  warmRoutes,
  watchReloadFile,
} from "../scripts/supervise.mjs";

// Verbatim from .next/dev/logs/next-development.log on the day the pool died.
const DEATH_LINE = "Jest worker encountered 2 child process exceptions, exceeding retry limit";

describe("dev supervisor — the pool-death signature", () => {
  it("matches the line Next actually printed, singular or plural", () => {
    expect(classifyLine(DEATH_LINE)).toMatchObject({ kind: "pool-death" });
    expect(classifyLine("Jest worker encountered 1 child process exception, exceeding retry limit")).toMatchObject({
      kind: "pool-death",
    });
    // Case is not load-bearing; the message has moved between streams before.
    expect(classifyLine("jest worker encountered 3 child process exceptions")).toMatchObject({ kind: "pool-death" });
    expect(POOL_DEATH).toHaveLength(1);
  });

  it("leaves ordinary dev output alone", () => {
    // Every one of these is a normal, self-inflicted dev failure: the person at
    // the keyboard is fixing them. Restarting on any of them would turn one
    // honest error into a loop of identical ones.
    const benign = [
      "✓ Compiled /settings in 1.2s",
      "⨯ ./src/app/page.tsx:12:5 — Module not found: Can't resolve './x'",
      "Error: Unexpected token '<'",
      " GET /app/abc/ 500 in 4.5s (next.js: 4.2s, application-code: 276ms)",
      "⚠ Fast Refresh had to perform a full reload",
      "[dev] restart 1/5 in 1000ms",
      "Child process exited with code 1",
      "worker crashed",
    ];
    for (const line of benign) expect(classifyLine(line), line).toBeNull();
  });

  it("refuses to restart what a new process cannot fix", () => {
    expect(classifyLine("Another next dev server is already running for this directory")).toMatchObject({
      kind: "no-restart",
    });
    expect(classifyLine("Error: listen EADDRINUSE: address already in use :::3000")).toMatchObject({
      kind: "no-restart",
    });
    expect(NO_RESTART.length).toBeGreaterThan(0);
  });

  it("learns the port from the banner, and only from the Local line", () => {
    expect(localUrlPort("- Local:         http://localhost:3111")).toBe(3111);
    expect(localUrlPort("- Local:   http://127.0.0.1:3005")).toBe(3005);
    expect(localUrlPort("- Network:       http://172.25.96.1:3111")).toBeNull();
    expect(localUrlPort(" GET /api/models 308 in 12ms")).toBeNull();
    expect(classifyLine("- Local:         http://localhost:3111")).toMatchObject({
      kind: "local-url",
      port: 3111,
    });
  });
});

describe("dev supervisor — the pages that were in use", () => {
  it("reads the dev server's own request log, query string and all", () => {
    // Verbatim shapes from this repo's dev output.
    expect(servedRoute(" GET / 200 in 3.6s (next.js: 1569ms, application-code: 2.0s)")).toBe("/");
    expect(servedRoute(" GET /settings/ 200 in 1631ms (next.js: 215ms, application-code: 1416ms)")).toBe(
      "/settings/",
    );
    expect(servedRoute(" GET /app/abc123/?tab=code 200 in 700ms (next.js: 15ms)")).toBe("/app/abc123/");
    expect(servedRoute(" HEAD /providers/ 304 in 12ms (next.js: 3ms)")).toBe("/providers/");
  });

  it("does not read its own probe and replays back as pages in use", () => {
    // The supervisor marks everything it asks for itself, and the dev server
    // echoes the query — so these lines must not enter the warm list, or it
    // would record itself talking rather than the pages that were in use.
    expect(servedRoute(" GET /?_warm=1 200 in 20ms (next.js: 3ms)")).toBeNull();
    expect(servedRoute(" GET /settings/?_warm=1 200 in 315ms (next.js: 41ms)")).toBeNull();
    expect(servedRoute(" GET /app/abc/?_warm=1&x=2 200 in 315ms (next.js: 41ms)")).toBeNull();
    // A page that merely mentions it is still a page.
    expect(servedRoute(" GET /docs/_warm=1explained 200 in 12ms (next.js: 3ms)")).toBe(
      "/docs/_warm=1explained",
    );
  });

  it("keeps only what is worth replaying", () => {
    // Failures and guesses: a route that answered with an error is not one to
    // put back in front of the person.
    expect(servedRoute(" GET /app/x/ 404 in 4.1s (next.js: 3.5s)")).toBeNull();
    expect(servedRoute(" GET /broken/ 500 in 900ms (next.js: 1ms)")).toBeNull();
    // Never a request that was not a request to read something.
    expect(servedRoute(" POST /api/chat 200 in 12000ms (next.js: 1ms)")).toBeNull();
    // Not the request log at all.
    expect(servedRoute("✓ Compiled /settings in 1.2s")).toBeNull();
    expect(servedRoute(" ○ Compiling / ...")).toBeNull();
  });

  it("warms pages, never build internals, static files or API handlers", () => {
    expect(isWarmable("/")).toBe(true);
    expect(isWarmable("/settings/")).toBe(true);
    expect(isWarmable("/app/abc/")).toBe(true);
    expect(isWarmable("/legacy.html")).toBe(true);
    expect(isWarmable("/_next/static/chunks/main.js")).toBe(false);
    expect(isWarmable("/__nextjs_original-stack-frame")).toBe(false);
    expect(isWarmable("/favicon.ico")).toBe(false);
    expect(isWarmable("/logo.png")).toBe(false);
    // A GET is supposed to be safe; re-sending one the user never asked for is
    // still not this script's call to make.
    expect(isWarmable("/api/models")).toBe(false);
    expect(classifyLine(" GET /settings/ 200 in 20ms (next.js: 3ms)")).toMatchObject({
      kind: "route",
      path: "/settings/",
    });
    expect(classifyLine(" GET /api/models 200 in 20ms (next.js: 3ms)")).toBeNull();
  });

  it("sees through colour, which the same lines carry on a TTY", () => {
    expect(classifyLine(`\u001b[31m${DEATH_LINE}\u001b[0m`)).toMatchObject({ kind: "pool-death" });
    expect(classifyLine(" GET /settings/ \u001b[32m200\u001b[0m in 20ms (next.js: 3ms)")).toMatchObject({
      kind: "route",
      path: "/settings/",
    });
  });

  it("remembers the pages in recency order, once each, and only so many", () => {
    const list = new WarmList({ limit: 3 });
    list.remember("/");
    list.remember("/settings/");
    list.remember("/providers/");
    expect(list.entries).toEqual(["/providers/", "/settings/", "/"]);

    list.remember("/"); // visited again: newest, and not twice
    expect(list.entries).toEqual(["/", "/providers/", "/settings/"]);

    list.remember("/app/abc/");
    expect(list.entries).toEqual(["/app/abc/", "/", "/providers/"]);
    expect(new WarmList({ limit: 0 }).remember("/").entries).toEqual([]);
  });

  it("replays them one at a time and survives a page that never answers", async () => {
    const seen: string[] = [];
    const results = await warmRoutes(9, ["/", "/settings/", "/providers/"], {
      sleepImpl: async () => {},
      fetchImpl: async (input: string | URL) => {
        seen.push(String(input));
        if (String(input).includes("/settings/")) return { status: 200 };
        return { status: 500 };
      },
    });
    // Marked, so the server's own request log shows them as the supervisor's
    // traffic rather than as pages a person visited.
    expect(seen).toEqual([
      "http://127.0.0.1:9/?_warm=1",
      "http://127.0.0.1:9/settings/?_warm=1",
      "http://127.0.0.1:9/providers/?_warm=1",
    ]);
    expect(results.map((r) => r.status)).toEqual([500, 200, 500]);

    // A page that hangs costs its own timeout, not the pass.
    const hung = await warmRoutes(9, ["/", "/settings/"], {
      sleepImpl: async () => {},
      fetchImpl: async (input: string | URL) => {
        if (String(input).includes("/settings/")) return new Promise(() => {});
        return { status: 200 };
      },
    });
    expect(hung.map((r) => r.status)).toEqual([200, null]);
    expect(hung[1].error).toMatch(/no response/);
  });

  it("stops warming the moment its server is gone", async () => {
    let calls = 0;
    const results = await warmRoutes(9, ["/", "/settings/"], {
      sleepImpl: async () => {},
      isDead: () => calls > 0,
      fetchImpl: async () => {
        calls += 1;
        return { status: 200 };
      },
    });
    expect(calls).toBe(1);
    expect(results).toHaveLength(1);
  });
});

describe("dev supervisor — command line", () => {
  // `portEnv` is named by each entry, never defaulted: these are the DEV names,
  // and the mechanism must not be able to read PROD_PORT (or the reverse).
  const dev = (env: Record<string, string>) => parseArgs([], env, { portEnv: "DEV_PORT" });

  it("reads the port out of -p/--port and forwards it to next dev", () => {
    expect(parseArgs(["-p", "3001"], {})).toEqual({ port: 3001, host: null, forward: ["--port", "3001"] });
    expect(parseArgs(["--port", "3001"], {})).toEqual({ port: 3001, host: null, forward: ["--port", "3001"] });
    expect(parseArgs(["--port=3005", "--turbopack"], {})).toEqual({
      port: 3005,
      host: null,
      forward: ["--port", "3005", "--turbopack"],
    });
  });

  it("falls back to DEV_PORT and forwards anything it does not understand", () => {
    expect(dev({ DEV_PORT: "3100" })).toEqual({ port: 3100, host: null, forward: [] });
    expect(parseArgs(["--hostname", "0.0.0.0"], {})).toEqual({
      port: null,
      host: "0.0.0.0",
      forward: ["--hostname", "0.0.0.0"],
    });
    // No port anywhere means next dev picks, and the banner tells us which.
    expect(parseArgs([], {}).port).toBeNull();
    // A port variable the entry did not name is not a port this server has.
    expect(parseArgs([], { PROD_PORT: "3100" }, { portEnv: "DEV_PORT" }).port).toBeNull();
  });

  it("reads the interface too, so a front door can bind what the server was pinned to", () => {
    expect(parseArgs(["-H", "127.0.0.1", "-p", "3002"], {})).toEqual({
      port: 3002,
      host: "127.0.0.1",
      forward: ["--hostname", "127.0.0.1", "--port", "3002"],
    });
    expect(parseArgs(["--hostname=::1"], {})).toEqual({ port: null, host: "::1", forward: ["--hostname", "::1"] });
    // A flag with nothing after it is forwarded untouched rather than read as one.
    expect(parseArgs(["-H"], {})).toEqual({ port: null, host: null, forward: ["-H"] });
  });

  it("can read a port without handing it to the server, which is what a front door needs", () => {
    // The port belongs to the supervisor there, and a run told to bind it too
    // would be told to fail: it is given a port of its own instead.
    expect(parseArgs(["-p", "3001", "--turbopack"], {}, { forwardPort: false })).toEqual({
      port: 3001,
      host: null,
      forward: ["--turbopack"],
    });
    expect(parseArgs(["--port=3001"], {}, { forwardPort: false }).forward).toEqual([]);
  });

  it("rejects a port that is not one, instead of starting on it", () => {
    expect(() => parseArgs(["-p", "http"], {})).toThrow(/not a port/);
    expect(() => parseArgs(["-p", "0"], {})).toThrow(/not a port/);
    expect(() => parseArgs(["-p", "70000"], {})).toThrow(/not a port/);
    expect(() => parseArgs(["-p"], {})).toThrow(/not a port/);
    expect(() => dev({ DEV_PORT: "abc" })).toThrow(/not a port/);
  });

  it("splits DEV_SERVER_CMD without a shell, keeping quoted paths whole", () => {
    expect(tokenizeCommand("")).toEqual([]);
    expect(tokenizeCommand('  node   "C:\\Program Files\\nodejs\\node.exe"  x.mjs ')).toEqual([
      "node",
      "C:\\Program Files\\nodejs\\node.exe",
      "x.mjs",
    ]);
    expect(tokenizeCommand("node 'a b' --flag=1")).toEqual(["node", "a b", "--flag=1"]);
  });
});

describe("dev supervisor — what it says happened", () => {
  it("describes an exit the way a person would, not the way Windows reports it", () => {
    expect(describeExit(1, null)).toBe("with code 1");
    expect(describeExit(0, null)).toBe("with code 0");
    expect(describeExit(null, "SIGTERM")).toBe("on SIGTERM");
    // The unsigned DWORD a force-killed Windows process leaves behind: -1, and
    // "4294967295" has never helped anybody.
    expect(describeExit(4_294_967_295, null)).toBe("with code 0xffffffff");
    expect(describeExit(undefined, null)).toBe("without an exit code");
  });
});

describe("dev supervisor — restart budget", () => {
  it("doubles the delay per attempt and then holds it at the ceiling", () => {
    const opts = { baseMs: 1_000, maxMs: 15_000 };
    expect([1, 2, 3, 4, 5].map((n) => backoffMs(n, opts))).toEqual([1_000, 2_000, 4_000, 8_000, 15_000]);
    expect(backoffMs(60, opts)).toBe(15_000);
    expect(backoffMs(1, { baseMs: 20, maxMs: 40 })).toBe(20);
  });

  it("spends the budget and then refuses", () => {
    const budget = new RestartBudget({ maxRestarts: 2, healthyMs: 1_000 });
    budget.startRun(0);
    expect(budget.claim()).toBe(true);
    expect(budget.claim()).toBe(true);
    expect(budget.claim()).toBe(false);
    expect(budget.used).toBe(2);
  });

  it("refills only after a run that stayed up long enough to be healthy", () => {
    const budget = new RestartBudget({ maxRestarts: 1, healthyMs: 10_000 });
    budget.startRun(0);
    expect(budget.claim()).toBe(true);
    expect(budget.claim()).toBe(false);

    // Died 2s in: a long dev session is still on its last restart.
    budget.startRun(0);
    expect(budget.refresh(2_000)).toBe(1);
    expect(budget.claim()).toBe(false);

    // Stayed up 10s: the pool was healthy, so the count starts over.
    budget.startRun(0);
    expect(budget.refresh(10_000)).toBe(0);
    expect(budget.claim()).toBe(true);
  });
});

describe("dev supervisor — killing the server tree", () => {
  const liveChild = { pid: 4242, exitCode: null, signalCode: null };

  it("does nothing to a process that is already gone", () => {
    expect(killTree({ pid: 1, exitCode: 0, signalCode: null })).toEqual({
      killed: false,
      reason: "already exited",
      terminated: null,
      failed: null,
    });
    expect(killTree(null)).toMatchObject({ killed: false });
  });

  it("takes the whole subtree on Windows, where the CLI process is not the tree", () => {
    // This is the load-bearing part of the fix on the platform most of this
    // repo is developed on: child.kill() leaves Next's start-server child and
    // its transform workers alive, holding the port, invisible.
    const calls: unknown[][] = [];
    const result = killTree(liveChild, {
      platform: "win32",
      spawnSyncImpl: (command: string, args: string[]) => {
        calls.push([command, args]);
        return { status: 0, error: undefined };
      },
    });
    expect(calls).toEqual([["taskkill", ["/pid", "4242", "/t", "/f"]]]);
    expect(result.killed).toBe(true);
    expect(result.reason).toMatch(/taskkill/);
  });

  it("falls back to a hard kill when taskkill cannot run", () => {
    const killed: string[] = [];
    const result = killTree(liveChild, {
      platform: "win32",
      spawnSyncImpl: () => ({ status: 1, error: new Error("ENOENT") }),
      killChild: (_child: unknown, signal: string) => killed.push(signal),
    });
    expect(killed).toEqual(["SIGKILL"]);
    expect(result.killed).toBe(true);
  });

  it("signals the process group on POSIX, per signal", () => {
    const signals: string[] = [];
    const result = killTree(liveChild, {
      platform: "linux",
      killGroup: (pid: number, signal: string) => signals.push(`${pid}:${signal}`),
      killChild: () => signals.push("child"),
    });
    expect(signals).toEqual(["4242:SIGTERM"]);
    expect(result.reason).toMatch(/process group/);
    expect(killTree(liveChild, { platform: "linux", killGroup: () => signals.push("group-kill") }).killed).toBe(true);
  });

  it("kills just the child when there is no group to signal", () => {
    const signals: string[] = [];
    const result = killTree(liveChild, {
      platform: "linux",
      killGroup: () => {
        throw new Error("ESRCH");
      },
      killChild: (_child: unknown, signal: string) => signals.push(signal),
    });
    expect(signals).toEqual(["SIGTERM"]);
    expect(result.killed).toBe(true);
  });
});

describe("dev supervisor — what the kill left behind", () => {
  const row = (pid: number, ppid: number, command = `node ${pid}.js`) => ({ pid, ppid, command });

  it("walks the tree the table describes, and survives a table that lies", () => {
    const rows = [row(10, 1, "next dev"), row(11, 10, "start-server"), row(12, 10, "other"), row(13, 11, "pool_entry"), row(20, 1, "unrelated")];
    expect(descendantsOf(rows, 10).map((r) => r.pid)).toEqual([11, 12, 13]);
    expect(descendantsOf(rows, 20).map((r) => r.pid)).toEqual([]);
    // A pid that claims to be its own parent must not loop forever.
    expect(descendantsOf([row(5, 5)], 5)).toEqual([]);
    expect(descendantsOf([], 1)).toEqual([]);
  });

  it("counts only what is still there, and only if it is still the same process", () => {
    const before = [row(1, 0, "next dev"), row(2, 1, "pool_entry")];
    expect(stillAlive(before, [row(2, 1, "pool_entry")]).map((r) => r.pid)).toEqual([2]);
    // The pid is gone: nothing survived.
    expect(stillAlive(before, [])).toEqual([]);
    // The pid came back as a different process — a reused pid is not a survivor.
    expect(stillAlive([row(1, 0, "next dev")], [row(1, 0, "something else")])).toEqual([]);
    // Where one side has no command line to compare, the pid is all we have.
    expect(stillAlive([row(1, 0, "")], [row(1, 0, "next dev")]).map((r) => r.pid)).toEqual([1]);
  });

  it("reads the table from /proc, parents and commands alike", () => {
    const files: Record<string, string> = {
      // The command contains spaces and a parenthesis: the parse keys off the
      // LAST ')' for exactly that reason.
      "/proc/22/stat": "22 (some worker (v2)) S 7 22 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 1234 0 0\n",
      "/proc/22/cmdline": "node\0worker.js\0",
      "/proc/1/stat": "1 (init) S 0 1 1 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0\n",
      "/proc/1/cmdline": "node\0server.mjs\0",
    };
    const rows = procProcessTable(
      "/proc",
      () => ["1", "22", "self", "999"],
      (path: string) => {
        // The real /proc exists only where the separator is `/`; this test just
        // has to speak the same path language the module does on its platform.
        const posix = path.replace(/\\/g, "/");
        if (!(posix in files)) throw new Error(`ENOENT ${posix}`);
        return files[posix];
      },
    );
    expect(rows).toEqual([
      { pid: 1, ppid: 0, command: "node server.mjs" },
      { pid: 22, ppid: 7, command: "node worker.js" },
    ]);
    // No /proc (macOS) is not an error: it is the signal to fall back to ps.
    expect(
      procProcessTable(
        "/proc",
        () => {
          throw new Error("ENOENT /proc");
        },
        () => "",
      ),
    ).toBeNull();
  });

  it("reads the ps fallback and the two engines Windows offers", () => {
    const ps = psProcessTable(() => ({ stdout: "  1   0 /sbin/init\n 22   1 node worker.js\n" }));
    expect(ps).toEqual([
      { pid: 1, ppid: 0, command: "/sbin/init" },
      { pid: 22, ppid: 1, command: "node worker.js" },
    ]);
    expect(psProcessTable(() => ({ error: new Error("ENOENT ps") }))).toEqual([]);

  });

  it("takes Windows' evidence from the kill's own report, both of its halves", () => {
    // Verbatim from taskkill on this machine, including which stream each half
    // arrives on: the successes are stdout, the errors are stderr. A parse of one
    // alone is half an audit.
    const stdout = "SUCCESS: The process with PID 26100 (child process of PID 67996) has been terminated.\r\n";
    const stderr = 'ERROR: The process "26101" not found.\r\nERROR: The process with PID 26102 could not be terminated.\r\n';
    expect(parseTaskkillReport(stdout)).toEqual({ terminated: [26100], failed: [] });
    expect(parseTaskkillReport(`${stdout}${stderr}`)).toEqual({ terminated: [26100], failed: [26102] });
    // "not found" is the audit succeeding late, not a survivor.
    expect(parseTaskkillReport(stderr)).toEqual({ terminated: [], failed: [26102] });
    expect(parseTaskkillReport(undefined)).toEqual({ terminated: [], failed: [] });
  });

  it("reads the tree it killed out of the kill's own report", () => {
    const calls: unknown[][] = [];
    const result = killTree({ pid: 4242, exitCode: null, signalCode: null }, {
      platform: "win32",
      spawnSyncImpl: (command: string, args: string[], options: object) => {
        calls.push([command, args, options]);
        return {
          status: 0,
          stdout: "SUCCESS: The process with PID 4242 (child process of PID 1) has been terminated.\r\n" +
            "SUCCESS: The process with PID 4243 (child process of PID 4242) has been terminated.\r\n",
          stderr: "",
        };
      },
    });
    expect(result.terminated).toEqual([4242, 4243]);
    expect(result.failed).toEqual([]);
    // Both streams must be captured for the failure half to exist at all.
    expect(calls[0][2]).toMatchObject({ stdio: ["ignore", "pipe", "pipe"] });
  });

  it("force-kills each named process the way its platform needs", () => {
    const spawns: string[][] = [];
    const windows = killPids([row(5, 1), row(6, 1)], {
      platform: "win32",
      run: (_command: string, args: string[]) => {
        spawns.push(args);
        return { status: 0, stdout: `SUCCESS: The process with PID ${args[1]} (child process of PID 1) has been terminated.\r\n` };
      },
    });
    // Per pid, never /t: a leftover may have been adopted by something innocent.
    expect(spawns).toEqual([
      ["/pid", "5", "/f"],
      ["/pid", "6", "/f"],
    ]);
    expect(windows).toEqual({ killed: [5, 6], failed: [] });

    // A pid taskkill refuses to end is reported as a failure, not flushed away.
    expect(
      killPids([row(5, 1)], {
        platform: "win32",
        run: () => ({ status: 1, stdout: "", stderr: "ERROR: The process with PID 5 could not be terminated.\r\n" }),
      }),
    ).toEqual({ killed: [], failed: [5] });

    const signalled: number[] = [];
    expect(
      killPids([row(5, 1), row(6, 1)], {
        platform: "linux",
        killPid: (pid: number) => signalled.push(pid),
      }),
    ).toEqual({ killed: [5, 6], failed: [] });
    expect(signalled).toEqual([5, 6]);

    // A process that got there first is the answer, not a failure — but any
    // other reason for not ending it is named.
    const esrch = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    expect(killPids([row(5, 1)], { platform: "linux", killPid: () => { throw esrch; } })).toEqual({
      killed: [5],
      failed: [],
    });
    expect(killPids([row(5, 1)], { platform: "linux", killPid: () => { throw new Error("EPERM"); } })).toEqual({
      killed: [],
      failed: [5],
    });
  });

  it("reports an audited kill, and takes out whatever outlived it", async () => {
    const tables: ReturnType<typeof row>[][] = [[row(100, 50, "next dev"), row(101, 100, "pool_entry")]];
    const lines: string[] = [];
    let killed: number[] = [];
    const child = { pid: 100, exitCode: null, signalCode: null };

    // Clean kill: one descendant, nothing left.
    tables.push([]);
    await terminate(
      { child, gone: Promise.resolve(), isExited: () => false },
      { kill: () => ({ killed: true }), sleepImpl: async () => {}, graceMs: 1, table: () => tables.shift() ?? [], log: (m: string) => lines.push(m) },
    );
    expect(lines).toEqual(["tree gone — 1 process(es), no survivors"]);

    // A worker that outlived the tree kill is named, killed, and checked again.
    lines.length = 0;
    tables.push([row(101, 100, "pool_entry")], [row(101, 100, "pool_entry")], []);
    await terminate(
      { child, gone: Promise.resolve(), isExited: () => false },
      {
        kill: () => ({ killed: true }),
        sleepImpl: async () => {},
        graceMs: 1,
        table: () => tables.shift() ?? [],
        killPids: (rows: { pid: number }[]) => {
          killed = rows.map((r) => r.pid);
          return { killed: rows.map((r) => r.pid), failed: [] };
        },
        log: (m: string) => lines.push(m),
      },
    );
    expect(killed).toEqual([101]);
    expect(lines).toEqual([
      "tree gone — 1 process(es), but 1 survived: 101 (pool_entry) — killing them",
      "the leftovers are gone",
    ]);

    // And when even that does not work, it says so instead of claiming success.
    lines.length = 0;
    tables.push([row(101, 100, "pool_entry")], [row(101, 100, "pool_entry")], [row(101, 100, "pool_entry")]);
    await terminate(
      { child, gone: Promise.resolve(), isExited: () => false },
      { kill: () => ({ killed: true, terminated: null, failed: null }), sleepImpl: async () => {}, graceMs: 1, table: () => tables.shift() ?? [], killPids: () => ({ killed: [], failed: [] }), log: (m: string) => lines.push(m) },
    );
    expect(lines[1]).toMatch(/still alive after a force kill: 101 \(pool_entry\) — the port may still be held/);
  });

  it("says the tree is gone from Windows' report, and takes out what it refused", async () => {
    const lines: string[] = [];
    const rows = (pids: number[]) => pids.map((pid) => ({ pid }));
    const run = { child: { pid: 100, exitCode: null, signalCode: null }, gone: Promise.resolve(), isExited: () => false };

    await terminate(run, {
      kill: () => ({ killed: true, terminated: [100, 101], failed: [] }),
      sleepImpl: async () => {},
      graceMs: 1,
      log: (m: string) => lines.push(m),
    });
    expect(lines).toEqual(["tree gone — 2 process(es), no survivors"]);

    // One taskkill could not end: it is named, retried alone, and confirmed.
    lines.length = 0;
    let retried: { pid: number }[] = [];
    await terminate(run, {
      kill: () => ({ killed: true, terminated: [100, 101], failed: [101] }),
      sleepImpl: async () => {},
      graceMs: 1,
      killPids: (named: { pid: number }[]) => {
        retried = named;
        return { killed: [101], failed: [] };
      },
      log: (m: string) => lines.push(m),
    });
    expect(retried).toEqual(rows([101]));
    expect(lines).toEqual([
      "tree gone — 2 process(es), but 1 survived: 101 — killing them",
      "the leftovers are gone",
    ]);

    // And when even that fails, it says so instead of claiming success.
    lines.length = 0;
    await terminate(run, {
      kill: () => ({ killed: true, terminated: [100, 101], failed: [101] }),
      sleepImpl: async () => {},
      graceMs: 1,
      killPids: () => ({ killed: [], failed: [101] }),
      log: (m: string) => lines.push(m),
    });
    expect(lines[1]).toMatch(/still alive after a force kill: 101 — the port may still be held/);
  });

  it("audits a run that died on its own only with evidence, and never dresses up a guess", async () => {
    const lines: string[] = [];
    const killed: unknown[] = [];
    // Nothing was killed here, and the tree can no longer be read from the root
    // either (on Linux the link dies with the parent). So there is nothing to
    // report — silence, rather than a clean bill of health nobody took.
    await terminate(
      { child: { pid: 100 }, gone: Promise.resolve(), isExited: () => true },
      {
        kill: () => {
          killed.push("kill");
          return { killed: false };
        },
        sleepImpl: async () => {},
        graceMs: 1,
        table: () => [row(101, 100, "pool_entry")],
        killPids: () => ({ killed: [], failed: [] }),
        log: (m: string) => lines.push(m),
      },
    );
    expect(killed).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe("dev supervisor — the recovery probe", () => {
  it("waits for an answer instead of assuming the restart worked", async () => {
    let calls = 0;
    const result = await probeUp(9, {
      timeoutMs: 2_000,
      intervalMs: 1,
      sleepImpl: async () => {},
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) throw new Error("ECONNREFUSED");
        return { status: 200 };
      },
    });
    expect(calls).toBe(3);
    expect(result).toEqual({ up: true, status: 200 });
  });

  it("asks again at the floor, so the line lands on the answer and not a tick later", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await probeUp(9, {
      timeoutMs: 2_000,
      intervalMs: 500,
      sleepImpl: async (ms: number) => {
        waits.push(ms);
      },
      fetchImpl: async () => {
        calls += 1;
        if (calls < 4) throw new Error("ECONNREFUSED");
        return { status: 200 };
      },
    });
    expect(result).toEqual({ up: true, status: 200 });
    expect(calls).toBe(4);
    // Three refusals, three waits — each the floor, none the poll interval. The
    // three-second entries in `waits` are each attempt's own request budget,
    // which is a clock on one attempt rather than the cadence between them.
    expect(waits.filter((ms) => ms <= 50)).toEqual([25, 25, 25]);
    expect(waits).not.toContain(500);
  });

  it("does not hang up on a server that answers slowly", async () => {
    // Measured on this repo: the first requests after a restart answered in
    // 3.5–22s, because that is a cold Turbopack compile of the route. The probe's
    // per-attempt budget used to be 3s, so it reported "the port has not
    // answered" about a port that had — and every request it abandoned left the
    // compile running. The attempt now gets the window; the answer is what
    // counts, however long it took.
    const result = await probeUp(9, {
      timeoutMs: 4_000,
      intervalMs: 1,
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        return { status: 200 };
      },
    });
    expect(result).toEqual({ up: true, status: 200 });
  });

  it("lets a caller ask for a cadence tighter than the floor", async () => {
    const waits: number[] = [];
    let calls = 0;
    await probeUp(9, {
      timeoutMs: 2_000,
      intervalMs: 5,
      sleepImpl: async (ms: number) => {
        waits.push(ms);
      },
      fetchImpl: async () => {
        calls += 1;
        if (calls < 2) throw new Error("ECONNREFUSED");
        return { status: 200 };
      },
    });
    expect(calls).toBe(2);
    expect(waits.filter((ms) => ms <= 50)).toEqual([5]);
  });

  it("stops probing when the run it is watching is gone", async () => {
    let calls = 0;
    const result = await probeUp(9, {
      timeoutMs: 2_000,
      intervalMs: 1,
      sleepImpl: async () => {},
      isDead: () => true,
      fetchImpl: async () => {
        calls += 1;
        return { status: 200 };
      },
    });
    expect(calls).toBe(0);
    expect(result).toEqual({ up: false, reason: "the server ended before it answered" });
  });

  it("gives up rather than waiting forever", async () => {
    const result = await probeUp(9, {
      timeoutMs: 20,
      intervalMs: 5,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result.up).toBe(false);
    expect(result.reason).toMatch(/no answer within/);
  });
});

describe("health checks — what makes a replacement worth keeping", () => {
  it("passes a server that answers, and says with what", async () => {
    expect(await healthCheck(9, { fetchImpl: async () => ({ status: 200 }) })).toEqual({
      ok: true,
      status: 200,
    });
  });

  it("fails a server that answers with a server error", async () => {
    // 5xx is the app saying it cannot serve, which is the case the rollback
    // exists for — and the status is carried so the log can name it.
    const result = await healthCheck(9, { fetchImpl: async () => ({ status: 500 }) });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.reason).toMatch(/HTTP 500/);
  });

  it("passes everything short of a server error", async () => {
    // A redirect, a missing page and a refusal-to-serve-the-thing are all a
    // server that is working: only the app failing to serve is a health failure.
    for (const status of [200, 204, 301, 307, 403, 404]) {
      expect((await healthCheck(9, { fetchImpl: async () => ({ status }) })).ok, String(status)).toBe(true);
    }
  });

  it("fails a server that is not answering, and one that is already gone", async () => {
    const silent = await healthCheck(9, {
      timeoutMs: 20,
      intervalMs: 5,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(silent.ok).toBe(false);
    expect(silent.reason).toMatch(/no answer within/);

    let calls = 0;
    const gone = await healthCheck(9, {
      timeoutMs: 1_000,
      intervalMs: 5,
      isDead: () => true,
      fetchImpl: async () => {
        calls += 1;
        return { status: 200 };
      },
    });
    expect(gone.ok).toBe(false);
    // Not even asked: a run that has ended cannot be healthy, and asking a dead
    // port is a question with one answer.
    expect(calls).toBe(0);
  });

  it("keeps asking inside its own window, so one check is more than one attempt", async () => {
    // The tolerance a single failed check of the rollback window rests on: a
    // server that is mid-restart, or busy for one request, gets the window to
    // answer in before it counts as having failed.
    let calls = 0;
    const result = await healthCheck(9, {
      timeoutMs: 1_000,
      intervalMs: 5,
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) throw new Error("ECONNREFUSED");
        return { status: 200 };
      },
    });
    expect(result).toEqual({ ok: true, status: 200 });
    expect(calls).toBe(3);
  });
});

describe("a run's own port — the one thing a front door has to hand out", () => {
  it("hands back a port the OS is not using", async () => {
    const port = await reservePort();
    expect(port).toBeGreaterThan(0);
    // Proved by taking it: a number nothing can bind is not a port.
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe("how long a reload's way back is kept — the window the app's traffic asks for", () => {
  // One reload, swapped at a fixed instant, so every number below is arithmetic
  // on the traffic alone: the window is a function of what the app did with the
  // replacement, and it does not read a clock to find out (that is the point of
  // anchoring it to the last connection — see `rollbackWindowFor`).
  const SWAP = 1_000_000;
  const at = (offset: number) => SWAP + offset;
  const window = (options: {
    arrivals: number[];
    served: number;
    proofConnections?: number;
    minMs?: number;
    maxMs?: number;
  }) =>
    rollbackWindowFor({
      swappedAt: SWAP,
      minMs: 2_000,
      maxMs: 90_000,
      ...options,
    });

  it("closes a busy window at the floor, because those connections arrived at speed", () => {
    // Twenty a second: whatever the ceiling is, this is an app that is USING the
    // replacement, and the way back does not need a long window to be the way back.
    expect(window({ arrivals: [at(0), at(50), at(100), at(150)], served: 20 })).toBe(2_000);
  });

  it("keeps a quiet window for the whole ceiling", () => {
    // Nothing has arrived at all — or exactly one connection, which is not a rate
    // that can be read. No traffic means no evidence, and the ceiling is what a
    // window with no evidence in it is allowed: this is the case the traffic rule
    // makes LONGER than a busy one, not equal to it.
    expect(window({ arrivals: [], served: 0 })).toBe(90_000);
    expect(window({ arrivals: [at(120)], served: 1 })).toBe(90_000);
  });

  it("sizes the window by the rate the app is sending at, not by the clock", () => {
    // One connection every ten seconds, two of them so far: the third — the one a
    // proof needs — is ten seconds away, so the window is the last arrival plus ten
    // seconds. Three minutes of ceiling would be three minutes of waiting for
    // evidence that has already said what it can say.
    expect(window({ arrivals: [at(10_000), at(20_000)], served: 2, maxMs: 180_000 })).toBe(30_000);
    // Two connections half a second apart, with seven of the nine a proof would
    // need: the two still missing are half a second each away, so the window is
    // the last arrival plus a second — two and a half seconds, inside both bounds.
    expect(window({ arrivals: [at(1_000), at(1_500)], served: 7, proofConnections: 9 })).toBe(2_500);
  });

  it("never closes sooner than the floor, however fast the connections arrive", () => {
    // A burst: two connections a tenth of a second apart, then silence. The rate
    // says the last missing connection is a tenth of a second away, and the floor
    // says a window is never that short — the health checks a proof rests on have
    // to be passable at all before traffic can retire the way back.
    expect(window({ arrivals: [at(100), at(200)], served: 2 })).toBe(2_000);
    // …and the same when the proof is already met: nothing is left to wait for.
    expect(window({ arrivals: [at(100), at(200)], served: 5 })).toBe(2_000);
  });

  it("keeps the ceiling when the rate asks for longer than it is allowed", () => {
    // One every 30s, one more needed: the rate asks for a 90s window, and 60s is
    // what the operator allows. The ceiling is a promise about how long two
    // servers can be up, so it wins.
    expect(window({ arrivals: [at(30_000), at(60_000)], served: 2, maxMs: 60_000 })).toBe(60_000);
    // A floor above the ceiling is not a floor: the ceiling is still the answer.
    expect(window({ arrivals: [at(100), at(200)], served: 2, minMs: 5_000, maxMs: 4_000 })).toBe(4_000);
  });

  it("leaves the clock to decide when early retirement is switched off", () => {
    // `proofConnections: 0` says nothing can prove the replacement, so there is no
    // rate for a window to be derived from: the ceiling is the whole of it.
    expect(window({ arrivals: [at(100), at(200)], served: 10, proofConnections: 0 })).toBe(90_000);
  });

  it("has no window at all when there is no way back", () => {
    expect(window({ arrivals: [at(100)], served: 1, maxMs: 0 })).toBe(0);
  });

  it("reads a rate from the instants it is given, and none from one instant", () => {
    expect(meanGapMs([at(0), at(50), at(100), at(150)])).toBe(50);
    expect(meanGapMs([at(10_000), at(20_000)])).toBe(10_000);
    // One connection is not a rate — neither zero nor infinite — and no connections
    // is the same nothing.
    expect(meanGapMs([at(120)])).toBeNull();
    expect(meanGapMs([])).toBeNull();
  });

  it("says a rate at the precision a rate needs", () => {
    // What a window decided by traffic gets logged with. Whole seconds are right
    // for a lifetime and useless for a burst: a gap of 40ms would read as `0s`,
    // which is how a busy window would come to look like a broken one.
    expect(formatGapMs(40)).toBe("40ms");
    expect(formatGapMs(150)).toBe("0.2s");
    expect(formatGapMs(2_500)).toBe("2.5s");
    expect(formatGapMs(10_000)).toBe("10s");
    expect(formatGapMs(90_000)).toBe("1m 30s");
  });
});

describe("the front door — the port that outlives the server", () => {
  /** A backend that answers with its own name, so a swap is observable. */
  async function backend(name: string) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(name);
    });
    const port = await freePort();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
    return {
      port,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  /** One request over a kept-alive connection, which is what a client reuses. */
  const overKeptConnection = (agent: Agent, port: number) =>
    new Promise<string>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/", agent }, (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk.toString();
        });
        res.on("end", () => resolve(text));
      });
      req.on("error", reject);
      req.end();
    });

  it("answers 503 for itself while nothing is behind it, instead of refusing the connection", async () => {
    const port = await freePort();
    const front = new FrontDoor({ port, host: "127.0.0.1" });
    await front.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(response.status).toBe(503);
      expect(await response.text()).toMatch(/not answering/);
      expect(front.countFor(port)).toBe(0);
      // A connection the door answered ITSELF is not traffic the app served:
      // what the door counts as use is what it piped somewhere.
      expect(front.usesFor(port)).toBe(0);
    } finally {
      await front.close();
    }
  });

  it("swaps targets without ever closing the port, and leaves existing connections on the run they were piped to", async () => {
    const first = await backend("first");
    const second = await backend("second");
    const port = await freePort();
    const front = new FrontDoor({ port, host: "127.0.0.1" });
    await front.listen();
    // A client that keeps its connection — which is what a browser does, and
    // the reason a swap can be invisible to one: its socket is already piped.
    const held = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      expect(front.setTarget(first.port)).toBeNull();
      expect(await overKeptConnection(held, port)).toBe("first");
      // One client connection reached the run behind the door, and the door says
      // so — this count is the supervisor's only account of real traffic.
      expect(front.usesFor(first.port)).toBe(1);
      expect(front.usesFor(second.port)).toBe(0);

      // The swap is a pointer move: nothing is closed, nothing is re-bound.
      expect(front.setTarget(second.port)).toBe(first.port);
      // A connection opened after it is served by the replacement…
      expect(await overKeptConnection(new Agent({ keepAlive: false }), port)).toBe("second");
      // …while the connection that was already piped stays where it was piped,
      // which is what lets a request already in flight come back after the swap.
      expect(await overKeptConnection(held, port)).toBe("first");
      expect(front.countFor(first.port)).toBe(1);
      // The counters are the runs', not the door's: what the app did with each
      // server is still separable after the port has moved, which is what lets a
      // reload judge the replacement by the traffic IT was given.
      expect(front.usesFor(first.port)).toBe(1);
      expect(front.usesFor(second.port)).toBe(1);
    } finally {
      held.destroy();
      await front.close();
      await first.close();
      await second.close();
    }
  });

  it("keeps a connection it piped when the other half of an earlier one ends after it", async () => {
    // The two halves of ONE connection end at different moments, and the door is told
    // about both: the upstream socket going away first, then the client's own socket,
    // which a keep-alive client can hold open for as long as it likes. `live` is keyed
    // by target port and a set is only installed for a port that has none, so a
    // connection arriving BETWEEN the two closes installs its own set — and a door
    // that deleted the port's entry on behalf of the already-empty set the first
    // connection had installed takes the live connection out of its count. Not
    // hypothetical: a real soak's held connection disappeared from
    // `leftoverConnections` during the 3ms between one client's two closes, and the
    // door was reported as having moved a connection a client was still holding.
    const closing = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", connection: "close" });
      res.end("first");
    });
    const backendPort = await freePort();
    await new Promise<void>((resolve) => closing.listen(backendPort, "127.0.0.1", () => resolve()));
    const port = await freePort();
    const front = new FrontDoor({ port, host: "127.0.0.1" });
    await front.listen();
    // `allowHalfOpen`: the first client keeps its half of the connection after the run
    // behind the door has finished with it, which is what puts real time between the
    // two closes instead of the tick the door would otherwise get.
    const first = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    let second: ReturnType<typeof connect> | null = null;
    try {
      front.setTarget(backendPort);
      // Read the bytes: a socket nobody reads from never reaches the end of its
      // stream, and the FIN after this response is half of what the test is about.
      first.on("data", () => {});
      await new Promise<void>((resolve, reject) => {
        first.once("error", reject);
        first.once("connect", () => {
          first.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        });
        first.once("end", () => resolve());
      });
      // The run answered and let go of the upstream half. The client's half is still
      // open, so the door has heard about one end of this connection and not the other.
      await new Promise((resolve) => setTimeout(resolve, 60));
      const arriving = connect({ port, host: "127.0.0.1" });
      second = arriving;
      await new Promise<void>((resolve) => arriving.once("connect", () => resolve()));
      expect(front.countFor(backendPort)).toBe(1);
      // ...and now the first client's half ends: the second time the door is told
      // about that one connection. Whoever is still piped to this run stays piped.
      first.destroy();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(front.countFor(backendPort)).toBe(1);
      expect(front.usesFor(backendPort)).toBe(2);
    } finally {
      first.destroy();
      second?.destroy();
      await front.close();
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
  });

  it("remembers when the connections it hands a run arrived, and only the recent ones", async () => {
    const first = await backend("first");
    const port = await freePort();
    // A ring of two, so that what is kept is provably the LAST few arrivals rather
    // than a history: what the app did a minute ago says nothing about the rate it
    // is sending at now.
    const front = new FrontDoor({ port, host: "127.0.0.1", trafficSample: 2 });
    await front.listen();
    try {
      // Nothing has been sent yet: a rate nobody can read, rather than a slow one.
      expect(front.arrivalsFor(first.port)).toEqual([]);
      expect(meanGapMs(front.arrivalsFor(first.port))).toBeNull();
      expect(front.setTarget(first.port)).toBeNull();
      const before = Date.now();
      for (let sent = 0; sent < 3; sent += 1) {
        await overKeptConnection(new Agent({ keepAlive: false }), port);
      }
      const arrivals = front.arrivalsFor(first.port);
      expect(arrivals).toHaveLength(2);
      // Counted in full even though only the last two instants are kept: the count
      // says whether the app has USED a run, the instants say how hard.
      expect(front.usesFor(first.port)).toBe(3);
      expect(arrivals[0]).toBeGreaterThanOrEqual(before);
      expect(arrivals[0]).toBeLessThanOrEqual(arrivals[1]);
    } finally {
      await front.close();
      await first.close();
    }
  });

  it("starts a run it is pointed at fresh, however much traffic that port served before", async () => {
    // The counters are keyed by PORT, and a port outlives the process that held
    // it: a replacement handed a port an older run used must not begin with THAT
    // run's traffic, or the window its traffic decides would be decided on evidence
    // about a process that no longer exists.
    const only = await backend("only");
    const port = await freePort();
    const front = new FrontDoor({ port, host: "127.0.0.1" });
    await front.listen();
    try {
      front.setTarget(only.port);
      await overKeptConnection(new Agent({ keepAlive: false }), port);
      expect(front.usesFor(only.port)).toBe(1);
      expect(front.arrivalsFor(only.port)).toHaveLength(1);
      // The door is pointed somewhere else and then back at this port, which is
      // what happens to a run that is reloaded on the same port, and to the run a
      // rollback hands the port back to.
      front.setTarget(null);
      front.setTarget(only.port);
      expect(front.usesFor(only.port)).toBe(0);
      expect(front.arrivalsFor(only.port)).toEqual([]);
    } finally {
      await front.close();
      await only.close();
    }
  });

  it("gives the port back when it closes", async () => {
    const port = await freePort();
    const front = new FrontDoor({ port, host: "127.0.0.1" });
    await front.listen();
    await front.close();
    const again = createServer();
    await new Promise<void>((resolve, reject) => {
      again.once("error", reject);
      again.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => again.close(() => resolve()));
  });

  it("refuses to open on a port somebody else holds", async () => {
    const holder = createServer();
    const port = await freePort();
    // The same interface it is asked for: binding a port is per address, so a
    // holder on one interface is not always a holder on another.
    await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", () => resolve()));
    const front = new FrontDoor({ port, host: "127.0.0.1" });
    try {
      await expect(front.listen()).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await front.close();
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });
});

describe("reload requests — one at a time, and the sentinel is consumed", () => {
  it("keeps what arrives while the loop is busy, and coalesces what does not have to be kept", async () => {
    const queue = new ReloadQueue();
    expect(queue.request("first")).toBe(true);
    // Ten touches of a sentinel are one reload, not ten.
    expect(queue.request("second")).toBe(false);
    // Read once, and there is nothing waiting after it.
    expect(await queue.next()).toBe("first");
    let reloading = false;
    void queue.next().then(() => {
      reloading = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reloading).toBe(false);
    // …until something asks again, which is served immediately rather than lost.
    queue.request("third");
    expect(await queue.next()).toBe("third");
  });

  it("wakes a loop that is already waiting for one", async () => {
    const queue = new ReloadQueue();
    const waiting = queue.next();
    queue.request("touched");
    await expect(waiting).resolves.toBe("touched");
  });

  it("reads the sentinel and removes it, so one touch is one reload", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "anybase-reload-")), ".reload");
    const asked: string[] = [];
    const watcher = watchReloadFile({ file, pollMs: 10, onReload: (why) => asked.push(why) });
    try {
      writeFileSync(file, "reload\n");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(asked).toEqual([file]);
      expect(existsSync(file)).toBe(false);
      // Nothing left to read is nothing left to ask for.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(asked).toHaveLength(1);
    } finally {
      watcher?.stop();
    }
  });

  it("leaves a file it cannot remove alone rather than reading half a request", async () => {
    const asked: string[] = [];
    const watcher = watchReloadFile({
      file: "not-really-there",
      pollMs: 5,
      onReload: (why) => asked.push(why),
      // What a file somebody is still writing looks like on Windows.
      fs: {
        existsSync: () => true,
        unlinkSync: () => {
          throw new Error("EBUSY: resource busy or locked");
        },
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(asked).toEqual([]);
    } finally {
      watcher?.stop();
    }
  });

  it("does nothing at all without a file to watch", () => {
    expect(watchReloadFile({ file: null, onReload: () => {} })).toBeNull();
    expect(watchReloadFile({ file: "", onReload: () => {} })).toBeNull();
  });
});

describe("a reload's record — what a deploy pipeline reads instead of a log", () => {
  // A fixed instant, so the assertions below are about the record and not about
  // how long the test took to run.
  const at = Date.UTC(2026, 9, 14, 12, 0, 0, 0);

  it("names the three moments, the outcome, what closed the window and the evidence", () => {
    const record = reloadRecord({
      asked: "SIGHUP",
      outcome: "replaced",
      closedBy: "traffic",
      startedAt: at,
      at: at + 2500,
      swappedAt: at + 300,
      windowMs: 30_000,
      proofConnections: 3,
      served: 20,
      checks: 2,
      leftoverConnections: 1,
      replacementPort: 51_234,
      previousPort: 51_235,
      frontPort: 3000,
    });
    expect(record).toEqual({
      schema: RELOAD_HISTORY_SCHEMA,
      at: "2026-10-14T12:00:02.500Z",
      startedAt: "2026-10-14T12:00:00.000Z",
      swappedAt: "2026-10-14T12:00:00.300Z",
      asked: "SIGHUP",
      outcome: "replaced",
      closedBy: "traffic",
      rolledBack: false,
      windowMs: 30_000,
      // The window the app closed early: 2.2s of the 30s it was allowed, which is
      // the number a pipeline checks the log's claim against.
      windowUsedMs: 2_200,
      proofConnections: 3,
      served: 20,
      checks: 2,
      leftoverConnections: 1,
      replacementPort: 51_234,
      previousPort: 51_235,
      frontPort: 3000,
      detail: null,
    });
  });

  it("says a rollback was a rollback, in the shape an alarm wants", () => {
    const record = reloadRecord({
      asked: "reload",
      outcome: "rolled-back",
      closedBy: "check",
      detail: "the replacement failed its health check (it answered HTTP 500)",
      startedAt: at,
      at: at + 1000,
      swappedAt: at + 100,
      windowMs: 8000,
      proofConnections: 3,
      served: 4,
      checks: 1,
    });
    expect(record).toMatchObject({
      outcome: "rolled-back",
      rolledBack: true,
      closedBy: "check",
      windowUsedMs: 900,
      detail: "the replacement failed its health check (it answered HTTP 500)",
    });
  });

  it("does not invent a window that was never open", () => {
    // Nothing was swapped in — the replacement never came up — so there is no
    // window to have closed and nothing to measure: null says that, and 0 would
    // say a window opened and lasted no time at all.
    const record = reloadRecord({
      asked: "reload",
      outcome: "kept",
      closedBy: null,
      detail: "the replacement never came up (no answer within 30s)",
      startedAt: at,
      at: at + 4000,
      windowMs: 30_000,
      proofConnections: 3,
    });
    expect(record).toMatchObject({
      outcome: "kept",
      closedBy: null,
      rolledBack: false,
      swappedAt: null,
      windowUsedMs: null,
      served: 0,
      checks: 0,
    });
  });

  it("writes one parseable line per record, appended rather than rewritten", () => {
    const file = join(mkdtempSync(join(tmpdir(), "anybase-reload-history-")), "reloads.jsonl");
    const replaced = reloadRecord({
      asked: "SIGHUP",
      outcome: "replaced",
      closedBy: "clock",
      startedAt: at,
      at: at + 1000,
      swappedAt: at + 100,
      windowMs: 30_000,
      proofConnections: 3,
    });
    const undone = reloadRecord({
      asked: "reload",
      outcome: "rolled-back",
      closedBy: "exit",
      startedAt: at,
      at: at + 2000,
      swappedAt: at + 100,
      windowMs: 30_000,
      proofConnections: 3,
    });
    expect(appendReloadRecord(file, replaced)).toBe(true);
    expect(appendReloadRecord(file, undone)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    // Two reloads, two lines: the first record is still there after the second,
    // which is what makes the file readable while it is being written.
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ schema: RELOAD_HISTORY_SCHEMA, outcome: "replaced" });
    expect(JSON.parse(lines[1])).toMatchObject({ outcome: "rolled-back", rolledBack: true });
  });

  it("reports a record it could not write rather than dying over it", () => {
    const said: string[] = [];
    const landed = appendReloadRecord(
      "/nowhere/at/all/reloads.jsonl",
      reloadRecord({
        asked: "SIGHUP",
        outcome: "replaced",
        closedBy: "clock",
        startedAt: at,
        at: at + 1000,
        swappedAt: at + 100,
        windowMs: 30_000,
        proofConnections: 3,
      }),
      {
        log: (message: string) => said.push(message),
        appendFile: () => {
          throw new Error("ENOENT: no such file or directory");
        },
      },
    );
    expect(landed).toBe(false);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/could not be written to \/nowhere\/at\/all\/reloads\.jsonl .*ENOENT/);
  });
});

const DEV_SCRIPT = join(process.cwd(), "scripts", "dev.mjs");
const FIXTURE = join(process.cwd(), "tests", "fixtures", "dev-death-server.mjs");

/** Poll until something answers on the port, so a test can use it as a person would. */
async function waitForHttp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`nothing answered on ${port} within ${timeoutMs}ms`);
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function runSupervisor(env: Record<string, string>, args: string[] = []) {
  const child = spawn(process.execPath, [DEV_SCRIPT, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // The supervisor runs the same code path as `npm run dev`; only the
      // program under it changes, so the test does not need a real compile.
      DEV_SERVER_CMD: `"${process.execPath}" "${FIXTURE}"`,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });

  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  return { child, exited, text: () => output };
}

/** Never leave a supervisor (or its fixture) behind after a failed assertion. */
function reap(session: { child: { pid?: number; exitCode: number | null } }) {
  if (!session.child.pid || session.child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(session.child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-session.child.pid, "SIGKILL");
  } catch {
    // Already gone between the check and the signal.
  }
}

describe("dev supervisor — end to end", () => {
  it(
    "restarts the server when the pool dies, and gives up when every run dies too",
    { timeout: 60_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "anybase-dev-supervisor-"));
      const counter = join(dir, "runs.txt");
      const port = await freePort();
      const session = runSupervisor({
        FAKE_COUNTER_FILE: counter,
        FAKE_DEATH_RUNS: "99",
        // Long enough that each fresh server answers the recovery probe's next
        // attempt before it dies again; otherwise the restart is real but
        // unconfirmed, which is a different assertion. The probe asks again at
        // its floor (25ms), so this is a wide margin even on a loaded machine.
        FAKE_DEATH_DELAY_MS: "1500",
        FAKE_PORT: String(port),
        DEV_MAX_RESTARTS: "2",
        DEV_BACKOFF_MS: "20",
        DEV_BACKOFF_MAX_MS: "40",
      });

      try {
        const { code } = await session.exited;
        const output = session.text();

        // Three runs: the original plus two restarts, then it stops.
        expect(readFileSync(counter, "utf8")).toBe("3");
        expect(code).toBe(1);
        expect(output).toMatch(/Turbopack's transform worker pool died: Jest worker encountered 2/);
        expect(output).toMatch(/restart 1\/2 in 20ms/);
        expect(output).toMatch(/restart 2\/2 in 40ms/);
        expect(output).toMatch(/giving up/);

        // Every run really took the port: if the kill had left the previous
        // server (or its children) behind, the next listen would have failed.
        expect(output).not.toMatch(/could not listen/);
        expect(output.match(/\[fake\] run \d+ listening on/g) ?? []).toHaveLength(3);

        // And recovery was only claimed on evidence — each restart answered HTTP.
        expect(output.match(/\[dev\] back up — http:\/\/127\.0\.0\.1:\d+ answered HTTP 200/g) ?? []).toHaveLength(3);

        // Every kill was audited, and the fixture's own worker — a genuine
        // child, like `start-server` and the transform workers — outlived none
        // of the three runs. How many processes the audit counts differs by
        // platform (POSIX enumerates the subtree below the root; Windows reads
        // taskkill's report, which names the root too), so the count is not the
        // assertion — the verdict is.
        expect(output.match(/tree gone — \d+ process\(es\), no survivors/g) ?? []).toHaveLength(3);
        expect(output).not.toMatch(/survived:|leftovers are gone|still alive after/);
      } finally {
        reap(session);
      }
    },
  );

  it(
    "follows the banner when the pinned port is not the port the server bound",
    { timeout: 60_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "anybase-dev-supervisor-"));
      const counter = join(dir, "runs.txt");
      // `-p` says one thing; the server binds another. That is what the banner
      // is for, and a supervisor that keeps probing the port it assumed would
      // report nothing at all about the server it is actually running.
      const pinned = await freePort();
      const bound = await freePort();
      const session = runSupervisor(
        {
          FAKE_COUNTER_FILE: counter,
          FAKE_DEATH_RUNS: "0",
          FAKE_CLEAN_EXIT_MS: "2500",
          FAKE_PORT: String(bound),
        },
        ["-p", String(pinned)],
      );

      try {
        const { code } = await session.exited;
        const output = session.text();

        expect(code).toBe(0);
        expect(output).toMatch(new RegExp(`back up — http://127\\.0\\.0\\.1:${bound} answered HTTP 200`));
        expect(output).not.toMatch(new RegExp(`127\\.0\\.0\\.1:${pinned}`));
      } finally {
        reap(session);
      }
    },
  );

  it(
    "re-requests the pages that were in use once the replacement server answers",
    { timeout: 60_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "anybase-dev-supervisor-"));
      const counter = join(dir, "runs.txt");
      const requests = join(dir, "requests.txt");
      const port = await freePort();
      const session = runSupervisor({
        FAKE_COUNTER_FILE: counter,
        FAKE_REQUEST_LOG: requests,
        FAKE_DEATH_RUNS: "1",
        FAKE_DEATH_DELAY_MS: "2500",
        FAKE_CLEAN_EXIT_MS: "2500",
        FAKE_PORT: String(port),
        DEV_MAX_RESTARTS: "5",
        DEV_BACKOFF_MS: "20",
        DEV_WARM_LIMIT: "3",
      });

      try {
        // Use the first server the way a person would, then let the pool die
        // under it: one page with a query string, and one API call that must
        // never be replayed by anyone but the client.
        await waitForHttp(port, 20_000);
        await fetch(`http://127.0.0.1:${port}/settings/?tab=keys`);
        await fetch(`http://127.0.0.1:${port}/api/models`);
        const { code } = await session.exited;

        const lines = readFileSync(requests, "utf8").split("\n").filter(Boolean);
        const byRun = (run: string) => lines.filter((line) => line.startsWith(`${run} `)).map((line) => line.split(" ")[1]);
        const first = byRun("1");
        const second = byRun("2");

        expect(code).toBe(0);
        // The page the person used, replayed — with their query string dropped
        // (what compiles is the route) and the supervisor's own marker on it.
        expect(first).toContain("/settings/?tab=keys");
        expect(second).toContain("/settings/?_warm=1");
        // …and the API route they never see replayed on their behalf.
        expect(first).toContain("/api/models");
        expect(second).not.toContain("/api/models");
        expect(second.every((path) => !path.includes("tab="))).toBe(true);
        // Nothing unmarked reached run 2 except by way of the probe's own
        // marked request: the supervisor is the only caller here.
        expect(second.every((path) => path.includes("_warm=1"))).toBe(true);

        // Two pages were warmable in run 1: /settings/ and the / the poll
        // above used. Most recent first, so /settings/ leads.
        const output = session.text();
        expect(output).toMatch(/re-requesting 2 page\(s\) that were in use.*: \/settings\/ \//);
        expect(output).toMatch(/warmed \/settings\/ → 200; \/ → 200/);
      } finally {
        reap(session);
      }
    },
  );

  it(
    "recovers once and then leaves a healthy server alone",
    { timeout: 60_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "anybase-dev-supervisor-"));
      const counter = join(dir, "runs.txt");
      const port = await freePort();
      const session = runSupervisor({
        FAKE_COUNTER_FILE: counter,
        FAKE_DEATH_RUNS: "1",
        // Same margin as the case above: the first run must live long enough for
        // the probe to confirm it before the pool takes it down, otherwise the
        // "recovered over HTTP" count is about timing rather than about the
        // supervisor confirming recovery.
        FAKE_DEATH_DELAY_MS: "1500",
        // Long enough for the restart to be confirmed over HTTP before the
        // fixture decides to exit cleanly (same 3× margin over the 500ms probe).
        FAKE_CLEAN_EXIT_MS: "2500",
        FAKE_PORT: String(port),
        DEV_MAX_RESTARTS: "5",
        DEV_BACKOFF_MS: "20",
      });

      try {
        const { code } = await session.exited;
        const output = session.text();

        expect(readFileSync(counter, "utf8")).toBe("2");
        // A clean exit is a decision, not a crash: the supervisor reports it and
        // returns the server's own code instead of resurrecting it.
        expect(code).toBe(0);
        expect(output).toMatch(/exited cleanly — not restarting/);
        // Both runs were confirmed over HTTP: the one the pool killed, and the
        // healthy replacement that took its port.
        expect(output.match(/\[dev\] back up — http:\/\/127\.0\.0\.1:\d+ answered HTTP 200/g) ?? []).toHaveLength(2);
        expect(output.match(/transform worker pool died/g) ?? []).toHaveLength(1);
        expect(output.match(/\[dev\] restart 1\/5/g) ?? []).toHaveLength(1);
        // The kill that led to that restart was audited; the clean exit that
        // ended the healthy run was not a kill, so there is nothing to report
        // about it.
        expect(output.match(/tree gone —/g) ?? []).toHaveLength(1);
        expect(output).toMatch(/\[fake\] run 2 listening/);
        expect(output).toMatch(/\[fake\] healthy/);
        expect(output).not.toMatch(/giving up/);
        expect(output).not.toMatch(/could not listen/);

      } finally {
        reap(session);
      }
    },
  );
});
