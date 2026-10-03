import { createHash } from "node:crypto";
import { streamText } from "ai";
import { BUILDER_SYSTEM_PROMPT, extractFiles } from "@/lib/prompt";
import { resolveGenerationFor } from "@/lib/providers/gateway";
import {
  createProject,
  deleteAppFile,
  getProject,
  listAppFiles,
  saveAppFile,
  setProjectTemplate,
} from "@/lib/store";
import {
  TEMPLATES,
  briefHash,
  templateProjectId,
  type TemplateDef,
} from "@/lib/templates";
import {
  auditDemoLinks,
  demoNavIsWired,
  formatDemoLinkAudit,
  buildPageSlugIndex,
  type PageSlugIndex,
  forEachTag,
  indexOfCloseAnchor,
  pageForLabelIn,
  textBetween,
} from "@/lib/demo-link-audit";
import { formatGateResult, runDemoGates } from "@/lib/demo-gates";
import { chargeWork } from "@/lib/perf-counter";
import type { ProjectFile } from "@/lib/types";

/**
 * Template demo generation, shared by:
 *  - POST /api/templates   (on-demand from the gallery)
 *  - warmTemplateCache()   (background pass on server start, instrumentation)
 *
 * Demos live in fixed-id "library projects" (`tpl-<id>`) and are cached:
 * a demo is fresh only while its briefHash matches the current brief.
 */

/**
 * Extra instruction for template generation. The brief is the file plan:
 * a demo must emit every file its brief describes — a multi-page brief
 * (SaaS site, blog) gets every page as a real .html file, never a
 * single-page stub whose nav links 404. Size guidance is per-file so a
 * five-file demo isn't squeezed into one 300-line page.
 *
 * The "emit exactly the files" rule governs PAGES, never styling. Reading
 * it literally once made four of six demos ship bare unstyled markup:
 * no brief names a stylesheet, so "no more, no fewer" talked the model out
 * of the one file that carries the entire visual design. The suffix
 * therefore mandates the design system explicitly.
 *
 * The length guidance was the other half of the same failure. "100–200
 * lines per page … a clean section flow beat raw length" read as an
 * instruction to be BRIEF, and five of six demos came back as 145–380
 * characters of visible text wrapped in a competent header and footer —
 * real DOM, no content. The suffix now asks for substance and names the
 * filler it must reject.
 *
 * IT IS ALSO DELIBERATELY SHORT. Expanding it to explain all of that at
 * length (410 words, up from 214) made generations overflow the model's
 * output budget: the response ended before closing the code fence, the
 * extractor returned nothing, and THREE templates were lost from the
 * gallery — a worse outcome than the thin demos it was meant to prevent.
 * The gates enforce; the prompt only has to make passing achievable. So
 * the rules are stated once each, in the fewest words that keep them
 * unambiguous, and the budget line tells the model to finish what it
 * starts rather than keep elaborating.
 */
export const TEMPLATE_SUFFIX = `

This is a TEMPLATE DEMO. Emit every file the brief names — each page the
brief describes, and any shared data file it mentions, as its own file
linked with plain relative paths, with the navbar/footer duplicated per page
(no build step). If the brief describes a single page, emit that ONE page.
Never link a file you did not emit.

Write REAL content: every section the brief lists exists and carries real
copy — actual names, dates, prices, quotes. "Feature 1", "Project 2",
"Lorem ipsum" and "your text here" are failed demos; a six-card grid means
six DIFFERENT projects, not "Project 1" through "Project 6".

Ship one styles.css (design system in :root, deliberate palette, type scale
with clamp(), grid/flex) linked from every page, and one app.js linked from
every page. app.js runs on EVERY page, so guard each lookup —
const el = document.querySelector('#x'); if (!el) return; — or the pages
missing that element throw and silently kill every handler after it. Never
hide a shared element on load (a page with no toggle renders a blank void).
Use future dates.

No image files and no external URLs: draw visuals with inline SVG or CSS
gradients. Never inline a base64 raster image.

Keep the whole output under ~500 lines and close the code fence — finishing
every file matters more than elaborating any one of them.`;

/**
 * Reject a demo whose html is truncated or unstyled: no <body>, or no
 * stylesheet/inline <style> anywhere. Without this, a generation that gets
 * cut off mid-output (the model emitted a 5 KB base64 og:image and the
 * response ended before <body>) is cached and served as a "ready" demo that
 * renders as a blank page. Retrying beats shipping it.
 */
export function demoLooksComplete(files: ProjectFile[]): boolean {
  const html = files.filter((f) => f.path.endsWith(".html"));
  // Every file's content is read: the html by a regex test, a stylesheet by
  // `trim()`. Charged as the documents themselves, which is the honest upper
  // bound — the characters a regex reads are not observable from JavaScript.
  chargeWork(files.reduce((n, f) => n + f.content.length, 0));
  if (html.length === 0) return false;
  if (!html.some((f) => /<body[\s>]/i.test(f.content))) return false;
  const styled =
    files.some((f) => f.path.endsWith(".css") && f.content.trim().length > 0) ||
    html.some((f) => /<style[\s>]/i.test(f.content));
  return styled;
}

/**
 * Cache key component: hash of everything the demo generation depends on
 * besides the brief. When the system prompt (or the template suffix) changes,
 * every cached demo becomes stale and is regenerated by the next warm pass.
 */
export function systemPromptHash(): string {
  return createHash("sha256")
    .update(BUILDER_SYSTEM_PROMPT, "utf8")
    .update(TEMPLATE_SUFFIX, "utf8")
    .digest("hex")
    .slice(0, 16);
}

export interface TemplateStatus {
  id: string;
  name: string;
  tagline: string;
  gradient: string;
  ready: boolean;
  generating: boolean;
  stale: boolean;
  files: string[];
  generatedAt?: string;
}

/** In-process lock so a warm pass and gallery clicks never double-generate. */
const generating = new Set<string>();

function statusFor(t: TemplateDef): TemplateStatus {
  const projectId = templateProjectId(t.id);
  const project = getProject(projectId);
  const files = project ? listAppFiles(projectId) : [];
  const fresh =
    project?.template?.briefHash === briefHash(t.brief) &&
    project?.template?.promptHash === systemPromptHash() &&
    files.length > 0;
  return {
    id: t.id,
    name: t.name,
    tagline: t.tagline,
    gradient: t.gradient,
    ready: fresh,
    generating: generating.has(t.id),
    stale: Boolean(project) && !fresh,
    files: files.map((f) => f.path),
    generatedAt: project?.template?.generatedAt,
  };
}

export interface TemplateCacheStatus {
  templates: TemplateStatus[];
  configured: boolean;
  /** True while the startup warm pass is still working through templates. */
  warming: boolean;
  /** Template ids still pending in the startup warm pass. */
  warmingPending: string[];
}

/** Warm-pass state, readable by the API for gallery polling. */
let warmActive = false;
const warmPending = new Set<string>();

export async function getTemplateCacheStatus(): Promise<TemplateCacheStatus> {
  return {
    templates: TEMPLATES.map(statusFor),
    configured: await isProviderConfigured(),
    warming: warmActive,
    warmingPending: [...warmPending],
  };
}

export async function isProviderConfigured(): Promise<boolean> {
  try {
    await resolveGenerationFor();
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate (or regenerate when stale) one template's demo app server-side
 * into its library project. Returns the fresh status, or null when nothing
 * was generated (already generating / no provider / generation failed).
 * Never throws — the background warm pass and the fire-and-forget API path
 * both just want success/failure.
 */
export async function generateTemplateDemo(
  template: TemplateDef,
): Promise<TemplateStatus | null> {
  try {
    return await generateTemplateDemoOrThrow(template);
  } catch (err) {
    console.error(
      `[templates] ${template.id}: generation failed —`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Generate one template's demo, throwing on failure with a message suitable
 * for the gallery's error banner (no provider, degenerate output, …).
 */
export async function generateTemplateDemoOrThrow(
  template: TemplateDef,
): Promise<TemplateStatus> {
  if (generating.has(template.id)) {
    throw new Error("Already generating");
  }
  let generation;
  try {
    generation = await resolveGenerationFor();
  } catch (err) {
    throw new Error(
      err instanceof Error
        ? err.message
        : "No AI provider configured — set one in Settings first.",
    );
  }

  generating.add(template.id);
  try {
    const projectId = templateProjectId(template.id);
    const files = await generateTemplateFiles(template, generation);
    if (!files || files.length === 0) {
      throw new Error(
        "Generation produced no files — try again or use a stronger model.",
      );
    }

    // Ensure the library project exists (fixed id, marked as template).
    if (!getProject(projectId)) {
      createProject(template.appName, template.brief, { id: projectId });
    }

    // Write the file set (replacing any stale content file-by-file).
    const keep = new Set(files.map((f) => f.path));
    for (const existing of listAppFiles(projectId)) {
      if (!keep.has(existing.path)) {
        deleteAppFile(projectId, existing.path);
      }
    }
    for (const f of files) {
      saveAppFile(projectId, f.path, f.content);
    }

    setProjectTemplate(projectId, {
      id: template.id,
      briefHash: briefHash(template.brief),
      promptHash: systemPromptHash(),
      generatedAt: new Date().toISOString(),
    });

    return statusFor(template);
  } finally {
    generating.delete(template.id);
  }
}

/**
 * One deletion/neutralization pass over the html: remove <img src=…>,
 * <script src=…></script>, and <link href=…> tags whose target is relative
 * and not among the files the model actually emitted, and neutralize
 * <a href=…> tags pointing at pages that were never emitted (rewritten to
 * href="#" — the navbar keeps its items, nothing navigates to a 404).
 *
 * Anchors are judged STRICTER than assets on purpose: a root-relative
 * asset (/vendored.js) may resolve same-origin, but a root-relative link
 * (/pricing) would leave the demo entirely — a static multi-page site can
 * only navigate among its own emitted files.
 *
 * ONE alternation regex matches all four tag shapes (a chained set of
 * one-shot replaces would let an earlier deletion splice the text into a
 * NEW well-formed tag the later passes never see). The pass is a MANUAL
 * exec loop that builds the output from segments — inter-match text is
 * appended verbatim, and each match is appended whole, dropped, or
 * replaced by a synthesized constant. No String.replace sanitization:
 * output is assembled from slices, so no pass ever grows the string and
 * the matcher never sees text it produced.
 */

/** The replacement for a dead anchor: a synthesized minimal open tag. */
const NEUTRAL_ANCHOR = '<a href="#">';

function stripBrokenPass(html: string, emitted: Set<string>): string {
  // Assets: root-relative targets may resolve same-origin, so they keep.
  const keepAsset = (target: string): boolean =>
    /^(https?:|data:|mailto:|tel:|#|\/)/.test(target) || emitted.has(target);
  // Anchors are stricter: no root-relative — a static demo cannot leave
  // itself, so /pricing would 404 exactly like a missing file.
  const keepAnchor = (target: string): boolean =>
    /^(https?:|data:|mailto:|tel:|#)/.test(target);

  let out = "";
  let last = 0;
  let pos = 0;
  // Characters this pass searched, which is NOT `pos`. The cubic bug this loop
  // replaced re-read the remainder once per `<`, advancing `pos` by one each
  // time, so a count built from `pos` would have read perfectly linear while
  // the work went n-cubed. Charged as the distance each `indexOf` had to look
  // across, the whole remainder included when it finds nothing.
  let scanned = 0;

  // Walked by hand, one `<` at a time, rather than with the alternation this
  // replaces. That pattern was not merely quadratic but CUBIC on
  // `<a href="x"` repeated with no `>` anywhere: each `<` ran `[^>]*` to the end
  // of the file, then backtracked through every position hunting for `href=`,
  // then ran `[^>]*` again after the value — and `sanitizeDemoFiles` runs this
  // pass inside a fixed-point loop, so it paid that twice. Measured at 730ms
  // for 800 unterminated anchors, growing ~8x per doubling; it is now linear.
  //
  // The cost was the UNBOUNDED `[^>]*`, and the fix is to stop using it: find
  // the attribute with `indexOf`, and treat "no `>` anywhere ahead" as the end
  // of the scan rather than as a reason to try the next `<`. That is sound
  // because if there is no `>` after a position there is none after any later
  // position either.
  //
  // NOT `forEachTag`, deliberately: the alternation looked for `<img`/`<script`/
  // `<link`/`<a` at ANY `<`, independent of where the enclosing tag ended, so
  // `<im<script src="x.js"></script>g src='missing.png'>` matched the inner
  // `<script`. Delimiting by the first `>` would have missed it and left the
  // spliced `<img>` behind — see "removes a broken tag spliced into shape by a
  // prior pass" in tests/demo-sanitizer.test.ts.
  while (pos < html.length) {
    const lt = html.indexOf("<", pos);
    if (lt === -1) {
      scanned += html.length - pos;
      break;
    }
    scanned += lt - pos + 1;
    const kind = refKindAt(html, lt);
    if (kind === null) {
      pos = lt + 1;
      continue;
    }
    // No `>` ahead means no later `<` can complete a tag either.
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) {
      scanned += html.length - lt;
      break;
    }
    // The `>` search, plus the bounded window `refValueIn` reads looking for
    // the attribute: at most the tag itself, and tags do not overlap.
    scanned += gt - lt;

    // The attribute name must appear BEFORE the first `>`, because the old
    // leading `[^>]*` could not cross it. The VALUE may cross it: `[^"'#]+`
    // permits `>`, so `<img src="a>b">` really did carry the value `a>b`.
    const attr = kind === "img" || kind === "script" ? "src" : "href";
    const found = refValueIn(html, lt + 1, gt, attr);
    // The `[^>]*>` that closed every branch of the alternation: the match ran
    // on to the first `>` after the value, and INCLUDED it.
    const afterGt = found === null ? -1 : html.indexOf(">", found.after);
    if (found === null) {
      pos = lt + 1;
      continue;
    }
    if (afterGt === -1) {
      // The search for the tag's own `>` read the remainder and found none.
      scanned += html.length - found.after;
      pos = lt + 1;
      continue;
    }
    scanned += afterGt - found.after;
    let end = afterGt + 1;
    if (kind === "script") {
      // The script alternative also claimed the body and closing tag, so the
      // whole element went into the match — and the trailing padding below
      // belongs after THAT, not after the value.
      const close = indexOfCloseScript(html, end);
      if (close === -1) {
        scanned += html.length - end;
        pos = lt + 1;
        continue;
      }
      scanned += close - end;
      end = close;
    }
    while (end < html.length && isInlineSpace(html.charCodeAt(end))) end += 1;
    if (html.charCodeAt(end) === 10) end += 1; // the trailing `\n?`

    // Leading `[ \t]*` was part of the match too, so the whitespace before the
    // tag was re-emitted with it. That run only reaches back as far as `last`,
    // because the scan resumes there.
    let start = lt;
    while (start > last && isInlineSpace(html.charCodeAt(start - 1))) start -= 1;
    // The leading whitespace this match reclaims, and the padding run above it.
    scanned += lt - start;

    const tag = html.slice(start, end);
    out += html.slice(last, start);
    last = end;
    pos = end;

    if (kind === "a") {
      if (keepAnchor(found.value)) {
        out += tag;
        continue;
      }
      // Compare the path part only — fragments and query strings ride
      // along on an emitted page (post.html#intro, post.html?id=2).
      const filePath = found.value.split("#")[0].split("?")[0].trim();
      if (filePath && emitted.has(filePath)) {
        out += tag;
        continue;
      }
      // Dead anchor: the synthesized minimal open tag. The link's label
      // text and closing </a> live outside this match and survive; the
      // dead link loses its styling attributes, which is fine — it is
      // dead.
      out += NEUTRAL_ANCHOR;
      continue;
    }
    if (keepAsset(found.value)) out += tag;
  }
  out += html.slice(last);
  chargeWork(scanned);
  return out;
}

/** Space or tab — the `[ \t]` the old pattern's padding matched. */
function isInlineSpace(code: number): boolean {
  return code === 32 || code === 9;
}

/** JS `\w`, which is what `\b` in the old pattern treated as a word character. */
function isWordCode(code: number): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === 95
  );
}

/** ASCII case-insensitive compare against an all-lowercase word. */
function matchesWord(html: string, at: number, lower: string): boolean {
  for (let k = 0; k < lower.length; k += 1) {
    const code = html.charCodeAt(at + k);
    const want = lower.charCodeAt(k);
    // Uppercase ASCII sits exactly 32 above lowercase, and every word compared
    // here is letters only.
    if (code !== want && code !== want - 32) return false;
  }
  return true;
}

/**
 * Which of the four tag kinds this alternation matched, or null.
 *
 * The old pattern required a `\b` after the name, so `<scripts>` is not a
 * script tag and `<abc>` is not an anchor. Preserved exactly.
 */
function refKindAt(html: string, lt: number): "img" | "script" | "link" | "a" | null {
  const at = lt + 1;
  if (matchesWord(html, at, "img") && !isWordCode(html.charCodeAt(at + 3))) return "img";
  if (matchesWord(html, at, "script") && !isWordCode(html.charCodeAt(at + 6))) return "script";
  if (matchesWord(html, at, "link") && !isWordCode(html.charCodeAt(at + 4))) return "link";
  if (matchesWord(html, at, "a") && !isWordCode(html.charCodeAt(at + 1))) return "a";
  return null;
}

/**
 * The `\b(src|href)=["']([^"'#]+)["']` value, with the attribute name required
 * to start before `to`, or null.
 *
 * Faithful in the ways that are easy to get wrong:
 *  - there is NO `\s*` around the `=`;
 *  - the value is non-empty and may contain neither a quote nor a `#`;
 *  - the closing quote need not match the opening one, so `href="'x"` matched
 *    before and still does;
 *  - the value is NOT bounded by `to`, because `[^"'#]` permits `>` and a real
 *    HTML attribute can contain one: `<img src="a>b">` carries `a>b`.
 *  Greedy `[^"'#]+` cannot usefully backtrack — any shorter match would be
 *  followed by a character that is not a quote — so the first stop is the only
 *  candidate, which is what keeps this linear.
 */
function refValueIn(
  html: string,
  from: number,
  to: number,
  attr: "src" | "href",
): { value: string; after: number } | null {
  for (let i = from; i + attr.length + 3 <= to; i += 1) {
    if (i > 0 && isWordCode(html.charCodeAt(i - 1))) continue; // the `\b`
    if (!matchesWord(html, i, attr)) continue;
    const eq = i + attr.length;
    if (html.charCodeAt(eq) !== 61) continue; // `=`, with no `\s*`
    const open = html.charCodeAt(eq + 1);
    if (open !== 34 && open !== 39) continue; // `"` or `'`
    let v = eq + 2;
    while (v < html.length) {
      const code = html.charCodeAt(v);
      if (code === 34 || code === 39 || code === 35) break;
      v += 1;
    }
    if (v === eq + 2) continue; // `[^"'#]+` needs at least one character
    const close = html.charCodeAt(v);
    if (close !== 34 && close !== 39) continue;
    return { value: html.slice(eq + 2, v), after: v + 1 };
  }
  return null;
}

/**
 * Index just past `</script>` for the `\s*<\/script>` tail of the script
 * alternative, given the position AFTER the tag's `>`, or -1.
 */
function indexOfCloseScript(html: string, afterGt: number): number {
  let k = afterGt;
  while (k < html.length && isJsSpace(html.charCodeAt(k))) k += 1;
  if (html.charCodeAt(k) !== 60 || html.charCodeAt(k + 1) !== 47) return -1; // </
  if (!matchesWord(html, k + 2, "script")) return -1;
  return k + 9; // `</script>` is 9 characters
}

/** The ASCII part of JS `\s`, which is all the old `\s*` could match here. */
function isJsSpace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}

/**
 * Relink placeholder nav anchors onto the pages the demo actually emitted.
 *
 * A multi-page demo whose entire navbar is `href="#"` renders fine and
 * links to nothing: the audit that checks "does every href resolve to an
 * emitted file" reports zero dead links, because "#" is a legal target.
 * The site still cannot be navigated, which is the whole point of a
 * multi-page demo.
 *
 * Models write those placeholders when a brief implies a nav but does not
 * spell out the filenames. The label usually names the page, so match it
 * against the emitted pages: "Pricing" -> pricing.html, "Home" ->
 * index.html. Matching is exact on a slug, so a legitimate in-page anchor
 * ("skip to content", "top") never matches anything and is left alone.
 *
 * The label-to-page decision itself lives in `pageForLabel`
 * (lib/demo-link-audit), shared with the link audit: a placeholder that
 * names a real page is either relinked here or reported inert there, never
 * both missed.
 */

function relinkPlaceholderNav(html: string, pageIndex: PageSlugIndex): string {
  let out = "";
  let last = 0;
  forEachTag(html, (span) => {
    const openTag = html.slice(span.start, span.end);
    if (!openTag.toLowerCase().startsWith("<a")) return;
    const hrefAt = placeholderHrefAt(openTag);
    if (hrefAt === -1) return;
    const labelEnd = indexOfCloseAnchor(html, span.end);
    if (labelEnd === -1) return;
    const label = textBetween(html, span.end, labelEnd);
    // The SAME matcher the audit re-derives, so a placeholder that names an
    // emitted page can never survive here and then be reported as inert.
    const target = pageForLabelIn(pageIndex, label);
    if (!target || target.ambiguous) return;

    // Slice the href out by hand (a String.replace on the tag reads as a
    // sanitising sink to CodeQL) and keep the anchor's other attributes.
    out += html.slice(last, span.start);
    out +=
      openTag.slice(0, hrefAt) +
      `href="${target.page}"` +
      openTag.slice(hrefAt + 'href="#"'.length);
    last = span.end;
  });
  out += html.slice(last);
  // The rebuild reads the document once, over and above what `forEachTag`,
  // `indexOfCloseAnchor` and `textBetween` charged for the anchors themselves.
  chargeWork(html.length);
  return out;
}

/**
 * Index of `href="#"` inside an open anchor tag, or -1.
 *
 * This replaces the leading half of `/<a\b([^>]*)\bhref="#"/gi`, whose `[^>]*`
 * was what made the whole scan quadratic on an unterminated `<a` (measured at
 * 4x per doubling). `forEachTag` has already delimited the tag, so what remains
 * is a bounded search inside one short string.
 */
function placeholderHrefAt(openTag: string): number {
  return openTag.toLowerCase().indexOf('href="#"');
}

/**
 * Undo JSON-style backslash escaping inside html attributes.
 *
 * Models write data-URI favicons as `href="data:image/svg+xml,<svg
 * xmlns=\"http://www.w3.org/2000/svg\" …>"`. HTML has no backslash escape,
 * so the parser ends the attribute at the first `\"` and the remainder —
 * including a stray `">` — spills into the page as visible text above the
 * fold. Rewriting the escaped quote to a single quote keeps the attribute
 * intact AND leaves the embedded markup valid, because a double-quoted
 * attribute may legally contain single quotes.
 *
 * Manual exec loop over tags (no String.replace sink, no growth, so the
 * fixed-point loop in sanitizeDemoFiles still terminates).
 */

function unescapeAttrQuotes(html: string): string {
  let out = "";
  let last = 0;
  // `forEachTag`, not the `/<[a-zA-Z][^>]*>/g` this replaces. That pattern is
  // quadratic on an unterminated tag, and this runs inside the fixed-point loop
  // in `sanitizeDemoFiles`, so it paid the cost more than once per file.
  forEachTag(html, (span) => {
    const tag = html.slice(span.start, span.end);
    if (!tag.includes('\\"')) return;
    out += html.slice(last, span.start);
    // Same length, character for character — only \" becomes '.
    out += tag.split('\\"').join("'");
    last = span.end;
  });
  out += html.slice(last);
  // The rebuild reads the document once; the tag walk above charges itself.
  chargeWork(html.length);
  return out;
}

/**
 * Remove tags that reference files the model never emitted — broken <img>,
 * dead <script src>/<link href> — and neutralize anchors pointing at pages
 * that were never emitted (rewritten to href="#"). Small models do this
 * constantly; the demo must look complete with only its own files.
 * Deterministic, so it works regardless of model quality. Returns the
 * cleaned file set.
 *
 * Two further repairs run alongside, both deterministic:
 *  - unescapeAttrQuotes, so JSON-escaped data URIs stop leaking text
 *  - relinkPlaceholderNav, so a multi-page demo's navbar actually goes
 *    somewhere. It runs AFTER the fixed-point loop on purpose: a dead
 *    anchor that neutralization just rewrote to "#" must stay dead, and
 *    relinking only fires when the label slugs to a page that really was
 *    emitted.
 *
 * The pass is iterated TO A FIXED POINT: a removal can splice the surrounding
 * text into a NEW well-formed tag (e.g. `<im` + `<link …>` + `g src=…>`), and
 * a single chained pass would leave that new broken tag behind. Each pass
 * only deletes or rewrites in place (never grows), so the loop terminates.
 */
export function sanitizeDemoFiles(files: ProjectFile[]): ProjectFile[] {
  const emitted = new Set(files.map((f) => f.path));
  // Once for the whole set, not once per file. Slugging the page list per file
  // was O(files x pages) — measured at 4x per doubling, and still quadratic
  // after the per-anchor scan inside it was fixed, because a demo has about as
  // many files as it has pages.
  const pageIndex = buildPageSlugIndex(
    [...emitted].filter((p) => p.toLowerCase().endsWith(".html")),
  );
  return files.map((f) => {
    if (!f.path.endsWith(".html")) return f;
    let prev = f.content;
    let next = stripBrokenPass(prev, emitted);
    while (next !== prev) {
      prev = next;
      next = stripBrokenPass(prev, emitted);
    }
    next = relinkPlaceholderNav(unescapeAttrQuotes(next), pageIndex);
    return { ...f, content: next };
  });
}

/**
 * Non-streaming generation with the same degenerate-output retry as the chat
 * route: automatic retries when the model returns an unclosed fence, empty
 * output, or a file set the quality gates reject.
 *
 * Three attempts, not two. A failed generation does not ship a thin demo, it
 * REMOVES the template from the gallery (nothing stale is served, the
 * regenerate buttons are all a user has), so the extra attempt is cheap
 * insurance against a good brief losing its demo to a strict gate.
 */
async function generateTemplateFiles(
  template: TemplateDef,
  generation: Awaited<ReturnType<typeof resolveGenerationFor>>,
): Promise<ProjectFile[] | null> {
  const prompt = `${template.brief}${TEMPLATE_SUFFIX}`;
  let lastRejection: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = streamText({
        model: generation.resolved.model,
        instructions: BUILDER_SYSTEM_PROMPT,
        prompt,
      });
      let text = "";
      for await (const delta of result.textStream) {
        text += delta;
      }
      const files = extractFiles(text);
      if (files && files.length > 0 && demoLooksComplete(files)) {
        const clean = sanitizeDemoFiles(files);
        // Three questions, none of them answerable from the gallery's
        // first-page thumbnail: does it navigate, does it ship the pages the
        // brief names, and does its own JS run against its own HTML.
        if (!demoNavIsWired(clean)) {
          lastRejection = `nav gate — ${formatDemoLinkAudit(auditDemoLinks(clean))}`;
          console.log(`[templates] ${template.id}: attempt ${attempt + 1} ${lastRejection}`);
          continue;
        }
        const gates = runDemoGates(template.brief, clean);
        if (gates.ok) return clean;
        lastRejection = `quality gates — ${formatGateResult(gates)}`;
        console.log(`[templates] ${template.id}: attempt ${attempt + 1} ${lastRejection}`);
        continue;
      }
      lastRejection = null;
      console.log(
        `[templates] ${template.id}: degenerate attempt ${attempt + 1}`,
      );
    } catch (err) {
      console.error(`[templates] ${template.id}: generation error`, err);
    }
  }
  // A gate rejection produced FILES. Reporting "Generation produced no files"
  // for it told the user to try a stronger model when the real answer is
  // that the demo missed a rule — and hid the reason the template vanished
  // from the gallery.
  if (lastRejection) {
    throw new Error(
      `Demo rejected by the ${lastRejection.split(" — ")[0]} — ${lastRejection}`,
    );
  }
  return null;
}

let warmStarted = false;

/**
 * Run a generation pass over `due` templates sequentially (gentle on rate
 * limits). Shared by the startup warmup and regenerate-all; progress is
 * exposed through the warming/warmingPending status fields so the gallery
 * can poll either kind of pass.
 */
async function runPass(due: TemplateDef[], startLabel: string): Promise<void> {
  console.log(
    `[templates] ${startLabel}: ${due.map((t) => t.id).join(", ")}`,
  );
  warmActive = true;
  for (const t of due) {
    warmPending.add(t.id);
  }

  for (const t of due) {
    const started = Date.now();
    const status = await generateTemplateDemo(t);
    warmPending.delete(t.id);
    if (status) {
      console.log(
        `[templates] ${t.id}: demo cached in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
    } else {
      console.warn(
        `[templates] ${t.id}: pass generation failed — use the gallery button to retry`,
      );
    }
  }

  warmActive = false;
  console.log("[templates] pass finished");
}

/**
 * Warm the template cache once per server process: generate every template
 * that has no fresh demo yet (missing, stale brief, or stale system-prompt
 * hash), sequentially, in the background. Safe to call from
 * instrumentation.register(); failures are logged, never thrown, and any
 * template that failed stays available via the gallery's manual buttons.
 */
export async function warmTemplateCache(): Promise<void> {
  if (warmStarted) return;
  warmStarted = true;

  // Before anything else: make the cache say what a user actually gets.
  // Repairs are idempotent, so this only writes demos a newer sanitizer
  // would change — see repairCachedDemos.
  repairCachedDemos();

  if (!(await isProviderConfigured())) {
    console.log(
      "[templates] warmup skipped — no AI provider configured (gallery has manual buttons)",
    );
    return;
  }

  const due = TEMPLATES.filter((t) => !statusFor(t).ready);
  if (due.length === 0) {
    console.log("[templates] warmup skipped — all demos already cached");
    return;
  }

  await runPass(due, "warming cache in background");
}

/**
 * Re-run the sanitizer over every CACHED demo and write back what changed.
 *
 * A demo generated before a repair rule existed keeps its unrepaired bytes
 * in the library project forever: the promote route sanitizes on copy, so
 * users get a fixed site, but the cache (and the gallery iframe, which
 * renders straight from it) keeps showing the broken original. That is how
 * the SaaS navbar stayed inert in the gallery for a release after the fix
 * shipped. Repairing at BOTH boundaries — cache and promote — makes the
 * cached demo equal the promoted one, so `npm run audit:demos` measures
 * something real.
 *
 * Idempotent by construction: sanitizeDemoFiles on already-sanitized bytes
 * is a no-op, so this writes nothing on a healthy cache. Returns the number
 * of demos changed.
 */
export function repairCachedDemos(): number {
  let repaired = 0;
  for (const template of TEMPLATES) {
    const projectId = templateProjectId(template.id);
    if (!getProject(projectId)) continue;
    const files = listAppFiles(projectId);
    if (files.length === 0) continue;
    const clean = sanitizeDemoFiles(files);
    for (let i = 0; i < clean.length; i++) {
      if (clean[i].content === files[i].content) continue;
      saveAppFile(projectId, clean[i].path, clean[i].content);
      repaired++;
    }
    if (clean.some((c, i) => c.content !== files[i].content)) {
      console.log(`[templates] ${template.id}: repaired cached demo files`);
    }
  }
  return repaired;
}

/**
 * Force-regenerate every template demo (user-triggered "Regenerate all").
 * Refused while another pass is running; otherwise returns immediately and
 * the pass progresses in the background — poll getTemplateCacheStatus().
 */
export async function startRegenerateAll(): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (warmActive) {
    return { ok: false, error: "A generation pass is already running" };
  }
  // Claim the pass synchronously so two rapid requests can't both slip
  // through the async provider check below (warmActive is only otherwise
  // set inside runPass, after awaits).
  warmActive = true;
  if (!(await isProviderConfigured())) {
    warmActive = false;
    return {
      ok: false,
      error: "No AI provider configured — set one in Settings first.",
    };
  }
  // runPass re-marks the pending set; warmActive stays true throughout.
  void runPass([...TEMPLATES], "regenerating all template demos");
  return { ok: true };
}
