import { describe, expect, it } from "vitest";
import {
  fillerHits,
  formatGateProblem,
  formatGateResult,
  missingBriefFiles,
  runDemoGates,
  selectorProblems,
  visibleText,
  type GateFile,
} from "@/lib/demo-gates";
import { TEMPLATES } from "@/lib/templates";

function f(path: string, content: string): GateFile {
  return { path, content };
}

const brief = (id: string) => {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error("no such template");
  return t.brief;
};

describe("plan gate: the brief is the file plan", () => {
  // The real blog defect: a three-page brief shipped as one page, so the post
  // grid was three href="#" links and the page held 145 characters of text.
  it("catches the blog demo that emitted one of its three named files", () => {
    const files = [
      f("index.html", "<html><body>blog</body></html>"),
      f("styles.css", "body{}"),
      f("app.js", ""),
    ];
    expect(missingBriefFiles(brief("blog"), files)).toEqual([
      "about.html",
      "post.html",
      "posts.js",
    ]);
  });

  it("passes a demo that emitted every file the brief names", () => {
    const files = [
      f("index.html", "<html><body>b</body></html>"),
      f("post.html", "<html><body>p</body></html>"),
      f("about.html", "<html><body>a</body></html>"),
      f("posts.js", "const posts=[];"),
    ];
    expect(missingBriefFiles(brief("blog"), files)).toEqual([]);
  });

  it("stays silent for the four briefs that name no files at all", () => {
    for (const id of ["landing", "portfolio", "restaurant", "event"]) {
      expect(missingBriefFiles(brief(id), [f("index.html", "<html></html>")])).toEqual([]);
    }
  });
});

describe("filler gate: literal placeholder copy", () => {
  // The real saas / portfolio / event defect, verbatim.
  it("catches numbered placeholder nouns", () => {
    const files = [
      f(
        "index.html",
        "<html><body><h2>Key Features</h2><ul><li>Feature 1</li><li>Feature 2</li></ul>" +
          "<p>Integration 3</p></body></html>",
      ),
    ];
    expect(fillerHits(files)).toEqual([
      "Feature 1",
      "Feature 2",
      "Integration 3",
    ]);
  });

  it("catches the portfolio and event filler", () => {
    expect(fillerHits([f("index.html", "<p>Project 1 Project 6</p>")])).toEqual([
      "Project 1",
      "Project 6",
    ]);
    expect(fillerHits([f("index.html", "<p>Sponsor 1 Sponsor 2</p>")])).toEqual([
      "Sponsor 1",
      "Sponsor 2",
    ]);
  });

  // The list is deliberately tight: these read as broken only in the
  // numbered-placeholder sense, and the words are absent on purpose.
  it("leaves real numbered copy alone", () => {
    const real = [
      "<p>Tier 1 — Solo, $9/mo. Tier 2 — Team, $29/mo. Tier 3 — Business, $99/mo.</p>",
      "<h3>Step 1: sign up. Step 2: import. Step 3: ship.</h3>",
      "<li>Chapter 4</li>",
      "<p>Our 2023 revenue grew 40%.</p>",
    ];
    expect(fillerHits([f("index.html", `<html><body>${real.join("")}</body></html>`)])).toEqual([]);
  });

  // The landing demo has a section simply headed "Integration". Thin, but
  // real copy — and it is the one demo that earns its place in the gallery,
  // so a rule that flagged it would have been wrong.
  it("leaves a bare domain noun alone — the digit is what makes it filler", () => {
    expect(
      fillerHits([
        f("index.html", "<h2>Integration</h2><h2>Project</h2><h2>Features</h2>"),
      ]),
    ).toEqual([]);
  });

  it("catches lorem ipsum and 'your text here'", () => {
    expect(
      fillerHits([f("index.html", "<p>Lorem ipsum dolor sit amet</p><p>your text here</p>")]),
    ).toEqual(["Lorem ipsum", "your text here"]);
  });

  it("fuses nothing when tags are removed", () => {
    // The bug this pins: dropping "</li><li>" with nothing in between made
    // "Features"+"Feature 1" into "FeaturesFeature", and no word-boundary
    // regex can see filler in a document made entirely of filler.
    expect(visibleText("<h2>Features</h2><ul><li>Feature 1</li><li>Feature 2</li></ul>")).toBe(
      "Features Feature 1 Feature 2",
    );
  });

  // A banned word inside a script or style is not visible copy, and the
  // suffix itself uses the word "Feature 1" as an example — which is exactly
  // why the extraction has to skip those bodies.
  it("does not read script or style bodies as visible copy", () => {
    const files = [
      f(
        "index.html",
        '<html><head><style>.feature-1{color:red}</style></head><body>' +
          '<script>// Feature 1 goes here\nconst x="Project 2";</script>' +
          "<p>Real copy about a fleet of trucks.</p></body></html>",
      ),
    ];
    expect(fillerHits(files)).toEqual([]);
  });
});

describe("visibleText", () => {
  it("drops tags and collapses whitespace", () => {
    expect(visibleText("<h1>Hi</h1>\n\n  <p>there</p>")).toBe("Hi there");
  });
});

describe("selector gate: the demo's JS must run against the demo's own HTML", () => {
  // The real saas defect, reduced to its shape: one app.js linked from every
  // page, selecting per-page elements with no guard.
  const appJs = `document.addEventListener('DOMContentLoaded', () => {
    const pricingTable = document.querySelector('#pricingTable');
    const contactForm = document.querySelector('#contactForm');
    pricingTable.style.display = 'none';
    contactForm.addEventListener('submit', () => {});
});`;

  it("catches an unguarded id the linking page does not have", () => {
    const files = [
      f("index.html", '<html><body><div id="contactForm"></div><script src="app.js"></script></body></html>'),
      f("app.js", appJs),
    ];
    const problems = selectorProblems(files);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("#pricingTable");
    expect(problems[0]).toContain("index.html");
  });

  it("catches it on every page that links the script", () => {
    const files = [
      f("index.html", '<html><body><div id="pricingTable"></div><div id="contactForm"></div><script src="app.js"></script></body></html>'),
      f("about.html", '<html><body><p>nothing here</p><script src="app.js"></script></body></html>'),
      f("app.js", appJs),
    ];
    const problems = selectorProblems(files);
    // index.html has both ids, so only about.html reports — and it reports
    // both, which is the point: one page links a script written for another.
    expect(problems).toHaveLength(2);
    expect(problems.every((p) => p.includes("about.html"))).toBe(true);
  });

  it("accepts the guarded form the suffix now asks for", () => {
    const guarded = `document.addEventListener('DOMContentLoaded', () => {
    const pricingTable = document.querySelector('#pricingTable');
    if (!pricingTable) return;
    const contactForm = document.querySelector('#contactForm');
    contactForm?.addEventListener('submit', () => {});
});`;
    const files = [
      f("index.html", '<html><body><p>nothing</p><script src="app.js"></script></body></html>'),
      f("app.js", guarded),
    ];
    expect(selectorProblems(files)).toEqual([]);
  });

  it("accepts querySelectorAll, which returns an empty list rather than null", () => {
    const files = [
      f("index.html", '<html><body><p>nothing</p><script src="app.js"></script></body></html>'),
      f("app.js", "const items = document.querySelectorAll('.card');\nitems.forEach(i => {});"),
    ];
    expect(selectorProblems(files)).toEqual([]);
  });

  it("ignores a script no page links, and a link to a missing script", () => {
    const files = [
      f("index.html", "<html><body><p>x</p></body></html>"),
      f("app.js", "const a = document.querySelector('#nope');\na.click();"),
      f("other.html", '<html><body><script src="gone.js"></script></body></html>'),
    ];
    expect(selectorProblems(files)).toEqual([]);
  });
});

describe("runDemoGates", () => {
  it("fails the shipped blog shape with all three kinds named", () => {
    const gates = runDemoGates(brief("blog"), [
      f("index.html", '<html><body><a href="#">Featured Post</a></body></html>'),
    ]);
    expect(gates.ok).toBe(false);
    const kinds = new Set(gates.problems.map((p) => p.kind));
    expect(kinds).toEqual(new Set(["plan"]));
    expect(formatGateResult(gates)).toContain("post.html");
  });

  it("passes a well-formed demo", () => {
    const gates = runDemoGates(brief("saas"), [
      f(
        "index.html",
        "<html><body><h1>Northwind</h1><p>We ship warehouse software.</p>" +
          '<div id="pricingTable"></div><div id="togglePricing"></div>' +
          '<script src="app.js"></script></body></html>',
      ),
      f(
        "pricing.html",
        '<html><body><h2>Compare plans</h2><div id="pricingTable"></div>' +
          '<div id="togglePricing"></div><script src="app.js"></script></body></html>',
      ),
      f(
        "about.html",
        '<html><body><h2>About us</h2><p>Founded in Portland.</p><script src="app.js"></script></body></html>',
      ),
      f(
        "contact.html",
        '<html><body><form id="contactForm"></form><div id="messageSent"></div>' +
          '<script src="app.js"></script></body></html>',
      ),
      f(
        "app.js",
        "const t = document.querySelector('#pricingTable');\nif (!t) return;\n" +
          "const f2 = document.querySelector('#contactForm');\nif (!f2) return;",
      ),
      f("styles.css", "body{color:#111}"),
    ]);
    expect(formatGateResult(gates)).toBe("");
    expect(gates.ok).toBe(true);
  });

  it("formats one problem per clause", () => {
    expect(formatGateProblem({ kind: "filler", detail: 'placeholder copy "Feature 1"' })).toBe(
      'filler: placeholder copy "Feature 1"',
    );
  });
});
