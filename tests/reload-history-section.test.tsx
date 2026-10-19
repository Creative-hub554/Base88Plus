/**
 * Component tests for the settings page's reload panel.
 *
 * Contract, in the order an operator meets it:
 *   • every reload shown is named with the SAME word the deploy gate uses, and
 *     coloured by the same `landed` flag — a panel that called a rollback fine
 *     while `npm run check:reload-history` failed the deploy over it would be
 *     worse than no panel;
 *   • the panel degrades to a sentence for each way there is nothing to show
 *     (not configured, no file yet, no reload yet, a failed request) and never
 *     takes the rest of the settings page down with it;
 *   • an outcome this build does not know is shown VERBATIM and labelled unknown,
 *     because a page that silently folded it into "fine" would be the false pass
 *     the gate exists to refuse;
 *   • the count says "ten of thirty" rather than implying ten is all there is;
 *   • Refresh re-reads, which is the whole point of a panel an operator watches
 *     while a deploy runs.
 *
 * The fixtures are built by `reloadRecord` (the writer) and read with the shared
 * `parseReloadHistory`, so the panel is pinned against what the route actually
 * returns rather than against a hand-written response.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReloadHistorySection } from "../src/components/reload-history-section";
import {
  parseReloadHistory,
  type ReloadHistoryView,
} from "../src/lib/deploy/reload-history";
import { reloadRecord } from "../scripts/supervise.mjs";

const AT = Date.parse("2026-10-14T12:00:00.000Z");

type Outcome = "replaced" | "stopped" | "kept" | "rolled-back" | "no-fallback";

const recordFor = (outcome: Outcome, overrides: Record<string, unknown> = {}) =>
  reloadRecord({
    asked: "/srv/.reload",
    outcome,
    closedBy: outcome === "kept" ? null : "traffic",
    detail: outcome === "replaced" ? null : `${outcome} happened`,
    startedAt: AT - 2_500,
    at: AT,
    swappedAt: outcome === "kept" ? null : AT - 2_000,
    windowMs: 30_000,
    proofConnections: 3,
    served: 64,
    checks: 2,
    leftoverConnections: 0,
    replacementPort: 51_234,
    previousPort: 51_235,
    frontPort: 3_000,
    ...overrides,
  });

/** A view exactly as `GET /api/deploy/reloads` builds one. */
function viewOf(
  outcomes: (Outcome | string)[],
  overrides: Partial<ReloadHistoryView> = {},
): ReloadHistoryView {
  // Newest first, one minute apart, in the order given — and ordered the way the
  // route orders them, so the panel is tested against what it is actually handed.
  const text = `${outcomes
    .map((outcome, index) => {
      const at = AT - index * 60_000;
      return JSON.stringify(
        recordFor(outcome as Outcome, {
          at,
          startedAt: at - 2_500,
          // A `kept` reload never opened a window: nothing was swapped in.
          swappedAt: outcome === "kept" ? null : at - 2_000,
        }),
      );
    })
    .join("\n")}\n`;
  const { records, unreadable } = parseReloadHistory(text);
  return {
    configured: true,
    path: "/srv/reloads.jsonl",
    total: records.length,
    records: [...records].sort((left, right) => right.atMs - left.atMs),
    unreadable,
    error: null,
    ...overrides,
  };
}

let views: ReloadHistoryView[];
let fetchCount: number;

beforeEach(() => {
  fetchCount = 0;
  views = [viewOf(["replaced"])];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/deploy/reloads");
      const view = views[Math.min(fetchCount, views.length - 1)];
      fetchCount += 1;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(view) } as Response);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPanel() {
  const user = userEvent.setup({ delay: null });
  render(<ReloadHistorySection />);
  return user;
}

describe("ReloadHistorySection", () => {
  it("names each reload with the gate's own words and colours", async () => {
    views = [viewOf(["replaced", "rolled-back", "kept"])];
    await renderPanel();

    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(3);
    // Newest first, as the route returns them.
    expect(within(rows[0]).getByText("REPLACED")).toBeTruthy();
    expect(within(rows[1]).getByText("ROLLED BACK")).toBeTruthy();
    expect(within(rows[1]).getByText(/the port went back to the run it replaced/)).toBeTruthy();
    expect(within(rows[2]).getByText("NOTHING CHANGED")).toBeTruthy();

    // The evidence travels with the row: the window, what closed it, and what the
    // app actually did through the replacement.
    expect(rows[0].textContent).toContain("window 2000ms of 30000ms, closed by traffic");
    expect(rows[0].textContent).toContain("64 real connection(s) from the app, 2 health check(s)");
    // A reload with no window says so in words rather than showing a zero.
    expect(rows[2].textContent).toContain("no window was ever open");
    expect(screen.getByText("3 reload(s) recorded in /srv/reloads.jsonl")).toBeTruthy();
  });

  it("says how many it is not showing", async () => {
    const view = viewOf(["replaced"]);
    views = [{ ...view, total: 30 }];
    await renderPanel();
    expect(await screen.findByText(/newest 1 of 30 reload\(s\) recorded in \/srv\/reloads\.jsonl/)).toBeTruthy();
  });

  it("shows an outcome it does not know verbatim, and says it does not know it", async () => {
    // The one thing this panel must never do quietly is mislabel.
    const unknown = { ...recordFor("replaced"), outcome: "teleported" };
    const { records } = parseReloadHistory(`${JSON.stringify(unknown)}\n`);
    views = [{ ...viewOf([]), records, total: 1 }];
    await renderPanel();

    const row = (await screen.findAllByRole("listitem"))[0];
    expect(within(row).getByText("teleported")).toBeTruthy();
    expect(row.textContent).toContain("does not know");
  });

  it("explains what to set when no history is configured", async () => {
    views = [
      { configured: false, path: null, total: 0, records: [], unreadable: [], error: null },
    ];
    await renderPanel();
    const note = await screen.findByRole("status");
    expect(note.textContent).toContain("No reload history is configured");
    expect(note.textContent).toContain("PROD_RELOAD_HISTORY");
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("tells 'no file yet' and 'cannot be read' apart, in the route's own words", async () => {
    views = [
      {
        ...viewOf([]),
        error: { kind: "missing", message: "no reload history at /srv/reloads.jsonl yet" },
      },
    ];
    await renderPanel();
    expect((await screen.findByRole("status")).textContent).toContain("no reload history at /srv/reloads.jsonl yet");

    cleanup();
    views = [
      {
        ...viewOf([]),
        error: { kind: "unreadable", message: "/srv/reloads.jsonl could not be read (EISDIR)" },
      },
    ];
    await renderPanel();
    expect((await screen.findByRole("status")).textContent).toContain("could not be read (EISDIR)");
  });

  it("waits for the first reload rather than calling an empty file an error", async () => {
    views = [viewOf([])];
    await renderPanel();
    expect((await screen.findByRole("status")).textContent).toContain("No reload has been performed yet");
  });

  it("counts the lines it could not read, naming them", async () => {
    const { records, unreadable } = parseReloadHistory(
      `${JSON.stringify(recordFor("replaced"))}\n>> truncated write\n`,
    );
    views = [{ ...viewOf([]), records, total: 1, unreadable }];
    await renderPanel();

    const statuses = await screen.findAllByRole("status");
    const problems = statuses.map((node) => node.textContent ?? "").join(" ");
    expect(problems).toContain("1 line(s) of the history could not be read");
    expect(problems).toContain("line 2: not JSON");
    // ...but the records it COULD read are still on the page.
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("keeps the page when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    await renderPanel();

    expect((await screen.findByRole("status")).textContent).toContain(
      "Could not read the reload history",
    );
    // The section is still there, and still says what it is.
    expect(screen.getByRole("heading", { name: "Reloads" })).toBeTruthy();
  });

  it("re-reads when Refresh is pressed, which is what the panel is for", async () => {
    views = [viewOf(["replaced"]), viewOf(["rolled-back"])];
    const user = await renderPanel();

    await screen.findAllByRole("listitem");
    expect(fetchCount).toBe(1);

    await user.click(screen.getByRole("button", { name: "Refresh reloads" }));
    await waitFor(() => expect(fetchCount).toBe(2));
    // The new read replaces the old one: a deploy that just rolled back now shows
    // as a rollback rather than as the reloads of a minute ago.
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    expect(screen.getAllByRole("listitem")[0].textContent).toContain("ROLLED BACK");
  });

  it("is what the settings page renders", () => {
    // The panel is only worth a test if a page actually shows it: the wiring is
    // one import and one element, and either can be dropped in a merge.
    const page = readFileSync(join(process.cwd(), "src", "app", "settings", "page.tsx"), "utf8");
    expect(page).toContain('from "@/components/reload-history-section"');
    expect(page).toContain("<ReloadHistorySection />");
  });
});
