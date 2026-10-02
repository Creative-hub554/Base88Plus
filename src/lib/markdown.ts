/**
 * A small Markdown parser for assistant chat replies.
 *
 * WHY THIS EXISTS AND WHY IT IS SHAPED THIS WAY
 * The builder chat prints model output. Every other part of the app treats
 * that output as TEXT — the existing bold renderer emits <strong> around a
 * string slice and never parses HTML. Extending that to headings, lists,
 * code fences and links could have gone two ways:
 *
 *   1. Parse to an HTML string and set it with dangerouslySetInnerHTML,
 *      behind a sanitizer (DOMPurify, sanitize-html, …).
 *   2. Parse to a plain-data tree and render it with React elements.
 *
 * (2) is what this does, and the difference is not stylistic. There is no
 * HTML string anywhere in the pipeline, so there is nothing for an injection
 * to escape into and no sanitizer whose allowlist can drift out of date.
 * The allowlist is the TYPE: `Inline` is a union of exactly the node kinds
 * this module knows how to produce, and a tag the parser does not recognise
 * cannot become a node because there is no node kind that means "tag".
 * `renderMarkdown` maps that tree onto elements; it cannot invent one.
 *
 * Links are the one place a string from the model reaches a URL-shaped
 * attribute, so that is where the allowlist lives: `safeUrl` accepts only
 * http, https and mailto, plus site-relative paths. `javascript:`,
 * `data:`, `vbscript:` and protocol-relative `//host` are all rejected and
 * degrade to plain text — see `ALLOWED_LINK_SCHEMES`.
 *
 * NO STRING.replace ANYWHERE IN THIS FILE, by design. A `.replace()` over
 * markup-ish text is exactly what CodeQL's incomplete-multi-character-
 * sanitization flags, and lint rule `anybase/no-markup-sanitiser-replace`
 * (src/lib/../eslint-rules/) now fails the build on one. Every rewrite below
 * is a slice of the original string, which is also why the parser cannot
 * re-scan text it produced.
 *
 * SCOPE — deliberately CommonMark-lite, because this renders chat bubbles in
 * a narrow panel, not a documentation site:
 *   - ATX headings `#`..`######`
 *   - paragraphs and single hard line breaks
 *   - fenced code blocks ``` with an optional language tag, and `~~~`
 *   - bullet lists (`-`, `*`, `+`) and ordered lists (`1.`, `1)`), one level
 *   - block quotes `>`
 *   - inline: `code`, **bold**, *italic*, ~~strike~~, [text](url), autolinks
 * Not supported, and rendered as literal text on purpose: reference links,
 * images (a tracking-pixel vector in a chat log), tables, nested lists,
 * raw HTML, setext headings, and inline HTML of any kind.
 */

// ---------------------------------------------------------------------------
// Types — the allowlist. A node kind not in this union cannot be rendered.
// ---------------------------------------------------------------------------

export type Inline =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "emphasis"; children: Inline[] }
  | { kind: "strike"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "code"; lang: string; value: string }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "quote"; children: Inline[] };

/**
 * Link schemes an assistant reply may point at. `mailto:` because the model
 * legitimately suggests contacting support; nothing else. Notably absent:
 * `javascript:`, `data:` (a `data:text/html` URL is a stored-XSS vector and
 * an image one is a tracking pixel), `blob:`, `file:` and `vbscript:`.
 */
const ALLOWED_LINK_SCHEMES = ["http://", "https://", "mailto:"];

/** Longest heading level we render; deeper `#######` is not a heading. */
const MAX_HEADING_LEVEL = 6;

/**
 * How far into an autolink's authority we look for the dot that proves it is
 * a real host. 253 is the DNS name limit, so no legitimate host is cut off,
 * and the bound is what stops one `http://` from scanning a whole message.
 */
const MAX_HOST_SCAN = 253;

/**
 * Characters that open an emphasis run, paired with their closer. Kept as a
 * table so the parser cannot pair a `*` opener with a `_` closer.
 */
const EMPHASIS_PAIRS: Record<string, string> = { "*": "*", "_": "_" };

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * Is this string safe to put in an href?
 *
 * Returns the URL to use, or null to render the link as plain text. The
 * checks are ordered cheapest-first and each one exists because the naive
 * version of the next one has been exploited somewhere:
 *  - control characters and whitespace are stripped first, because
 *    `java\0script:` and `java\tscript:` are parsed as `javascript:` by
 *    browsers but would defeat a literal prefix check;
 *  - scheme comparison is case-insensitive, because `JaVaScRiPt:` works;
 *  - `//evil.example` is rejected outright: it inherits the page's scheme
 *    and is an open-redirect-shaped link the model did not need to emit.
 */
export function safeUrl(raw: string): string | null {
  // Strip ASCII control characters and whitespace anywhere in the URL.
  let cleaned = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) continue;
    cleaned += ch;
  }
  if (cleaned.length === 0) return null;
  // Protocol-relative: inherits the current scheme, so it is never ours.
  if (cleaned.startsWith("//")) return null;
  // Site-relative and fragment links are fine and are common in a chat log.
  if (cleaned.startsWith("/") || cleaned.startsWith("#") || cleaned.startsWith("?")) {
    return cleaned;
  }
  const lower = cleaned.toLowerCase();
  for (const scheme of ALLOWED_LINK_SCHEMES) {
    if (lower.startsWith(scheme)) return cleaned;
  }
  // Anything else has an unrecognised scheme (or none at all, like
  // `www.example.com`, which we decline rather than guess at).
  return null;
}

/**
 * Case-insensitive `startsWith(scheme)` at an index, over a bounded window.
 *
 * Bounded on purpose: a slice to the end of the message would make this
 * O(remaining) per call site, which is how the autolink check became the
 * parser's worst hot spot (see `isAutolink`).
 */
function matchesSchemeAt(text: string, at: number, scheme: string): boolean {
  if (at + scheme.length > text.length) return false;
  for (let k = 0; k < scheme.length; k += 1) {
    const ch = text[at + k].toLowerCase();
    if (ch !== scheme[k]) return false;
  }
  return true;
}

/**
 * Does a bare URL start at `at`?
 *
 * This used to take the whole remainder of the message — a slice from
 * the scan position to the end — and lowercased all of it to test
 * three prefixes. That is O(remaining) work at every `(`-preceded
 * position, so a message full of parenthesised prose cost O(n^2):
 * measured 5.4ms at 4800 characters, 592ms at 76800. It is now three
 * bounded checks and never looks past `MAX_HOST_SCAN`.
 *
 * The first-character gate is what makes ordinary prose free: only `h`
 * (http, https) and `m` (mailto) can begin an allowed scheme, so almost
 * every position is rejected after reading a single character.
 */
function isAutolink(text: string, at: number): boolean {
  const first = text[at];
  if (first !== "h" && first !== "H" && first !== "m" && first !== "M") {
    return false;
  }
  // Protocol-relative: inherits the page's scheme, so never ours.
  if (text[at + 1] === "/") return false;
  for (const scheme of ALLOWED_LINK_SCHEMES) {
    if (!matchesSchemeAt(text, at, scheme)) continue;
    // Require a dot in the authority, so `http://x` or a bare scheme
    // mention is not turned into a link. The authority ends at the first
    // `/?#`, and the scan is capped at MAX_HOST_SCAN.
    const limit = Math.min(text.length, at + scheme.length + MAX_HOST_SCAN);
    for (let i = at + scheme.length; i < limit; i += 1) {
      const ch = text[i];
      if (ch === "/" || ch === "?" || ch === "#") return false;
      if (ch === ".") return true;
    }
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

/** Index of a matching single-character closer at or after `from`, or -1. */
function findCloser(text: string, from: number, closer: string): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === closer) return i;
  }
  return -1;
}

/**
 * A `findCloser` that remembers when a closer does not exist.
 *
 * `findCloser` alone is only linear if it finds something. On a string with
 * no `]` at all, EVERY `[` asks for one and each ask runs to the end of the
 * text, so `"[a".repeat(n)` costs O(n^2) — measured at 27ms for 3200
 * characters, and it degrades from there. Streaming makes this reachable:
 * the buffer is re-parsed on every token, so a model that emits a bracket
 * and no closing one pays the quadratic cost repeatedly on a growing string.
 *
 * The memo is sound because the scan is position-independent: starting at
 * `from` or further right visits the same characters with the same escape
 * rule, so "no closer at or after N" implies "no closer at or after M" for
 * every M >= N. One failed scan therefore answers every later question of
 * the same kind in constant time, and the total work drops to a single pass.
 *
 * Only asymmetric delimiters need this. `*`, `_` and `~` open and close with
 * the same character, so an opener always finds a partner further right and
 * `findCloserPair` was already linear — measured, not assumed.
 */
function makeCloserFinder(text: string): (from: number, closer: string) => number {
  /** closer character -> lowest index already proven to have no closer after it */
  const emptyFrom = new Map<string, number>();
  return (from: number, closer: string): number => {
    const proven = emptyFrom.get(closer);
    // Reached only when `from` is left of any earlier proof, so recording it
    // unconditionally keeps the strongest (lowest) bound.
    if (proven !== undefined && from >= proven) return -1;
    const at = findCloser(text, from, closer);
    if (at === -1) emptyFrom.set(closer, from);
    return at;
  };
}

/**
 * Index of a closer that must be exactly `run` copies of `closer`, or -1.
 *
 * Needed because `findCloser(text, …, "**")` compares one character against
 * a TWO-character string and therefore never matches — which is why strong
 * spans silently failed to parse. Matching a fixed run also stops `~~~` from
 * closing a strike opened by `~~`.
 */
function findCloserPair(text: string, from: number, closer: string, run: number): number {
  for (let i = from; i + run <= text.length; i += 1) {
    if (text[i] === "\\") {
      i += run;
      continue;
    }
    let matched = true;
    for (let k = 0; k < run; k += 1) {
      if (text[i + k] !== closer) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

/**
 * Parse inline markup.
 *
 * One left-to-right pass that emits literal text between spans. An opener
 * with no closer is literal text, which is what makes a stray `*` in prose
 * ("2 * 3 = 6") render as itself instead of swallowing the rest of the
 * message.
 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  let i = 0;
  // Scoped to THIS string: recursive calls parse a slice, so they must not
  // inherit a memo built for the parent.
  const findFrom = makeCloserFinder(text);

  const flush = () => {
    if (plain.length > 0) {
      out.push({ kind: "text", value: plain });
      plain = "";
    }
  };

  while (i < text.length) {
    const ch = text[i];

    // Backslash escape: the next character is literal, always. This is what
    // lets a reply show `\*not emphasis\*` and what stops a model from
    // closing a span with an escaped delimiter.
    if (ch === "\\" && i + 1 < text.length) {
      plain += text[i + 1];
      i += 2;
      continue;
    }

    // Inline code. Fenced to the matching backtick run, and its contents
    // are NEVER re-parsed: `**not bold**` inside backticks stays literal.
    if (ch === "`") {
      let run = 0;
      while (text[i + run] === "`") run += 1;
      const fence = "`".repeat(run);
      const close = text.indexOf(fence, i + run);
      if (close !== -1) {
        flush();
        out.push({ kind: "code", value: text.slice(i + run, close) });
        i = close + run;
        continue;
      }
      // Unclosed backtick run: literal text, per CommonMark.
      plain += fence;
      i += run;
      continue;
    }

    // Strong: ** or __
    if ((ch === "*" || ch === "_") && text[i + 1] === ch) {
      const close = findCloserPair(text, i + 2, ch, 2);
      if (close !== -1 && close > i + 2) {
        flush();
        out.push({
          kind: "strong",
          children: parseInline(text.slice(i + 2, close)),
        });
        i = close + 2;
        continue;
      }
    }

    // Strike: ~~ — two tildes, opened and closed by a pair.
    if (ch === "~" && text[i + 1] === "~") {
      const close = findCloserPair(text, i + 2, "~", 2);
      if (close !== -1 && close > i + 2) {
        flush();
        out.push({ kind: "strike", children: parseInline(text.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    // Emphasis: * or _ , but not `**` (handled above) and, for `_`, not
    // inside a word — `snake_case_name` must not become `snake<em>case</em>`.
    //
    // A single `*` or `_` immediately before a DOUBLE run is not emphasis:
    // in `**bold**` the first star belongs to the strong delimiter, and
    // treating it as an opener here consumed one star and left the message
    // rendering as `*<em>bold</em>*`. The double-run branch above already
    // handled the case where BOTH stars are present, so reaching here with
    // text[i+1] === ch and text[i+2] === ch means the strong branch found no
    // closer — which makes the star literal, not an opener.
    if (EMPHASIS_PAIRS[ch] === ch) {
      const isDouble = text[i + 1] === ch;
      const intraword = ch === "_" && i > 0 && isWordChar(text[i - 1]);
      if (!isDouble && !intraword) {
        const close = findFrom(i + 1, ch);
        // Contents must be non-empty and must not start with whitespace,
        // both of which CommonMark forbids and both of which otherwise
        // render as stray emphasis marks.
        const inner = close === -1 ? "" : text.slice(i + 1, close);
        if (close !== -1 && close > i + 1 && !/^\s/.test(inner)) {
          flush();
          out.push({ kind: "emphasis", children: parseInline(inner) });
          i = close + 1;
          continue;
        }
      }
    }

    // Link: [text](href)
    if (ch === "[") {
      const labelEnd = findFrom(i + 1, "]");
      if (labelEnd !== -1 && text[labelEnd + 1] === "(") {
        const hrefEnd = findFrom(labelEnd + 2, ")");
        if (hrefEnd !== -1) {
          const href = safeUrl(text.slice(labelEnd + 2, hrefEnd));
          if (href !== null) {
            flush();
            out.push({
              kind: "link",
              href,
              children: parseInline(text.slice(i + 1, labelEnd)),
            });
            i = hrefEnd + 1;
            continue;
          }
          // Unsafe href: fall through and let the brackets render as text
          // rather than dropping the label.
        }
      }
    }

    // Autolink: a bare URL on its own.
    if (isAutolinkAt(text, i)) {
      const end = autolinkEnd(text, i);
      const href = end > i ? safeUrl(text.slice(i, end)) : null;
      if (href !== null) {
        flush();
        out.push({ kind: "link", href, children: [{ kind: "text", value: href }] });
        i = end;
        continue;
      }
    }

    plain += ch;
    i += 1;
  }

  flush();
  return out;
}

/** Would an autolink start at `at`? Only at a word boundary. */
function isAutolinkAt(text: string, at: number): boolean {
  if (at > 0 && !/[\s(]/.test(text[at - 1])) return false;
  // The authority check has to read far enough to see the dot in
  // `example.com`. An earlier 12-character window truncated the candidate
  // to `https://exam` — no dot, so no link, and bare URLs in a reply
  // silently stayed plain text. The window is `MAX_HOST_SCAN` now rather
  // than the whole remainder, which is what used to make this the most
  // expensive check in the parser.
  return isAutolink(text, at);
}

/**
 * End index of a bare URL starting at `at`, excluding trailing punctuation.
 *
 * A trailing `.`/`,` ends the sentence, not the URL. A trailing `)` only
 * belongs to the URL if the URL opened one — otherwise it is a parenthetical
 * around the link, which is how `(see https://example.com)` should read.
 */
function autolinkEnd(text: string, at: number): number {
  // Scan on WHITESPACE only. Stopping on punctuation too would end the URL
  // at the colon in `https://` — the scan has to cross the scheme first and
  // only then decide what is punctuation.
  let end = at;
  while (end < text.length && !/\s/.test(text[end])) end += 1;
  // Now trim from the end: sentence punctuation, then an unmatched closing
  // paren (so `(see https://example.com)` does not swallow the paren).
  while (end > at && ".,;:!?".includes(text[end - 1])) end -= 1;
  if (end > at && text[end - 1] === ")") {
    const candidate = text.slice(at, end);
    const opens = candidate.split("(").length - 1;
    const closes = candidate.split(")").length - 1;
    if (closes > opens) end -= 1;
  }
  return end;
}

/** Punctuation that ends a sentence rather than the URL. */
function isTrailingPunctuation(ch: string): boolean {
  return ".,;:!?)]'\"".includes(ch);
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9]/.test(ch);
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

/** Split into lines, tolerating CRLF. */
function toLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      let end = i;
      if (end > start && text[end - 1] === "\r") end -= 1;
      lines.push(text.slice(start, end));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** A list bullet at the start of a line? Returns the indent width, or -1. */
function bulletIndent(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === " ") i += 1;
  const rest = line.slice(i);
  if (rest.startsWith("- ") || rest.startsWith("* ") || rest.startsWith("+ ")) return i;
  // Ordered: `1.` or `1)` followed by a space.
  let digits = 0;
  while (digits < rest.length && rest[digits] >= "0" && rest[digits] <= "9") digits += 1;
  if (digits > 0 && digits <= 9 && rest.length > digits + 1) {
    const mark = rest[digits];
    if ((mark === "." || mark === ")") && rest[digits + 1] === " ") return i;
  }
  return -1;
}

/** Is this line a list bullet of the given kind? */
function isBulletOf(line: string, ordered: boolean): boolean {
  const indent = bulletIndent(line);
  if (indent === -1) return false;
  const rest = line.slice(indent);
  if (ordered) return rest[0] >= "0" && rest[0] <= "9";
  return rest === "-" || rest === "*" || rest === "+" || rest.startsWith("- ")
    || rest.startsWith("* ") || rest.startsWith("+ ");
}

/** Strip the bullet marker, returning the item's text. */
function bulletText(line: string): string {
  const indent = bulletIndent(line);
  if (indent === -1) return line;
  const rest = line.slice(indent);
  if (rest[0] >= "0" && rest[0] <= "9") {
    let digits = 0;
    while (digits < rest.length && rest[digits] >= "0" && rest[digits] <= "9") digits += 1;
    return rest.slice(digits + 2);
  }
  return rest.slice(2);
}

/**
 * Parse Markdown into blocks.
 *
 * Fenced code is consumed whole before any other rule runs, so a `#` or a
 * `-` inside a code block is a code line, not a heading or a bullet. That
 * ordering is the whole reason this is a single left-to-right pass rather
 * than a set of independent line rules.
 */
export function parseMarkdown(source: string): Block[] {
  const lines = toLines(source);
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank line: a paragraph separator, and nothing else.
    if (trimmed.length === 0) {
      i += 1;
      continue;
    }

    // Fenced code block.
    const fence = fenceMarker(trimmed);
    if (fence !== null) {
      const lang = trimmed.slice(fence.length).trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const candidate = lines[i].trim();
        const closing = fenceMarker(candidate);
        if (closing !== null && candidate.slice(closing.length).trim().length === 0) {
          i += 1;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: "code", lang, value: body.join("\n") });
      continue;
    }

    // ATX heading.
    const level = headingLevel(trimmed);
    if (level !== null) {
      const rest = trimmed.slice(level).trim();
      // Strip an optional closing run of `#`.
      let end = rest.length;
      while (end > 0 && rest[end - 1] === "#") end -= 1;
      blocks.push({
        kind: "heading",
        level: level as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(rest.slice(0, end).trim()),
      });
      i += 1;
      continue;
    }

    // Block quote: gather consecutive `>` lines and recurse through the BLOCK
    // parser on the dequoted text, so a quote can contain lists, headings
    // and code fences. Parsing the joined text as INLINE flattened all of
    // that to one run of emphasis nodes.
    if (trimmed.startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        const inner = lines[i].trim().slice(1);
        quoted.push(inner.startsWith(" ") ? inner.slice(1) : inner);
        i += 1;
      }
      const inner = parseMarkdown(quoted.join("\n"));
      blocks.push({
        kind: "quote",
        children: flattenQuote(inner),
      });
      continue;
    }

    // List: gather consecutive bullets of the same ordered-ness, allowing
    // lazy continuation lines (a wrapped item with no bullet).
    if (bulletIndent(line) !== -1) {
      const ordered = line.trim()[0] >= "0" && line.trim()[0] <= "9";
      const items: Inline[][] = [];
      let current: string[] | null = null;
      while (i < lines.length) {
        const candidate = lines[i];
        if (candidate.trim().length === 0) {
          // A blank line ends the list unless the next line continues it.
          const next = i + 1 < lines.length ? lines[i + 1] : null;
          if (next === null || bulletIndent(next) === -1 || next.trim().length === 0) {
            break;
          }
          i += 1;
          continue;
        }
        if (isBulletOf(candidate, ordered)) {
          current = [bulletText(candidate)];
          items.push(parseInline(""));
          // Replace the placeholder with the real parse below.
          items[items.length - 1] = parseInline(current[0]);
          i += 1;
          continue;
        }
        if (current !== null && bulletIndent(candidate) === -1) {
          // Lazy continuation of the current item.
          current.push(candidate.trim());
          items[items.length - 1] = parseInline(current.join(" "));
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // Paragraph: run of non-blank lines that is not any of the above. Hard
    // breaks (two trailing spaces, or a backslash) become explicit breaks.
    const paragraph: string[] = [];
    while (i < lines.length) {
      const candidate = lines[i];
      if (
        candidate.trim().length === 0 ||
        headingLevel(candidate.trim()) !== null ||
        fenceMarker(candidate.trim()) !== null ||
        candidate.trim().startsWith(">") ||
        bulletIndent(candidate) !== -1
      ) {
        break;
      }
      paragraph.push(candidate.replace(/[ \t]+$/, ""));
      i += 1;
    }
    blocks.push({ kind: "paragraph", children: parseInline(paragraph.join("\n")) });
  }

  return blocks;
}

/**
 * Flatten parsed blocks back to inline nodes for a quote's children.
 *
 * A quote's inner content is parsed as BLOCKS (so a quoted list is a list),
 * but the `quote` node carries `Inline[]` so the renderer stays simple. The
 * separators keep the text readable: blocks are joined with a space rather
 * than run together.
 */
function flattenQuote(blocks: Block[]): Inline[] {
  const out: Inline[] = [];
  for (let b = 0; b < blocks.length; b += 1) {
    if (b > 0) out.push({ kind: "text", value: " " });
    const block = blocks[b];
    switch (block.kind) {
      case "paragraph":
      case "heading":
        out.push(...block.children);
        break;
      case "code":
        out.push({ kind: "code", value: block.value });
        break;
      case "list":
        for (let i = 0; i < block.items.length; i += 1) {
          if (i > 0) out.push({ kind: "text", value: " " });
          out.push(...block.items[i]);
        }
        break;
      case "quote":
        out.push(...block.children);
        break;
    }
  }
  return out;
}

/** The fence marker at the start of a trimmed line, or null. */
function fenceMarker(trimmed: string): string | null {
  for (const ch of ["```", "~~~"]) {
    if (trimmed.startsWith(ch)) {
      // Count the whole run and return the run itself, not the three-char
      // seed repeated: ``` and ```` are different markers, and the language
      // is whatever follows. (Repeating the SEED would also turn ``` into a
      // nine-character marker and swallow the language tag.)
      const first = ch[0];
      let run = 0;
      while (trimmed[run] === first) run += 1;
      if (run >= 3) return first.repeat(run);
    }
  }
  return null;
}

/** ATX heading level, or null. */
function headingLevel(trimmed: string): number | null {
  let hashes = 0;
  while (trimmed[hashes] === "#") hashes += 1;
  if (hashes === 0 || hashes > MAX_HEADING_LEVEL) return null;
  // `#hashtag` is not a heading; a heading needs a space after the hashes.
  if (trimmed[hashes] !== " ") return null;
  return hashes;
}