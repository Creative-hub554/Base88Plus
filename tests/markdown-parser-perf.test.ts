/**
 * Pins that the Markdown parser is LINEAR in the length of the reply.
 *
 * This is not a micro-optimisation. The builder re-parses the whole streaming
 * buffer on every token, so a reply of length n is parsed n times over: a
 * quadratic parser turns a long answer into a frozen tab. Both hot spots
 * below were found by measurement, not by reading the code, and both are the
 * same mistake — asking a question whose answer costs O(remaining) and asking
 * it once per character:
 *
 *   1. An unmatched `[` scanned to the end of the message looking for a `]`,
 *      and every further `[` did it again. `"[a".repeat(n)` was O(n^2):
 *      27ms at 3200 characters. `makeCloserFinder` now remembers that a
 *      closer does not exist, which is sound because the scan is
 *      position-independent.
 *
 *   2. `isAutolink` took the whole remainder of the message and lowercased
 *      all of it to test three prefixes, at every `(`-preceded position.
 *      `"[a(".repeat(n)` was O(n^2) and far worse: 592ms at 76800
 *      characters. It is now three bounded checks.
 *
 * The time bounds below are deliberately loose — around 40x the measured
 * linear cost — because a test that fails on a slow CI machine is worse than
 * no test. They are still far below the quadratic cost they guard against,
 * so a regression fails loudly instead of drifting.
 *
 * Correctness pins come first and matter more: a memo that returns a stale
 * answer is a parser that silently drops links, which no timing test would
 * catch.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, type Inline } from "@/lib/markdown";

/** Wall-clock milliseconds for one parse. Generous bounds, see the header. */
function parseMs(source: string): number {
  const start = process.hrtime.bigint();
  parseMarkdown(source);
  return Number(process.hrtime.bigint() - start) / 1e6;
}

/** Every link href anywhere in a tree. */
function hrefs(nodes: Inline[]): string[] {
  const found: string[] = [];
  for (const node of nodes) {
    if (node.kind === "link") found.push(node.href);
    const withChildren = node as { children?: Inline[] };
    if (withChildren.children) found.push(...hrefs(withChildren.children));
  }
  return found;
}

function kinds(nodes: Inline[]): string[] {
  return nodes.map((node) => node.kind);
}

describe("the closer memo is correct, not just fast", () => {
  it("an unmatched bracket stays literal text, all of it", () => {
    // The adversarial input from the timing pins, checked for MEANING: every
    // character must survive as text. A memo that skipped past a bracket, or
    // dropped the run, would still be fast.
    const source = "[a".repeat(500);
    const nodes = parseInline(source);
    expect(kinds(nodes)).toEqual(["text"]);
    expect(nodes[0]).toEqual({ kind: "text", value: source });
  });

  it("still finds the closer when one exists later in the string", () => {
    // The memo is only ever written on a FAILED scan, and a failed scan
    // means the closer is absent from that point to the end — so a `]`
    // further right can never be missed. Pin it anyway: an "optimisation"
    // that memoised a successful hit as well would break exactly here.
    const nodes = parseInline("[unclosed [good](https://example.com)");
    expect(hrefs(nodes)).toEqual(["https://example.com"]);
  });

  it("does not let one delimiter's failure poison another's lookup", () => {
    // `*` has no partner in this string, so the `*` scan fails and is
    // remembered. The `]` that follows must still be found — which it only
    // is if the memo is keyed per closer character. A single shared slot
    // would report "no closer" for `]` too and silently drop the link.
    const nodes = parseInline("*[a](https://example.com)");
    expect(hrefs(nodes)).toEqual(["https://example.com"]);
    expect(kinds(nodes)).toContain("text");
  });

  it("keys the memo per string, not across the recursive slices", () => {
    // `parseInline` recurses on slices of its input. If a memo built for the
    // parent leaked into a child, the child would answer questions about
    // indices that mean nothing in its own string.
    const nodes = parseInline("**[a](https://example.com)**");
    expect(hrefs(nodes)).toEqual(["https://example.com"]);
    expect(kinds(nodes)).toEqual(["strong"]);
  });

  it("an unsafe href still degrades to text, brackets and all", () => {
    // The memo must not change what `safeUrl` decides.
    const nodes = parseInline("[click](javascript:alert(1))");
    expect(hrefs(nodes)).toEqual([]);
    expect(nodes.map((node) => (node.kind === "text" ? node.value : node.kind)))
      .toEqual(["[click](javascript:alert(1))"]);
  });
});

describe("the autolink check does not scan the rest of the message", () => {
  it("still autolinks every allowed scheme", () => {
    // `isAutolink` gates on the first character being `h` or `m` before it
    // does any work. If a scheme were added to ALLOWED_LINK_SCHEMES without
    // widening that gate, it would stop being recognised — and the pin that
    // matters here is that all three CURRENT schemes still work.
    const cases = [
      ["see https://example.com now", "https://example.com"],
      ["see http://example.com now", "http://example.com"],
      ["write to mailto:someone@example.com please", "mailto:someone@example.com"],
    ] as const;
    for (const [source, expected] of cases) {
      expect(hrefs(parseInline(source)), source).toEqual([expected]);
    }
  });

  it("does not autolink a scheme outside the allowlist", () => {
    // The gate is the allowlist, expressed as a first character. `f` is not
    // h or m, so this is rejected before any scanning happens.
    for (const source of ["ftp://example.com", "tel:+15551234", "x://example.com"]) {
      expect(hrefs(parseInline(source)), source).toEqual([]);
    }
  });

  it("requires a dot in the authority", () => {
    expect(hrefs(parseInline("http://localhost"))).toEqual([]);
    expect(hrefs(parseInline("http://example.com"))).toEqual(["http://example.com"]);
  });

  it("a dot past the host bound is not a host", () => {
    // The documented trade-off of bounding the authority scan at MAX_HOST_SCAN
    // (253, the DNS name limit): a "host" longer than any real one is not
    // treated as a link. Pinned so the bound cannot be widened by accident.
    const deep = `http://${"a".repeat(300)}.com`;
    expect(hrefs(parseInline(deep))).toEqual([]);
    const withinBound = `http://${"a".repeat(200)}.com`;
    expect(hrefs(parseInline(withinBound))).toEqual([withinBound]);
  });

  it("stops the authority scan at the first /, ? or #", () => {
    // The dot has to be inside the authority. A dot in the path does not make
    // `http://localhost/a.b` a link.
    expect(hrefs(parseInline("http://localhost/a.b"))).toEqual([]);
  });

  it("trims a parenthetical closing paren off a bare URL", () => {
    const nodes = parseInline("(see https://example.com)");
    expect(hrefs(nodes)).toEqual(["https://example.com"]);
  });

  it("leaves parenthesised prose as text", () => {
    // The shape that used to be quadratic: many `(`-preceded positions, none
    // of them a URL. Each one is now rejected on its first character.
    const nodes = parseInline("(a) (b) (c) (d)");
    expect(hrefs(nodes)).toEqual([]);
    expect(kinds(nodes)).toEqual(["text"]);
  });
});

describe("parsing cost grows linearly, not quadratically", () => {
  it("many unmatched open brackets", () => {
    // 25600 characters. Quadratic cost extrapolates from the measured 27ms
    // at 3200 characters to roughly 1.7s here; linear costs ~2ms.
    const source = "[a".repeat(12800);
    expect(parseMs(source)).toBeLessThan(400);
  });

  it("many open brackets and parens", () => {
    // 153600 characters, and the worse of the two hot spots: quadratic cost
    // extrapolates from the measured 592ms at 76800 to ~2.4s here, linear
    // costs ~10ms.
    const source = "[a(".repeat(51200);
    expect(parseMs(source)).toBeLessThan(400);
  });

  it("a bracket closed only at the very end", () => {
    // The other shape of the same scan: the closer EXISTS, so the negative
    // memo never fires and every `[` finds it again. Still linear, because a
    // hit is a hit rather than a walk to the end.
    const source = `${"[a".repeat(12800)}](https://example.com)`;
    expect(parseMs(source)).toBeLessThan(400);
  });

  it("a realistic long reply", () => {
    const parts: string[] = ["## What I changed\n\n"];
    for (let i = 0; i < 400; i += 1) {
      parts.push(`Paragraph ${i} describing **index.html** and the *hero* section.`);
      parts.push(`- item ${i} with \`code()\` and a [link](https://example.com/${i})`);
      parts.push("\n");
      if (i % 5 === 0) parts.push("```html\n<section>...</section>\n```\n");
    }
    // ~54000 characters, measured at 5ms.
    expect(parseMs(parts.join("\n"))).toBeLessThan(400);
  });
});

describe("the source cannot drift back to whole-remainder scanning", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/lib/markdown.ts"),
    "utf8",
  );

  it("never slices from a scan position to the end of the string", () => {
    // The exact expression both fixes removed. A slice to the end of the
    // message inside a per-character loop is the whole bug, so pin the
    // expression rather than the timing.
    expect(source).not.toContain("slice(at)");
    expect(source).not.toContain("isAutolink(text.slice");
  });

  it("keeps the autolink first-character gate in step with the scheme list", () => {
    // Structural pin: every scheme in ALLOWED_LINK_SCHEMES must begin with a
    // character the gate accepts, or that scheme silently stops working.
    const list = /const ALLOWED_LINK_SCHEMES = \[([^\]]*)\]/.exec(source);
    expect(list, "could not read ALLOWED_LINK_SCHEMES").not.toBeNull();
    const schemes = (list as RegExpExecArray)[1]
      .split(",")
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
      .filter((entry) => entry.length > 0);
    expect(schemes.length).toBeGreaterThan(0);
    for (const scheme of schemes) {
      const first = scheme[0].toLowerCase();
      expect(["h", "m"], `${scheme} starts with ${first}`).toContain(first);
    }
  });
});
