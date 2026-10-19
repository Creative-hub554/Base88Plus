/**
 * Pins for GET /api/deploy/reloads — the read behind the settings page's reload
 * panel, run as the REAL route handler (Next routes export plain functions).
 *
 * What is pinned, and why each one matters to an operator:
 *   • no history configured is an empty view, not a 500 — the panel says "not
 *     configured" and the rest of the page is untouched;
 *   • the newest reloads come first, by their own `at`, with the verdict the
 *     deploy gate uses attached to each one;
 *   • the list is capped and still reports the total, so ten of thirty is said
 *     rather than implied;
 *   • a file that is missing and a file that cannot be read are DIFFERENT
 *     answers (`missing` / `unreadable`), because they need different actions;
 *   • a line the reader cannot use is reported by line and reason, and the lines
 *     it CAN read are still shown;
 *   • the response carries no raw file text and no credential — a reason, never a
 *     quote.
 *
 * `PROD_RELOAD_HISTORY` is the only input, so each case points it at a temp path
 * (or at a directory, which is how a file that exists and cannot be read is made
 * on a platform with no meaningful file modes).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "../src/app/api/deploy/reloads/route";
import { RELOAD_HISTORY_VIEW_LIMIT } from "../src/lib/deploy/reload-history";
import { reloadRecord } from "../scripts/supervise.mjs";

const AT = Date.parse("2026-10-14T12:00:00.000Z");
const previous = process.env.PROD_RELOAD_HISTORY;

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

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "anybase-reloads-route-"));
}

/** Point the route at `contents`, and answer with the parsed body. */
async function asking(contents: string | null) {
  const path = join(tempDir(), "reloads.jsonl");
  if (contents !== null) writeFileSync(path, contents);
  process.env.PROD_RELOAD_HISTORY = path;
  const res = await GET();
  return { res, body: await res.json(), path };
}

beforeEach(() => {
  delete process.env.PROD_RELOAD_HISTORY;
});

afterEach(() => {
  if (previous === undefined) delete process.env.PROD_RELOAD_HISTORY;
  else process.env.PROD_RELOAD_HISTORY = previous;
});

describe("GET /api/deploy/reloads", () => {
  it("answers with an empty view when no history is configured", async () => {
    delete process.env.PROD_RELOAD_HISTORY;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: false,
      path: null,
      total: 0,
      records: [],
      unreadable: [],
      error: null,
    });
  });

  it("is never served from a cache: the file is being appended to as we read it", async () => {
    // Both halves matter: `force-dynamic` stops Next from evaluating this once at
    // build time (where there is no history and never will be), and `no-store`
    // stops anything in front of it caching the answer to a question whose whole
    // point is that it changes.
    const route = await import("../src/app/api/deploy/reloads/route");
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.runtime).toBe("nodejs");
    const { res } = await asking(null);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns the newest reloads first, each with the verdict the gate uses", async () => {
    const older = recordFor("replaced", { at: AT - 60_000, startedAt: AT - 62_500, swappedAt: AT - 61_000 });
    const newest = recordFor("rolled-back", { at: AT });
    // Written newest-FIRST in the file: the order returned must be the records'
    // own `at`, not the order somebody happened to concatenate files in.
    const { body, path } = await asking(jsonl(newest, older));

    expect(body.configured).toBe(true);
    expect(body.path).toBe(path);
    expect(body.total).toBe(2);
    expect(body.error).toBeNull();
    expect(body.records.map((entry: { record: { at: string } }) => entry.record.at)).toEqual([
      newest.at,
      older.at,
    ]);
    expect(body.records[0].verdict).toMatchObject({ landed: false, word: "ROLLED BACK" });
    expect(body.records[1].verdict).toMatchObject({ landed: true, word: "REPLACED" });
    // The record travels as the supervisor wrote it — `rolledBack` included, which
    // is the field an alarm reads.
    expect(body.records[0].record.rolledBack).toBe(true);
  });

  it("shows the newest ten and still says how many there are", async () => {
    const records = Array.from({ length: 12 }, (_, i) =>
      recordFor("replaced", {
        at: AT - i * 1_000,
        startedAt: AT - i * 1_000 - 2_500,
        swappedAt: AT - i * 1_000 - 2_000,
      }),
    );
    const { body } = await asking(jsonl(...records));

    expect(body.records).toHaveLength(RELOAD_HISTORY_VIEW_LIMIT);
    expect(body.total).toBe(12);
    // The ten newest, oldest-first among themselves, so the list reads top-down.
    expect(body.records.map((entry: { record: { at: string } }) => entry.record.at)).toEqual(
      records.slice(0, 10).map((record) => record.at),
    );
  });

  it("tells a file that is missing from one that cannot be read", async () => {
    const missing = await asking(null);
    expect(missing.res.status).toBe(200);
    expect(missing.body.error.kind).toBe("missing");
    expect(missing.body.error.message).toContain(missing.path);
    expect(missing.body.configured).toBe(true);
    expect(missing.body.records).toEqual([]);

    // A directory exists at the path and cannot be read as a file: the other
    // answer, and the one that needs a person rather than a reload.
    const dir = tempDir();
    process.env.PROD_RELOAD_HISTORY = dir;
    const unreadable = await (await GET()).json();
    expect(unreadable.error.kind).toBe("unreadable");
    expect(unreadable.error.message).toContain(dir);
  });

  it("reports the lines it could not read and still shows the ones it could", async () => {
    const good = recordFor("kept");
    const { body } = await asking(
      `${jsonl(good)}>> a truncated write\n\n${JSON.stringify({ not: "a record" })}\n`,
    );

    expect(body.records).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.records[0].record.outcome).toBe("kept");
    expect(body.unreadable).toEqual([
      { line: 2, reason: "not JSON" },
      { line: 4, reason: "no outcome" },
    ]);
  });

  it("returns a reason for a line it cannot use, never the line's own text", async () => {
    // The file is server state. A reader that echoed an unreadable line back would
    // hand whatever is in it — including a credential someone appended by mistake —
    // to any client that can open this page.
    const { body } = await asking(
      `${jsonl(recordFor("replaced"))}{"apiKey":"cf-secret-value-0123456789"}\n`,
    );
    const text = JSON.stringify(body);
    expect(text).not.toContain("cf-secret-value-0123456789");
    expect(body.unreadable).toEqual([{ line: 2, reason: "no outcome" }]);
  });

  it("keeps a record from a newer supervisor and names the outcome as unknown", async () => {
    // The page is a view, not a gate: it shows what the file says rather than
    // nothing at all — and, crucially, it does not call an outcome it has never
    // heard of fine. `scripts/check-reload-history.mjs` is where that refusal
    // belongs, and it does not take this path.
    const { body } = await asking(jsonl({ ...recordFor("replaced"), outcome: "teleported" }));
    expect(body.records).toHaveLength(1);
    expect(body.records[0].record.outcome).toBe("teleported");
    expect(body.records[0].verdict).toBeNull();
  });

  it("shows an empty history as empty rather than as an error", async () => {
    // The first reload has not happened yet: the file exists and carries nothing.
    const { body } = await asking("\n\n");
    expect(body.error).toBeNull();
    expect(body.configured).toBe(true);
    expect(body.total).toBe(0);
    expect(body.records).toEqual([]);
  });
});
