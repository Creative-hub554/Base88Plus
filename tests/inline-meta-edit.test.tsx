/**
 * The shared inline meta-edit layer (useInlineMetaEdit + MetaEditButtons)
 * pinned through its TWO surfaces: the builder-header ProjectNameEditor
 * (previously untested) and — via the dedicated card suite — the dashboard
 * description editor. This file pins the header-specific glue and the
 * contract both surfaces share: one-field PATCH to
 * /api/projects/[id]/meta, server-wins normalization, server error
 * surfaced (including the empty-name 400 the store throws), Enter/blur
 * commit, Escape cancel, and the unchanged-value no-op (free re-blurs).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectNameEditor } from "../src/components/builder-client";
import { MetaEditButtons } from "../src/components/inline-meta-edit";
import { ToastHost, resetToasts } from "../src/components/toast";

type Wire = { url: string; method: string; body: unknown };

let fetchResponse: () => Promise<Response>;
let lastWire: Wire | null = null;

beforeEach(() => {
  lastWire = null;
  fetchResponse = async () =>
    new Response(JSON.stringify({ project: { name: "Renamed App" } }), {
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
  render(
    <>
      <ProjectNameEditor projectId="p1" initialName="Old Name" />
      <ToastHost />
    </>,
  );
});

afterEach(() => {
  cleanup();
  resetToasts();
  vi.unstubAllGlobals();
});

/** The header editor's display mode is a button showing the name. */
function displayButton(): HTMLElement {
  return screen.getByTitle("Rename project");
}

function enterEdit() {
  fireEvent.click(displayButton());
  return screen.getByLabelText("Project name") as HTMLInputElement;
}

describe("ProjectNameEditor (via useInlineMetaEdit)", () => {
  it("commits on blur with a name-only PATCH and shows the server-normalized value", async () => {
    const input = enterEdit();
    fireEvent.change(input, { target: { value: "  Padded  " } });
    fireEvent.blur(input);

    await waitFor(() => expect(displayButton()).toBeTruthy());
    expect(lastWire?.url).toBe("/api/projects/p1/meta");
    expect(lastWire?.method).toBe("PATCH");
    expect(lastWire?.body).toEqual({ name: "Padded" });
    expect(displayButton().textContent).toContain("Renamed App");
    expect(screen.getByTestId("toast-host").textContent).toContain("Project renamed");
  });

  it("commits on Enter (blur-on-Enter pattern)", async () => {
    const input = enterEdit();
    fireEvent.change(input, { target: { value: "Enter Name" } });
    fireEvent.keyDown(input, { key: "Enter", preventDefault: vi.fn() });
    fireEvent.blur(input); // the component blurs itself

    await waitFor(() => expect(lastWire).not.toBeNull());
    expect(lastWire?.body).toEqual({ name: "Enter Name" });
  });

  it("Escape cancels without a network call", () => {
    const input = enterEdit();
    fireEvent.change(input, { target: { value: "discarded" } });
    fireEvent.keyDown(input, { key: "Escape", preventDefault: vi.fn() });

    expect(displayButton()).toBeTruthy();
    expect(displayButton().textContent).toContain("Old Name");
    expect(lastWire).toBeNull();
  });

  it("an unchanged value commits nothing (free re-blurs)", async () => {
    const input = enterEdit();
    fireEvent.blur(input); // no edit at all
    expect(lastWire).toBeNull();

    fireEvent.change(input, { target: { value: "Old Name" } });
    fireEvent.blur(input);
    expect(lastWire).toBeNull();
  });

  it("surfaces the server's error toast instead of a local message", async () => {
    fetchResponse = async () =>
      new Response(JSON.stringify({ error: "Name cannot be empty" }), { status: 400 });
    const input = enterEdit();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(screen.getByTestId("toast-host").textContent).toContain(
        "Name cannot be empty",
      ),
    );
    // The previous name is untouched.
    expect(displayButton().textContent).toContain("Old Name");
  });

  it("keeps the input in sync while typing (controlled draft)", () => {
    const input = enterEdit();
    fireEvent.change(input, { target: { value: "typing…" } });
    expect(input.value).toBe("typing…");
  });
});

describe("MetaEditButtons defaults", () => {
  it("renders default test ids and labels", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(
      <MetaEditButtons busy={false} onSave={onSave} onCancel={onCancel} counter="7/500" />,
    );
    fireEvent.click(screen.getByTestId("meta-edit-save"));
    fireEvent.click(screen.getByTestId("meta-edit-cancel"));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByText("7/500")).toBeTruthy();
  });
});
