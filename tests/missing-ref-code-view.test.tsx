/**
 * MissingRefCodeView — the workspace code view highlights exactly which
 * lines reference files the workspace doesn't contain (the known
 * small-model quirk: HTML pointing at a script it never emitted).
 *
 * Pins: normal content renders as plain lines (empty file → placeholder);
 * lines in `missingLines` get the red highlight + explanatory tooltip and
 * carry a `missing-ref-line-<n>` testid; the highlight is per-file data —
 * the view itself never re-derives which lines to mark.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MissingRefCodeView } from "../src/components/builder-client";

afterEach(() => cleanup());

describe("MissingRefCodeView", () => {
  it("renders plain content with no highlights when nothing is missing", () => {
    const { container } = render(
      <MissingRefCodeView content={"a\nb\nc"} missingLines={[]} />,
    );
    expect(container.querySelector("[data-testid^='missing-ref-line-']")).toBeNull();
    expect(container.textContent).toContain("b");
  });

  it("keeps the file-placeholder for an empty file", () => {
    const { container } = render(
      <MissingRefCodeView content="" missingLines={[1]} />,
    );
    expect(container.textContent).toContain("// Select a file");
  });

  it("highlights exactly the given lines and names the problem in the tooltip", () => {
    const content = [
      "<!doctype html>",
      "<html>",
      '  <script src="app.js"></script>',
      '  <p>fine</p>',
      "</html>",
    ].join("\n");
    render(<MissingRefCodeView content={content} missingLines={[3]} />);

    const hit = screen.getByTestId("missing-ref-line-3");
    expect(hit.className).toContain("bg-red-950");
    expect(hit.getAttribute("title")).toContain("doesn't have");
    // Line 3 shows the offending reference; neighbors stay clean.
    expect(hit.textContent).toContain("app.js");
    expect(screen.queryByTestId("missing-ref-line-2")).toBeNull();
    expect(screen.queryByTestId("missing-ref-line-4")).toBeNull();
    expect(screen.getByTestId("missing-ref-view").textContent).toContain("fine");
  });

  it("highlights multiple scattered lines", () => {
    const content = ["one", "two", "three", "four"].join("\n");
    render(<MissingRefCodeView content={content} missingLines={[1, 4]} />);
    expect(screen.getByTestId("missing-ref-line-1")).toBeTruthy();
    expect(screen.getByTestId("missing-ref-line-4")).toBeTruthy();
    expect(screen.queryByTestId("missing-ref-line-2")).toBeNull();
    expect(screen.queryByTestId("missing-ref-line-3")).toBeNull();
  });
});
