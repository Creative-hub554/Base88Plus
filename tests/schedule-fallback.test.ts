/**
 * Sourcing policy for the Node release schedule (scripts/node-schedule.js):
 * SCHEDULE_JSON override → live fetch → committed fallback snapshot that
 * refuses to classify on stale data.
 *
 * The fallback is the outage story for CI, so its failure modes are
 * pinned: it is used (with a warning) while fresh, and REFUSED when it is
 * too old, predates a transition that has since passed, lacks the lts date
 * of a released even major, or is malformed. The live path is exercised
 * against a LOCAL http server — no test touches the real network, and the
 * dead-upstream probes use a closed port.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";

const COMPUTE = path.resolve(__dirname, "..", "scripts", "ci-compute-matrix.js");
const REPO_ROOT = path.resolve(__dirname, "..");

/** Real published dates (verified 2026-09-25). */
const SCHEDULE = {
  v22: { start: "2024-04-24", lts: "2024-10-29", maintenance: "2025-10-21", end: "2027-04-30" },
  v24: { start: "2025-05-06", lts: "2025-10-28", maintenance: "2026-10-20", end: "2028-04-30" },
  v26: { start: "2026-05-05", lts: "2026-10-28", maintenance: "2027-10-20", end: "2029-04-30" },
};

// --- local schedule server (the "upstream") ---------------------------------

let server: http.Server;
let baseUrl = "";
let served: { status: number; body: string } | null = null;

beforeAll(async () => {
  server = createServer((_req, res) => {
    const s = served ?? { status: 200, body: JSON.stringify(SCHEDULE) };
    res.statusCode = s.status;
    res.end(s.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/schedule.json`;
});
afterAll(() => {
  server?.close();
});

// --- fixture trees -----------------------------------------------------------

const tmps: string[] = [];
function tmpProject(opts: { snapshot?: object | null; engines?: string; nvmrc?: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-fallback-"));
  tmps.push(dir);
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      engines: { node: opts.engines ?? ">=22 <27" },
    }),
  );
  if (opts.snapshot !== null) {
    fs.writeFileSync(
      path.join(dir, "scripts", "node-schedule.json"),
      JSON.stringify(opts.snapshot ?? { _fetchedAt: "2026-09-25", schedule: SCHEDULE }),
    );
  }
  return dir;
}
afterEach(() => {
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true, maxRetries: 5 });
  served = null;
});

function runCompute(dir: string, env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [COMPUTE], { cwd: dir, env: { ...process.env, ...env } });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    proc.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

const DEAD = "https://127.0.0.1:9/v1/schedule.json"; // closed port = outage

describe("schedule sourcing — happy paths", () => {
  it("uses the live upstream when reachable", async () => {
    served = { status: 200, body: JSON.stringify(SCHEDULE) };
    const dir = tmpProject({});
    const { code, out } = await runCompute(dir, { SCHEDULE_URL: baseUrl });
    expect(code).toBe(0);
    expect(out).toContain("blocking legs [22,24], canary [26]");
    expect(out).not.toContain("⚠"); // no fallback warning
  }, 15_000);

  it("falls back to the committed snapshot with a warning when upstream is down", async () => {
    const dir = tmpProject({});
    const { code, out } = await runCompute(dir, { SCHEDULE_URL: DEAD });
    expect(code).toBe(0);
    expect(out).toContain("⚠ upstream unavailable");
    expect(out).toContain("using committed fallback snapshot (fetched 2026-09-25, 0d ago)");
    expect(out).toContain("blocking legs [22,24], canary [26]");
  }, 15_000);
});

describe("schedule sourcing — stale-snapshot refusals", () => {
  it("refuses a snapshot older than the 60-day limit", async () => {
    const dir = tmpProject({ snapshot: { _fetchedAt: "2026-06-01", schedule: SCHEDULE } });
    const { code, out } = await runCompute(dir, { SCHEDULE_URL: DEAD });
    expect(code).toBe(1);
    expect(out).toContain("TOO STALE");
    expect(out).toContain("days old (limit 60)");
  }, 15_000);

  it("refuses a snapshot that predates a transition that has since passed", async () => {
    const snapshot = {
      _fetchedAt: "2026-09-25",
      schedule: { ...SCHEDULE, v26: { start: "2026-05-05", end: "2029-04-30" } },
    };
    // After promotion day the missing lts date would silently un-gate 26.
    const dir = tmpProject({ snapshot });
    const { code, out } = await runCompute(dir, {
      SCHEDULE_URL: DEAD,
      NOW: "2026-10-28",
    });
    expect(code).toBe(1);
    expect(out).toContain("TOO STALE");
    expect(out).toContain("lts date is absent");
  }, 15_000);

  it("refuses a malformed snapshot instead of guessing", async () => {
    const dir = tmpProject({});
    fs.writeFileSync(
      path.join(dir, "scripts", "node-schedule.json"),
      "{ not json at all",
    );
    const { code, out } = await runCompute(dir, { SCHEDULE_URL: DEAD });
    expect(code).toBe(1);
    expect(out).toContain("no usable fallback snapshot");
  }, 15_000);

  it("refuses outright when upstream is down and no snapshot exists", async () => {
    const dir = tmpProject({ snapshot: null });
    const { code, out } = await runCompute(dir, { SCHEDULE_URL: DEAD });
    expect(code).toBe(1);
    expect(out).toContain("no usable fallback snapshot");
    expect(out).toContain("update:schedule");
  }, 15_000);
});

describe("schedule sourcing — repo hygiene", () => {
  it("the committed snapshot is fresh, well-formed, and classifies as today does", async () => {
    const wrapper = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "scripts", "node-schedule.json"), "utf8"),
    );
    expect(wrapper._fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(wrapper.schedule.v26.lts).toBe("2026-10-28");
    // Classifying the committed snapshot must reproduce the shipped policy.
    const { classify } = await import("../scripts/node-schedule");
    const cls = classify(wrapper.schedule, new Date("2026-09-25"));
    expect(cls.blocking).toEqual([22, 24]);
    expect(cls.canary).toBe(26);
  });
});
