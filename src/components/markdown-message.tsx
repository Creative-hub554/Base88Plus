/**
 * Render the Markdown tree from lib/markdown.tsx as React elements.
 *
 * The security property is structural and worth stating plainly: this file
 * contains no `dangerouslySetInnerHTML`, no `innerHTML`, and no HTML string
 * of any kind. Every element below is a JSX tag chosen by this module, and
 * every text value arrives as a React child, which React escapes. A tag the
 * model wrote is text, because there is no code path that turns text into a
 * tag.
 *
 * The other property is that link hrefs have already been through
 * `safeUrl` by the time they arrive — the parser rejects an unsafe URL by
 * not emitting a link node at all — so there is no href check to forget
 * here. `rel="noopener noreferrer"` is defence in depth for the target.
 */
import { memo, useState, type ReactNode } from "react";
import {
  createStreamingMarkdownParser,
  type Block,
  type Inline,
} from "../lib/markdown";

/** Tailwind classes per heading level, sized for the chat panel. */
const HEADING_CLASSES: Record<number, string> = {
  1: "text-base font-semibold text-neutral-50 mt-3 first:mt-0",
  2: "text-sm font-semibold text-neutral-50 mt-3 first:mt-0",
  3: "text-sm font-semibold text-neutral-200 mt-2.5 first:mt-0",
  4: "text-sm font-medium text-neutral-200 mt-2 first:mt-0",
  5: "text-sm font-medium text-neutral-300 mt-2 first:mt-0",
  6: "text-xs font-medium uppercase tracking-wide text-neutral-400 mt-2 first:mt-0",
};

const INLINE_CODE_CLASSES =
  "rounded bg-neutral-950/70 px-1 py-0.5 font-mono text-[0.8em] text-amber-200";

function renderInline(nodes: Inline[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.kind) {
      case "text":
        // A bare string, not a <span>. Wrapping every literal in an element
        // means a query for the text of a bold run lands on the inner span
        // rather than the <strong>, which makes both the DOM and the tests
        // harder to reason about for no rendering benefit.
        return node.value;
      case "code":
        return (
          <code key={key} className={INLINE_CODE_CLASSES}>
            {node.value}
          </code>
        );
      case "strong":
        return (
          <strong key={key} className="font-semibold text-neutral-100">
            {renderInline(node.children, key)}
          </strong>
        );
      case "emphasis":
        return (
          <em key={key} className="italic">
            {renderInline(node.children, key)}
          </em>
        );
      case "strike":
        return (
          <s key={key} className="line-through opacity-70">
            {renderInline(node.children, key)}
          </s>
        );
      case "link":
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-amber-300 underline underline-offset-2 hover:text-amber-200"
          >
            {renderInline(node.children, key)}
          </a>
        );
    }
  });
}

function renderBlock(block: Block, index: number): ReactNode {
  const key = `b${index}`;
  switch (block.kind) {
    case "heading": {
      const Tag = `h${block.level}` as "h1";
      return (
        <Tag key={key} className={HEADING_CLASSES[block.level]}>
          {renderInline(block.children, key)}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p key={key} className="whitespace-pre-wrap leading-relaxed">
          {renderInline(block.children, key)}
        </p>
      );
    case "code":
      return (
        <pre
          key={key}
          className="overflow-x-auto rounded-md border border-neutral-800 bg-neutral-950/80 p-2.5 font-mono text-[0.78rem] leading-relaxed text-neutral-200"
        >
          <code>
            {block.lang.length > 0 ? (
              <span className="mb-1.5 block text-[0.7rem] uppercase tracking-wide text-neutral-500">
                {block.lang}
              </span>
            ) : null}
            {block.value}
          </code>
        </pre>
      );
    case "list":
      return block.ordered ? (
        <ol key={key} className="list-decimal space-y-1 pl-5 marker:text-neutral-500">
          {block.items.map((item, i) => (
            <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key} className="list-disc space-y-1 pl-5 marker:text-neutral-500">
          {block.items.map((item, i) => (
            <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
          ))}
        </ul>
      );
    case "quote":
      return (
        <blockquote
          key={key}
          className="border-l-2 border-neutral-700 pl-3 italic text-neutral-400"
        >
          {renderInline(block.children, key)}
        </blockquote>
      );
  }
}

/**
 * One block, memoised on the block object itself.
 *
 * This is the second half of not re-rendering the whole reply per token. The
 * streaming parser hands back the SAME block objects for every part of the
 * buffer that is already final, so `React.memo` sees identical props and skips
 * those subtrees entirely — a paragraph the model finished a second ago costs
 * nothing to keep on screen, and only the paragraph still being written
 * re-renders. Keys are unchanged from the plain `renderBlock` map, so the
 * rendered DOM is identical to what it was before.
 */
const MarkdownBlock = memo(function MarkdownBlock({
  block,
  index,
}: {
  block: Block;
  index: number;
}) {
  return renderBlock(block, index);
});

/**
 * Render an assistant reply as Markdown.
 *
 * Returns a fragment of blocks with normal vertical rhythm. An empty string
 * yields an empty fragment rather than an empty paragraph, so a streaming
 * message that has produced no text yet does not leave a gap in the panel.
 *
 * The parser is created once per mounted message, not once per render: one
 * instance per bubble, because two replies can be streaming at once and must
 * not share a cache. Its output is by construction identical to
 * `parseMarkdown(text)` — see `createStreamingMarkdownParser`.
 */
export function MarkdownMessage({ text }: { text: string }) {
  const [parser] = useState(createStreamingMarkdownParser);
  const blocks = parser.parse(text);
  if (blocks.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="markdown-message">
      {blocks.map((block, index) => (
        <MarkdownBlock key={index} block={block} index={index} />
      ))}
    </div>
  );
}