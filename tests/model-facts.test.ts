/**
 * Facts from the models.dev dataset — the second producer, and the one whose
 * numbers this app did not witness itself.
 *
 * What is pinned here, and why each one matters:
 *
 *   THE MAPPING IS EXPLICIT. `MODEL_FACTS_SOURCES` is compared whole: which
 *   dataset provider answers for which of ours is a decision, not a lookup,
 *   so changing it has to be a deliberate edit to a test that names every
 *   entry. Providers the table leaves out (ollama, custom, together, …) get
 *   nothing at all — not "the closest match".
 *
 *   MATCHING IS EXACT. A model id that differs by a suffix, by case, or by
 *   belonging to a different provider yields no facts. The dataset's 226
 *   providers are never scanned for something that looks similar: a
 *   confidently displayed wrong price is worse than an empty line.
 *
 *   ONE RULE SET FOR BOTH PRODUCERS. The dataset carries `limit: {context:
 *   0}` and no `cost` on rows it has no window or price for (every OpenAI
 *   image model, for one), and those have to read as "not published" — the
 *   same rule models-catalog applies to a provider's own catalogue. A row
 *   that survives carries its `source`, so the UI can attribute it.
 *
 *   THE READ NEVER WAITS. `modelFactsFor` is memory-only and the load is
 *   warm-only: the picker must never block on a multi-megabyte document, so
 *   the first open after a cold start legitimately shows ids without facts.
 *   The cache then collapses repeated opens, concurrent ones (single-flight)
 *   and failures (a remembered window, during which the document is not
 *   re-fetched).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../src/lib/types";

const DATASET_URL = "https://models.dev/api.json";
const GROQ_MODELS = "https://api.groq.com/openai/v1/models";

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stub fetch by URL; an unlisted URL is a test failure, not a silent 404. */
function stubUrls(handler: (url: string) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function datasetCalls(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter(([url]) => String(url) === DATASET_URL).length;
}

/** A document shaped like the real one, with only the rows this test needs. */
const DOCUMENT = {
  // Declared: groq.
  groq: {
    id: "groq",
    models: {
      "llama-3.3-70b-versatile": {
        id: "llama-3.3-70b-versatile",
        name: "Llama 3.3 70B",
        limit: { context: 131072, output: 32768 },
        cost: { input: 0.59, output: 0.79 },
        modalities: { input: ["text"] },
        tool_call: true,
      },
      // No window and no price: the row must vanish, not become zeros.
      "whisper-large-v3": {
        id: "whisper-large-v3",
        name: "Whisper Large v3",
        limit: { context: 0, output: 0 },
      },
      // Free, and multimodal: zero survives as a price, "text" is dropped.
      "allam-2-7b": {
        id: "allam-2-7b",
        limit: { context: 4096, output: 4096 },
        cost: { input: 0, output: 0 },
        modalities: { input: ["text", "image"] },
        tool_call: false,
      },
    },
  },
  // NOT declared in MODEL_FACTS_SOURCES: must never be consulted, even
  // though it holds ids in a provider id space we do map.
  abacus: {
    id: "abacus",
    models: {
      "llama-3.3-70b-versatile": {
        id: "llama-3.3-70b-versatile",
        limit: { context: 999999, output: 999999 },
      },
    },
  },
  // Declared, but only via the exact id space: "qwen2.5-coder-7b" is not
  // "qwen2.5-coder-7b-instruct".
  lmstudio: {
    id: "lmstudio",
    models: { "qwen2.5-coder-7b-instruct": { limit: { context: 32768 } } },
  },
  openai: {
    id: "openai",
    models: { "gpt-4.1": { limit: { context: 1047576, output: 32768 }, cost: { input: 2, output: 8 } } },
  },
};

const GROQ: Settings["providers"][number] = {
  id: "groq",
  name: "Groq",
  kind: "openai-compatible",
  baseURL: "https://api.groq.com/openai/v1",
  defaultModel: "llama-3.3-70b-versatile",
  configured: true,
  apiKey: "gsk_real_key_0123456789abcdef0123456789",
};

/** A fresh module registry per test: the facts cache is module state. */
async function fresh() {
  vi.resetModules();
  const facts = await import("../src/lib/providers/model-facts");
  const gateway = await import("../src/lib/providers/gateway");
  return { facts, gateway };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the declared mapping — a decision, not a lookup", () => {
  it("names every provider whose facts come from the dataset", async () => {
    const { facts } = await fresh();
    expect(facts.MODEL_FACTS_SOURCES).toEqual({
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
    });
  });

  it("keys the table by provider ids the registry actually ships", async () => {
    const { facts } = await fresh();
    const { DEFAULT_PROVIDERS } = await import("../src/lib/providers/registry");
    const known = new Set(DEFAULT_PROVIDERS.map((p) => p.id));
    // A table keyed "z-ai" while the registry says "zai" looks perfectly
    // reasonable and delivers nothing. The live probe caught that one; this
    // catches the class of it, offline.
    for (const id of Object.keys(facts.MODEL_FACTS_SOURCES)) {
      expect(known.has(id), `no provider in the registry is "${id}"`).toBe(true);
    }
  });

  it("leaves the unmapped providers out — including the local ones", async () => {
    const { facts } = await fresh();
    for (const id of [
      "ollama",
      "lmstudio",
      "vllm",
      "custom",
      "together",
      "fireworks",
      "bedrock",
      "sambanova",
      "moonshot",
      "novita",
    ]) {
      expect(facts.hasModelFactsSource(id)).toBe(false);
    }
    expect(facts.hasModelFactsSource("groq")).toBe(true);
  });
});

describe("projection — declared providers, exact ids, one rule set", () => {
  it("keeps only the declared providers and the fields the UI can show", async () => {
    const { facts } = await fresh();
    const rows = facts.projectModelFacts(DOCUMENT);

    expect(rows.get("groq::llama-3.3-70b-versatile")).toEqual({
      source: "models.dev",
      name: "Llama 3.3 70B",
      contextLength: 131072,
      maxCompletionTokens: 32768,
      pricePerMTokInput: 0.59,
      pricePerMTokOutput: 0.79,
      supportsTools: true,
    });
    expect(rows.get("openai::gpt-4.1")).toEqual({
      source: "models.dev",
      contextLength: 1047576,
      maxCompletionTokens: 32768,
      pricePerMTokInput: 2,
      pricePerMTokOutput: 8,
    });
  });

  it("never reads a dataset provider we did not declare", async () => {
    const { facts } = await fresh();
    const rows = facts.projectModelFacts(DOCUMENT);
    // `abacus` holds the very same model id with different numbers, and is
    // not in the table: it must contribute nothing at all.
    for (const key of rows.keys()) {
      expect(key.startsWith("abacus::")).toBe(false);
    }
    expect(rows.size).toBe(3);
  });

  it("matches ids exactly — no prefix, suffix or case guessing", async () => {
    const { facts } = await fresh();
    const rows = facts.projectModelFacts(DOCUMENT);
    // lmstudio is not mapped at all, and its one row is a different id.
    expect(rows.has("lmstudio::qwen2.5-coder-7b")).toBe(false);
    expect(rows.has("lmstudio::qwen2.5-coder-7b-instruct")).toBe(false);
    expect(rows.has("groq::LLAMA-3.3-70B-VERSATILE")).toBe(false);
    // A declared dataset provider answers only for the provider that declared
    // it: openai's row is not available to azure, which has its own key.
    expect(rows.has("azure::gpt-4.1")).toBe(false);
  });

  it("reads a row the dataset has no fact for as 'not published'", async () => {
    const { facts } = await fresh();
    const rows = facts.projectModelFacts(DOCUMENT);
    // Whisper: limit 0/0 and no cost — nothing survives, so nothing is kept.
    expect(rows.has("groq::whisper-large-v3")).toBe(false);
    // Free is a fact: 0 survives as a price, "text" is dropped from modalities,
    // and an explicit tool_call: false is kept as false.
    expect(rows.get("groq::allam-2-7b")).toEqual({
      source: "models.dev",
      contextLength: 4096,
      maxCompletionTokens: 4096,
      pricePerMTokInput: 0,
      pricePerMTokOutput: 0,
      inputModalities: ["image"],
      supportsTools: false,
    });
  });

  it("survives a document that is not a document", async () => {
    const { facts } = await fresh();
    expect(facts.projectModelFacts(null).size).toBe(0);
    expect(facts.projectModelFacts({ groq: "nonsense" }).size).toBe(0);
  });
});

describe("the load — memory-only reads, warm-only fetch", () => {
  it("does not fetch anything to answer a read", async () => {
    const { facts } = await fresh();
    const spy = stubUrls(() => respond(DOCUMENT));
    expect(facts.modelFactsFor("groq", "llama-3.3-70b-versatile")).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("fills the rows on a load, then serves them without asking again", async () => {
    const { facts } = await fresh();
    const spy = stubUrls(() => respond(DOCUMENT));

    await facts.refreshModelFacts();
    facts.warmModelFacts();
    await Promise.resolve();

    expect(datasetCalls(spy)).toBe(1);
    expect(facts.modelFactsFor("groq", "llama-3.3-70b-versatile")).toMatchObject({
      source: "models.dev",
      contextLength: 131072,
    });
  });

  it("shares one load between concurrent warms", async () => {
    const { facts } = await fresh();
    let release!: (r: Response) => void;
    const spy = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)));
    vi.stubGlobal("fetch", spy);

    const first = facts.warmModelFacts();
    const second = facts.warmModelFacts();
    // The second warm hands back the first one's load rather than starting a
    // second multi-megabyte download.
    expect(second).toBe(first);
    release(respond(DOCUMENT));
    await first;

    expect(datasetCalls(spy)).toBe(1);
    // …and once it is loaded and fresh, warming asks for nothing.
    expect(facts.warmModelFacts()).toBeNull();
    expect(datasetCalls(spy)).toBe(1);
  });

  it("remembers a failure, keeps the rows it already had, and retries later", async () => {
    const { facts } = await fresh();
    let fail = false;
    const spy = stubUrls(() => {
      if (fail) return Promise.reject(new Error("dataset host down"));
      return respond(DOCUMENT);
    });

    await facts.refreshModelFacts();
    expect(facts.modelFactsFor("groq", "allam-2-7b")).toBeDefined();

    // Expire the day-long window, then let the host fail.
    vi.setSystemTime(Date.now() + 13 * 60 * 60_000);
    fail = true;
    await facts.refreshModelFacts();
    const afterFailure = datasetCalls(spy);
    facts.warmModelFacts();
    facts.warmModelFacts();
    expect(datasetCalls(spy)).toBe(afterFailure);

    // A failed refresh is not a reason to forget what was published, and the
    // failure is not a forever state either.
    expect(facts.modelFactsFor("groq", "allam-2-7b")).toBeDefined();
    vi.setSystemTime(Date.now() + 11 * 60_000);
    fail = false;
    await facts.refreshModelFacts();
    expect(datasetCalls(spy)).toBe(afterFailure + 1);
  });

  it("forgets everything on request", async () => {
    const { facts } = await fresh();
    stubUrls(() => respond(DOCUMENT));
    await facts.refreshModelFacts();
    facts.clearModelFactsCache();
    expect(facts.modelFactsFor("groq", "allam-2-7b")).toBeUndefined();
  });
});

describe("the merge — provider facts win, the dataset fills the gap", () => {
  const settings: Settings = { providers: [GROQ], cloudflare: undefined };

  it("fills a provider that publishes only ids, marked as the dataset's", async () => {
    const { facts, gateway } = await fresh();
    const spy = stubUrls((url) =>
      url === DATASET_URL
        ? respond(DOCUMENT)
        : respond({ data: [{ id: "llama-3.3-70b-versatile" }, { id: "allam-2-7b" }] }),
    );
    await facts.refreshModelFacts();

    const out = await gateway.listProviderModels(GROQ, settings);

    expect(out.models).toEqual(["allam-2-7b", "llama-3.3-70b-versatile"]);
    expect(out.metadata["llama-3.3-70b-versatile"]).toMatchObject({
      source: "models.dev",
      contextLength: 131072,
      pricePerMTokInput: 0.59,
    });
    // The fresh window means the merge did not trigger a second load.
    expect(datasetCalls(spy)).toBe(1);
  });

  it("keeps the provider's own row for a model it does publish", async () => {
    const { facts, gateway } = await fresh();
    stubUrls((url) =>
      url === DATASET_URL
        ? respond(DOCUMENT)
        : respond({
            data: [
              {
                id: "llama-3.3-70b-versatile",
                name: "Llama 3.3 70B Versatile",
                context_length: 100000,
                pricing: { prompt: "0.000001", completion: "0.000002" },
              },
            ],
          }),
    );
    await facts.refreshModelFacts();

    const out = await gateway.listProviderModels(GROQ, settings);

    // The dataset says 131072 / $0.59; the provider says 100000 / $1.
    expect(out.metadata["llama-3.3-70b-versatile"]).toEqual({
      source: "provider",
      name: "Llama 3.3 70B Versatile",
      contextLength: 100000,
      pricePerMTokInput: 1,
      pricePerMTokOutput: 2,
    });
  });

  it("never downloads the dataset for a provider the table leaves out", async () => {
    const { gateway } = await fresh();
    const spy = stubUrls(() => respond({ data: [{ id: "qwen2.5-coder:7b" }] }));

    const out = await gateway.listProviderModels(
      {
        id: "ollama",
        name: "Ollama",
        kind: "openai-compatible",
        baseURL: "http://localhost:11434/v1",
        defaultModel: "qwen2.5-coder:7b",
        configured: false,
      },
      settings,
    );
    // Let any warming it wrongly started reach fetch.
    await Promise.resolve();

    expect(out.models).toEqual(["qwen2.5-coder:7b"]);
    expect(out.metadata).toEqual({});
    expect(datasetCalls(spy)).toBe(0);
  });
});
