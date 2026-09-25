/**
 * Drift guard + schedule-driven CI policy: scripts/check-node-contract.js.
 *
 * The CI matrix is COMPUTED from the official Node release schedule
 * (scripts/node-schedule.js → scripts/ci-compute-matrix.js), so the
 * canary auto-promotes to a blocking gate on its lts date (v26:
 * 2026-10-28) and EOL legs drop out. The guard re-runs the SAME
 * classification and enforces the cross-source contract. These tests pin:
 *
 *   • the real tree passes TODAY (legs [22,24], canary 26);
 *   • promotion day passes with ZERO changes (26 graduates into legs —
 *     engines ">=22 <27" already covers it) — the whole point of the
 *     schedule-driven design;
 *   • post-EOL (22 retired) the guard FAILS until the engines floor is
 *     bumped — demotion is automatic in CI but must be acknowledged here;
 *   • promotion-day drift (engines not widened in time) fails with the
 *     bump instruction;
 *   • structural drift fails: hardcoded matrix, canary that lost
 *     continue-on-error, .nvmrc pointing at a canary instead of a gate.
 *
 * Cases run the guard as a real subprocess against the real tree (with an
 * inline SCHEDULE_JSON for determinism — no network) or generated fixtures.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "..", "scripts", "check-node-contract.js");
const REPO_ROOT = path.resolve(__dirname, "..");

/** The real published dates (verified 2026-09-25 against nodejs/Release). */
const REAL_SCHEDULE = JSON.stringify({
  v22: { start: "2024-04-24", lts: "2024-10-29", maintenance: "2025-10-21", end: "2027-04-30" },
  v24: { start: "2025-05-06", lts: "2025-10-28", maintenance: "2026-10-20", end: "2028-04-30" },
  v26: { start: "2026-05-05", lts: "2026-10-28", maintenance: "2027-10-20", end: "2029-04-30" },
});

function runScript(cwd: string, env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [SCRIPT], {
      cwd,
      env: { ...process.env, ...env },
    });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    proc.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

// --- fixture scaffolding ----------------------------------------------------

const WORKFLOW = `name: CI
on: push
jobs:
  matrix:
    runs-on: ubuntu-latest
    outputs:
      legs: '["22","24"]'
      canary: '["26"]'
    steps:
      - run: echo ok
  gates:
    needs: matrix
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: \${{ fromJSON(needs.matrix.outputs.legs) }}
    steps:
      - run: echo ok
  canary:
    needs: matrix
    runs-on: ubuntu-latest
    continue-on-error: true
    if: needs.matrix.outputs.canary != '[]'
    strategy:
      matrix:
        node: \${{ fromJSON(needs.matrix.outputs.canary) }}
    steps:
      - run: echo ok
  ci-ok:
    needs: [matrix, gates]
    runs-on: ubuntu-latest
    if: always()
    steps:
      - run: echo ok
`;

const tmps: string[] = [];
function tmpProject(opts: {
  engines: string;
  nvmrc: string;
  workflow?: string;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-contract-"));
  tmps.push(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", engines: { node: opts.engines } }),
  );
  fs.writeFileSync(path.join(dir, ".nvmrc"), opts.nvmrc + "\n");
  fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".github", "workflows", "ci.yml"),
    opts.workflow ?? WORKFLOW,
  );
  return dir;
}

afterEach(() => {
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true, maxRetries: 5 });
});

// --- the pins ----------------------------------------------------------------

describe("check-node-contract — real tree", () => {
  it("passes today: legs [22,24], canary 26, structure intact", async () => {
    const { code, out } = await runScript(REPO_ROOT, { SCHEDULE_JSON: REAL_SCHEDULE });
    expect(code).toBe(0);
    expect(out).toContain("blocking [22, 24], canary 26");
    expect(out).toContain("contract holds");
    expect(out).toContain("gates matrix is computed from the release schedule");
    expect(out).toContain("canary job is non-blocking");
    expect(out).toContain(".nvmrc (node 24) is one of the blocking CI legs");
  }, 15_000);

  it("promotion day (2026-10-28) passes with ZERO changes — 26 graduates to a gate", async () => {
    const { code, out } = await runScript(REPO_ROOT, {
      SCHEDULE_JSON: REAL_SCHEDULE,
      NOW: "2026-10-28",
    });
    expect(code).toBe(0);
    expect(out).toContain("blocking [22, 24, 26], canary none");
    expect(out).toContain("blocking leg node 26 satisfies engines");
    expect(out).toContain("contract holds");
  }, 15_000);

  it("post-EOL (22 retired) FAILS until the engines floor is bumped", async () => {
    // 2027-05-01: the schedule drops 22 → the oldest blocking leg is 24,
    // but engines still advertises >=22. Demotion is automatic in CI;
    // the guard makes the floor bump an explicit, forced act.
    const { code, out } = await runScript(REPO_ROOT, {
      SCHEDULE_JSON: REAL_SCHEDULE,
      NOW: "2027-05-01",
    });
    expect(code).toBe(1);
    expect(out).toContain("engines floor is node 22 but the oldest blocking leg is node 24");
    expect(out).toContain("advertised but never tested");
  }, 15_000);
});

describe("check-node-contract — drift probes (fixtures)", () => {
  it("fails when promotion lands but engines was not widened in time", async () => {
    // Engines frozen below the graduating LTS: leg 26 runs red on a
    // healthy tree unless someone bumps the range.
    const dir = tmpProject({ engines: ">=22 <26", nvmrc: "24" });
    const { code, out } = await runScript(dir, {
      SCHEDULE_JSON: REAL_SCHEDULE,
      NOW: "2026-10-28",
    });
    expect(code).toBe(1);
    expect(out).toContain("blocking leg node 26 does NOT satisfy engines \">=22 <26\"");
    expect(out).toContain("bump engines to cover it");
  }, 15_000);

  it("fails when .nvmrc points at the canary instead of a blocking leg", async () => {
    const dir = tmpProject({ engines: ">=22 <27", nvmrc: "26" });
    const { code, out } = await runScript(dir, { SCHEDULE_JSON: REAL_SCHEDULE });
    expect(code).toBe(1);
    expect(out).toContain(".nvmrc (node 26) is NOT a blocking CI leg [22, 24]");
    expect(out).toContain("the recommended dev version would be ungated");
  }, 15_000);

  it("fails when the canary job loses continue-on-error (would block merges)", async () => {
    const workflow = WORKFLOW.replace("    continue-on-error: true\n", "");
    const dir = tmpProject({ engines: ">=22 <27", nvmrc: "24", workflow });
    const { code, out } = await runScript(dir, { SCHEDULE_JSON: REAL_SCHEDULE });
    expect(code).toBe(1);
    expect(out).toContain("canary job lost continue-on-error");
    expect(out).toContain("a canary failure would block merges");
  }, 15_000);

  it("fails when the gates matrix is hardcoded instead of schedule-driven", async () => {
    const workflow = WORKFLOW.replace(
      "        node: \${{ fromJSON(needs.matrix.outputs.legs) }}",
      "        node: [22, 24]",
    );
    const dir = tmpProject({ engines: ">=22 <27", nvmrc: "24", workflow });
    const { code, out } = await runScript(dir, { SCHEDULE_JSON: REAL_SCHEDULE });
    expect(code).toBe(1);
    expect(out).toContain("gates matrix is hardcoded");
    expect(out).toContain("promotions/demotions apply without workflow edits");
  }, 15_000);
});
