/**
 * The model catalog: what a provider publishes about its models, and what
 * the app does with it between requests.
 *
 * PARSING — metadata is the provider's own numbers, never ours. Extracted
 * only from fields the provider actually published, in whichever of the
 * three envelope shapes it uses, and omitted entirely for a provider that
 * publishes none. Nothing is inferred from a model name, and "not
 * published" stays distinct from "zero" (a price of 0 is free — a fact; a
 * missing price is not). The `fetchModels` id-list contract itself is
 * pinned in tests/provider-registry.test.ts.
 *
 * CACHING — what this file is mostly about. The picker route asks EVERY
 * configured provider on EVERY open, and the builder header carries two
 * pickers (global + per-project pin), so an uncached implementation spends
 * one HTTP request per provider per page view; OpenRouter's catalog alone
 * answers in 764 KB. Four rules are pinned here: the fresh window serves
 * without a request, concurrent opens share one request (single-flight),
 * a failure is remembered briefly instead of re-probed per open, and a
 * failed refresh keeps the last good catalog — marked stale and bounded in
 * time — rather than blanking a picker that was working.
 *
 * Every test imports the module fresh: the cache is module state (that is
 * the production shape), and `vi.resetModules()` is what keeps these tests
 * from being statements about each other. Time is faked at the Date level
 * only, so the code's own clock moves while real timers stay real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BASE = "https://catalog.example/v1";

/** The richest shape a provider in the registry actually returns. */
const OPENROUTER_ENTRY = {
  id: "anthropic/claude-sonnet-4.6",
  name: "Anthropic: Claude Sonnet 4.6",
  created: 1750000000,
  context_length: 1_000_000,
  pricing: { prompt: "0.000003", completion: "0.000015" },
  architecture: {
    modality: "text+image+file->text",
    input_modalities: ["text", "image", "file"],
    output_modalities: ["text"],
  },
  top_provider: { context_length: 900_000, max_completion_tokens: 128_000 },
  supported_parameters: ["max_tokens", "tools", "reasoning"],
};

async function freshCatalog() {
  vi.resetModules();
  return import("../src/lib/models-catalog");
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stub fetch with a script: one entry per call, recycled at the end. */
function stubFetch(
  script: Array<Response | (() => Response | Promise<Response>)>,
) {
  let calls = 0;
  const spy = vi.fn(async () => {
    const step = script[Math.min(calls, script.length - 1)];
    calls += 1;
    return typeof step === "function" ? await step() : step;
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(() => {
  // Only the clock is faked: real timers (and AbortSignal.timeout) stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("metadata — the provider's published facts, or nothing", () => {
  it("reads the full published block, converting per-token prices", async () => {
    const { fetchModelCatalog } = await freshCatalog();
    stubFetch([respond({ data: [OPENROUTER_ENTRY] })]);

    const { models, metadata } = await fetchModelCatalog(BASE);

    expect(models).toEqual(["anthropic/claude-sonnet-4.6"]);
    expect(metadata["anthropic/claude-sonnet-4.6"]).toEqual({
      // The producer, not decoration: rows from the models.dev dataset say so
      // instead, and the UI attributes only those (see model-facts tests).
      source: "provider",
      name: "Anthropic: Claude Sonnet 4.6",
      // The model-level window wins over the serving provider's own limit.
      contextLength: 1_000_000,
      maxCompletionTokens: 128_000,
      // Per token in the response ("0.000003"), per million here.
      pricePerMTokInput: 3,
      pricePerMTokOutput: 15,
      // "text" dropped: every chat model takes text.
      inputModalities: ["image", "file"],
      supportsTools: true,
    });
  });

  it("accepts all three envelope shapes, with bare ids carrying no facts", async () => {
    const { fetchModelCatalog } = await freshCatalog();

    stubFetch([respond({ data: [{ id: "zeta" }, { id: "alpha" }] })]);
    expect(await fetchModelCatalog(BASE)).toEqual({
      models: ["alpha", "zeta"],
      metadata: {},
    });

    // Workers AI wraps its list one level deeper.
    stubFetch([respond({ result: { data: [{ id: "cf-model" }] } })]);
    expect(await fetchModelCatalog(BASE)).toEqual({
      models: ["cf-model"],
      metadata: {},
    });

    stubFetch([respond([{ id: "bare" }])]);
    expect(await fetchModelCatalog(BASE)).toEqual({
      models: ["bare"],
      metadata: {},
    });
  });

  it("keeps 'not published' distinct from zero, and never coerces", async () => {
    const { fetchModelCatalog } = await freshCatalog();
    stubFetch([
      respond({
        data: [
          // A free model: 0 is a fact worth showing.
          { id: "free", pricing: { prompt: "0", completion: "0" } },
          // String where a number belongs: ignored, not coerced to 1000.
          { id: "stringy", context_length: "1000" },
          // Negative price: not a price.
          { id: "negative", pricing: { prompt: "-1" } },
          // Only-text modalities say nothing worth displaying.
          { id: "textual", architecture: { input_modalities: ["text"] } },
          // No parameter list at all is NOT "supports no tools".
          { id: "unknown-tools", name: "Just a name", context_length: 8000 },
          // A name with nothing else is not a fact, so no row at all.
          { id: "name-only", name: "Only a name" },
          { id: "", name: "not a model" },
          { name: "no id at all" },
        ],
      }),
    ]);

    const { models, metadata } = await fetchModelCatalog(BASE);

    expect(models).toEqual([
      "free",
      "name-only",
      "negative",
      "stringy",
      "textual",
      "unknown-tools",
    ]);
    expect(metadata.free).toEqual({
      source: "provider",
      pricePerMTokInput: 0,
      pricePerMTokOutput: 0,
    });
    expect(metadata.stringy).toBeUndefined();
    expect(metadata.negative).toBeUndefined();
    expect(metadata.textual).toBeUndefined();
    // A published parameter list WITHOUT "tools" means no tools — that is
    // the one path that may assert false.
    expect(metadata["unknown-tools"]).toEqual({
      source: "provider",
      name: "Just a name",
      contextLength: 8000,
    });
    expect("supportsTools" in metadata["unknown-tools"]).toBe(false);
    expect(metadata["name-only"]).toBeUndefined();

    stubFetch([respond({ data: [{ id: "no-tools", supported_parameters: [] }] })]);
    const second = await fetchModelCatalog("https://other.example/v1");
    expect(second.metadata["no-tools"]).toEqual({
      source: "provider",
      supportsTools: false,
    });
  });

  it("does not believe a catalog-shaped response with no list in it", async () => {
    const { fetchModelCatalog } = await freshCatalog();
    stubFetch([respond({ error: "boom" })]);
    expect(await fetchModelCatalog(BASE)).toEqual({ models: [], metadata: {} });
  });
});

describe("the cache — one request per provider per window, not per open", () => {
  it("serves a repeat read inside the fresh window without fetching", async () => {
    const { readModelCatalog } = await freshCatalog();
    const fetchSpy = stubFetch([respond({ data: [{ id: "m" }] })]);

    const first = await readModelCatalog(BASE);
    vi.setSystemTime(Date.now() + 4 * 60_000);
    const second = await readModelCatalog(BASE);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first.models).toEqual(["m"]);
    expect(second.models).toEqual(["m"]);
    expect(second.stale).toBeUndefined();
    expect(second.error).toBeUndefined();
  });

  it("shares one request between concurrent opens (single-flight)", async () => {
    const { readModelCatalog } = await freshCatalog();
    let release!: (r: Response) => void;
    const fetchSpy = vi.fn(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    vi.stubGlobal("fetch", fetchSpy);

    // Both reads are in flight before the response exists — the second must
    // join the first instead of opening its own request.
    const a = readModelCatalog(BASE);
    const b = readModelCatalog(BASE);
    release(respond({ data: [{ id: "m" }, { id: "n" }] }));
    const [ra, rb] = await Promise.all([a, b]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(ra.models).toEqual(["m", "n"]);
    expect(rb.models).toEqual(["m", "n"]);
  });

  it("remembers a failure briefly instead of re-probing per open", async () => {
    const { readModelCatalog } = await freshCatalog();
    const fetchSpy = stubFetch([() => Promise.reject(new Error("refused"))]);

    const first = await readModelCatalog(BASE);
    await readModelCatalog(BASE);
    await readModelCatalog(BASE);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ models: [], error: "unreachable" });
    expect(first.fetchedAt).toBeNull();

    // …and the memory lapses, so a fixed key is picked up rather than hidden.
    vi.setSystemTime(Date.now() + 31_000);
    await readModelCatalog(BASE);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("labels a timeout as a timeout, and an HTTP error as unreachable", async () => {
    const { readModelCatalog } = await freshCatalog();
    stubFetch([
      () =>
        Promise.reject(
          // What AbortSignal.timeout hands to fetch's catch.
          Object.assign(new Error("timed out"), { name: "TimeoutError" }),
        ),
    ]);
    expect((await readModelCatalog("https://slow.example/v1")).error).toBe(
      "timeout",
    );

    stubFetch([respond({ error: "nope" }, 500)]);
    expect((await readModelCatalog("https://down.example/v1")).error).toBe(
      "unreachable",
    );
  });

  it("keeps the last good catalog when a refresh fails, and says so", async () => {
    const { readModelCatalog } = await freshCatalog();
    const fetchSpy = stubFetch([
      respond({ data: [OPENROUTER_ENTRY] }),
      () => Promise.reject(new Error("blip")),
    ]);

    const good = await readModelCatalog(BASE);
    expect(good.models).toEqual(["anthropic/claude-sonnet-4.6"]);
    expect(typeof good.fetchedAt).toBe("number");

    // Past the fresh window the refresh is attempted — and fails. The
    // provider's own list and its facts survive; only freshness is lost.
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const stale = await readModelCatalog(BASE);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(stale.models).toEqual(good.models);
    expect(stale.metadata).toEqual(good.metadata);
    expect(stale.stale).toBe(true);
    expect(stale.error).toBe("unreachable");
    // The stale read is remembered too: no third request for the next open.
    await readModelCatalog(BASE);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("recovers: a successful refresh replaces the stale catalog", async () => {
    const { readModelCatalog } = await freshCatalog();
    stubFetch([
      respond({ data: [{ id: "old" }] }),
      () => Promise.reject(new Error("blip")),
      respond({ data: [{ id: "new" }] }),
    ]);

    await readModelCatalog(BASE);
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect((await readModelCatalog(BASE)).stale).toBe(true);

    vi.setSystemTime(Date.now() + 31_000);
    const recovered = await readModelCatalog(BASE);
    expect(recovered.models).toEqual(["new"]);
    expect(recovered.stale).toBeUndefined();
    expect(recovered.error).toBeUndefined();
  });

  it("stops standing in for a live catalog after an hour", async () => {
    const { readModelCatalog } = await freshCatalog();
    stubFetch([
      respond({ data: [{ id: "ancient" }] }),
      () => Promise.reject(new Error("still down")),
    ]);

    await readModelCatalog(BASE);
    vi.setSystemTime(Date.now() + 61 * 60_000);
    const late = await readModelCatalog(BASE);

    // A list from over an hour ago is not a catalog: report the failure on
    // its own rather than hide retired models behind a reassuring picker.
    expect(late.models).toEqual([]);
    expect(late.stale).toBeUndefined();
    expect(late.error).toBe("unreachable");
  });

  it("clears on demand — the settings write's way to make a new key count", async () => {
    const { readModelCatalog, clearModelCatalogCache } = await freshCatalog();
    const fetchSpy = stubFetch([
      respond({ data: [{ id: "before" }] }),
      respond({ data: [{ id: "after" }] }),
    ]);

    await readModelCatalog(BASE);
    clearModelCatalogCache();
    const after = await readModelCatalog(BASE);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(after.models).toEqual(["after"]);
  });

  it("never stores a response fetched under the credentials a clear replaced", async () => {
    const { readModelCatalog, clearModelCatalogCache } = await freshCatalog();
    let releaseFirst!: (r: Response) => void;
    const fetchSpy = stubFetch([
      () => new Promise<Response>((resolve) => (releaseFirst = resolve)),
      respond({ data: [{ id: "fresh" }] }),
    ]);

    // A read is in flight with the OLD credentials when the settings write
    // clears the cache. Its response describes the old key, so it must not
    // land in the cache afterwards.
    const inFlightRead = readModelCatalog(BASE, "old-key");
    clearModelCatalogCache();
    const newRead = readModelCatalog(BASE, "new-key");
    releaseFirst(respond({ data: [{ id: "stale-response" }] }));

    await inFlightRead;
    expect((await newRead).models).toEqual(["fresh"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // And the late response is not what the next read sees either.
    expect((await readModelCatalog(BASE)).models).toEqual(["fresh"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
