/**
 * Unit tests for the module-level toast bus (src/components/toast.tsx),
 * exercised through <ToastHost /> in jsdom.
 *
 * The bus backs the fix→pin→publish recovery flows with two primitives:
 *   • choose() — a DECISION toast that stays up until an action button is
 *     clicked and resolves the awaiting flow's promise with that value;
 *   • notify() — an OUTCOME toast (the window.alert replacement) that
 *     auto-dismisses after 6s.
 * plus resetToasts() for unmount/test hygiene on the module-level state.
 *
 * Pinned behaviors:
 *   • supersede — a newer choose() replaces the open toast and settles the
 *     superseded promise with the OLD toast's walk-away (non-primary)
 *     action value, so no flow hangs on a toast that no longer exists;
 *   • auto-dismiss — outcome toasts clear themselves at exactly 6s, and a
 *     stale timer only clears the toast it was created for (an id guard
 *     protects a newer toast; decisions never auto-dismiss);
 *   • resetToasts — settles any pending decision with its walk-away value
 *     ("cancel" fallback when every action is primary), clears the screen,
 *     tolerates no-op calls, and leaves the bus usable.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastHost, choose, notify, resetToasts } from "../src/components/toast";

beforeEach(() => {
  // Auto-dismiss is timer-driven; microtasks stay real, so promise
  // resolution asserts work normally under fake timers.
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup(); // unmount first so resetToasts() can't touch detached React
  resetToasts(); // module-level bus hygiene between tests
  vi.useRealTimers();
});

/** Drain microtasks so values resolved into captured promises are visible. */
async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const PIN_OFFER = [
  { value: "confirm", label: "Pin it", primary: true },
  { value: "cancel", label: "Not now" },
];

const PUBLISH_OFFER = [
  { value: "confirm", label: "Publish now", primary: true },
  { value: "cancel", label: "Later" },
];

describe("toast bus — choose() decision toasts", () => {
  it("shows the message and action buttons, and resolves with the clicked action's value", async () => {
    render(<ToastHost />);
    let resolved: string | undefined;
    act(() => {
      choose("Pin this now-complete version?", PIN_OFFER).then((v) => {
        resolved = v;
      });
    });

    const host = screen.getByTestId("toast-host");
    expect(host.getAttribute("role")).toBe("alertdialog");
    expect(host.textContent).toContain("Pin this now-complete version?");
    expect(screen.getByTestId("toast-confirm").textContent).toBe("Pin it");
    expect(screen.getByTestId("toast-cancel").textContent).toBe("Not now");

    fireEvent.click(screen.getByTestId("toast-confirm"));
    await flushMicrotasks();
    expect(resolved).toBe("confirm");
    // Answered → the toast leaves the screen.
    expect(screen.queryByTestId("toast-host")).toBeNull();
  });

  it("resolves with a non-primary action's value when the user walks away", async () => {
    render(<ToastHost />);
    let resolved: string | undefined;
    act(() => {
      choose("Publish it now?", PUBLISH_OFFER).then((v) => {
        resolved = v;
      });
    });

    fireEvent.click(screen.getByTestId("toast-cancel"));
    await flushMicrotasks();
    expect(resolved).toBe("cancel");
    expect(screen.queryByTestId("toast-host")).toBeNull();
  });

  it("never auto-dismisses — a decision stays on screen until answered", () => {
    render(<ToastHost />);
    act(() => {
      choose("Pin this now-complete version?", PIN_OFFER);
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId("toast-host").textContent).toContain(
      "Pin this now-complete version?",
    );
  });
});

describe("toast bus — supersede semantics", () => {
  it("a newer choose() replaces the open toast and settles the superseded promise with its walk-away value", async () => {
    render(<ToastHost />);
    let superseded: string | undefined;
    let newest: string | undefined;
    act(() => {
      choose("Pin this now-complete version?", PIN_OFFER).then((v) => {
        superseded = v;
      });
    });
    act(() => {
      choose("Publish it now?", PUBLISH_OFFER).then((v) => {
        newest = v;
      });
    });

    // Exactly one toast on screen, showing the NEWEST question only.
    expect(screen.getAllByTestId("toast-host")).toHaveLength(1);
    expect(screen.getByTestId("toast-host").textContent).toContain("Publish it now?");
    expect(screen.getByTestId("toast-host").textContent).not.toContain(
      "Pin this now-complete version?",
    );

    await flushMicrotasks();
    // The superseded flow was settled with ITS OWN walk-away choice, not
    // left hanging on a toast that no longer exists…
    expect(superseded).toBe("cancel");
    // …while the newest decision is still pending an answer.
    expect(newest).toBeUndefined();
  });

  it("the walk-away value comes from the superseded toast's own actions, not the new one's", async () => {
    render(<ToastHost />);
    let superseded: string | undefined;
    act(() => {
      choose("Pin this now-complete version?", [
        { value: "confirm", label: "Pin it", primary: true },
        { value: "dismiss", label: "Walk away" },
      ]).then((v) => {
        superseded = v;
      });
    });
    act(() => {
      choose("Publish it now?", PUBLISH_OFFER);
    });

    await flushMicrotasks();
    // The old toast's non-primary value is "dismiss"; the new toast's is
    // "cancel". The supersede must use the OLD toast's choice.
    expect(superseded).toBe("dismiss");
  });

  it("a notify() outcome toast is superseded by a choose() without disturbing the decision", () => {
    render(<ToastHost />);
    act(() => {
      notify("Fixed: app.js");
    });
    act(() => {
      choose("Publish it now?", PUBLISH_OFFER);
    });
    expect(screen.getByTestId("toast-host").textContent).toContain("Publish it now?");
    // The decision carries its buttons (the outcome toast had none).
    expect(screen.getByTestId("toast-confirm")).toBeTruthy();
  });
});

describe("toast bus — notify() auto-dismiss", () => {
  it("shows the message with no action buttons", () => {
    render(<ToastHost />);
    act(() => {
      notify("Fixed: app.js");
    });
    expect(screen.getByTestId("toast-host").textContent).toContain("Fixed: app.js");
    expect(screen.queryByTestId("toast-confirm")).toBeNull();
  });

  it("auto-dismisses after exactly 6 seconds", () => {
    render(<ToastHost />);
    act(() => {
      notify("Fixed: app.js");
    });
    act(() => {
      vi.advanceTimersByTime(5_999);
    });
    expect(screen.getByTestId("toast-host")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId("toast-host")).toBeNull();
  });

  it("a stale timer never clears a newer toast (id guard)", () => {
    render(<ToastHost />);
    act(() => {
      notify("first");
    });
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    act(() => {
      notify("second");
    });
    // t=6000: the FIRST toast's timer fires but must not clear the second.
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByTestId("toast-host").textContent).toContain("second");
    // t=9000: the second toast's own timer dismisses it.
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.queryByTestId("toast-host")).toBeNull();
  });

  it("tones map to distinct text colors (info / warn / danger)", () => {
    render(<ToastHost />);
    act(() => {
      notify("heads up", "warn");
    });
    expect(screen.getByTestId("toast-host").querySelector("p")?.className).toContain(
      "text-amber-200",
    );
    act(() => {
      notify("boom", "danger");
    });
    expect(screen.getByTestId("toast-host").querySelector("p")?.className).toContain(
      "text-red-200",
    );
    act(() => {
      notify("all good");
    });
    expect(screen.getByTestId("toast-host").querySelector("p")?.className).toContain(
      "text-neutral-200",
    );
  });
});

describe("toast bus — resetToasts()", () => {
  it("settles a pending decision with its walk-away value and clears the screen", async () => {
    render(<ToastHost />);
    let resolved: string | undefined;
    act(() => {
      choose("Pin this now-complete version?", PIN_OFFER).then((v) => {
        resolved = v;
      });
    });
    expect(screen.getByTestId("toast-host")).toBeTruthy();

    act(() => {
      resetToasts();
    });
    await flushMicrotasks();

    expect(resolved).toBe("cancel");
    expect(screen.queryByTestId("toast-host")).toBeNull();
  });

  it('falls back to "cancel" when the open decision has no non-primary action', async () => {
    render(<ToastHost />);
    let resolved: string | undefined;
    act(() => {
      choose("Unpin?", [{ value: "confirm", label: "Unpin", primary: true }]).then((v) => {
        resolved = v;
      });
    });

    act(() => {
      resetToasts();
    });
    await flushMicrotasks();

    expect(resolved).toBe("cancel");
    expect(screen.queryByTestId("toast-host")).toBeNull();
  });

  it("clears an outcome toast, tolerates no-op calls, and leaves the bus usable", () => {
    render(<ToastHost />);
    act(() => {
      notify("Fixed: app.js");
    });
    act(() => {
      resetToasts();
    });
    expect(screen.queryByTestId("toast-host")).toBeNull();

    expect(() => {
      act(() => {
        resetToasts();
      });
    }).not.toThrow();

    // The bus accepts a fresh decision afterwards (no leaked state).
    act(() => {
      choose("Publish it now?", PUBLISH_OFFER);
    });
    expect(screen.getByTestId("toast-host").textContent).toContain("Publish it now?");
  });
});