/**
 * Component tests for the model pickers in builder-client.tsx.
 *
 * These pin the client-side catalog contract shared by the global picker and
 * the per-project pin picker (via ModelOptgroups):
 *   1. A PINNED model that the provider's live catalog does not list stays
 *      selectable — the original bug was the pin picker silently dropping
 *      the pinned model from its own dropdown (fixed by `ensureSelection`).
 *   2. An unlisted model only appears when it is actually selected — never
 *      for arbitrary entries.
 *   3. Unconfigured providers never render, even if the selection points at
 *      them (the configured flag is the server gate; the client never
 *      re-derives it — ensureSelection cannot resurrect a dead provider).
 *   4. Empty live catalogs fall back to the entry's defaultModel.
 *   5. What a provider published about a model is VISIBLE IN THE ROW while
 *      choosing, not only on hover: each option carries a compact badge of the
 *      two numbers a choice turns on — context window and price — with the
 *      full line (the provider's own label for the model, the output budget,
 *      tools, modalities) on the option's title and under the select for the
 *      current selection. All of it verbatim; a provider that published
 *      nothing produces no badge, no title and no line at all (never a zero,
 *      never a guess), and a catalog that failed to refresh is labelled stale
 *      rather than pretending to be the live list. A native option's text IS
 *      its accessible name, so the badge is deliberately short — the detail
 *      that would not fit is the part left to hover.
 *   6. A row from the models.dev dataset is ATTRIBUTED ("via models.dev") in
 *      that same badge and line. The two producers are never allowed to look
 *      alike: the vendor's own number and a curated third party's number are
 *      different claims, and the interface says which one it is showing.
 *   7. Token counts keep their precision: 1,048,576 renders as "1.05M", not
 *      "1M" — a formatter that rounds a true value away is the one place
 *      this UI could misreport a number it was handed correctly.
 *
 * The fetch layer is stubbed at the global level with canned route payloads —
 * the components' contract is exactly the JSON shape of /api/models and
 * /api/projects/[id]/model, and this keeps the tests hermetic.
 *
 * Interactions go through `userEvent.setup({ delay: null })`. The direct
 * `userEvent.selectOptions()` API defaults to `delay: 0`, which is a real
 * `setTimeout(resolve, 0)` awaited between every key (user-event's `wait()`),
 * so wall time becomes a function of scheduler contention instead of of the
 * code under test. See tests/deploy-section.test.tsx for the measurement.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelOptgroups, ModelPicker, ProjectModelPicker } from "../src/components/builder-client";
import type { ModelCatalogEntry } from "../src/components/builder-client";

const LISTED = ["qwen2.5-coder:1.5b", "llama3.1:8b"];
const UNLISTED = "mistral-nemo:12b"; // pinned/active but absent from `models`

const OLLAMA: ModelCatalogEntry = {
  id: "ollama",
  name: "Ollama (local)",
  configured: true,
  defaultModel: LISTED[0],
  models: LISTED,
  metadata: {},
};

const GROQ_UNCONFIGURED: ModelCatalogEntry = {
  id: "groq",
  name: "Groq",
  configured: false,
  defaultModel: "llama-3.3-70b",
  models: ["llama-3.3-70b"],
  metadata: {},
};

/** A provider that publishes facts, the way OpenRouter's catalog does. */
const SONNET = "anthropic/claude-sonnet-4.6";
const SONNET_FACTS =
  "Anthropic: Claude Sonnet 4.6 · 1M ctx · max 128k out · $3/$15 per Mtok · tools · image";
/** A row from the dataset, which fills providers that publish only ids. */
const GPT = "gpt-4.1";
const GPT_FACTS =
  "GPT-4.1 · 1.05M ctx · max 32.8k out · $2/$8 per Mtok · tools · image+pdf · via models.dev";
const OPENAI_DATASET: ModelCatalogEntry = {
  id: "openai",
  name: "OpenAI",
  configured: true,
  defaultModel: GPT,
  models: [GPT],
  metadata: {
    [GPT]: {
      source: "models.dev",
      name: "GPT-4.1",
      // The real published window — the number the old formatter rounded to 1M.
      contextLength: 1_048_576,
      maxCompletionTokens: 32_768,
      pricePerMTokInput: 2,
      pricePerMTokOutput: 8,
      inputModalities: ["image", "pdf"],
      supportsTools: true,
    },
  },
};

const OPENROUTER: ModelCatalogEntry = {
  id: "openrouter",
  name: "OpenRouter",
  configured: true,
  defaultModel: SONNET,
  models: [SONNET],
  metadata: {
    [SONNET]: {
      source: "provider",
      name: "Anthropic: Claude Sonnet 4.6",
      contextLength: 1_000_000,
      maxCompletionTokens: 128_000,
      pricePerMTokInput: 3,
      pricePerMTokOutput: 15,
      inputModalities: ["image"],
      supportsTools: true,
    },
  },
};

/** Route → JSON payload served by the stubbed fetch. */
const routes = new Map<string, unknown>();
/** Every mutation the stub sees: [url, method, parsed body]. */
let hits: [string, string, Record<string, unknown> | undefined][];

beforeEach(() => {
  routes.clear();
  hits = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = routes.get(url);
      if (init?.method) {
        hits.push([
          url,
          init.method,
          init.body ? JSON.parse(String(init.body)) : undefined,
        ]);
      }
      if (body === undefined) {
        return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(body),
      } as Response);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProjectModelPicker — per-project pin", () => {
  it("keeps a pinned unlisted model selectable (regression: it used to vanish)", async () => {
    routes.set("/api/projects/p1/model", {
      override: { providerId: "ollama", modelId: UNLISTED },
      default: { providerId: "ollama", modelId: LISTED[0] },
      catalog: [OLLAMA, GROQ_UNCONFIGURED],
    });

    render(<ProjectModelPicker projectId="p1" refreshKey={0} />);

    // The pinned option renders — and it is NOT in the live catalog.
    const opt = await screen.findByRole("option", { name: UNLISTED });
    expect((opt as HTMLOptionElement).value).toBe(`ollama::${UNLISTED}`);

    const select = screen.getByRole("combobox", {
      name: "Model for this project",
    }) as HTMLSelectElement;
    expect(select.value).toBe(`ollama::${UNLISTED}`);
    expect((opt as HTMLOptionElement).selected).toBe(true);

    // The provider's listed models render alongside the pinned extra…
    expect(screen.getByRole("option", { name: LISTED[0] })).toBeTruthy();
    expect(screen.getByRole("option", { name: LISTED[1] })).toBeTruthy();
    // …exactly once (no duplicate pinned option).
    expect(screen.getAllByRole("option", { name: UNLISTED })).toHaveLength(1);

    // Pinned state is visible.
    expect(screen.getByText("pinned")).toBeTruthy();
  });

  it("does not list unlisted models when nothing is pinned", async () => {
    routes.set("/api/projects/p2/model", {
      override: null,
      default: { providerId: "ollama", modelId: LISTED[0] },
      catalog: [OLLAMA, GROQ_UNCONFIGURED],
    });

    render(<ProjectModelPicker projectId="p2" refreshKey={0} />);

    // Data has loaded when the default label reflects the server default.
    await screen.findByRole("option", { name: /This project: default/ });

    expect(screen.queryByRole("option", { name: UNLISTED })).toBeNull();
    expect(screen.getByRole("option", { name: LISTED[0] })).toBeTruthy();
    expect(screen.queryByText("pinned")).toBeNull();
  });

  it("skips the PUT when the selection already matches the committed pin", async () => {
    routes.set("/api/projects/p3/model", {
      override: null,
      default: { providerId: "ollama", modelId: LISTED[0] },
      catalog: [OLLAMA, GROQ_UNCONFIGURED],
    });

    const user = userEvent.setup({ delay: null });
    render(<ProjectModelPicker projectId="p3" refreshKey={0} />);
    const select = (await screen.findByLabelText("Model for this project")) as HTMLSelectElement;

    // Re-select "global" — already the committed pin → no PUT.
    await user.selectOptions(select, "global");
    expect(hits.filter(([, m]) => m === "PUT")).toEqual([]);
  });
});

describe("ModelPicker — global active model", () => {
  it("keeps an active unlisted model selectable", async () => {
    routes.set("/api/models", {
      providers: [OLLAMA, GROQ_UNCONFIGURED],
      active: { providerId: "ollama", model: UNLISTED },
    });

    render(<ModelPicker refreshKey={0} />);

    await screen.findByRole("option", { name: UNLISTED });
    const select = screen.getByTitle("Active model") as HTMLSelectElement;
    expect(select.value).toBe(`ollama::${UNLISTED}`);
    expect(screen.getAllByRole("option", { name: UNLISTED })).toHaveLength(1);
  });

  it("selects the active provider's listed model normally", async () => {
    routes.set("/api/models", {
      providers: [OLLAMA, GROQ_UNCONFIGURED],
      active: { providerId: "ollama", model: LISTED[1] },
    });

    render(<ModelPicker refreshKey={0} />);

    await screen.findByRole("option", { name: LISTED[1] });
    const select = screen.getByTitle("Active model") as HTMLSelectElement;
    expect(select.value).toBe(`ollama::${LISTED[1]}`);
  });

  it("skips the POST when the selection already matches the committed pair", async () => {
    routes.set("/api/models", {
      providers: [OLLAMA, GROQ_UNCONFIGURED],
      active: { providerId: "ollama", model: LISTED[0] },
    });

    const user = userEvent.setup({ delay: null });
    render(<ModelPicker refreshKey={0} />);
    const select = (await screen.findByTitle("Active model")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(`ollama::${LISTED[0]}`));

    // Re-select the same option — the onChange fires, but persist must
    // no-op (the pair is already committed).
    await user.selectOptions(select, `ollama::${LISTED[0]}`);
    expect(hits.filter(([, m]) => m === "POST")).toEqual([]);
  });

  it("POSTs exactly once per real change, with the active pair payload", async () => {
    routes.set("/api/models", {
      providers: [OLLAMA, GROQ_UNCONFIGURED],
      active: { providerId: "ollama", model: LISTED[0] },
    });
    routes.set("/api/settings", {}); // the persist POST target

    const user = userEvent.setup({ delay: null });
    render(<ModelPicker refreshKey={0} />);
    const select = (await screen.findByTitle("Active model")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(`ollama::${LISTED[0]}`));

    await user.selectOptions(select, `ollama::${LISTED[1]}`);
    await waitFor(() => expect(hits.filter(([, m]) => m === "POST")).toHaveLength(1));
    expect(hits[0]).toEqual([
      "/api/settings",
      "POST",
      { activeProviderId: "ollama", activeModel: LISTED[1] },
    ]);
  });
});

describe("ModelOptgroups — the shared client-side catalog rules", () => {
  it("falls back to defaultModel when the endpoint lists nothing", () => {
    render(
      <select>
        <ModelOptgroups
          entries={[
            { ...OLLAMA, models: [] },
            GROQ_UNCONFIGURED,
          ]}
          ensureSelection="ollama::qwen2.5-coder:1.5b"
        />
      </select>,
    );
    expect(screen.getByRole("option", { name: LISTED[0] })).toBeTruthy();
  });

  it("never renders unconfigured providers — not even the selection's provider", () => {
    render(
      <select>
        <ModelOptgroups
          entries={[OLLAMA, GROQ_UNCONFIGURED]}
          ensureSelection={`groq::${UNLISTED}`}
        />
      </select>,
    );
    expect(screen.queryByRole("option", { name: UNLISTED })).toBeNull();
    const groups = screen.getAllByRole("group");
    expect(groups).toHaveLength(1);
    expect((groups[0] as HTMLElement).getAttribute("label")).toBe(
      "Ollama (local)",
    );
  });

  it("renders nothing when an entry has no models, no default, and no selection", () => {
    render(
      <select>
        <ModelOptgroups entries={[{ ...OLLAMA, models: [], defaultModel: "" }]} />
      </select>,
    );
    expect(screen.queryAllByRole("group")).toHaveLength(0);
  });

  it("puts the published facts in the row itself, with the full line as its title", () => {
    render(
      <select>
        <ModelOptgroups entries={[OPENROUTER]} />
      </select>,
    );
    // What you see while choosing, without hovering: the id and the two
    // numbers that decide the choice.
    const opt = screen.getByRole("option", {
      name: `${SONNET} — 1M ctx · $3/$15`,
    });
    expect(opt.textContent).toBe(`${SONNET} — 1M ctx · $3/$15`);
    // The rest of the published facts — the provider's own label, the output
    // budget, tools, modalities — stay on the title, verbatim.
    expect(opt.getAttribute("title")).toBe(SONNET_FACTS);
  });

  it("badges a one-sided price as one-sided rather than inventing the other side", () => {
    render(
      <select>
        <ModelOptgroups
          entries={[
            {
              ...OPENROUTER,
              metadata: {
                [SONNET]: {
                  source: "provider" as const,
                  contextLength: 1_000_000,
                  pricePerMTokInput: 3,
                },
              },
            },
          ]}
        />
      </select>,
    );
    expect(screen.getByRole("option", { name: /\$3\/\$/ }).textContent).toBe(
      `${SONNET} — 1M ctx · $3/$?`,
    );
  });

  it("leaves the row and the title alone when the provider published no facts", () => {
    render(
      <select>
        <ModelOptgroups entries={[OLLAMA]} />
      </select>,
    );
    const opt = screen.getByRole("option", { name: LISTED[0] });
    expect(opt.getAttribute("title")).toBeNull();
    // No dangling separator either — the row is exactly the model id.
    expect(opt.textContent).toBe(LISTED[0]);
  });

  it("labels a catalog that failed to refresh as stale, and keeps its models", () => {
    render(
      <select>
        <ModelOptgroups
          entries={[{ ...OPENROUTER, stale: true, error: "unreachable" }]}
        />
      </select>,
    );
    expect(
      (screen.getByRole("group") as HTMLElement).getAttribute("label"),
    ).toBe("OpenRouter (stale)");
    // Stale is not empty: the last good catalog is still usable.
    expect(
      screen.getByRole("option", { name: /anthropic\/claude-sonnet-4\.6/ }),
    ).toBeTruthy();
  });

  it("attributes a dataset row, and keeps the token counts it was given", () => {
    render(
      <select>
        <ModelOptgroups entries={[OPENAI_DATASET]} />
      </select>,
    );
    // The attribution rides in the row too: while choosing, a price you can
    // see must say whose number it is. 1,048,576 keeps its precision.
    const opt = screen.getByRole("option", {
      name: `${GPT} — 1.05M ctx · $2/$8 · via models.dev`,
    });
    expect(opt.getAttribute("title")).toBe(GPT_FACTS);
  });

  it("still reports a real failure as a failure", () => {
    render(
      <select>
        <ModelOptgroups entries={[{ ...OLLAMA, error: "unreachable" }]} />
      </select>,
    );
    expect(
      (screen.getByRole("group") as HTMLElement).getAttribute("label"),
    ).toBe("Ollama (local) (unreachable)");
  });
});

describe("the selection's published facts", () => {
  it("shows them in the row and under the global picker for the active model", async () => {
    routes.set("/api/models", {
      providers: [OPENROUTER, OLLAMA],
      active: { providerId: "openrouter", model: SONNET },
    });

    render(<ModelPicker refreshKey={0} />);

    const select = (await screen.findByTitle("Active model")) as HTMLSelectElement;
    // The closed select displays the selected row verbatim, so the facts are
    // on screen before the list is even opened — this is what "visible while
    // choosing" means for a native select, and it is asserted on the real
    // element rather than on a lookalike span.
    await waitFor(() =>
      expect(select.options[select.selectedIndex]?.textContent).toBe(
        `${SONNET} — 1M ctx · $3/$15`,
      ),
    );
    expect(await screen.findByText(SONNET_FACTS)).toBeTruthy();
  });

  it("attributes the dataset's facts in the row for an ids-only provider", async () => {
    routes.set("/api/models", {
      providers: [OPENAI_DATASET],
      active: { providerId: "openai", model: GPT },
    });

    render(<ModelPicker refreshKey={0} />);

    await screen.findByRole("option", {
      name: `${GPT} — 1.05M ctx · $2/$8 · via models.dev`,
    });
    expect(await screen.findByText(GPT_FACTS)).toBeTruthy();
  });

  it("shows no line at all for a provider that published nothing", async () => {
    routes.set("/api/models", {
      providers: [OLLAMA],
      active: { providerId: "ollama", model: LISTED[0] },
    });

    render(<ModelPicker refreshKey={0} />);

    await screen.findByRole("option", { name: LISTED[0] });
    expect(screen.queryByText(/ctx/)).toBeNull();
  });

  it("describes the pinned model in a project's picker", async () => {
    routes.set("/api/projects/p4/model", {
      override: { providerId: "openrouter", modelId: SONNET },
      default: { providerId: "ollama", modelId: LISTED[0] },
      catalog: [OPENROUTER, OLLAMA],
    });

    render(<ProjectModelPicker projectId="p4" refreshKey={0} />);

    // The pin badge is the "data loaded" signal this picker already has.
    await screen.findByText("pinned");
    expect(screen.getByText(SONNET_FACTS)).toBeTruthy();
  });
});
