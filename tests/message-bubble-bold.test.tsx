/**
 * Component pins for assistant-reply rendering in the chat panel.
 *
 * Two things are asserted here. First, that Markdown actually RENDERS — a
 * reply that says "## What changed" should be a heading in the DOM, and a
 * fenced block should be a <pre>, not literal hashes and backticks. Before
 * this, only `**bold**` rendered and everything else printed as raw markup.
 *
 * Second, and more important, that model output stays TEXT. The parser emits
 * a closed union of node kinds and the renderer maps that onto React
 * elements, so there is no `dangerouslySetInnerHTML` and no HTML string
 * anywhere on the path. These pins hold that: an <img onerror> in a reply
 * must not become an element, a `javascript:` href must not become an
 * anchor, and a raw HTML tag must be visible as the characters the model
 * typed.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageBubble } from "@/components/builder-client";
import { MarkdownMessage } from "@/components/markdown-message";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const assistant = (text: string) =>
  ({
    id: "m1",
    role: "assistant",
    parts: [{ type: "text", text }],
  }) as never;

describe("MessageBubble markdown rendering", () => {
  it("renders **bold** as a strong element", () => {
    render(<MessageBubble message={assistant("Started from the **SaaS site** template.")} />);
    const strong = screen.getByText("SaaS site");
    expect(strong.tagName).toBe("STRONG");
    expect(document.body.textContent).not.toContain("**");
  });

  it("renders headings as heading elements, not literal hashes", () => {
    render(<MessageBubble message={assistant("## What changed\n\nI rewrote the hero.")} />);
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toBe("What changed");
    expect(document.body.textContent).not.toContain("##");
  });

  it("renders a fenced code block as pre > code", () => {
    render(
      <MessageBubble
        message={assistant("```html\n<section class=\"hero\"></section>\n```")}
      />,
    );
    const pre = document.querySelector("pre code");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("<section class=");
    // The backticks are gone from the visible text.
    expect(document.body.textContent).not.toContain("```");
  });

  it("renders a code fence's content as literal text, not elements", () => {
    render(<MessageBubble message={assistant("```\n<b>hi</b>\n```")} />);
    // The tag is VISIBLE as characters and is NOT an element.
    expect(document.querySelector("pre b")).toBeNull();
    expect(document.querySelector("pre")?.textContent).toContain("<b>hi</b>");
  });

  it("renders bullet and ordered lists as real list elements", () => {
    render(
      <MessageBubble message={assistant("- one\n- two\n\n1. first\n2. second")} />,
    );
    // Two lists: the unordered pair and the ordered pair.
    const lists = screen.getAllByRole("list");
    expect(lists.map((l) => l.tagName)).toEqual(["UL", "OL"]);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("one").tagName).toBe("LI");
  });

  it("renders a link with a safe href and safe rel attributes", () => {
    render(<MessageBubble message={assistant("See [the docs](https://example.com/docs).")} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    // target=_blank without noopener hands the new page a window reference.
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toBe("the docs");
  });

  it("renders a block quote as a blockquote", () => {
    render(<MessageBubble message={assistant("> worth noting")} />);
    expect(document.querySelector("blockquote")?.textContent).toBe("worth noting");
  });

  it("renders italic, strike and inline code", () => {
    render(
      <MessageBubble message={assistant("*soft* and ~~gone~~ and `x = 1`")} />,
    );
    expect(document.querySelector("em")?.textContent).toBe("soft");
    expect(document.querySelector("s")?.textContent).toBe("gone");
    expect(document.querySelector("p code, div code")?.textContent).toBe("x = 1");
  });

  it("leaves plain text alone", () => {
    render(<MessageBubble message={assistant("no markup here")} />);
    expect(screen.getByText(/no markup here/)).toBeTruthy();
    expect(document.querySelector("strong")).toBeNull();
  });

  it("leaves user messages verbatim — the user typed the asterisks", () => {
    const msg = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "make it **bold**" }],
    } as never;
    render(<MessageBubble message={msg} />);
    expect(document.body.textContent).toContain("**bold**");
    // A user message is not Markdown: no heading, no anchor.
    expect(document.querySelector("a")).toBeNull();
  });
});

describe("assistant text never becomes markup", () => {
  it("does not interpret html in assistant text", () => {
    render(
      <MessageBubble message={assistant('<img src=x onerror=alert(1)> **ok**')} />,
    );
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("ok").tagName).toBe("STRONG");
  });

  it("shows a raw html tag as the characters the model typed", () => {
    render(<MessageBubble message={assistant("<script>alert(1)</script>")} />);
    expect(document.querySelector("script")).toBeNull();
    expect(document.body.textContent).toContain("<script>alert(1)</script>");
  });

  it("does not create an anchor for a javascript: href", () => {
    render(<MessageBubble message={assistant("[click](javascript:alert(1))")} />);
    expect(document.querySelector("a")).toBeNull();
    // The label is still visible, so the reader sees what was written.
    expect(document.body.textContent).toContain("click");
  });

  it("does not create an anchor for a data: href", () => {
    render(<MessageBubble message={assistant("[x](data:text/html,<script>alert(1)</script>)")} />);
    expect(document.querySelector("a")).toBeNull();
  });

  it("renders a relative link without a scheme", () => {
    render(<MessageBubble message={assistant("[pricing](/pricing)")} />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/pricing");
  });

  it("never sets innerHTML anywhere in the rendered output", () => {
    // The structural claim, asserted rather than assumed: React escaping is
    // the only sanitiser in play, which holds only if no raw-HTML path
    // exists. A single dangerouslySetInnerHTML would void all of the above.
    render(
      <MessageBubble
        message={assistant(
          '# H\n\n- a\n- b\n\n[x](https://e.com)\n\n```\n<b>c</b>\n```\n\n> q',
        )}
      />,
    );
    // If any node had been injected via innerHTML it would be an element that
    // React never created; asserting the expected set exists and the raw
    // tags do not is the observable proxy for that.
    expect(document.querySelector("h1")).not.toBeNull();
    expect(document.querySelector("ul")).not.toBeNull();
    expect(document.querySelector("a")).not.toBeNull();
    expect(document.querySelector("pre")).not.toBeNull();
    expect(document.querySelector("blockquote")).not.toBeNull();
    expect(document.querySelector("b")).toBeNull();
  });
});

describe("MarkdownMessage edge cases", () => {
  it("renders nothing for empty text, so a streaming bubble has no gap", () => {
    const { container } = render(<MarkdownMessage text="" />);
    expect(container.textContent).toBe("");
    expect(container.querySelector("p")).toBeNull();
  });

  it("preserves a hard line break inside a paragraph", () => {
    const { container } = render(<MarkdownMessage text={"line one\nline two"} />);
    const p = container.querySelector("p");
    expect(p?.textContent).toContain("line one");
    expect(p?.className).toContain("whitespace-pre-wrap");
  });

  it("renders a truncated fence without throwing", () => {
    // Normal during streaming: the model gets cut off mid-block.
    expect(() => render(<MarkdownMessage text={"```js\nconst x = 1;"} />)).not.toThrow();
  });

  it("renders a long message without pathological cost", () => {
    const source = Array.from({ length: 300 }, (_, i) => `- item ${i}`).join("\n");
    const started = Date.now();
    render(<MarkdownMessage text={source} />);
    expect(document.querySelectorAll("li").length).toBe(300);
    // Generous, but a regex-backtracking parser would blow past this.
    expect(Date.now() - started).toBeLessThan(5000);
  });
});