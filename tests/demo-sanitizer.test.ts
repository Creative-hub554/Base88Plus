/**
 * Pins for sanitizeDemoFiles (src/lib/template-generation.ts), the sanitizer
 * that strips tags referencing files the model never emitted from template
 * demo HTML.
 *
 * CodeQL's first scan of the repo flagged
 * js/incomplete-multi-character-sanitization on the original implementation:
 * three chained ONE-SHOT replaces could leave a broken tag behind when an
 * earlier deletion spliced the surrounding text into a new well-formed tag
 * (e.g. removing a dead <script> between "<im" and "g src='missing.png'>"
 * reveals a complete broken <img> AFTER the img pass already ran). The
 * sanitizer is now ONE alternation replace (all three tag shapes in a single
 * pass, so nothing "already ran") iterated to a fixed point — each pass only
 * deletes, so it terminates — and these tests pin both the splice case and
 * the ordinary contracts.
 */
import { describe, expect, it } from "vitest";
import { sanitizeDemoFiles } from "@/lib/template-generation";
import type { ProjectFile } from "@/lib/types";

const pf = (path: string, content: string): ProjectFile => ({ path, content });

describe("sanitizeDemoFiles", () => {
  it("strips img/script/link tags whose relative target was never emitted", () => {
    const html = [
      "<!doctype html><html><body>",
      '<img src="missing.png">',
      '<script src="missing.js"></script>',
      '<link href="missing.css" rel="stylesheet">',
      "<p>kept</p>",
      "</body></html>",
    ].join("\n");
    const out = sanitizeDemoFiles([pf("index.html", html), pf("app.js", "1")]);
    const cleaned = out[0].content;
    expect(cleaned).not.toContain("missing.png");
    expect(cleaned).not.toContain("missing.js");
    expect(cleaned).not.toContain("missing.css");
    expect(cleaned).toContain("<p>kept</p>");
  });

  it("keeps external, data, hash, and root-relative targets", () => {
    const html = [
      '<img src="https://example.com/x.png">',
      '<img src="data:image/png;base64,AAA">',
      '<a href="#top">x</a>',
      '<script src="/vendored.js"></script>',
    ].join("\n");
    const out = sanitizeDemoFiles([pf("index.html", html)]);
    expect(out[0].content).toBe(html);
  });

  it("keeps tags whose target exists in the emitted set", () => {
    const html = '<img src="local.png"><script src="app.js"></script>';
    const out = sanitizeDemoFiles([
      pf("index.html", html),
      pf("local.png", "PNG"),
      pf("app.js", "1"),
    ]);
    expect(out[0].content).toBe(html);
  });

  it("does not touch non-html files", () => {
    const files = [pf("styles.css", 'a { content: "<img src=missing.png>"; }')];
    const out = sanitizeDemoFiles(files);
    expect(out[0].content).toBe(files[0].content);
  });

  it("removes a broken tag spliced into shape by a prior pass (CodeQL js/incomplete-multi-character-sanitization)", () => {
    // Deleting the dead <script> splices "<im" + "g src='missing.png'>" into
    // a complete broken <img> — the img pass already ran, so a single chained
    // pass leaves it behind. The fixed-point loop must remove it too.
    const html = "<im<script src=\"x.js\"></script>g src='missing.png'>";
    const out = sanitizeDemoFiles([pf("index.html", html)]);
    expect(out[0].content).not.toContain("missing.png");
  });

  it("removes a broken tag truncated into shape by an unclosed attribute (alert's original case)", () => {
    // The attribute value closes the first match early; the tail re-forms a
    // complete <img src='missing.png'>.
    const html = '<img src="x> <img src=\'missing.png\'>">';
    const out = sanitizeDemoFiles([pf("index.html", html)]);
    expect(out[0].content).not.toContain("missing.png");
  });

  it("terminates on already-clean input without changes", () => {
    const html = "<p>nothing to do</p>";
    const out = sanitizeDemoFiles([pf("index.html", html)]);
    expect(out[0].content).toBe(html);
  });
});
