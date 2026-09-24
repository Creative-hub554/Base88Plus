/**
 * Quota → fallback: wire-level coverage for the free-tier-exhaustion path.
 *
 * Two mock provider instances run side by side (per-port request logs so
 * they don't clobber each other):
 *   - primary  (port A, MOCK_QUOTA_MODE=partial-then-429): streams a
 *     COMPLETE index.html section into the workspace, then dies mid-stream
 *     with an in-stream rate-limit error — the wire shape of a provider
 *     running out of quota mid-generation.
 *   - fallback (port B, clean): serves the normal counter app.
 *
 * Asserts, from the wire and disk only:
 *   1. The route detects the quota error (isQuotaError on the in-stream
 *      error object), emits the fallback note, and re-runs on the OTHER
 *      provider — proven by the fallback's request log receiving the
 *      generation request.
 *   2. Switchover isolation: the fallback's request never contains the
 *      quota attempt's partial draft (rollback now runs BEFORE
 *      resolveFallbackGeneration, not only before degenerate retries).
 *   3. The final workspace is the fallback's clean app; final metadata
 *      reports quotaFallback: true and the fallback's model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT_A = 4601; // quota'd primary
const PORT_B = 4602; // healthy fallback
const POISON = "quota-partial-draft-id";
const MOCK_SCRIPT = path.resolve(process.cwd(), "scripts", "mock-provider.js");

const fetchReal = globalThis.fetch.bind(globalThis);
vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
  const url =
    typeof input === "object" && input !== null && "url" in input
      ? String((input as Request).url)
      : String(input);
  if (url.includes(`:${PORT_A}`) || url.includes(`:${PORT_B}`)) {
    if (process.env.DEBUG_QF) console.log("[spy] allowed:", url);
    if (typeof input === "string" || input instanceof URL) return fetchReal(url, init);
    return fetchReal(input as Request);
  }
  if (process.env.DEBUG_QF) console.log("[spy] rejected:", url);
  throw new Error("no network in quota-fallback tests");
});

let tmp: string;
let prevCwd: string;
let procs: Array<ReturnType<typeof spawn>> = [];

function seedProviders() {
  fs.writeFileSync(
    path.join(tmp, "providers.json"),
    JSON.stringify({
      activeProviderId: "primary",
      activeModel: "mock-counter-model",
      providers: [
        {
          id: "primary",
          name: "Primary (quota)",
          kind: "openai-compatible",
          baseURL: `http://localhost:${PORT_A}/v1`,
          defaultModel: "mock-counter-model",
          apiKey: "mock-key-primary-12345",
          configured: true,
        },
        {
          id: "secondary",
          name: "Secondary (healthy)",
          kind: "openai-compatible",
          baseURL: `http://localhost:${PORT_B}/v1`,
          defaultModel: "mock-counter-model",
          apiKey: "mock-key-secondary-12345",
          configured: true,
        },
      ],
    }),
  );
}

function startMock(port: number, env: Record<string, string>) {
  const proc = spawn(process.execPath, [MOCK_SCRIPT, String(port)], {
    env: { ...process.env, ...env },
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-quota-"));
  prevCwd = process.cwd();
  process.chdir(tmp);
  seedProviders();
  await Promise.all([
    startMock(PORT_A, { MOCK_QUOTA_MODE: "partial-then-429", MOCK_POISON: POISON }),
    startMock(PORT_B, { MOCK_WHO: "B" }),
  ]);
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

describe("quota → fallback wire coverage", () => {
  it("falls back after a mid-stream quota error, isolated from the dead attempt's partials", { timeout: 20_000 }, async () => {
    const { POST } = await import("@/app/api/chat/route");
    const { createProject, listAppFiles } = await import("@/lib/store");

    const projectId = createProject("QuotaTest", "")!.id;

    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          messages: [{ id: "q1", role: "user", parts: [{ type: "text", text: "Build a counter app." }] }],
        }),
      }) as never,
    );
    expect(res.status).toBe(200);
    const streamText = await res.text();

    // The user-visible fallback note went out on this stream.
    expect(streamText).toContain("free tier is out of capacity");

    // 1+2: the primary saw exactly one request; the fallback received the
    // generation and its instructions contain NO trace of the quota
    // attempt's partial draft.
    const primaryLog = JSON.parse(
      fs.readFileSync(path.join(tmp, `mock-requests-${PORT_A}.json`), "utf8"),
    );
    expect(primaryLog.length).toBe(1); // no retry hammered the quota'd provider

    const fallbackLog = JSON.parse(
      fs.readFileSync(path.join(tmp, `mock-requests-${PORT_B}.json`), "utf8"),
    );
    expect(fallbackLog.length).toBeGreaterThanOrEqual(1);
    const fallbackWire = JSON.stringify(fallbackLog[0]);
    expect(fallbackWire).not.toContain(POISON);

    // 3: the workspace is the fallback's clean counter app.
    const files = listAppFiles(projectId);
    const index = files.find((f) => f.path === "index.html");
    expect(index?.content).toContain('id="inc"');
    for (const f of files) expect(f.content).not.toContain(POISON);

    // Final metadata: quotaFallback flag + the fallback's model, and the
    // rollback note counts the partial file the quota attempt left behind.
    const chat = JSON.parse(
      fs.readFileSync(path.join(tmp, "projects-data", projectId, "chat.json"), "utf8"),
    );
    const finished = chat.find((m: { role: string }) => m.role === "assistant");
    expect(finished.metadata.quotaFallback).toBe(true);
    expect(finished.metadata.modelUsed).toBe("mock-counter-model");
    expect(finished.metadata.rolledBackFiles).toBe(1);
  });
});
