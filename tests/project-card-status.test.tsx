/**
 * ProjectCardStatus — the FOURTH metadata surface and the first
 * application of recipe 7. Pins the shell glue: the select widget over
 * PROJECT_STATUSES, the status-only PATCH, server-wins value, the
 * no-navigation contract, Save/Cancel/Escape semantics (no Enter commit
 * for a select), and the badge-as-filter-link with the pencil owning
 * edits once a status exists. A server enum-rejection (400 "Invalid
 * status") toasts and reverts.
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectCardStatus } from "../src/components/project-card-status";
import { ToastHost, resetToasts } from "../src/components/toast";

/** Plain-anchor stand-in for next/link-style navigation in unit tests. */
vi.mock("next/link", () => ({
  default: (props: {
    href: string;
    children?: React.ReactNode;
    className?: string;
    "data-testid"?: string;
    onClick?: (e: { stopPropagation: () => void }) => void;
  }) =>
    React.createElement(
      "a",
      {
        href: props.href,
        className: props.className,
        "data-testid": props["data-testid"],
        onClick: (e: { preventDefault: () => void }) => {
          props.onClick?.({ stopPropagation: () => {} });
          e.preventDefault();
        },
      },
      props.children,
    ),
}));

/** The card shell owns a router for the board view's soft refresh. */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

type Wire = { url: string; method: string; body: unknown };

let fetchResponse: () => Promise<Response>;
let lastWire: Wire | null = null;

function renderCard(status = "") {
  render(
    <>
      <a href="/app/p1" data-testid="card-link">
        <div data-testid="card-title">Recipe Box</div>
      </a>
      <ProjectCardStatus projectId="p1" initialStatus={status} />
      <ToastHost />
    </>,
  );
}

function cardClickNavigated(): boolean {
  const link = screen.getByTestId("card-link");
  return link.dataset.navigated === "1";
}

beforeEach(() => {
  lastWire = null;
  fetchResponse = async () =>
    new Response(JSON.stringify({ project: { id: "p1", status: "shipped" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
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

describe("ProjectCardStatus (via useInlineMetaEdit)", () => {
  it("empty state opens the editor on click WITHOUT triggering card navigation", () => {
    renderCard();

    const link = screen.getByTestId("card-link");
    link.addEventListener("click", (e) => {
      e.preventDefault();
      link.dataset.navigated = "1";
    });

    fireEvent.click(screen.getByTestId("card-status-button"));
    const select = screen.getByTestId("card-status-select") as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(cardClickNavigated()).toBe(false);
    // Enum options + the empty placeholder.
    const values = [...select.options].map((o) => o.value);
    expect(values).toEqual(["", "idea", "building", "shipped"]);
    // Keystrokes stay at the boundary too.
    fireEvent.keyDown(select, { key: "a" });
    expect(cardClickNavigated()).toBe(false);
  });

  it("sends a status-only PATCH and shows the server-confirmed value as a filter badge", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("card-status-button"));
    fireEvent.change(screen.getByTestId("card-status-select"), {
      target: { value: "shipped" },
    });
    fireEvent.click(screen.getByTestId("card-status-save"));

    await waitFor(() => expect(screen.getByTestId("card-status")).toBeTruthy());
    expect(lastWire?.url).toBe("/api/projects/p1/meta");
    expect(lastWire?.method).toBe("PATCH");
    expect(lastWire?.body).toEqual({ status: "shipped" });
    const badge = screen.getByTestId("card-status-badge");
    expect(badge.textContent).toBe("shipped");
    expect(badge.getAttribute("href")).toBe("/?status=shipped");
    expect(screen.getByTestId("toast-host").textContent).toContain(
      "Status set to shipped.",
    );
  });

  it("cancel and Escape discard without a network call; Enter does not commit", () => {
    renderCard("building");
    fireEvent.click(screen.getByTestId("card-status-button"));
    fireEvent.change(screen.getByTestId("card-status-select"), {
      target: { value: "idea" },
    });
    fireEvent.keyDown(screen.getByTestId("card-status-select"), { key: "Enter" });
    expect(lastWire).toBeNull(); // select: no Enter commit
    fireEvent.click(screen.getByTestId("card-status-cancel"));
    expect(screen.getByTestId("card-status-badge").textContent).toBe("building");

    fireEvent.click(screen.getByTestId("card-status-button"));
    fireEvent.keyDown(screen.getByTestId("card-status-select"), { key: "Escape" });
    expect(screen.getByTestId("card-status-badge").textContent).toBe("building");
    expect(lastWire).toBeNull();
  });

  it("shows the server's enum-rejection toast and reverts", async () => {
    fetchResponse = async () =>
      new Response(JSON.stringify({ error: "Invalid status — must be one of: idea, building, shipped" }), {
        status: 400,
      });
    renderCard("idea");
    fireEvent.click(screen.getByTestId("card-status-button"));
    fireEvent.change(screen.getByTestId("card-status-select"), {
      target: { value: "building" },
    });
    fireEvent.click(screen.getByTestId("card-status-save"));

    await waitFor(() =>
      expect(screen.getByTestId("toast-host").textContent).toContain("Invalid status"),
    );
    expect(screen.getByTestId("card-status-badge").textContent).toBe("idea");
  });

  it("uses the empty-state affordance text when no status is set", () => {
    renderCard("");
    const button = screen.getByTestId("card-status-button");
    expect(button.textContent).toContain("No status");
    expect(button.getAttribute("title")).toBe("Set status");
  });
});
