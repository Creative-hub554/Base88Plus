/**
 * Provider model catalogs — the OpenAI-compatible GET /models response, and
 * the few facts a provider publishes alongside each model.
 *
 * Three contracts live here and nowhere else.
 *
 * 1. PARSING. Accepts the canonical `{ data: [{ id }] }` shape, bare
 *    arrays, and Cloudflare's envelope (`{ result: { data: [...] } }` —
 *    Workers AI). 404/405 are *not* failures: several otherwise healthy
 *    hosts simply do not implement GET /models (Amazon Bedrock documents
 *    this, and AI21 answers with an empty list), so labelling those
 *    "unreachable" would report a working provider as down. Anything else
 *    non-OK throws.
 *
 * 2. METADATA. Nothing in ModelMetadata is estimated, inferred from a model
 *    name, or copied from a table in this repository: every field is either
 *    the value the provider itself publishes for the model it serves, or a
 *    value from the models.dev dataset with `source` saying so (providers
 *    that publish nothing — OpenAI, Anthropic, Gemini, Groq — get their
 *    facts from there; see providers/model-facts.ts for the declared
 *    mapping). A model nobody publishes a fact about produces no entry, and
 *    the UI renders exactly what arrived. Today OpenRouter's catalog is the
 *    rich one (context_length, pricing, top_provider, supported_parameters
 *    all present for all 458 entries — measured, not remembered).
 *
 *    modelMetadataFrom is the one rule set both producers apply, so a fact
 *    cannot mean two different things depending on who published it. The
 *    rules: positive finite numbers only — a row saying `context: 0` is a
 *    fact nobody published, not a zero-token model — "text" dropped from
 *    modalities, and an unknown staying unknown instead of becoming `false`.
 *
 * 3. CACHING. The picker asks EVERY configured provider on EVERY open, and
 *    the builder header carries two pickers (the global one and the
 *    per-project pin), so a naive implementation spends one HTTP request
 *    per provider per page view — OpenRouter alone answers in 764 KB.
 *    readModelCatalog is the one entry point that fixes this: a fresh
 *    window, single-flight so concurrent opens share one request, memory of
 *    a failure so a dead endpoint is not re-probed on every open, and the
 *    last good catalog kept for a bounded while after a failed refresh —
 *    because a provider blip should not blank a picker that was working.
 *    `stale` says which of those you got, so the UI can be honest about it.
 */

/** Facts about one model, from whichever producer published them. */
export interface ModelMetadata {
  /**
   * Who published these facts. "provider" is the model's own provider
   * answering GET /models; "models.dev" is the open dataset that fills the
   * providers which publish nothing. A row is always exactly one of the
   * two: blending them would need per-field provenance, which the UI has no
   * way to show, so a row from one source is one coherent claim.
   */
  source: "provider" | "models.dev";
  /** The publisher's display name ("Anthropic: Claude Sonnet 4.6"). */
  name?: string;
  /** Context window in tokens, as advertised for this model. */
  contextLength?: number;
  /** Most tokens the provider will generate in one response. */
  maxCompletionTokens?: number;
  /** USD per million input tokens. */
  pricePerMTokInput?: number;
  /** USD per million output tokens. */
  pricePerMTokOutput?: number;
  /**
   * Input modalities other than text ("image", "file", "audio", "video") —
   * the provider's own list with "text" dropped, since every chat model
   * takes text and repeating it only pads the payload.
   */
  inputModalities?: string[];
  /**
   * Whether the provider lists tool/function calling. Absent when the
   * provider publishes no parameter list at all — which is not the same as
   * "supports no tools", so the difference is preserved rather than
   * flattened to `false`.
   */
  supportsTools?: boolean;
}

/** A provider's parsed catalog: sorted ids plus whatever came with them. */
export interface ModelCatalog {
  models: string[];
  metadata: Record<string, ModelMetadata>;
}

/** The parsed block a provider may attach to one model entry. */
interface RawEntry {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: unknown;
  architecture?: unknown;
  supported_parameters?: unknown;
  top_provider?: unknown;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** A positive finite number, or undefined — never NaN, never 0-by-accident. */
function positiveNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** A non-negative finite number, or undefined. Zero survives: it is "free". */
function nonNegativeNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * A price published per token → USD per million tokens, the unit this app
 * displays. Providers disagree on the JSON type (OpenRouter sends
 * "0.000003" as a string), so both are accepted. Zero is kept: it means
 * free, which is a fact worth showing, unlike an unparseable value.
 */
function perMillionTokens(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1_000_000 * 1e6) / 1e6;
}

/** The three accepted envelope shapes → the flat entry array. */
function entriesOf(json: unknown): RawEntry[] {
  if (Array.isArray(json)) return json as RawEntry[];
  const wrapped = json as { data?: unknown; result?: unknown } | null;
  if (Array.isArray(wrapped?.data)) return wrapped.data as RawEntry[];
  const result = wrapped?.result as { data?: unknown } | undefined;
  if (Array.isArray(result?.data)) return result.data as RawEntry[];
  return [];
}

/**
 * A candidate row, as each producer sees it, before the shared rules run.
 * Prices arrive ALREADY in USD per million tokens: every producer knows its
 * own unit (OpenRouter publishes per-token strings, models.dev per-million
 * numbers) and converts at its own boundary rather than leaving a unit to
 * be guessed here.
 */
export interface ModelMetadataFields {
  source: ModelMetadata["source"];
  name?: unknown;
  contextLength?: unknown;
  maxCompletionTokens?: unknown;
  pricePerMTokInput?: unknown;
  pricePerMTokOutput?: unknown;
  inputModalities?: unknown;
  supportsTools?: unknown;
}

/**
 * The ONE rule set both producers apply — a provider's own catalog and the
 * models.dev dataset — so no fact can mean two things depending on where it
 * came from. Returns undefined when nothing survived the rules: a row whose
 * only content is its provenance is not worth carrying.
 */
export function modelMetadataFrom(
  fields: ModelMetadataFields,
): ModelMetadata | undefined {
  const metadata: ModelMetadata = { source: fields.source };

  const name = nonEmptyString(fields.name);
  if (name) metadata.name = name;

  const contextLength = positiveNumber(fields.contextLength);
  if (contextLength) metadata.contextLength = contextLength;

  const maxCompletionTokens = positiveNumber(fields.maxCompletionTokens);
  if (maxCompletionTokens) metadata.maxCompletionTokens = maxCompletionTokens;

  const priceIn = nonNegativeNumber(fields.pricePerMTokInput);
  if (priceIn !== undefined) metadata.pricePerMTokInput = priceIn;
  const priceOut = nonNegativeNumber(fields.pricePerMTokOutput);
  if (priceOut !== undefined) metadata.pricePerMTokOutput = priceOut;

  if (Array.isArray(fields.inputModalities)) {
    const modalities = fields.inputModalities
      .map(nonEmptyString)
      .filter((m): m is string => Boolean(m) && m !== "text");
    if (modalities.length) metadata.inputModalities = modalities;
  }

  if (typeof fields.supportsTools === "boolean") {
    metadata.supportsTools = fields.supportsTools;
  }

  // A row is worth carrying only when it says something about the model
  // itself. A display name alone is not a fact — the dataset knows what many
  // models are called while publishing no window and no price for them, and a
  // picker line that offers a name plus an attribution has nothing to say.
  const published = Object.keys(metadata).some(
    (field) => field !== "source" && field !== "name",
  );
  return published ? metadata : undefined;
}

function metadataOf(entry: RawEntry): ModelMetadata | undefined {
  // The model-level window is the advertised one; top_provider carries the
  // serving provider's own limit and is only a fallback.
  const topProvider = entry.top_provider as
    | { context_length?: unknown; max_completion_tokens?: unknown }
    | undefined;
  const pricing = entry.pricing as
    | { prompt?: unknown; completion?: unknown }
    | undefined;
  const architecture = entry.architecture as
    | { input_modalities?: unknown }
    | undefined;

  return modelMetadataFrom({
    source: "provider",
    name: entry.name,
    contextLength:
      positiveNumber(entry.context_length) ?? topProvider?.context_length,
    maxCompletionTokens: topProvider?.max_completion_tokens,
    // Per token in the response, per million in the row.
    pricePerMTokInput: perMillionTokens(pricing?.prompt),
    pricePerMTokOutput: perMillionTokens(pricing?.completion),
    inputModalities: architecture?.input_modalities,
    supportsTools: Array.isArray(entry.supported_parameters)
      ? entry.supported_parameters.includes("tools")
      : undefined,
  });
}

/**
 * One GET /models, parsed into ids plus provider-published metadata. Throws
 * on a real failure (see the header) — the caller decides what a failure
 * means for the catalog it is holding.
 */
export async function fetchModelCatalog(
  baseURL: string,
  apiKey?: string,
): Promise<ModelCatalog> {
  const url = `${baseURL.replace(/\/+$/, "")}/models`;
  const res = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    if (res.status === 404 || res.status === 405) {
      return { models: [], metadata: {} };
    }
    throw new Error(`HTTP ${res.status}`);
  }
  const json = (await res.json()) as unknown;
  const models: string[] = [];
  const metadata: Record<string, ModelMetadata> = {};
  for (const entry of entriesOf(json)) {
    const id = nonEmptyString(entry.id);
    if (!id) continue;
    models.push(id);
    const published = metadataOf(entry);
    if (published) metadata[id] = published;
  }
  models.sort();
  return { models, metadata };
}

/** The id list alone — the original surface, kept for its callers. */
export async function fetchModels(
  baseURL: string,
  apiKey?: string,
): Promise<string[]> {
  return (await fetchModelCatalog(baseURL, apiKey)).models;
}

/** How long a fetched catalog is served without asking the provider again. */
const CATALOG_TTL_MS = 5 * 60_000;
/**
 * How long a failed attempt is remembered. Short on purpose: long enough
 * that a picker re-open does not re-probe a dead endpoint, short enough
 * that a key fixed a moment later is picked up rather than masked.
 */
const CATALOG_FAILURE_TTL_MS = 30_000;
/**
 * How long a last-good catalog may stand in for a live one while refreshes
 * keep failing. Beyond this the failure is reported on its own: a list from
 * a day ago is not a catalog, and presenting one as current would hide
 * retired models behind a reassuring UI.
 */
const CATALOG_STALE_MAX_MS = 60 * 60_000;

/** What a catalog read hands back, including how it came by it. */
export interface ModelCatalogResult extends ModelCatalog {
  /** Set when the attempt failed, or when a stale catalog is being served. */
  error?: string;
  /** True when this is the previous catalog and the refresh failed. */
  stale?: boolean;
  /** Epoch ms of the successful fetch behind this catalog; null = none yet. */
  fetchedAt: number | null;
}

interface CacheEntry {
  models: string[];
  metadata: Record<string, ModelMetadata>;
  fetchedAt: number | null;
  /** Fresh (no provider request) while now < expiresAt. */
  expiresAt: number;
  /** In failure memory while now < retryAt. */
  retryAt: number;
  error?: string;
}

/**
 * Keyed by endpoint, not by provider id (two entries can share a host) and
 * not by API key — credentials have no business in a Map key, and a key
 * change is handled by clearing the cache from the settings write instead.
 * The corner that leaves: two providers configured on the SAME base URL
 * with different keys share one catalog. They would be asking the same host
 * for the same model list anyway.
 */
const catalogCache = new Map<string, CacheEntry>();
/** In-flight refreshes by endpoint — the single-flight half of the cache. */
const inFlight = new Map<string, Promise<CacheEntry>>();
/**
 * Bumped by every clear. A refresh started before the bump must not store
 * its result afterwards: the clear existed because the credentials or
 * endpoint just changed, and that in-flight response describes the old ones.
 */
let generation = 0;

/** Drop every cached catalog (settings writes, "Re-check now", tests). */
export function clearModelCatalogCache() {
  generation += 1;
  catalogCache.clear();
  inFlight.clear();
}

function endpointKey(baseURL: string): string {
  return baseURL.replace(/\/+$/, "");
}

/**
 * "timeout" vs "unreachable" — the same two labels the catalog contract has
 * always carried. AbortSignal.timeout surfaces a DOMException named
 * TimeoutError; AbortError is kept because an aborted fetch used to be the
 * only shape this could take.
 */
function failureLabel(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable";
}

function toResult(entry: CacheEntry): ModelCatalogResult {
  const stale = Boolean(entry.error && entry.models.length > 0);
  return {
    models: entry.models,
    metadata: entry.metadata,
    ...(entry.error ? { error: entry.error } : {}),
    ...(stale ? { stale: true } : {}),
    fetchedAt: entry.fetchedAt,
  };
}

async function refreshCatalog(
  key: string,
  baseURL: string,
  apiKey: string | undefined,
  startedAt: number,
): Promise<CacheEntry> {
  try {
    const { models, metadata } = await fetchModelCatalog(baseURL, apiKey);
    const entry: CacheEntry = {
      models,
      metadata,
      fetchedAt: Date.now(),
      expiresAt: Date.now() + CATALOG_TTL_MS,
      retryAt: 0,
    };
    if (startedAt === generation) catalogCache.set(key, entry);
    return entry;
  } catch (e) {
    const error = failureLabel(e);
    const previous = catalogCache.get(key);
    const keepPrevious =
      previous?.fetchedAt != null &&
      previous.models.length > 0 &&
      Date.now() - previous.fetchedAt <= CATALOG_STALE_MAX_MS;
    const entry: CacheEntry = keepPrevious
      ? { ...previous, retryAt: Date.now() + CATALOG_FAILURE_TTL_MS, error }
      : {
          models: [],
          metadata: {},
          fetchedAt: null,
          expiresAt: Date.now() + CATALOG_FAILURE_TTL_MS,
          retryAt: Date.now() + CATALOG_FAILURE_TTL_MS,
          error,
        };
    if (startedAt === generation) catalogCache.set(key, entry);
    return entry;
  }
}

/**
 * The cached read used by every catalog route. In order: a fresh entry, a
 * failure still inside its memory window, a refresh already in flight (share
 * it), otherwise a real request — whose failure never discards a recent good
 * catalog, only marks it stale.
 */
export async function readModelCatalog(
  baseURL: string,
  apiKey?: string,
): Promise<ModelCatalogResult> {
  const key = endpointKey(baseURL);
  const now = Date.now();

  const cached = catalogCache.get(key);
  if (cached && now < cached.expiresAt) return toResult(cached);
  if (cached && now < cached.retryAt) return toResult(cached);

  const pending = inFlight.get(key);
  if (pending) return toResult(await pending);

  const startedAt = generation;
  const refresh = refreshCatalog(key, baseURL, apiKey, startedAt).finally(() => {
    // Only the owner removes the key: a clear() during the flight dropped
    // this promise already, and its own refresh must not be deleted here.
    if (inFlight.get(key) === refresh) inFlight.delete(key);
  });
  inFlight.set(key, refresh);
  return toResult(await refresh);
}
