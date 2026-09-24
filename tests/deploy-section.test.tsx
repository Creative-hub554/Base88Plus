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

async function renderSection() {
  render(<DeploySection projectId="p1" viewingVersion={null} onViewVersion={() => {}} />);
  await screen.findByLabelText("Cloudflare Account ID");
}

describe("DeploySection — connect contract", () => {
  it("posts both credential fields on connect (command, not merge)", async () => {
    await renderSection();

    await userEvent.type(screen.getByLabelText("Cloudflare Account ID"), "a".repeat(32));
    await userEvent.type(
      screen.getByLabelText("Cloudflare API token"),
      "cf-token-0123456789abcdef",
    );
    await userEvent.click(screen.getByRole("button", { name: "Connect Cloudflare" }));

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
    await renderSection();
    failConnect = true;

    await userEvent.type(screen.getByLabelText("Cloudflare Account ID"), "a".repeat(32));
    await userEvent.type(
      screen.getByLabelText("Cloudflare API token"),
      "cf-bad-token-0123456789",
    );
    await userEvent.click(screen.getByRole("button", { name: "Connect Cloudflare" }));

    await waitFor(() => expect(screen.getByText("Invalid API token")).toBeTruthy());
    expect(
      (screen.getByLabelText("Cloudflare API token") as HTMLInputElement).value,
    ).toBe("cf-bad-token-0123456789");
  });
});
