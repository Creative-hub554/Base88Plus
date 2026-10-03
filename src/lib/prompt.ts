import { chargeWork } from "./perf-counter";
import type { ProjectFile } from "./types";

/**
 * True when the visible narration is nothing but empty fenced blocks (e.g.
 * "```\n\n```") — the model opened and closed a fence with no content and
 * wrote nothing else. A legitimate chat reply carrying a code snippet has
 * content between or around the fences; the empty-fence signature is pure
 * degeneration and must trigger the recovery path. (A bare generic fence
 * without the anybase tag escapes hadFence detection — this catches it.)
 *
 * WHY THIS IS A HAND-WRITTEN SCAN AND NOT A REGEX. It used to replace every
 * fence marker — three backticks plus a greedy run of ASCII letters — with the
 * empty string, trim the result, and ask whether anything was left. That was
 * correct, and it is gone for three reasons, in order of how much they matter.
 *
 *  1. IT ALLOCATED TWO FULL COPIES OF THE REPLY to answer a yes/no question.
 *     The scan instead stops at the first character that is neither whitespace
 *     nor part of a fence marker, so a healthy reply is decided in its first
 *     few characters. Measured A/B in a single process, interleaved, min of 11
 *     rounds, so the comparison cannot be flattered by machine drift:
 *
 *       fences then prose (a real reply)   0.00532 -> 0.00004 ms   -99.2%
 *       prose then a fence                 0.04848 -> 0.00003 ms   -99.9%
 *       stray backticks and 4-runs         0.08014 -> 0.00003 ms   -100.0%
 *       every byte a fence marker          0.02324 -> 0.01121 ms   -51.8%
 *       no fence at all (the control)      0.00013 -> 0.00013 ms    +0.3%
 *
 *     Read those honestly: most of the win is the EARLY EXIT, not a faster
 *     per-character loop. The old code paid a full-length copy every time; this
 *     one pays for a prefix. The only shape that scans end to end is the
 *     degenerate all-fence one, which is precisely the shape worth spending
 *     on. The control is in the table so the reader can see the case where
 *     there is nothing to win did not move.
 *
 *  2. IT IS COUNTABLE, which the regex was not and could not be made to be.
 *     Work inside a single regex call is not observable from JavaScript — see
 *     src/lib/perf-counter.ts. `isEmptyFenceOutput` was the worst-reading
 *     probe in the timing gate's corpus, with the least headroom of all 33,
 *     and it had no deterministic backstop at all. It now charges what it
 *     reads, so it is pinned by an integer count as well as by a ratio.
 *
 *  3. The whitespace test had to become explicit in order to be charged, and
 *     the obvious way to write it is much slower than what it replaced:
 *     a `/[\u00a0\u2028...]/.test(text[at])` per character measured +141% on
 *     non-ASCII blank padding, because `text[at]` allocates a fresh
 *     single-character string for every non-ASCII code unit. Switching on the
 *     code unit allocates nothing and came out 28.8% faster than the regex
 *     implementation on that same case.
 *
 * THE SEMANTICS ARE UNCHANGED, and that is pinned rather than asserted:
 * tests/refine-loop.test.ts keeps the old regex as a differential oracle and
 * fuzzes the two against each other, including the cases where a fence marker
 * is unterminated, doubled to four backticks, or followed by a tag word with a
 * digit in it.
 */
export function isEmptyFenceOutput(narration: string): boolean {
  // The `includes` pre-pass really does read the whole string, so it is charged.
  // Keeping it is deliberate: it is a native substring search and it is the
  // only cheap way to answer the overwhelmingly common "no fence anywhere"
  // case without a per-character loop over every reply.
  const whole = narration.length;
  if (!narration.includes("```")) {
    chargeWork(whole);
    return false;
  }
  let i = 0;
  while (i < narration.length) {
    // A fence marker: three backticks plus the optional tag word, which the
    // old `[a-zA-Z]*` took greedily and which `js`/`any`/`anybase` all match.
    if (
      narration.charCodeAt(i) === 96 &&
      narration.charCodeAt(i + 1) === 96 &&
      narration.charCodeAt(i + 2) === 96
    ) {
      i += 3;
      let c = narration.charCodeAt(i);
      while ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) {
        i += 1;
        // charCodeAt past the end is NaN, and every comparison against NaN is
        // false, so the tag loop terminates at the end of the string for free.
        c = narration.charCodeAt(i);
      }
      continue;
    }
    // Anything else has to be whitespace, and whitespace is what the old
    // `.trim()` would have had left behind.
    if (!isBlankAt(narration, i)) {
      chargeWork(whole + i + 1);
      return false;
    }
    i += 1;
  }
  chargeWork(whole + narration.length);
  return true;
}

/**
 * Exactly the code points `String.prototype.trim` removes: the ASCII five plus
 * space, and the Unicode Zs category plus ZWNBSP. Writing this as
 * `/\s/.test(ch)` would be shorter and measurably slower — see the header.
 *
 * Lone surrogates are not blank, exactly as they are not to `trim()`: every
 * code point in the blank set is in the BMP, so a surrogate unit always fails
 * this test whether or not it is half of a pair.
 */
function isBlankAt(text: string, at: number): boolean {
  const c = text.charCodeAt(at);
  if (c === 32 || (c >= 9 && c <= 13)) return true;
  if (c < 128) return false;
  switch (c) {
    case 0x00a0: // NO-BREAK SPACE
    case 0x1680: // OGHAM SPACE MARK
    case 0x2028: // LINE SEPARATOR
    case 0x2029: // PARAGRAPH SEPARATOR
    case 0x202f: // NARROW NO-BREAK SPACE
    case 0x205f: // MEDIUM MATHEMATICAL SPACE
    case 0x3000: // IDEOGRAPHIC SPACE
    case 0xfeff: // ZERO WIDTH NO-BREAK SPACE
      return true;
    default:
      // EN QUAD .. HAIR SPACE: the rest of Zs.
      return c >= 0x2000 && c <= 0x200a;
  }
}

/**
 * The single-server-retry failed (or the generation was cut off some other
 * way): the turn produced no files, so offer the user a one-click Continue
 * — a fresh minimal-history attempt with a hard format reminder.
 */
export function shouldOfferContinue(a: {
  hadFence: boolean;
  files: readonly unknown[] | null;
  error: string | null;
  narrationText: string;
}): boolean {
  if (a.files && a.files.length > 0) return false;
  return a.hadFence || a.error !== null || isEmptyFenceOutput(a.narrationText);
}

export const CONTINUE_REMINDER = `\n\nFINAL INSTRUCTION: Your previous reply was cut off or was not a valid app. Continue now: output the COMPLETE app in ONE \`\`\`anybase code block using the === file === format for every file, close the code fence, and write nothing after it.`;

/** Local (same-origin) script/stylesheet references in an HTML document. */
export function localRefsFromHtml(html: string): string[] {
  const refs: string[] = [];
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  // The document, once, plus every match's own length: the second term is
  // what a per-match rescan of the whole document would inflate, and the
  // matches of a global regex cannot overlap, so it stays proportional.
  //
  // Accumulated in a local and charged once, NOT charged per match: there
  // are two matches per 48 characters here, and a call per match measured
  // at 19ns each, +10.9% on this function. The increment is not free either
  // but it is two orders of magnitude cheaper.
  let scanned = html.length;
  while ((m = re.exec(html))) {
    scanned += m[0].length + 1;
    const u = m[1].trim();
    if (!u || /^(https?:)?\/\//i.test(u) || u.startsWith("data:") || u.startsWith("#")) continue;
    if (/\.(html?|css|js|mjs)$/i.test(u)) refs.push(u.replace(/^\.\//, ""));
  }
  chargeWork(scanned);
  return [...new Set(refs)];
}

/**
 * Detects a generation turn that IMITATED the compaction notes instead of
 * producing an app: visible prose like "[wrote 3 file(s)]" (the exact shape
 * the chat route appends to compacted history) with zero actual files
 * parsed. A small model that has seen these notes will emit them as its
 * whole answer — without this, the user is told files were written when
 * none were. Cases:
 *   - no files + no anybase fence + a `[wrote N file(s)]` note → imitation.
 *   - no files + a bare/generic fence (e.g. ```any) → truncated-fence form
 *     of the same failure (the real tag never made it out).
 */
export function isSummaryImitation(a: {
  hadFence: boolean;
  files: readonly unknown[] | null;
  narrationText: string;
}): boolean {
  if (a.files && a.files.length > 0) return false;
  if (a.hadFence) return false; // already covered by the degenerate retry
  return /\[wrote\s+\d+\s+file\(s\)\]/i.test(a.narrationText);
}

export const BUILDER_SYSTEM_PROMPT = `You are Anybase, an expert web designer and front-end engineer.

You build COMPLETE, WORKING websites and web apps as static files (HTML, CSS, JavaScript).
The user sees your result rendered live in a preview pane. Aim for agency-quality:
the kind of site a professional studio would ship — not a toy.

## Output format (STRICT)

Every app you build is described in ONE fenced code block tagged \`anybase\`:

\`\`\`anybase
=== index.html ===
<!doctype html>
<html>...full content...</html>

=== styles.css ===
/* full content */

=== app.js ===
// full content
\`\`\`

Rules:
- ALWAYS start with an \`index.html\`. Add styles.css / app.js (or more files) as needed.
- File contents must be COMPLETE. Never use "..." or "rest unchanged" placeholders.
- Every file MUST be a valid HTML document (with <!doctype html>) or valid CSS or JavaScript.
- index.html must reference other files with plain relative paths (e.g. <link rel="stylesheet" href="styles.css">, <script src="app.js"></script>).
- NO build tools, NO npm, NO frameworks that need compilation. Vanilla HTML/CSS/JS only.
- You may use <script type="module"> and browser ES modules between your own files, plus CDN imports (e.g. https://esm.sh) if genuinely helpful.
- Persist data in localStorage when the app needs storage.
- If the user asks for a change to an existing app, output the COMPLETE updated files (all files whose content changes, in full) in a new anybase block.
- Before the code block, write ONE short sentence describing what you built.
- Never output anything after the closing fence of the anybase block.

## Website quality bar

When the request is a website or landing page (as opposed to an interactive
tool), ship a real website:

- **Multi-page when it makes sense.** A marketing/business site gets separate
  pages (e.g. index.html, about.html, pricing.html, contact.html) linked by a
  shared navigation bar and footer with correct relative links. Keep each page
  self-sufficient: every HTML page links the same stylesheet and script.
- **Design system first.** Define CSS custom properties in :root for colors,
  fonts, spacing and radii, then use them everywhere. Pick a deliberate palette
  (one accent, neutrals that contrast well) — never default browser blue
  headings on plain white.
- **Typography.** Use a font stack with real hierarchy: fluid sizes with
  clamp(), clear heading scale, line-height >= 1.5, max-width ch-units for
  readable paragraphs.
- **Layout.** CSS grid/flex, generous whitespace, consistent max-width
  container. Cards, sections and clear visual rhythm.
- **Responsive.** Must look right at 390px, 768px and desktop. Use media
  queries; make navigation usable on mobile (wrap or hamburger via checkbox).
- **Motion.** Subtle and purposeful: hover/focus transitions, gentle
  scroll-reveal with IntersectionObserver, one hero animation. Respect
  prefers-reduced-motion. Never animate layout-critical properties excessively.
- **Polish.** Inline SVG favicon (<link rel="icon" href="data:...">),
  <meta name="description">, Open Graph tags, semantic HTML5 (header, nav,
  main, section, footer), alt text on images, visible focus styles, and a
  footer with the year.
- Include empty states and user-friendly error messages in interactive apps.

## Interactive apps: state and timers

A mode / UI-state function (one that flips CSS classes, headings or
visibility, e.g. setMode(true, false)) must be the single writer of that
state:

- Call it exactly ONCE per user action. Never call it a second time later in
  the same handler with different arguments — the later call silently
  overwrites the earlier one (the UI flashes the new mode, then reverts).
- If a handler auto-starts a timer inside \`if (ticking === null) { ... }\`,
  only start the timer there. Do not re-apply mode or visuals in that block;
  they are already set.
- Apply only the target state. Never "reset" to a default mode at the top of
  an action handler before applying the real one.
- Phase changes (e.g. work -> break -> work) happen where the timer expires,
  inside the tick handler, so every phase is visibly entered and exited;
  update counters/credits at the same place.
- If a handler rebuilds a dynamic list (e.g. rendering a summary, results or
  log lines into a container), CLEAR the container first (innerHTML = "" or
  removeChild loop) and rebuild it fresh. Appending on every click stacks
  duplicate output that grows forever.
- Before writing app.js, CROSS-CHECK every id and class you query against
  the HTML you are shipping in the same reply: getElementById must use ids
  that literally exist in the HTML, and querySelector selectors must match
  real elements. A single wrong id makes the script throw on load and the
  whole app dies — this is the most common fatal generation bug.\n`;

export interface ParsedFile {
  path: string;
  content: string;
}

/**
 * Extracts file updates from a model response. Returns null when the
 * response contains no anybase block (plain conversational text).
 */
export function extractFiles(text: string): ParsedFile[] | null {
  // The block search, the header split, and every per-part trim, all added
  // into one local and charged once on the way out. A second pass over
  // `body` would double the total and the work gate would see it.
  let scanned = text.length;
  const match = text.match(/```anybase\s*\n([\s\S]*?)(?:```|$)/);
  if (!match) return null;
  const body = match[1];
  scanned += body.length;
  const parts = body.split(/^===\s*(.+?)\s*===\s*$/gm);
  const files: ParsedFile[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const filePath = parts[i].trim();
    // Trim a single leading newline after the === path === header.
    scanned += parts[i + 1].length;
    const content = parts[i + 1].replace(/^\r?\n/, "").replace(/\s+$/, "");
    if (filePath) files.push({ path: filePath, content });
  }
  chargeWork(scanned);
  if (files.length > 0) return files;
  // Small models sometimes emit a fenced block holding a bare HTML document
  // without === file === headers. That's still a usable one-file app —
  // salvage it as index.html instead of discarding the whole attempt.
  chargeWork(scanned + body.length);
  const trimmed = body.trim();
  if (/^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return [{ path: "index.html", content: trimmed }];
  }
  return null;
}

/**
 * Progressive variant of extractFiles: returns only the file sections that
 * are already COMPLETE inside an anybase block, even while the block is
 * still streaming. A section counts as complete once the next `=== path ===`
 * header appears (its content can no longer change) or the fence closes;
 * the currently-growing section is withheld until its boundary arrives, so
 * every file streamed to the workspace is syntactically whole. Returns []
 * before any block starts and for header-less blocks (extractFiles' bare-HTML
 * salvage still applies at fence close).
 */
export function extractPartialFiles(text: string): ParsedFile[] {
  // indexOf plus the slice that follows it: one linear pass over the reply,
  // added into a local and charged once. This function is called on EVERY
  // streamed token, so it is the one in this module where a second pass
  // would hurt most.
  let scanned = text.length;
  const start = text.indexOf("```anybase");
  if (start === -1) return [];
  const rest = text.slice(start + "```anybase".length).replace(/^\r?\n/, "");
  const endIdx = rest.indexOf("```");
  const closed = endIdx !== -1;
  const body = closed ? rest.slice(0, endIdx) : rest;
  scanned += body.length;
  const parts = body.split(/^===\s*(.+?)\s*===\s*$/gm);
  const files: ParsedFile[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    // A section is final only when another header follows it, or the whole
    // block has closed.
    if (i + 2 >= parts.length && !closed) continue;
    const filePath = String(parts[i]).trim();
    scanned += String(parts[i + 1] ?? "").length;
    const content = String(parts[i + 1] ?? "")
      .replace(/^\r?\n/, "")
      .replace(/\s+$/, "");
    if (filePath) files.push({ path: filePath, content });
  }
  chargeWork(scanned);
  return files;
}

/**
 * Strips anybase blocks from the visible chat text so users see a clean
 * narration instead of raw code (the code lands in the file editor).
 */
export function stripCodeBlocks(text: string): string {
  // Two regex passes and a trim, all linear in the reply; charged once so
  // the ratio pins the reply length, not the number of blocks in it.
  chargeWork(text.length);
  return text
    .replace(/```anybase\s*\n[\s\S]*?(?:```|$)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Builds the model-facing "current project files" context block from the
 * workspace. SINGLE SOURCE for both the primary attempt and the degenerate
 * retry — the retry MUST rebuild this from the post-rollback workspace so a
 * failed attempt's partial writes (and any hallucinated IDs in them) can
 * never appear in the retry's instructions.
 */
export function buildWorkspaceContext(files: ProjectFile[]): string {
  if (!files.length) return "";
  const MAX_FILE_CHARS = 20_000;
  const MAX_TOTAL_CHARS = 60_000;
  let budget = MAX_TOTAL_CHARS;
  const fileBlocks: string[] = [];
  // Binary assets (images/fonts, base64 string layer) must NEVER be
  // inlined into the prompt — they are noise to the model and would eat
  // the entire context budget. They are listed by name instead.
  const binary = files.filter((f) => f.encoding === "base64");
  for (const f of files) {
    if (f.encoding === "base64") continue;
    if (budget <= 0) break;
    const content =
      f.content.length > MAX_FILE_CHARS
        ? f.content.slice(0, MAX_FILE_CHARS) + "\n… (truncated)"
        : f.content;
    const block = `=== ${f.path} ===\n${content}`;
    budget -= block.length;
    if (budget > 0) fileBlocks.push(block);
  }
  const binaryNote = binary.length
    ? `\n\nBinary assets already in the project (referenced by relative path when needed; never recreate their contents): ${binary
        .map((f) => f.path)
        .join(", ")}.`
    : "";
  return `\n\n## Current project files\n\nThese are the project's current files. When editing, keep IDs, class names and\nfunction names consistent with these actual contents:\n\n${fileBlocks.join("\n\n")}${binaryNote}`;
}

export function relativePathList(files: ProjectFile[]): string {
  return files
    .map(
      (f) =>
        `- ${f.path} (${f.content.length} bytes${f.encoding === "base64" ? ", binary" : ""})`,
    )
    .join("\n");
}
