/**
 * Dashboard board view — `/?view=board` swaps the grid for a three-column
 * status board (idea / building / shipped). Pins the view contract:
 *
 * - the URL IS the state: exact-match "board" opts in, anything else
 *   (including "BOARD") renders the default grid;
 * - the board is a VIEW over the same filtered set — ?tag= and ?status=
 *   AND into it exactly as they do into the grid, and empty columns
 *   still render (a column with (0) is information);
 * - projects without a status keep a home in a trailing "No status"
 *   column instead of vanishing;
 * - board cards drop the description surface but keep tags + status
 *   (pills/badges still deep-link their filters);
 * - a status save on a BOARD card soft-refreshes (router.refresh) so the
 *   card re-sorts into its new column — the grid never does;
 * - the Grid/Board toggle preserves an active filter in its href.
 *
 * Renders the REAL HomePage server component against a temp-cwd store
 * (the dashboard-tag-filter pattern); next/link and next/navigation are
 * stubbed to plain DOM equivalents.
 */
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Plain-anchor stand-in for next/link (no app router in unit tests). */
vi.mock("next/link", () => ({
  default: (props: {
    href: string;
    children?: React.ReactNode;
    className?: string;
    "data-testid"?: string;
    "aria-current"?: string;
  }) =>
    React.createElement(
      "a",
      {
        href: props.href,
        className: props.className,
        "data-testid": props["data-testid"],
        "aria-current": props["aria-current"],
      },
      props.children,
    ),
}));

/** Shared refresh mock so board/grid refresh wiring is assertable. */
const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: refreshMock }),
}));

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-board-"));
  prevCwd = process.cwd();
  process.chdir(tmp);
  refreshMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.resetModules();
  vi.unstubAllGlobals();
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Seed three projects and render the dashboard with the given params. */
async function renderSeeded(
  filter?: { tag?: string; status?: string; view?: string },
): Promise<{ betaId: string }> {
  const store = await import("../src/lib/store");
  const { default: HomePage } = await import("../src/app/page");
  const alpha = store.createProject("Alpha App", "first");
  store.setProjectMeta(alpha.id, { tags: "recipes, fast", status: "shipped" });
  const beta = store.createProject("Beta App", "second");
  store.setProjectMeta(beta.id, { tags: "slow", status: "building" });
  store.createProject("Gamma App", "");
  const ui = await HomePage({
    searchParams: Promise.resolve(filter ?? {}),
  });
  render(ui);
  return { betaId: beta.id };
}

function columnHas(column: string, name: string): boolean {
  return (
    screen.getByTestId(`board-column-${column}`).textContent?.includes(name) ??
    false
  );
}

describe("board view", () => {
  it("default view is the unchanged grid: no board, description surface present", async () => {
    await renderSeeded();
    expect(screen.queryByTestId("board")).toBeNull();
    expect(screen.queryByTestId("board-column-idea")).toBeNull();
    expect(screen.getAllByTestId("card-desc").length).toBe(3);
    expect(screen.getByText("Alpha App")).toBeTruthy();
    expect(screen.getByText("Beta App")).toBeTruthy();
    expect(screen.getByText("Gamma App")).toBeTruthy();
  });

  it("?view=board renders three status columns; unstatused projects land in No status", async () => {
    await renderSeeded({ view: "board" });
    expect(screen.getByTestId("board")).toBeTruthy();
    // All three enum columns exist even when empty; Gamma is unstatused.
    for (const col of ["idea", "building", "shipped", "none"]) {
      expect(screen.getByTestId(`board-column-${col}`)).toBeTruthy();
    }
    expect(columnHas("shipped", "Alpha App")).toBe(true);
    expect(columnHas("building", "Beta App")).toBe(true);
    expect(columnHas("none", "Gamma App")).toBe(true);
    // ...and nowhere else.
    expect(columnHas("idea", "Alpha App")).toBe(false);
    expect(columnHas("shipped", "Beta App")).toBe(false);
    expect(columnHas("building", "Gamma App")).toBe(false);
    // Counts are visible: one shipped, zero ideas.
    expect(screen.getByTestId("board-column-shipped").textContent).toContain(
      "(1)",
    );
    expect(screen.getByTestId("board-column-idea").textContent).toContain(
      "(0)",
    );
  });

  it("the view match is exact: 'BOARD' and 'grid' fall back to the default grid", async () => {
    await renderSeeded({ view: "BOARD" });
    expect(screen.queryByTestId("board")).toBeNull();
    expect(screen.getAllByTestId("card-desc").length).toBe(3);
    await cleanup();
    await renderSeeded({ view: "grid" });
    expect(screen.queryByTestId("board")).toBeNull();
  });

  it("board cards drop the description surface but keep tags and status deep links", async () => {
    await renderSeeded({ view: "board" });
    // No description editors anywhere on the board.
    expect(screen.queryByTestId("card-desc")).toBeNull();
    // Tags survive as filter pills (Alpha: recipes, fast).
    const pills = screen
      .getAllByTestId("card-tags-pill")
      .map((p) => p.getAttribute("href"));
    expect(pills).toContain("/?tag=recipes");
    expect(pills).toContain("/?tag=fast");
    expect(pills).toContain("/?tag=slow");
    // Set statuses render as filter badges (one per occupied column);
    // Gamma keeps the empty affordance.
    expect(
      within(screen.getByTestId("board-column-shipped")).getByTestId(
        "card-status-badge",
      ).getAttribute("href"),
    ).toBe("/?status=shipped");
    expect(
      within(screen.getByTestId("board-column-building")).getByTestId(
        "card-status-badge",
      ).getAttribute("href"),
    ).toBe("/?status=building");
    const noneColumn = within(screen.getByTestId("board-column-none"));
    expect(
      noneColumn.getByTestId("card-status-button").textContent,
    ).toContain("No status");
  });

  it("tag and status filters AND into the board exactly as into the grid", async () => {
    await renderSeeded({ tag: "slow", view: "board" });
    expect(screen.getByTestId("tag-filter-bar")).toBeTruthy();
    expect(columnHas("building", "Beta App")).toBe(true);
    expect(columnHas("shipped", "Alpha App")).toBe(false);
    expect(screen.queryByText("Gamma App")).toBeNull();

    await cleanup();
    await renderSeeded({ status: "building", view: "board" });
    expect(columnHas("building", "Beta App")).toBe(true);
    expect(columnHas("shipped", "Alpha App")).toBe(false);
    expect(screen.queryByTestId("board-column-none")).toBeNull(); // no unstatused left
  });

  it("a status save on a board card triggers router.refresh (card re-sorts into its new column)", async () => {
    const { betaId } = await renderSeeded({ view: "board" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Response(
            JSON.stringify({ project: { id: "beta", status: "idea" } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const building = within(screen.getByTestId("board-column-building"));
    fireEvent.click(building.getByTestId("card-status-button"));
    fireEvent.change(building.getByTestId("card-status-select"), {
      target: { value: "idea" },
    });
    fireEvent.click(building.getByTestId("card-status-save"));

    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      `/api/projects/${betaId}/meta`,
    );
  });

  it("a status save on a GRID card never refreshes (the card does not move)", async () => {
    await renderSeeded();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Response(
            JSON.stringify({ project: { id: "alpha", status: "building" } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const alphaCard = screen.getByText("Alpha App").closest("li") as HTMLElement;
    fireEvent.click(within(alphaCard).getByTestId("card-status-button"));
    fireEvent.change(within(alphaCard).getByTestId("card-status-select"), {
      target: { value: "building" },
    });
    fireEvent.click(within(alphaCard).getByTestId("card-status-save"));

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    // Let any (wrong) refresh land before asserting the negative.
    await new Promise((r) => setTimeout(r, 5));
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("the Grid/Board toggle preserves an active filter and marks the active view", async () => {
    await renderSeeded();
    const boardLink = screen.getByTestId("view-board-link");
    expect(boardLink.getAttribute("href")).toBe("/?view=board");
    expect(screen.getByTestId("view-grid-link").getAttribute("href")).toBe("/");
    expect(screen.getByTestId("view-grid-link").getAttribute("aria-current")).toBe(
      "page",
    );
    expect(boardLink.getAttribute("aria-current")).toBeNull();

    await cleanup();
    await renderSeeded({ tag: "slow", view: "board" });
    expect(screen.getByTestId("view-grid-link").getAttribute("href")).toBe(
      "/?tag=slow",
    );
    // The board link keeps its own view param even when already on board.
    expect(screen.getByTestId("view-board-link").getAttribute("href")).toBe(
      "/?tag=slow&view=board",
    );
    expect(
      screen.getByTestId("view-board-link").getAttribute("aria-current"),
    ).toBe("page");
  });
});
