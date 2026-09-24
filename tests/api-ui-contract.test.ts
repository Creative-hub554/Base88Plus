/**
 * API↔UI contract pin: every provider-state flag the UI consumes from an
 * API response must EQUAL the gateway's own gate at response-build time.
 *
 * The historical drift this prevents — the "placeholder-key bug class" —
 * shipped three times by hand-restating the gate: settings `isUsable`
 * counting PASTE_YOUR_KEY as configured, the pin-picker catalog doing the
 * same, and (earliest) catalogs counting providers with no base URL. Each
 * time the API told the UI one story while the resolver told another.
 *
 * This file runs the REAL route handlers (imported directly — Next routes
 * export plain functions) against a settings file in an isolated temp cwd,
 * then asserts every consumed flag deep-equals the gateway's exported
 * gate. If a route re-derives a flag by hand, any drift from the gate
 * fails here immediately.
 *
 * Flags pinned (consumer → route → gate):
 *   settings[].configured (SettingsForm, ModelPicker) → /api/settings,
 *     /api/models, /api/projects/[id]/model → isProviderUsable
 *   providers[].configured + reachable (dashboard)     → /api/providers/health
 *   projects[].pinBroken (dashboard fallback warning)  → /api/providers/health
 *   default.modelId (pin picker's "global default")    → pin-model GET
 *   templates.configured (gallery "provider ready")    → resolveGenerationFor
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Settings } from "../src/lib/types";

// Keep host noise (probes against real localhost ports / real APIs) out of
// the tests; errors intentionally leak to handlers, which degrade to
// `reachable: false` / `error: "unreachable"` per the contract.
vi.spyOn(globalThis, "fetch").mockImplementation(() =>
  Promise.reject(new Error("no network in api-ui-contract tests")),
);

let tmp: string;
let prevCwd: string;

function writeProvidersJson(settings: Settings) {
  fs.writeFileSync(path.join(tmp, "providers.json"), JSON.stringify(settings));
}

/** Settings that exercise every branch of the gates. */
function seedSettings(): Settings {
  return {
    activeProviderId: "ollama",
    activeModel: "qwen2.5-coder:1.5b",
    providers: [
      {
        id: "ollama",
        name: "Ollama (local)",
        kind: "openai-compatible",
        baseURL: "http://localhost:11434/v1",
        defaultModel: "qwen2.5-coder:1.5b",
        configured: false,
      },
      {
        id: "openai",
        name: "OpenAI",
        kind: "openai",
        baseURL: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1",
        // The classic placeholder — must NOT read as configured anywhere.
        apiKey: "PASTE_YOUR_KEY_HERE",
        configured: true,
      },
      {
        id: "groq",
        name: "Groq",
        kind: "openai-compatible",
        baseURL: "https://api.groq.com/openai/v1",
        defaultModel: "llama-3.3-70b-versatile",
        apiKey: "gsk_real_key_0123456789abcdef0123456789",
        configured: false,
      },
      {
        // Keyless by design but with NO base URL — usable=false, and the
        // earliest drift bug was catalogs counting exactly this shape.
        id: "custom",
        name: "Custom OpenAI-compatible",
        kind: "openai-compatible",
        baseURL: "",
        defaultModel: "",
        configured: false,
      },
      {
        // Connected Workers AI (token + account id via cloudflare block,
        // no own key) — usable only after {account} expansion.
        id: "cloudflare-ai",
        name: "Cloudflare Workers AI (free)",
        kind: "openai-compatible",
        baseURL: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1",
        defaultModel: "@cf/meta/llama-3.1-8b-instruct-fast",
        configured: false,
      },
    ],
    cloudflare: {
      accountId: "testaccount1234567890abcdef",
      apiKey: "cf-test-token-0123456789abcdef",
    },
  };
}

function realProvider(settings: Settings, id: string) {
  return settings.providers.find((p) => p.id === id)!;
}

beforeEach(() => {
  vi.resetModules();
  vi.mocked(globalThis.fetch).mockClear();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-contract-"));
  prevCwd = process.cwd();
  process.chdir(tmp);
  writeProvidersJson(seedSettings());
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.resetModules();
});

describe("settings route — configured flags equal isProviderUsable", () => {
  it("GET /api/settings redacts keys and mirrors the gate per provider", async () => {
    const { GET } = await import("../src/app/api/settings/route");
    const { redactSettings, getSettings } = await import(
      "../src/lib/providers/gateway"
    );

    const res = await GET();
    const { settings: redacted } = await res.json();

    // The UI's only "configured" source must be exactly the gate —
    // compared against the same merged settings view the route used.
    const settings = getSettings();
    expect(redacted.providers).toEqual(redactSettings(settings).providers);
    for (const p of redacted.providers) {
      const { isProviderUsable } = await import("../src/lib/providers/gateway");
      expect(p.configured).toBe(isProviderUsable(realProvider(settings, p.id), settings));
    }
    // And keys never leave the server.
    expect(redacted.providers.every((p: { apiKey?: string }) => !p.apiKey)).toBe(true);
  });

  it("POST /api/settings redacts identically to GET", async () => {
    const { GET, POST } = await import("../src/app/api/settings/route");
    const req = new Request("http://localhost/api/settings", {
      method: "POST",
      body: JSON.stringify({ activeProviderId: "groq", activeModel: "llama-3.3-70b-versatile" }),
    });
    const postRes = await POST(req as never);
    const { settings: afterPost } = await postRes.json();
    const { settings: afterGet } = await (await GET()).json();
    expect(afterPost).toEqual(afterGet);
  });
});

describe("models route — catalog flags equal the gates", () => {
  it("GET /api/models: configured === hasProviderCredentials, activeModel === activeModelOrDefault", async () => {
    const { GET } = await import("../src/app/api/models/route");
    const {
      hasProviderCredentials,
      listProviderModels,
      getSettings,
    } = await import("../src/lib/providers/gateway");

    const { providers } = await (await GET()).json();
    // getSettings() merges the default catalog into the saved file — the
    // exact view the route saw, with every default provider id present.
    const settings = getSettings();

    for (const entry of providers) {
      const p = realProvider(settings, entry.id);
      expect(entry.configured).toBe(hasProviderCredentials(p, settings));
      const { models, error } = await listProviderModels(p, settings);
      expect(entry.models).toEqual(models);
      expect(entry.error).toBe(error);
    }
    // Placeholder OpenAI key: no drift anywhere in the catalog response.
    const openai = providers.find((p: { id: string }) => p.id === "openai");
    expect(openai.configured).toBe(false);
    expect(openai.models).toEqual([]);
    // The active pair echoes the global picker selection.
    const ollama = providers.find((p: { id: string }) => p.id === "ollama");
    expect(ollama.activeModel).toBe("qwen2.5-coder:1.5b");
  });
});

describe("pin-model route — catalog + default equal the gates", () => {
  it("GET: configured === hasProviderCredentials, models/error === listProviderModels", async () => {
    const { createProject } = await import("../src/lib/store");
    const { id } = createProject("Contract pin", "");
    const { GET } = await import("../src/app/api/projects/[projectId]/model/route");
    const {
      hasProviderCredentials,
      listProviderModels,
      getSettings,
    } = await import("../src/lib/providers/gateway");
    const settings = getSettings();

    const data = await (
      await GET(
        new Request("http://localhost/x") as never,
        { params: Promise.resolve({ projectId: id }) } as never,
      )
    ).json();

    expect(data.override).toBeNull();
    // The pin picker's "This project: default (...)" label reads exactly this.
    expect(data.default).toEqual({
      providerId: settings.activeProviderId,
      modelId: settings.activeModel,
    });

    for (const entry of data.catalog) {
      const p = realProvider(settings, entry.id);
      expect(entry.configured).toBe(hasProviderCredentials(p, settings));
      const { models, error } = await listProviderModels(p, settings);
      expect(entry.models).toEqual(models);
      expect(entry.error).toBe(error);
    }
  });

  it("PUT rejects a pin the resolver would refuse, accepts one it would honor", async () => {
    const { createProject } = await import("../src/lib/store");
    const { id } = createProject("Pin validation", "");
    const { PUT } = await import("../src/app/api/projects/[projectId]/model/route");

    const put = (body: unknown) =>
      PUT(
        new Request("http://localhost/x", {
          method: "PUT",
          body: JSON.stringify(body),
        }) as never,
        { params: Promise.resolve({ projectId: id }) } as never,
      );

    // Placeholder-keyed OpenAI: the resolver refuses → route must 400.
    expect((await put({ providerId: "openai", modelId: "gpt-4.1" })).status).toBe(400);
    // Groq (real key): the resolver honors → route must accept.
    expect((await put({ providerId: "groq", modelId: "llama-3.3-70b-versatile" })).status).toBe(200);
  });
});

describe("health route — dashboard flags equal the gates", () => {
  it("configured === isProviderUsable; unconfigured providers are never probed", async () => {
    const { GET } = await import("../src/app/api/providers/health/route");
    const { isProviderUsable, getSettings } = await import(
      "../src/lib/providers/gateway"
    );

    const fetchSpy = vi.mocked(globalThis.fetch);
    const { providers, projects } = await (
      await GET({ nextUrl: new URL("http://localhost/x") } as never)
    ).json();

    const settings = getSettings();

    for (const h of providers) {
      expect(h.configured).toBe(isProviderUsable(realProvider(settings, h.id), settings));
      if (!h.configured) expect(h.reachable).toBeNull();
    }
    // Unconfigured providers are never probed: the fetch count must equal
    // the usable count exactly (merged defaults make the keyless locals
    // ollama/lmstudio/vllm plus groq and cloudflare-ai usable here).
    const usableIds = providers
      .filter((h: { configured: boolean }) => h.configured)
      .map((h: { id: string }) => h.id);
    expect(usableIds).toContain("lmstudio"); // merged from the default catalog
    expect(usableIds).not.toContain("openai"); // placeholder key
    expect(usableIds).not.toContain("custom"); // no base URL
    expect(fetchSpy.mock.calls.length).toBe(usableIds.length);

    // The dashboard's fallback-warning story matches the resolver: the only
    // pin on this settings file would be honored → pinBroken false everywhere.
    expect(projects.every((p: { pinBroken: boolean }) => p.pinBroken === false)).toBe(true);
  });

  it("a dead pinned endpoint flips pinBroken — matching resolveGenerationFor's fallback", async () => {
    // Rewrite settings so a project is pinned to Groq (usable but every
    // fetch fails → unreachable). The resolver would fall back; the
    // dashboard must say exactly that.
    const settings = seedSettings();
    const { createProject, setProjectModelOverride } = await import("../src/lib/store");
    const project = createProject("Broken pin", "");
    setProjectModelOverride(project.id, {
      providerId: "groq",
      modelId: "llama-3.3-70b-versatile",
    });
    writeProvidersJson(settings);

    const { GET } = await import("../src/app/api/providers/health/route");
    const { projects } = await (
      await GET({ nextUrl: new URL("http://localhost/x") } as never)
    ).json();

    const pinned = projects.find(
      (p: { projectId: string }) => p.projectId === project.id,
    );
    expect(pinned.source).toBe("project");
    expect(pinned.pinBroken).toBe(true);
  });
});

describe("templates route — the gallery's providerReady flag", () => {
  it("configured equals resolveGenerationFor succeeding", async () => {
    const { GET } = await import("../src/app/api/templates/route");
    const { resolveGenerationFor } = await import("../src/lib/providers/gateway");

    const data = await (await GET()).json();
    let wouldResolve = true;
    try {
      await resolveGenerationFor();
    } catch {
      wouldResolve = false;
    }
    expect(data.configured).toBe(wouldResolve);
    expect(data.configured).toBe(true);
  });
});
