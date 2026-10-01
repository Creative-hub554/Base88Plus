/**
 * ProjectCardTags — the third metadata surface, and the live proof that
 * the #84 extraction pays off: a full editor with ZERO state-machine code
 * of its own. Pins only the shell glue: click-to-edit WITHOUT triggering
 * the card's navigation, a tags-only PATCH to /api/projects/[id]/meta,
 * the server's normalized string (per-tag trim, comma-space join)
 * winning over the draft, clearing to the placeholder fallback,
 * Save/Cancel/Escape/Enter semantics, and failure toasts that revert.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectCardTags } from "../src/components/project-card-tags";
import { ToastHost, resetToasts } from "../src/components/toast";

type Wire = { url: string; method: string; body: unknown };

let fetchResponse: () => Promise<Response>;
let lastWire: Wire | null = null;

function renderCard(tags = "recipes, fast") {
  render(
    <>
      <a href="/app/p1" data-testid="card-link">
        <div data-testid="card-title">Recipe Box</div>
      </a>
      <ProjectCardTags projectId="p1" initialTags={tags} />
      <ToastHost />
    </>,
  );
}

/** The card <Link> the editor must never trigger. */
function cardClickNavigated(): boolean {
  const link = screen.getByTestId("card-link");
  return link.dataset.navigated === "1";
}

beforeEach(() => {
  lastWire = null;
  fetchResponse = async () =>
    new Response(
      JSON.stringify({ project: { id: "p1", tags: "recipes, fast, vegan" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      lastWire = {
        url: String(_input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      return fetchResponse();
    }),
  );
});

afterEach(() => {
  cleanup();
  resetToasts();
  vi.unstubAllGlobals();
});

describe("ProjectCardTags (via useInlineMetaEdit)", () => {
  it("enters edit mode on click WITHOUT triggering the card link's navigation", async () => {
    renderCard();

    const link = screen.getByTestId("card-link");
    link.addEventListener("click", (e) => {
      e.preventDefault();
      link.dataset.navigated = "1";
    });

    fireEvent.click(screen.getByTestId("card-tags-button"));
    expect(screen.getByTestId("card-tags-input")).toBeTruthy();
    // The editor stopped the click at its boundary — the card never saw it.
    expect(cardClickNavigated()).toBe(false);
    // Same guarantee for keystrokes in edit mode.
    fireEvent.keyDown(screen.getByTestId("card-tags-input"), { key: "a" });
    expect(cardClickNavigated()).toBe(false);
  });

  it("sends a tags-only PATCH and displays the server-normalized string", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("card-tags-button"));

    fireEvent.change(screen.getByTestId("card-tags-input"), {
      target: { value: "  soup , , chili ,, bread  " },
    });
    fireEvent.click(screen.getByTestId("card-tags-save"));

    await waitFor(() => expect(screen.getByTestId("card-tags")).toBeTruthy());
    // Wire shape: tags ONLY (whole-string trimmed by the hook), patched
    // to the meta route. Per-TAG trimming/joining is the server's job.
    expect(lastWire?.url).toBe("/api/projects/p1/meta");
    expect(lastWire?.method).toBe("PATCH");
    expect(lastWire?.body).toEqual({ tags: "soup , , chili ,, bread" });
    // The server's normalized value is the truth, not the local draft.
    expect(screen.getByTestId("card-tags").textContent).toContain("recipes, fast, vegan");
    expect(screen.getByTestId("toast-host").textContent).toContain("Tags updated.");
  });

  it("clears tags when saved empty and falls back to the placeholder", async () => {
    renderCard("something to clear");
    // The server confirms the cleared value — local state must mirror it.
    fetchResponse = async () =>
      new Response(JSON.stringify({ project: { id: "p1", tags: "" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    fireEvent.click(screen.getByTestId("card-tags-button"));
    fireEvent.change(screen.getByTestId("card-tags-input"), { target: { value: " , " } });
    fireEvent.click(screen.getByTestId("card-tags-save"));

    await waitFor(() => expect(screen.getByTestId("card-tags")).toBeTruthy());
    expect(lastWire?.body).toEqual({ tags: "," });
    expect(screen.getByTestId("card-tags").textContent).toContain("No tags");
  });

  it("cancel and Escape discard the draft without a network call", () => {
    renderCard();
    fireEvent.click(screen.getByTestId("card-tags-button"));
    fireEvent.change(screen.getByTestId("card-tags-input"), {
      target: { value: "discarded draft" },
    });
    fireEvent.click(screen.getByTestId("card-tags-cancel"));

    expect(screen.getByTestId("card-tags")).toBeTruthy();
    expect(lastWire).toBeNull();
    expect(screen.getByTestId("card-tags").textContent).toContain("recipes, fast");

    fireEvent.click(screen.getByTestId("card-tags-button"));
    fireEvent.change(screen.getByTestId("card-tags-input"), {
      target: { value: "discarded again" },
    });
    fireEvent.keyDown(screen.getByTestId("card-tags-input"), { key: "Escape" });
    expect(screen.getByTestId("card-tags")).toBeTruthy();
    expect(lastWire).toBeNull();
  });

  it("Enter commits without a network round-trip through Save", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("card-tags-button"));
    fireEvent.change(screen.getByTestId("card-tags-input"), {
      target: { value: "enter-committed" },
    });
    fireEvent.keyDown(screen.getByTestId("card-tags-input"), { key: "Enter" });

    await waitFor(() => expect(lastWire).not.toBeNull());
    expect(lastWire?.body).toEqual({ tags: "enter-committed" });
  });

  it("shows a danger toast and reverts on a server rejection", async () => {
    fetchResponse = async () =>
      new Response(JSON.stringify({ error: "Update failed" }), { status: 400 });
    renderCard();
    fireEvent.click(screen.getByTestId("card-tags-button"));
    fireEvent.change(screen.getByTestId("card-tags-input"), {
      target: { value: "will not land" },
    });
    fireEvent.click(screen.getByTestId("card-tags-save"));

    await waitFor(() =>
      expect(screen.getByTestId("toast-host").textContent).toContain("Update failed"),
    );
    // Local state keeps the ORIGINAL tags — the failed draft is gone.
    expect(screen.getByTestId("card-tags").textContent).toContain("recipes, fast");
  });

  it("uses the empty-state affordance text when there are no tags yet", () => {
    renderCard("");
    const button = screen.getByTestId("card-tags-button");
    expect(button.textContent).toContain("No tags");
    expect(button.getAttribute("title")).toBe("Add tags");
  });
});
