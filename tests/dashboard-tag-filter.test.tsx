/**
 * Dashboard tag filter — the leg that makes tags FUNCTIONAL: `/?tag=<tag>`
 * narrows the server-rendered grid to projects carrying that tag
 * (case-insensitive exact match), with a filter bar (count + clear) and a
 * filtered-empty state. URL IS THE STATE: no client filter state, and the
 * pill hrefs on every card point at exactly these URLs.
 *
 * Renders the REAL HomePage server component against a temp-cwd store
 * (hermetic: mkdtemp + chdir + fresh imports, the project-meta pattern).
 * The client bits (import button's router, next/link) are stubbed to
 * plain DOM equivalents — the filter itself is server logic.
 */
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectMatchesTag, splitTags } from "../src/lib/tags";

/** Plain-anchor stand-in for next/link (no app router in unit tests). */
vi.mock("next/link", () => ({
  default: (props: {
    href: string;
    children?: React.ReactNode;
    className?: string;
    "data-testid"?: string;
  }) =>
    React.createElement(
      "a",
      {
        href: props.href,
        className: props.className,
        "data-testid": props["data-testid"],
      },
      props.children,
    ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anybase-tagfilter-"));
  prevCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  cleanup();
  vi.resetModules();
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Seed three projects (two tagged, one not) and render the dashboard. */
async function renderSeeded(tag?: string) {
  const store = await import("../src/lib/store");
  const { default: HomePage } = await import("../src/app/page");
  const alpha = store.createProject("Alpha App", "first");
  store.setProjectMeta(alpha.id, { tags: "recipes, fast" });
  const beta = store.createProject("Beta App", "second");
  store.setProjectMeta(beta.id, { tags: "slow" });
  store.createProject("Gamma App", "");
  const ui = await HomePage({
    searchParams: Promise.resolve(tag === undefined ? {} : { tag }),
  });
  render(ui);
}

describe("tag helpers (shared by server filter and card pills)", () => {
  it("splitTags trims, drops empties, and tolerates missing values", () => {
    expect(splitTags(" a , b ,, ")).toEqual(["a", "b"]);
    expect(splitTags("one")).toEqual(["one"]);
    expect(splitTags(undefined)).toEqual([]);
    expect(splitTags("")).toEqual([]);
  });

  it("projectMatchesTag is a case-insensitive exact match", () => {
    expect(projectMatchesTag("recipes, fast", "recipes")).toBe(true);
    expect(projectMatchesTag("recipes, fast", "RECIPES")).toBe(true);
    expect(projectMatchesTag("recipes, fast", " fast ")).toBe(true);
    // Exact per-tag: no substring matches, no empty-tag matches.
    expect(projectMatchesTag("recipes, fast", "recipe")).toBe(false);
    expect(projectMatchesTag("recipes, fast", "ast")).toBe(false);
    expect(projectMatchesTag(undefined, "recipes")).toBe(false);
    expect(projectMatchesTag("recipes", "   ")).toBe(false);
  });
});

describe("HomePage tag filter", () => {
  it("no tag: renders every project and no filter bar", async () => {
    await renderSeeded();
    expect(screen.getByText("Alpha App")).toBeTruthy();
    expect(screen.getByText("Beta App")).toBeTruthy();
    expect(screen.getByText("Gamma App")).toBeTruthy();
    expect(screen.queryByTestId("tag-filter-bar")).toBeNull();
  });

  it("?tag= narrows the grid server-side and shows the filter bar", async () => {
    await renderSeeded("recipes");
    expect(screen.getByText("Alpha App")).toBeTruthy();
    expect(screen.queryByText("Beta App")).toBeNull();
    expect(screen.queryByText("Gamma App")).toBeNull();

    const bar = screen.getByTestId("tag-filter-bar");
    expect(bar.textContent).toContain("1 project tagged");
    expect(bar.textContent).toContain("recipes");
    expect(
      screen.getByTestId("tag-filter-clear").getAttribute("href"),
    ).toBe("/");
  });

  it("matches case-insensitively (hand-typed URLs are forgiving)", async () => {
    await renderSeeded("RECIPES");
    expect(screen.getByText("Alpha App")).toBeTruthy();
    expect(screen.queryByText("Beta App")).toBeNull();
  });

  it("zero matches: filtered-empty state with a way back", async () => {
    await renderSeeded("ghost");
    expect(screen.getByTestId("tag-filter-empty")).toBeTruthy();
    expect(screen.queryByText("Alpha App")).toBeNull();
    const back = screen.getByText("Show all apps");
    expect(back.getAttribute("href")).toBe("/");
  });

  it("filtered cards keep their pills, deep-linking the same filter", async () => {
    await renderSeeded("fast");
    expect(screen.getByText("Alpha App")).toBeTruthy();
    expect(screen.queryByText("Beta App")).toBeNull();
    expect(
      screen.getAllByTestId("card-tags-pill").map((p) => p.getAttribute("href")),
    ).toEqual(["/?tag=recipes", "/?tag=fast"]);
  });
});
