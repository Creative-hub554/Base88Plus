/**
 * FilePanel — the workspace file list with drag-and-drop/click asset
 * upload. Pins the glue: "+" opens the picker, dropping files posts
 * multipart to /assets, outcome toast (warn on partial rejection),
 * onUploaded drives the files refresh, file buttons still select.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilePanel } from "../src/components/asset-uploader";
import { ToastHost, resetToasts } from "../src/components/toast";

const onUploaded = vi.fn();
const onFileSelect = vi.fn();

let respond: (files: string[]) => Response;

function makeFiles(names: string[]) {
  return names.map(
    (n) => new File([new Uint8Array([1, 2, 3])], n, { type: "application/octet-stream" }),
  );
}

beforeEach(() => {
  onUploaded.mockClear();
  onFileSelect.mockClear();
  lastPost = null;
  respond = (saved) =>
    new Response(
      JSON.stringify({ saved: saved.map((p) => ({ path: p })), errors: [] }),
      { status: 201 },
    );
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      lastPost = {
        url: String(_input),
        form: init?.body as FormData,
      };
      return Promise.resolve(respond(["dropped.png"]));
    }),
  );
  render(
    <>
      <FilePanel
        projectId="p1"
        files={[{ path: "index.html" }, { path: "app.js" }]}
        activeFile="index.html"
        onFileSelect={onFileSelect}
        onUploaded={onUploaded}
      />
      <ToastHost />
    </>,
  );
});

let lastPost: { url: string; form: FormData } | null = null;

afterEach(() => {
  cleanup();
  resetToasts();
  vi.unstubAllGlobals();
});

describe("FilePanel asset upload", () => {
  it("renders files, selects on click, and posts picker uploads to /assets", async () => {
    fireEvent.click(screen.getByText("app.js"));
    expect(onFileSelect).toHaveBeenCalledWith("app.js");

    const input = screen.getByTestId("asset-input") as HTMLInputElement;
    expect(input.accept).toContain(".png");
    expect(input.accept).toContain(".woff2");
    expect(input.multiple).toBe(true);

    fireEvent.change(input, { target: { files: makeFiles(["icon.png"]) } });
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(["dropped.png"]));
    expect(lastPost?.url).toBe("/api/projects/p1/assets");
    expect(lastPost?.form.get("file")).toBeInstanceOf(File);
    expect(screen.getByTestId("toast-host").textContent).toContain("Added 1 asset(s)");
  });

  it("uploads files dropped onto the panel", async () => {
    const panel = screen.getByTestId("file-panel");
    // fireEvent.drop resolves to false BECAUSE the handler preventDefaults
    // (jsdom semantics) — the upload happening is the real assertion.
    fireEvent.drop(panel, {
      dataTransfer: { files: makeFiles(["a.png", "b.woff2"]) },
    });
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(["dropped.png"]));
    expect(lastPost?.form.getAll("file")).toHaveLength(2);
  });

  it("warns on partial rejection and shows danger on total failure", async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          saved: [{ path: "ok.png" }],
          errors: [{ filename: "bad.png", error: "Unsupported asset type" }],
        }),
        { status: 201 },
      );
    fireEvent.drop(screen.getByTestId("file-panel"), {
      dataTransfer: { files: makeFiles(["ok.png", "bad.png"]) },
    });
    await waitFor(() =>
      expect(screen.getByTestId("toast-host").textContent).toContain("1 rejected"),
    );

    respond = () =>
      new Response(
        JSON.stringify({
          saved: [],
          errors: [{ filename: "bad.png", error: "Too large (max 2000 kB)" }],
        }),
        { status: 400 },
      );
    fireEvent.drop(screen.getByTestId("file-panel"), {
      dataTransfer: { files: makeFiles(["bad.png"]) },
    });
    await waitFor(() =>
      expect(screen.getByTestId("toast-host").textContent).toContain("bad.png: Too large"),
    );
    expect(onUploaded).toHaveBeenCalledTimes(1); // total failure → no refresh
  });

  it("does not upload an empty drop", async () => {
    fireEvent.drop(screen.getByTestId("file-panel"), {
      dataTransfer: { files: [] },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(lastPost).toBeNull();
    expect(onUploaded).not.toHaveBeenCalled();
  });
});
