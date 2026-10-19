/**
 * Component tests for the SettingsForm per-card save model.
 *
 * Contract: each provider card saves independently —
 *   • a card's Save button posts ONLY that provider's diff (changed
 *     fields, trimmed key) and appears exactly when the card is dirty;
 *   • there is no global save — switching providers commits the active
 *     pair immediately, clearing the model so the new provider's own
 *     default applies (posting the previous provider's model to the new
 *     provider was the latent bug this model eliminates);
 *   • a key save triggers one refresh GET so the configured badge can
 *     flip; model/base-URL saves do not;
 *   • indicators: "unsaved" while dirty, "Saved ✓" after a card commits,
 *     and the header count reflects remaining dirty cards.
 *
 * The fetch stub is stateful and merges POSTs exactly like the real
 * settings route (partial merge, key flips `configured`, keys redacted).
 *
 * The model browser added under each card is pinned too: it is fed by
 * /api/models (the pickers' own read), it shows each model's PUBLISHED facts
 * with their attribution, it orders them by price or context window with
 * models nobody published a number for always last — and picking one only
 * fills the card's model field, so the card's own diff-save is still the
 * only thing that writes. Without a catalogue there is no browser at all.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsForm } from "../src/components/builder-client";

type Call = { url: string; body?: Record<string, unknown> };

let calls: Call[];

function freshCommittedSettings() {
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
        configured: true,
      },
      {
        id: "groq",
        name: "Groq",
        kind: "openai-compatible",
        baseURL: "https://api.groq.com/openai/v1",
        defaultModel: "llama-3.3-70b-versatile",
        configured: false,
      },
    ],
  };
}

let committed: ReturnType<typeof freshCommittedSettings>;
/** What GET /api/models answers — the settings page reads it for the browser. */
let catalog: { providers: unknown[] };

beforeEach(() => {
  calls = [];
  committed = freshCommittedSettings();
  catalog = { providers: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/api/models")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(catalog),
        } as Response);
      }
      if (url.endsWith("/api/settings") && !init?.method) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ settings: committed }),
        } as Response);
      }
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      if (body?.provider) {
        const prov = body.provider as Record<string, unknown> & { id: string };
        const target = committed.providers.find((p) => p.id === prov.id);
        if (target) {
          if (typeof prov.baseURL === "string") target.baseURL = prov.baseURL;
          if (typeof prov.defaultModel === "string") target.defaultModel = prov.defaultModel;
          if (typeof prov.apiKey === "string") target.configured = true;
        }
      }
      if (typeof body?.activeProviderId === "string") {
        committed.activeProviderId = body.activeProviderId as string;
        if (typeof body.activeModel === "string") committed.activeModel = body.activeModel;
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function summarize() {
  const providerPosts = calls
    .filter((c) => typeof c.body?.provider === "object")
    .map((c) => (c.body!.provider as { id: string }).id);
  const activePosts = calls.filter((c) => "activeProviderId" in (c.body ?? {}));
  return { providerPosts, activePosts };
}

/** The card container for a provider, for scoped queries. */
function cardOf(name: string): HTMLElement {
  const label = screen.getByLabelText(`API key for ${name}`);
  return label.closest("div.rounded-xl") as HTMLElement;
}

/**
 * `delay: null` is load-bearing. user-event's default `delay: 0` is not "no
 * delay": it awaits a real `setTimeout(resolve, 0)` between EVERY keystroke
 * (user-event/dist/cjs/utils/misc/wait.js — the `typeof delay !== 'number'`
 * branch is the only way to skip it). A 30-character key plus a click costs
 * ~35 event-loop round trips whose wall time is pure scheduler contention, so
 * under 2x CPU oversubscription two tests in this file measured 3.6s and 3.8s
 * against vitest's 5s budget, and the suite has already reported them as
 * timeouts. Interactions still fire as real per-key input events; only the
 * timer hop is gone, and no assertion changes.
 */
async function renderForm() {
  const user = userEvent.setup({ delay: null });
  render(<SettingsForm onDone={() => {}} />);
  await screen.findByLabelText(`API key for Ollama (local)`);
  return user;
}

describe("SettingsForm — per-card saves", () => {
  it("shows a Save button per card only while that card is dirty", async () => {
    const user = await renderForm();

    // No save buttons, no unsaved badges when everything is committed.
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    expect(screen.queryByText(/unsaved/i)).toBeNull();

    await user.type(
      screen.getByLabelText("API key for Groq"),
      "gsk_real_key_0123456789abcdef",
    );

    // Groq's card now has a Save button + unsaved badge; Ollama's doesn't.
    const groqCard = cardOf("Groq");
    expect(within(groqCard).getByRole("button", { name: "Save Groq" })).toBeTruthy();
    expect(within(groqCard).getByText("unsaved")).toBeTruthy();
    const ollamaCard = cardOf("Ollama (local)");
    expect(within(ollamaCard).queryByRole("button")).toBeNull();

    // Header count reflects exactly one dirty card.
    expect(screen.getByText("Unsaved change")).toBeTruthy();
  });

  it("saving one card does not post or clear another card's edits", async () => {
    const user = await renderForm();

    await user.type(screen.getByLabelText("API key for Groq"), "gsk_real_key_0123456789abcdef");
    await user.type(
      screen.getByLabelText(/Default model for Ollama/),
      "-edit",
    );

    await user.click(screen.getByRole("button", { name: "Save Groq" }));
    await waitFor(() => expect(within(cardOf("Groq")).getByText("Saved ✓")).toBeTruthy());

    const { providerPosts } = summarize();
    expect(providerPosts).toEqual(["groq"]); // only the saved card posted

    // Ollama's untouched edit survives the other card's save.
    expect(
      (screen.getByLabelText(/Default model for Ollama/) as HTMLInputElement).value,
    ).toBe("qwen2.5-coder:1.5b-edit");
    expect(screen.getByText("Unsaved change")).toBeTruthy();
  });

  it("posts a diff-only payload and flips the configured badge after a key save", async () => {
    const user = await renderForm();

    await user.type(
      screen.getByLabelText("API key for Groq"),
      "gsk_real_key_0123456789abcdef",
    );
    await user.click(screen.getByRole("button", { name: "Save Groq" }));
    await waitFor(() => expect(within(cardOf("Groq")).getByText("Saved ✓")).toBeTruthy());

    const body = calls.find((c) => c.body?.provider)?.body
      ?.provider as Record<string, unknown>;
    expect(body).toEqual({ id: "groq", apiKey: "gsk_real_key_0123456789abcdef" });

    // Refresh GET re-synced badges — Groq flips to configured.
    await waitFor(() =>
      expect(within(cardOf("Groq")).getByText("configured")).toBeTruthy(),
    );
  });

  it("model and base-URL saves post their diffs without a refresh", async () => {
    const user = await renderForm();

    await user.type(
      screen.getByLabelText(/Default model for Ollama/),
      "-edit",
    );
    await user.type(
      screen.getByLabelText(`Base URL for Groq`),
      "-edited",
    );
    await user.click(screen.getByRole("button", { name: "Save Ollama (local)" }));
    await waitFor(() => expect(within(cardOf("Ollama (local)")).getByText("Saved ✓")).toBeTruthy());

    const { providerPosts } = summarize();
    expect(providerPosts).toEqual(["ollama"]);
    const body = calls.find((c) => c.body?.provider)?.body
      ?.provider as Record<string, unknown>;
    expect(body).toEqual({
      id: "ollama",
      defaultModel: "qwen2.5-coder:1.5b-edit",
    });

    // No key in this save → no refresh GET (only the initial load).
    const gets = calls.filter(
      (c) => c.url.endsWith("/api/settings") && c.body === undefined,
    );
    expect(gets).toHaveLength(1);
  });

  it("switching the active provider commits immediately and clears the model", async () => {
    const user = await renderForm();

    await user.click(screen.getByLabelText("Use Groq"));

    await waitFor(() => {
      const { providerPosts, activePosts } = summarize();
      expect(providerPosts).toEqual([]);
      expect(activePosts.map((c) => c.body)).toEqual([
        { activeProviderId: "groq", activeModel: "" },
      ]);
    });
    // No save buttons appeared anywhere — the radio is the commit.
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
  });

  it("shows the active-pair Saved ✓ confirmation and header count clears", async () => {
    const user = await renderForm();

    await user.click(screen.getByLabelText("Use Groq"));
    await screen.findByText("Saved ✓");

    // After commit: no dirty count, radio state consistent.
    expect(screen.queryByText(/unsaved/i)).toBeNull();
    expect((screen.getByLabelText("Use Groq") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Use Ollama (local)") as HTMLInputElement).checked).toBe(false);
  });
});

/**
 * A catalogue with four shapes: the card's current model (a dataset row, so
 * attribution is exercised), one cheap narrow model, one expensive wide one,
 * and one nobody published a number for.
 */
function catalogFixture() {
  return {
    providers: [
      {
        id: "ollama",
        name: "Ollama (local)",
        configured: true,
        defaultModel: "qwen2.5-coder:1.5b",
        models: [
          "qwen2.5-coder:1.5b",
          "mystery-model",
          "small-cheap",
          "wide-expensive",
        ],
        metadata: {
          "qwen2.5-coder:1.5b": {
            source: "models.dev",
            name: "Qwen2.5 Coder 1.5B",
            contextLength: 32_768,
            maxCompletionTokens: 16_384,
            pricePerMTokInput: 0.09,
            pricePerMTokOutput: 0.29,
            supportsTools: true,
          },
          "small-cheap": {
            source: "provider",
            contextLength: 8_192,
            pricePerMTokInput: 0.05,
          },
          "wide-expensive": {
            source: "provider",
            contextLength: 1_048_576,
            pricePerMTokInput: 3,
          },
        },
      },
    ],
  };
}

describe("SettingsForm — the model browser", () => {
  const card = () => cardOf("Ollama (local)");
  const sortControl = () => within(card()).getByLabelText("Sort models for Ollama (local)");
  /** The ids in rendered order — the row's own span, not its facts line. */
  const order = () =>
    within(card())
      .getAllByRole("listitem")
      .map((li) => li.querySelector("span")?.textContent ?? "");

  async function expanded() {
    const user = await renderForm();
    await user.click(
      within(card()).getByRole("button", {
        name: "Browse models for Ollama (local)",
      }),
    );
    return user;
  }

  it("shows the current model's published facts before anything is expanded", async () => {
    catalog = catalogFixture();
    await renderForm();

    const facts = await within(card()).findByText(/32.8k ctx/);
    expect(facts.textContent).toContain("Qwen2.5 Coder 1.5B");
    expect(facts.textContent).toContain("max 16.4k out");
    expect(facts.textContent).toContain("$0.09/$0.29 per Mtok");
    // Attribution travels into settings as well: this row is not the vendor's.
    expect(facts.textContent).toContain("via models.dev");
    expect(within(card()).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("lists every model with its facts, and a click only fills the card's field", async () => {
    catalog = catalogFixture();
    const user = await expanded();

    expect(order()).toEqual([
      "qwen2.5-coder:1.5b",
      "mystery-model",
      "small-cheap",
      "wide-expensive",
    ]);
    // Every model is listed; the one nobody published a number for simply has
    // no facts line, rather than a line of zeros.
    const rows = within(card()).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(rows[2]).toContain("8.2k ctx");
    expect(rows[3]).toContain("1.05M ctx");
    expect(rows[1]).not.toContain("ctx");

    // Picking writes NOTHING: it fills the field, and the card's own
    // diff-save remains the only thing that posts (the contract above).
    await user.click(within(card()).getByText("wide-expensive"));
    expect(
      (screen.getByLabelText(/Default model for Ollama/) as HTMLInputElement)
        .value,
    ).toBe("wide-expensive");
    expect(within(card()).getByText("unsaved")).toBeTruthy();
    expect(calls.filter((c) => c.body?.provider)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Save Ollama (local)" }));
    await waitFor(() =>
      expect(calls.find((c) => c.body?.provider)?.body?.provider).toEqual({
        id: "ollama",
        defaultModel: "wide-expensive",
      }),
    );
  });

  it("orders by price or context window, and an unpublished number never wins", async () => {
    catalog = catalogFixture();
    const user = await expanded();

    await user.selectOptions(sortControl(), "price");
    expect(order()).toEqual([
      "small-cheap",
      "qwen2.5-coder:1.5b",
      "wide-expensive",
      // Last in BOTH directions: silence is not cheap and not small.
      "mystery-model",
    ]);

    await user.selectOptions(sortControl(), "context");
    expect(order()).toEqual([
      "wide-expensive",
      "qwen2.5-coder:1.5b",
      "small-cheap",
      "mystery-model",
    ]);

    await user.selectOptions(sortControl(), "default");
    expect(order()[0]).toBe("qwen2.5-coder:1.5b");
    expect(order()[3]).toBe("wide-expensive");
  });

  it("offers nothing to browse when there is no catalogue", async () => {
    // The shipped default: every provider listed no models.
    await renderForm();
    expect(
      within(card()).queryByRole("button", { name: /Browse/ }),
    ).toBeNull();
    expect(
      within(cardOf("Groq")).queryByRole("button", { name: /Browse/ }),
    ).toBeNull();
  });

  it("survives a catalogue response with no providers in it", async () => {
    catalog = {} as never;
    await renderForm();
    // The model field is all this card ever required; a shapeless payload
    // must cost a convenience, not the page.
    expect(screen.getByLabelText(/Default model for Ollama/)).toBeTruthy();
    expect(within(card()).queryByRole("button", { name: /Browse/ })).toBeNull();
  });
});
