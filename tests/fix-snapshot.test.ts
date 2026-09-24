/**
 * "Fix this snapshot" route E2E against the mock OpenAI-compatible
 * provider (same wire harness as quota-fallback.test.ts).
 *
 * Seeds an incomplete snapshot (HTML references app.js, file absent),
 * POSTs the fix route, and asserts — from the wire and disk only:
 *   1. The generation request's instructions contain the snapshot's HTML
 *      and name the missing file, and NEVER contain live-workspace content
 *      (the fix must see the snapshot, not the workspace).
 *   2. The snapshot now contains the generated app.js and reports no
 *      missing assets; the workspace was never touched.
 *   3. Complete snapshots refuse (400); unknown snapshots 404.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 4607;
const MOCK_SCRIPT = path.resolve(process.cwd(), "scripts", "mock-provider.js");

const fetchReal = globalThis.fetch.bind(globalThis);
vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
  const url =
    typeof input === "object" && input !== null && "url" in input
      ? String((input as Request).url)
      : String(input);
  if (url.includes(`:${PORT}`)) {
    if (typeof input === "string" || input instanceof URL) return fetchReal(url, init);
    return fetchReal(input as Request);
  }
  if (url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")) {
    return fetchReal(input as Request);
  }
  throw new Error(`no network in fix-snapshot tests: ${url}`);
});

let tmp: string;
let prevCwd: string;
let procs: Array<ReturnType<typeof spawn>> = [];

function seedProviders() {
  fs.writeFileSync(
    path.join(tmp, "providers.json"),
    JSON.stringify({
      activeProviderId: "mock",
      activeModel: "mock-counter-model",
      providers: [
        {
          id: "mock",
          name: "Mock provider",
          kind: "openai-compatible",
          baseURL: `http://localhost:${PORT}/v1`,
          defaultModel: "mock-counter-model",
          apiKey: "mock-key-fix-1234567890",
          configured: true,
        },
      ],
    }),
  );
}

function startMock(port: number) {
  const proc = spawn(process.execPath, [MOCK_SCRIPT, String(port)], {
    env: { ...process.env, MOCK_WHO: "FIX" },
    stdio: "ignore",
  });
  procs.push(proc);
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const probe = setInterval(async () => {
      try {
        const res = await fetchReal(`http://localhost:${port}/v1/models`);
        if (res.ok) { clearInterval(probe); resolve(); }
      } catch {
        if (Date.now() - started > 8000) { clearInterval(probe); reject(new Error(`mock :${port} never came up`)); }
      }
    }, 100);
  });
}

beforeEach(async () => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-fix-"));
  prevCwd = process.cwd();
  process.chdir(tmp);
  seedProviders();
  await startMock(PORT);
});

afterEach(async () => {
  const exits = procs.map((p) => new Promise<void>((r) => p.once("exit", () => r())));
  procs.forEach((p) => p.kill());
  await Promise.race([Promise.all(exits), new Promise((r) => setTimeout(r, 2000))]);
  procs = [];
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.resetModules();
});

describe("snapshot fix route — regenerate missing assets", () => {
  it("regenerates the missing file into the snapshot; workspace untouched", { timeout: 20_000 }, async () => {
    const { createProject, saveAppFile, listAppFiles, recordTurnSnapshot, snapshotMissingAssets } =
      await import("@/lib/store");
    const { POST: fixPOST } = await import(
      "@/app/api/projects/[projectId]/snapshots/[messageId]/fix/route"
    );

    const projectId = createProject("Fix", "")!.id;
    const LIVE_MARK = "live-workspace-marker";
    saveAppFile(projectId, "index.html", `<p>${LIVE_MARK}</p>`);
    const html = '<html><head><link rel="stylesheet" href="styles.css"></head><body><h1>Ghost</h1><script src="app.js"></script></body></html>';
    recordTurnSnapshot(projectId, "m-fix", [
      { path: "index.html", content: html },
      { path: "styles.css", content: "body{}" },
    ]);
    expect(snapshotMissingAssets(projectId, "m-fix")).toEqual(["app.js"]);

    const res = await fixPOST(
      new Request("http://localhost/api/x", { method: "POST" }) as never,
      { params: Promise.resolve({ projectId, messageId: "m-fix" }) } as never,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.fixed).toEqual(["app.js"]);
    expect(data.stillMissing).toEqual([]);

    // The wire: instructions carried the SNAPSHOT's html + the missing
    // name, and never the live workspace's marker.
    const log = JSON.parse(
      fs.readFileSync(path.join(tmp, `mock-requests-${PORT}.json`), "utf8"),
    );
    expect(log.length).toBeGreaterThanOrEqual(1);
    const wire = JSON.stringify(log[0]);
    expect(wire).toContain("app.js");
    expect(wire).toContain("<h1>Ghost</h1>");
    expect(wire).not.toContain(LIVE_MARK);

    // Snapshot is complete now, with the mock's counter app.js.
    expect(snapshotMissingAssets(projectId, "m-fix")).toEqual([]);
    const { readTurnSnapshotFile } = await import("@/lib/store");
    const fixed = readTurnSnapshotFile(projectId, "m-fix", "app.js");
    expect(fixed).toContain("getElementById");
    // The snapshot's HTML was updated to the mock's regenerated app (the
    // merge lets generated content win for paths it emitted) — the index
    // still references app.js and now has it.
    const mergedHtml = readTurnSnapshotFile(projectId, "m-fix", "index.html");
    expect(mergedHtml).toContain("app.js");
    expect(mergedHtml).not.toContain("Ghost");

    // Workspace untouched.
    const files = listAppFiles(projectId);
    expect(files).toHaveLength(1);
    expect(files[0].content).toContain(LIVE_MARK);
  });

  it("refuses complete snapshots (400) and unknown snapshots (404)", async () => {
    const { createProject, saveAppFile, recordTurnSnapshot } = await import("@/lib/store");
    const { POST: fixPOST } = await import(
      "@/app/api/projects/[projectId]/snapshots/[messageId]/fix/route"
    );

    const projectId = createProject("Fix2", "")!.id;
    saveAppFile(projectId, "index.html", "<p>x</p>");
    recordTurnSnapshot(projectId, "m-ok", [
      { path: "index.html", content: "<html></html>" },
    ]);

    const ok = await fixPOST(
      new Request("http://localhost/api/x", { method: "POST" }) as never,
      { params: Promise.resolve({ projectId, messageId: "m-ok" }) } as never,
    );
    expect(ok.status).toBe(400);

    const missing = await fixPOST(
      new Request("http://localhost/api/x", { method: "POST" }) as never,
      { params: Promise.resolve({ projectId, messageId: "nope" }) } as never,
    );
    expect(missing.status).toBe(404);
  });
});
