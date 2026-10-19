/**
 * Pins for the soak's trend — the record `scripts/soak-supervisor.mjs` appends per
 * run (`trendRecord`) and the gate that reads a file of them
 * (`scripts/check-soak-trend.mjs`).
 *
 * Every record here goes through the WRITER, from a summary shaped the way `--json`
 * writes one, so the reader is pinned against the writer's own output instead of
 * against a literal copied out of a trend file: a field the soak stops emitting
 * shows up as a reader that has fallen behind it, rather than as a green test.
 *
 * Three of these cases are the reason the gate exists at all, and each is a way a
 * trend gate rots: a slow-down that is NOT called one (the budget is a budget, and a
 * gate that fires on 5% is a gate somebody turns off), a slow-down that is called one
 * from the run's OWN reloads before any comparison is possible, and a floor compared
 * across runs on a platform whose reading is sampled rather than live. That last one
 * is refused by name rather than judged on noise — the sampled instrument's readings
 * of a clean supervisor were measured 15 handles apart under load (see the header of
 * scripts/check-soak-trend.mjs), which is most of a floor's signal.
 *
 * The exit codes are the interface, so they are asserted twice: as a unit with the
 * reader and the two streams injected — where the cases a real process cannot be made
 * to produce live, like "no such file" and a line that is not JSON — and through the
 * real process against a real file, because that is what a CI step runs.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULTS,
  USAGE,
  heldNotes,
  judgeSoakTrend,
  liveReading,
  main,
  median,
  parseArgs,
  profileKey,
} from "../scripts/check-soak-trend.mjs";
import { DEFAULTS as SOAK_DEFAULTS, HELD_SHAPE, SOAK_TREND_SCHEMA, trendRecord } from "../scripts/soak-supervisor.mjs";

const HERE = process.cwd();
const SCRIPT = join(HERE, "scripts", "check-soak-trend.mjs");
const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")) as { scripts: Record<string, string> };

const PHASES = ["busy", "trickle", "quiet"] as const;
type Phase = (typeof PHASES)[number];

/** A run's reloads in the order a soak performs them, as [phase, durationMs] pairs. */
function orderedRun(durations: Record<Phase, number[]>): [Phase, number][] {
  const out: [Phase, number][] = [];
  for (let round = 0; round < 4; round += 1) for (const phase of PHASES) out.push([phase, durations[phase][round]]);
  return out;
}

/** Twelve reloads, four of each phase, every reload the same cost. */
const STEADY = orderedRun({ busy: [10_000, 10_100, 9_900, 10_200], trickle: [10_100, 10_050, 10_200, 10_100], quiet: [10_000, 10_050, 10_100, 10_000] });

type SummaryOptions = {
  at: string;
  verdict?: string;
  platform?: string;
  arch?: string;
  node?: string;
  run?: [Phase, number][];
  floors?: Record<string, { first: number; second: number }>;
  outcomes?: (string | null)[] | null;
  problems?: string[];
  /**
   * The reload's held connection, per reload. The default is the ordinary shape — a
   * connection held through the door, answered nothing, ended with the run it was
   * piped to — and returning `undefined` writes NO `held` key at all, which is what a
   * record written before the field existed looks like.
   */
  held?: (reload: { index: number; phase: Phase; retiredPort: number }) => Record<string, any> | undefined;
};

/** The ordinary hold: piped to the run behind the door, unanswered, ended with it. */
const ordinaryHeld = (): Record<string, any> => ({
  // Which shape the block is, which is what the reader reads its answers from — see the
  // "reads answers only from a block that names the shape it knows" case below.
  shape: HELD_SHAPE,
  accepted: true,
  // Each answer is one object with its own status and instant (`length` is the count), so
  // the block has nothing to keep in step with itself.
  answered: [],
  answeredBeforeSwap: false,
  endedAt: "2026-10-01T00:00:05.000Z",
  endedReason: "closed",
  endedBeforeSwap: false,
  endedBeforeCount: false,
  runGaveUp: false,
  afterStop: "!closed",
  leftoverConnections: 3,
});

/**
 * A soak summary, from the two things the trend reads: how long each reload took
 * (authored as a duration and turned into the startedAt/landedAt pair the soak really
 * emits, so the projection's arithmetic is what is exercised) and the floor each
 * phase read.
 */
function summaryOf({
  at,
  verdict = "PASS",
  platform = "linux",
  arch = "x64",
  node = "22",
  run = STEADY,
  floors = {
    busy: { first: 280, second: 281 },
    trickle: { first: 280, second: 281 },
    quiet: { first: 280, second: 281 },
  },
  outcomes = null,
  problems = [],
  held = () => ordinaryHeld(),
}: SummaryOptions) {
  let clock = Date.parse(at);
  const reloadsDetail = run.map(([phase, ms], index) => {
    const startedAt = new Date(clock).toISOString();
    clock += ms;
    return {
      index: index + 1,
      phase,
      // A null in the list is a reload the supervisor recorded nothing for: the test
      // helper must not fill it in, or the projection's "no outcome" path is untested.
      outcome: outcomes === null ? "replaced" : outcomes[index] ?? null,
      closedBy: "clock",
      windowUsedMs: 6000,
      replacementPort: 5000 + index,
      retiredPort: 4000 + index,
      retiredPortFree: true,
      descendants: 1,
      handles: 300,
      startedAt,
      landedAt: new Date(clock).toISOString(),
      swappedAt: startedAt,
      served: 0,
      checks: 6,
      held: held({ index: index + 1, phase, retiredPort: 4000 + index }),
    };
  });
  const byPhase: Record<string, number> = {};
  for (const reload of reloadsDetail) byPhase[reload.phase] = (byPhase[reload.phase] ?? 0) + 1;
  return {
    verdict,
    at,
    profile: { platform, arch, node },
    reloads: reloadsDetail.length,
    performed: reloadsDetail.length,
    phases: reloadsDetail.map((reload) => reload.phase),
    byPhase,
    closedBy: { clock: reloadsDetail.length },
    records: reloadsDetail.length,
    outcomes: [...new Set(reloadsDetail.map((reload) => reload.outcome))],
    frontPort: 1234,
    history: "/tmp/reloads.jsonl",
    requests: 40,
    answers: 40,
    byStatus: { 200: 40 },
    timeouts: 0,
    connectionErrors: 0,
    swapsAtTheDoor: reloadsDetail.map((reload) => ({ index: reload.index, phase: reload.phase, at: Date.parse(reload.swappedAt), band: 0, inFlight: 0, lost: 0 })),
    swapsWithAClient: 0,
    clientsInFlight: 0,
    descriptors: null,
    floors,
    reloadsDetail,
    notes: [],
    problems,
  };
}

/** The record a real run would append for that summary. */
const recordOf = (options: SummaryOptions) => trendRecord(summaryOf(options));

/** Four runs a day apart: the newest is the one judged, the rest are its baseline. */
const day = (n: number) => `2026-10-0${n}T00:00:00.000Z`;

function trendFile(records: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "anybase-trend-test-"));
  const path = join(dir, "soak-trend.jsonl");
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return path;
}

const run = (args: string[]) =>
  spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", SCRIPT, ...args], {
    cwd: HERE,
    encoding: "utf8",
  });

describe("the record the soak leaves for the next run", () => {
  it("groups each reload's own cell by phase, in order, and counts how the reloads ended", () => {
    const record = recordOf({
      at: day(1),
      run: orderedRun({ busy: [10_000, 11_000, 12_000, 13_000], trickle: [20_000, 20_500, 21_000, 21_500], quiet: [30_000, 30_000, 30_000, 30_000] }),
      outcomes: ["replaced", "replaced", "stopped", null, ...Array(8).fill("replaced")],
    });

    expect(record.schema).toBe(SOAK_TREND_SCHEMA);
    // The reload's cell is asked → landed, which is the whole reload rather than one
    // leg of it: a boot that got slower, a window that got longer, a stop that hung.
    expect(record.durations.busy).toEqual([10_000, 11_000, 12_000, 13_000]);
    expect(record.durations.trickle).toEqual([20_000, 20_500, 21_000, 21_500]);
    expect(record.durations.quiet).toEqual([30_000, 30_000, 30_000, 30_000]);
    expect(record.outcomes).toEqual({ replaced: 10, stopped: 1 });
    expect(record.windows.busy).toEqual([6000, 6000, 6000, 6000]);
    // The profile travels with the numbers: two runs from different machines are not
    // two measurements of one thing, and nothing else in the record remembers where
    // it was read.
    expect(record.profile).toEqual({ platform: "linux", arch: "x64", node: "22" });
    expect(record.reloads).toMatchObject({ asked: 12, performed: 12, records: 12 });
    expect(record.door).toMatchObject({ requests: 40, answers: 40, timeouts: 0, lost: 0 });
  });

  it("contributes nothing for a reload that left no record, rather than a zero", () => {
    // A reload whose record never landed is a reload that did not happen, and a 0 in
    // its place would read as the fastest reload in the run.
    const summary = summaryOf({ at: day(1) });
    (summary.reloadsDetail[2] as { landedAt: string | null }).landedAt = null;
    const record = trendRecord(summary);

    expect(record.durations.quiet).toHaveLength(3);
    expect(record.durations.busy).toHaveLength(4);
    expect(record.durations.quiet).not.toContain(0);
  });

  it("is judgeable from ONE run: the slow-down within it needs no history at all", () => {
    const record = recordOf({ at: day(1) });
    const judgment = judgeSoakTrend([record]);

    expect(judgment.latest).toBe(record);
    expect(judgment.compared).toBe(0);
    expect(judgment.judged).toHaveLength(3);
    expect(judgment.skipped.join("\n")).toMatch(/across runs \(0 earlier linux\/x64\/22 run\(s\)\): 3 are needed/);
  });
});

describe("what a red run's line says about the connections it held", () => {
  it("carries each reload's hold under its own identity, in reload order", () => {
    const record = recordOf({ at: day(1) });

    expect(record.held).toHaveLength(12);
    expect(record.held.map((entry: { index: number }) => entry.index)).toEqual([...Array(12)].map((_, index) => index + 1));
    // The facts a door claim is judged on, straight from the summary's own block, with
    // the reload's identity and the port of the run the door's count was taken on: a
    // claim names ONE reload, so this is the entry it is read against.
    expect(record.held[0]).toMatchObject({
      index: 1,
      phase: "busy",
      retiredPort: 4000,
      // The block's own marker travels with it, so the trend line can be read without the
      // summary the run wrote beside it.
      shape: HELD_SHAPE,
      accepted: true,
      answered: [],
      endedBeforeCount: false,
      runGaveUp: false,
      afterStop: "!closed",
      leftoverConnections: 3,
    });
    expect(record.held[2]).toMatchObject({ index: 3, phase: "quiet", retiredPort: 4002 });
  });

  it("contributes nothing for a record written before the field existed, rather than a hold with no facts", () => {
    const record = recordOf({ at: day(1), held: () => undefined });
    expect(record.held).toEqual([]);
    // ...and the reader says that rather than nothing: "no held facts" and "nothing odd
    // in the held facts" are different answers to the same question.
    expect(heldNotes(record.held).join("\n")).toMatch(/carries no per-reload held-connection facts/);
    expect(heldNotes(undefined).join("\n")).toMatch(/carries no per-reload held-connection facts/);
  });

  it("names the reloads whose hold is not the ordinary shape, and only those", () => {
    const ordinary = ordinaryHeld();
    const lines = heldNotes([
      { index: 1, phase: "busy", retiredPort: 5001, ...ordinary },
      { index: 2, phase: "trickle", retiredPort: 5002, ...ordinary, accepted: false, endedReason: "ECONNREFUSED" },
      { index: 3, phase: "busy", retiredPort: 5003, ...ordinary, leftoverConnections: 0 },
      { index: 4, phase: "busy", retiredPort: 5004, ...ordinary, answered: [{ status: 503, at: "2026-10-01T00:00:04.000Z" }], answeredBeforeSwap: true },
      { index: 5, phase: "quiet", retiredPort: 5005, ...ordinary, runGaveUp: true, endedBeforeCount: true },
      { index: 6, phase: "quiet", retiredPort: 5006, ...ordinary, afterStop: "200" },
      { index: 7, phase: "busy", retiredPort: 5007, ...ordinary, endedBeforeSwap: true },
      // The door's own retry for a connection whose run has gone, at or after the swap:
      // an answer, and the ordinary discharge — real soaks say it to every hold, so a
      // reader that named it would bury the one answer that IS a finding.
      { index: 8, phase: "busy", retiredPort: 5008, ...ordinary, answered: [{ status: 503, at: "2026-10-01T00:00:05.000Z" }] },
      // ...where an answer that is NOT that (and not the run's own 408) is named.
      { index: 9, phase: "busy", retiredPort: 5009, ...ordinary, answered: [{ status: 200, at: "2026-10-01T00:00:05.000Z" }] },
    ]);

    // The shape first, so a red run whose holds are all ordinary says so in one line —
    // which is itself a diagnosis: the problem is then not the connection the soak held.
    expect(lines[0]).toBe(
      "held connections: 9 reload(s), 8 accepted, 2 answered where nothing may answer, 1 given up on by the run, " +
        "1 ended before the door's count, 1 with the door's count below the connection on it",
    );
    expect(lines).toHaveLength(8);
    expect(lines[1]).toBe(
      "held reload 2 (trickle), on the run it had in port 5002: no connection could be held through the door across the swap (ECONNREFUSED)",
    );
    // The count claim, read the way the verdict reads it: the count is evidence because
    // the connection was still open at that instant, and zero there is the finding.
    expect(lines[2]).toBe(
      "held reload 3 (busy), on the run it had in port 5003: was still open when the door took its count, which reported 0 connection(s) on the run it retired",
    );
    expect(lines[3]).toBe("held reload 4 (busy), on the run it had in port 5004: was answered 503 while the run it was piped to was serving");
    expect(lines[4]).toBe(
      "held reload 5 (quiet), on the run it had in port 5005: was ended by the run it was piped to, which answered 408 for a request this connection never finished; " +
        "ended before the door took its count",
    );
    expect(lines[5]).toBe(
      "held reload 6 (quiet), on the run it had in port 5006: was answered 200 after the run it was piped to had been stopped",
    );
    expect(lines[6]).toBe("held reload 7 (busy), on the run it had in port 5007: ended before the port changed hands");
    // Reload 8's 503 is the ordinary discharge and gets no line of its own:
    expect(lines.join("\n")).not.toMatch(/reload 8 \(/);
    expect(lines[7]).toBe(
      "held reload 9 (busy), on the run it had in port 5009: was answered 200 after the port had changed hands",
    );

    // Every reload ordinary: the shape line and nothing else.
    const all = heldNotes([{ index: 1, phase: "busy", retiredPort: 5001, ...ordinary }]);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatch(/^held connections: 1 reload\(s\), 1 accepted, 0 answered where nothing may answer/);
    // An empty list is the absent field's other spelling, and answers the same way.
    expect(heldNotes([])).toEqual(heldNotes(undefined));
  });

  it("reads answers only from a block that names the shape it knows", () => {
    // The block STATES its shape, and that marker — not the presence of an `answered`
    // field — is what tells this reader the answers below are answers it can read. The
    // same `answered` list in a block that does not name it is not an answer here, and
    // reading it as one would be inferring a shape from fields that happen to be there.
    const answer = [{ status: 200, at: "2026-10-01T00:00:05.000Z" }];
    const lines = heldNotes([
      { index: 1, phase: "busy", retiredPort: 6001, ...ordinaryHeld(), answered: answer, answeredBeforeSwap: true },
      { index: 2, phase: "busy", retiredPort: 6002, ...ordinaryHeld(), shape: "anybase-held/1", answered: answer },
      { index: 3, phase: "busy", retiredPort: 6003, ...ordinaryHeld(), shape: undefined, answered: answer },
    ]);

    // Reload 1's answer is the only one named, and the count says so too: the other two
    // blocks are in shapes this reader does not read, so nothing is claimed about them.
    expect(lines.filter((line) => line.includes("was answered"))).toEqual([
      "held reload 1 (busy), on the run it had in port 6001: was answered 200 while the run it was piped to was serving",
    ]);
    expect(lines[0]).toMatch(/^held connections: 3 reload\(s\), 3 accepted, 1 answered where nothing may answer/);
  });

  it("is named on the NOT-JUDGED lines of a run that did not pass, so the claim is diagnosable from the line", () => {
    const tailed = recordOf({
      at: day(4),
      verdict: "FAIL",
      problems: [
        "reload 3 (busy): the door reported 0 connection(s) still on the run it retired, while a client was holding one that had been piped to it",
      ],
      held: (reload) => (reload.index === 3 ? { ...ordinaryHeld(), leftoverConnections: 0 } : ordinaryHeld()),
    });
    const judgment = judgeSoakTrend([tailed]);

    // The run is judged by nothing here — but what it held across its swaps is said,
    // because that is what somebody reading the red line has to diagnose from.
    expect(judgment.problems).toEqual([]);
    expect(judgment.skipped.join("\n")).toMatch(/the newest run did not pass/);
    const notes = judgment.notes.join("\n");
    expect(notes).toMatch(/the newest record is a FAIL run: reload 3 \(busy\)/);
    // The claim is reload 3, and the line names the reload the run's own schedule
    // made reload 3 — its port, and the count it was judged against.
    expect(notes).toMatch(
      /held reload 3 \(quiet\), on the run it had in port 4002: was still open when the door took its count, which reported 0 connection\(s\) on the run it retired/,
    );

    // And through the process, because the lines are what the CI log shows when the
    // soak goes red and this step is the one that fails.
    const result = run([trendFile([tailed])]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("SOAK_TREND=NOT_JUDGED");
    expect(result.stdout).toMatch(/note +held reload 3 \(quiet\)/);
  });
});

describe("what the trend calls a regression", () => {
  const steady = [day(1), day(2), day(3)].map((at) => recordOf({ at }));

  it("a phase that costs more as the soak goes on, from the run's own reloads", () => {
    // Nothing has leaked and nothing has been compared yet: this is the leak's first
    // symptom, and it is visible in a single run.
    const slow = recordOf({
      at: day(1),
      run: orderedRun({ busy: [10_000, 10_100, 14_000, 14_800], trickle: [10_100, 10_050, 10_200, 10_100], quiet: [10_000, 10_050, 10_100, 10_000] }),
    });
    const judgment = judgeSoakTrend([slow]);

    expect(judgment.judged).toContain("in-run busy 10050ms→14400ms");
    expect(judgment.problems.join("\n")).toMatch(/the busy phase's reloads cost more as the soak went on/);
    expect(judgment.problems.join("\n")).toMatch(/series: 10000, 10100, 14000, 14800/);
    // The other phases are compared with themselves and are fine, so a phase that is
    // merely different from its neighbour is never the finding.
    expect(judgment.problems).toHaveLength(1);
  });

  it("a rise inside the budget is NOT one — the gate fires on regressions, not on noise", () => {
    // 5% on a reload, which is the shape of ordinary jitter here (three real runs of
    // one build differed by about 5% end to end). A gate that called this would be
    // turned off within a week, and then it would not be there for the real one.
    const drift = recordOf({
      at: day(1),
      run: orderedRun({ busy: [10_000, 10_100, 10_400, 10_600], trickle: [10_100, 10_050, 10_200, 10_100], quiet: [10_000, 10_050, 10_100, 10_000] }),
    });
    expect(judgeSoakTrend([drift]).problems).toEqual([]);
  });

  it("a phase slower than the runs before it, once there are three to compare with", () => {
    const slower = recordOf({
      at: day(4),
      run: orderedRun({ busy: [20_000, 20_100, 19_900, 20_200], trickle: [10_100, 10_050, 10_200, 10_100], quiet: [10_000, 10_050, 10_100, 10_000] }),
    });
    const judgment = judgeSoakTrend([...steady, slower]);

    expect(judgment.compared).toBe(3);
    expect(judgment.judged).toContain("across-runs busy 10050ms→20050ms");
    expect(judgment.problems.join("\n")).toMatch(/the busy phase is slower than the 3 passing run\(s\) before it/);
    // A flat phase across runs is judged and is not a finding: the comparison has to
    // be able to pass as well as to fail.
    expect(judgment.judged).toContain("across-runs quiet 10025ms→10025ms");
  });

  it("the run's cost as one number, so a boot that got slower anywhere shows up", () => {
    const slower = recordOf({
      at: day(4),
      run: orderedRun({ busy: [16_000, 16_100, 15_900, 16_200], trickle: [16_100, 16_050, 16_200, 16_100], quiet: [16_000, 16_050, 16_100, 16_000] }),
    });
    const judgment = judgeSoakTrend([...steady, slower]);

    expect(judgment.judged.join("\n")).toMatch(/across-runs total 120800ms→192800ms/);
    expect(judgment.problems.join("\n")).toMatch(/the run cost more than the 3 passing run\(s\) before it/);
  });

  it("a floor that rose across runs, where the reading is a measurement rather than a sample", () => {
    const risen = recordOf({
      at: day(4),
      floors: { busy: { first: 282, second: 292 }, trickle: { first: 280, second: 281 }, quiet: { first: 280, second: 281 } },
    });
    const judgment = judgeSoakTrend([...steady, risen]);

    expect(liveReading(risen.profile)).toBe(true);
    expect(judgment.problems.join("\n")).toMatch(/the busy phase's descriptor floor rose across runs, from 281 to 292/);
  });

  it("refuses the floor across runs on a platform whose reading is sampled, by name", () => {
    // The same rise as the case above, on a profile whose count is sampled rather
    // than live. Windows is the platform whose noise was measured at up to 15 handles
    // under load: judging a floor there would be judging the instrument.
    const windows = [day(1), day(2), day(3)].map((at) =>
      recordOf({
        at,
        platform: "win32",
        floors: { busy: { first: 288, second: 289 }, trickle: { first: 288, second: 289 }, quiet: { first: 288, second: 289 } },
      }),
    );
    const risen = recordOf({
      at: day(4),
      platform: "win32",
      floors: { busy: { first: 302, second: 302 }, trickle: { first: 302, second: 302 }, quiet: { first: 302, second: 302 } },
    });
    const judgment = judgeSoakTrend([...windows, risen]);

    expect(liveReading(risen.profile)).toBe(false);
    expect(judgment.problems).toEqual([]);
    expect(judgment.skipped.join("\n")).toMatch(/descriptor floors \(this profile's reading is sampled, not live\)/);
    // Its timings are still judged: only the floor half is refused.
    expect(judgment.judged).toContain("across-runs total 120800ms→120800ms");
  });

  it("refuses to judge reloads that did not land, and does not base on them either", () => {
    const broken = recordOf({
      at: day(4),
      outcomes: ["replaced", "replaced", "rolled-back", ...Array(9).fill("replaced")],
    });
    const judgment = judgeSoakTrend([...steady, broken]);
    expect(judgment.problems.join("\n")).toMatch(/the newest run's reloads did not all land: rolled-back ×1/);

    // And an earlier run that did not pass is not a baseline: a run that leaked must
    // not become what normal looks like.
    const failed = [...steady.slice(0, 2), recordOf({ at: day(3), verdict: "FAIL", problems: ["the quiet phase's lowest descriptor count rose"] })];
    const judged = judgeSoakTrend([...failed, recordOf({ at: day(4) })]);
    expect(judged.compared).toBe(2);
    expect(judged.notes.join("\n")).toMatch(/1 earlier record\(s\) are not a baseline/);
    expect(judged.skipped.join("\n")).toMatch(/across runs \(2 earlier linux\/x64\/22 run\(s\)\): 3 are needed/);
  });

  it("records a run that did not pass and judges nothing about it — not even itself", () => {
    // The reason is measured rather than tidy: a run that failed is usually a run that
    // STOPPED, and a stopped run's numbers read as a fast one's. The soak disturbed by
    // a second soak in its own `--dir` performed 12 reloads, four of them with no
    // usable clock, and came out 48080ms against three passing runs' 73558ms — a 35%
    // "speed-up" a total-cost check would have called fine.
    const failed = recordOf({
      at: day(4),
      verdict: "FAIL",
      problems: ["reload 1 (busy): a connection accepted before the swap was answered 200 after the run it was piped to had been stopped"],
    });
    const judgment = judgeSoakTrend([...steady, failed]);

    expect(judgment.judged).toEqual([]);
    expect(judgment.compared).toBe(0);
    expect(judgment.problems).toEqual([]);
    expect(judgment.notes.join("\n")).toMatch(/the newest record is a FAIL run: reload 1 \(busy\)/);
    expect(judgment.skipped.join("\n")).toMatch(/the newest run did not pass, so there is no trend to read from it/);
    // And through the process: nothing judged is exit 2, never a PASS.
    expect(main([trendFile([...steady, failed])], { out: () => {}, err: () => {} })).toBe(2);
  });

  it("keeps another machine's runs out of the comparison, and says which profile it compared", () => {
    const elsewhere = recordOf({ at: day(4), platform: "darwin", run: orderedRun({ busy: [50_000, 50_000, 50_000, 50_000], trickle: [50_000, 50_000, 50_000, 50_000], quiet: [50_000, 50_000, 50_000, 50_000] }) });
    const judgment = judgeSoakTrend([...steady, elsewhere, recordOf({ at: `2026-10-05T00:00:00.000Z` })]);

    expect(judgment.compared).toBe(3);
    expect(judgment.notes.join("\n")).toMatch(/not a baseline/);
    expect(judgment.problems).toEqual([]);
  });

  it("reports an outcome this reader does not know instead of judging it away", () => {
    const newer = recordOf({ at: day(4), outcomes: ["replaced", "replaced", "teleported", ...Array(9).fill("replaced")] });
    const judgment = judgeSoakTrend([...steady, newer]);

    expect(judgment.notes.join("\n")).toMatch(/outcome\(s\) this reader does not know \(teleported\)/);
    expect(judgment.problems).toEqual([]);
  });

  it("reads only records in its own schema, and refuses a file with none", () => {
    const stray = { ...recordOf({ at: day(1) }), schema: "anybase-soak-trend/9" };
    const judgment = judgeSoakTrend([stray, { nope: true }]);

    expect(judgment.latest).toBeNull();
    expect(judgment.skipped).toEqual([`no record in ${SOAK_TREND_SCHEMA} to judge`]);
    expect(main([trendFile([stray])], { out: () => {}, err: () => {} })).toBe(2);
  });
});

describe("the numbers it calls a regression by", () => {
  it("takes the halves rule and the floor slack from the soak's own, not a second copy", () => {
    // The floor is the same instrument within a run and across runs, so what counts
    // as a rise cannot be two numbers: `handleTrendProblems` uses 4 readings a phase
    // and a slack of 8, and this reader must agree with it.
    expect(DEFAULTS.minReadings).toBe(4);
    expect(DEFAULTS.floorSlack).toBe(SOAK_DEFAULTS.handleSlack);
    // and three earlier runs, because a median of two is a coin toss.
    expect(DEFAULTS.minBaseline).toBe(3);
  });

  it("medians a list, and says nothing about an empty one", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(3); // the two middles, averaged
    expect(median([])).toBeNull();
    expect(median([Number.NaN, 5])).toBe(5);
  });
});

describe("the command line, through the process", () => {
  it("prints its usage and exits 0 for --help", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: node scripts/check-soak-trend.mjs");
    expect(result.stdout).toContain("SOAK_TREND");
  });

  it("exits 2 for a usage error, which is not a verdict about a trend", () => {
    expect(run([]).status).toBe(2);
    expect(run(["--nope", "x.jsonl"]).status).toBe(2);
    expect(run(["--profile"]).status).toBe(2);
    expect(run(["/tmp/definitely-not-a-trend.jsonl"]).status).toBe(2);
  });

  it("exits 1 for a run that got slower and 0 for one that did not", () => {
    const slow = run([trendFile([...steadyRecords(), recordOf({
      at: day(4),
      run: orderedRun({ busy: [10_000, 10_100, 14_000, 14_800], trickle: [10_100, 10_050, 10_200, 10_100], quiet: [10_000, 10_050, 10_100, 10_000] }),
    })])]);
    expect(slow.status).toBe(1);
    expect(slow.stdout).toContain("SOAK_TREND=REGRESSED");
    expect(slow.stdout).toMatch(/problem  the busy phase's reloads cost more as the soak went on/);

    const steady = run([trendFile(steadyRecords())]);
    expect(steady.status).toBe(0);
    expect(steady.stdout).toContain("SOAK_TREND=PASS");
  });

  it("puts the judgment on stdout alone with --json, and the prose on stderr", () => {
    const file = trendFile([...steadyRecords(), recordOf({ at: day(4) })]);
    const result = run([file, "--json"]);

    const judgment = JSON.parse(result.stdout.trim()) as Record<string, any>;
    expect(judgment.verdict).toBe("PASS");
    expect(judgment.records).toBe(4);
    expect(judgment.compared).toBe(3);
    expect(judgment.judged).toContain("across-runs quiet 10025ms→10025ms");
    // The prose still went somewhere: a person reading a CI log sees why.
    expect(result.stderr).toContain("SOAK_TREND=PASS");
  });

  it("says NOT_JUDGED rather than PASS when the newest run did not pass", () => {
    const file = trendFile([...steadyRecords(), recordOf({ at: day(4), verdict: "FAIL", problems: ["something leaked"] })]);
    const result = run([file, "--json"]);

    expect(result.status).toBe(2);
    const judgment = JSON.parse(result.stdout.trim()) as Record<string, any>;
    expect(judgment.verdict).toBe("NOT_JUDGED");
    expect(judgment.judged).toEqual([]);
    expect(judgment.skipped.join("\n")).toMatch(/no trend to read from it/);
  });

  it("refuses a line it cannot read, naming the file and the line", () => {
    const dir = mkdtempSync(join(tmpdir(), "anybase-trend-bad-"));
    const path = join(dir, "soak-trend.jsonl");
    writeFileSync(path, `${JSON.stringify(recordOf({ at: day(1) }))}\nnot json\n`);
    const result = run([path]);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/line 2 is not JSON/);
  });

  it("is runnable as `npm run check:soak-trend`", () => {
    expect(pkg.scripts["check:soak-trend"]).toBe(
      "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/check-soak-trend.mjs",
    );
  });

  it("names every exit code in its usage, including the one for refusing to judge", () => {
    expect(USAGE).toMatch(/2 {2}it could not be judged/);
    expect(USAGE).toContain("SOAK_TREND");
  });

  it("parses what it accepts and refuses the rest", () => {
    expect(parseArgs(["a.jsonl", "b.jsonl", "--json"])).toMatchObject({ paths: ["a.jsonl", "b.jsonl"], json: true });
    expect(parseArgs(["--profile", "linux/x64/22"]).profile).toBe("linux/x64/22");
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(() => parseArgs(["--profile"])).toThrow(/--profile needs a value/);
    expect(() => parseArgs(["-x"])).toThrow(/unknown option/);
    expect(profileKey({ platform: "linux", arch: "x64", node: "22" })).toBe("linux/x64/22");
    expect(profileKey(null)).toBeNull();
  });
});

function steadyRecords() {
  return [day(1), day(2), day(3)].map((at) => recordOf({ at }));
}
