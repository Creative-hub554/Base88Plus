/**
 * Degenerate-retry isolation: a truncated generation must not poison the
 * retry's view of the workspace.
 *
 * Historical failure (pomodoro, 7b): progressive streaming persists each
 * completed `=== file ===` section BEFORE the fence closes; the attempt
 * then died mid-`app.js`. The automatic retry rebuilt its instructions
 * from the workspace — now containing the DRAFT's hallucinated
 * `.long-break-indicator` — and bound its retry JS to that element,
 * which threw on click and killed the timer.
 *
 * The fix under test: the route snapshots the workspace before the first
 * attempt; on a degenerate outcome it ROLLS BACK to the snapshot and
 * rebuilds the retry's file context from the clean state. This test runs
 * the REAL route handler against the mock provider (poison mode): the
 * failed attempt writes a complete index.html + styles.css containing a
 * hallucinated `juicy-hallucinated-id`, and the mock's RETRY tripwire
 * answers with `MOCK_SAW_juicy-hallucinated-id` if the marker ever
 * reaches a retry request — direct evidence from the wire, not a
 * re-derivation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MOCK_PORT = 4599;
const POISON = "juicy-hallucinated-id";
// Module-load cwd is the project root (beforeEach chdir happens later).
const MOCK_SCRIPT = path.resolve(process.cwd(), "scripts", "mock-provider.js");

// Capture the REAL fetch BEFORE spying, so the harness can reach the mock
// provider process while all other traffic (probe noise) fails closed.
const fetchReal = globalThis.fetch.bind(globalThis);
vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
  // input may be a string, URL, or Request — normalize to a URL string.
  const url =
    typeof input === "object" && input !== null && "url" in input
      ? String((input as Request).url)
      : String(input);
  if (url.includes(`:${MOCK_PORT}`)) {
    // Forward the ORIGINAL input untouched when possible: consuming a
    // Request's body here (input.text()) breaks the SDK's streaming
    // internals (ECONNRESET). Only re-wrap plain-string inputs.
    if (typeof input === "string" || input instanceof URL) {
      return fetchReal(url, init);
    }
    return fetchReal(input as Request);
  }
  throw new Error("no network in retry-isolation tests");
});

let tmp: string;
let prevCwd: string;
let mockProc: ReturnType<typeof spawn> | null = null;

function seedProviders() {
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
}

function startMock(env: Record<string, string>) {
  mockProc = spawn(process.execPath, [MOCK_SCRIPT, String(MOCK_PORT)], {
    cwd: tmp,
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
  // Wait for the mock to accept connections.
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const probe = setInterval(async () => {
      try {
        const res = await fetchReal(`http://localhost:${MOCK_PORT}/v1/models`);
        if (res.ok) { clearInterval(probe); resolve(); }
      } catch {
        if (Date.now() - started > 8000) { clearInterval(probe); reject(new Error("mock provider never came up")); }
      }
    }, 100);
  });
}

beforeEach(async () => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-retry-iso-"));
  prevCwd = process.cwd();
  process.chdir(tmp);
  seedProviders();
  fs.mkdirSync(path.join(tmp, "projects-data", "proj-iso"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "projects-data", "proj-iso", "project.json"),
    JSON.stringify({ id: "proj-iso", name: "Iso", description: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
  );
  await startMock({ MOCK_DEGENERATE: "1", MOCK_POISON: POISON });
});

afterEach(async () => {
  if (mockProc) {
    // Wait for exit before rmSync: on Windows the mock's cwd locks tmpdir.
    const exited = new Promise<void>((r) => mockProc!.once("exit", () => r()));
    mockProc.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    mockProc = null;
  }
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.resetModules();
});

describe("degenerate retry isolates the failed attempt's draft", () => {
  it("retry instructions never contain the draft's hallucinated ids; workspace ends clean", { timeout: 20_000 }, async () => {
    // Import through the SAME alias specifiers the route uses so the test
    // and the route share one module registry entry (relative paths would
    // create a second instance of store/gateway).
    const { POST } = await import("@/app/api/chat/route");
    const { createProject } = await import("@/lib/store");

    // Use the store through the same tmp cwd so the route sees this project.
    const project = createProject("Iso", "") ?? { id: "proj-iso" };
    const projectId = project.id;

    const req = new Request("http://localhost/api/chat", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Build a counter app." }] }],
      }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    await res.text(); // drain the SSE stream fully

    // Direct wire evidence: inspect what the mock actually received.
    const requests = JSON.parse(
      fs.readFileSync(path.join(tmp, `mock-requests-${MOCK_PORT}.json`), "utf8"),
    ) as Array<{ messages?: Array<{ content?: unknown }> }>;
    expect(requests.length).toBeGreaterThanOrEqual(2); // attempt + retry

    const instrOf = (r: (typeof requests)[number]) =>
      JSON.stringify(r.messages ?? []);
    // Use the LAST request: if the SDK ever retries an attempt internally,
    // the meaningful isolation evidence is the final one the mock saw.
    expect(instrOf(requests[0])).not.toContain(POISON); // attempt 1: pre-turn workspace
    expect(instrOf(requests[requests.length - 1])).not.toContain(POISON); // THE isolation assertion

    // The mock's tripwire: a poisoned retry would have answered with
    // MOCK_SAW_<poison>; assert the final files don't contain it.
    const { listAppFiles } = await import("../src/lib/store");
    const files = listAppFiles(projectId);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.content).not.toContain(`MOCK_SAW_${POISON}`);
      expect(f.content).not.toContain(POISON);
    }
    // And the workspace is the mock's CLEAN app (counter ids), not the draft.
    const index = files.find((f) => f.path === "index.html");
    expect(index?.content).toContain('id="inc"');

    // Rollback visibility contract: the finished message metadata reports
    // how many files the failed attempt had touched (the draft wrote
    // index.html + styles.css before dying mid-app.js).
    const messages = JSON.parse(
      fs.readFileSync(path.join(tmp, "projects-data", projectId, "chat.json"), "utf8"),
    ) as Array<{
      role: string;
      metadata?: { rolledBackFiles?: number; retried?: boolean };
    }>;
    const finished = messages.find((m) => m.role === "assistant");
    expect(finished?.metadata?.retried).toBe(true);
    expect(finished?.metadata?.rolledBackFiles).toBe(2);
  });

  it("workspace rollback restores the pre-attempt state byte-for-byte (non-generated additions removed)", async () => {
    const { snapshotWorkspace, restoreWorkspace, saveAppFile, listAppFiles, createProject } = await import(
      "../src/lib/store"
    );
    const projectId = createProject("Rollback", "")?.id ?? "proj-iso";
    saveAppFile(projectId, "index.html", "<p>original</p>");
    saveAppFile(projectId, "styles.css", "body{}");
    const snap = snapshotWorkspace(projectId);

    // The "failed attempt" mutates existing files and adds a draft file.
    saveAppFile(projectId, "index.html", "<p>hallucinated draft</p>");
    saveAppFile(projectId, "draft.js", "var x = hallucination;");
    restoreWorkspace(projectId, snap);

    const after = listAppFiles(projectId);
    expect(after.find((f) => f.path === "index.html")?.content).toBe("<p>original</p>");
    expect(after.find((f) => f.path === "styles.css")?.content).toBe("body{}");
    expect(after.find((f) => f.path === "draft.js")).toBeUndefined();
  });
});
