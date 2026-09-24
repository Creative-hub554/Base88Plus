import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ProviderConfig, Settings } from "../types";
import { getProject, listProjects } from "../store";
import { cloudflareApiBase } from "../deploy/cloudflare";
import { fetchModels } from "../models-catalog";
import { DEFAULT_PROVIDERS } from "./registry";

const SETTINGS_FILE = "providers.json";

// ---------------------------------------------------------------------------
// Settings persistence (BYOK — keys stay on the local machine)
// ---------------------------------------------------------------------------

export function getSettings(): Settings {
  let settings: Settings;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const raw = fs.readFileSync(
      path.join(process.cwd(), SETTINGS_FILE),
      "utf8",
    );
    settings = JSON.parse(raw) as Settings;
  } catch {
    settings = { providers: [] };
  }
  // Merge the built-in catalog into whatever is on disk: newly shipped
  // providers must appear for existing users, while user-edited entries
  // (keys, base URLs, models) win over defaults. ORDER: user-configured
  // entries come FIRST — the fallback resolver walks this list in order,
  // and a keyless built-in (e.g. ollama) that happens to be down would
  // otherwise shadow a user's explicitly-configured cloud provider
  // (observed: fallback picked unreachable localhost ollama over a
  // healthy configured secondary because its failed probe "serves
  // anything").
  const defaults = DEFAULT_PROVIDERS.map((p) => ({ ...p }));
  const saved = settings.providers ?? [];
  const merged = defaults.map((d) => {
    const existing = saved.find((p) => p.id === d.id);
    return existing ? { ...d, ...existing } : d;
  });
  for (const extra of saved) {
    if (!merged.some((p) => p.id === extra.id)) {
      merged.push(extra);
    }
  }  // User-saved entries first (preserving their saved order), then the
  // remaining never-configured built-ins.
  const savedIds = new Set(saved.map((p) => p.id));
  settings.providers = [
    ...saved.map(
      (p) => merged.find((m) => m.id === p.id)!,
    ),
    ...merged.filter((m) => !savedIds.has(m.id)),
  ];
  return applyEnvKeyFallback(settings);
}

/**
 * Env vars always act as a per-provider key fallback, even when a saved
 * settings file exists — otherwise saving settings once would orphan
 * env-configured providers.
 */
function applyEnvKeyFallback(settings: Settings): Settings {
  for (const provider of settings.providers) {
    if (!provider.apiKey) {
      const envKey = process.env[`${provider.id.toUpperCase()}_API_KEY`];
      if (envKey && !isPlaceholderKey(envKey)) {
        provider.apiKey = envKey;
        provider.configured = true;
      }
    }
  }
  return settings;
}

/**
 * Placeholder/obviously-bogus keys ("PASTE_YOUR_KEY_HERE", truncated values)
 * must not mark a provider as configured — otherwise the gateway silently
 * routes requests to a provider that can never authenticate.
 */
export function isPlaceholderKey(value: string): boolean {
  return value.length < 20 || /^paste[_-]/i.test(value);
}

// ---------------------------------------------------------------------------
// Cloudflare credentials — one source of truth
// ---------------------------------------------------------------------------

/**
 * The stored Cloudflare credentials when they can actually authenticate:
 * an account id AND a real (non-placeholder) API token. This is the single
 * definition of "Cloudflare is connected" — the deploy token doubles as
 * the Workers AI token (credential reuse), so the AI side and the deploy
 * side can never disagree about what counts as connected.
 */
export function cfCredentials(
  settings: Settings,
): { accountId: string; apiKey: string } | null {
  const cf = settings.cloudflare;
  if (!cf?.accountId?.trim() || !cf.apiKey || isPlaceholderKey(cf.apiKey)) {
    return null;
  }
  return { accountId: cf.accountId.trim(), apiKey: cf.apiKey };
}

/**
 * The API key a provider's requests should carry: its own real (non-
 * placeholder) key when set, otherwise the Cloudflare deploy token for
 * Workers AI only. One definition so every fetch site — the adapter,
 * liveness probes, model catalogs — picks the same key. (Env-var fallbacks
 * are already folded into `provider.apiKey` by `applyEnvKeyFallback`.)
 */
export function providerApiKey(
  p: Pick<ProviderConfig, "id" | "apiKey">,
  settings: Settings,
): string | undefined {
  if (p.apiKey && !isPlaceholderKey(p.apiKey)) return p.apiKey;
  if (p.id === "cloudflare-ai") return cfCredentials(settings)?.apiKey;
  return undefined;
}

export function saveSettings(settings: Settings) {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  fs.writeFileSync(
    path.join(process.cwd(), SETTINGS_FILE),
    JSON.stringify(settings, null, 2),
  );
}

/**
 * The cached workers.dev subdomain from the deploy connection, if any.
 * Read-only accessor so routes never reach into `settings.cloudflare` for
 * display values — the credentials writer (deploy settings route) is the
 * only other legitimate touchpoint.
 */
export function cfSubdomain(settings: Settings): string | undefined {
  return settings.cloudflare?.subdomain || undefined;
}

/**
 * The client-safe settings shape: API keys never leave the server, and
 * `configured` mirrors the resolver's real gate. Used by both the GET and
 * POST settings routes so redaction cannot drift between them.
 */
export function redactSettings(settings: Settings) {
  return {
    ...settings,
    cloudflare: settings.cloudflare
      ? { ...settings.cloudflare, apiKey: undefined }
      : undefined,
    providers: settings.providers.map((p) => ({
      ...p,
      apiKey: undefined,
      configured: isProviderUsable(p, settings),
    })),
  };
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

export class ProviderError extends Error {}

/**
 * Detect free-tier quota exhaustion (Cloudflare Workers AI daily neuron
 * cap and similar provider-side rate/credit errors) so the chat can offer
 * a friendly fallback instead of a raw provider error.
 *
 * The AI SDK often wraps provider errors in an AggregateError (its retry
 * layer — 429s are retryable), so classification recurses into `errors`,
 * `lastError` and `cause`, and matches on message + provider response body
 * (where quota wording actually lives).
 */
export function isQuotaError(err: unknown, depth = 0): boolean {
  if (!err || depth > 4) return false;
  const e = err as {
    message?: unknown;
    responseBody?: unknown;
    text?: unknown;
    statusCode?: unknown;
    errors?: unknown[];
    lastError?: unknown;
    cause?: unknown;
  };
  const text = [
    typeof e.message === "string" ? e.message : "",
    typeof e.responseBody === "string" ? e.responseBody : "",
    typeof e.text === "string" ? e.text : "",
    e.statusCode === 429 ? "429" : "",
  ]
    .join("\n")
    .toLowerCase();
  if (
    /quota|neuron|daily limit|rate limit|usage limit|exceeded|insufficient|credit|429/.test(
      text,
    )
  ) {
    return true;
  }
  return [
    ...(Array.isArray(e.errors) ? e.errors : []),
    e.lastError,
    e.cause,
  ].some((inner) => isQuotaError(inner, depth + 1));
}

/**
 * Next usable generation after some providers were excluded (e.g. a
 * free-tier quota was hit): the same resolution order — active model,
 * then any configured provider — skipping `exclude` ids, and verifying
 * the candidate's model actually exists before returning it (a fallback
 * whose default model isn't served would just fail a second time).
 * Returns null when nothing else is available.
 */
export async function resolveFallbackGeneration(
  exclude: string[],
): Promise<ResolvedGeneration | null> {
  const settings = getSettings();
  const candidates = [
    settings.activeProviderId,
    ...settings.providers.map((p) => p.id),
  ].filter((id): id is string => Boolean(id)).filter((id) => !exclude.includes(id));

  for (const providerId of candidates) {
    const provider = settings.providers.find((p) => p.id === providerId);
    if (!provider) continue;
    if (!isProviderUsable(provider, settings)) continue;
    const modelId =
      providerId === settings.activeProviderId
        ? settings.activeModel || provider.defaultModel
        : provider.defaultModel;
    try {
      const resolved = {
        model: resolveModel(providerId, modelId, settings),
        providerId,
        providerName: provider.name,
        modelId,
      };
      if (await providerServesModel(provider, modelId, settings)) {
        return resolved;
      }
      // Endpoint alive but doesn't list this model — try to pick one it
      // does serve so the fallback actually works (local servers expose
      // whatever is installed; cloud APIs list their catalog).
      const replacement = await pickServedModel(provider, settings);
      if (replacement) {
        return {
          model: resolveModel(providerId, replacement, settings),
          providerId,
          providerName: provider.name,
          modelId: replacement,
        };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Best-effort check that `modelId` is actually served by the provider's
 * /models endpoint. Skipped for the `custom` provider (arbitrary gateways
 * need not implement listing) and treated as satisfied when the endpoint
 * doesn't list models at all (some local servers) — we only fail the
 * candidate when we positively see a catalog that excludes the model.
 */
async function providerServesModel(
  provider: ProviderConfig,
  modelId: string,
  settings: Settings,
): Promise<boolean> {
  if (provider.id === "custom") return true;
  // No catalog / listing failed / provider unconfigured → allow; the real
  // request reports any genuine problem.
  const { models, error } = await listProviderModels(provider, settings);
  if (error || models.length === 0) return true;
  return models.includes(modelId);
}

/**
 * Pick a model the provider actually serves, preferring its configured
 * default when listed, otherwise the first catalog entry that plausibly
 * fits code generation. Returns null when nothing suitable is listed.
 */
async function pickServedModel(
  provider: ProviderConfig,
  settings: Settings,
): Promise<string | null> {
  const { models, error } = await listProviderModels(provider, settings);
  if (error || models.length === 0) return null;
  if (provider.defaultModel && models.includes(provider.defaultModel)) {
    return provider.defaultModel;
  }
  // Prefer a code-capable entry when one is listed (local Ollama often
  // has a mix of general and coder models).
  const coder = models.find((m) => /coder|code|qwen|deepseek|starcoder/i.test(m));
  return coder ?? models[0];
}

/**
 * Build a LanguageModel for any configured provider. Every provider —
 * official or user-added — flows through this single function, which is
 * what makes the platform provider-agnostic.
 */
export function resolveModel(
  providerId: string,
  modelId: string,
  settings: Settings,
): LanguageModel {
  const provider = settings.providers.find((p) => p.id === providerId);
  if (!provider) {
    throw new ProviderError(`Unknown provider "${providerId}".`);
  }
  if (provider.kind !== "openai-compatible" && provider.kind !== "openai") {
    throw new ProviderError(`Unsupported provider kind "${provider.kind}".`);
  }
  let baseURL = provider.baseURL;
  // One key-selection rule (own key → CF deploy-token reuse for Workers AI).
  let apiKey = providerApiKey(provider, settings);

  // Cloudflare Workers AI: the deploy token IS the AI token (same API
  // token permissions cover both). Substitute the stored account id into
  // the base URL. Honors CLOUDFLARE_API_BASE so tests can point it at a
  // mock.
  if (providerId === "cloudflare-ai") {
    const expanded = effectiveBaseURL(provider, settings);
    if (expanded !== provider.baseURL) {
      baseURL = expanded;
    }
  }

  if (hasUnexpandedAccount(baseURL)) {
    throw new ProviderError(
      `Cloudflare Workers AI needs your account id. Connect Deploy (publish panel → Deploy to Cloudflare) or paste an API token in Settings → AI Providers.`,
    );
  }
  if (!baseURL) {
    throw new ProviderError(
      `Provider "${provider.name}" has no base URL configured. Set it in Settings → AI Providers.`,
    );
  }
  if (!apiKey && !isKeyless(provider, settings)) {
    throw new ProviderError(
      `No API key configured for "${provider.name}". Add one in Settings → AI Providers (BYOK) or set ${provider.id.toUpperCase()}_API_KEY.`,
    );
  }

  // All providers — including OpenAI proper — go through the generic
  // OpenAI-compatible adapter. One code path, zero vendor SDK churn.
  return createOpenAICompatible({
    name: provider.id,
    baseURL,
    apiKey,
    headers: provider.headers,
  })(modelId || provider.defaultModel);
}

/**
 * Providers that work without any API key: local servers, the custom
 * catch-all, and Cloudflare Workers AI when deploy credentials exist
 * (credential reuse — see resolveModel). Single source of truth used by
 * the gateway and every catalog/pin route.
 */
export function isKeyless(
  p: { id: string },
  settings?: Settings,
): boolean {
  if (
    p.id === "ollama" ||
    p.id === "lmstudio" ||
    p.id === "vllm" ||
    p.id === "custom"
  ) {
    return true;
  }
  if (p.id === "cloudflare-ai") {
    const cf = settings?.cloudflare ?? getSettings().cloudflare;
    return Boolean(cf?.apiKey && !isPlaceholderKey(cf.apiKey));
  }
  return false;
}

// NOTE: isKeyless above is intentionally narrower than cfCredentials — it
// answers "has a token" for resolution-order candidates; full usability
// (account id + token + base URL) goes through isProviderUsable below.
// Together with cfCredentials/cfSubdomain/redactSettings, these functions
// own ALL settings.cloudflare access in the codebase — routes must import
// them, never read the field directly (tests/architecture-cloudflare-
// access.test.ts enforces this).

export interface ResolvedGeneration {
  model: LanguageModel;
  providerId: string;
  providerName: string;
  modelId: string;
}

/**
 * Resolve the model for a specific project: a per-project pin (set from the
 * builder header) wins; otherwise the global default from the model picker
 * is used. If the pinned provider/model is unavailable (provider removed,
 * key cleared), fall back to the global resolution.
 */
export async function resolveGenerationFor(projectId?: string): Promise<{
  resolved: ResolvedGeneration;
  source: "project" | "global" | "fallback";
}> {
  if (projectId) {
    const project = getProject(projectId);
    const pin = project?.modelOverride;
    if (pin?.providerId && pin?.modelId) {
      const settings = getSettings();
      const provider = settings.providers.find((p) => p.id === pin.providerId);
      if (provider && isProviderUsable(provider, settings)) {
        if (await isProviderReachable(provider, settings)) {
          return {
            resolved: {
              model: resolveModel(pin.providerId, pin.modelId, settings),
              providerId: provider.id,
              providerName: provider.name,
              modelId: pin.modelId,
            },
            source: "project",
          };
        }
      }
      // Pinned but unusable (removed, unconfigured, or endpoint down) →
      // global fallback.
      return { resolved: resolveActiveModel(), source: "fallback" };
    }
  }
  return { resolved: resolveActiveModel(), source: "global" };
}

/**
 * Cheap liveness check for pinned providers: the OpenAI-compatible adapter
 * builds lazily, so a dead endpoint would otherwise only fail mid-generation.
 * Any HTTP response means the endpoint is alive; network errors don't.
 * Results are cached briefly so pinned chats don't probe on every message.
 */
const reachabilityCache = new Map<
  string,
  { alive: boolean; at: number }
>();
const REACHABILITY_TTL_MS = 30_000;

/** Drop cached probe verdicts (dashboard "Re-check now", tests). */
export function clearReachabilityCache() {
  reachabilityCache.clear();
}

/**
 * Effective base URL for a provider — the stored baseURL with the
 * Cloudflare Workers AI credential expansion applied. Shared by the
 * adapter and the liveness probe so both hit the same host.
 */
export function effectiveBaseURL(
  provider: ProviderConfig,
  settings: Settings,
): string {
  let baseURL = provider.baseURL;
  if (provider.id === "cloudflare-ai") {
    const cf = cfCredentials(settings);
    if (cf) {
      return `${cloudflareApiBase()}/accounts/${cf.accountId}/ai/v1`;
    }
  }
  return baseURL;
}

async function isProviderReachable(
  provider: ProviderConfig,
  settings: Settings,
): Promise<boolean> {
  // Use the resolved URL (with account id substituted) — probing the raw
  // `{account}` template would hit the wrong host entirely.
  const baseURL = effectiveBaseURL(provider, settings);
  if (!baseURL || hasUnexpandedAccount(baseURL)) return false;
  const cached = reachabilityCache.get(provider.id);
  const now = Date.now();
  if (cached && now - cached.at < REACHABILITY_TTL_MS) return cached.alive;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  const key = providerApiKey(provider, settings);
  let alive = false;
  try {
    const url = `${baseURL.replace(/\/$/, "")}/models`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: key ? { Authorization: `Bearer ${key}` } : undefined,
    });
    // Any HTTP response means the endpoint is alive (auth/model errors are
    // surfaced later by the real request).
    alive = res.status < 600;
  } catch {
    alive = false;
  } finally {
    clearTimeout(timer);
  }
  reachabilityCache.set(provider.id, { alive, at: now });
  return alive;
}

/**
 * The credentials half of the usability gate: a real (non-placeholder) key
 * OR keyless credentials. Routes that only need "can this provider
 * authenticate" (catalogs, pin validation) must use this — never a raw
 * `Boolean(p.apiKey)`, which counts placeholder "PASTE_YOUR_KEY" values as
 * configured (the exact drift that shipped twice before).
 */
export function hasProviderCredentials(
  p: Pick<ProviderConfig, "id" | "apiKey">,
  settings: Settings,
): boolean {
  return Boolean(p.apiKey && !isPlaceholderKey(p.apiKey)) || isKeyless(p, settings);
}

/**
 * The full usability gate, shared by health reporting and resolution:
 * real credentials (see hasProviderCredentials) AND a base URL to hit
 * (resolveModel refuses to build an adapter without one).
 */
export function isProviderUsable(
  p: ProviderConfig,
  settings: Settings,
): boolean {
  return hasProviderCredentials(p, settings) && Boolean(p.baseURL?.trim());
}

/**
 * A Workers AI base URL still carrying the un-expanded `{account}`
 * template — no credentials to substitute with. Shared guard so catalogs
 * and probes refuse it identically.
 */
export function hasUnexpandedAccount(baseURL: string): boolean {
  return baseURL.includes("{account}");
}

/**
 * The live model list a provider currently serves, with the shared
 * reachability contract: unconfigured providers and un-expanded Workers AI
 * URLs are skipped (models: []), and fetch failures degrade to an `error`
 * note instead of throwing. The single definition used by both catalog
 * routes (global picker and per-project pin picker).
 */
export async function listProviderModels(
  p: ProviderConfig,
  settings: Settings,
): Promise<{ models: string[]; error?: string }> {
  if (!hasProviderCredentials(p, settings)) {
    return { models: [], error: "No API key configured" };
  }
  const baseURL = effectiveBaseURL(p, settings);
  if (!baseURL || hasUnexpandedAccount(baseURL)) {
    return { models: [] };
  }
  try {
    return {
      models: await fetchModels(baseURL, providerApiKey(p, settings)),
    };
  } catch (e) {
    return {
      models: [],
      error:
        e instanceof Error && e.name === "AbortError"
          ? "timeout"
          : "unreachable",
    };
  }
}

export interface ProviderHealth {
  id: string;
  name: string;
  configured: boolean;
  /** Endpoint answered (any HTTP response counts); null = not probed. */
  reachable: boolean | null;
  defaultModel: string;
  /** Global picker selection when this is the active provider. */
  activeModel?: string;
  kind: string;
  baseURL: string;
}

/**
 * Health state for every provider in the catalog: configured (credentials
 * present), reachable (endpoint answered — cheap cached probe), and the
 * model each would serve. Reachability probes run in parallel with a
 * per-host timeout; unconfigured providers are skipped (probing them would
 * be a guaranteed failure and, for cloud APIs, a pointless cold call).
 */
export async function getProvidersHealth(): Promise<ProviderHealth[]> {
  const settings = getSettings();
  const usable = settings.providers.filter((p) => isProviderUsable(p, settings));
  const verdicts = await Promise.all(
    usable.map((p) => isProviderReachable(p, settings)),
  );
  const reachableById = new Map(
    usable.map((p, i) => [p.id, verdicts[i]] as const),
  );
  return settings.providers.map((p) => ({
    id: p.id,
    name: p.name,
    // Mirror the resolver's real gate via isProviderUsable: a placeholder
    // key ("PASTE_YOUR_KEY…") or an empty base URL does NOT make a
    // provider usable.
    configured: isProviderUsable(p, settings),
    reachable: reachableById.get(p.id) ?? null,
    defaultModel: p.defaultModel,
    activeModel:
      p.id === settings.activeProviderId ? settings.activeModel : undefined,
    kind: p.kind,
    baseURL: p.baseURL,
  }));
}

/**
 * The model each project actually generates with: the per-project pin when
 * set, otherwise the global active provider/model.
 */
export interface ProjectModelInfo {
  projectId: string;
  projectName: string;
  updatedAt: string;
  source: "project" | "global";
  providerId: string;
  providerName: string;
  modelId: string;
  /** Pin exists but is unusable (unconfigured provider, missing model). */
  pinBroken: boolean;
}

export function getProjectModelInfo(
  reachableById?: Map<string, boolean | null>,
): ProjectModelInfo[] {
  const settings = getSettings();
  const byId = new Map(settings.providers.map((p) => [p.id, p] as const));
  const global = (() => {
    const p = settings.activeProviderId
      ? byId.get(settings.activeProviderId)
      : undefined;
    if (p && isProviderUsable(p, settings)) {
      return {
        providerId: p.id,
        providerName: p.name,
        modelId: settings.activeModel || p.defaultModel,
      };
    }
    const firstUsable = settings.providers.find((q) =>
      isProviderUsable(q, settings),
    );
    return firstUsable
      ? {
          providerId: firstUsable.id,
          providerName: firstUsable.name,
          modelId: firstUsable.defaultModel,
        }
      : null;
  })();

  return listProjects().map((project) => {
    const pin = project.modelOverride;
    if (pin) {
      const p = byId.get(pin.providerId);
      const pinUsable = Boolean(
        p && isProviderUsable(p, settings) && pin.modelId,
      );
      // The pin also can't be honored when its endpoint is down —
      // resolveGenerationFor probes before using it and falls back.
      const endpointDown = reachableById?.get(pin.providerId) === false;
      return {
        projectId: project.id,
        projectName: project.name,
        updatedAt: project.updatedAt,
        source: "project" as const,
        providerId: pin.providerId,
        providerName: p?.name ?? pin.providerId,
        modelId: pin.modelId,
        pinBroken: !pinUsable || endpointDown,
      };
    }
    return {
      projectId: project.id,
      projectName: project.name,
      updatedAt: project.updatedAt,
      source: "global" as const,
      providerId: global?.providerId ?? "—",
      providerName: global?.providerName ?? "(no provider configured)",
      modelId: global?.modelId ?? "—",
      pinBroken: false,
    };
  });
}

/** Resolve the active provider/model, falling back to the first configured provider. */
export function resolveActiveModel(): ResolvedGeneration {
  const settings = getSettings();
  const candidates = [
    settings.activeProviderId,
    ...settings.providers.map((p) => p.id),
  ].filter((id): id is string => Boolean(id));

  for (const providerId of candidates) {
    const provider = settings.providers.find((p) => p.id === providerId);
    if (!provider) continue;
    if (!isProviderUsable(provider, settings)) continue;
    const modelId = providerId === settings.activeProviderId
      ? settings.activeModel || provider.defaultModel
      : provider.defaultModel;
    try {
      return {
        model: resolveModel(providerId, modelId, settings),
        providerId,
        providerName: provider.name,
        modelId,
      };
    } catch {
      // try next candidate
    }
  }
  throw new ProviderError(
    "No AI provider is configured yet. Open Settings → AI Providers and add an API key (OpenAI, Anthropic, Gemini, Groq, OpenRouter, a local Ollama server…).",
  );
}
