/**
 * /app/new — "Regenerate all" confirm converted to the in-app toast system.
 *
 * This was the LAST native window.confirm in the app (the pin/fix/publish
 * flows moved to the toast bus earlier). Pinned here:
 *   • clicking "Regenerate all" opens a choose() decision toast (no native
 *     dialog — jsdom can't show one, so a stubbed confirm that would throw
 *     on any call doubles as the no-native-dialog proof);
 *   • accepting the toast POSTs { all: true } to /api/templates;
 *   • declining never fires the POST;
 *   • the button shows "Regenerating…" while the pass runs, then settles.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NewAppPage from "../src/app/new/page";
import { resetToasts } from "../src/components/toast";

// Next 16's useRouter throws "invariant expected app router to be mounted"
// outside a real app-router tree; the page only uses push().
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const confirmSpy = vi.fn();

beforeEach(() => {
  confirmSpy.mockClear();
  // If any code path still reached for a native dialog this would trip.
  vi.stubGlobal("confirm", confirmSpy);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/templates" && !init?.method) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ templates: [], configured: true, warming: false }),
        } as Response);
      }
      if (url === "/api/templates" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ started: true }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    }),
  );
});

afterEach(() => {
  cleanup();
  resetToasts();
  vi.unstubAllGlobals();
});

describe("/app/new — regenerate-all toast decision", () => {
  it("opens a toast (not a native confirm) and POSTs {all:true} on accept", async () => {
    render(<NewAppPage />);
    fireEvent.click(await screen.findByText("Regenerate all"));

    const toast = await screen.findByTestId("toast-host");
    expect(toast.textContent).toContain("Regenerate every template demo");
    expect(toast.textContent).toContain("Cached previews will be replaced");
    expect(confirmSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("toast-confirm"));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/templates",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ all: true }),
        }),
      );
    });
  });

  it("declining the toast never fires the regeneration POST", async () => {
    render(<NewAppPage />);
    fireEvent.click(await screen.findByText("Regenerate all"));
    fireEvent.click(await screen.findByTestId("toast-cancel"));
    await new Promise((r) => setTimeout(r, 25));

    const posts = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url, init]) => url === "/api/templates" && init?.method === "POST",
    );
    expect(posts).toHaveLength(0);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("shows the Regenerating… state after accepting", async () => {
    render(<NewAppPage />);
    fireEvent.click(await screen.findByText("Regenerate all"));
    fireEvent.click(await screen.findByTestId("toast-confirm"));

    await waitFor(() => {
      expect(screen.getByText("Regenerating…")).toBeTruthy();
    });
  });
});
