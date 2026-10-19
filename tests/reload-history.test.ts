/**
 * Pins for src/lib/deploy/reload-history.ts — the ONE declaration of what a
 * `PROD_RELOAD_HISTORY` line means, and the reader every surface uses.
 *
 * Three things read that file (the deploy gate, the settings route, the settings
 * panel), and the failure this file guards is the one this repo has already
 * shipped three times by hand-restating a gate: one surface calling a rollback fine
 * while another refuses it. So the vocabulary is not only tested, it is tested to
 * be the ONLY copy — the gate, the route and the panel are scanned for a second
 * declaration of an outcome's verdict, and the vocabulary is compared against the
 * verdict blocks in the supervisor that writes the records.
 *
 * The other load-bearing pin here is the strict/lenient split, which is one
 * argument: the gate passes the writer's schema constant and refuses a line that
 * carries a different one, the page passes nothing and keeps the line (naming an
 * outcome it does not know verbatim is useful on a page and dangerous in a gate).
 * The fixtures are built by `reloadRecord`, the WRITER, so the reader is pinned
 * against the shape that is actually written rather than a literal from a log.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  OUTCOME_VERDICT,
  RELOAD_HISTORY_VIEW_LIMIT,
  describeReload,
  parseReloadHistory,
  reloadEvidence,
  verdictFor,
} from "../src/lib/deploy/reload-history";
import { RELOAD_HISTORY_SCHEMA, reloadRecord } from "../scripts/supervise.mjs";

const HERE = process.cwd();
const read = (rel: string) => readFileSync(join(HERE, rel), "utf8");

const AT = Date.parse("2026-10-14T12:00:00.000Z");

type Outcome = "replaced" | "stopped" | "kept" | "rolled-back" | "no-fallback";

const recordFor = (outcome: Outcome, overrides: Record<string, unknown> = {}) =>
  reloadRecord({
    asked: "/srv/.reload",
    outcome,
    closedBy: outcome === "kept" ? null : "traffic",
    detail: outcome === "replaced" ? null : `${outcome} happened`,
    startedAt: AT - 2_500,
    at: AT,
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

describe("the vocabulary: one declaration, and it is the writer's", () => {
  it("knows every outcome the supervisor can write, and no outcome it cannot", () => {
    // Read out of the supervisor's own source rather than listed again here: a
    // sixth outcome is a record a pipeline would branch on, and a reader that
    // does not know it must fail loudly instead of quietly passing.
    //
    // The pair is what identifies a reload verdict — an `outcome` with a
    // `closedBy` under it — because the front door keeps an outcome vocabulary of
    // its own (`healthy`, `proven`, `stopping`, the health-check window's), and
    // that one is not what a history line carries.
    const written = [...read("scripts/supervise.mjs").matchAll(/outcome: "([^"]+)",\n\s*closedBy\b/g)].map(
      (m) => m[1],
    );
    expect(written).toHaveLength(7);
    expect([...new Set(written)].sort()).toEqual(Object.keys(OUTCOME_VERDICT).sort());
  });

  it("lands `replaced` and `stopped`, and fails the three that did not land", () => {
    expect(verdictFor("replaced")).toMatchObject({ landed: true, word: "REPLACED" });
    // A shutdown ended the reload with the replacement already in place: reporting
    // a reload that happened as one that did not would be the gate's own false
    // alarm, so it passes and is printed with its detail rather than hidden.
    expect(verdictFor("stopped")).toMatchObject({ landed: true, word: "STOPPED" });
    expect(verdictFor("rolled-back")).toMatchObject({ landed: false, word: "ROLLED BACK" });
    expect(verdictFor("kept")).toMatchObject({ landed: false, word: "NOTHING CHANGED" });
    // Not a rollback and not a no-op: a deploy that landed broken, which is the
    // worst of the three to hand a pipeline as green.
    expect(verdictFor("no-fallback")).toMatchObject({ landed: false, word: "LANDED BROKEN" });
  });

  it("answers null — not a guess — for an outcome it has never heard of", () => {
    expect(verdictFor("teleported")).toBeNull();
    expect(verdictFor(undefined)).toBeNull();
    expect(verdictFor(null)).toBeNull();
  });

  it("is declared here and nowhere else, by the script, the route and the panel", () => {
    // Every reader takes the verdict from this module. A second copy is how the
    // page ends up colouring a rollback green while the gate fails a deploy.
    const readers = [
      "scripts/check-reload-history.mjs",
      "src/app/api/deploy/reloads/route.ts",
      "src/components/reload-history-section.tsx",
    ];
    for (const rel of readers) {
      const source = read(rel);
      expect(source, `${rel} must take the vocabulary from the shared module`).toMatch(
        /from ["'](?:\.\.\/)*src\/lib\/deploy\/reload-history(?:\.ts)?["']|from "@\/lib\/deploy\/reload-history"/,
      );
      expect(source, `${rel} must not declare the vocabulary again`).not.toMatch(
        /OUTCOME_VERDICT\s*[:=]\s*\{/,
      );
      expect(source, `${rel} must not restate an outcome's words`).not.toMatch(
        /word:\s*"[A-Z]/,
      );
    }
    // ...and the gate really is one of them, rather than a stale copy of a copy.
    expect(read("scripts/check-reload-history.mjs")).toMatch(/OUTCOME_VERDICT/);
    expect(read("src/components/reload-history-section.tsx")).toMatch(/verdict\.word|\.word/);
  });
});

describe("reading a history", () => {
  it("keeps each line's own object, with this reader's notes beside it", () => {
    const first = recordFor("replaced");
    const second = recordFor("rolled-back");
    const { records, unreadable } = parseReloadHistory(`${jsonl(first, second)}\n`);

    expect(unreadable).toEqual([]);
    expect(records.map((entry) => entry.line)).toEqual([1, 2]);
    expect(records[0].atMs).toBe(AT);
    // The record is the line, unchanged — the shape `--json` writes back out, so
    // the reader's own bookkeeping must not ride along inside it.
    expect(records[0].record).toEqual(first);
    expect("atMs" in records[0].record).toBe(false);
    expect(records[1].record).toEqual(second);
    // Each entry carries the verdict of its own outcome.
    expect(records[1].verdict).toMatchObject({ landed: false, word: "ROLLED BACK" });
  });

  it("names every line it cannot read, rather than skipping it", () => {
    const text = [
      jsonl(recordFor("replaced")).trim(),
      "not json at all",
      '["an array, not a record"]',
      JSON.stringify({ ...recordFor("replaced"), outcome: undefined }),
      JSON.stringify({ ...recordFor("replaced"), at: "whenever" }),
      "",
    ].join("\n");

    const { records, unreadable } = parseReloadHistory(text);
    expect(records).toHaveLength(1);
    expect(unreadable).toEqual([
      { line: 2, reason: "not JSON" },
      { line: 3, reason: "not a record object" },
      { line: 4, reason: "no outcome" },
      { line: 5, reason: 'no readable at: "whenever"' },
    ]);
    // A file with an empty line at the end is a file, not a finding.
    expect(parseReloadHistory("\n\n")).toEqual({ records: [], unreadable: [] });
  });

  it("keeps a record from a newer schema unless it is asked to refuse one", () => {
    // The whole of the strict/lenient split, and it is the gate that is strict:
    // it passes the writer's schema and refuses a line it cannot place, because a
    // gate that cannot read its evidence does not pass. The page passes nothing
    // and keeps the line, naming an outcome it does not know verbatim instead of
    // pretending it understands it.
    const newer = jsonl({ ...recordFor("replaced"), schema: "base88.reload/2" });

    const lenient = parseReloadHistory(newer);
    expect(lenient.records).toHaveLength(1);
    expect(lenient.unreadable).toEqual([]);
    expect(lenient.records[0].record.schema).toBe("base88.reload/2");

    const strict = parseReloadHistory(newer, { schema: RELOAD_HISTORY_SCHEMA });
    expect(strict.records).toEqual([]);
    expect(strict.unreadable).toEqual([
      { line: 1, reason: `schema "base88.reload/2" is not ${RELOAD_HISTORY_SCHEMA}` },
    ]);
    // A record written by the writer we know passes the strict read.
    expect(
      parseReloadHistory(jsonl(recordFor("replaced")), { schema: RELOAD_HISTORY_SCHEMA }).unreadable,
    ).toEqual([]);
  });
});

describe("describing a record", () => {
  it("says a window that never opened in words, not as a zero", () => {
    const evidence = reloadEvidence(recordFor("kept"));
    expect(evidence).toContain("no window was ever open");
    expect(evidence).not.toContain("window 0ms");
    // Nothing was swapped in, so there is nothing to have measured.
    expect(recordFor("kept").windowUsedMs).toBeNull();
  });

  it("carries the window, what closed it, and what the app and checks did", () => {
    expect(reloadEvidence(recordFor("replaced"))).toBe(
      "asked by /srv/.reload at 2026-10-14T11:59:57.500Z; window 2000ms of 30000ms, closed by traffic; " +
        "64 real connection(s) from the app, 2 health check(s)",
    );
  });

  it("names the outcome, why it matters, and the reason it happened", () => {
    const line = describeReload(recordFor("rolled-back"), verdictFor("rolled-back")!);
    expect(line).toContain("2026-10-14T12:00:00.000Z ROLLED BACK — ");
    expect(line).toContain("the port went back to the run it replaced");
    expect(line).toContain("closed by traffic");
    expect(line).toContain(": rolled-back happened");
    // A landed reload has no detail to add, and gets no dangling colon.
    expect(describeReload(recordFor("replaced"), verdictFor("replaced")!)).not.toContain("):");
  });

  it("shows ten reloads, which is a deploy's history rather than an archive", () => {
    expect(RELOAD_HISTORY_VIEW_LIMIT).toBe(10);
  });
});
