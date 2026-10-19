/**
 * Facts for the providers that publish none.
 *
 * The picker reads each provider's own GET /models, and most of them answer
 * with bare ids: OpenAI, Anthropic, Gemini and Groq say nothing about a
 * model's context window or its price. Those numbers come from
 * [models.dev](https://models.dev) (MIT, keyless, one public document —
 * nothing about this machine or this user goes with the request), and every
 * row they produce carries `source: "models.dev"` so the UI can say where a
 * number came from. A curated third-party number is not the same claim as
 * the provider's own, and the interface is not allowed to blur them.
 *
 * THE MAPPING IS DECLARED, NEVER GUESSED (MODEL_FACTS_SOURCES). Our provider
 * id maps to exactly one dataset provider key, and a model id then has to
 * match EXACTLY. There is no normalisation, no prefix stripping, no
 * case-folding, and no scanning of the dataset's 226 providers for
 * something that looks close. A confidently displayed wrong price is worse
 * than no price, so an id nobody declared stays factless — which is also
 * what a provider that publishes nothing looks like, and that is fine.
 *
 * A dataset failure is deliberately invisible: the facts are then absent in
 * exactly the way they are for a provider that publishes none, and the
 * catalog route already has one error channel (the provider's) which this
 * must not crowd. It is remembered, though, so the multi-megabyte document
 * is not re-fetched on every picker open while the host is down.
 */

import { modelMetadataFrom, type ModelMetadata } from "../models-catalog";

/**
 * Our provider id → its models.dev provider key.
 *
 * Declared from a probe rather than from a hunch (2026-10-10): of the
 * dataset's 226 providers, these keys exist, and for openai / anthropic /
 * google / groq / mistral / cohere / perplexity / nvidia / deepinfra /
 * siliconflow / qwen / z-ai / minimax / huggingface / upstage / azure the
 * dataset holds our registry's own default model for that provider
 * verbatim — which is the evidence that a shared id space is real and not
 * assumed. The remaining entries (deepseek, xai, cerebras, nebius, ai21,
 * cloudflare-ai) are mapped because the dataset's ids for them are in the
 * provider's own namespace (deepseek-v4-flash, grok-4.7, @cf/...), verified
 * by inspection; a mapping that stops matching simply stops producing facts.
 *
 * Every key here has to be an id the registry actually ships, and
 * tests/model-facts.test.ts checks that against DEFAULT_PROVIDERS — a table
 * keyed "z-ai" while the registry says "zai" would have looked fine and
 * delivered nothing, which is exactly what a live probe caught once.
 *
 * NOT mapped, and the reason: together, fireworks, bedrock, sambanova,
 * moonshot, novita, ollama, vllm (no dataset provider key at all), and
 * lmstudio (the dataset holds 3 rows under file-style names, which is not
 * the same id space an LM Studio user's own /models returns).
 */
export const MODEL_FACTS_SOURCES: Readonly<Record<string, string>> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  groq: "groq",
  mistral: "mistral",
  deepseek: "deepseek",
  xai: "xai",
  cohere: "cohere",
  perplexity: "perplexity",
  cerebras: "cerebras",
  nebius: "nebius",
  ai21: "ai21",
  upstage: "upstage",
  zai: "zai",
  minimax: "minimax",
  nvidia: "nvidia",
  deepinfra: "deepinfra",
  siliconflow: "siliconflow",
  huggingface: "huggingface",
  azure: "azure",
  "cloudflare-ai": "cloudflare-workers-ai",
  qwen: "alibaba",
};

const DATASET_URL = "https://models.dev/api.json";
/** The dataset is a slow-moving catalogue; an in-memory copy lives a day. */
const FACTS_TTL_MS = 12 * 60 * 60_000;
/**
 * How long a failed attempt is remembered. Much longer than the catalog's
 * window: the retry costs a multi-megabyte document, not one provider's
 * model list.
 */
const FACTS_FAILURE_TTL_MS = 10 * 60_000;
/** Several megabytes deserve more room than a model list does. */
const FACTS_TIMEOUT_MS = 15_000;

/** Rows keyed "providerId::modelId" — the lookup the merge needs. */
let facts = new Map<string, ModelMetadata>();
/** Epoch ms of the successful load behind `facts`; null = nothing loaded. */
let loadedAt: number | null = null;
/** Inside failure memory while now < retryAt. */
let retryAt = 0;
/** The one fetch in flight, so concurrent opens cannot double-download. */
let inFlight: Promise<Map<string, ModelMetadata>> | null = null;

/** Drop the loaded document (tests; never needed for a credential change —
 *  this document does not depend on any credential or endpoint). */
export function clearModelFactsCache() {
  facts = new Map();
  loadedAt = null;
  retryAt = 0;
}

/**
 * Whether we would ask the dataset about this provider at all. False for
 * the providers the table leaves out, which is what keeps an OpenRouter-only
 * setup (every model already carries its provider's own facts) from ever
 * downloading the document.
 */
export function hasModelFactsSource(providerId: string): boolean {
  return Boolean(MODEL_FACTS_SOURCES[providerId]);
}

/**
 * What the dataset says about one model, or undefined — from memory only.
 * This is the read the catalog route uses, and it never waits: a picker must
 * not block on it, so the first open after a cold start shows ids and the
 * fetch warms the rows for the next one.
 */
export function modelFactsFor(
  providerId: string,
  modelId: string,
): ModelMetadata | undefined {
  return facts.get(`${providerId}::${modelId}`);
}

/**
 * Ask for a load when the memory is missing or expired — the one entry point
 * a route should use, and safe to call from anywhere: the freshness and
 * failure checks below collapse it to at most one fetch per window, and
 * callers that would gain nothing from the document (a catalog whose every
 * model already carries its provider's own facts) simply do not call it.
 *
 * Fire-and-forget: the return value is the shared load for anyone who wants
 * to await it (tests, a probe that may as well wait), and null when nothing
 * was started — either the memory is fresh, a failure is still remembered,
 * or another load is already running, whose promise is returned instead.
 */
export function warmModelFacts(): Promise<Map<string, ModelMetadata>> | null {
  if (inFlight) return inFlight;
  const now = Date.now();
  if (loadedAt !== null && now - loadedAt < FACTS_TTL_MS) return null;
  if (now < retryAt) return null;
  const load = refreshModelFacts().finally(() => {
    // Only the owner clears the slot: a concurrent warm shares this promise.
    if (inFlight === load) inFlight = null;
  });
  inFlight = load;
  return load;
}

/**
 * The load itself, awaitable so tests and probes can drive it without
 * relying on a background promise — and deliberately NOT the single-flight
 * entry point, which is warmModelFacts: this one always goes and looks.
 * Never throws: a failed attempt leaves the previous rows in place (they are
 * still the best answer available, and the TTL expiry already decides how
 * long that is acceptable).
 */
export async function refreshModelFacts(): Promise<Map<string, ModelMetadata>> {
  try {
    const res = await fetch(DATASET_URL, {
      signal: AbortSignal.timeout(FACTS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const document_ = (await res.json()) as unknown;
    facts = projectModelFacts(document_);
    loadedAt = Date.now();
    retryAt = 0;
  } catch {
    retryAt = Date.now() + FACTS_FAILURE_TTL_MS;
  }
  return facts;
}

/**
 * The dataset's 226 providers and 8,456 models, reduced to the declared
 * mapping and the fields the UI can actually show. Measured 2026-10-10:
 * 759 rows and 162 KB of kept facts, projected in ~50 ms, out of a document
 * that also measured 4.1 MB minutes earlier and 5.4 MB later — the CDN's copy
 * moves, which is one more reason to keep only what is declared. Everything
 * not in the mapping is dropped and left to be collected, so what stays in
 * memory is a picker's worth of facts, not a catalogue.
 */
export function projectModelFacts(
  document_: unknown,
): Map<string, ModelMetadata> {
  const projected = new Map<string, ModelMetadata>();
  if (!document_ || typeof document_ !== "object") return projected;
  const providers = document_ as Record<string, { models?: unknown } | undefined>;

  for (const [providerId, datasetKey] of Object.entries(MODEL_FACTS_SOURCES)) {
    const models = providers[datasetKey]?.models;
    if (!models || typeof models !== "object") continue;
    for (const [modelId, row] of Object.entries(
      models as Record<string, unknown>,
    )) {
      const published = datasetRow(row);
      // The dataset keys its models by id; an entry with no usable fact is
      // dropped rather than stored as an empty row.
      if (published) projected.set(`${providerId}::${modelId}`, published);
    }
  }
  return projected;
}

interface DatasetRow {
  name?: unknown;
  limit?: { context?: unknown; output?: unknown } | null;
  cost?: { input?: unknown; output?: unknown } | null;
  modalities?: { input?: unknown } | null;
  tool_call?: unknown;
}

function datasetRow(row: unknown): ModelMetadata | undefined {
  if (!row || typeof row !== "object") return undefined;
  const m = row as DatasetRow;
  return modelMetadataFrom({
    source: "models.dev",
    name: m.name,
    // A dataset row commonly carries `limit: { context: 0, output: 0 }` for a
    // model it has no window for (every OpenAI image model, for one) — the
    // shared rules turn that back into "not published".
    contextLength: m.limit?.context,
    maxCompletionTokens: m.limit?.output,
    // models.dev publishes USD per million tokens, the unit the row wants.
    pricePerMTokInput: m.cost?.input,
    pricePerMTokOutput: m.cost?.output,
    inputModalities: m.modalities?.input,
    supportsTools: m.tool_call,
  });
}
