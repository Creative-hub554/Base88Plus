/**
 * ProjectCardDescription — the list-view leg of the metadata lifecycle
 * (#77 put rename/describe in the builder header; this puts an editor on
 * every dashboard card). Pins the glue: click-to-edit WITHOUT triggering
 * the card's navigation (the card is a server-rendered <Link>; the editor
 * must stop clicks/keys at its boundary), a description-only PATCH to
 * /api/projects/[id]/meta, the server-normalized value winning over the
 * draft, the empty-description fallback, Save/Cancel/Escape semantics, and
 * failure toasts that revert instead of corrupting local state.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectCardDescription } from "../src/components/project-card-description";
import { ToastHost, resetToasts } from "../src/components/toast";

type Wire = { url: string; method: string; body: unknown };

let fetchResponse: () => Promise<Response>;
let lastWire: Wire | null = null;

function renderCard(description = "Fresh from the generator") {
  render(
    <>
      <a href="/app/p1" data-testid="card-link">
        <div data-testid="card-title">Recipe Box</div>
      </a>
      <ProjectCardDescription projectId="p1" initialDescription={description} />
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
      JSON.stringify({ project: { id: "p1", description: "Saved description" } }),
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

describe("ProjectCardDescription", () => {
  it("enters edit mode on click WITHOUT triggering the card link's navigation", async () => {
    renderCard();

    const link = screen.getByTestId("card-link");
    link.addEventListener("click", (e) => {
      e.preventDefault();
      link.dataset.navigated = "1";
    });

    fireEvent.click(screen.getByTestId("card-desc-button"));
    expect(screen.getByTestId("card-desc-input")).toBeTruthy();
    // The editor stopped the click at its boundary — the card never saw it.
    expect(cardClickNavigated()).toBe(false);
    // Same guarantee for keystrokes in edit mode.
    fireEvent.keyDown(screen.getByTestId("card-desc-input"), { key: "a" });
    expect(cardClickNavigated()).toBe(false);
  });

  it("saves a description-only PATCH and shows the server-normalized value", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("card-desc-button"));

    fireEvent.change(screen.getByTestId("card-desc-input"), {
      target: { value: "  Padded draft  " },
    });
    fireEvent.click(screen.getByTestId("card-desc-save"));

    await waitFor(() => expect(screen.getByTestId("card-desc")).toBeTruthy());
    // Wire shape: description ONLY, patched to the meta route.
    expect(lastWire?.url).toBe("/api/projects/p1/meta");
    expect(lastWire?.method).toBe("PATCH");
    expect(lastWire?.body).toEqual({ description: "Padded draft" });
    // The server's normalized value is the truth, not the local draft.
    expect(screen.getByTestId("card-desc").textContent).toContain("Saved description");
    expect(screen.getByTestId("toast-host").textContent).toContain("Description updated.");
  });

  it("clears the description when saved empty and falls back to the placeholder", async () => {
    renderCard("Something to clear");
    // The server confirms the cleared value — local state must mirror it.
    fetchResponse = async () =>
      new Response(JSON.stringify({ project: { id: "p1", description: "" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    fireEvent.click(screen.getByTestId("card-desc-button"));
    fireEvent.change(screen.getByTestId("card-desc-input"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("card-desc-save"));

    await waitFor(() => expect(screen.getByTestId("card-desc")).toBeTruthy());
    expect(lastWire?.body).toEqual({ description: "" });
    expect(screen.getByTestId("card-desc").textContent).toContain("No description");
  });

  it("cancel and Escape discard the draft without a network call", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("card-desc-button"));
    fireEvent.change(screen.getByTestId("card-desc-input"), {
      target: { value: "discarded draft" },
    });
    fireEvent.click(screen.getByTestId("card-desc-cancel"));

    expect(screen.getByTestId("card-desc")).toBeTruthy();
    expect(lastWire).toBeNull();
    expect(screen.getByTestId("card-desc").textContent).toContain(
      "Fresh from the generator",
    );

    fireEvent.click(screen.getByTestId("card-desc-button"));
    fireEvent.change(screen.getByTestId("card-desc-input"), {
      target: { value: "discarded again" },
    });
    fireEvent.keyDown(screen.getByTestId("card-desc-input"), { key: "Escape" });
    expect(screen.getByTestId("card-desc")).toBeTruthy();
    expect(lastWire).toBeNull();
  });

  it("shows a danger toast and reverts on a server rejection", async () => {
    fetchResponse = async () =>
      new Response(JSON.stringify({ error: "Update failed" }), { status: 400 });
    renderCard();
    fireEvent.click(screen.getByTestId("card-desc-button"));
    fireEvent.change(screen.getByTestId("card-desc-input"), {
      target: { value: "will not land" },
    });
    fireEvent.click(screen.getByTestId("card-desc-save"));

    await waitFor(() =>
      expect(screen.getByTestId("toast-host").textContent).toContain("Update failed"),
    );
    // Local state keeps the ORIGINAL description — the failed draft is gone.
    expect(screen.getByTestId("card-desc").textContent).toContain(
      "Fresh from the generator",
    );
  });

  it("uses the empty-state affordance text when there is no description yet", () => {
    renderCard("");
    const button = screen.getByTestId("card-desc-button");
    expect(button.textContent).toContain("No description");
    expect(button.getAttribute("title")).toBe("Add a description");
  });
});
