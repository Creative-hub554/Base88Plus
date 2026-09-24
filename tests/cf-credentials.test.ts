/**
 * Unit tests for the single Cloudflare-credentials helpers.
 *
 * `cfCredentials` is THE definition of "Cloudflare is connected" (used by
 * the AI gateway, the liveness probe, deploy, domains, and connect-status
 * routes); `providerApiKey` is THE key-selection rule (own key first,
 * deploy-token reuse for Workers AI only). These tests pin their contracts
 * so no route can reintroduce a drifted copy — the exact failure mode that
 * produced the mangled `{account}` URL bug.
 *
 * Both helpers are pure functions of the settings object — no filesystem
 * or environment needed.
 */
import { describe, expect, it, vi } from "vitest";
import type { Settings } from "../src/lib/types";

const ACCOUNT = "aaaaaaaabbbbbbbbccccccccdddddddd";
const REAL_TOKEN = "cf-real-token-1234567890abcdef";
const DEPLOY_TOKEN = "cf-deploy-token-1234567890";

function settingsWith(cloudflare: Settings["cloudflare"]): Settings {
  return { providers: [], cloudflare };
}

async function freshGateway() {
  vi.resetModules();
  return import("../src/lib/providers/gateway");
}

describe("cfCredentials — the one definition of connected", () => {
  it("accepts an account id + real token, trimming whitespace", async () => {
    const { cfCredentials } = await freshGateway();
    expect(
      cfCredentials(settingsWith({ accountId: ` ${ACCOUNT} `, apiKey: REAL_TOKEN })),
    ).toEqual({ accountId: ACCOUNT, apiKey: REAL_TOKEN });
  });

  it("rejects a missing or blank account id (token alone is not enough)", async () => {
    const { cfCredentials } = await freshGateway();
    expect(cfCredentials(settingsWith({ apiKey: REAL_TOKEN }))).toBeNull();
    expect(cfCredentials(settingsWith({ accountId: "   ", apiKey: REAL_TOKEN }))).toBeNull();
  });

  it("rejects placeholder or too-short tokens", async () => {
    const { cfCredentials } = await freshGateway();
    expect(
      cfCredentials(settingsWith({ accountId: ACCOUNT, apiKey: "PASTE_YOUR_KEY_HERE" })),
    ).toBeNull();
    expect(
      cfCredentials(settingsWith({ accountId: ACCOUNT, apiKey: "short" })),
    ).toBeNull();
  });

  it("rejects a missing token or missing cloudflare block", async () => {
    const { cfCredentials } = await freshGateway();
    expect(cfCredentials(settingsWith({ accountId: ACCOUNT }))).toBeNull();
    expect(cfCredentials(settingsWith(undefined))).toBeNull();
  });
});

describe("providerApiKey — the one key-selection rule", () => {
  const cfSettings = settingsWith({ accountId: ACCOUNT, apiKey: DEPLOY_TOKEN });

  it("prefers the provider's own real key", async () => {
    const { providerApiKey } = await freshGateway();
    expect(
      providerApiKey(
        { id: "openai", apiKey: "sk-own-real-key-1234567890" },
        cfSettings,
      ),
    ).toBe("sk-own-real-key-1234567890");
  });

  it("falls back to the deploy token for Workers AI only", async () => {
    const { providerApiKey } = await freshGateway();
    expect(providerApiKey({ id: "cloudflare-ai" }, cfSettings)).toBe(DEPLOY_TOKEN);
    // Other providers must NOT inherit the Cloudflare token.
    expect(providerApiKey({ id: "groq" }, cfSettings)).toBeUndefined();
  });

  it("ignores a placeholder own-key and still reuses the CF token for Workers AI", async () => {
    const { providerApiKey } = await freshGateway();
    expect(
      providerApiKey(
        { id: "cloudflare-ai", apiKey: "PASTE_YOUR_KEY_HERE" },
        cfSettings,
      ),
    ).toBe(DEPLOY_TOKEN);
  });

  it("returns undefined when no credentials exist at all", async () => {
    const { providerApiKey } = await freshGateway();
    expect(
      providerApiKey({ id: "cloudflare-ai" }, settingsWith(undefined)),
    ).toBeUndefined();
  });
});

const cfSettings = settingsWith({ accountId: ACCOUNT, apiKey: DEPLOY_TOKEN });

describe("hasProviderCredentials / isProviderUsable — the one usability gate", () => {
  it("counts a real key as credentials, a placeholder key as none", async () => {
    const { hasProviderCredentials } = await freshGateway();
    expect(
      hasProviderCredentials({ id: "openai", apiKey: "sk-real-key-1234567890" }, cfSettings),
    ).toBe(true);
    // The drifted routes counted this as configured — must stay false.
    expect(
      hasProviderCredentials({ id: "openai", apiKey: "PASTE_YOUR_KEY_HERE" }, cfSettings),
    ).toBe(false);
  });

  it("treats keyless providers as credentialed, incl. Workers AI via deploy token", async () => {
    const { hasProviderCredentials } = await freshGateway();
    expect(hasProviderCredentials({ id: "ollama" }, cfSettings)).toBe(true);
    expect(hasProviderCredentials({ id: "custom" }, cfSettings)).toBe(true);
    expect(hasProviderCredentials({ id: "cloudflare-ai" }, cfSettings)).toBe(true);
    // Groq with no key does not inherit the CF token.
    expect(hasProviderCredentials({ id: "groq" }, cfSettings)).toBe(false);
  });

  it("requires a base URL for full usability but not for credentials", async () => {
    const { isProviderUsable } = await freshGateway();
    expect(
      isProviderUsable({ id: "custom", baseURL: "" } as never, cfSettings),
    ).toBe(false);
    expect(
      isProviderUsable({ id: "custom", baseURL: "http://x" } as never, cfSettings),
    ).toBe(true);
  });
});

describe("listProviderModels — the one catalog-fetch contract", () => {
  it("skips unconfigured providers with the standard error note", async () => {
    const { listProviderModels } = await freshGateway();
    const out = await listProviderModels(
      { id: "groq", baseURL: "https://api.groq.com/openai/v1" } as never,
      settingsWith(undefined),
    );
    expect(out).toEqual({ models: [], error: "No API key configured" });
  });

  it("skips an un-expanded {account} URL without fetching", async () => {
    const { listProviderModels } = await freshGateway();
    // cloudflare-ai with no creds fails the credential check first; the
    // URL guard is pinned via a keyless provider carrying a templated URL.
    const out = await listProviderModels(
      {
        id: "custom",
        baseURL: "https://gw.example/v4/accounts/{account}/ai/v1",
      } as never,
      cfSettings,
    );
    expect(out).toEqual({ models: [] });
  });
});
