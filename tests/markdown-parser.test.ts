/**
 * Pins for the assistant-reply Markdown parser (src/lib/markdown.ts).
 *
 * Two things are under test, and the second matters more than the first.
 *
 * RENDERING: a chat reply that says "## What changed" should read as a
 * heading, not as literal hashes. The builder system prompt asks the model
 * for a summary and models habitually answer in Markdown, so before this the
 * panel printed raw `#` and ``` for anything but `**bold**`.
 *
 * SAFETY: the parser emits a plain-data tree (`Inline` is a closed union), so
 * there is no HTML string anywhere in the pipeline and no sanitizer to keep
 * current. The allowlist is the type. These pins exist to prove that stays
 * true — that a tag in model output stays a text node, and that the one
 * place a model string reaches a URL-shaped attribute (a link href) only
 * accepts http/https/mailto.
 */
import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, safeUrl, type Block } from "@/lib/markdown";

/** Flatten a block tree to `kind` strings for terse assertions. */
function kinds(blocks: Block[]): string[] {
  return blocks.map((b) => b.kind);
}

/** The concatenated text of a block, ignoring structure. */
function textOf(nodes: { kind: string }[]): string {
  return nodes
    .map((n) => {
      const anyNode = n as unknown as { value?: string; children?: unknown[] };
      if (anyNode.value !== undefined) return anyNode.value;
      if (Array.isArray(anyNode.children)) return textOf(anyNode.children as { kind: string }[]);
      return "";
    })
    .join("");
}

describe("parseMarkdown blocks", () => {
  it("parses ATX headings at each level", () => {
    const blocks = parseMarkdown("# One\n## Two\n### Three");
    expect(kinds(blocks)).toEqual(["heading", "heading", "heading"]);
    expect(blocks.map((b) => (b.kind === "heading" ? b.level : 0))).toEqual([1, 2, 3]);
  });

  it("renders a single hash with no space as text, not a heading", () => {
    // `#hashtag` is the common case; treating it as a heading would silently
    // swallow a tag the model meant literally.
    expect(kinds(parseMarkdown("#hashtag"))).toEqual(["paragraph"]);
  });

  it("strips a closing run of hashes", () => {
    const [block] = parseMarkdown("## Title ##");
    expect(block.kind).toBe("heading");
    expect(textOf(block.kind === "heading" ? block.children : [])).toBe("Title");
  });

  it("keeps headings deeper than six as text", () => {
    expect(kinds(parseMarkdown("####### too deep"))).toEqual(["paragraph"]);
  });

  it("parses a fenced code block and does not read markup inside it", () => {
    const source = ["```ts", "# not a heading", "- not a bullet", "<b>x</b>", "```"].join("\n");
    const [block] = parseMarkdown(source);
    expect(block.kind).toBe("code");
    if (block.kind !== "code") throw new Error("expected code");
    expect(block.lang).toBe("ts");
    expect(block.value).toBe("# not a heading\n- not a bullet\n<b>x</b>");
  });

  it("supports tilde fences and a fence with no language", () => {
    const [block] = parseMarkdown("~~~\nplain\n~~~");
    expect(block.kind).toBe("code");
    if (block.kind !== "code") throw new Error("expected code");
    expect(block.lang).toBe("");
  });

  it("does not let an unterminated fence swallow the rest of the message", () => {
    // A truncated stream is normal here; the model gets cut off mid-block
    // and the panel must still render what it has.
    const blocks = parseMarkdown("```js\nconst x = 1;");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("code");
  });

  it("parses bullet lists in all three markers", () => {
    for (const marker of ["-", "*", "+"]) {
      const blocks = parseMarkdown(`${marker} one\n${marker} two`);
      expect(kinds(blocks)).toEqual(["list"]);
      if (blocks[0].kind !== "list") throw new Error("expected list");
      expect(blocks[0].ordered).toBe(false);
      expect(blocks[0].items).toHaveLength(2);
    }
  });

  it("parses ordered lists with . and ) markers", () => {
    const [dot] = parseMarkdown("1. first\n2. second");
    const [paren] = parseMarkdown("1) first\n2) second");
    for (const block of [dot, paren]) {
      expect(block.kind).toBe("list");
      if (block.kind !== "list") throw new Error("expected list");
      expect(block.ordered).toBe(true);
      expect(block.items).toHaveLength(2);
      expect(textOf(block.items[0])).toBe("first");
    }
  });

  it("joins a wrapped bullet into one item", () => {
    const [block] = parseMarkdown("- first line\n  continued here\n- second");
    if (block.kind !== "list") throw new Error("expected list");
    expect(block.items).toHaveLength(2);
    expect(textOf(block.items[0])).toBe("first line continued here");
  });

  it("parses block quotes", () => {
    const [block] = parseMarkdown("> quoted **text**");
    expect(block.kind).toBe("quote");
    if (block.kind !== "quote") throw new Error("expected quote");
    expect(textOf(block.children)).toBe("quoted text");
  });

  it("returns nothing for empty and whitespace-only input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\n  \n")).toEqual([]);
  });

  it("tolerates CRLF line endings", () => {
    const blocks = parseMarkdown("# Title\r\n\r\nbody\r\n");
    expect(kinds(blocks)).toEqual(["heading", "paragraph"]);
  });

  it("handles a realistic assistant summary", () => {
    const source = [
      "## What changed",
      "",
      "I rewrote the hero and added a pricing table.",
      "",
      "- **index.html** — new hero",
      "- **pricing.html** — table added",
      "",
      "```html",
      "<section class=\"hero\"></section>",
      "```",
      "",
      "See [the docs](https://example.com/docs).",
    ].join("\n");
    expect(kinds(parseMarkdown(source))).toEqual([
      "heading",
      "paragraph",
      "list",
      "code",
      "paragraph",
    ]);
  });
});

describe("parseInline", () => {
  it("renders **bold** and __bold__", () => {
    for (const marker of ["**", "__"]) {
      const nodes = parseInline(`a ${marker}b${marker} c`);
      const strong = nodes.find((n) => n.kind === "strong");
      expect(strong, `expected strong for ${marker}`).toBeDefined();
    }
  });

  it("renders *italic* but not inside a word", () => {
    expect(parseInline("*yes*").some((n) => n.kind === "emphasis")).toBe(true);
    // snake_case_names are everywhere in this app's output; emphasis here
    // would be a bug that only shows up on real messages.
    const nodes = parseInline("call some_function_name now");
    expect(nodes.some((n) => n.kind === "emphasis")).toBe(false);
    expect(textOf(nodes)).toBe("call some_function_name now");
  });

  it("renders ~~strike~~", () => {
    expect(parseInline("~~gone~~").some((n) => n.kind === "strike")).toBe(true);
  });

  it("leaves an unmatched marker as literal text", () => {
    const nodes = parseInline("2 * 3 = 6 and **unclosed");
    expect(nodes.every((n) => n.kind === "text")).toBe(true);
    expect(textOf(nodes)).toBe("2 * 3 = 6 and **unclosed");
  });

  it("does not re-parse inside inline code", () => {
    const nodes = parseInline("`**not bold**`");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toEqual({ kind: "code", value: "**not bold**" });
  });

  it("honours backslash escapes", () => {
    const nodes = parseInline("\\*not emphasis\\*");
    expect(nodes.every((n) => n.kind === "text")).toBe(true);
    expect(textOf(nodes)).toBe("*not emphasis*");
  });

  it("nests inline markup", () => {
    const nodes = parseInline("**bold with `code` inside**");
    const strong = nodes.find((n) => n.kind === "strong");
    if (!strong || strong.kind !== "strong") throw new Error("expected strong");
    expect(strong.children.some((c) => c.kind === "code")).toBe(true);
  });

  it("renders links with a safe href", () => {
    const nodes = parseInline("see [docs](https://example.com/a?b=c#d)");
    const link = nodes.find((n) => n.kind === "link");
    expect(link).toBeDefined();
    if (!link || link.kind !== "link") throw new Error("expected link");
    expect(link.href).toBe("https://example.com/a?b=c#d");
    expect(textOf(link.children)).toBe("docs");
  });

  it("autolinks a bare url and leaves sentence punctuation outside the link", () => {
    const nodes = parseInline("see https://example.com/x.");
    const link = nodes.find((n) => n.kind === "link");
    if (!link || link.kind !== "link") throw new Error("expected link");
    // The full stop ends the sentence, not the URL, so it stays outside the
    // anchor — otherwise the link text and the href disagree.
    expect(link.href).toBe("https://example.com/x");
    expect(textOf(nodes)).toBe("see https://example.com/x.");
  });

  it("does not swallow a parenthetical closing paren", () => {
    const nodes = parseInline("(see https://example.com/x)");
    const link = nodes.find((n) => n.kind === "link");
    if (!link || link.kind !== "link") throw new Error("expected link");
    expect(link.href).toBe("https://example.com/x");
    expect(textOf(nodes)).toBe("(see https://example.com/x)");
  });

  it("allows relative and fragment links", () => {
    for (const href of ["/pricing", "#section", "?q=1"]) {
      expect(parseInline(`[x](${href})`).some((n) => n.kind === "link")).toBe(true);
    }
  });
});

describe("safeUrl — the only route from model text to an href", () => {
  it("accepts http, https and mailto", () => {
    expect(safeUrl("https://example.com")).toBe("https://example.com");
    expect(safeUrl("http://example.com")).toBe("http://example.com");
    expect(safeUrl("mailto:a@example.com")).toBe("mailto:a@example.com");
  });

  it("rejects script-bearing schemes however they are spelled", () => {
    const hostile = [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "java script:alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "file:///etc/passwd",
      "blob:https://example.com/x",
    ];
    for (const url of hostile) {
      expect(safeUrl(url), `should reject ${JSON.stringify(url)}`).toBeNull();
    }
  });

  it("rejects protocol-relative urls", () => {
    // Inherits the page scheme and is an open redirect the model never
    // needed to emit.
    expect(safeUrl("//evil.example")).toBeNull();
  });

  it("rejects a scheme-less host rather than guessing", () => {
    expect(safeUrl("example.com")).toBeNull();
    expect(safeUrl("www.example.com")).toBeNull();
  });

  it("rejects an empty or whitespace-only url", () => {
    expect(safeUrl("")).toBeNull();
    expect(safeUrl("   ")).toBeNull();
  });

  it("keeps a safe url byte-for-byte", () => {
    const url = "https://example.com/a_b-c~d?e=f&g=h#i";
    expect(safeUrl(url)).toBe(url);
  });
});

describe("the parser cannot express anything outside its allowlist", () => {
  it("keeps html tags as text nodes", () => {
    for (const source of [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "<iframe src=evil></iframe>",
      "<a href=\"javascript:alert(1)\">click</a>",
    ]) {
      const nodes = parseInline(source);
      expect(nodes.every((n) => n.kind === "text"), `leaked node in ${source}`).toBe(true);
      expect(textOf(nodes)).toBe(source);
    }
  });

  it("renders a hostile link as literal text, keeping the label", () => {
    const nodes = parseInline("[click me](javascript:alert(1))");
    expect(nodes.some((n) => n.kind === "link")).toBe(false);
    // The text survives so the reader still sees what the model wrote.
    expect(textOf(nodes)).toContain("click me");
  });

  it("does not create a link for an html tag with a safe-looking href", () => {
    const nodes = parseInline('<a href="https://example.com">x</a>');
    expect(nodes.some((n) => n.kind === "link")).toBe(false);
  });

  it("never emits a node kind outside the Inline union", () => {
    // Structural guarantee: whatever the input, the only kinds produced are
    // the seven this module defines. A tag cannot become a node because
    // there is no node kind that means "tag".
    const allowed = new Set(["text", "code", "strong", "emphasis", "strike", "link"]);
    const sources = [
      "# h\n\n- a\n- b\n\n> q\n\n```\ncode\n```",
      "<script>x</script> [a](javascript:1) ![img](x.png)",
      "**b** *i* ~~s~~ `c` https://example.com",
      "\\* escaped \\\\ backslash",
    ];
    for (const source of sources) {
      const walk = (nodes: ReturnType<typeof parseInline>) => {
        for (const node of nodes) {
          expect(allowed.has(node.kind), `unexpected kind ${node.kind}`).toBe(true);
          const anyNode = node as unknown as { children?: ReturnType<typeof parseInline> };
          if (anyNode.children) walk(anyNode.children);
        }
      };
      walk(parseInline(source));
    }
  });

  it("survives pathological input without throwing", () => {
    const nasty = [
      "**".repeat(500),
      "[".repeat(200),
      "`".repeat(300),
      "> ".repeat(200),
      "#".repeat(100),
      "- ".repeat(200),
      "*a".repeat(500),
      "",
      "\n\n\n",
    ];
    for (const source of nasty) {
      expect(() => parseMarkdown(source), `threw on ${JSON.stringify(source.slice(0, 20))}`)
        .not.toThrow();
    }
  });
});