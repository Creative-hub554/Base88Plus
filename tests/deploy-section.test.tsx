/**
 * Component tests for the DeploySection connect flow.
 *
 * Contract: the connect form only renders when DISCONNECTED, and both
 * fields are fresh typed credentials — so connect() MUST post both
 * fields. This is the deliberate counterpart of the diff-based saves
 * elsewhere: a connect is a command, not a merge, and the route verifies
 * what it receives. Pins:
 *   • connect posts {accountId, apiKey} — both fields, exactly once;
 *   • success swaps the form for the connected panel (token state gone);
 *   • a verification failure surfaces the route's error verbatim and
 *     keeps the token in the field for retry.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeploySection } from "../src/components/builder-client";

type Call = { url: string; body?: Record<string, unknown> };

let calls: Call[];
let failConnect: boolean;

beforeEach(() => {
  calls = [];
  failConnect = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/api/deploy/settings") && !init?.method) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ connected: false, accountId: undefined }),
        } as Response);
      }
      if (url.includes("/deploy") && init?.method === "POST") {
        if (failConnect) {
          return Promise.resolve({
            ok: false,
            status: 400,
            json: () => Promise.resolve({ error: "Invalid API token" }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              connected: true,
              accountId: "a".repeat(32),
              subdomain: "my-sub",
            }),
        } as Response);
      }
      // GET /api/projects/:id/deploy (status + versions on load).
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ deployment: null, versions: [] }),
      } as Response);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * `delay: null` is load-bearing, not a style choice.
 *
 * user-event defaults to `delay: 0`, and that is not "no delay" — it is a
 * real `setTimeout(resolve, 0)` awaited between EVERY keystroke
 * (user-event/dist/cjs/utils/misc/wait.js). These tests type 56 characters,
 * so the happy path burned ~60 event-loop round trips whose wall time is
 * entirely at the mercy of scheduler contention. Measured on an idle box the
 * first test took 1.27s of which almost all was that waiting; run in parallel
 * (12 test files against 12 cores, plus any other load on the machine) each
 * hop stretches and the total sails past vitest's 5s per-test timeout — which
 * is exactly the "pure 5s timeout" failure this suite showed. `delay: null`
 * makes `wait()` return without scheduling (same file, the `typeof delay !==
 * 'number'` branch), so the interactions still fire as real per-key input
 * events but no longer race the clock. Nothing about what is asserted changes.
 */
async function renderSection() {
  const user = userEvent.setup({ delay: null });
  render(<DeploySection projectId="p1" viewingVersion={null} onViewVersion={() => {}} />);
  // The connect form renders synchronously (status is null ⇒ connected is
  // false), so this is a presence assertion, not a wait.
  screen.getByLabelText("Cloudflare Account ID");
  return user;
}

describe("DeploySection — connect contract", () => {
  it("posts both credential fields on connect (command, not merge)", async () => {
    const user = await renderSection();

    await user.type(screen.getByLabelText("Cloudflare Account ID"), "a".repeat(32));
    await user.type(
      screen.getByLabelText("Cloudflare API token"),
      "cf-token-0123456789abcdef",
    );
    await user.click(screen.getByRole("button", { name: "Connect Cloudflare" }));

    await waitFor(() => expect(screen.getByText("connected")).toBeTruthy());
    const posts = calls.filter(
      (c) => c.url.endsWith("/api/deploy/settings") && c.body,
    );
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({
      accountId: "a".repeat(32),
      apiKey: "cf-token-0123456789abcdef",
    });

    // Success swaps the connect form for the connected panel — the token
    // input (and its state) is gone entirely, never to be re-posted.
    expect(screen.queryByLabelText("Cloudflare API token")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Deploy to Cloudflare" }),
    ).toBeTruthy();
  });

  it("surfaces the verification error verbatim and keeps the token for retry", async () => {
    const user = await renderSection();
    failConnect = true;

    await user.type(screen.getByLabelText("Cloudflare Account ID"), "a".repeat(32));
    await user.type(
      screen.getByLabelText("Cloudflare API token"),
      "cf-bad-token-0123456789",
    );
    await user.click(screen.getByRole("button", { name: "Connect Cloudflare" }));

    await waitFor(() => expect(screen.getByText("Invalid API token")).toBeTruthy());
    expect(
      (screen.getByLabelText("Cloudflare API token") as HTMLInputElement).value,
    ).toBe("cf-bad-token-0123456789");
  });
});
