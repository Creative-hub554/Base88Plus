/**
 * ProjectCardTags — the third metadata surface, and the live proof that
 * the #84 extraction pays off: a full editor with ZERO state-machine code
 * of its own. Pins only the shell glue: click-to-edit WITHOUT triggering
 * the card's navigation, a tags-only PATCH to /api/projects/[id]/meta,
 * the server's normalized string (per-tag trim, comma-space join)
 * winning over the draft, clearing to the placeholder fallback,
 * Save/Cancel/Escape/Enter semantics, and failure toasts that revert.
 *
 * Tags are functional: each pill is a `/?tag=` filter link (deep-linkable
 * server-side filter). Pins that pill clicks NEVER open the editor and
 * carry the right href, while the pencil remains the edit trigger for
 * non-empty cards (the whole-area affordance is empty-state only).
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectCardTags } from "../src/components/project-card-tags";
import { ToastHost, resetToasts } from "../src/components/toast";

/** Plain-anchor stand-in for next/link (no app router in unit tests). */
vi.mock("next/link", () => ({
  default: (props: {
    href: string;
    children?: React.ReactNode;
    className?: string;
    title?: string;
    "aria-label"?: string;
    "data-testid"?: string;
    onClick?: (e: { stopPropagation: () => void }) => void;
  }) =>
    React.createElement(
      "a",
      {
        href: props.href,
        className: props.className,
        title: props.title,
        "aria-label": props["aria-label"],
        "data-testid": props["data-testid"],
        onClick: (e: { preventDefault: () => void }) => {
          props.onClick?.({ stopPropagation: () => {} });
          e.preventDefault(); // keep jsdom from attempting real navigation
        },
      },
      props.children,
    ),
}));

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
    // The server's normalized value is the truth, not the local draft —
    // displayed as one filter pill per tag, each deep-linking the filter.
    expect(
      screen.getAllByTestId("card-tags-pill").map((p) => p.textContent),
    ).toEqual(["recipes", "fast", "vegan"]);
    expect(
      screen.getAllByTestId("card-tags-pill").map((p) => p.getAttribute("href")),
    ).toEqual(["/?tag=recipes", "/?tag=fast", "/?tag=vegan"]);
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
    expect(
      screen.getAllByTestId("card-tags-pill").map((p) => p.textContent),
    ).toEqual(["recipes", "fast"]);

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
    expect(
      screen.getAllByTestId("card-tags-pill").map((p) => p.textContent),
    ).toEqual(["recipes", "fast"]);
  });

  it("uses the empty-state affordance text when there are no tags yet", () => {
    renderCard("");
    const button = screen.getByTestId("card-tags-button");
    expect(button.textContent).toContain("No tags");
    expect(button.getAttribute("title")).toBe("Add tags");
  });

  it("renders one filter link per tag; a pill click never opens the editor", () => {
    renderCard();
    const pills = screen.getAllByTestId("card-tags-pill");
    expect(pills.map((p) => p.textContent)).toEqual(["recipes", "fast"]);
    // Deep-linkable server-side filter, one per stored tag.
    expect(pills[0].getAttribute("href")).toBe("/?tag=recipes");
    expect(pills[1].getAttribute("href")).toBe("/?tag=fast");
    expect(pills[0].getAttribute("aria-label")).toBe(
      "Filter projects by tag recipes",
    );

    // A pill is a filter, not an edit affordance: no editor, no fetch.
    fireEvent.click(pills[0]);
    expect(screen.queryByTestId("card-tags-input")).toBeNull();
    expect(lastWire).toBeNull();

    // The pencil is the edit trigger for non-empty cards.
    const pencil = screen.getByTestId("card-tags-button");
    expect(pencil.getAttribute("title")).toBe("Edit tags");
    fireEvent.click(pencil);
    expect(screen.getByTestId("card-tags-input")).toBeTruthy();
  });
});
