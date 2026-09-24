/**
 * Component test: the version-history panel renders one visual card per
 * snapshot thumbnail-style (link to the snapshot's index.html), hides
 * itself when there are no snapshots, exposes the diff tooltip data, wires
 * card clicks to restore, and offers a per-card "restore as copy" fork.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { VersionHistoryPanel } from "../src/components/builder-client";
import { ToastHost, resetToasts } from "../src/components/toast";

afterEach(() => {
  cleanup();
  resetToasts();
  vi.unstubAllGlobals();
});

function mockFetchSnapshots(snapshots: unknown[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ snapshots }),
  });
}

const SNAPSHOTS = [
  { messageId: "m2", savedAt: "2026-09-22T02:03:31.362Z", files: ["index.html", "styles.css"] },
  { messageId: "m1", savedAt: "2026-09-22T02:02:35.238Z", files: ["index.html", "app.js"] },
  {
    messageId: "m3",
    savedAt: "2026-09-22T02:05:00.000Z",
    files: ["index.html"],
    missing: ["app.js", "logo.png"],
  },
];

function renderPanel(overrides: Partial<Parameters<typeof VersionHistoryPanel>[0]> = {}) {
  const props = {
    projectId: "p1",
    refreshKey: 0,
    busy: false,
    onRestore: vi.fn(),
    onFork: vi.fn(),
    onFix: vi.fn(),
    onLoadDiff: vi.fn(),
    onTogglePin: vi.fn(),
    pinnedId: null as string | null,
    diffs: {} as Record<string, { added: string[]; removed: string[]; modified: string[] } | null>,
    ...overrides,
  };
  render(
    <>
      <ToastHost />
      <VersionHistoryPanel {...props} />
    </>,
  );
  return props;
}

describe("VersionHistoryPanel — missing-assets chips", () => {
  it("marks incomplete snapshots and says what will 404 if pinned", async () => {
    vi.stubGlobal("fetch", mockFetchSnapshots(SNAPSHOTS));
    renderPanel();
    const chip = await screen.findByTestId("history-missing-m3");
    expect(chip.textContent).toContain("2 missing");
    expect(chip.getAttribute("title")).toContain("app.js");
    // Complete snapshots carry no chip.
    expect(screen.queryByTestId("history-missing-m1")).toBeNull();
    // And the pin button's tooltip discloses the risk.
    const pin = screen.getByTestId("history-pin-m3");
    expect(pin.getAttribute("title")).toContain("missing");
    vi.unstubAllGlobals();
  });
});

describe("VersionHistoryPanel — restore-tooltip health badges", () => {
  const M3_DIFF = { added: [], removed: ["styles.css"], modified: [] };

  it("badges complete snapshots' tooltips ✓ — safe to restore", async () => {
    vi.stubGlobal("fetch", mockFetchSnapshots(SNAPSHOTS));
    renderPanel({ diffs: { m2: M3_DIFF } });
    const ok = await screen.findByTestId("history-health-m2");
    expect(ok.textContent).toContain("✓");
    expect(ok.textContent).toContain("safe to restore");
    vi.unstubAllGlobals();
  });

  it("badges ⚠ when the snapshot is incomplete and NO complete version exists", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSnapshots([SNAPSHOTS[2]]), // m3 only — nothing complete
    );
    renderPanel({ diffs: { m3: M3_DIFF } });
    const warn = await screen.findByTestId("history-health-m3");
    expect(warn.textContent).toContain("⚠");
    expect(warn.textContent).toContain("app.js");
    expect(warn.textContent).toContain("404");
    vi.unstubAllGlobals();
  });

  it("badges 🛠 when incomplete but a complete version exists — names it", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSnapshots([
        SNAPSHOTS[2],
        {
          messageId: "m4",
          savedAt: "2026-09-22T02:06:00.000Z",
          files: ["index.html"],
          missing: [],
        },
      ]),
    );
    renderPanel({ diffs: { m3: M3_DIFF } });
    const fixable = await screen.findByTestId("history-health-m3");
    expect(fixable.textContent).toContain("🛠");
    expect(fixable.textContent).toContain("app.js");
    expect(fixable.textContent).toContain("m4");
    vi.unstubAllGlobals();
  });

  it("suggests the NEWEST complete snapshot, not just any complete one", async () => {
    vi.stubGlobal("fetch", mockFetchSnapshots(SNAPSHOTS));
    renderPanel({ diffs: { m3: M3_DIFF } });
    await screen.findByTestId("history-health-m3");
    // SNAPSHOTS: complete m2 (02:03:31) is newer than complete m1 (02:02:35).
    const tip = screen.getByTestId("history-diff-m3");
    expect(tip.textContent).toContain("m2");
    vi.unstubAllGlobals();
  });

  it("only appears inside a loaded (hovered) tooltip", async () => {
    vi.stubGlobal("fetch", mockFetchSnapshots(SNAPSHOTS));
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("history-card-m1")).toBeTruthy();
    });
    // No diffs loaded → no tooltips, no badges.
    expect(screen.queryByTestId("history-health-m1")).toBeNull();
    expect(screen.queryByTestId("history-diff-m1")).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("VersionHistoryPanel — 🛠 fix then pin (one-flow recovery from history)", () => {
  async function openPanelWithBrokenCard(overrides: Record<string, unknown> = {}) {
    vi.stubGlobal("fetch", mockFetchSnapshots(SNAPSHOTS));
    const props = renderPanel(overrides);
    await screen.findByTestId("history-fix-m3");
    return props;
  }

  it("a complete fix offers to pin the version; accepting pins through the shared handler", async () => {
    const props = await openPanelWithBrokenCard({
      onFix: vi.fn().mockResolvedValueOnce(["app.js", "logo.png"]),
    });

    fireEvent.click(screen.getByTestId("history-fix-m3"));

    const toast = await screen.findByTestId("toast-host");
    expect(toast.textContent).toContain("Fixed: app.js, logo.png");
    expect(toast.textContent).toContain("Pin this now-complete version");
    fireEvent.click(screen.getByTestId("toast-confirm"));
    await waitFor(() => {
      expect(props.onTogglePin).toHaveBeenCalledWith("m3", false);
    });
    expect(props.onFix).toHaveBeenCalledWith("m3");
  });

  it("declining the offer leaves the pin untouched", async () => {
    const props = await openPanelWithBrokenCard({
      onFix: vi.fn().mockResolvedValueOnce(["app.js"]),
    });

    fireEvent.click(screen.getByTestId("history-fix-m3"));
    fireEvent.click(await screen.findByTestId("toast-cancel"));
    await waitFor(() => {
      expect(props.onFix).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 25));

    expect(props.onTogglePin).not.toHaveBeenCalled();
  });

  it("a failed or partial fix never offers a pin", async () => {
    const props = await openPanelWithBrokenCard({
      onFix: vi.fn().mockResolvedValueOnce(null),
    });

    fireEvent.click(screen.getByTestId("history-fix-m3"));
    await waitFor(() => {
      expect(props.onFix).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 25));

    expect(screen.queryByTestId("toast-host")).toBeNull();
    expect(props.onTogglePin).not.toHaveBeenCalled();
  });

  it("after the pin, a second toast offers publish-now through onPublish", async () => {
    const props = await openPanelWithBrokenCard({
      onFix: vi.fn().mockResolvedValueOnce(["app.js"]),
      onPublish: vi.fn().mockResolvedValueOnce(true),
    });

    fireEvent.click(screen.getByTestId("history-fix-m3"));

    fireEvent.click(await screen.findByTestId("toast-confirm")); // pin
    await screen.findByText(/Publish it now/);
    fireEvent.click(screen.getByTestId("toast-confirm")); // publish
    await waitFor(() => {
      expect(props.onPublish).toHaveBeenCalledOnce();
    });
    expect(props.onTogglePin).toHaveBeenCalledWith("m3", false);
  });

  it("declining the publish toast keeps the pin and never calls onPublish", async () => {
    const props = await openPanelWithBrokenCard({
      onFix: vi.fn().mockResolvedValueOnce(["app.js"]),
      onPublish: vi.fn(),
    });

    fireEvent.click(screen.getByTestId("history-fix-m3"));
    fireEvent.click(await screen.findByTestId("toast-confirm")); // pin
    await screen.findByText(/Publish it now/);
    fireEvent.click(screen.getByTestId("toast-cancel")); // decline
    await new Promise((r) => setTimeout(r, 25));

    expect(props.onPublish).not.toHaveBeenCalled();
    expect(props.onTogglePin).toHaveBeenCalledWith("m3", false);
  });

  it("without onPublish the flow stops after the pin (pin-only offer)", async () => {
    const props = await openPanelWithBrokenCard({
      onFix: vi.fn().mockResolvedValueOnce(["app.js"]),
    });

    fireEvent.click(screen.getByTestId("history-fix-m3"));
    fireEvent.click(await screen.findByTestId("toast-confirm")); // pin
    await waitFor(() => {
      expect(props.onTogglePin).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 25));

    expect(screen.queryByText(/Publish it now/)).toBeNull();
  });
});

describe("VersionHistoryPanel — fix button", () => {
  it("renders on incomplete cards only and calls onFix on click", async () => {
    vi.stubGlobal("fetch", mockFetchSnapshots(SNAPSHOTS));
    const onFix = vi.fn();
    renderPanel({ onFix });
    const btn = await screen.findByTestId("history-fix-m3");
    expect(screen.queryByTestId("history-fix-m1")).toBeNull();
    expect(screen.queryByTestId("history-fix-m2")).toBeNull();
    fireEvent.click(btn);
    expect(onFix).toHaveBeenCalledWith("m3");
    vi.unstubAllGlobals();
  });

  it("disables the fix button while busy", async () => {
    vi.stubGlobal("fetch", mockFetchSnapshots(SNAPSHOTS));
    const onFix = vi.fn();
    renderPanel({ onFix, busy: true });
    const busyBtn = await screen.findByTestId("history-fix-m3");
    expect((busyBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busyBtn);
    expect(onFix).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("spins only the card whose fix is running; siblings stay live", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSnapshots([
        SNAPSHOTS[2],
        {
          messageId: "m5",
          savedAt: "2026-09-22T02:07:00.000Z",
          files: ["index.html"],
          missing: ["app.js"],
        },
      ]),
    );
    renderPanel({ fixingId: "m3" });
    const spinning = await screen.findByTestId("history-fix-m3");
    expect(spinning.textContent).toContain("fixing");
    expect((spinning as HTMLButtonElement).disabled).toBe(true);
    const other = screen.getByTestId("history-fix-m5");
    expect((other as HTMLButtonElement).disabled).toBe(false);
    expect(other.textContent).toContain("🛠 fix");
    vi.unstubAllGlobals();
  });
});

describe("VersionHistoryPanel", () => {
  it("renders a card per snapshot with a thumbnail and file list", async () => {
    vi.stubGlobal("fetch", mockFetchSnapshots(SNAPSHOTS));
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Version history \(3\)/)).toBeTruthy();
    });
    expect(screen.getByTestId("history-card-m2")).toBeTruthy();
    expect(screen.getByTestId("history-card-m1")).toBeTruthy();
    // Thumbnail iframe points at the snapshot file route.
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[src*="/snapshots/m2/files/index.html"]',
    );
    expect(iframe).toBeTruthy();
    expect(iframe!.src).toContain("v=");
    // File list rendered in the card footer.
    expect(screen.getByText("index.html, styles.css")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("renders nothing when there are no snapshots", async () => {
    vi.stubGlobal("fetch", mockFetchSnapshots([]));
    const { container } = render(
      <VersionHistoryPanel
        projectId="p1"
        refreshKey={0}
        busy={false}
        onRestore={vi.fn()}
        onFork={vi.fn()}
        onFix={vi.fn()}
        onLoadDiff={vi.fn()}
        pinnedId={null}
        onTogglePin={vi.fn()}
        diffs={{}}
      />,
    );
    await waitFor(() => {
      expect(container).toBeTruthy();
    });
    expect(screen.queryByText(/Version history/)).toBeNull();
    vi.unstubAllGlobals();
  });

  it("loads the diff on hover and restores on click", async () => {
    vi.stubGlobal("fetch", mockFetchSnapshots(SNAPSHOTS));
    const props = renderPanel({
      diffs: {
        m1: { added: [], removed: ["styles.css"], modified: ["index.html"] },
      },
    });
    await waitFor(() => {
      expect(screen.getByTestId("history-card-m1")).toBeTruthy();
    });
    const card = screen.getByTestId("history-card-m1");
    fireEvent.mouseEnter(card);
    expect(props.onLoadDiff).toHaveBeenCalledWith("m1");
    fireEvent.click(card);
    expect(props.onRestore).toHaveBeenCalledWith("m1");
    // Diff tooltip content is present for the hovered card.
    expect(screen.getByTestId("history-diff-m1").textContent).toContain(
      "− styles.css",
    );
    vi.unstubAllGlobals();
  });

  it("disables cards while busy", async () => {
    vi.stubGlobal("fetch", mockFetchSnapshots(SNAPSHOTS));
    const props = renderPanel({ busy: true });
    await waitFor(() => {
      expect(screen.getByTestId("history-card-m1")).toBeTruthy();
    });
    const card = screen.getByTestId("history-card-m1") as HTMLButtonElement;
    expect(card.disabled).toBe(true);
    fireEvent.click(card);
    expect(props.onRestore).not.toHaveBeenCalled();
    // The fork affordance is disabled too.
    const fork = screen.getByTestId("history-fork-m1") as HTMLButtonElement;
    expect(fork.disabled).toBe(true);
    fireEvent.click(fork);
    expect(props.onFork).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("forks from the card's copy button without restoring", async () => {
    vi.stubGlobal("fetch", mockFetchSnapshots(SNAPSHOTS));
    const props = renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("history-card-m1")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("history-fork-m1"));
    expect(props.onFork).toHaveBeenCalledWith("m1");
    expect(props.onRestore).not.toHaveBeenCalled();
    // Every card exposes the fork affordance.
    expect(screen.getByTestId("history-fork-m2")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("pins and unpins from the card, showing which version publish ships", async () => {
    vi.stubGlobal("fetch", mockFetchSnapshots(SNAPSHOTS));
    const props = renderPanel({ pinnedId: "m2" });
    await waitFor(() => {
      expect(screen.getByTestId("history-card-m2")).toBeTruthy();
    });
    // The pinned card shows a persistent pinned badge; the other doesn't.
    const pinnedBtn = screen.getByTestId("history-pin-m2");
    expect(pinnedBtn.textContent).toContain("pinned");
    expect(screen.getByTestId("history-pin-m1").textContent).not.toContain(
      "pinned",
    );
    // Header explains what publish ships while a pin is active.
    expect(screen.getByText(/pinned version is what publish ships/)).toBeTruthy();
    // Clicking the pinned card's button unpins (toggle passes current state).
    fireEvent.click(pinnedBtn);
    expect(props.onTogglePin).toHaveBeenCalledWith("m2", true);
    // Clicking the unpinned card's button pins it.
    fireEvent.click(screen.getByTestId("history-pin-m1"));
    expect(props.onTogglePin).toHaveBeenCalledWith("m1", false);
    vi.unstubAllGlobals();
  });
});
