import type { ProjectFile } from "./types";

/**
 * True when the visible narration is nothing but empty fenced blocks (e.g.
 * "```\n\n```") — the model opened and closed a fence with no content and
 * wrote nothing else. A legitimate chat reply carrying a code snippet has
 * content between or around the fences; the empty-fence signature is pure
 * degeneration and must trigger the recovery path. (A bare generic fence
 * without the anybase tag escapes hadFence detection — this catches it.)
 */
export function isEmptyFenceOutput(narration: string): boolean {
  if (!narration.includes("```")) return false;
  // Strip every fence marker (``` with an optional tag word like `any` or
  // `js`); whatever remains must be whitespace only.
  return narration.replace(/```[a-zA-Z]*/g, "").trim().length === 0;
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
  while ((m = re.exec(html))) {
    const u = m[1].trim();
    if (!u || /^(https?:)?\/\//i.test(u) || u.startsWith("data:") || u.startsWith("#")) continue;
    if (/\.(html?|css|js|mjs)$/i.test(u)) refs.push(u.replace(/^\.\//, ""));
  }
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
- Include empty states and user-friendly error messages in interactive apps.`;

export interface ParsedFile {
  path: string;
  content: string;
}

/**
 * Extracts file updates from a model response. Returns null when the
 * response contains no anybase block (plain conversational text).
 */
export function extractFiles(text: string): ParsedFile[] | null {
  const match = text.match(/```anybase\s*\n([\s\S]*?)(?:```|$)/);
  if (!match) return null;
  const body = match[1];
  const parts = body.split(/^===\s*(.+?)\s*===\s*$/gm);
  const files: ParsedFile[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const filePath = parts[i].trim();
    // Trim a single leading newline after the === path === header.
    const content = parts[i + 1].replace(/^\r?\n/, "").replace(/\s+$/, "");
    if (filePath) files.push({ path: filePath, content });
  }
  if (files.length > 0) return files;
  // Small models sometimes emit a fenced block holding a bare HTML document
  // without === file === headers. That's still a usable one-file app —
  // salvage it as index.html instead of discarding the whole attempt.
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
  const start = text.indexOf("```anybase");
  if (start === -1) return [];
  const rest = text.slice(start + "```anybase".length).replace(/^\r?\n/, "");
  const endIdx = rest.indexOf("```");
  const closed = endIdx !== -1;
  const body = closed ? rest.slice(0, endIdx) : rest;
  const parts = body.split(/^===\s*(.+?)\s*===\s*$/gm);
  const files: ParsedFile[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    // A section is final only when another header follows it, or the whole
    // block has closed.
    if (i + 2 >= parts.length && !closed) continue;
    const filePath = String(parts[i]).trim();
    const content = String(parts[i + 1] ?? "")
      .replace(/^\r?\n/, "")
      .replace(/\s+$/, "");
    if (filePath) files.push({ path: filePath, content });
  }
  return files;
}

/**
 * Strips anybase blocks from the visible chat text so users see a clean
 * narration instead of raw code (the code lands in the file editor).
 */
export function stripCodeBlocks(text: string): string {
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
  for (const f of files) {
    if (budget <= 0) break;
    const content =
      f.content.length > MAX_FILE_CHARS
        ? f.content.slice(0, MAX_FILE_CHARS) + "\n… (truncated)"
        : f.content;
    const block = `=== ${f.path} ===\n${content}`;
    budget -= block.length;
    if (budget > 0) fileBlocks.push(block);
  }
  return `\n\n## Current project files\n\nThese are the project's current files. When editing, keep IDs, class names and\nfunction names consistent with these actual contents:\n\n${fileBlocks.join("\n\n")}`;
}

export function relativePathList(files: ProjectFile[]): string {
  return files.map((f) => `- ${f.path} (${f.content.length} bytes)`).join("\n");
}
