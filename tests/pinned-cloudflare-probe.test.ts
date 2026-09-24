/**
 * Regression test for the pinned Cloudflare Workers AI liveness probe.
 *
 * Pins a project to `cloudflare-ai` and asserts that resolving the
 * generation (a) honors the pin and (b) probes the *expanded* base URL
 * (`$CLOUDFLARE_API_BASE/accounts/<id>/ai/v1/models`) — never the raw
 * `{account}` template. That expansion was the original bug: the probe
 * used the stored template URL, so pinned chats pinged the real Cloudflare
 * API with a mangled path and a 404 counted as "alive".
 *
 * Runs hermetically: an isolated cwd, a real local HTTP server standing in
 * for the Cloudflare API, and no network access. Lives in tests/ so Next
 * never bundles it (tsconfig includes it only for typechecking).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Environment MUST be set before the gateway module loads — both
// cloudflareApiBase() and the store resolve paths at import time.
const MOCK_BASE = "http://127.0.0.1:45913";
process.env.CLOUDFLARE_API_BASE = MOCK_BASE;

const ACCOUNT_ID = "testaccount1234567890abcdef";
const CF_TOKEN = "cf-test-token-regression-0001";
const PINNED_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

/** Every URL any request in this test process hits. */
const hitUrls: string[] = [];

/** URL the mock saw for the /models probe of the expanded endpoint. */
let probeUrl: string | null = null;
/** Bearer token the mock saw on that probe. */
let probeAuth: string | null = null;

const server = http.createServer((req, res) => {
  const url = `${MOCK_BASE}${req.url ?? ""}`;
  hitUrls.push(url);
  if (req.url === `/accounts/${ACCOUNT_ID}/ai/v1/models`) {
    probeUrl = url;
    probeAuth = req.headers.authorization ?? null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        errors: [],
        result: {
          object: "list",
          data: [{ id: PINNED_MODEL, object: "model" }],
        },
      }),
    );
    return;
  }
  // Anything else — including the un-expanded
  // `/accounts/%7Baccount%7D/...` template — must never be requested.
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "unexpected request in test mock" }));
});

let tmp: string;
let prevCwd: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(45913, "127.0.0.1", resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  // Fresh isolated cwd per test: providers.json + projects-data land here.
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-probe-"));
  prevCwd = process.cwd();
  process.chdir(tmp);

  fs.writeFileSync(
    "providers.json",
    JSON.stringify({
      activeProviderId: "cloudflare-ai",
      activeModel: PINNED_MODEL,
      providers: [
        {
          id: "cloudflare-ai",
          name: "Cloudflare Workers AI (free)",
          kind: "openai-compatible",
          baseURL: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1",
          defaultModel: PINNED_MODEL,
          configured: false,
        },
      ],
      cloudflare: { accountId: ACCOUNT_ID, apiKey: CF_TOKEN },
    }),
  );
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  hitUrls.length = 0;
  probeUrl = null;
  probeAuth = null;
  // Reset module-level state (settings file cache, probe reachability
  // cache) so tests never observe a previous test's cwd or result.
  vi.resetModules();
});

// Import AFTER the env vars above are set (dynamic so resetModules works).
async function freshGateway() {
  return import("../src/lib/providers/gateway");
}

describe("resolveGenerationFor with a cloudflare-ai project pin", () => {
  it("probes the expanded URL with the Cloudflare token and honors the pin", async () => {
    const { createProject, setProjectModelOverride } = await import(
      "../src/lib/store"
    );
    const { resolveGenerationFor } = await freshGateway();

    const project = createProject("Probe regression", "");
    setProjectModelOverride(project.id, {
      providerId: "cloudflare-ai",
      modelId: PINNED_MODEL,
    });

    const { resolved, source } = await resolveGenerationFor(project.id);

    expect(source).toBe("project");
    expect(resolved.providerId).toBe("cloudflare-ai");
    expect(resolved.modelId).toBe(PINNED_MODEL);

    // The decisive assertion: the liveness probe fetched the EXPANDED url.
    expect(probeUrl).toBe(
      `${MOCK_BASE}/accounts/${ACCOUNT_ID}/ai/v1/models`,
    );
    // …authenticated with the reused Cloudflare deploy token.
    expect(probeAuth).toBe(`Bearer ${CF_TOKEN}`);
    // …and nothing ever hit the un-expanded `{account}` template.
    const mangled = hitUrls.filter((u) => u.includes("%7Baccount%7D"));
    expect(mangled).toEqual([]);
  });

  it("falls back to the global default when the expanded endpoint is dead", async () => {
    // Point the (freshly re-imported) gateway at a dead port: the probe now
    // fails on connection refused → the pin is unusable →
    // resolveGenerationFor must fall back to the global default.
    process.env.CLOUDFLARE_API_BASE = "http://127.0.0.1:9";

    const { createProject, setProjectModelOverride } = await import(
      "../src/lib/store"
    );
    const { resolveGenerationFor } = await freshGateway();

    const project = createProject("Dead endpoint", "");
    setProjectModelOverride(project.id, {
      providerId: "cloudflare-ai",
      modelId: PINNED_MODEL,
    });

    const { source } = await resolveGenerationFor(project.id);
    expect(source).toBe("fallback");
  });
});
