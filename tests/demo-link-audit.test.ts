import { describe, expect, it } from "vitest";
import {
  auditDemoLinks,
  demoNavIsWired,
  formatDemoLinkAudit,
  formatDemoLinkProblem,
  pageForLabel,
  resolveDemoPath,
  type DemoAuditFile,
} from "@/lib/demo-link-audit";
import { sanitizeDemoFiles } from "@/lib/template-generation";

function f(path: string, content: string): DemoAuditFile {
  return { path, content };
}

function page(body: string, name = "index.html"): DemoAuditFile {
  return f(name, `<html><head></head><body>${body}</body></html>`);
}

const STYLE = f("styles.css", "body{color:red}");

describe("auditDemoLinks: the navbar a preview cannot show", () => {
  // The defect this audit exists for: the original check asked "does every
  // href resolve to an emitted file?", and a navbar of href="#" answered
  // yes — "#" is a legal target. Four real pages, zero navigable.
  it("calls a placeholder nav inert when its label names an emitted page", () => {
    const audit = auditDemoLinks([
      page('<nav><a href="#">Home</a><a href="#">Pricing</a></nav>'),
      page("<p>p</p>", "pricing.html"),
      STYLE,
    ]);
    expect(audit.inert).toHaveLength(2);
    expect(audit.inert.map((p) => p.page).sort()).toEqual([
      "index.html",
      "pricing.html",
    ]);
    expect(audit.dead).toHaveLength(0);
    expect(audit.ok).toBe(false);
  });

  it("names the file, the label and the missing target in the report", () => {
    const audit = auditDemoLinks([
      page('<a class="nav" href="#">Contact</a>'),
      page("<p>c</p>", "contact.html"),
    ]);
    const line = formatDemoLinkProblem(audit.inert[0]);
    expect(line).toContain("index.html");
    expect(line).toContain('"#"');
    expect(line).toContain("Contact");
    expect(line).toContain("contact.html");
    expect(formatDemoLinkAudit(audit)).toBe(line);
  });

  // The rule needs a boundary or it would reject every honest placeholder.
  it("allows a placeholder that names no page (skip link, back to top)", () => {
    const audit = auditDemoLinks([
      page(
        '<a href="#main">Skip to content</a><a href="#">Back to top</a><main id="main"></main>',
      ),
      page("<p>p</p>", "pricing.html"),
    ]);
    expect(audit.ok).toBe(true);
    // the bare "#" is counted, not failed; the "#main" is a real target
    expect(audit.placeholders).toBe(1);
  });

  it("does not call an ambiguous label inert — it names no single page", () => {
    const audit = auditDemoLinks([
      page('<a href="#">About Us</a>'),
      page("<p>a</p>", "about-us.html"),
      page("<p>b</p>", "about_us.html"),
    ]);
    expect(audit.inert).toHaveLength(0);
    expect(audit.placeholders).toBe(1);
    expect(audit.ok).toBe(true);
  });

  it("ignores a label wrapped in markup", () => {
    const audit = auditDemoLinks([
      page('<a href="#"><span>Pricing</span></a>'),
      page("<p>p</p>", "pricing.html"),
    ]);
    expect(audit.inert).toHaveLength(1);
    expect(audit.inert[0].label).toBe("Pricing");
  });
});

describe("auditDemoLinks: dead links", () => {
  it("reports a page the demo never emitted", () => {
    const audit = auditDemoLinks([
      page('<a href="pricing.html">Pricing</a>'),
      STYLE,
    ]);
    expect(audit.dead).toHaveLength(1);
    expect(audit.dead[0].reason).toBe("dead");
    expect(audit.dead[0].label).toBe("Pricing");
  });

  it("reports an unresolvable asset", () => {
    const audit = auditDemoLinks([
      page('<link rel="stylesheet" href="theme.css"><img src="hero.png">'),
    ]);
    expect(audit.dead.map((p) => p.target).sort()).toEqual([
      "hero.png",
      "theme.css",
    ]);
  });

  it("resolves a fragment against the ids the page really has", () => {
    const ok = auditDemoLinks([
      page('<nav><a href="#pricing">Pricing</a></nav><section id="pricing"></section>'),
    ]);
    expect(ok.ok).toBe(true);

    // an in-page anchor whose target is missing is a dead link wearing a
    // legal-looking href — the same blind spot "#" itself was
    const missing = auditDemoLinks([page('<a href="#pricing">Pricing</a>')]);
    expect(missing.dead).toHaveLength(1);
    expect(missing.dead[0].target).toBe("#pricing");
  });

  it("keeps a query string and a cross-page fragment out of the path check", () => {
    const audit = auditDemoLinks([
      page('<a href="post.html?id=2">Post</a><a href="index.html#top">Top</a>'),
      page("<p>p</p>", "post.html"),
    ]);
    expect(audit.ok).toBe(true);
  });

  it("resolves rooted and dotted paths", () => {
    const audit = auditDemoLinks([
      page('<a href="/pricing.html">P</a><a href="./about.html">A</a>'),
      page("<p>p</p>", "pricing.html"),
      page("<p>a</p>", "about.html"),
    ]);
    expect(audit.ok).toBe(true);
  });

  it("does not count or fail an external or data ref", () => {
    const audit = auditDemoLinks([
      page(
        '<a href="https://example.com">E</a><a href="mailto:a@b.co">M</a>' +
          '<a href="tel:+1">T</a><img src="data:image/svg+xml,<svg>">',
      ),
    ]);
    expect(audit.ok).toBe(true);
    expect(audit.checked).toBe(0);
  });

  it("does not look inside non-html files", () => {
    const audit = auditDemoLinks([
      f("app.js", 'document.write("<a href=\\"missing.html\\">x</a>")'),
    ]);
    expect(audit.ok).toBe(true);
    expect(audit.checked).toBe(0);
  });
});

describe("pageForLabel", () => {
  it("maps Home to index and an exact label to its page", () => {
    expect(pageForLabel("Home", ["index.html", "pricing.html"])).toEqual({
      page: "index.html",
      ambiguous: false,
    });
    expect(pageForLabel("Pricing", ["index.html", "pricing.html"])).toEqual({
      page: "pricing.html",
      ambiguous: false,
    });
  });

  it("answers ambiguous when two pages slug to the same word", () => {
    expect(pageForLabel("About Us", ["about-us.html", "about_us.html"])).toEqual({
      page: null,
      ambiguous: true,
    });
  });

  it("answers null for an empty label and for no match", () => {
    expect(pageForLabel("", ["index.html"])).toBeNull();
    expect(pageForLabel("Docs", ["index.html"])).toBeNull();
  });
});

describe("resolveDemoPath", () => {
  it("reads a rooted path as site-rooted and '.' as the index", () => {
    expect(resolveDemoPath("index.html", "/pricing.html")).toBe("pricing.html");
    expect(resolveDemoPath("index.html", "/")).toBe("index.html");
    expect(resolveDemoPath("index.html", "./about.html")).toBe("about.html");
  });

  it("walks up out of a subdirectory", () => {
    expect(resolveDemoPath("blog/post.html", "../styles.css")).toBe("styles.css");
  });
});

describe("demoNavIsWired: the generation gate", () => {
  it("passes a wired-up navbar and fails a placeholder one", () => {
    const wired = [
      page('<nav><a href="index.html">Home</a><a href="pricing.html">Pricing</a></nav>'),
      page("<p>p</p>", "pricing.html"),
    ];
    expect(demoNavIsWired(wired)).toBe(true);
    expect(
      demoNavIsWired([
        page('<nav><a href="#">Home</a><a href="#">Pricing</a></nav>'),
        page("<p>p</p>", "pricing.html"),
      ]),
    ).toBe(false);
  });

  // The two halves of the contract: the sanitizer fixes what it can, and the
  // audit is what proves it. A demo that reaches the cache has been through
  // both, so a relinked navbar can never read as inert afterwards.
  it("agrees with the sanitizer it shares a matcher with", () => {
    const emitted: DemoAuditFile[] = [
      f("index.html", '<nav><a href="#">Home</a><a href="#">Pricing</a></nav>'),
      f("pricing.html", "<html><body>p</body></html>"),
      STYLE,
    ];
    const sanitized = sanitizeDemoFiles(emitted);
    expect(demoNavIsWired(sanitized)).toBe(true);
    expect(demoNavIsWired(emitted)).toBe(false);
  });

  // The gate is deliberately narrower than the audit. A dead link is model
  // sloppiness; failing a generation over it would throw away a good demo
  // rather than improve it. The real landing demo has five of them (a footer
  // pointing at #terms on a one-pager) and still generates fine.
  it("does not gate on a dead link, only on an inert one", () => {
    const deadish = [page('<a href="ghost.html">Ghost</a><a href="#nope">N</a>')];
    const audit = auditDemoLinks(deadish);
    expect(audit.dead.length).toBeGreaterThan(0);
    expect(demoNavIsWired(deadish)).toBe(true);
  });

  it("gates on an inert link even when everything else resolves", () => {
    const mostlyFine = [
      page('<link rel="stylesheet" href="styles.css"><a href="#">Pricing</a>'),
      page("<p>p</p>", "pricing.html"),
      STYLE,
    ];
    expect(auditDemoLinks(mostlyFine).dead).toHaveLength(0);
    expect(demoNavIsWired(mostlyFine)).toBe(false);
  });

  it("is idempotent: sanitizing twice changes nothing", () => {
    const emitted: DemoAuditFile[] = [
      f("index.html", '<a href="#">About</a><a href="ghost.html">Ghost</a>'),
      f("about.html", "<html><body>a</body></html>"),
    ];
    const once = sanitizeDemoFiles(emitted);
    expect(sanitizeDemoFiles(once)).toEqual(once);
    // the ghost anchor is neutralized to a placeholder rather than deleted,
    // so the audit that runs afterwards sees it as a harmless "#"
    expect(once[0].content).toContain("Ghost</a>");
    const audit = auditDemoLinks(once);
    expect(audit.dead).toHaveLength(0);
    expect(audit.placeholders).toBe(1);
    expect(demoNavIsWired(once)).toBe(true);
  });

  // The gate runs on SANITIZED output, so anything the sanitizer can fix is
  // already fixed by the time a demo is judged — which is what makes a
  // generation retry mean "the model would not build this site", not
  // "the sanitizer lost a fight".
  it("judges the post-sanitize file set, where a dead link is already neutralized", () => {
    const emitted: DemoAuditFile[] = [
      f("index.html", '<a href="ghost.html">Ghost</a>'),
    ];
    expect(auditDemoLinks(emitted).dead).toHaveLength(1);
    const clean = sanitizeDemoFiles(emitted);
    expect(auditDemoLinks(clean).dead).toHaveLength(0);
    expect(demoNavIsWired(clean)).toBe(true);
  });
});

  it("is idempotent: sanitizing twice changes nothing", () => {
    const emitted: DemoAuditFile[] = [
      f("index.html", '<a href="#">About</a><a href="ghost.html">Ghost</a>'),
      f("about.html", "<html><body>a</body></html>"),
    ];
    const once = sanitizeDemoFiles(emitted);
    expect(sanitizeDemoFiles(once)).toEqual(once);
    // the ghost anchor is neutralized to a placeholder rather than deleted,
    // so the audit that runs afterwards sees it as a harmless "#"
    expect(once[0].content).toContain("Ghost</a>");
    const audit = auditDemoLinks(once);
    expect(audit.dead).toHaveLength(0);
    expect(audit.placeholders).toBe(1);
    expect(demoNavIsWired(once)).toBe(true);
  });
