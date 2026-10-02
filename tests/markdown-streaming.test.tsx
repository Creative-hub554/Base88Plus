/**
 * Pins for streaming an assistant reply without re-parsing the whole buffer.
 *
 * The builder re-renders the chat panel on every token, and every assistant
 * message in it, so a reply of length n was being parsed n times: measured at
 * ~415ms of main-thread work for a 27000-character answer, which is why long
 * replies used to freeze the tab. The parser is now resumable, and these pins
 * hold the thing that makes that safe.
 *
 * THE CONTRACT IS WORTH THE WHOLE FILE: `createStreamingMarkdownParser().parse`
 * returns exactly what `parseMarkdown` returns, for every intermediate state of
 * every stream. None of the speed comes from returning something different, so
 * the dominant pin is that one — asserted over EVERY prefix of a corpus of
 * awkward replies, not a handful of samples.
 *
 * The awkward cases are not hypothetical. Two of them are bugs this
 * implementation actually had:
 *
 *   - `1. a\n\n2.` parses `2.` as a paragraph. One character later `2. ` is a
 *     list marker, and a list marker merges BACKWARDS into the list before it,
 *     so a block that was final a moment ago stopped being final. The naive
 *     "keep every block but the last" rule is wrong because of this.
 *
 *   - A blank line does not end a list when the next line is another bullet, so
 *     a blank line is not automatically a boundary — and while that bullet is
 *     still arriving, nothing on screen can tell you yet.
 *
 * Counting rather than timing is deliberate for the performance pins. A test
 * that waits for a quadratic parser to finish is a slow test that eventually
 * stops failing, and a test with a generous wall-clock bound passes on a fast
 * machine and fails on a slow one for no reason.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownMessage } from "@/components/markdown-message";
import {
  createStreamingMarkdownParser,
  parseMarkdown,
  safeLineCount,
  type Block,
} from "@/lib/markdown";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

/** Compact, comparable form of a block tree. */
function shape(nodes: Block[]): string {
  return JSON.stringify(nodes);
}

/**
 * Replies chosen for the ways a stream can contradict an earlier parse: lists
 * that continue across blank lines, list markers arriving one character at a
 * time, fences containing blank lines, unclosed fences, indented lazy
 * continuations, CRLF, and consecutive blank lines.
 */
const AWKWARD = [
  "- a\n\n- b\n\n- c",
  "1. a\n\n2. b\n\n3. c",
  "1. a\n\n2. b\n\ntail",
  "- a\n\n\n- b",
  "- a\n\n  \n\n- b",
  "1. a\n  cont\n\n2. b\n  cont\n\ntail",
  "```\na\n\nb\n```",
  "```html\n<section>\n\n</section>\n```\n\nafter",
  "```\nunclosed\n\nmore\n\nand more",
  "para\n\n```\n\n```\n\ntail",
  "para\n\n``\n\ntail",
  "# H\n\npara\n\n> quote\n\n- x\n- y\n\n```\ncode\n```\n\nend",
  "> quoted\n> more\n\nafter",
  "para one\npara two\n\n- item\n  lazy continuation\n\nnext para",
  "text\n\n    indented",
  "a\r\n\r\n- b",
  "~~~\ncode\n\n~~~\n\ntail",
  "*a\n\n[b](https://x.com)\n\nend",
  "- a\n\n> quote\n\n- b",
  "#head\n\ntext",
  "## H\n\n- 1. a\n- 2. b\n\n1. x\n\n2. y",
  "> - a\n> - b\n\nafter",
];

describe("streaming parse is identical to a full parse", () => {
  it("matches at EVERY prefix of every awkward reply", () => {
    const failures: string[] = [];
    for (const source of AWKWARD) {
      const parser = createStreamingMarkdownParser();
      for (let n = 1; n <= source.length; n += 1) {
        const prefix = source.slice(0, n);
        if (shape(parser.parse(prefix)) !== shape(parseMarkdown(prefix))) {
          failures.push(`${JSON.stringify(source)} truncated at ${n}: ${JSON.stringify(prefix)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("a list marker that arrives one character late still joins its list", () => {
    // The backwards merge. At `2.` the reply has a paragraph; at `2. ` it has a
    // single ordered list of two items. A cache that trusted the earlier parse
    // would leave two separate <ol>s, the second numbered from 1 again.
    const parser = createStreamingMarkdownParser();
    const steps = ["1. a\n\n2.", "1. a\n\n2. ", "1. a\n\n2. b"];
    for (const step of steps) {
      expect(shape(parser.parse(step)), step).toBe(shape(parseMarkdown(step)));
    }
    const blocks = parseMarkdown("1. a\n\n2. b");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("list");
  });

  it("a bullet split across tokens does not become a list mid-stream", () => {
    const parser = createStreamingMarkdownParser();
    for (const step of ["-", "- ", "- a", "- a\n", "- a\n-", "- a\n- "]) {
      expect(shape(parser.parse(step)), step).toBe(shape(parseMarkdown(step)));
    }
  });

  it("a blank line does not split a list when a bullet follows", () => {
    const parser = createStreamingMarkdownParser();
    for (const step of ["- a\n", "- a\n\n", "- a\n\n-", "- a\n\n- ", "- a\n\n- b"]) {
      expect(shape(parser.parse(step)), step).toBe(shape(parseMarkdown(step)));
    }
    const blocks = parseMarkdown("- a\n\n- b");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("list");
  });
});

describe("safeLineCount only vouches for what cannot change", () => {
  it("is zero while the buffer has no blank line", () => {
    expect(safeLineCount("para one\npara two")).toBe(0);
  });

  it("does not claim a boundary behind an unsettled line", () => {
    // The last line has no newline after it yet, so it can still turn into a
    // bullet and merge backwards. No boundary may be reported.
    expect(safeLineCount("para one\n\npara tw")).toBe(0);
  });

  it("does not claim a boundary in front of a bullet", () => {
    expect(safeLineCount("- a\n\n- b\n")).toBe(0);
  });

  it("claims the boundary once the following line is settled and not a bullet", () => {
    expect(safeLineCount("para one\n\npara two\n")).toBe(2);
  });

  it("ignores blank lines inside a fence", () => {
    // Lines 0..4 are the fence; the blank inside it is not a boundary, but the
    // one after the closing fence is.
    expect(safeLineCount("```\na\n\nb\n```\n\ntail\n")).toBe(6);
  });

  it("only ever grows as text is appended", () => {
    const source = "# H\n\n- a\n\n1. x\n\n```\nf\n```\n\ntail\nmore\n";
    let previous = 0;
    for (let n = 1; n <= source.length; n += 1) {
      const current = safeLineCount(source.slice(0, n));
      expect(current, `shrank at ${n}`).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
    expect(previous).toBeGreaterThan(0);
  });
});

describe("the streaming parser does the work once", () => {
  /** A reply shaped like the ones the builder actually receives. */
  function realistic(n: number): string {
    const parts: string[] = ["## What I changed\n\n"];
    for (let i = 0; i < n; i += 1) {
      parts.push(`Paragraph ${i} describing **index.html** and the *hero* section.`);
      parts.push(`- item ${i} with \`code()\` and a [link](https://example.com/${i})`);
      parts.push("\n");
      if (i % 5 === 0) parts.push("```html\n<section>...</section>\n```\n");
    }
    return parts.join("\n");
  }

  it("parses a token at a time without re-reading the whole reply", () => {
    const full = realistic(200);
    const parser = createStreamingMarkdownParser();
    const step = Math.max(1, Math.floor(full.length / 400));
    let compared = 0;
    for (let end = step; end <= full.length; end += step) {
      expect(shape(parser.parse(full.slice(0, end)))).toBe(shape(parseMarkdown(full.slice(0, end))));
      compared += 1;
    }
    const stats = parser.stats();
    expect(compared).toBeGreaterThan(300);
    expect(stats.resets).toBe(0);
    // Re-parsing everything would be ~200x the reply length across the stream.
    // Linear is a small multiple of it. Generous, but far below quadratic.
    expect(stats.charsParsed).toBeLessThan(full.length * 10);
    expect(stats.committedBlocks).toBeGreaterThan(100);
  });

  it("keeps the work proportional to the tail, not the buffer", () => {
    // Two streams of the same shape, one twice the length: the long one must
    // not cost four times as much, which is the quadratic signature.
    const measure = (n: number) => {
      const full = realistic(n);
      const parser = createStreamingMarkdownParser();
      const step = Math.max(1, Math.floor(full.length / 400));
      for (let end = step; end <= full.length; end += step) {
        parser.parse(full.slice(0, end));
      }
      return { length: full.length, chars: parser.stats().charsParsed };
    };
    const short = measure(50);
    const long = measure(200);
    const lengthRatio = long.length / short.length;
    const workRatio = long.chars / short.chars;
    expect(lengthRatio).toBeGreaterThan(3);
    // Linear would be ~4x; quadratic would be ~16x. 8x separates them while
    // leaving room for a noisy short sample.
    expect(workRatio).toBeLessThan(lengthRatio * 2);
  });

  it("hands back the identical array for unchanged text", () => {
    // Every other bubble in the panel re-renders while one is streaming, and
    // none of them should re-parse. Measured by identity, not by a counter.
    const parser = createStreamingMarkdownParser();
    const first = parser.parse("## H\n\nbody\n\ntail");
    expect(parser.parse("## H\n\nbody\n\ntail")).toBe(first);
  });

  it("reuses settled blocks, which is what lets the renderer skip them", () => {
    // This identity IS the React.memo contract: a block committed by one call
    // must be the same object in the next, or every settled paragraph
    // re-renders on every token and the parsing win buys nothing.
    const source = "para one\n\npara two\n\npara three\n\npara four\n\ntail line";
    const parser = createStreamingMarkdownParser();
    const first = parser.parse(source);
    const committed = parser.stats().committedBlocks;
    const second = parser.parse(`${source}\n\npara five\n`);
    expect(committed).toBeGreaterThan(1);
    for (let i = 0; i < committed; i += 1) {
      expect(second[i], `block ${i} was re-parsed`).toBe(first[i]);
    }
    expect(second.length).toBe(first.length + 1);
  });

  it("throws the cache away when handed text that is not a continuation", () => {
    // A retry, or a message swapped underneath a mounted bubble. The cache
    // describes a buffer that no longer exists, so it must not be trusted.
    const parser = createStreamingMarkdownParser();
    const grown = parser.parse("## H\n\none\n\ntwo\n\nthree\n\nfour\n\nfive");
    expect(parser.stats().committedBlocks).toBeGreaterThan(0);
    const unrelated = "totally different\n\nreply";
    expect(shape(parser.parse(unrelated))).toBe(shape(parseMarkdown(unrelated)));
    expect(parser.stats().resets).toBe(1);
    expect(grown.length).toBeGreaterThan(0);
  });
});

describe("the rendered DOM does not depend on how the text arrived", () => {
  it("a streamed reply renders exactly like the finished one", () => {
    const full =
      "## What changed\n\nI rewrote the **hero** and added a [link](https://example.com).\n\n" +
      "- first item\n- second item\n\n```html\n<section>hi</section>\n```\n\nDone.";

    // Render the finished reply on its own.
    const finished = render(<MarkdownMessage text={full} />);
    const expected = finished.container.innerHTML;
    finished.unmount();

    // Now stream it in, a few characters at a time, on ONE mounted component.
    const step = 7;
    const view = render(<MarkdownMessage text="" />);
    for (let n = step; n <= full.length; n += step) {
      view.rerender(<MarkdownMessage text={full.slice(0, n)} />);
    }
    view.rerender(<MarkdownMessage text={full} />);
    expect(view.container.innerHTML).toBe(expected);
    view.unmount();
  });

  it("still renders a heading, a list and a fence after streaming", () => {
    const full = "## Heading\n\n- one\n- two\n\n```js\ncode\n```";
    const view = render(<MarkdownMessage text="" />);
    for (let n = 1; n <= full.length; n += 3) {
      view.rerender(<MarkdownMessage text={full.slice(0, n)} />);
    }
    expect(view.container.querySelector("h2")?.textContent).toBe("Heading");
    expect(view.container.querySelectorAll("li")).toHaveLength(2);
    expect(view.container.querySelector("pre code")?.textContent).toContain("code");
    view.unmount();
  });

  it("renders nothing at all for an empty buffer", () => {
    const view = render(<MarkdownMessage text="" />);
    expect(view.container.innerHTML).toBe("");
    expect(screen.queryByTestId("markdown-message")).toBeNull();
    view.unmount();
  });
});