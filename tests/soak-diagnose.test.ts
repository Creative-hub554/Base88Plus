/**
 * Pins for the account READER — `npm run soak:diagnose` (scripts/soak-diagnose.mjs).
 *
 * The claim this suite exists to keep true is the one the uploaded artifact is for: a
 * red soak, and a door claim in particular, is diagnosable from the downloaded
 * `soak-account` alone — no re-run, no second file open beside the first. So every
 * account here is built through the WRITERS (a summary shaped the way `--json` writes
 * one, the trend line through `trendRecord`, the history records in
 * `base88.reload/1`), and then read back through the real command, because a reader
 * pinned against a literal copied out of an artifact is a reader pinned against
 * somebody's memory of one.
 *
 * Four cases carry the policy, and each is a way the command could be useless rather
 * than wrong: a GREEN account has to read as green (a diagnosis command that cries wolf
 * on the artifact of a passing run is one nobody reads), a run whose summary never got
 * written still has to read as RED from its trend line (the summary is written by the
 * same function that appends the line, so that is the shape a soak that died late enough
 * to record a line leaves behind), a line the history reader cannot use has to be named
 * with its line number without hiding the rest of the file, and a file that is not JSON
 * has to be `exit 2` — half an incident read as a whole one is how a wrong diagnosis
 * gets made.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LOG_SHAPES,
  USAGE,
  accountFiles,
  baselineComparison,
  classifyLogLine,
  classifyLogLines,
  clientLogLines,
  diagnoseAccount,
  diffAccounts,
  main,
  parseArgs,
  readAccount,
  reloadEvents,
  reloadRows,
  renderDiff,
  renderDiagnosis,
  seriesAccounts,
} from "../scripts/soak-diagnose.mjs";
import { HELD_SHAPE, trendRecord } from "../scripts/soak-supervisor.mjs";

const HERE = process.cwd();
const SCRIPT = join(HERE, "scripts", "soak-diagnose.mjs");
const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")) as { scripts: Record<string, string> };

const PHASES = ["busy", "trickle", "quiet"] as const;
type Phase = (typeof PHASES)[number];

/** The clock every account here is built on: one run, twelve seconds of reloads. */
const START = Date.parse("2026-10-16T05:10:01.200Z");
const GAP = 9_000;
const SWAP_MS = 210;
const WINDOW_MS = 6_000;
const LAND_MS = 8_400;
const iso = (ms: number) => new Date(START + ms).toISOString();

/**
 * The hold of the ordinary shape: opened through the door on the run behind it, ended with it,
 * at the instants the reload given by `offsetMs` names — a hold's clocks belong to its own
 * reload, and a fixture that put every one of them at the same instant would test an ordering
 * no real run produces. `acceptedAt` is BEFORE the ask, because the soak opens the hold first
 * (so the run serving the port at that moment is the run it is piped to).
 */
const HOLD_LEAD_MS = 450;
const ordinaryHeld = (offsetMs = 0, over: Record<string, any> = {}): Record<string, any> => ({
  // Which shape the block is: the reader reads answers out of a block that names this one
  // and out of no other (see "reads answers only from a block it knows the shape of").
  shape: HELD_SHAPE,
  accepted: true,
  acceptedAt: iso(offsetMs - HOLD_LEAD_MS),
  // One object per answer, its status and instant together: there is no count (the list's
  // length is one) and no second list to keep in step with this one.
  answered: [],
  answeredBeforeSwap: false,
  endedAt: iso(offsetMs + LAND_MS),
  endedReason: "closed",
  endedBeforeSwap: false,
  endedBeforeCount: false,
  runGaveUp: false,
  afterStop: "!closed",
  leftoverConnections: 3,
  ...over,
});

type ReloadSpec = {
  phase: Phase;
  outcome?: string | null;
  /** The reload's held connection; `null` writes NO `held` key at all. */
  held?: Record<string, any> | null;
  /** Whether the run this reload retired left its port behind. */
  retiredPortFree?: boolean;
  /** The supervisor's own sentence, which only the history record carries. */
  detail?: string | null;
  /** How long the reload's own cell took (asked → landed), which is what a run COSTS. */
  landMs?: number;
  /** How many clients this reload's swap cost an answer, which the soak calls `lost`. */
  lost?: number;
  /**
   * WHICH client this reload's swap spent, as the door's evidence names it (one entry per
   * client lost, in accept order); `null` writes NO `spent` key at all, which is the shape a
   * summary written before the field existed has.
   */
  spent?: Record<string, any>[] | null;
};

type AccountOptions = {
  at?: string;
  verdict?: string;
  reloads?: ReloadSpec[];
  problems?: string[];
  notes?: string[];
  platform?: string;
  /**
   * The door's own counters: how much traffic arrived and what it was answered. Defaults to 40
   * requests answered 200, no failures, and one client in flight at every swap — so the DEFAULT
   * account's door rates are the same whatever it did, which is what keeps one fixture usable as
   * the green run of every comparison here.
   */
  door?: {
    requests?: number;
    byStatus?: Record<string, number>;
    timeouts?: number;
    connectionErrors?: number;
    swapsWithAClient?: number;
    clientsInFlight?: number;
    /** How many clients each swap had AT THE DOOR (the band around the port change). */
    atTheDoor?: number;
    /** ...and how many of those the swap cost an answer, which is what the soak calls `lost`. */
    lost?: number;
  };
};

/** One reload's row, with the clocks a real run leaves: ask, swap, count, land. */
function reloadRow(spec: ReloadSpec, index: number) {
  const offset = index * GAP;
  const retiredPort = 62_158 + index;
  return {
    index: index + 1,
    phase: spec.phase,
    outcome: spec.outcome === undefined ? "replaced" : spec.outcome,
    closedBy: "count",
    startedAt: iso(offset),
    swappedAt: iso(offset + SWAP_MS),
    landedAt: iso(offset + (spec.landMs ?? LAND_MS)),
    served: 4,
    checks: 6,
    windowUsedMs: WINDOW_MS,
    replacementPort: retiredPort + 1,
    retiredPort,
    retiredPortFree: spec.retiredPortFree ?? true,
    descendants: 1,
    handles: 300,
    // `held: null` writes NO key at all, which is the shape a record written before the
    // field existed has; anything else is the ordinary hold, with the test's changes over
    // it, at this reload's own offset.
    held: spec.held === null ? undefined : { ...ordinaryHeld(offset), ...(spec.held ?? {}) },
    detail: spec.detail ?? null,
    // The front door's own number, which is the same in the record and the summary.
    leftoverConnections: spec.held?.leftoverConnections ?? null,
  };
}

/** A run's summary, shaped the way `--json` writes one. */
function summaryOf(options: AccountOptions = {}) {
  const reloads = options.reloads ?? [{ phase: "busy" as Phase }, { phase: "trickle" as Phase }, { phase: "quiet" as Phase }];
  const reloadsDetail = reloads.map((spec, index) => reloadRow(spec, index));
  const byPhase: Record<string, number> = {};
  for (const reload of reloadsDetail) byPhase[reload.phase] = (byPhase[reload.phase] ?? 0) + 1;
  return {
    verdict: options.verdict ?? "PASS",
    at: options.at ?? iso(reloads.length * GAP),
    profile: { platform: options.platform ?? "linux", arch: "x64", node: "22" },
    reloads: reloadsDetail.length,
    performed: reloadsDetail.length,
    phases: reloadsDetail.map((reload) => reload.phase),
    byPhase,
    closedBy: { count: reloadsDetail.length },
    records: reloadsDetail.length,
    outcomes: [...new Set(reloadsDetail.map((reload) => reload.outcome).filter((outcome) => outcome !== null))],
    frontPort: 62_158,
    history: "/tmp/reloads.jsonl",
    // The door's counters, as `report()` in scripts/soak-supervisor.mjs writes them: the traffic
    // that arrived, what it was answered (the soak counts a failure at the connection under a
    // `!` key of the same map), and how many clients were at the swaps.
    requests: options.door?.requests ?? 40,
    answers: Object.values(options.door?.byStatus ?? { 200: 40 }).reduce((total, count) => total + count, 0),
    byStatus: options.door?.byStatus ?? { 200: 40 },
    timeouts: options.door?.timeouts ?? 0,
    connectionErrors: options.door?.connectionErrors ?? 0,
    // The clients at each swap, as `swapProblems` reports them: the band around the port change,
    // the ones open across the instant, and how many of the band the door cost an answer. The band
    // and the in-flight count are separate knobs on purpose — the band is the WIDER set, which is
    // the whole reason a loss is rated against it rather than against the in-flight count.
    swapsAtTheDoor: reloadsDetail.map((reload, position) => ({
      index: reload.index,
      phase: reload.phase,
      at: Date.parse(reload.swappedAt),
      band: options.door?.atTheDoor ?? 1,
      inFlight: 1,
      lost: reloads[position]?.lost ?? options.door?.lost ?? 0,
      // `spent: null` writes NO key at all — the shape a summary written before a swap named
      // its losses has — while anything else is the evidence itself, empty by default.
      spent: reloads[position]?.spent === null ? undefined : (reloads[position]?.spent ?? []),
    })),
    swapsWithAClient: options.door?.swapsWithAClient ?? reloadsDetail.length,
    clientsInFlight: options.door?.clientsInFlight ?? reloadsDetail.length,
    descriptors: null,
    floors: null,
    reloadsDetail,
    notes: options.notes ?? [],
    problems: options.problems ?? [],
  };
}

/** The `base88.reload/1` line a real supervisor would have written for each reload. */
function historyRecords(summary: ReturnType<typeof summaryOf>) {
  return summary.reloadsDetail.map((reload) => ({
    schema: "base88.reload/1",
    at: reload.landedAt,
    startedAt: reload.startedAt,
    swappedAt: reload.swappedAt,
    asked: "C:\\temp\\sentinel",
    outcome: reload.outcome ?? "replaced",
    closedBy: reload.closedBy,
    rolledBack: false,
    windowMs: WINDOW_MS,
    windowUsedMs: reload.windowUsedMs,
    proofConnections: 0,
    served: reload.served,
    checks: reload.checks,
    leftoverConnections: reload.leftoverConnections,
    replacementPort: reload.replacementPort,
    previousPort: reload.retiredPort,
    frontPort: summary.frontPort,
    detail: "detail" in reload ? (reload.detail as string | null) : null,
  }));
}

/** An artifact directory, as a download unpacks one — only what the test asks for. */
function writeAccount(
  parts: { summary?: unknown; history?: unknown[] | string; trend?: unknown; log?: string },
): string {
  const dir = mkdtempSync(join(tmpdir(), "anybase-soak-account-"));
  if (parts.summary !== undefined) {
    writeFileSync(join(dir, "soak-summary.json"), typeof parts.summary === "string" ? parts.summary : `${JSON.stringify(parts.summary)}\n`);
  }
  if (parts.history !== undefined) {
    const text = typeof parts.history === "string" ? parts.history : parts.history.map((record) => JSON.stringify(record)).join("\n") + "\n";
    writeFileSync(join(dir, "reloads.jsonl"), text);
  }
  if (parts.trend !== undefined) {
    writeFileSync(join(dir, "soak-trend.jsonl"), typeof parts.trend === "string" ? parts.trend : `${JSON.stringify(parts.trend)}\n`);
  }
  if (parts.log !== undefined) {
    writeFileSync(join(dir, "server.log"), parts.log);
  }
  return dir;
}

/** An account whose three files agree, from one summary — the ordinary artifact. */
function accountOf(options: AccountOptions = {}) {
  const summary = summaryOf(options);
  return writeAccount({ summary, history: historyRecords(summary), trend: trendRecord(summary) });
}

const run = (args: string[]) =>
  spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", SCRIPT, ...args], {
    cwd: HERE,
    encoding: "utf8",
  });

/** Read an account the way the command does, without a process. */
const read = (dir: string) => {
  const files = accountFiles({ account: dir, summary: null, history: null, trend: null });
  return diagnoseAccount({ files: readAccount(files, (path) => readFileSync(path, "utf8")), dir: files.dir });
};

/** The green run every comparison here is made against. */
const green = () => accountOf({});
/**
 * The red one: the same three phases, with a door claim on reload 3, which is the run
 * whose count came back below the connection still open on it.
 */
const red = () =>
  accountOf({
    verdict: "FAIL",
    problems: [
      "reload 3 (quiet): the door reported 0 connection(s) still on the run it retired, while a client was holding one that had been piped to it",
    ],
    notes: ["the descriptor trend is not judged for one reading a phase"],
    reloads: [{ phase: "busy" }, { phase: "trickle" }, { phase: "quiet", outcome: "rolled-back", held: { leftoverConnections: 0 } }],
  });

/**
 * A STORED trend line, as the file a soak appends one line per run to: what a person has kept
 * across runs, which is the whole of what a baseline is.
 */
function writeBaseline(records: unknown[] | string): string {
  const path = join(mkdtempSync(join(tmpdir(), "anybase-soak-baseline-")), "soak-trend.jsonl");
  writeFileSync(path, typeof records === "string" ? records : records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return path;
}

/**
 * One EARLIER run — a line of that file, on the same machine and engine as the accounts above,
 * at its own instant (the fixtures' runs are all at `iso(27000)`, and a baseline record has to
 * be a different run than the one being measured to be a baseline at all).
 */
const earlierRun = (index = 1, over: AccountOptions = {}) => trendRecord(summaryOf({ ...over, at: iso(1_000 * index) }));

/** A baseline of `count` earlier passing runs, which is what a kept file holds. */
const baselineOf = (count: number, over: AccountOptions = {}) =>
  writeBaseline(Array.from({ length: count }, (_, index) => earlierRun(index + 1, over)));

describe("the command line", () => {
  it("names the account, the other accounts, its files and the exit codes in its usage", () => {
    expect(USAGE).toContain("soak-diagnose.mjs [account] [other...]");
    for (const file of ["soak-summary.json", "reloads.jsonl", "soak-trend.jsonl", "server.log"]) expect(USAGE).toContain(file);
    expect(USAGE).toContain("SOAK_DIAGNOSIS=PASS|RED|UNREADABLE");
    expect(USAGE).toContain("SOAK_DIFF=SAME|DIFFERENT|UNREADABLE");
    expect(USAGE).toContain("SOAK_DRIFT=DRIFTED|WITHIN|NOT_COMPARED");
    expect(USAGE).toContain("--baseline <path>");
    expect(USAGE).toContain("as RATES rather than as counts");
    expect(USAGE).toContain("cannot be used with");
    expect(USAGE).toContain("accounts compared");
    expect(USAGE).toMatch(/0 {2}the account was read and carries no problem/);
  });

  it("reads the working directory by default, each file by a flag, and any number of accounts in order", () => {
    expect(parseArgs([])).toMatchObject({ account: ".", accounts: ["."], summary: null, history: null, trend: null, baseline: null, json: false });
    expect(parseArgs(["artifacts/123", "--json"])).toMatchObject({ account: "artifacts/123", json: true });
    const named = parseArgs(["--summary", "s.json", "--history", "h.jsonl", "--trend", "t.jsonl", "--log", "app.log"]);
    expect(named).toMatchObject({ account: ".", summary: "s.json", history: "h.jsonl", trend: "t.jsonl", log: "app.log" });
    expect(parseArgs([])).toMatchObject({ log: null });
    // A flag with no value and an option nobody knows: both are usage rather than a guess.
    expect(() => parseArgs(["--summary"])).toThrow(/--summary needs a value/);
    expect(() => parseArgs(["--nope"])).toThrow(/unknown option/);
    // Several directories ARE allowed — two are a diff and more are a series — and the order
    // they are given in IS the order they are compared, which is what each fact is named
    // against: nothing here re-sorts by the accounts' own instants.
    expect(parseArgs(["one", "two"])).toMatchObject({ account: "one", against: "two", accounts: ["one", "two"] });
    expect(parseArgs(["one", "two", "three"]).accounts).toEqual(["one", "two", "three"]);
    expect(parseArgs(["one", "two", "three"])).toMatchObject({ account: "one", against: "two" });
    // ...but a file flag names a file of ONE account, and with accounts compared there is no
    // answer to which of them it belongs to.
    expect(() => parseArgs(["one", "two", "--summary", "s.json"])).toThrow(/cannot be used when accounts are compared/);
    expect(() => parseArgs(["one", "two", "--log", "app.log"])).toThrow(/cannot be used when accounts are compared/);
    expect(() => parseArgs(["one", "two", "three", "--trend", "t.jsonl"])).toThrow(/cannot be used when accounts are compared/);
  });

  it("takes ONE account and a stored baseline, and refuses the two of them together", () => {
    // The baseline is the comparison, so it needs exactly one account to compare — and with
    // accounts named the comparison is those accounts, one step at a time.
    expect(parseArgs(["account", "--baseline", "kept.jsonl"])).toMatchObject({ account: "account", baseline: "kept.jsonl" });
    expect(parseArgs(["--baseline", "kept.jsonl"])).toMatchObject({ account: ".", baseline: "kept.jsonl" });
    expect(() => parseArgs(["--baseline"])).toThrow(/--baseline needs a value/);
    expect(() => parseArgs(["one", "two", "--baseline", "kept.jsonl"])).toThrow(/--baseline compares ONE account's cost/);
    expect(() => parseArgs(["one", "two", "three", "--baseline", "kept.jsonl"])).toThrow(/--baseline compares ONE account's cost/);
  });

  it("resolves the flags against the working directory and the rest against the account", () => {
    const files = accountFiles({ account: "artifacts/123", summary: "s.json", history: null, trend: null });
    expect(files.dir.endsWith(join("artifacts", "123"))).toBe(true);
    expect(files.summary.endsWith("s.json")).toBe(true);
    expect(files.history).toBe(join(files.dir, "reloads.jsonl"));
    expect(files.trend).toBe(join(files.dir, "soak-trend.jsonl"));
    // The app's own output sits beside them, named once in both readers (`SERVER_LOG`).
    expect(files.log).toBe(join(files.dir, "server.log"));
    expect(accountFiles({ account: ".", summary: null, history: null, trend: null, log: "app.log" }).log.endsWith("app.log")).toBe(true);
  });

  it("is runnable as `npm run soak:diagnose`, and prints its usage through the process", () => {
    expect(pkg.scripts["soak:diagnose"]).toBe("node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/soak-diagnose.mjs");
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: node scripts/soak-diagnose.mjs");
  });
});

describe("an account that passed", () => {
  it("puts every reload on the run's own clock, with the hold and the count where they happened", () => {
    const dir = accountOf({ problems: [], notes: ["the descriptor trend is not judged for one reload a phase"] });
    const diagnosis = read(dir);

    expect(diagnosis.verdict).toBe("PASS");
    expect(diagnosis.problems).toEqual([]);
    expect(diagnosis.reloads.map((row: any) => row.phase)).toEqual(["busy", "trickle", "quiet"]);

    // The first reload asked, swapped, was counted and concluded, in that order, at the
    // instances the account already carried — nothing here is a new measurement.
    const first = diagnosis.events.filter((event: any) => event.reload === 1);
    // The hold's own clocks are the two ends of that stretch, and the run's zero is the
    // earliest instant in the account — the hold being opened, not the ask.
    expect(first.map((event: any) => event.offsetMs)).toEqual([
      0,
      HOLD_LEAD_MS,
      HOLD_LEAD_MS + SWAP_MS,
      HOLD_LEAD_MS + SWAP_MS + WINDOW_MS,
      HOLD_LEAD_MS + LAND_MS,
      HOLD_LEAD_MS + LAND_MS,
    ]);
    expect(first[0].text).toBe(
      "a client's connection was held through the door on the run it piped it to, port 62158, and nothing was ever said to it while it was held",
    );
    // ...and the swap's line is the swap: what was held across it is on the clock above.
    expect(first[2].text).toBe("the port changed hands: port 62158 → 62159");
    expect(first[3].text).toContain("the door took its count on the run it retired (port 62158): 3 connection(s) still on it");
    expect(first[3].text).toContain("was still open, so the count does");
    expect(first[5].text).toContain("REPLACED — the replacement is serving and the run it replaced was retired");

    // The run's own note is on the timeline too, at the run's instant — the reading is
    // one place, not a timeline plus a list printed somewhere else.
    const note = diagnosis.events.find((event: any) => event.kind === "note" && event.who === "the run");
    expect(note?.text).toContain("the descriptor trend is not judged");

    expectThroughProcess(dir, 0, "SOAK_DIAGNOSIS=PASS");
  });

  it("says what the account does NOT carry rather than inventing a hold", () => {
    // A summary written before `held` existed: the reload is still on the timeline, and
    // the missing facts are said in the swap's own line.
    const summary = summaryOf({ reloads: [{ phase: "busy", held: null }] });
    const dir = writeAccount({ summary, history: historyRecords(summary), trend: trendRecord(summary) });
    const diagnosis = read(dir);

    const swap = diagnosis.events.find((event: any) => event.text.startsWith("the port changed hands"));
    expect(swap?.text).toContain("with no held-connection facts in the account");
    expect(diagnosis.events.some((event: any) => event.text.includes("the door took its count"))).toBe(false);
  });

  it("falls back to the swap's own line for a record written before the instants existed", () => {
    // The facts of a hold with no clock for them belong to the swap, which is the only
    // instant the account names, rather than to a place invented for them.
    // ...and it is an account of the OLDER shape, which is the second thing `shape` is
    // for: it carries no marker, because it was written before the marker existed.
    const summary = summaryOf({ reloads: [{ phase: "busy", held: { shape: undefined, acceptedAt: undefined, answered: undefined } }] });
    const diagnosis = read(writeAccount({ summary, history: historyRecords(summary), trend: trendRecord(summary) }));

    const swap = diagnosis.events.find((event: any) => event.text.startsWith("the port changed hands"));
    expect(swap?.text).toContain("with a client's connection held through the door on the run it piped it to, port 62158");
    // ...and nothing is inferred from the absence: "no per-answer facts" is not the same
    // answer as "nothing was ever said to it", which only an empty list carries.
    expect(swap?.text).toContain("and no per-answer facts in the account");
    expect(swap?.text).not.toContain("nothing was ever said to it");
    expect(diagnosis.events.some((event: any) => event.text.startsWith("a client's connection was held through the door"))).toBe(false);
  });

  it("reads answers only from a block it knows the shape of, and names the shape it does not", () => {
    // A hold in a shape this reader has never seen: it carries an `answered` list, and the
    // list is NOT read, because the block does not say it is this reader's shape. The
    // marker is what decides — not the fields that happen to be present — so the account
    // is read as one this reader cannot place rather than as a quiet hold.
    const summary = summaryOf({
      reloads: [
        { phase: "busy", held: { shape: "anybase-held/9", answered: [{ status: 200, at: iso(SWAP_MS + 500) }] } },
      ],
    });
    const diagnosis = read(writeAccount({ summary, history: historyRecords(summary), trend: trendRecord(summary) }));

    const swap = diagnosis.events.find((event: any) => event.text.startsWith("the port changed hands"));
    expect(swap?.text).toContain("and no per-answer facts in the account");
    expect(swap?.text).toContain('it is in "anybase-held/9", a shape this reader does not know');
    expect(swap?.text).toContain(`this reader reads answers from ${HELD_SHAPE}`);
    // Nothing is placed at an instant the shape does not let the reader trust.
    expect(diagnosis.events.some((event: any) => event.text.includes("was answered"))).toBe(false);
  });
});

describe("an account that did not pass", () => {
  /** The red account this whole command exists for: a door claim on reload 3. */
  const doorClaim = "reload 3 (quiet): the door reported 0 connection(s) still on the run it retired, while a client was holding one that had been piped to it";
  const redOptions: AccountOptions = {
    verdict: "FAIL",
    problems: [doorClaim, "reload 2 (trickle): the run this reload retired still holds port 62159 — a warm process that outlived its stop"],
    reloads: [
      { phase: "busy" },
      { phase: "trickle", retiredPortFree: false, detail: "the replacement never came up in the window" },
      { phase: "quiet", held: { leftoverConnections: 0 } },
    ],
  };

  it("sits the problem at the reload it names, with the facts behind the door claim on the same clock", () => {
    const diagnosis = read(accountOf(redOptions));

    expect(diagnosis.verdict).toBe("RED");
    expect(diagnosis.problems).toEqual(redOptions.problems);

    // The claim is about reload 3, so that is where it is — not in a list at the end.
    const problems = diagnosis.events.filter((event: any) => event.kind === "problem");
    expect(problems.map((event: any) => event.reload)).toEqual([2, 3]);
    expect(problems[1].text).toBe(doorClaim);
    expect(problems[1].offsetMs).toBe(HOLD_LEAD_MS + 2 * GAP + LAND_MS);

    // ...and the facts it rests on are in the account: the count the door took, on the
    // port that run had, against a connection that was still open when it took it.
    const held = diagnosis.events.filter((event: any) => event.reload === 3);
    const count = held.find((event: any) => event.text.startsWith("the door took its count"));
    expect(count?.text).toContain("the door took its count on the run it retired (port 62160): 0 connection(s) still on it");
    expect(count?.text).toContain("was still open, so the count does");
    expect(held.map((event: any) => event.text).join("\n")).toContain("the run it piped it to, port 62160");

    // The record's own sentence is carried too, which the summary does not have: reload
    // 2's `detail` could not be in the timeline without the history being read.
    expect(diagnosis.events.find((event: any) => event.reload === 2 && event.text.includes("reload concluded"))?.text).toContain(
      "the record says: the replacement never came up in the window",
    );

    expectThroughProcess(accountOf(redOptions), 1, "SOAK_DIAGNOSIS=RED");
  });

  it("is still red when the summary was never written, reading the run from its trend line", () => {
    const summary = summaryOf(redOptions);
    const dir = writeAccount({ history: historyRecords(summary), trend: trendRecord(summary) });
    const diagnosis = read(dir);

    expect(diagnosis.verdict).toBe("RED");
    expect(diagnosis.problems).toContain(doorClaim);
    expect(diagnosis.events.some((event: any) => event.text.includes("read from its trend line"))).toBe(true);
    // The reloads are named by the line's held entries, and each one still carries what
    // the line knows about it.
    expect(diagnosis.reloads).toHaveLength(3);
    // A trend line names its reloads by the connections they held and no clocks at all,
    // so the door's own number is still on the timeline — unclocked, not dropped.
    const count = diagnosis.events.find((event: any) => event.reload === 3 && event.text.startsWith("the door took its count"));
    expect(count?.text).toContain("the door took its count on the run it retired (port 62160): 0 connection(s) still on it");
    expect(count?.offsetMs).toBe(null);
    // ...and nothing is invented for a reload the line names no outcome for.
    expect(diagnosis.events.filter((event: any) => event.reload === 3).every((event: any) => !event.text.includes("outcome this reader does not know"))).toBe(true);

    expectThroughProcess(dir, 1, "SOAK_DIAGNOSIS=RED");
  });

  it("names WHICH client a swap spent, out of the account's own per-swap evidence", () => {
    // The count says a client was lost and nothing about which one; the evidence says both,
    // and this is the line a person reads it off — at the instant the port changed hands,
    // because that is when the client lost had the door in its hands.
    const summary = summaryOf({
      verdict: "FAIL",
      reloads: [
        {
          phase: "busy",
          lost: 1,
          spent: [
            {
              // The handle the account carries the loss by: the ordinal the client was handed
              // to the door at, which is also the number it asked with (`_client=`).
              client: 63,
              acceptedAt: iso(SWAP_MS - 40),
              atTheDoor: { nth: 2, of: 5 },
              handed: { side: "retired", port: 62_158, nth: 1, of: 3 },
            },
          ],
        },
        { phase: "trickle" },
        { phase: "quiet" },
      ],
      problems: [
        "reload 1 (busy): a client at the port change was answered 503 — the front door holds the port and never closes it, so a swap may not cost a client its answer",
      ],
    });
    const diagnosis = read(writeAccount({ summary, history: historyRecords(summary), trend: trendRecord(summary) }));
    const costs = diagnosis.events.filter((event: any) => event.text.startsWith("the swap cost"));

    expect(costs.map((event: any) => event.text)).toEqual([
      // The ordinal FIRST, because it is the one fact here a person can act on outside the
      // account: it is the number the client carried into the app (`_client=`), and therefore
      // the handle the app's own request log names the same client by.
      "the swap cost 1 client(s): the 63rd client handed to the door (`_client=63` in the app's own request log) — the 2nd of the 5 client(s) the swap had at the door — the 1st of the 3 client(s) the run this swap retired (port 62158) was handed",
    ]);
    expect(costs[0].reload).toBe(1);
    expect(costs[0].offsetMs).toBe(HOLD_LEAD_MS + SWAP_MS);
    // A swap that cost nothing gets no line: a sentence about a zero is not a fact about a
    // client, and the other two swaps here spent nobody.
    expect(diagnosis.events.filter((event: any) => event.text.startsWith("the swap cost"))).toHaveLength(1);

    expectThroughProcess(writeAccount({ summary, history: historyRecords(summary), trend: trendRecord(summary) }), 1, "SOAK_DIAGNOSIS=RED");
  });

  it("follows a lost client into the app's own lines, by the same ordinal the loss was named with", () => {
    // The report names the client; the app's output in the same account says what the app did
    // with it. Both are joined by ONE number — the ordinal the client was handed to the door at,
    // which rides on the request as `_client=` — so the reader never leaves the report to find
    // the line, and never has to work out which line was meant by a substring: client 63 is not
    // client 6, nor client 630.
    const summary = summaryOf({
      verdict: "FAIL",
      reloads: [
        {
          phase: "busy",
          lost: 1,
          spent: [{ client: 63, acceptedAt: iso(SWAP_MS - 40), atTheDoor: { nth: 2, of: 5 }, handed: null }],
        },
      ],
      problems: [
        "reload 1 (busy): a client at the port change was answered 503 — the front door holds the port and never closes it, so a swap may not cost a client its answer",
      ],
    });
    const dir = writeAccount({
      summary,
      history: historyRecords(summary),
      trend: trendRecord(summary),
      log: [
        "[start] replacement live in port 62158",
        " GET /?_client=6 200 in 3ms (next.js: 1ms, application-code: 2ms)",
        " GET /?_client=630 200 in 3ms (next.js: 1ms, application-code: 2ms)",
        " GET /?_client=63 503 in 4ms (next.js: 2ms, application-code: 2ms)",
        " GET /?_client=63&page=2 200 in 5ms (next.js: 3ms, application-code: 2ms)",
        "",
      ].join("\n"),
    });
    const diagnosis = read(dir);

    // The header says what the file holds, so a reader knows before the timeline that a loss has
    // somewhere to be followed to.
    expect(diagnosis.files.find((file: any) => file.key === "log")).toMatchObject({
      present: true,
      detail: "4 line(s) naming a client, 3 distinct client(s)",
    });

    const atTheLoss = diagnosis.events.filter((event: any) => event.reload === 1).map((event: any) => event.text);
    const loss = atTheLoss.findIndex((text: string) => text.startsWith("the swap cost"));
    expect(loss).toBeGreaterThanOrEqual(0);
    // Straight after the line that named it, at the same instant — and only the ordinal's own
    // lines, in the app's own words.
    expect(atTheLoss[loss + 1]).toBe(
      "the app's own log (server.log) names this client on 2 line(s): " +
        "GET /?_client=63 503 in 4ms (next.js: 2ms, application-code: 2ms) | " +
        "GET /?_client=63&page=2 200 in 5ms (next.js: 3ms, application-code: 2ms) " +
        "— ANSWERED (503/200): the client got an answer on every line it has here, so nothing was cut off on the " +
        "app's side — the loss is the status it got (503), not a silence",
    );
    const followed = diagnosis.events.find((event: any) => event.text.startsWith("the app's own log"));
    expect(followed?.offsetMs).toBe(diagnosis.events.find((event: any) => event.text.startsWith("the swap cost"))?.offsetMs);

    expectThroughProcess(dir, 1, "SOAK_DIAGNOSIS=RED");

    // A log that carries no line for the client is a FACT about the loss, not a missing file: a
    // client cut off before the app answered is exactly what leaves no line behind, and the
    // report says which of the two it is.
    const silent = summaryOf({
      verdict: "FAIL",
      reloads: [
        { phase: "busy", lost: 1, spent: [{ client: 63, acceptedAt: iso(SWAP_MS - 40), atTheDoor: { nth: 2, of: 5 }, handed: null }] },
      ],
      problems: [
        "reload 1 (busy): a client at the port change was closed with no answer at all — the front door holds the port and never closes it, so a swap may not cost a client its answer",
      ],
    });
    const quietDir = writeAccount({
      summary: silent,
      history: historyRecords(silent),
      trend: trendRecord(silent),
      log: " GET /?_client=6 200 in 3ms (next.js: 1ms, application-code: 2ms)\n",
    });
    expect(
      read(quietDir)
        .events.map((event: any) => event.text)
        .find((text: string) => text.startsWith("the app's own log")),
    ).toBe(
      "the app's own log (server.log) carries no line for this client — the run wrote no answer for it, and the " +
        "request never became a line at all, so it was cut off at the door before the app was handed it, which is " +
        "what a client lost at the swap looks like from the app's side",
    );
  });

  it("says the account's log could not be read whole rather than calling the absence the app's", () => {
    // The watch marks a loss it could not explain (`spent[].app.gaps` — the file was rotated or
    // truncated under it) and the mark travels in the account. The downloaded log is the same file
    // with the same hole in it, so the timeline reads the account's own finding instead of
    // deciding, from the hole, that the app never saw the request.
    const summary = summaryOf({
      verdict: "FAIL",
      reloads: [
        {
          phase: "busy",
          lost: 1,
          spent: [
            {
              client: 63,
              acceptedAt: iso(SWAP_MS - 40),
              atTheDoor: { nth: 2, of: 5 },
              handed: null,
              app: { total: 0, lines: [], more: 0, gaps: [{ kind: "rotated", at: START + SWAP_MS }] },
            },
          ],
        },
      ],
      problems: [
        "reload 1 (busy): a client at the port change was answered 503 — the front door holds the port and never closes it, so a swap may not cost a client its answer",
      ],
    });
    const dir = writeAccount({
      summary,
      history: historyRecords(summary),
      trend: trendRecord(summary),
      log: " GET /?_warm=2 200 in 1ms (next.js: 1ms)\n",
    });
    const said = read(dir)
      .events.map((event: any) => event.text)
      .find((text: string) => text.startsWith("the app's own log"));
    expect(said).toBe(
      "the app's own log (server.log) names no line for this client, and cannot be read whole — " +
        "UNSEEN: the app's own output was replaced (rotated or truncated) while the watch was reading it, so a " +
        "client this log does not name is not one the app never saw — a line for it may have been written into " +
        "the part the watch could not keep",
    );
    expect(said).not.toContain("NO LINE AT ALL");
  });

  it("reads a client's own ordinal exactly, so a neighbour's line is never quoted as its own", () => {
    // The handle is a number in a query, and numbers are prefixes of other numbers: a reader
    // that matched `_client=6` as a substring would quote client 63's loss line as client 6's,
    // which is worse than quoting nothing.
    const log = [
      " GET /?_client=6 200 in 1ms (next.js: 1ms)",
      " GET /?_client=63 503 in 2ms (next.js: 1ms)",
      " GET /?_client=630 200 in 3ms (next.js: 1ms)",
      " GET /x?_client=63&page=2 200 in 4ms (next.js: 1ms)",
    ].join("\n");
    expect(clientLogLines(log, 6)?.lines).toEqual(["GET /?_client=6 200 in 1ms (next.js: 1ms)"]);
    expect(clientLogLines(log, 63)?.lines).toEqual([
      "GET /?_client=63 503 in 2ms (next.js: 1ms)",
      "GET /x?_client=63&page=2 200 in 4ms (next.js: 1ms)",
    ]);
    expect(clientLogLines(log, 630)?.lines).toEqual(["GET /?_client=630 200 in 3ms (next.js: 1ms)"]);
    // A client the log never saw is not a failure to read: it is zero lines, which the timeline
    // turns into the sentence saying the app wrote no answer for it.
    expect(clientLogLines(log, 7)).toMatchObject({ lines: [], total: 0, more: 0 });
    // Nothing to search when there is no log, and nothing to search BY when the account carries
    // no ordinal for the loss — both are null rather than an empty answer that would read as
    // "the app wrote nothing".
    expect(clientLogLines(null, 63)).toBeNull();
    expect(clientLogLines(log, null)).toBeNull();
    // A log that names one client many times keeps a few lines and counts the rest, rather than
    // turning one loss into a page of output.
    const many = Array.from({ length: 5 }, (_, index) => ` GET /?_client=9&n=${index} 200 in 1ms`).join("\n");
    const capped = clientLogLines(many, 9);
    expect(capped).toMatchObject({ total: 5, more: 2 });
    expect(capped?.lines).toHaveLength(3);
  });

  it("classifies a lost client's own lines, because their shape says why the loss looks the way it does", () => {
    // Naming the client and quoting the app's own line is where the report used to stop. The line
    // is the only place the app's SIDE of the request is written down, and the ways it can look are
    // three different losses: an ANSWER the app finished (so the loss is that answer on its way back
    // through the door, or the status the door would not pass), NO ANSWER on a request the app was
    // handed and never finished (the connection ended under it), and NO LINE AT ALL for one that
    // never reached the app (cut off at the door first).
    expect(LOG_SHAPES).toEqual(["answered", "unanswered", "mixed", "absent", "unseen"]);

    // A status is a token of its own, so the request's own query can never supply one: client 6's
    // `?page=200` is not an answer, and the same line WITH a status is one.
    expect(classifyLogLine(" GET /?_client=6&page=200")).toEqual({ shape: "unanswered", status: null });
    expect(classifyLogLine(" GET /?_client=6&page=200 200 in 3ms (next.js: 1ms)")).toEqual({
      shape: "answered",
      status: 200,
    });
    // Neither a duration, nor a port, nor an instant is an answer.
    expect(classifyLogLine(" GET /?_client=6 200 in 3ms (next.js: 1ms)").status).toBe(200);
    expect(classifyLogLine("[fake] run 2 listening on 4123 at 05:10:01.200")).toEqual({
      shape: "unanswered",
      status: null,
    });

    const answered = classifyLogLines([" GET /?_client=6 200 in 3ms (next.js: 1ms)"]);
    expect(answered).toMatchObject({ shape: "answered", statuses: [200], answered: 1, silent: 0, total: 1 });
    expect(answered.why).toContain("ANSWERED (200): the app finished every request it logged for this client");
    // A status that is not 2xx is still an answer, and it is the loss — said as a status rather than
    // as a silence, because the door counted something it saw.
    const failed = classifyLogLines([" GET /?_client=6 503 in 4ms (next.js: 1ms)"]);
    expect(failed).toMatchObject({ shape: "answered", statuses: [503] });
    expect(failed.why).toContain("the loss is the status it got (503), not a silence");
    // The fixture's own notice for the client it cost — a line that names the client and carries no
    // status at all — is the app having been handed the request and never finishing it.
    const silent = classifyLogLines(["[fake] run 2 cost a client its answer — /?_client=6 closed with no reply"]);
    expect(silent).toMatchObject({ shape: "unanswered", statuses: [], answered: 0, silent: 1, total: 1 });
    expect(silent.why).toContain("NO ANSWER: not one line here carries a status");
    expect(silent.why).toContain("the connection ended under it");
    // Both shapes for one client is not one thing: what was answered came back, what was not ended
    // under the app.
    const mixed = classifyLogLines([" GET /?_client=6 200 in 3ms (next.js: 1ms)", "[fake] run 2 stalled a client — /?_client=6 left with no answer"]);
    expect(mixed).toMatchObject({ shape: "mixed", statuses: [200], answered: 1, silent: 1, total: 2 });
    expect(mixed.why).toContain("MIXED: 1 line(s) ANSWERED (200) and 1 with no status");
    // A client the log never names was cut off before the app was handed it — a different failure
    // from an unanswered request, and it is said with its own shape rather than as zero lines.
    expect(classifyLogLines([])).toMatchObject({ shape: "absent", statuses: [], answered: 0, silent: 0, total: 0 });
    expect(classifyLogLines([]).why).toContain("NO LINE AT ALL");

    // The same zero lines, and not the same finding, when the reader knows the file was not read
    // whole: the absence is the LOG's, so the classifier says `unseen` and why — a rotation, a
    // truncation, a missing file or the reader's own cap — rather than calling it the app's.
    const unseen = classifyLogLines([], { gaps: [{ kind: "rotated" }, { kind: "dropped" }] });
    expect(unseen).toMatchObject({ shape: "unseen", total: 0 });
    expect(unseen.why).toContain("UNSEEN: the app's own output was replaced (rotated or truncated) while the watch was reading it");
    expect(unseen.why).toContain("lost its oldest lines to the watch's own size cap");
    expect(unseen.why).toContain("may have been written into the part the watch could not keep");
    // A gap only matters where there are no lines: a client the output DOES name is classified
    // from its lines, whatever happened to the rest of the file.
    expect(classifyLogLines([" GET /?_client=6 200 in 3ms"], { gaps: [{ kind: "rotated" }] })).toMatchObject({
      shape: "answered",
      statuses: [200],
    });
  });

  it("prints a stalled client's line under the loss, and says the app never finished it", () => {
    // The end-to-end half: the classification is what the timeline PRINTS, at the loss's own
    // instant, so a reader gets the reason without having to classify the line themselves.
    const summary = summaryOf({
      verdict: "FAIL",
      reloads: [
        {
          phase: "busy",
          lost: 1,
          spent: [{ client: 12, acceptedAt: iso(SWAP_MS - 40), atTheDoor: { nth: 2, of: 5 }, handed: null }],
        },
      ],
      problems: [
        "reload 1 (busy): a client in flight across the port change was closed with no answer — the front door holds the port and never closes it, so a swap may not cost a client its answer",
      ],
    });
    const line = " GET /?_client=12 200 in 1ms (next.js: 1ms)";
    const dir = writeAccount({
      summary,
      history: historyRecords(summary),
      trend: trendRecord(summary),
      log: [line, "[fake] run 2 stalled a client — /?_client=12 left with no answer", ""].join("\n"),
    });
    const atTheLoss = read(dir)
      .events.filter((event: any) => event.reload === 1)
      .map((event: any) => event.text);
    expect(atTheLoss.find((text: string) => text.startsWith("the app's own log"))).toBe(
      "the app's own log (server.log) names this client on 2 line(s): " +
        `${line.trim()} | [fake] run 2 stalled a client — /?_client=12 left with no answer ` +
        "— MIXED: 1 line(s) ANSWERED (200) and 1 with no status — part of what this client was handed came " +
        "back, and part ended under the app",
    );
  });

  it("says a loss the account carries no ordinal for, rather than leaving a hole where a handle goes", () => {
    // The places are in the account and the handle is not — the case of a loss whose clients
    // were not the traffic driver's, which the account writes as `client: null` on purpose.
    // Said rather than elided: a line naming only the places reads the same whether the
    // account never had an ordinal or a reader lost it.
    const summary = summaryOf({
      verdict: "FAIL",
      reloads: [
        {
          phase: "busy",
          lost: 1,
          spent: [{ client: null, acceptedAt: iso(SWAP_MS - 40), atTheDoor: { nth: 2, of: 5 }, handed: null }],
        },
      ],
      problems: [
        "reload 1 (busy): a client at the port change was answered 503 — the front door holds the port and never closes it, so a swap may not cost a client its answer",
      ],
    });
    const diagnosis = read(writeAccount({ summary, history: historyRecords(summary), trend: trendRecord(summary) }));

    expect(
      diagnosis.events
        .filter((event: any) => event.text.startsWith("the swap cost"))
        .map((event: any) => event.text),
    ).toEqual([
      "the swap cost 1 client(s): a client this account names no `_client=` ordinal for — the 2nd of the 5 client(s) the swap had at the door",
    ]);
  });

  it("says the count alone when the swap's own evidence does not name its losses", () => {
    // Two silences, and only one of them means anything: an evidence block that lost nothing
    // carries an empty list, and a block written before a swap named its losses carries no list
    // at all — which is a run whose lost client the account cannot place, and is said in words
    // rather than read as a swap that cost nothing.
    const summary = summaryOf({
      verdict: "FAIL",
      reloads: [{ phase: "busy", lost: 2, spent: null }],
      problems: [
        "reload 1 (busy): a client at the port change was answered 503 — the front door holds the port and never closes it, so a swap may not cost a client its answer",
      ],
    });
    const diagnosis = read(writeAccount({ summary, history: historyRecords(summary), trend: trendRecord(summary) }));
    const costs = diagnosis.events.filter((event: any) => event.text.startsWith("the swap cost"));

    expect(costs.map((event: any) => event.text)).toEqual([
      "the swap cost 2 client(s), and which client each one was is not in this account (a summary written before a swap's evidence named its losses carries the count alone)",
    ]);

    // ...and an account older still, with no per-swap evidence in it at all, gets no such
    // line: there is no count of a swap's losses to say anything about.
    const older = summaryOf({ reloads: [{ phase: "busy" }] });
    delete (older as { swapsAtTheDoor?: unknown }).swapsAtTheDoor;
    const oldest = read(writeAccount({ summary: older, history: historyRecords(older), trend: trendRecord(older) }));
    expect(oldest.events.filter((event: any) => event.text.startsWith("the swap cost"))).toEqual([]);
  });

  it("reads each swap's losses against the reload whose port changed hands at that instant, not by position", () => {
    // The evidence is a list of SWAPS and the rows are a list of RELOADS, and the two are
    // matched by the instant the port changed hands — the same instant the summary and the
    // record both take from one record — so a list written in another order cannot put one
    // reload's lost client against another reload's reload.
    const summary = summaryOf({
      reloads: [
        { phase: "busy", lost: 1, spent: [{ acceptedAt: iso(SWAP_MS), atTheDoor: { nth: 1, of: 4 }, handed: null }] },
        { phase: "trickle" },
        { phase: "quiet", lost: 1, spent: [{ acceptedAt: iso(2 * GAP + SWAP_MS), atTheDoor: { nth: 3, of: 9 }, handed: null }] },
      ],
    });
    summary.swapsAtTheDoor = [...summary.swapsAtTheDoor].reverse();
    const diagnosis = read(writeAccount({ summary, history: historyRecords(summary), trend: trendRecord(summary) }));

    expect(
      diagnosis.events
        .filter((event: any) => event.text.startsWith("the swap cost"))
        .map((event: any) => [event.reload, event.text]),
    ).toEqual([
      [
        1,
        "the swap cost 1 client(s): a client this account names no `_client=` ordinal for — the 1st of the 4 client(s) the swap had at the door",
      ],
      [
        3,
        "the swap cost 1 client(s): a client this account names no `_client=` ordinal for — the 3rd of the 9 client(s) the swap had at the door",
      ],
    ]);
  });

  it("places each answer where it arrived, and reads the side of the swap off the instant", () => {
    // Two answers, one either side of the port changing hands, and NO aggregate flag in
    // the account at all: what the answer is can only come from where it is, which is the
    // whole point of carrying the instants.
    const summary = summaryOf({
      reloads: [
        {
          phase: "busy",
          held: {
            answered: [
              { status: 200, at: iso(SWAP_MS - 110) },
              { status: 503, at: iso(SWAP_MS + 700) },
            ],
            answeredBeforeSwap: undefined,
          },
        },
      ],
    });
    const diagnosis = read(writeAccount({ summary, history: historyRecords(summary), trend: trendRecord(summary) }));
    const answers = diagnosis.events.filter((event: any) => event.text.includes("was answered"));

    expect(answers.map((event: any) => event.offsetMs)).toEqual([HOLD_LEAD_MS + SWAP_MS - 110, HOLD_LEAD_MS + SWAP_MS + 700]);
    expect(answers[0].text).toBe(
      "the connection held across the swap was answered 200 — BEFORE the port changed hands, while the run it was piped to was still serving",
    );
    expect(answers[1].text).toBe("the connection held across the swap was answered 503 — after the port had changed hands");
  });

  it("says a hold that was refused where the refusal happened, not on the swap", () => {
    // A door that would not take the connection at all: the failure has an instant, and it
    // is the finding the reload is judged on rather than a clause on the port change.
    const summary = summaryOf({
      reloads: [
        {
          phase: "busy",
          // The attempt fails where it is made — before the reload is asked for, which is
          // when the soak opens the hold.
          held: { accepted: false, acceptedAt: null, endedReason: "ECONNREFUSED", endedAt: iso(-HOLD_LEAD_MS), answered: [], leftoverConnections: null },
        },
      ],
    });
    const diagnosis = read(writeAccount({ summary, history: historyRecords(summary), trend: trendRecord(summary) }));
    const refusal = diagnosis.events.find((event: any) => event.text.includes("was never accepted"));

    expect(refusal?.offsetMs).toBe(0);
    expect(diagnosis.events.find((event: any) => event.text.startsWith("asked for the reload"))?.offsetMs).toBe(HOLD_LEAD_MS);
    expect(refusal?.text).toBe("the connection the soak opened to the door for this reload was never accepted (ECONNREFUSED)");
    expect(diagnosis.events.some((event: any) => event.text.startsWith("a client's connection was held"))).toBe(false);
    expect(diagnosis.events.find((event: any) => event.text.startsWith("the port changed hands"))?.text).toBe(
      "the port changed hands: port 62158 → 62159",
    );
  });

  it("names a line of the history it cannot use, and still reads the rest of the file", () => {
    const summary = summaryOf({});
    const records = historyRecords(summary);
    // The middle reload's record is the one this reader cannot use, and the two around it
    // are still read: nothing else in the file is hidden by it.
    const dir = writeAccount({
      summary,
      history: `${[JSON.stringify(records[0]), '{"schema":"base88.reload/1"}', JSON.stringify(records[2])].join("\n")}\n`,
      trend: trendRecord(summary),
    });
    const diagnosis = read(dir);

    expect(diagnosis.verdict).toBe("RED");
    expect(diagnosis.problems).toHaveLength(1);
    expect(diagnosis.problems[0]).toContain("reloads.jsonl line 2");
    expect(diagnosis.problems[0]).toContain("no outcome");
    // The records either side of it are still there — matched to their OWN reloads, and
    // not filled in from the neighbours: the reload whose record is missing keeps the
    // summary's account and no record's sentence.
    expect(diagnosis.reloads.map((row: any) => Boolean(row.record))).toEqual([true, false, true]);
    const concluded = diagnosis.events.filter((event: any) => event.text.startsWith("reload concluded"));
    expect(concluded).toHaveLength(3);
    expect(concluded.every((event: any) => !event.text.includes("the record says:"))).toBe(true);
    expectThroughProcess(dir, 1, "problems=1");
  });

  it("matches each reload to its own record by the instant it was asked, not by position", () => {
    const summary = summaryOf({ reloads: [{ phase: "busy", detail: "one" }, { phase: "trickle", detail: "two" }, { phase: "quiet", detail: "three" }] });
    // The history of a real run is in run order; the reader must not depend on that.
    const dir = writeAccount({ summary, history: historyRecords(summary).reverse(), trend: trendRecord(summary) });
    const diagnosis = read(dir);

    const concluded = diagnosis.events.filter((event: any) => event.text.includes("the record says:"));
    expect(concluded.map((event: any) => event.text.match(/the record says: (.*)$/)?.[1])).toEqual(["one", "two", "three"]);
  });

  it("shows a record from another vocabulary as it stands instead of judging it", () => {
    const summary = summaryOf({});
    const records = historyRecords(summary).map((record, index) => (index === 0 ? { ...record, schema: "base88.reload/9" } : record));
    const diagnosis = read(writeAccount({ summary, history: records, trend: trendRecord(summary) }));

    expect(diagnosis.notes.join("\n")).toContain("base88.reload/9");
    expect(diagnosis.verdict).toBe("PASS");
  });
});

describe("an account that cannot be read", () => {
  it("says nothing of the account is there when none of the three files is", () => {
    const dir = mkdtempSync(join(tmpdir(), "anybase-soak-account-empty-"));
    const result = run([dir]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("SOAK_DIAGNOSIS=UNREADABLE files=0");
    expect(result.stdout).toContain("nothing of the account is there");
  });

  it("is unreadable when the summary is not JSON, and still shows the other half", () => {
    const summary = summaryOf({});
    const dir = writeAccount({ summary: "{not json", history: historyRecords(summary), trend: trendRecord(summary) });
    const result = run([dir]);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("could not be read: ");
    expect(result.stdout).toContain("SOAK_DIAGNOSIS=UNREADABLE");
    // What WAS readable is still on the timeline: the reloads the history and the trend
    // line name, rather than a report that says only "unreadable".
    expect(result.stdout).toMatch(/reload 3 \(quiet\)/);
  });

  it("is unreadable when a trend line is not JSON, which is how the gate reads it too", () => {
    const summary = summaryOf({});
    const dir = writeAccount({ summary, history: historyRecords(summary), trend: "{oops" });
    expect(run([dir]).status).toBe(2);
    expect(main([dir], { readFile: (path) => readFileSync(path, "utf8"), out: () => {}, err: () => {} })).toBe(2);
  });

  it("reads a missing file as an absent one rather than as a broken account", () => {
    const summary = summaryOf({});
    const dir = writeAccount({ summary });
    const diagnosis = read(dir);

    expect(diagnosis.files.find((file: any) => file.key === "history")?.present).toBe(false);
    expect(diagnosis.verdict).toBe("PASS");
    // ...and every reload is still on the clock, from the summary's own fields.
    expect(diagnosis.reloads).toHaveLength(3);
    expect(diagnosis.events.some((event: any) => event.text.includes("reload concluded"))).toBe(true);
  });
});

describe("the report", () => {
  it("puts one JSON object on stdout and the human timeline on stderr under --json", () => {
    const dir = accountOf({ verdict: "FAIL", problems: ["the front door answered 40 request(s) with statuses {\"200\":40}"] });
    const result = run([dir, "--json"]);

    expect(result.status).toBe(1);
    const account = JSON.parse(result.stdout.trim()) as Record<string, any>;
    expect(account.verdict).toBe("RED");
    expect(account.problems).toHaveLength(1);
    expect(account.events.length).toBeGreaterThan(0);
    expect(account.reloads).toHaveLength(3);
    expect(result.stderr).toContain("SOAK_DIAGNOSIS=RED");
    expect(result.stdout).not.toContain("SOAK_DIAGNOSIS");
  });

  it("refuses a flag it cannot read at all, and a third account", () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(["--summary"], { out: (text: string) => out.push(text), err: (text: string) => err.push(text) });
    expect(code).toBe(2);
    expect(err.join("")).toContain("--summary needs a value");
    // Two directories are the comparison now; a third is a typo, refused as usage.
    expect(main(["a", "b", "c"], { out: () => {}, err: () => {} })).toBe(2);
  });

  it("says which reload a claim is about, in the reader's words, for a run that did not pass", () => {
    // The trend half of the same door claim, through `heldNotes`, so nobody has to run
    // `check:soak-trend` beside this to read the line the artifact carries.
    const diagnosis = read(
      accountOf({
        verdict: "FAIL",
        problems: ["reload 1 (busy): the door reported 0 connection(s) still on the run it retired, while a client was holding one that had been piped to it"],
        reloads: [{ phase: "busy", held: { leftoverConnections: 0 } }],
      }),
    );
    const notes = diagnosis.notes.join("\n");
    expect(notes).toContain("held reload 1 (busy), on the run it had in port 62158");
    expect(notes).toContain("was still open when the door took its count, which reported 0 connection(s)");
  });
});

describe("two accounts, compared", () => {
  it("prints only the facts that are not the same in both, and says what it did not compare", () => {
    const result = run([green(), red()]);

    // The comparison happened, and DIFFERENT is the answer rather than a failure: the exit
    // code is about whether both accounts could be READ.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SOAK_DIFF=DIFFERENT");
    // Run-level: the verdict, the problem the soak named, the note.
    expect(result.stdout).toMatch(/^ {2}the run$/m);
    expect(result.stdout).toMatch(/verdict {2,}PASS {2,}-> {2,}RED/);
    expect(result.stdout).toContain("+ reload 3 (quiet): the door reported 0 connection(s)");
    expect(result.stdout).toContain("+ the descriptor trend is not judged for one reading a phase");
    // The reload that changed: how it ended, and the count the door reported on it.
    expect(result.stdout).toMatch(/^ {2}reload 3$/m);
    expect(result.stdout).toMatch(/outcome {2,}replaced {2,}-> {2,}rolled-back/);
    expect(result.stdout).toMatch(/held\.leftoverConnections {2,}3 {2,}-> {2,}0/);
    // A reload the two runs agree about produces no group at all — the whole point of the
    // command is that a reader never sees the parts that are the same.
    expect(result.stdout).not.toMatch(/^ {2}reload 1$/m);
    expect(result.stdout).not.toMatch(/^ {2}reload 2$/m);
    // ...and its exclusions are named rather than left for a reader to reverse-engineer.
    expect(result.stdout).toContain("not compared: instants, ports, window durations, descriptor counts");
    expect(result.stdout).toContain("which IS compared");
  });

  it("names the run that got SLOWER, against the allowance the trend gate judges cost with", () => {
    // The same run with one phase's reloads costing more. Nothing about what either run DID
    // changed, so without the cost side this would read as SAME — which is the regression a
    // comparison of problems alone cannot find.
    const slower = accountOf({ reloads: [{ phase: "busy", landMs: 12_000 }, { phase: "trickle" }, { phase: "quiet" }] });
    const result = run([green(), slower]);

    // DIFFERENT is not a failure, and the exit code is still about whether both were read.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SOAK_DIFF=DIFFERENT");
    expect(result.stdout).toMatch(/^ {2}the run's cost$/m);
    // 8400ms → 12000ms is +3600ms, past the 2100ms this comparison allows (a quarter of the
    // median, which is more than the 2s floor) — so it is a fact, named as the phase it is.
    expect(result.stdout).toMatch(/busy median {2,}8400ms {2,}-> {2,}12000ms \(\+3600ms, more than the 2100ms allowed\)/);
    // The total moved by the same 3600ms, which its own, wider allowance (10s) covers, so it
    // is NOT reported: a movement inside the allowance is not a difference.
    expect(result.stdout).not.toContain("total cost");
    expect(result.stdout).toContain("cost=+3600ms");

    // ...and the same facts in memory, as one group of their own after the run itself.
    const diff = diffAccounts(read(green()), read(slower));
    expect(diff.cost).toBe(3_600);
    expect(diff.groups.map((group: any) => group.where)).toEqual(["the run's cost"]);
  });

  it("reports the run's total when every phase is slower, and a run that came out faster too", () => {
    const everyPhase = { reloads: [{ phase: "busy" as Phase, landMs: 20_000 }, { phase: "trickle" as Phase, landMs: 20_000 }, { phase: "quiet" as Phase, landMs: 20_000 }] };
    const slower = run([green(), accountOf(everyPhase)]);

    // Three phases at three times the cell against a total within 20% or 10s of the other: the
    // total is the run's cost as one number, and it is a fact here because it moved 34800ms.
    expect(slower.stdout).toMatch(/total cost {2,}25200ms {2,}-> {2,}60000ms \(\+34800ms, more than the 10000ms allowed\)/);
    expect(slower.stdout).toContain("cost=+34800ms");

    // The direction is the reader's, not this command's: a run whose reloads cost LESS is a
    // difference on the same terms, because a movement past the allowance is one either way.
    const faster = run([green(), accountOf({ reloads: [{ phase: "busy", landMs: 4_000 }, { phase: "trickle" }, { phase: "quiet" }] })]);
    expect(faster.stdout).toMatch(/busy median {2,}8400ms {2,}-> {2,}4000ms \(-4400ms, more than the 2100ms allowed\)/);
    expect(faster.stdout).toContain("cost=-4400ms");
  });

  it("keeps a movement inside the allowance silent, so the cost side is not a line per run", () => {
    const nudged = accountOf({ reloads: [{ phase: "busy", landMs: LAND_MS + 600 }, { phase: "trickle" }, { phase: "quiet" }] });
    const result = run([green(), nudged]);

    // 600ms is inside the 2s floor, so it is not a difference and there is no group — but the
    // machine line still says how much more the second run cost, which is the number a person
    // tracking a series wants (and is `?` only when there is nothing to read a cost from).
    expect(result.stdout).toContain("SOAK_DIFF=SAME accounts=2 differences=0 reloads=3/3 cost=+600ms");
    expect(result.stdout).not.toContain("the run's cost");
  });

  it("refuses the cost comparison across profiles, and says which two it refused", () => {
    const elsewhere = accountOf({ platform: "win32", reloads: [{ phase: "busy", landMs: 20_000 }, { phase: "trickle", landMs: 20_000 }, { phase: "quiet", landMs: 20_000 }] });
    const result = run([green(), elsewhere]);

    // The two runs DID differ (the profile is a compared fact) — but a movement that size on
    // another machine is not a measurement of this one, so the cost half is named as skipped
    // rather than judged, exactly as the trend gate refuses the same comparison.
    expect(result.stdout).toContain("SOAK_DIFF=DIFFERENT");
    expect(result.stdout).not.toContain("total cost");
    expect(result.stdout).toContain("not compared: the cost side: the two ran on different profiles (linux/x64/22 against win32/x64/22)");
    expect(result.stdout).toContain("cost=?");
  });

  it("says which half the cost came from when an account left no trend line", () => {
    const summary = summaryOf({});
    const withoutLine = writeAccount({ summary, history: historyRecords(summary) });
    const result = run([withoutLine, green()]);

    // The trend line is the file that names what a run cost, so an account without one has no
    // cost to compare — reported as skipped, rather than as a run that cost nothing.
    expect(result.stdout).toContain("not compared: the cost side: a trend line is missing on one side");
    expect(result.stdout).toContain("cost=?");
  });

  it("says the two runs agree when nothing comparable differs", () => {
    const result = run([green(), green()]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SOAK_DIFF=SAME accounts=2 differences=0 reloads=3/3");
    expect(result.stdout).toContain("the two accounts agree on every fact that two runs can be compared on");
    expect(result.stdout).not.toContain("CHANGED");
  });

  it("never reports the facts that are the identity of one run", () => {
    // The same run with only its ports, its clock, its window and its descriptor readings
    // moved: a different RUN, but not a different STORY — so there is nothing to report.
    const summary = summaryOf({});
    const moved = movedRunIdentity(summary);
    const result = run([
      writeAccount({ summary, history: historyRecords(summary), trend: trendRecord(summary) }),
      writeAccount({ summary: moved, history: historyRecords(moved), trend: trendRecord(moved) }),
    ]);

    expect(result.stdout).toContain("SOAK_DIFF=SAME accounts=2 differences=0 reloads=3/3");
    // Not one line about the facts excluded by name — which is the reason the comparison is
    // by fact rather than by text: two timelines differ in every timestamp they carry.
    expect(result.stdout).not.toMatch(/^ {4}(served|checks|retiredPort|replacementPort|frontPort|windowUsedMs|descendants|handles) {2,}/m);
    expect(result.stdout).not.toMatch(/startedAt|landedAt|swappedAt|acceptedAt|endedAt/);
  });

  it("reports a reload only one account has, and a hold in a shape the other is not", () => {
    // Three reloads against two: the third is a fact about the first account, not a
    // difference to be read field by field against a reload that is not there.
    // The reload is reported as the fact NOT BEING THERE (`(none)`) rather than with a word
    // about which side is missing, so the line reads the same in a pair and in a series.
    const short = run([accountOf({}), accountOf({ reloads: [{ phase: "busy" }, { phase: "trickle" }] })]);
    expect(short.stdout).toContain("SOAK_DIFF=DIFFERENT");
    expect(short.stdout).toMatch(/the reload {2,}a quiet reload {2,}-> {2,}\(none\)/);

    // A hold in a shape this reader does not know is compared AS a shape difference rather
    // than read as a quiet hold: the marker is a compared fact, and its answers go from an
    // empty list (nothing was said) to nothing at all (no facts this reader can read).
    const stranger = run([
      accountOf({}),
      accountOf({ reloads: [{ phase: "busy", held: { shape: "anybase-held/9" } }, { phase: "trickle" }, { phase: "quiet" }] }),
    ]);
    expect(stranger.stdout).toMatch(/held\.shape {2,}anybase-held\/2 {2,}-> {2,}anybase-held\/9/);
    expect(stranger.stdout).toMatch(/held\.answered {2,}\[\] {2,}-> {2,}\(none\)/);
  });

  it("is exit 2 when one of the two could not be read, and says the lines are one-sided", () => {
    const empty = mkdtempSync(join(tmpdir(), "anybase-soak-account-none-"));
    const result = run([accountOf({}), empty]);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("SOAK_DIFF=UNREADABLE");
    // Said FIRST, because everything after it is misleading until it has been read.
    expect(result.stdout).toContain("could not be read, so what follows is that account's absence of facts");
  });

  it("writes the comparison as one JSON object under --json", () => {
    const result = run([green(), red(), "--json"]);

    expect(result.status).toBe(0);
    const diff = JSON.parse(result.stdout.trim()) as Record<string, any>;
    expect(diff.mode).toBe("diff");
    expect(diff.read).toBe(true);
    expect(diff.differences).toBeGreaterThan(0);
    expect(diff.groups.map((group: any) => group.where)).toContain("reload 3");
    // The human report goes to stderr, as it does for one account.
    expect(result.stderr).toContain("SOAK_DIFF=DIFFERENT");
    expect(result.stdout).not.toContain("SOAK_DIFF");
  });

  it("compares in memory as well as through the process, so the diff itself is a unit", () => {
    const dirA = green();
    const dirB = red();
    const diff = diffAccounts(read(dirA), read(dirB));

    expect(diff.differences).toBe(diff.groups.reduce((total: number, group: any) => total + group.differences.length, 0));
    // A run-level change is reported under `the run`, a reload's under its own index, and
    // the groups are in the order the accounts live them.
    expect(diff.groups.map((group: any) => group.where)).toEqual(["the run", "reload 3"]);
    // The rendered report names the fact that changed and nothing that did not: reload 1's
    // phase is the same in both, so it is not on the page.
    const text = renderDiff(diff).join("\n");
    expect(text).toMatch(/held\.leftoverConnections {2,}3 {2,}-> {2,}0/);
    expect(text).not.toContain("held.accepted");
  });
});

describe("a series of runs", () => {
  /** The red run with one problem MORE than `red` has: a fact that moves later in a series. */
  const withExtra = () =>
    accountOf({
      verdict: "FAIL",
      problems: [
        "reload 3 (quiet): the door reported 0 connection(s) still on the run it retired, while a client was holding one that had been piped to it",
        "reload 1 (busy): the replacement never answered a health check",
      ],
      notes: ["the descriptor trend is not judged for one reading a phase"],
      reloads: [{ phase: "busy" }, { phase: "trickle" }, { phase: "quiet", outcome: "rolled-back", held: { leftoverConnections: 0 } }],
    });
  /** A run whose reloads cost more in one phase: nothing about what it DID changed. */
  const slower = () => accountOf({ reloads: [{ phase: "busy", landMs: 12_000 }, { phase: "trickle" }, { phase: "quiet" }] });

  it("names the run each fact first changed in, rather than only that the runs differ", () => {
    const result = run([green(), green(), red(), withExtra()]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("soak-account series: 4 run(s)");
    // Every run is named, in the order it is compared: the numbers in the differences are
    // positions in this list, so the list has to be there — and a series given out of order is
    // then visible instead of being silently re-sorted.
    expect(result.stdout).toMatch(/^ {2}run 1 {2}/m);
    expect(result.stdout).toMatch(/^ {2}run 4 {2}/m);
    expect(result.stdout).toContain("each named at the run it FIRST changed in");
    expect(result.stdout).toContain("SOAK_DIFF=DIFFERENT accounts=4 differences=");
    expect(result.stdout).toContain("reloads=3/3/3/3");
    // The claim the soak first made in run 3 is named at run 3...
    expect(result.stdout).toMatch(/\+ reload 3 \(quiet\): the door reported 0 connection/);
    expect(result.stdout).toMatch(/while a client was holding one that had been piped to it {3}\(run 3\)/);
    // ...and the problem only run 4 has is named at run 4, not at the run the first one moved in.
    expect(result.stdout).toMatch(/the replacement never answered a health check {3}\(run 4\)/);
    // A step that changed nothing contributes nothing: runs 1 and 2 are the same run, so no
    // fact is reported at run 2 just to have something to say.
    expect(result.stdout).not.toMatch(/\(run 2\)/);
  });

  it("names every run a fact changed in when it moves back", () => {
    const result = run([green(), green(), red(), green()]);

    // PASS, PASS, RED, PASS: the verdict moved at run 3 and BACK at run 4. A reader shown only
    // the first change cannot tell a one-off from a series that stayed red — which is the
    // whole reason a regression series is read a step at a time.
    expect(result.stdout).toMatch(/verdict {2,}PASS {2,}-> {2,}RED {3}\(run 3\)/);
    expect(result.stdout).toMatch(/verdict {2,}RED {2,}-> {2,}PASS {3}\(run 4\)/);
    expect(result.stdout).toContain("SOAK_DIFF=DIFFERENT accounts=4");
  });

  it("collects the runs of one change that happened more than once, rather than hiding it", () => {
    const result = run([green(), red(), green(), red()]);

    // PASS, RED, PASS, RED: the same change (PASS → RED) happened at run 2 and again at run 4,
    // so it is ONE difference naming both runs — the alternative is a series that reads as if
    // the last step changed nothing.
    expect(result.stdout).toMatch(/verdict {2,}PASS {2,}-> {2,}RED {3}\(runs 2, 4\)/);
    expect(result.stdout).toMatch(/verdict {2,}RED {2,}-> {2,}PASS {3}\(run 3\)/);
  });

  it("names the run a cost movement happened in, across a series", () => {
    const result = run([green(), green(), slower(), slower()]);

    // The same facts, one phase costing more from run 3 on: the movement is named at the run
    // it started in, which is the run a person has to look at.
    expect(result.stdout).toMatch(/^ {2}the run's cost$/m);
    expect(result.stdout).toMatch(/busy median {2,}8400ms {2,}-> {2,}12000ms \(\+3600ms, more than the 2100ms allowed\) {3}\(run 3\)/);
    // The machine token is the LAST run against the FIRST, which is the drift over the series.
    expect(result.stdout).toContain("cost=+3600ms");
  });

  it("says the runs agree when nothing comparable differs across the series", () => {
    const result = run([green(), green(), green()]);

    expect(result.stdout).toContain("SOAK_DIFF=SAME accounts=3 differences=0 reloads=3/3/3 cost=0ms");
    expect(result.stdout).toContain("the 3 accounts agree on every fact that runs can be compared on");
    expect(result.stdout).not.toContain("CHANGED");
  });

  it("says which runs could not be read rather than letting them read as change points", () => {
    const empty = mkdtempSync(join(tmpdir(), "anybase-soak-account-none-"));
    const result = run([green(), empty, green()]);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("SOAK_DIFF=UNREADABLE accounts=3");
    expect(result.stdout).toContain("NOTE run 2 could not be read, so the steps into and out of it are that account's absence of facts");
    expect(result.stdout).toContain("reloads=3/0/3");
    // Those two steps have no cost to compare, and say so; the two ends that DO have one are
    // still read, because the token is the last run against the first.
    expect(result.stdout).toContain("not compared: the cost side: a trend line is missing on one side");
    expect(result.stdout).toContain("cost=0ms");
  });

  it("writes the series as one JSON object, every difference carrying the run it changed in", () => {
    const result = run([green(), green(), red(), green(), "--json"]);

    expect(result.status).toBe(0);
    const series = JSON.parse(result.stdout.trim()) as Record<string, any>;
    expect(series.mode).toBe("series");
    expect(series.dirs).toHaveLength(4);
    expect(series.verdicts).toEqual(["PASS", "PASS", "RED", "PASS"]);
    expect(series.reloads).toEqual([3, 3, 3, 3]);
    expect(series.read).toBe(true);
    // Every difference says where it happened, which is what a consumer needs to bisect a
    // regression without reading the prose at all.
    const verdict = series.groups
      .flatMap((group: any) => group.differences)
      .find((difference: any) => difference.field === "verdict");
    expect(verdict.run).toBe(3);
    expect(verdict.runs).toEqual([3]);
    expect(series.differences).toBe(series.groups.reduce((total: number, group: any) => total + group.differences.length, 0));
    // The human report goes to stderr, as it does for one account and for a pair.
    expect(result.stderr).toContain("SOAK_DIFF=DIFFERENT");
  });

  it("compares in memory as well as through the process, so the series itself is a unit", () => {
    const series = seriesAccounts([read(green()), read(green()), read(red()), read(withExtra())]);

    expect(series.mode).toBe("series");
    expect(series.differences).toBe(series.groups.reduce((total, group) => total + group.differences.length, 0));
    // A group appears once wherever in the series it first showed up, and every difference in
    // it names the run it moved in.
    expect(series.groups.map((group) => group.where)).toEqual(["the run", "reload 3"]);
    const moved = series.groups.flatMap((group) => group.differences);
    // Two facts in ONE group, each named at its own run: the claim first appeared in run 3 and
    // the extra problem only exists from run 4 — which is the whole difference between a
    // series and a diff against the first run.
    expect(moved.find((difference) => String(difference.value ?? "").includes("door reported 0 connection"))?.run).toBe(3);
    expect(moved.find((difference) => String(difference.value ?? "").includes("never answered a health check"))?.run).toBe(4);
    // A fact that moved is labelled even in a pair: the run is always the second, which is the
    // only run anything can have changed in.
    const pair = diffAccounts(read(green()), read(red()));
    const pairMoved = pair.groups.flatMap((group) => group.differences);
    expect(pairMoved.length).toBeGreaterThan(0);
    expect(pairMoved.every((difference) => difference.run === 2 && difference.runs?.[0] === 2)).toBe(true);
    expect(diffAccounts(read(green()), read(green())).differences).toBe(0);
  });
});

describe("the door, compared as rates rather than as counts", () => {
  /** The green run's door: 40 requests, every one of them answered 200. */
  const plainDoor = () => accountOf({});
  /** The same run with a share of its traffic answered 503 instead. */
  const mixedDoor = () => accountOf({ door: { requests: 40, byStatus: { 200: 37, 503: 3 } } });

  it("does not report the traffic itself: the same mix at two volumes is the same run", () => {
    // MEASURED, on this repository's own build: three soaks of the same fixture counted 61, 59
    // and 62 requests and served each of them 200. The count is the load generator's; the mix is
    // the door's — so two runs whose traffic differs and whose mix does not are `SAME`.
    const result = run([
      accountOf({ door: { requests: 59, byStatus: { 200: 59 } } }),
      accountOf({ door: { requests: 62, byStatus: { 200: 62 } } }),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SOAK_DIFF=SAME accounts=2 differences=0");
    expect(result.stdout).not.toMatch(/^ {2}the door$/m);
    // ...and the report says so rather than leaving a reader to wonder why 59 and 62 agree.
    expect(result.stdout).toContain("the request count moved 3 in 60 across three runs of one");
  });

  it("compares each status as a SHARE of what the door was offered", () => {
    const result = run([plainDoor(), mixedDoor()]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^ {2}the door$/m);
    // Every line carries the counts behind the percentage, so a reader can see the sample.
    expect(result.stdout).toMatch(/status 200 {2,}100\.0% \(40\/40\) {2,}-> {2,}92\.5% \(37\/40\) \(-7\.5 points, more than the 5\.0 points allowed\)/);
    expect(result.stdout).toContain("SOAK_DIFF=DIFFERENT accounts=2 differences=2");

    // A status the FIRST run never gave is read as the zero it is, not as a missing fact: the
    // door counts every answer it gives, so a 503 that appears is exactly the finding.
    const appeared = run([plainDoor(), accountOf({ door: { requests: 40, byStatus: { 200: 37, 503: 3 } } })]);
    expect(appeared.stdout).toMatch(/status 503 {2,}0\.0% \(0\/40\) {2,}-> {2,}7\.5% \(3\/40\) \(\+7\.5 points, more than the 5\.0 points allowed\)/);
  });

  it("rates the failures the door counts under its own keys, once each", () => {
    // The soak counts a failed request as `!timeout` / `!ECONNRESET` in the SAME map as the
    // statuses, so reading every key of it would report one failure twice, at two denominators.
    const failing = accountOf({
      door: { requests: 40, byStatus: { 200: 34, "!timeout": 3, "!ECONNRESET": 3 }, timeouts: 3, connectionErrors: 3 },
    });
    const result = run([plainDoor(), failing]);

    expect(result.stdout).toMatch(/timeouts {2,}0\.0% \(0\/40\) {2,}-> {2,}7\.5% \(3\/40\) \(\+7\.5 points/);
    expect(result.stdout).toMatch(/connection errors {2,}0\.0% \(0\/40\) {2,}-> {2,}7\.5% \(3\/40\)/);
    // ...and the `!` keys are NOT statuses of their own: one fact, one line.
    expect(result.stdout).not.toContain("status !timeout");
    expect(result.stdout).not.toContain("status !ECONNRESET");
  });

  it("rates the clients in flight per swap that had one, and says when a run had none", () => {
    const busier = accountOf({ door: { swapsWithAClient: 3, clientsInFlight: 5 } });
    const result = run([plainDoor(), busier]);

    // 1.00 and 1.67 clients per swap: a mean rather than a share, and the counts are the swaps
    // it was read over rather than the traffic.
    expect(result.stdout).toMatch(/clients in flight {2,}1\.00 \(3\/3\) {2,}-> {2,}1\.67 \(5\/3\) \(\+0\.67, more than the 0\.50 allowed\)/);

    // A run whose swaps had no client at the door has no mean to have moved — NOT THERE, which is
    // a different fact from zero clients in flight.
    const none = run([plainDoor(), accountOf({ door: { swapsWithAClient: 0, clientsInFlight: 0 } })]);
    expect(none.stdout).toMatch(/clients in flight {2,}1\.00 \(3\/3\) {2,}-> {2,}\(none\)/);
  });

  it("rates the clients a swap lost against the clients that were at the door for it", () => {
    // One client at each of the three swaps, and one of them cost an answer at every one: the loss
    // the soak raises as a problem on the run, as the rate that problem can be compared in — a
    // failing run against a passing one, which is the only way the line can appear at all.
    const costing = accountOf({
      verdict: "FAIL",
      door: { lost: 1 },
      problems: [
        "reload 1 (busy): a client in flight across the port change was answered 503 — the front door holds the port and never closes it, so a swap may not cost a client its answer",
      ],
    });
    const result = run([plainDoor(), costing]);

    // The share is of the clients the swaps had at the door, and the counts say which client was
    // lost where: three clients, three of them lost. It is judged in CLIENTS rather than in the
    // traffic's points of mix: half a client of the three at the door is 16.7 points, which is
    // what one client is worth here — so a difference this size could not have been the traffic.
    expect(result.stdout).toMatch(
      /clients lost {2,}0\.0% \(0\/3\) {2,}-> {2,}100\.0% \(3\/3\) \(\+100\.0 points, more than the 16\.7 points allowed — half a client of the 3 at the door, where a whole one is worth 33\.3 points\)/,
    );
    // ...and the problem it is the magnitude of is still the run group's fact, at its own reload.
    expect(result.stdout).toMatch(/^ {2}the run$/m);
    expect(result.stdout).toContain("a client in flight across the port change was answered 503");
  });

  it("divides a loss by the clients at the door, not by the clients in flight across the change", () => {
    // Two clients touched each swap's window, NEITHER was open across the instant, and one was
    // answered outside 200: a request answered inside the window but after the port changed hands
    // is a client the door cost an answer and never one it had in flight. Read against the
    // in-flight count that loss would have no denominator at all — and, with a client genuinely in
    // flight, could read as more than every client the mean was over.
    const windowOnly = accountOf({
      verdict: "FAIL",
      door: { atTheDoor: 2, lost: 1, swapsWithAClient: 3, clientsInFlight: 0 },
      problems: [
        "reload 2 (trickle): a client at the port change was answered 503 — the front door holds the port and never closes it, so a swap may not cost a client its answer",
      ],
    });
    const result = run([plainDoor(), windowOnly]);

    // The same three losses, at the sample each side counted among — the passing run's own three
    // clients at its door, and this run's six — while the clients IN FLIGHT are 0.00 (0/3): two
    // different questions, two lines, and neither rate divided by the other run's clients. The
    // allowance is half a client of the sample that makes a client worth LEAST — the six — which
    // is what keeps a client lost in the run with more of them a movement.
    expect(result.stdout).toMatch(
      /clients lost {2,}0\.0% \(0\/3\) {2,}-> {2,}50\.0% \(3\/6\) \(\+50\.0 points, more than the 8\.3 points allowed — half a client of the 6 at the door, where a whole one is worth 16\.7 points\)/,
    );
    expect(result.stdout).toMatch(/clients in flight {2,}1\.00 \(3\/3\) {2,}-> {2,}0\.00 \(0\/3\)/);
  });

  it("does not read a record that never named its losses as a run that lost none", () => {
    // A door block written before the loss was carried in it names the traffic and says nothing
    // about losses, which is not the same fact as a run that names `lost: 0` (the zero it is, out
    // of the clients it had): the side that never spoke prints as NOT THERE.
    const summary = summaryOf({});
    const record = trendRecord(summary);
    // The block as a line written before the loss was carried in it has one: the traffic and the
    // clients, and not one word about what a swap cost.
    const { requests, byStatus, timeouts, connectionErrors, swapsWithAClient, clientsInFlight } = record.door;
    const before = writeAccount({
      summary,
      history: historyRecords(summary),
      trend: { ...record, door: { requests, byStatus, timeouts, connectionErrors, swapsWithAClient, clientsInFlight } },
    });
    const diff = diffAccounts(read(plainDoor()), read(before));
    const door = diff.groups.find((group) => group.where === "the door");

    expect(door?.differences.map((difference) => difference.field)).toEqual(["clients lost"]);
    expect(door?.differences[0]).toMatchObject({ op: "changed", a: "0.0% (0/3)", b: null });
  });

  it("sums a summary's losses from the swaps it carries, the way the trend line carries the sum", () => {
    // A summary names the swaps rather than the totals, and one that left no trend line still has
    // a loss to read — summed where the soak counted it, at the same rate the projection gives.
    const summaryOnly = writeAccount({ summary: summaryOf({ verdict: "FAIL", door: { lost: 1 } }) });
    const diff = diffAccounts(read(plainDoor()), read(summaryOnly));
    const door = diff.groups.find((group) => group.where === "the door");

    expect(door?.differences.map((difference) => difference.field)).toEqual(["clients lost"]);
    expect(door?.differences[0]).toMatchObject({
      a: "0.0% (0/3)",
      b: "100.0% (3/3) (+100.0 points, more than the 16.7 points allowed — half a client of the 3 at the door, where a whole one is worth 33.3 points)",
    });
    expect(diff.skips.join(" ")).toContain("a trend line is missing on one side");
  });

  it("calls a client lost in a large sample a movement, rather than the traffic", () => {
    // Three clients lost among a hundred and twenty at the door is 2.5 points — INSIDE the five
    // points the traffic itself wobbles by, which is the floor a share of the traffic is judged
    // by, and under it this is exactly the loss a large sample would swallow. A loss is not judged
    // that way: it is judged in clients, and the half a client is taken of the LARGER of the two
    // runs' samples, because that is the run where one client moves the rate by the least. Here
    // half a client of the 120 is 0.4 points, so 2.5 points is a movement — where half a client of
    // the other run's 3 (16.7 points) would have called it nothing at all.
    const costing = accountOf({
      verdict: "FAIL",
      door: { atTheDoor: 40, lost: 1 },
      problems: ["reload 3 (quiet): a client at the port change was answered 503 — the front door holds the port and never closes it"],
    });
    const result = run([plainDoor(), costing]);

    expect(result.stdout).toMatch(
      /clients lost {2,}0\.0% \(0\/3\) {2,}-> {2,}2\.5% \(3\/120\) \(\+2\.5 points, more than the 0\.4 points allowed — half a client of the 120 at the door, where a whole one is worth 0\.8 points\)/,
    );
    // ...and the run group still names the reload it was lost at, which is what the verdict was
    // decided on: this line is the magnitude of that finding rather than the finding.
    expect(result.stdout).toContain("a client at the port change was answered 503");
  });

  it("takes the half a client from the run with more clients, whichever run lost one", () => {
    // The rule has to be symmetric, and it is the CLIENTS AT THE DOOR of each run that say what one
    // client is worth — not the side the loss is being read from. So a loss in the run with fewer
    // clients is judged against the larger sample just the same: the same two and a half points as
    // above clear 0.4 points here (half a client of this run's own 120) and would have been under
    // half a client of the other run's 3 (16.7 points if the SMALLER sample had set the allowance).
    const costing = accountOf({
      verdict: "FAIL",
      door: { atTheDoor: 40, lost: 1 },
      problems: ["reload 2 (trickle): a client at the port change was answered 503 — the front door holds the port and never closes it"],
    });
    const result = run([costing, plainDoor()]);

    expect(result.stdout).toMatch(
      /clients lost {2,}2\.5% \(3\/120\) {2,}-> {2,}0\.0% \(0\/3\) \(-2\.5 points, more than the 0\.4 points allowed — half a client of the 120 at the door, where a whole one is worth 0\.8 points\)/,
    );
  });

  it("names the run a door fact moved in, across a series", () => {
    const result = run([plainDoor(), plainDoor(), mixedDoor(), mixedDoor()]);

    // The mix moved at run 3 and stayed there, so that is the run a person has to look at — and
    // the second run, which is the same run again, contributes nothing.
    expect(result.stdout).toMatch(/status 503 {2,}0\.0% \(0\/40\) {2,}-> {2,}7\.5% \(3\/40\) \(\+7\.5 points, more than the 5\.0 points allowed\) {3}\(run 3\)/);
    expect(result.stdout).not.toMatch(/\(run 2\)/);
    expect(result.stdout).toContain("SOAK_DIFF=DIFFERENT accounts=4");
  });

  it("reports the door as not compared when an account names no traffic", () => {
    // A run whose door never saw a request has no rate to read: three zero shares of nothing are
    // not the same fact as a door that answered everything, so the whole group is skipped by name
    // rather than read as a door that failed.
    const result = run([plainDoor(), accountOf({ door: { requests: 0, byStatus: {} } })]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("not compared: the door's counters: one of the two accounts left no door count");
    expect(result.stdout).toContain("SOAK_DIFF=SAME");
  });

  it("reads the door from the summary of a run that left no trend line", () => {
    // The counters are measured by the soak and PROJECTED into the trend line, so an account
    // whose line never got downloaded still has a door to compare — the same reading, from the
    // file they came from — while the cost side is the half that needs the line and says so.
    const summaryOnly = writeAccount({ summary: summaryOf({ door: { requests: 40, byStatus: { 200: 37, 503: 3 } } }) });
    const diff = diffAccounts(read(plainDoor()), read(summaryOnly));

    expect(diff.groups.map((group) => group.where)).toEqual(["the run", "the door"]);
    expect(diff.groups[1].differences.map((difference) => difference.field)).toEqual(["status 200", "status 503"]);
    expect(diff.skips.join(" ")).toContain("a trend line is missing on one side");
  });

  it("compares in memory as well as through the process, so the door is a group of its own", () => {
    const diff = diffAccounts(read(plainDoor()), read(mixedDoor()));

    // After the run and its cost, and before the reloads: the door is a fact about the run.
    expect(diff.groups.map((group) => group.where)).toEqual(["the door"]);
    expect(diff.groups[0].differences.map((difference) => difference.field)).toEqual(["status 200", "status 503"]);
    expect(diff.groups[0].differences[1]).toMatchObject({
      op: "changed",
      a: "0.0% (0/40)",
      b: "7.5% (3/40) (+7.5 points, more than the 5.0 points allowed)",
    });
    expect(diff.differences).toBe(2);
  });

  it("carries the door's facts into the JSON a consumer reads", () => {
    const result = run([plainDoor(), mixedDoor(), "--json"]);

    const diff = JSON.parse(result.stdout.trim()) as Record<string, any>;
    const door = diff.groups.find((group: any) => group.where === "the door");
    expect(door.differences.map((difference: any) => difference.field)).toEqual(["status 200", "status 503"]);
    expect(door.differences[0].a).toBe("100.0% (40/40)");
  });
});

describe("one account against a stored baseline", () => {
  /** The run whose reloads cost more in one phase: nothing about what it DID changed. */
  const slower = () => accountOf({ reloads: [{ phase: "busy", landMs: 12_000 }, { phase: "trickle" }, { phase: "quiet" }] });

  it("says how far ONE artifact drifted from the runs before it", () => {
    const result = run([slower(), "--baseline", baselineOf(3)]);

    // The account itself carries no problem, and a drift is an ANSWER rather than a failure —
    // the same rule a pair follows for its cost half, so a pipeline can use it.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BASELINE — ");
    expect(result.stdout).toContain("3 record(s), 3 of them a baseline for this run (linux/x64/22)");
    expect(result.stdout).toContain("DRIFTED — 1 cost fact(s), the baseline before it  ->  this run");
    // The baseline's own number is the MEDIAN of the medians its records read (8400ms in each
    // of the three), and the allowance is the one check:soak-trend judges the same comparison
    // with: a quarter of that median, which is more than the 2s floor.
    expect(result.stdout).toMatch(/busy median {2,}8400ms {2,}-> {2,}12000ms \(\+3600ms, more than the 2100ms allowed\)/);
    // The total moved by the same 3600ms, which its own, wider allowance (10s) covers, so it is
    // not a fact — and the machine line carries it either way.
    expect(result.stdout).not.toContain("total cost");
    expect(result.stdout).toContain("SOAK_DRIFT=DRIFTED records=3 compared=3 differences=1 cost=+3600ms");
  });

  it("says the run is WITHIN what the runs before it allow rather than staying silent", () => {
    const result = run([green(), "--baseline", baselineOf(3)]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("the run's cost is within what the 3 run(s) before it allow");
    expect(result.stdout).toContain("SOAK_DRIFT=WITHIN records=3 compared=3 differences=0 cost=0ms");
    // The drift is a reading of ONE run, so the account's own verdict and machine line are
    // exactly what they are without it.
    expect(result.stdout).toContain("SOAK_DIAGNOSIS=PASS files=3 reloads=3");
  });

  it("does not let a run be its own baseline, and names the line it left in the kept file", () => {
    // A trend file KEPT across runs is the file the run just appended its own line to, which is
    // exactly the file a person has to hand — so its own line is in there, and it is not a
    // baseline for itself.
    const summary = summaryOf({ reloads: [{ phase: "busy", landMs: 12_000 }, { phase: "trickle" }, { phase: "quiet" }] });
    const dir = writeAccount({ summary, history: historyRecords(summary), trend: trendRecord(summary) });
    const result = run([dir, "--baseline", writeBaseline([earlierRun(1), earlierRun(2), earlierRun(3), trendRecord(summary)])]);

    expect(result.stdout).toContain("carries this run's own line");
    expect(result.stdout).toContain("which is not a baseline for itself");
    expect(result.stdout).toContain("records=4 compared=3");
    // ...and without that exclusion the drift would have been diluted by the run's own numbers,
    // which is the whole reason the line is recognised rather than counted.
    expect(result.stdout).toContain("SOAK_DRIFT=DRIFTED records=4 compared=3");
  });

  it("leaves out every record that is not a baseline, and says each reason by name", () => {
    const result = run([
      green(),
      "--baseline",
      writeBaseline([
        earlierRun(1),
        earlierRun(2),
        earlierRun(3),
        earlierRun(4, { verdict: "FAIL", problems: ["reload 3 (quiet): the door reported 0 connection(s) still on the run it retired"] }),
        earlierRun(5, { platform: "win32" }),
        { schema: "another-trend/1", at: iso(6_000) },
      ]),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 line(s) of the baseline are not records in anybase-soak-trend/1");
    expect(result.stdout).toContain("1 earlier record(s) of the baseline ran on another profile (linux/x64/22 is the profile being compared)");
    expect(result.stdout).toContain("1 earlier record(s) of the baseline did not pass, and are not a baseline");
    expect(result.stdout).toContain("records=6 compared=3");
    expect(result.stdout).toContain("SOAK_DRIFT=WITHIN records=6 compared=3");
  });

  it("reads a baseline thinner than the gate judges on, and says the gate would not", () => {
    const result = run([green(), "--baseline", baselineOf(1)]);

    // A lone artifact is exactly when a person wants the number, so it is read — with the
    // gate's own floor named rather than the reading dressed up as the gate's answer.
    expect(result.stdout).toContain("the baseline is 1 run(s), and check:soak-trend judges across runs only from 3");
    expect(result.stdout).toContain("a median of two runs is a coin toss");
    expect(result.stdout).toContain("SOAK_DRIFT=WITHIN records=1 compared=1");
  });

  it("measures a run that did not pass, with the gate's caveat named instead of the reading refused", () => {
    const result = run([red(), "--baseline", baselineOf(3)]);

    // The exit code is the account's own (it carries a problem), never the drift's: the run
    // being red is not a failure of the comparison.
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("the run being measured is RED, and check:soak-trend judges only a run that passed");
    // The red account's reloads cost what the baseline's do, so nothing moved and the report
    // says exactly that rather than manufacturing a fact for a red run.
    expect(result.stdout).toContain("SOAK_DRIFT=WITHIN records=3 compared=3 differences=0");
    expect(result.stdout).not.toContain("DRIFTED —");
  });

  it("is NOT_COMPARED when the baseline holds nothing of this profile, and the run's own code stands", () => {
    const result = run([green(), "--baseline", writeBaseline([earlierRun(1, { platform: "darwin" }), earlierRun(2, { verdict: "FAIL" })])]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("carries no earlier passing run of linux/x64/22 to read this run against");
    expect(result.stdout).toContain("SOAK_DRIFT=NOT_COMPARED records=2 compared=0 differences=0 cost=?");
    expect(result.stdout).toContain("records=2 compared=0");
    // The account was read, and is still the account: only the comparison is missing.
    expect(result.stdout).toContain("SOAK_DIAGNOSIS=PASS");
  });

  it("is exit 2 when the file it names cannot be read, and prints the account in full anyway", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "anybase-soak-baseline-none-")), "soak-trend.jsonl");
    const result = run([green(), "--baseline", missing]);

    // The comparison asked for could not be made, which is the answer exit 2 is for — while
    // the account itself was read and is printed whole rather than thrown away with it.
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("SOAK_DIAGNOSIS=PASS files=3 reloads=3");
    expect(result.stdout).toContain("not compared: the baseline could not be read:");
    expect(result.stdout).toContain("SOAK_DRIFT=NOT_COMPARED records=0 compared=0");

    // A line that is not JSON is the same answer for the same reason: half a comparison read as
    // a whole one is how a wrong diagnosis gets made.
    const broken = run([green(), "--baseline", writeBaseline('{"schema":"anybase-soak-trend/1"}\nnot json\n')]);
    expect(broken.status).toBe(2);
    expect(broken.stdout).toContain("not compared: the baseline could not be read:");
    expect(broken.stdout).toContain("is not JSON");
  });

  it("writes the drift into the account's own JSON object under --json", () => {
    const result = run([slower(), "--baseline", baselineOf(3), "--json"]);

    expect(result.status).toBe(0);
    const one = JSON.parse(result.stdout.trim()) as Record<string, any>;
    expect(one.verdict).toBe("PASS");
    expect(one.drift.records).toBe(3);
    expect(one.drift.compared).toBe(3);
    expect(one.drift.profile).toBe("linux/x64/22");
    expect(one.drift.cost).toBe(3_600);
    expect(one.drift.differences).toEqual([
      { field: "busy median", op: "changed", a: "8400ms", b: "12000ms (+3600ms, more than the 2100ms allowed)" },
    ]);
    // The human half goes to stderr, as it does for an account read on its own.
    expect(result.stderr).toContain("SOAK_DRIFT=DRIFTED");
    expect(result.stdout).not.toContain("SOAK_DRIFT");

    // ...and an account read WITHOUT a baseline carries no drift at all, which is not the same
    // answer as a comparison that found nothing: one is `null`, the other is an empty reading.
    const plain = JSON.parse(run([green(), "--json"]).stdout.trim()) as Record<string, any>;
    expect(plain.drift).toBe(null);
  });

  it("reads the baseline as numbers as well as prose, so the comparison itself is a unit", () => {
    const diagnosis = read(slower());
    const drift = baselineComparison(diagnosis, [earlierRun(1), earlierRun(2), earlierRun(3)], "/tmp/soak-trend.jsonl");

    expect(drift.records).toBe(3);
    expect(drift.compared).toBe(3);
    expect(drift.profile).toBe("linux/x64/22");
    expect(drift.cost).toBe(3_600);
    expect(drift.skips).toEqual([]);
    expect(drift.notes).toEqual([]);
    expect(drift.differences).toEqual([
      { field: "busy median", op: "changed", a: "8400ms", b: "12000ms (+3600ms, more than the 2100ms allowed)" },
    ]);

    // A run with no trend line of its own has no cost to have drifted, and says so rather than
    // costing nothing; the same is true of a record that never said where it ran.
    const summaryOnly = writeAccount({ summary: summaryOf({}) });
    const noLine = baselineComparison(read(summaryOnly), [earlierRun(1)], "/tmp/soak-trend.jsonl");
    expect(noLine.compared).toBe(0);
    expect(noLine.skips[0]).toContain("left no trend line");
    const noProfile = baselineComparison({ ...diagnosis, trendRecord: { ...diagnosis.trendRecord, profile: null } }, [earlierRun(1)], "/tmp/soak-trend.jsonl");
    expect(noProfile.skips[0]).toContain("names no profile");
  });
});

/**
 * The same run with only the facts that are the identity of ONE run moved: its ports, its
 * clock, its window, its descriptor readings, and the instants its held connection carries.
 * Every fact a comparison is allowed to look at is untouched.
 */
function movedRunIdentity(summary: ReturnType<typeof summaryOf>): ReturnType<typeof summaryOf> {
  const source = summary as Record<string, any>;
  const later = (value: unknown, by: number) =>
    typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value) + by).toISOString() : value;
  return {
    ...source,
    frontPort: (source.frontPort as number) + 777,
    reloadsDetail: (source.reloadsDetail as Record<string, any>[]).map((reload, index) => ({
      ...reload,
      startedAt: later(reload.startedAt, 5_000 + index),
      landedAt: later(reload.landedAt, 5_000 + index),
      swappedAt: later(reload.swappedAt, 5_000 + index),
      retiredPort: reload.retiredPort + 777,
      replacementPort: reload.replacementPort + 777,
      windowUsedMs: reload.windowUsedMs + 111,
      descendants: (reload.descendants ?? 0) + 2,
      handles: (reload.handles ?? 0) + 13,
      // The traffic each run happened to get, which is the fact two real runs were measured
      // to differ by and the reason it is not compared (see `reloadFacts`).
      served: (reload.served ?? 0) + 1,
      checks: (reload.checks ?? 0) + 1,
      held:
        reload.held === undefined
          ? undefined
          : {
              ...reload.held,
              acceptedAt: later(reload.held.acceptedAt, 5_000 + index),
              endedAt: later(reload.held.endedAt, 5_000 + index),
              answered: (reload.held.answered ?? []).map((answer: Record<string, any>) => ({ ...answer, at: later(answer.at, 5_000 + index) })),
            },
    })),
  } as unknown as ReturnType<typeof summaryOf>;
}

/** The events of one reload, in order — the unit the report is built from. */
function eventsOf(summary: ReturnType<typeof summaryOf>, index: number) {
  const rows = reloadRows({ summary, trend: null, history: null });
  return reloadEvents(rows[index]);
}

/** A rendered report, as text, for a summary built in memory. */
function render(summary: ReturnType<typeof summaryOf>) {
  const dir = writeAccount({ summary, history: historyRecords(summary), trend: trendRecord(summary) });
  return renderDiagnosis(read(dir)).join("\n");
}

describe("the pieces the report is built from", () => {
  it("gives a reload its events in the order they happened, an unclocked one kept in place", () => {
    const summary = summaryOf({ reloads: [{ phase: "busy", outcome: null, detail: null }] });
    const events = eventsOf(summary, 0);
    // The reload's clocks make it six lines (the hold being taken, asked, the port
    // changing hands, the count, the hold ending, the reload concluding), in the order the
    // instants put them in rather than the order the code writes them.
    expect(events).toHaveLength(6);
    expect(events.map((event) => event.text.slice(0, 12))).toEqual([
      "a client's c",
      "asked for th",
      "the port cha",
      "the door too",
      "the connecti",
      "reload concl",
    ]);
  });

  it("refuses to conclude for a reload the account names no instant, outcome or record for", () => {
    const summary = summaryOf({});
    const rows = reloadRows({ summary: null, trend: trendRecord(summary), history: null });
    const events = reloadEvents(rows[0]);
    expect(events.every((event) => !event.text.includes("reload concluded"))).toBe(true);
  });

  it("marks the problem at the reload it names in the rendered report", () => {
    const text = render(
      summaryOf({
        verdict: "FAIL",
        problems: ["reload 2 (trickle): the door reported 0 connection(s) still on the run it retired, while a client was holding one that had been piped to it"],
        reloads: [{ phase: "busy" }, { phase: "trickle" }],
      }),
    );
    expect(text).toMatch(/reload 2 \(trickle\)\s+PROBLEM reload 2 \(trickle\): the door reported 0 connection/);
    expect(text).toContain("SOAK_DIAGNOSIS=RED");
  });
});

/** Assert the command's exit code and machine line through the real process. */
function expectThroughProcess(dir: string, status: number, line: string) {
  const result = run([dir]);
  expect(result.status, result.stdout + result.stderr).toBe(status);
  expect(result.stdout).toContain(line);
}
