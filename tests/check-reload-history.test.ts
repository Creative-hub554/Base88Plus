/**
 * Pins for scripts/check-reload-history.mjs — the gate a deploy step runs after
 * a reload, whose whole answer is an exit code.
 *
 * The fixtures are built by `reloadRecord` from `scripts/supervise.mjs`, which is
 * the code that WRITES a line: the reader is therefore pinned against the writer's
 * own output shape rather than against a literal copied out of a log, and a change
 * to a field the writer emits shows up here as a reader that has fallen behind it.
 *
 * The three exit codes are the interface, so they are asserted twice: as a unit
 * with the clock, the file and the two streams injected — where the cases that
 * cannot be manufactured from a real process live, like a wait that times out and
 * a record that is a day old — and through the real process, because that is what
 * a deploy script actually runs. The load-bearing one is the record that is OLDER
 * than the reload being checked: a reload that never happened writes nothing at
 * all, so an unconditional "last line" reader would pass a stale green record as
 * this deploy's. `exit 2` there is the false pass being refused.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  USAGE,
  main,
  parseArgs,
  parseWhen,
} from "../scripts/check-reload-history.mjs";
import { OUTCOME_VERDICT } from "../src/lib/deploy/reload-history";
import { RELOAD_HISTORY_SCHEMA, reloadRecord } from "../scripts/supervise.mjs";

const HERE = process.cwd();
const SCRIPT = join(HERE, "scripts", "check-reload-history.mjs");
const scriptSource = (name: string) => readFileSync(join(HERE, "scripts", name), "utf8");

/** A moment the injected clock can be pinned to, so nothing here reads the wall. */
const AT = Date.parse("2026-10-14T12:00:00.000Z");

type Outcome = "replaced" | "stopped" | "kept" | "rolled-back" | "no-fallback";

const CLOSED_BY: Record<Outcome, string | null> = {
  replaced: "traffic",
  stopped: "shutdown",
  kept: null,
  "rolled-back": "check",
  "no-fallback": "exit",
};

const DETAIL: Record<Outcome, string | null> = {
  replaced: null,
  stopped: "a shutdown ended the reload before the window did",
  kept: "the replacement never came up (it ended before it answered)",
  "rolled-back": "the replacement failed its health check (it answered HTTP 500)",
  "no-fallback": "the replacement exited (code 1), and the run it replaced was gone",
};

/** One record, in the shape the supervisor writes to `PROD_RELOAD_HISTORY`. */
const recordFor = (outcome: Outcome, overrides: Record<string, unknown> = {}) =>
  reloadRecord({
    asked: "/srv/.reload",
    outcome,
    closedBy: CLOSED_BY[outcome],
    detail: DETAIL[outcome],
    startedAt: AT - 2_500,
    at: AT,
    // A `kept` reload never opened a window: nothing was swapped in.
    swappedAt: outcome === "kept" ? null : AT - 2_000,
    windowMs: 30_000,
    proofConnections: 3,
    served: 64,
    checks: 2,
    leftoverConnections: 0,
    replacementPort: 51_234,
    previousPort: 51_235,
    frontPort: 3_000,
    ...overrides,
  });

const jsonl = (...records: Record<string, unknown>[]) =>
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

/** A record whose `at` really is now, for the cases a real process drives. */
const agedRecord = (outcome: Outcome, ageMs = 0) => {
  const at = Date.now() - ageMs;
  return recordFor(outcome, {
    at,
    startedAt: at - 2_500,
    swappedAt: outcome === "kept" ? null : at - 2_000,
  });
};

function fakeClock(start = AT) {
  let current = start;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
    sleeps,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

interface Deps {
  env?: Record<string, string | undefined>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readFile?: (path: string) => string;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/** The gate with everything outside it replaced, returning what it said. */
async function gate(argv: string[], deps: Deps = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const clock = fakeClock();
  const code = await main(argv, {
    env: deps.env ?? {},
    now: deps.now ?? clock.now,
    sleep: deps.sleep ?? clock.sleep,
    readFile:
      deps.readFile ??
      ((path: string) => {
        const error: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${path}'`);
        error.code = "ENOENT";
        throw error;
      }),
    out: deps.out ?? ((text: string) => void out.push(text)),
    err: deps.err ?? ((text: string) => void err.push(text)),
  });
  return { code, out: out.join(""), err: err.join(""), sleeps: clock.sleeps };
}

/** A fresh temp path per test, with the file written when there is something to write. */
function historyFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "anybase-reload-gate-"));
  const file = join(dir, "reloads.jsonl");
  if (contents !== "") writeFileSync(file, contents);
  return file;
}

describe("the gate's strictness: the writer's schema, and the page's leniency refused", () => {
  it("takes the schema from the single declaration instead of restating it", () => {
    // `base88.reload/1` is declared once, in scripts/supervise.mjs, and imported.
    // A second copy is how a reader ends up accepting a shape nobody writes.
    expect(scriptSource("check-reload-history.mjs")).toMatch(
      /import \{ RELOAD_HISTORY_SCHEMA \} from "\.\/supervise\.mjs"/,
    );
    expect(scriptSource("check-reload-history.mjs")).not.toMatch(/export const RELOAD_HISTORY_SCHEMA/);
  });

  it("refuses a record from a schema it does not know, which the settings page would show", async () => {
    // One shared reader, two policies: the page keeps a record from a newer
    // supervisor and names the outcome it cannot interpret, and this — the thing a
    // pipeline branches on — refuses to judge at all. Without the schema argument
    // the gate would inherit the page's leniency and pass on a vocabulary it has
    // never heard of.
    const { code, err } = await gate(["/srv/reloads.jsonl"], {
      readFile: () => jsonl({ ...recordFor("replaced"), schema: "base88.reload/2" }),
    });
    expect(code).toBe(2);
    expect(err).toContain(`schema "base88.reload/2" is not ${RELOAD_HISTORY_SCHEMA}`);
  });

  it("judges with the shared vocabulary rather than one of its own", () => {
    // The same verdict object the settings page colours its rows with, so a page
    // cannot show a rollback as fine while this fails a deploy over it.
    expect(scriptSource("check-reload-history.mjs")).toMatch(
      /from "\.\.\/src\/lib\/deploy\/reload-history\.ts"/,
    );
    expect(OUTCOME_VERDICT["rolled-back"].landed).toBe(false);
  });
});

describe("--since: what a window means", () => {
  it("reads a duration back from now, in the units a deploy would write", () => {
    expect(parseWhen("-90s", AT)).toBe(AT - 90_000);
    expect(parseWhen("-5m", AT)).toBe(AT - 300_000);
    expect(parseWhen("-2h", AT)).toBe(AT - 7_200_000);
    expect(parseWhen("-1d", AT)).toBe(AT - 86_400_000);
    expect(parseWhen("-750ms", AT)).toBe(AT - 750);
  });

  it("reads an instant, either as epoch milliseconds or as a timestamp", () => {
    expect(parseWhen(String(AT), AT)).toBe(AT);
    expect(parseWhen("2026-10-14T11:59:00.000Z", AT)).toBe(AT - 60_000);
  });

  it("answers null for anything it cannot place, so a typo cannot widen a window", () => {
    // The failure that matters: `--since -5` or `--since yesterday` silently read
    // as "no floor" would pass a record from any time at all.
    expect(parseWhen("yesterday", AT)).toBeNull();
    expect(parseWhen("-5", AT)).toBeNull();
    expect(parseWhen("", AT)).toBeNull();
    expect(parseWhen(null, AT)).toBeNull();
  });
});

describe("the command line", () => {
  it("takes the history as an argument or as a flag, and defaults nothing else", () => {
    expect(parseArgs(["C:/srv/reloads.jsonl"])).toMatchObject({ history: "C:/srv/reloads.jsonl", waitMs: 0 });
    expect(parseArgs(["--history=C:/srv/reloads.jsonl"]).history).toBe("C:/srv/reloads.jsonl");
    expect(parseArgs(["--history", "C:/srv/reloads.jsonl"]).history).toBe("C:/srv/reloads.jsonl");
    expect(parseArgs(["--since", "-5m"]).since).toBe("-5m");
    expect(parseArgs(["--wait=60000"]).waitMs).toBe(60_000);
    expect(parseArgs(["--all"]).all).toBe(true);
    expect(parseArgs(["--json"]).json).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs([])).toMatchObject({ history: null, since: null, waitMs: 0 });
  });

  it("refuses what it cannot read instead of guessing", () => {
    expect(() => parseArgs(["--wait", "soon"])).toThrow(/--wait: not a number of milliseconds/);
    expect(() => parseArgs(["--wait"])).toThrow(/--wait needs a value/);
    expect(() => parseArgs(["--nope"])).toThrow(/unknown option: --nope/);
    expect(() => parseArgs(["one.jsonl", "two.jsonl"])).toThrow(/unexpected argument: two.jsonl/);
  });

  it("takes the path the supervisor was told to append to when none is named", async () => {
    // The deploy's real wiring: PROD_RELOAD_HISTORY is set on the server, and the
    // step that checks it is usually given nothing but the environment.
    const file = historyFile(jsonl(recordFor("replaced")));
    const { code } = await gate([], {
      env: { PROD_RELOAD_HISTORY: file },
      readFile: () => jsonl(recordFor("replaced")),
    });
    expect(code).toBe(0);
  });
});

describe("the exit codes a deploy branches on", () => {
  const judged = async (outcome: Outcome) =>
    gate(["/srv/reloads.jsonl"], { readFile: () => jsonl(recordFor(outcome)) });

  it("passes a reload that landed, and says what landed", async () => {
    const replaced = await judged("replaced");
    expect(replaced.code).toBe(0);
    expect(replaced.out).toContain("REPLACED");
    expect(replaced.out).toContain("64 real connection(s) from the app, 2 health check(s)");
    expect(replaced.out).toContain("RELOAD_VERDICT=LANDED records=1 landed=1 failed=0");
    expect(replaced.err).toBe("");

    const stopped = await judged("stopped");
    expect(stopped.code).toBe(0);
    expect(stopped.out).toContain("STOPPED");
    expect(stopped.out).toContain("a shutdown ended the reload before the window did");
  });

  it("fails a reload that was rolled back, quoting the reason it was", async () => {
    const { code, out } = await judged("rolled-back");
    expect(code).toBe(1);
    expect(out).toContain("ROLLED BACK");
    expect(out).toContain("the replacement failed its health check (it answered HTTP 500)");
    expect(out).toContain("RELOAD_VERDICT=NOT_LANDED records=1 landed=0 failed=1");
  });

  it("fails a reload where nothing changed", async () => {
    const { code, out } = await judged("kept");
    expect(code).toBe(1);
    expect(out).toContain("NOTHING CHANGED");
    expect(out).toContain("the run that was already serving kept serving");
  });

  it("fails a replacement that landed broken, with no way back", async () => {
    // The nastiest shape: the port did move, so a check that only looked for a
    // rollback would call this a success while a failed server serves.
    const { code, out } = await judged("no-fallback");
    expect(code).toBe(1);
    expect(out).toContain("LANDED BROKEN");
  });

  it("refuses to judge at all when there is no history to read", async () => {
    const named = await gate([], { env: {} });
    expect(named.code).toBe(2);
    expect(named.err).toContain("no reload history to read");
    expect(named.err).toContain("PROD_RELOAD_HISTORY");

    const missing = await gate(["/srv/reloads.jsonl"]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("there is no reload history at /srv/reloads.jsonl");

    const empty = await gate(["/srv/reloads.jsonl"], { readFile: () => "" });
    expect(empty.code).toBe(2);
    expect(empty.err).toContain("the file has no records");

    const unreadable = await gate(["/srv/reloads.jsonl"], {
      readFile: () => {
        const error: NodeJS.ErrnoException = new Error("EACCES: permission denied");
        error.code = "EACCES";
        throw error;
      },
    });
    expect(unreadable.code).toBe(2);
    expect(unreadable.err).toContain("could not be read");
  });

  it("refuses a record older than the reload being checked — the false pass", async () => {
    // A reload that never happened writes NOTHING, so the newest line in the file
    // would otherwise be some earlier deploy's green one. Without this, a deploy
    // whose reload silently never ran reads as a success.
    const stale = await gate(["/srv/reloads.jsonl"], {
      readFile: () => jsonl(recordFor("replaced")),
      now: () => AT + 3_600_000,
    });
    expect(stale.code).toBe(2);
    expect(stale.err).toContain("no reload landed at or after");
    expect(stale.err).toContain("the newest record in /srv/reloads.jsonl is from 2026-10-14T12:00:00.000Z");
    expect(stale.err).toContain("--since");

    // ...and the window is the caller's to widen, deliberately: the same record,
    // judged on purpose, is a pass.
    const widened = await gate(["/srv/reloads.jsonl", "--since", "-2h"], {
      readFile: () => jsonl(recordFor("replaced")),
      now: () => AT + 3_600_000,
    });
    expect(widened.code).toBe(0);
  });

  it("refuses a line it cannot place, even with a good record behind it", async () => {
    // The file is the evidence. A gate that cannot read all of it does not pass
    // on the part it could read, or an unreadable line becomes a way through.
    const { code, err } = await gate(["/srv/reloads.jsonl"], {
      readFile: () => `${jsonl(recordFor("replaced"))}>> truncated write\n`,
    });
    expect(code).toBe(2);
    expect(err).toContain("line 2: not JSON");
    expect(err).toContain("nothing is judged");
  });

  it("refuses an outcome it has never heard of instead of guessing it", async () => {
    // The lib's test proves the page keeps such a record and names it verbatim;
    // this proves the gate does not judge it.
    const { code, err } = await gate(["/srv/reloads.jsonl"], {
      readFile: () => jsonl({ ...recordFor("replaced"), outcome: "teleported" }),
    });
    expect(code).toBe(2);
    expect(err).toContain('the outcome "teleported"');
    expect(err).toContain("the history is newer than this reader");
  });

  it("judges only the newest record, unless every one of them is asked for", async () => {
    // A deploy asks for one reload and checks it, so the newest record is the
    // answer. `--all` is for a step that asks for several.
    const both = jsonl(recordFor("replaced"), recordFor("rolled-back"));
    const newest = await gate(["/srv/reloads.jsonl"], { readFile: () => both });
    expect(newest.code).toBe(1);
    expect(newest.out).toContain("judging 1");

    const all = await gate(["/srv/reloads.jsonl", "--all"], { readFile: () => both });
    expect(all.code).toBe(1);
    expect(all.out).toContain("judging 2");
    expect(all.out).toContain("RELOAD_VERDICT=NOT_LANDED records=2 landed=1 failed=1");

    // A step that asked for two and got two greens is a pass.
    const greens = await gate(["/srv/reloads.jsonl", "--all"], {
      readFile: () => jsonl(recordFor("replaced"), recordFor("stopped")),
    });
    expect(greens.code).toBe(0);
  });

  it("gives the record back as JSON when a pipeline asks for it", async () => {
    const record = recordFor("rolled-back");
    const { code, out, err } = await gate(["/srv/reloads.jsonl", "--json"], {
      readFile: () => jsonl(record),
    });
    expect(code).toBe(1);
    // stdout is the record and nothing else, so `--json | jq .` composes; the
    // prose a person wants moves to stderr.
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(out.trim())).toEqual(record);
    expect(err).toContain("RELOAD_VERDICT=NOT_LANDED");
  });

  it("waits for a reload asked for and checked in the same breath", async () => {
    // The record lands when the reload CONCLUDES, so a step that asks and checks
    // at once has to wait for one that landed after it started — and an empty
    // read is why it keeps looking rather than giving up.
    let reads = 0;
    const { code, out, sleeps } = await gate(["/srv/reloads.jsonl", "--wait", "10000"], {
      readFile: () => {
        reads += 1;
        return reads < 2 ? "" : jsonl(recordFor("replaced", { at: AT + 1_000, startedAt: AT, swappedAt: AT + 100 }));
      },
    });
    expect(code).toBe(0);
    expect(reads).toBeGreaterThan(1);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(out).toContain("REPLACED");
  });

  it("fails the wait, rather than passing on what was already there", async () => {
    // The whole point of `--wait`: a reload that did not happen leaves the OLD
    // record in place, and judging that one is the false pass again. The record
    // here landed ten seconds before the check started.
    const before = { at: AT - 10_000, startedAt: AT - 12_500, swappedAt: AT - 11_000 };
    const stale = await gate(["/srv/reloads.jsonl", "--wait", "5000"], {
      readFile: () => jsonl(recordFor("replaced", before)),
    });
    expect(stale.code).toBe(2);
    expect(stale.err).toContain("no reload landed in the 5000ms this command waited");
    expect(stale.sleeps.length).toBeGreaterThan(0);

    const never = await gate(["/srv/reloads.jsonl", "--wait", "5000"]);
    expect(never.code).toBe(2);
    expect(never.err).toContain("did not appear within the 5000ms this command waited");
  });

  it("prints its exit codes in the usage a deploy's author reads", async () => {
    expect(USAGE).toContain("0  the reload landed");
    expect(USAGE).toContain("1  it did not");
    expect(USAGE).toContain("2  it could not be judged");
    const helped = await gate(["--help"]);
    expect(helped.code).toBe(0);
    expect(helped.out).toContain("--wait <ms>");
    expect(helped.err).toBe("");
  });
});

describe("through the real process — the interface a deploy script runs", () => {
  it("exits 0 for a reload that landed and 1 for one that did not", () => {
    const green = spawnSync(process.execPath, [SCRIPT, historyFile(jsonl(agedRecord("replaced")))], {
      encoding: "utf8",
    });
    expect(green.status).toBe(0);
    expect(green.stdout).toContain("RELOAD_VERDICT=LANDED records=1 landed=1 failed=0");

    const red = spawnSync(process.execPath, [SCRIPT, historyFile(jsonl(agedRecord("rolled-back")))], {
      encoding: "utf8",
    });
    expect(red.status).toBe(1);
    expect(red.stdout).toContain("ROLLED BACK");
    expect(red.stdout).toContain("RELOAD_VERDICT=NOT_LANDED");
  });

  it("exits 2 when there is nothing it can judge, and says so on stderr", () => {
    const missing = spawnSync(process.execPath, [SCRIPT, join(tmpdir(), "no-such-history.jsonl")], {
      encoding: "utf8",
    });
    expect(missing.status).toBe(2);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("nothing is judged without one");

    const usageError = spawnSync(process.execPath, [SCRIPT, "--nope"], { encoding: "utf8" });
    expect(usageError.status).toBe(2);
    expect(usageError.stderr).toContain("unknown option: --nope");
    expect(usageError.stderr).toContain("Exit codes:");
  });

  it("waits across processes for a reload that lands while it waits", async () => {
    // The real deploy shape, end to end in two processes: the file already holds
    // an OLDER reload, the check starts, and the reload it is waiting for lands
    // while it waits — the record is written when the reload concludes, which is
    // why `--wait` exists at all.
    //
    // The record is appended repeatedly rather than once after a fixed sleep
    // because WHEN the check starts is the machine's business: under a suite
    // running seventy files at once, starting a node process costs a second or
    // more, and a record written before that started is (correctly) not the
    // reload this check is waiting for. Appending keeps the write a whole line,
    // so the file never has to be read half-written.
    const file = join(mkdtempSync(join(tmpdir(), "anybase-reload-gate-wait-")), "reloads.jsonl");
    writeFileSync(file, jsonl(agedRecord("replaced", 60_000)));
    const child = spawn(process.execPath, [SCRIPT, file, "--wait", "20000"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finished = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1)));

    const landing = setInterval(() => appendFileSync(file, jsonl(agedRecord("replaced"))), 300);
    try {
      expect(await finished).toBe(0);
    } finally {
      clearInterval(landing);
    }
  }, 30_000);

  it("is runnable as `npm run check:reload-history`", () => {
    const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    // The `--disable-warning` flag is the price of a script importing a `.ts`
    // module (this Node strips the types itself): the same invocation
    // `audit:demos` uses for `scripts/demo-link-audit.mjs`.
    expect(pkg.scripts["check:reload-history"]).toBe(
      "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/check-reload-history.mjs",
    );
  });
});
