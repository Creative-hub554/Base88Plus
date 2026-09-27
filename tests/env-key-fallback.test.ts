/**
 * Env-key fallback chain, unit-tested at the gateway boundary.
 *
 * `applyEnvKeyFallback` (reached through getSettings) must fold
 * `<ID>_API_KEY` env vars into the matching provider as a real key —
 * this is what gives the builder a cloud fallback model without
 * touching the UI — and `isPlaceholderKey` must keep placeholder or
 * otherwise bogus values from ever marking a provider configured (the
 * drift documented in the gateway: placeholder "PASTE_…" values counted
 * as configured twice before).
 *
 * The chain is exercised through the real merge: getSettings reads a
 * minimal providers.json from a temp cwd, the built-in catalog merges
 * in, and the env fallback runs on top — exactly the production path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getSettings,
  isPlaceholderKey,
  providerApiKey,
  clearReachabilityCache,
} from "../src/lib/providers/gateway";

/** Real-shaped OpenRouter key: correct prefix, >=20 chars, not "paste…". */
const REAL_SHAPED_KEY = "sk-or-v1-" + "a".repeat(40);
const SAVED_KEY = "sk-or-v1-" + "b".repeat(40);

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "TOGETHER_API_KEY",
];

function writeSettingsFile(json: unknown) {
  fs.writeFileSync(
    path.join(tmpDir, "providers.json"),
    JSON.stringify(json, null, 2),
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-envfallback-"));
  vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  // Hermetic regardless of the machine's own env vars.
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  clearReachabilityCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  clearReachabilityCache();
});

describe("isPlaceholderKey", () => {
  it("rejects the shipped placeholder shapes", () => {
    expect(isPlaceholderKey("sk-or-v1-you...here")).toBe(true); // 19 chars
    expect(isPlaceholderKey("PASTE_GROQ_KEY")).toBe(true);
    expect(isPlaceholderKey("paste_your_key_here_really_long")).toBe(true);
  });

  it("accepts real-shaped keys", () => {
    expect(isPlaceholderKey(REAL_SHAPED_KEY)).toBe(false);
  });
});

describe("applyEnvKeyFallback (via getSettings)", () => {
  it("folds a real env key into the matching provider and marks it configured", () => {
    writeSettingsFile({ providers: [] });
    process.env.OPENROUTER_API_KEY = REAL_SHAPED_KEY;

    const settings = getSettings();
    const openrouter = settings.providers.find((p) => p.id === "openrouter");

    expect(openrouter).toBeDefined();
    expect(openrouter?.configured).toBe(true);
    expect(openrouter?.apiKey).toBe(REAL_SHAPED_KEY);
    expect(providerApiKey(openrouter!, settings)).toBe(REAL_SHAPED_KEY);
  });

  it("ignores placeholder env values — provider stays unconfigured", () => {
    writeSettingsFile({ providers: [] });
    process.env.GROQ_API_KEY = "PASTE_GROQ_KEY";

    const settings = getSettings();
    const groq = settings.providers.find((p) => p.id === "groq");

    expect(groq?.configured).toBe(false);
    expect(providerApiKey(groq!, settings)).toBeUndefined();
  });

  it("never overrides a key saved in the settings file", () => {
    writeSettingsFile({
      providers: [{ id: "openrouter", apiKey: SAVED_KEY }],
    });
    process.env.OPENROUTER_API_KEY = REAL_SHAPED_KEY;

    const settings = getSettings();
    const openrouter = settings.providers.find((p) => p.id === "openrouter");

    expect(openrouter?.apiKey).toBe(SAVED_KEY);
  });

  it("leaves providers without a matching env var untouched", () => {
    writeSettingsFile({ providers: [] });
    process.env.OPENROUTER_API_KEY = REAL_SHAPED_KEY;

    const settings = getSettings();
    const groq = settings.providers.find((p) => p.id === "groq");

    expect(groq?.configured).toBe(false);
  });
});
