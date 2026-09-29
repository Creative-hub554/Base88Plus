/**
 * Binary assets must never reach the model's context as base64 walls:
 * buildWorkspaceContext lists them by name instead of inlining content.
 * Pins the context-budget invariant introduced with binary asset support.
 */
import { describe, expect, it } from "vitest";
import { buildWorkspaceContext } from "../src/lib/prompt";

describe("buildWorkspaceContext — binary safety", () => {
  it("never inlines base64 asset contents; lists them by name instead", () => {
    const ctx = buildWorkspaceContext([
      { path: "index.html", content: "<p>x</p>" },
      { path: "img/logo.png", content: "QUJDREVG", encoding: "base64" },
      { path: "fonts/Inter.woff2", content: "d29mZjI=", encoding: "base64" },
    ]);
    // Text files still inline fully.
    expect(ctx).toContain("index.html");
    expect(ctx).toContain("<p>x</p>");
    // Base64 layers are absent from the prompt…
    expect(ctx).not.toContain("QUJDREVG");
    expect(ctx).not.toContain("d29mZjI=");
    // …and the assets are named so the model can reference them.
    expect(ctx).toContain("img/logo.png");
    expect(ctx).toContain("fonts/Inter.woff2");
    expect(ctx).toContain("Binary assets already in the project");
  });

  it("stays silent about binaries when there are none (baseline)", () => {
    const ctx = buildWorkspaceContext([{ path: "a.js", content: "1" }]);
    expect(ctx).not.toContain("Binary assets");
  });
});
