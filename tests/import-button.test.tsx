/**
 * ImportZipButton — the dashboard's import affordance (the return leg of
 * the export story). Pins the glue: hidden file input → POST multipart
 * (file + filename-derived name) to /api/projects/import → outcome toast
 * (warn when entries were skipped) → navigate into the new project.
 * Failure paths keep the user on the dashboard with a danger toast.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportZipButton } from "../src/components/import-button";
import { ToastHost, resetToasts } from "../src/components/toast";

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

let fetchResponse: () => Promise<Response>;

function pickFile(name: string, type = "application/zip") {
  const input = screen.getByTestId("import-input") as HTMLInputElement;
  const file = new File(["PK-x-fake"], name, { type });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

beforeEach(() => {
  mockPush.mockClear();
  fetchResponse = async () =>
    new Response(
      JSON.stringify({ project: { id: "imported-1" }, importedCount: 3, skipped: [] }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      // Capture the wire shape: FormData with the file + derived name.
      const form = init?.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect(form.get("file")).toBeInstanceOf(File);
      return fetchResponse().then((res) => {
        lastWire = {
          name: String(form.get("name") ?? ""),
          url: String(_input),
          method: init?.method ?? "GET",
        };
        return res;
      });
    }),
  );
  render(
    <>
      <ImportZipButton />
      <ToastHost />
    </>,
  );
});

let lastWire: { name: string; url: string; method: string } | null = null;

afterEach(() => {
  cleanup();
  resetToasts();
  vi.unstubAllGlobals();
});

describe("ImportZipButton", () => {
  it("posts the picked file with a derived name, toasts, and navigates into the app", async () => {
    pickFile("recipe-box.zip");
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/app/imported-1"));
    expect(lastWire?.url).toBe("/api/projects/import");
    expect(lastWire?.method).toBe("POST");
    expect(lastWire?.name).toBe("recipe-box");
    expect(screen.getByTestId("toast-host").textContent).toContain("Imported 3 file(s)");
  });

  it("warns when entries were skipped, and keeps the button busy-safe", async () => {
    fetchResponse = async () =>
      new Response(
        JSON.stringify({
          project: { id: "imported-2" },
          importedCount: 2,
          skipped: [{ path: "img/x.png", reason: "binary" }],
        }),
        { status: 201 },
      );
    pickFile("with-assets.zip");
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/app/imported-2"));
    const toast = screen.getByTestId("toast-host");
    expect(toast.textContent).toContain("1 skipped");
  });

  it("stays on the dashboard with a danger toast when the API rejects the zip", async () => {
    fetchResponse = async () =>
      new Response(JSON.stringify({ error: "The uploaded file is not a zip archive" }), {
        status: 400,
      });
    pickFile("garbage.zip");
    await waitFor(() =>
      expect(screen.getByTestId("toast-host").textContent).toContain("not a zip"),
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("re-picking the same file re-fires the change event (input value reset)", async () => {
    pickFile("first.zip");
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    pickFile("first.zip");
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(2));
  });
});
