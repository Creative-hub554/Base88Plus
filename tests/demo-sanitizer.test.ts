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
import {
  demoLooksComplete,
  sanitizeDemoFiles,
} from "@/lib/template-generation";
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

  it("neutralizes anchors to emitted-nowhere pages instead of deleting them", () => {
    const html = [
      '<nav><a href="index.html">Home</a><a href="missing.html">Docs</a></nav>',
      '<a href="post.html#intro">Intro</a>',
      "<p>kept</p>",
    ].join("\n");
    const out = sanitizeDemoFiles([
      pf("index.html", html),
      pf("post.html", "<p>post</p>"),
    ]);
    const cleaned = out[0].content;
    // Emitted pages keep their hrefs (fragment rides along).
    expect(cleaned).toContain('href="index.html"');
    expect(cleaned).toContain('href="post.html#intro"');
    // Dead page: rewritten in place, link text survives.
    expect(cleaned).toContain('href="#"');
    expect(cleaned).toContain(">Docs</a>");
    expect(cleaned).not.toContain("missing.html");
  });

  it("anchors: root-relative links do NOT count as keepable (a static demo cannot leave itself)", () => {
    // The live saas failure: /pricing, /about, /contact look like routes
    // but 404 in a static multi-page demo.
    const html = '<nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav>';
    const out = sanitizeDemoFiles([pf("index.html", html)]);
    const cleaned = out[0].content;
    expect(cleaned).toContain('>Pricing</a>');
    expect(cleaned).not.toContain('href="/pricing"');
    expect(cleaned).toContain('href="#"');
  });

  it("anchors: external, mailto, tel, data, and hash links are kept", () => {
    const html = [
      '<a href="https://example.com">ext</a>',
      '<a href="mailto:hi@example.com">mail</a>',
      '<a href="tel:+123">tel</a>',
      '<a href="#top">hash</a>',
      '<a href="data:text/html,hi">data</a>',
    ].join("\n");
    const out = sanitizeDemoFiles([pf("index.html", html)]);
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

describe("demoLooksComplete", () => {
  it("accepts a styled page with a body", () => {
    expect(
      demoLooksComplete([
        pf("index.html", "<html><body><h1>hi</h1></body></html>"),
        pf("styles.css", "body{margin:0}"),
      ]),
    ).toBe(true);
  });

  it("accepts an inline <style> block with no separate stylesheet", () => {
    expect(
      demoLooksComplete([
        pf("index.html", "<html><body><style>body{margin:0}</style></body></html>"),
      ]),
    ).toBe(true);
  });

  // The real incident: generation returned a 5 KB inline base64 og:image and
  // stopped before <body>. It was cached and served as a ready demo whose
  // preview rendered blank.
  it("rejects output truncated before <body>", () => {
    const truncated = [
      "<!doctype html><html><head>",
      '<meta property="og:image" content="data:image/png;base64,iVBORw0KGgo',
    ].join("");
    expect(demoLooksComplete([pf("index.html", truncated)])).toBe(false);
  });

  it("rejects unstyled markup even when the body is intact", () => {
    expect(
      demoLooksComplete([
        pf("index.html", "<html><body><h1>Title</h1><p>text</p></body></html>"),
      ]),
    ).toBe(false);
  });

  it("rejects a file set with no html at all", () => {
    expect(demoLooksComplete([pf("styles.css", "body{}")])).toBe(false);
  });

  it("rejects an empty stylesheet as a styling source", () => {
    expect(
      demoLooksComplete([
        pf("index.html", "<html><body>x</body></html>"),
        pf("styles.css", "   "),
      ]),
    ).toBe(false);
  });
});

describe("sanitizeDemoFiles: placeholder nav relinking", () => {
  it("points a '#' nav label at the page it names", () => {
    const html = '<nav><a class="link" href="#">Pricing</a></nav>';
    const out = sanitizeDemoFiles([
      pf("index.html", html),
      pf("pricing.html", "<html><body>pricing</body></html>"),
    ]);
    expect(out[0].content).toContain('href="pricing.html"');
    expect(out[0].content).not.toContain('href="#"');
    // the anchor keeps its other attributes
    expect(out[0].content).toContain('class="link"');
  });

  it("maps Home to index.html", () => {
    const out = sanitizeDemoFiles([
      pf("about.html", '<a href="#">Home</a>'),
      pf("index.html", "<html><body>x</body></html>"),
    ]);
    expect(out[0].content).toContain('href="index.html"');
  });

  it("leaves an in-page anchor that names no page alone", () => {
    const out = sanitizeDemoFiles([
      pf("index.html", '<a href="#">Skip to content</a>'),
      pf("pricing.html", "<html><body>p</body></html>"),
    ]);
    expect(out[0].content).toContain('href="#"');
  });

  // A dead anchor neutralized to "#" must stay dead: relinking runs after
  // neutralization and only fires for pages that really were emitted.
  it("does not resurrect a neutralized dead anchor", () => {
    const out = sanitizeDemoFiles([
      pf("index.html", '<a href="pricing.html">Pricing</a>'),
      pf("styles.css", "body{}"),
    ]);
    expect(out[0].content).toContain('href="#"');
  });

  it("leaves an ambiguous slug alone rather than guessing", () => {
    // about-us.html and about_us.html both slug to "about-us"; picking
    // either one would be a coin flip, so the placeholder stays.
    const out = sanitizeDemoFiles([
      pf("index.html", '<a href="#">About Us</a>'),
      pf("about-us.html", "<html><body>a</body></html>"),
      pf("about_us.html", "<html><body>b</body></html>"),
    ]);
    expect(out[0].content).toContain('href="#"');
  });

  // The real saas case: a whole navbar of placeholders, each label naming
  // a page that was emitted.
  it("relinks every label of a multi-item navbar to its own page", () => {
    const nav =
      '<a href="#">Home</a><a href="#">Pricing</a><a href="#">About</a><a href="#">Contact</a>';
    const out = sanitizeDemoFiles([
      pf("index.html", nav),
      pf("pricing.html", "<html><body>p</body></html>"),
      pf("about.html", "<html><body>a</body></html>"),
      pf("contact.html", "<html><body>c</body></html>"),
    ]);
    expect(out[0].content).toContain('href="index.html"');
    expect(out[0].content).toContain('href="pricing.html"');
    expect(out[0].content).toContain('href="about.html"');
    expect(out[0].content).toContain('href="contact.html"');
    expect(out[0].content).not.toContain('href="#"');
  });

  // Matching is exact on the slug: "About Us" is not about.html.
  it("does not fuzzy-match a label to a differently-named page", () => {
    const out = sanitizeDemoFiles([
      pf("index.html", '<a href="#">About Us</a>'),
      pf("about.html", "<html><body>a</body></html>"),
    ]);
    expect(out[0].content).toContain('href="#"');
  });

  it("does not relink inside a single-page demo", () => {
    const out = sanitizeDemoFiles([pf("index.html", '<a href="#">Pricing</a>')]);
    expect(out[0].content).toContain('href="#"');
  });
});

describe("sanitizeDemoFiles: JSON-escaped attribute quotes", () => {
  it("rewrites escaped quotes inside a data-URI favicon", () => {
    const html =
      '<link rel="icon" href="data:image/svg+xml,<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 24 24\\">';
    const out = sanitizeDemoFiles([pf("index.html", html)]);
    expect(out[0].content).not.toContain('\\"');
    expect(out[0].content).toContain(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>",
    );
  });

  it("leaves ordinary html untouched", () => {
    const html = '<a href="index.html" class="x">Hi</a><p>plain "quoted" text</p>';
    const out = sanitizeDemoFiles([pf("index.html", html)]);
    expect(out[0].content).toContain('class="x"');
  });
});
