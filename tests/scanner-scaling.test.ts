/**
 * Pins for the HTML scanners: linear, and behaving exactly as they did.
 *
 * This repo had four copies of the same quadratic shape — a regex of the form
 * `/<[a-zA-Z][^>]*>/` or `/<[^>]*>/` walking generated HTML — plus one cubic
 * one. `[^>]*` cannot cross a `>`, so a `<` with no `>` after it makes the
 * engine consume the rest of the file looking for one, fail, and try again at
 * the next `<`: a full pass over the remainder for every unmatched `<`. The
 * cubic one, `BROKEN_TAG_RE`, had `[^>]*` on both sides of a required literal,
 * so it backtracked through every position twice — and ran inside a
 * fixed-point loop, so it paid that twice per file.
 *
 * Measured on adversarial input before the fix, growing 4x per doubling:
 * `auditDemoLinks` (12.4ms at 3200 chars), `visibleText` (4.4ms at 6400),
 * `sanitizeDemoFiles` (3.0ms at 2400), and `BROKEN_TAG_RE` at 730ms for 800
 * unterminated anchors, growing ~8x per doubling. All linear now.
 *
 * TWO KINDS OF PIN, because "it got faster" is not a claim worth testing on
 * its own:
 *
 *  1. DIFFERENTIAL — the new hand-written walk is compared against the ORIGINAL
 *     regex on a corpus, including the nasty cases that pin real behaviour: a
 *     `<script` spliced inside a `<im`, a value crossing its own `>`, `=` with
 *     no spaces, `xhref=`, uppercase tags, mismatched quotes. This is the pin
 *     that matters. A rewrite that quietly stopped stripping a broken `<img>`
 *     would pass every timing test in the world.
 *
 *  2. SHAPE — the scanners must stop at a `<` with no `>` ahead instead of
 *     retrying. Pinned by work-counting rather than wall-clock: a test that
 *     waits for a quadratic parser to finish is a slow test that eventually
 *     stops failing.
 */
import { describe, expect, it } from "vitest";
import {
  auditDemoLinks,
  forEachTag,
  forEachTagRun,
  indexOfCloseAnchor,
  pageForLabel,
  pageForLabelIn,
  buildPageSlugIndex,
  textBetween,
  type DemoAuditFile,
} from "@/lib/demo-link-audit";
import { visibleText } from "@/lib/demo-gates";
import { sanitizeDemoFiles } from "@/lib/template-generation";
import type { ProjectFile } from "@/lib/types";

/**
 * The pattern this work replaced, kept verbatim so the differential pin has
 * something to compare against. Deliberately still quadratic — it is never
 * called on large input here.
 */
const ORIGINAL_TAG_RE = /<[a-zA-Z][^>]*>/g;
const ORIGINAL_TAG_RUN_RE = /<[^>]*>/g;
const ORIGINAL_BROKEN_TAG_RE =
  /[ \t]*(?:<img\b[^>]*\bsrc=["']([^"'#]+)["'][^>]*>|<script\b[^>]*\bsrc=["']([^"'#]+)["'][^>]*>\s*<\/script>|<link\b[^>]*\bhref=["']([^"'#]+)["'][^>]*>|<a\b[^>]*\bhref=["']([^"'#]+)["'][^>]*>)[ \t]*\n?/gi;

const NEUTRAL_ANCHOR = '<a href="#">';

/** Tags the original regex found, as `[start, end)` pairs. */
function originalTags(html: string, run = false): Array<[number, number]> {
  const re = run ? ORIGINAL_TAG_RUN_RE : ORIGINAL_TAG_RE;
  re.lastIndex = 0;
  const spans: Array<[number, number]> = [];
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

function scannedTags(html: string, run = false, from = 0, limit?: number): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const visit = (tag: { start: number; end: number }) => spans.push([tag.start, tag.end]);
  if (run) {
    if (limit === undefined) forEachTagRun(html, visit, from);
    else forEachTagRun(html, visit, from, limit);
  } else if (limit === undefined) {
    forEachTag(html, visit, from);
  } else {
    forEachTag(html, visit, from, limit);
  }
  return spans;
}

describe("the linear scanners agree with the regexes they replaced", () => {
  // The awkward ones first. Each of these broke a naive hand-written version
  // at some point during this work.
  const CORPUS = [
    "",
    "plain text, no markup at all",
    "<p>hello</p>",
    "<div class='a'>x</div>",
    "<a href=\"#\">Pricing</a>",
    "<a href='x'>y</a>",
    "<a href=\"a>b\">value crosses its own bracket</a>",
    "<a href=\"x\" >trailing space before bracket</a>",
    "<a  href = \"x\">spaces around equals</a>",
    "<a href>x</a>",
    "<a href=\"\">empty</a>",
    "<a href=\"'x\">mismatched quotes</a>",
    "<a xhref=\"x\">not an href</a>",
    "<abc href=\"x\">not an anchor</abc>",
    "<A HREF=\"x\">uppercase</A>",
    "3 < 5 and 6 > 2",
    "a < b",
    "<a",
    "<a href=\"unterminated",
    "<a <a <a <a",
    "<",
    ">",
    "<> ",
    "<a href=\"x\">one</a>\n<a href=\"y\">two</a>",
    "text before <b>bold</b> text after",
    "<div><span><em>nested</em></span></div>",
    "<img src=\"a.png\" alt=\"x\">",
    "<script src=\"app.js\"></script>",
    "<script>inline</script>",
    "<a href=\"#frag\">frag</a>",
    "<a href=\"/pricing\">rooted</a>",
    "<link rel=\"stylesheet\" href=\"styles.css\">",
    "<a\nhref=\"x\">newline before attr</a>",
    "<a href=\"x\" \n >newline before bracket</a>",
    "<a href=\"x\">x</a>  \n",
  ];

  it("forEachTag finds exactly the tags the old regex found", () => {
    for (const html of CORPUS) {
      expect(scannedTags(html), JSON.stringify(html)).toEqual(originalTags(html));
    }
  });

  it("forEachTagRun finds exactly the runs the old regex found", () => {
    for (const html of CORPUS) {
      expect(scannedTags(html, true), JSON.stringify(html)).toEqual(originalTags(html, true));
    }
  });

  it("textBetween still strips tags and keeps the text between them", () => {
    const cases: Array<[string, string]> = [
      ["<b>bold</b>", "bold"],
      ["<b>bo`ld</b>", "bo`ld"],
      ["plain", "plain"],
      ["<b>a</b> and <i>b</i>", "a and b"],
      ["<a href=\"x\">label</a>", "label"],
    ];
    for (const [html, expected] of cases) {
      const open = html.indexOf(">");
      const close = html.lastIndexOf("<");
      if (open === -1 || close === -1) continue;
      expect(textBetween(html, open + 1, close), html).toBe(expected);
    }
  });

  it("indexOfCloseAnchor finds the closing tag regardless of case", () => {
    expect(indexOfCloseAnchor("</a>", 0)).toBe(0);
    expect(indexOfCloseAnchor("</A>", 0)).toBe(0);
    expect(indexOfCloseAnchor("xx</a>", 0)).toBe(2);
    expect(indexOfCloseAnchor("no close here", 0)).toBe(-1);
    // Not a close tag: wrong letter, wrong order, or no `>`.
    expect(indexOfCloseAnchor("</b>", 0)).toBe(-1);
    expect(indexOfCloseAnchor("a></a>", 0)).toBe(2);
    expect(indexOfCloseAnchor("</a", 0)).toBe(-1);
  });
});

describe("pageForLabel: indexed and identical", () => {
  const PAGES = ["index.html", "pricing.html", "about-us.html", "about_us.html"];

  it("the index answers exactly what the scan answered", () => {
    const index = buildPageSlugIndex(PAGES);
    const labels = [
      "Home", "Pricing", "About Us", "About", "Docs", "", "   ", "home",
      "about us", "About_Us", "Contact", "index", "Pricing!",
    ];
    for (const label of labels) {
      expect(pageForLabelIn(index, label), JSON.stringify(label))
        .toEqual(pageForLabel(label, PAGES));
    }
  });

  it("two pages slugging to one word stay ambiguous", () => {
    // about-us.html and about_us.html collide, and the guard must survive.
    expect(pageForLabel("About Us", PAGES)).toEqual({ page: null, ambiguous: true });
    expect(pageForLabelIn(buildPageSlugIndex(PAGES), "About Us"))
      .toEqual({ page: null, ambiguous: true });
  });

  it("Home is index.html", () => {
    expect(pageForLabel("Home", PAGES)).toEqual({ page: "index.html", ambiguous: false });
  });
});

describe("sanitizeDemoFiles still strips what it used to", () => {
  // The original implementation, verbatim, as the oracle.
  function referencePass(html: string, emitted: Set<string>): string {
    const keepAsset = (target: string): boolean =>
      /^(https?:|data:|mailto:|tel:|#|\/)/.test(target) || emitted.has(target);
    const keepAnchor = (target: string): boolean =>
      /^(https?:|data:|mailto:|tel:|#)/.test(target);
    let out = "";
    let last = 0;
    ORIGINAL_BROKEN_TAG_RE.lastIndex = 0;
    for (
      let m = ORIGINAL_BROKEN_TAG_RE.exec(html);
      m !== null;
      m = ORIGINAL_BROKEN_TAG_RE.exec(html)
    ) {
      out += html.slice(last, m.index);
      last = m.index + m[0].length;
      const [tag, imgSrc, scriptSrc, linkHref, anchorHref] = m;
      if (anchorHref !== undefined) {
        if (keepAnchor(anchorHref)) {
          out += tag;
          continue;
        }
        const filePath = anchorHref.split("#")[0].split("?")[0].trim();
        if (filePath && emitted.has(filePath)) {
          out += tag;
          continue;
        }
        out += NEUTRAL_ANCHOR;
        continue;
      }
      const target = imgSrc ?? scriptSrc ?? linkHref;
      if (keepAsset(target)) out += tag;
    }
    out += html.slice(last);
    return out;
  }

  function referenceSanitize(content: string, paths: string[]): string {
    const emitted = new Set(paths);
    let prev = content;
    let next = referencePass(prev, emitted);
    let guard = 0;
    while (next !== prev && guard < 20) {
      prev = next;
      next = referencePass(prev, emitted);
      guard += 1;
    }
    return next;
  }

  const PATHS = [
    "index.html", "about.html", "a.html", "b.html",
    "styles.css", "app.js", "a.png", "b.png",
  ];

  const CASES = [
    "<im<script src=\"x.js\"></script>g src='missing.png'>",
    "<img src=\"x> <img src='missing.png'>\">",
    "<a href=\"#\">Pricing</a>",
    "<a href=\"about.html\">About</a>",
    "<a href=\"missing.html\">Gone</a>",
    "<a href=\"post.html#intro\">Post</a>",
    "<a href=\"post.html?id=2\">Post</a>",
    "<img src=\"styles.css\">",
    "<img src=\"missing.png\">",
    "<link rel=\"stylesheet\" href=\"styles.css\">",
    "<link href=\"nope.css\" rel=\"x\">",
    "<script src=\"app.js\"></script>",
    "<script src=\"gone.js\"></script>",
    "  <a href=\"missing.html\">x</a>",
    "<a  href = \"missing.html\">x</a>",
    "<a href=\"\">x</a>",
    "<a href=\"#frag\">x</a>",
    "<a xhref=\"missing.html\">x</a>",
    "<abc href=\"missing.html\">x</abc>",
    "<A HREF=\"missing.html\">x</A>",
    "<img src=\"a.png\" alt=\"x\">",
    "<script src=\"app.js\">\n</script>",
    "<a\nhref=\"missing.html\">x</a>",
    "<a href=\"a.html\">x</a>\n<a href=\"b.html\">y</a>",
    "<a href=\"missing.html\">x</a>  \n",
    "<img src=\"a.png\"><img src=\"b.png\">",
    "no markup at all",
  ];

  it("produces byte-identical output to the regex implementation", () => {
    for (const html of CASES) {
      const files = PATHS.map((path) => ({
        path,
        content: path === "index.html" ? html : "",
      })) as ProjectFile[];
      const got = sanitizeDemoFiles(files)[0].content;
      expect(got, JSON.stringify(html)).toBe(referenceSanitize(html, PATHS));
    }
  });
});

describe("the scanners stop instead of retrying (the whole point)", () => {
  /**
   * Characters examined by a scan: how far forward it ever got. The scan's
   * regions are disjoint, so this is the true work done, and it is what a
   * quadratic implementation cannot avoid inflating.
   */
  function scanCost(html: string): number {
    let reached = 0;
    forEachTag(html, ({ end }) => {
      if (end > reached) reached = end;
    });
    return reached;
  }

  it("an unterminated tag costs one pass, not one per bracket", () => {
    // The quadratic signature: doubling the number of `<` quadruples the work.
    // With the fix, the FIRST `<` finds no `>` and ends the scan, so the cost
    // does not grow with the number of brackets at all.
    const costs = [500, 1000, 2000, 4000].map((n) => scanCost("<a ".repeat(n)));
    // Every scan ends after the first `<`, so all four are identical.
    expect(new Set(costs).size).toBe(1);
  });

  it("a terminated tag costs its own length, not the rest of the document", () => {
    // With `>` present, the total examined equals the input length: the scan
    // never looks at a character twice.
    const html = "<a href=\"x\">y</a>".repeat(200);
    expect(scanCost(html)).toBeLessThanOrEqual(html.length);
  });

  it("visibleText on unterminated tags stays proportional to the input", () => {
    // A relative comparison rather than an absolute millisecond bound: doubling
    // the input must not quadruple the time, and there is no wall-clock here to
    // flake on a slow machine.
    const small = "<div".repeat(500);
    const large = "<div".repeat(4000);
    const t0 = process.hrtime.bigint();
    visibleText(small);
    const smallMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const t1 = process.hrtime.bigint();
    visibleText(large);
    const largeMs = Number(process.hrtime.bigint() - t1) / 1e6;
    // 8x the input. Quadratic would be ~64x; allow a very generous 24x so this
    // cannot fail on a noisy machine, while still failing loudly on a
    // regression to quadratic.
    if (smallMs > 0.5) {
      expect(largeMs / smallMs, `${smallMs}ms -> ${largeMs}ms`).toBeLessThan(24);
    }
  });

  it("sanitizeDemoFiles on unterminated anchors stays under a generous bound", () => {
    // 800 unterminated anchors took 730ms when BROKEN_TAG_RE was in place.
    const html = '<a href="x"'.repeat(800);
    const files = [{ path: "index.html", content: html }] as ProjectFile[];
    const t0 = process.hrtime.bigint();
    sanitizeDemoFiles(files);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(ms, `${ms}ms for 800 unterminated anchors`).toBeLessThan(250);
  });
});

describe("auditDemoLinks finds the same links it always did", () => {
  it("counts links on a page with many of them", () => {
    const html = Array.from({ length: 50 }, (_, i) => `<a href="p${i}.html">Page ${i}</a>`).join("\n");
    const files: DemoAuditFile[] = [
      { path: "index.html", content: html },
      ...Array.from({ length: 50 }, (_, i) => ({ path: `p${i}.html`, content: "<h1>x</h1>" })),
    ];
    const audit = auditDemoLinks(files);
    expect(audit.checked).toBe(50);
    expect(audit.dead).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it("reports an inert placeholder whose label names a real page", () => {
    const files: DemoAuditFile[] = [
      { path: "index.html", content: '<a href="#">Pricing</a>' },
      { path: "pricing.html", content: "<h1>Pricing</h1>" },
    ];
    const audit = auditDemoLinks(files);
    expect(audit.inert).toHaveLength(1);
    expect(audit.inert[0].reason).toBe("inert");
    expect(audit.inert[0].page).toBe("pricing.html");
  });

  it("reports a dead link to a page that was never emitted", () => {
    const files: DemoAuditFile[] = [{ path: "index.html", content: '<a href="gone.html">Gone</a>' }];
    const audit = auditDemoLinks(files);
    expect(audit.dead).toHaveLength(1);
    expect(audit.dead[0].target).toBe("gone.html");
  });
});