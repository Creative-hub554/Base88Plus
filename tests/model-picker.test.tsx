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
 *
 * The fetch layer is stubbed at the global level with canned route payloads —
 * the components' contract is exactly the JSON shape of /api/models and
 * /api/projects/[id]/model, and this keeps the tests hermetic.
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
};

const GROQ_UNCONFIGURED: ModelCatalogEntry = {
  id: "groq",
  name: "Groq",
  configured: false,
  defaultModel: "llama-3.3-70b",
  models: ["llama-3.3-70b"],
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

    render(<ProjectModelPicker projectId="p3" refreshKey={0} />);
    const select = (await screen.findByLabelText("Model for this project")) as HTMLSelectElement;

    // Re-select "global" — already the committed pin → no PUT.
    await userEvent.selectOptions(select, "global");
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

    render(<ModelPicker refreshKey={0} />);
    const select = (await screen.findByTitle("Active model")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(`ollama::${LISTED[0]}`));

    // Re-select the same option — the onChange fires, but persist must
    // no-op (the pair is already committed).
    await userEvent.selectOptions(select, `ollama::${LISTED[0]}`);
    expect(hits.filter(([, m]) => m === "POST")).toEqual([]);
  });

  it("POSTs exactly once per real change, with the active pair payload", async () => {
    routes.set("/api/models", {
      providers: [OLLAMA, GROQ_UNCONFIGURED],
      active: { providerId: "ollama", model: LISTED[0] },
    });
    routes.set("/api/settings", {}); // the persist POST target

    render(<ModelPicker refreshKey={0} />);
    const select = (await screen.findByTitle("Active model")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(`ollama::${LISTED[0]}`));

    await userEvent.selectOptions(select, `ollama::${LISTED[1]}`);
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
});
