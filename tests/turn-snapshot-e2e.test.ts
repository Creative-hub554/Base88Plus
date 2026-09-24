/**
 * Per-turn undo, end-to-end: a generation through the REAL chat route
 * (mock provider) must persist a workspace snapshot keyed by the finished
 * assistant message id, the snapshots API must list it, and POSTing to
 * the restore endpoint must perform a true point-in-time restore (later
 * edits removed).
 *
 * Hermetic + wire-level, same harness as tests/retry-isolation.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MOCK_PORT = 4603;
const MOCK_SCRIPT = path.resolve(process.cwd(), "scripts", "mock-provider.js");

const fetchReal = globalThis.fetch.bind(globalThis);
vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
  const url =
    typeof input === "object" && input !== null && "url" in input
      ? String((input as Request).url)
      : String(input);
  if (url.includes(`:${MOCK_PORT}`)) {
    if (typeof input === "string" || input instanceof URL) return fetchReal(url, init);
    return fetchReal(input as Request);
  }
  throw new Error("no network in turn-snapshot e2e");
});

let tmp: string;
let prevCwd: string;
let mockProc: ReturnType<typeof spawn> | null = null;

beforeEach(async () => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-undo-e2e-"));
  prevCwd = process.cwd();
  process.chdir(tmp);
  fs.writeFileSync(
    path.join(tmp, "providers.json"),
    JSON.stringify({
      activeProviderId: "mock",
      activeModel: "mock-counter-model",
      providers: [
        {
          id: "mock",
          name: "Mock (test)",
          kind: "openai-compatible",
          baseURL: `http://localhost:${MOCK_PORT}/v1`,
          defaultModel: "mock-counter-model",
          apiKey: "mock-key-test-0123456789",
          configured: true,
        },
      ],
    }),
  );
  mockProc = spawn(process.execPath, [MOCK_SCRIPT, String(MOCK_PORT)], {
    env: process.env,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const probe = setInterval(async () => {
      try {
        const res = await fetchReal(`http://localhost:${MOCK_PORT}/v1/models`);
        if (res.ok) { clearInterval(probe); resolve(); }
      } catch {
        if (Date.now() - started > 8000) { clearInterval(probe); reject(new Error("mock never came up")); }
      }
    }, 100);
  });
});

afterEach(async () => {
  if (mockProc) {
    const exited = new Promise<void>((r) => mockProc!.once("exit", () => r()));
    mockProc.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    mockProc = null;
  }
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.resetModules();
});

describe("per-turn undo end-to-end", () => {
  it("generation persists a snapshot; restore API rewinds the workspace", { timeout: 20_000 }, async () => {
    const { POST: chatPOST } = await import("@/app/api/chat/route");
    const { GET: snapshotsGET } = await import(
      "@/app/api/projects/[projectId]/snapshots/route"
    );
    const { POST: restorePOST } = await import(
      "@/app/api/projects/[projectId]/snapshots/[messageId]/route"
    );
    const { createProject, listAppFiles, saveAppFile } = await import(
      "@/lib/store"
    );

    const projectId = createProject("UndoE2E", "")!.id;

    // Turn 1: generate the app through the real route.
    const res = await chatPOST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Build a counter app." }] }],
        }),
      }) as never,
    );
    expect(res.status).toBe(200);
    await res.text();

    // The finished assistant message id has a snapshot listed.
    const { snapshots } = await (await snapshotsGET(
      new Request(`http://localhost/api/projects/${projectId}/snapshots`) as never,
      { params: Promise.resolve({ projectId }) } as never,
    )).json();
    expect(snapshots.length).toBe(1);
    const messageId = snapshots[0].messageId as string;
    expect(snapshots[0].files).toContain("index.html");

    // Simulate a later destructive turn (operator or model edits).
    saveAppFile(projectId, "index.html", "<p>clobbered by a later turn</p>");
    saveAppFile(projectId, "extra.js", "console.log('should vanish on undo');");

    // Restore via the API route.
    const restoreRes = await restorePOST(
      new Request(
        `http://localhost/api/projects/${projectId}/snapshots/${messageId}`,
        { method: "POST" },
      ) as never,
      { params: Promise.resolve({ projectId, messageId }) } as never,
    );
    expect(restoreRes.status).toBe(200);

    const files = listAppFiles(projectId);
    expect(files.find((f) => f.path === "index.html")?.content).toContain('id="inc"');
    expect(files.find((f) => f.path === "extra.js")).toBeUndefined();

    // Restoring an unknown/pruned message id 404s.
    const missing = await restorePOST(
      new Request(
        `http://localhost/api/projects/${projectId}/snapshots/nope`,
        { method: "POST" },
      ) as never,
      { params: Promise.resolve({ projectId, messageId: "nope" }) } as never,
    );
    expect(missing.status).toBe(404);
  });
});
