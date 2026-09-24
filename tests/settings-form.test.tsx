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

beforeEach(() => {
  calls = [];
  committed = freshCommittedSettings();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
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

async function renderForm() {
  render(<SettingsForm onDone={() => {}} />);
  await screen.findByLabelText(`API key for Ollama (local)`);
}

describe("SettingsForm — per-card saves", () => {
  it("shows a Save button per card only while that card is dirty", async () => {
    await renderForm();

    // No save buttons, no unsaved badges when everything is committed.
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    expect(screen.queryByText(/unsaved/i)).toBeNull();

    await userEvent.type(
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
    await renderForm();

    await userEvent.type(screen.getByLabelText("API key for Groq"), "gsk_real_key_0123456789abcdef");
    await userEvent.type(
      screen.getByLabelText(/Default model for Ollama/),
      "-edit",
    );

    await userEvent.click(screen.getByRole("button", { name: "Save Groq" }));
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
    await renderForm();

    await userEvent.type(
      screen.getByLabelText("API key for Groq"),
      "gsk_real_key_0123456789abcdef",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save Groq" }));
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
    await renderForm();

    await userEvent.type(
      screen.getByLabelText(/Default model for Ollama/),
      "-edit",
    );
    await userEvent.type(
      screen.getByLabelText(`Base URL for Groq`),
      "-edited",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save Ollama (local)" }));
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
    await renderForm();

    await userEvent.click(screen.getByLabelText("Use Groq"));

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
    await renderForm();

    await userEvent.click(screen.getByLabelText("Use Groq"));
    await screen.findByText("Saved ✓");

    // After commit: no dirty count, radio state consistent.
    expect(screen.queryByText(/unsaved/i)).toBeNull();
    expect((screen.getByLabelText("Use Groq") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Use Ollama (local)") as HTMLInputElement).checked).toBe(false);
  });
});
