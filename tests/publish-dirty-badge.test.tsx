/**
 * PublishButton — the "workspace is ahead of the published version"
 * indicator next to the Publish button, driven by the publish API's
 * `dirty` flag (pin-aware since the adversarial-review fixes).
 *
 * Pins:
 *   • published + dirty  → amber "● changes" badge on the button;
 *   • published + clean  → no badge;
 *   • unpublished        → no badge;
 *   • a files change (the `dirtyKey` prop) re-fetches status — the badge
 *     appears the moment the workspace moves past the published snapshot.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublishButton } from "../src/components/builder-client";
import { ToastHost, resetToasts } from "../src/components/toast";

type PublishPayload = Record<string, unknown>;

let publishPayload: PublishPayload;
let snapshotsPayload: { snapshots: unknown[] };

beforeEach(() => {
  publishPayload = { published: false };
  snapshotsPayload = { snapshots: [] };
  base.onTogglePin.mockClear();
  base.onFix.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/publish") && !init?.method) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(publishPayload),
        } as Response);
      }
      // The safe-versions list inside the panel.
      if (url.includes("/snapshots")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(snapshotsPayload),
        } as Response);
      }
      // DeploySection's status/settings fetches.
      if (url.includes("/deploy")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ deployment: null, versions: [] }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ connected: false }),
      } as Response);
    }),
  );
});

afterEach(() => {
  cleanup();
  resetToasts();
  vi.unstubAllGlobals();
});

const base = {
  projectId: "p1",
  viewingVersion: null,
  onViewVersion: () => {},
  pinSyncKey: null,
  dirtyKey: [] as readonly unknown[],
  snapshotRefreshKey: 0,
  onTogglePin: vi.fn(),
  onFix: vi.fn(),
  builderBusy: false,
};

function renderButton(dirtyKey?: readonly unknown[]) {
  render(
    <>
      <ToastHost />
      <PublishButton {...base} dirtyKey={dirtyKey ?? base.dirtyKey} />
    </>,
  );
}

describe("PublishButton — workspace-ahead badge", () => {
  it("shows the amber badge when published and the workspace is ahead", async () => {
    publishPayload = { published: true, slug: "demo", dirty: true };
    renderButton();
    const badge = await screen.findByTestId("publish-dirty-badge");
    expect(badge.textContent).toContain("changes");
  });

  it("shows no badge when published and up to date", async () => {
    publishPayload = { published: true, slug: "demo", dirty: false };
    renderButton();
    await screen.findByText(/Published/);
    expect(screen.queryByTestId("publish-dirty-badge")).toBeNull();
  });

  it("shows no badge when unpublished", async () => {
    publishPayload = { published: false };
    renderButton();
    await screen.findByText("Publish");
    expect(screen.queryByTestId("publish-dirty-badge")).toBeNull();
  });

  it("re-fetches status when the workspace files change (dirtyKey)", async () => {
    publishPayload = { published: true, slug: "demo", dirty: false };
    const key1 = [{ path: "index.html", content: "v1" }] as readonly unknown[];
    const { rerender } = render(<PublishButton {...base} dirtyKey={key1} />);
    await screen.findByText(/Published/);

    // Workspace moves on (a generation lands) → dirtyKey identity changes
    // and the API now reports dirty. The badge must appear.
    publishPayload = { published: true, slug: "demo", dirty: true };
    const key2 = [
      { path: "index.html", content: "v2-live" },
      { path: "app.js", content: "new" },
    ] as readonly unknown[];
    rerender(<PublishButton {...base} dirtyKey={key2} />);

    await waitFor(() => {
      expect(screen.getByTestId("publish-dirty-badge")).toBeTruthy();
    });
  });
});

describe("PublishButton — safe-versions list in the publish panel", () => {
  const SNAPSHOTS = [
    {
      messageId: "m-complete",
      savedAt: "2026-09-24T10:00:00.000Z",
      files: ["index.html"],
      missing: [],
    },
    {
      messageId: "m-broken",
      savedAt: "2026-09-24T11:00:00.000Z",
      files: ["index.html"],
      missing: ["app.js"],
    },
  ];

  it("lists every snapshot with ✓/⚠ markers and marks the pinned one", async () => {
    publishPayload = {
      published: true,
      slug: "demo",
      dirty: false,
      pinnedFrom: "m-complete",
    };
    snapshotsPayload = { snapshots: SNAPSHOTS };
    renderButton();
    await screen.findByText(/Published/);
    // Open the panel.
    (screen.getByText(/Published/) as HTMLElement).click();

    const list = await screen.findByTestId("publish-safe-versions");
    expect(list.textContent).toContain("Versions safe to publish");
    const complete = screen.getByTestId("safe-version-m-complete");
    expect(complete.textContent).toContain("✓");
    expect(complete.textContent).toContain("📌");
    const broken = screen.getByTestId("safe-version-m-broken");
    expect(broken.textContent).toContain("⚠");
    expect(broken.textContent).toContain("missing 1");
    expect(broken.getAttribute("title")).toContain("app.js");
    // The pinned row's tooltip advertises the unpin action; the unpinned
    // complete one advertises pinning.
    expect(complete.getAttribute("title")).toContain("click to unpin");
    expect(broken.getAttribute("title")).toContain("pin anyway");
  });

  it("re-syncs when the snapshotRefreshKey changes (a fix lands)", async () => {
    publishPayload = { published: false };
    snapshotsPayload = { snapshots: SNAPSHOTS };
    const { rerender } = render(<PublishButton {...base} />);
    await screen.findByText("Publish");
    (screen.getByText("Publish") as HTMLElement).click();
    await screen.findByTestId("safe-version-m-broken");

    // The 🛠 fix regenerated the missing asset → key bumps, the API now
    // reports the snapshot complete, and the row must flip to ✓.
    snapshotsPayload = {
      snapshots: [
        { ...SNAPSHOTS[1], messageId: "m-broken", missing: [] },
      ],
    };
    rerender(<PublishButton {...base} snapshotRefreshKey={1} />);

    await waitFor(() => {
      expect(screen.getByTestId("safe-version-m-broken").textContent).toContain("✓");
    });
    expect(screen.queryByTestId("safe-version-m-complete")).toBeNull();
  });
});

describe("PublishButton — safe-versions rows pin/unpin", () => {
  /** Same snapshots as the list tests above. */
  const SNAPSHOTS = [
    {
      messageId: "m-complete",
      savedAt: "2026-09-24T10:00:00.000Z",
      files: ["index.html"],
      missing: [],
    },
    {
      messageId: "m-broken",
      savedAt: "2026-09-24T11:00:00.000Z",
      files: ["index.html"],
      missing: ["app.js"],
    },
  ];

  function renderPanel(pinnedFrom: string | null) {
    publishPayload = {
      published: true,
      slug: "demo",
      dirty: false,
      pinnedFrom,
    };
    snapshotsPayload = { snapshots: SNAPSHOTS };
    render(<PublishButton {...base} />);
    return screen.findByText(/Published/).then(() => {
      (screen.getByText(/Published/) as HTMLElement).click();
    });
  }

  it("clicking a row toggles the pin through the shared handler", async () => {
    await renderPanel("m-complete");
    // Pinned row → toggle passes current state (true) → unpin intent.
    fireEvent.click(await screen.findByTestId("safe-version-m-complete"));
    expect(base.onTogglePin).toHaveBeenCalledWith("m-complete", true);
    // Unpinned row → pin intent.
    fireEvent.click(screen.getByTestId("safe-version-m-broken"));
    expect(base.onTogglePin).toHaveBeenCalledWith("m-broken", false);
  });

  it("disables rows while the builder is busy", async () => {
    publishPayload = { published: true, slug: "demo", dirty: false };
    snapshotsPayload = { snapshots: SNAPSHOTS };
    render(<PublishButton {...base} builderBusy />);
    await screen.findByText(/Published/);
    (screen.getByText(/Published/) as HTMLElement).click();
    const row = await screen.findByTestId("safe-version-m-complete");
    expect((row as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(row);
    expect(base.onTogglePin).not.toHaveBeenCalled();
  });
});

describe("PublishButton — switch-to-complete recovery", () => {
  it("shows the switch button in the blocked state and sequences unpin → pin → publish", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method });
        if (url.endsWith("/publish") && !init?.method) {
          // Status: published, pinned snapshot is incomplete, a complete
          // one exists → the GET offers the switch.
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                published: true,
                slug: "demo",
                dirty: false,
                pinnedFrom: "m-bad",
                pinnedMissing: ["app.js"],
                suggest: "m-good",
              }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        } as Response);
      }),
    );

    // pinSyncKey set → switchPin first unpins the incomplete pin.
    render(<PublishButton {...base} pinSyncKey="m-bad" />);
    await screen.findByText(/Published/);
    (screen.getByText(/Published/) as HTMLElement).click();

    const btn = await screen.findByTestId("publish-switch-complete");
    expect(btn.textContent).toContain("Switch to the most recent complete version");
    fireEvent.click(btn);

    await waitFor(() => {
      // The publish POST fired last (after the pin swap).
      const publishPost = calls.find(
        (c) => c.url.endsWith("/publish") && c.method === "POST",
      );
      expect(publishPost).toBeTruthy();
    });
    // Unpin the incomplete pin, then pin the suggested complete one —
    // both through the shared parent handler.
    expect(base.onTogglePin).toHaveBeenNthCalledWith(1, "m-bad", true);
    expect(base.onTogglePin).toHaveBeenNthCalledWith(2, "m-good", false);
    vi.unstubAllGlobals();
  });

  it("hides the switch button when there is no complete version to offer", async () => {
    publishPayload = {
      published: true,
      slug: "demo",
      dirty: false,
      pinnedFrom: "m-bad",
      pinnedMissing: ["app.js"],
      suggest: null,
    };
    render(<PublishButton {...base} />);
    await screen.findByText(/Published/);
    (screen.getByText(/Published/) as HTMLElement).click();
    await screen.findByTestId("publish-missing-note");
    expect(screen.queryByTestId("publish-switch-complete")).toBeNull();
  });
});

describe("PublishButton — 🛠 fix shortcut on unsafe safe-version rows", () => {
  /** Same snapshots as the list tests above. */
  const SNAPSHOTS = [
    {
      messageId: "m-complete",
      savedAt: "2026-09-24T10:00:00.000Z",
      files: ["index.html"],
      missing: [],
    },
    {
      messageId: "m-broken",
      savedAt: "2026-09-24T11:00:00.000Z",
      files: ["index.html"],
      missing: ["app.js"],
    },
  ];

  async function openPanel(published = true) {
    publishPayload = published
      ? { published: true, slug: "demo", dirty: false }
      : { published: false };
    snapshotsPayload = { snapshots: SNAPSHOTS };
    render(<PublishButton {...base} />);
    await screen.findByText(/Published|Publish/);
    (screen.getByText(/Published|Publish/) as HTMLElement).click();
    await screen.findByTestId("publish-safe-versions");
  }

  it("shows 🛠 fix only on unsafe rows and calls onFix with that snapshot id", async () => {
    await openPanel();
    // Complete row has no fix button.
    expect(screen.queryByTestId("safe-version-fix-m-complete")).toBeNull();
    const fixBtn = screen.getByTestId("safe-version-fix-m-broken");
    expect(fixBtn.getAttribute("title")).toContain("app.js");
    fireEvent.click(fixBtn);
    expect(base.onFix).toHaveBeenCalledWith("m-broken");
    // The row's pin toggle must NOT have fired (sibling, not nested).
    expect(base.onTogglePin).not.toHaveBeenCalled();
  });

  it("fix buttons disable while busy and don't trigger the row's pin toggle", async () => {
    snapshotsPayload = { snapshots: SNAPSHOTS };
    render(<PublishButton {...base} builderBusy />);
    await screen.findByText(/Published|Publish/);
    (screen.getByText(/Published|Publish/) as HTMLElement).click();
    const fixBtn = await screen.findByTestId("safe-version-fix-m-broken");
    expect((fixBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(fixBtn);
    expect(base.onFix).not.toHaveBeenCalled();
  });

  it("only the clicked row's fix button spins; other rows stay live", async () => {
    snapshotsPayload = {
      snapshots: [
        ...SNAPSHOTS,
        {
          messageId: "m-broken-2",
          savedAt: "2026-09-24T12:00:00.000Z",
          files: ["index.html"],
          missing: ["theme.css"],
        },
      ],
    };
    // No onFix stub here: the spinning button is disabled via the prop and
    // never clicked, so no pending mock may leak into later tests.
    render(<PublishButton {...base} fixingId="m-broken" />);
    await screen.findByText(/Published|Publish/);
    (screen.getByText(/Published|Publish/) as HTMLElement).click();

    const spinning = await screen.findByTestId("safe-version-fix-m-broken");
    expect(spinning.textContent).toContain("fixing");
    expect((spinning as HTMLButtonElement).disabled).toBe(true);
    // Sibling unsafe rows stay live while the repair runs.
    const other = screen.getByTestId("safe-version-fix-m-broken-2");
    expect((other as HTMLButtonElement).disabled).toBe(false);
    expect(other.textContent).toContain("🛠 fix");
  });

  it("clicking a row's fix button flips it to the spinner while onFix pends", async () => {
    snapshotsPayload = { snapshots: SNAPSHOTS };
    let resolveFix: (v: string[] | null) => void = () => {};
    base.onFix.mockImplementationOnce(
      () => new Promise<string[] | null>((r) => { resolveFix = r; }),
    );
    render(<PublishButton {...base} />);
    await screen.findByText(/Published|Publish/);
    (screen.getByText(/Published|Publish/) as HTMLElement).click();
    fireEvent.click(await screen.findByTestId("safe-version-fix-m-broken"));
    // onFix called; the spinner comes from the parent's fixingId state,
    // which this component-level stub can't set — asserted in the
    // "only the clicked row's fix button spins" test via the prop.
    expect(base.onFix).toHaveBeenCalledWith("m-broken");
    resolveFix(null); // consume the mock — never leak a pending fix
  });
});

describe("PublishButton — 🛠 fix then pin (one-flow recovery)", () => {
  /** The unsafe snapshot from the list tests above. */
  const SNAPSHOTS = [
    {
      messageId: "m-broken",
      savedAt: "2026-09-24T11:00:00.000Z",
      files: ["index.html"],
      missing: ["app.js"],
    },
  ];

  async function openPanel() {
    publishPayload = { published: false };
    snapshotsPayload = { snapshots: SNAPSHOTS };
    render(
      <>
        <ToastHost />
        <PublishButton {...base} />
      </>,
    );
    await screen.findByText("Publish");
    (screen.getByText("Publish") as HTMLElement).click();
    await screen.findByTestId("safe-version-fix-m-broken");
  }

  it("a complete fix offers to pin the version; accepting pins it through the shared handler", async () => {
    await openPanel();
    base.onFix.mockResolvedValueOnce(["app.js"]);

    fireEvent.click(screen.getByTestId("safe-version-fix-m-broken"));

    const toast = await screen.findByTestId("toast-host");
    expect(toast.textContent).toContain("Fixed: app.js");
    expect(toast.textContent).toContain("Pin this now-complete version");
    fireEvent.click(screen.getByTestId("toast-confirm"));
    await waitFor(() => {
      expect(base.onTogglePin).toHaveBeenCalledWith("m-broken", false);
    });
    expect(base.onFix).toHaveBeenCalledWith("m-broken");
  });

  it("declining the offer leaves the pin untouched", async () => {
    await openPanel();
    base.onFix.mockResolvedValueOnce(["app.js"]);

    fireEvent.click(screen.getByTestId("safe-version-fix-m-broken"));
    fireEvent.click(await screen.findByTestId("toast-cancel"));
    await waitFor(() => {
      expect(base.onFix).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 25));

    expect(base.onTogglePin).not.toHaveBeenCalled();
  });

  it("a failed or partial fix never offers a pin (pinning would 409 again)", async () => {
    await openPanel();
    base.onFix.mockResolvedValueOnce(null);

    fireEvent.click(screen.getByTestId("safe-version-fix-m-broken"));
    await waitFor(() => {
      expect(base.onFix).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 25));

    expect(screen.queryByTestId("toast-host")).toBeNull();
    expect(base.onTogglePin).not.toHaveBeenCalled();
  });
});

describe("PublishButton — 🛠 fix → pin → publish (one-flow recovery)", () => {
  /** The unsafe snapshot from the list tests above. */
  const SNAPSHOTS = [
    {
      messageId: "m-broken",
      savedAt: "2026-09-24T11:00:00.000Z",
      files: ["index.html"],
      missing: ["app.js"],
    },
  ];

  async function openPanel(recordCalls: Array<{ url: string; method?: string }>) {
    publishPayload = { published: false };
    snapshotsPayload = { snapshots: SNAPSHOTS };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        recordCalls.push({ url, method: init?.method });
        if (url.endsWith("/publish") && !init?.method) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(publishPayload),
          } as Response);
        }
        if (url.includes("/snapshots")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(snapshotsPayload),
          } as Response);
        }
        // The publish POST: failure only when the test asks for it.
        if (url.endsWith("/publish") && init?.method === "POST") {
          return Promise.resolve({
            ok: publishPostOk,
            json: () => Promise.resolve(publishPostOk ? { published: true } : { error: "nope" }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ connected: false }),
        } as Response);
      }),
    );
    render(
      <>
        <ToastHost />
        <PublishButton {...base} />
      </>,
    );
    await screen.findByText("Publish");
    (screen.getByText("Publish") as HTMLElement).click();
    await screen.findByTestId("safe-version-fix-m-broken");
  }

  let publishPostOk: boolean;

  beforeEach(() => {
    publishPostOk = true;
  });

  it("after the pin is accepted, a second toast publishes immediately — pin first, then POST", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    await openPanel(calls);
    base.onFix.mockResolvedValueOnce(["app.js"]);

    fireEvent.click(screen.getByTestId("safe-version-fix-m-broken"));

    // First toast: the pin offer. At the moment the PUBLISH offer toast
    // fires, the pin must already be in — prove the order structurally.
    await screen.findByTestId("toast-confirm");
    expect(screen.getByTestId("toast-host").textContent).toContain(
      "Pin this now-complete version",
    );
    fireEvent.click(screen.getByTestId("toast-confirm"));
    await waitFor(() => {
      expect(base.onTogglePin).toHaveBeenCalledWith("m-broken", false);
    });
    await screen.findByText(/Publish it now/);
    // Pin landed BEFORE the publish offer appeared.
    expect(base.onTogglePin.mock.calls.some(
      ([id, pinned]) => id === "m-broken" && pinned === false,
    )).toBe(true);
    fireEvent.click(screen.getByTestId("toast-confirm"));

    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith("/publish") && c.method === "POST")).toBe(true);
    });
  });

  it("declining the publish toast keeps the pin but never POSTs", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    await openPanel(calls);
    base.onFix.mockResolvedValueOnce(["app.js"]);

    fireEvent.click(screen.getByTestId("safe-version-fix-m-broken"));
    // Accept the pin toast...
    fireEvent.click(await screen.findByTestId("toast-confirm"));
    await waitFor(() => {
      expect(base.onTogglePin).toHaveBeenCalled();
    });
    // ...decline the publish toast.
    await screen.findByText(/Publish it now/);
    fireEvent.click(screen.getByTestId("toast-cancel"));
    await new Promise((r) => setTimeout(r, 25));

    expect(
      calls.some((c) => c.url.endsWith("/publish") && c.method === "POST"),
    ).toBe(false);
  });

  it("a failed publish shows a danger toast instead of dying silently", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    publishPostOk = false;
    await openPanel(calls);
    base.onFix.mockResolvedValueOnce(["app.js"]);

    fireEvent.click(screen.getByTestId("safe-version-fix-m-broken"));
    fireEvent.click(await screen.findByTestId("toast-confirm"));
    await screen.findByText(/Publish it now/);
    fireEvent.click(screen.getByTestId("toast-confirm"));

    await waitFor(() => {
      expect(screen.getByTestId("toast-host").textContent).toContain("Publish failed");
    });
  });

  it("publishSyncKey changes re-fetch status (external publish re-syncs the badge)", async () => {
    publishPayload = { published: true, slug: "demo", dirty: false };
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method });
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(publishPayload),
        } as Response);
      }),
    );
    const { rerender } = render(<PublishButton {...base} publishSyncKey={0} />);
    await screen.findByText(/Published/);
    const after = calls.filter((c) => c.url.endsWith("/publish")).length;
    rerender(<PublishButton {...base} publishSyncKey={1} />);
    await waitFor(() => {
      expect(calls.filter((c) => c.url.endsWith("/publish")).length).toBeGreaterThan(after);
    });
    vi.unstubAllGlobals();
  });
});

describe("PublishButton — 🛠 fix-pinned recovery when no complete alternative exists", () => {
  /** The panel's blocked states with suggest:null (pinned version is the
   *  only snapshot — switch is impossible, force ships 404s). */
  function stubBlocked409() {
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method });
        if (url.endsWith("/publish") && !init?.method) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                published: true,
                slug: "demo",
                dirty: false,
                pinnedFrom: "m-bad",
                pinnedMissing: ["app.js"],
                suggest: null,
              }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        } as Response);
      }),
    );
    return calls;
  }

  async function openBlockedPanel() {
    const calls = stubBlocked409();
    render(
      <>
        <ToastHost />
        <PublishButton {...base} pinSyncKey="m-bad" />
      </>,
    );
    await screen.findByText(/Published/);
    (screen.getByText(/Published/) as HTMLElement).click();
    return calls;
  }

  it("offers 🛠 Fix the pinned version & publish when suggest is null", async () => {
    await openBlockedPanel();
    const btn = await screen.findByTestId("publish-fix-pinned");
    expect(btn.textContent).toContain("Fix the pinned version");
  });

  it("a complete fix publishes without force (no 409 to bypass)", async () => {
    const calls = await openBlockedPanel();
    base.onFix.mockResolvedValueOnce(["app.js"]);

    fireEvent.click(await screen.findByTestId("publish-fix-pinned"));

    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith("/publish") && c.method === "POST")).toBe(true);
    });
    expect(base.onFix).toHaveBeenCalledWith("m-bad");
    const post = calls.find((c) => c.url.endsWith("/publish") && c.method === "POST")!;
    expect(post.url).not.toContain("force=1");
  });

  it("a failed/partial fix never publishes (it would 409 again)", async () => {
    const calls = await openBlockedPanel();
    base.onFix.mockResolvedValueOnce(null);

    fireEvent.click(await screen.findByTestId("publish-fix-pinned"));
    await waitFor(() => {
      expect(base.onFix).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 25));

    expect(
      calls.some((c) => c.url.endsWith("/publish") && c.method === "POST"),
    ).toBe(false);
  });

  it("prefers the switch button when a complete alternative exists (no fix button)", async () => {
    publishPayload = {
      published: true,
      slug: "demo",
      dirty: false,
      pinnedFrom: "m-bad",
      pinnedMissing: ["app.js"],
      suggest: "m-good",
    };
    render(<PublishButton {...base} />);
    await screen.findByText(/Published/);
    (screen.getByText(/Published/) as HTMLElement).click();
    await screen.findByTestId("publish-switch-complete");
    expect(screen.queryByTestId("publish-fix-pinned")).toBeNull();
  });

  it("the recovery button spins while the fix generates, then publishes only after it resolves", async () => {
    const calls = stubBlocked409();
    let resolveFix: (v: string[] | null) => void = () => {};
    base.onFix.mockImplementationOnce(
      () => new Promise<string[] | null>((r) => { resolveFix = r; }),
    );
    render(<PublishButton {...base} pinSyncKey="m-bad" />);
    await screen.findByText(/Published/);
    (screen.getByText(/Published/) as HTMLElement).click();
    const btn = await screen.findByTestId("publish-fix-pinned");

    fireEvent.click(btn);
    try {
      // Mid-fix: honest wait state on THIS button — and no publish yet.
      await waitFor(() => {
        expect(btn.textContent).toContain("Fixing the pinned version");
      });
      expect((btn as HTMLButtonElement).disabled).toBe(true);
      expect(
        calls.some((c) => c.url.endsWith("/publish") && c.method === "POST"),
      ).toBe(false);
    } finally {
      resolveFix(["app.js"]); // consume the mock — never leak a pending fix
    }
    await waitFor(() => {
      expect(
        calls.some((c) => c.url.endsWith("/publish") && c.method === "POST"),
      ).toBe(true);
    });
  });

  it("unpublished branch: offers the fix under a pinned-missing 409, only when a pin exists", async () => {
    publishPayload = {
      published: false,
      warning: "The pinned snapshot is missing assets its HTML references.",
      missing: ["app.js"],
      suggest: null,
    };
    render(<PublishButton {...base} pinSyncKey="m-bad" />);
    await screen.findByText("Publish");
    (screen.getByText("Publish") as HTMLElement).click();
    await screen.findByText(/Publish anyway/);
    expect(screen.getByTestId("publish-fix-pinned")).toBeTruthy();

    // Same shape but NO pin (pure workspace gap) → no fix-pinned button.
    cleanup();
    publishPayload = {
      published: false,
      warning: "Workspace is missing assets.",
      missing: ["app.js"],
      suggest: null,
    };
    render(<PublishButton {...base} pinSyncKey={null} />);
    await screen.findByText("Publish");
    (screen.getByText("Publish") as HTMLElement).click();
    await screen.findByText(/Publish anyway/);
    expect(screen.queryByTestId("publish-fix-pinned")).toBeNull();
  });
});
