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
  pageForLabel,
  textBetween,
} from "@/lib/demo-link-audit";
import { formatGateResult, runDemoGates } from "@/lib/demo-gates";
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
const BROKEN_TAG_RE =
  /[ \t]*(?:<img\b[^>]*\bsrc=["']([^"'#]+)["'][^>]*>|<script\b[^>]*\bsrc=["']([^"'#]+)["'][^>]*>\s*<\/script>|<link\b[^>]*\bhref=["']([^"'#]+)["'][^>]*>|<a\b[^>]*\bhref=["']([^"'#]+)["'][^>]*>)[ \t]*\n?/gi;

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
  BROKEN_TAG_RE.lastIndex = 0;
  for (
    let m = BROKEN_TAG_RE.exec(html);
    m !== null;
    m = BROKEN_TAG_RE.exec(html)
  ) {
    out += html.slice(last, m.index);
    last = m.index + m[0].length;
    const [tag, imgSrc, scriptSrc, linkHref, anchorHref] = m;
    if (anchorHref !== undefined) {
      if (keepAnchor(anchorHref)) {
        out += tag;
        continue;
      }
      // Compare the path part only — fragments and query strings ride
      // along on an emitted page (post.html#intro, post.html?id=2).
      const filePath = anchorHref.split("#")[0].split("?")[0].trim();
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
    const target = imgSrc ?? scriptSrc ?? linkHref;
    if (keepAsset(target)) out += tag;
  }
  out += html.slice(last);
  return out;
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
const PLACEHOLDER_ANCHOR_RE = /<a\b([^>]*)\bhref="#"/gi;

function relinkPlaceholderNav(html: string, emitted: Set<string>): string {
  const pages = [...emitted].filter((p) => p.toLowerCase().endsWith(".html"));
  let out = "";
  let last = 0;
  PLACEHOLDER_ANCHOR_RE.lastIndex = 0;
  for (
    let m = PLACEHOLDER_ANCHOR_RE.exec(html);
    m !== null;
    m = PLACEHOLDER_ANCHOR_RE.exec(html)
  ) {
    const openTag = m[0];
    const labelEnd = html.indexOf("</a>", m.index + openTag.length);
    if (labelEnd === -1) continue;
    const label = textBetween(html, m.index + openTag.length, labelEnd);
    // The SAME matcher the audit re-derives, so a placeholder that names an
    // emitted page can never survive here and then be reported as inert.
    const target = pageForLabel(label, pages);
    if (!target || target.ambiguous) continue;

    // Slice the href out by hand (a String.replace on the tag reads as a
    // sanitising sink to CodeQL) and keep the anchor's other attributes.
    const hrefAt = openTag.toLowerCase().indexOf('href="#"');
    if (hrefAt === -1) continue;
    out += html.slice(last, m.index);
    out +=
      openTag.slice(0, hrefAt) +
      `href="${target.page}"` +
      openTag.slice(hrefAt + 'href="#"'.length);
    last = m.index + openTag.length;
  }
  out += html.slice(last);
  return out;
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
const TAG_RE = /<[a-zA-Z][^>]*>/g;

function unescapeAttrQuotes(html: string): string {
  let out = "";
  let last = 0;
  TAG_RE.lastIndex = 0;
  for (
    let m = TAG_RE.exec(html);
    m !== null;
    m = TAG_RE.exec(html)
  ) {
    if (!m[0].includes('\\"')) continue;
    out += html.slice(last, m.index);
    // Same length, character for character — only \" becomes '.
    out += m[0].split('\\"').join("'");
    last = m.index + m[0].length;
  }
  out += html.slice(last);
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
  return files.map((f) => {
    if (!f.path.endsWith(".html")) return f;
    let prev = f.content;
    let next = stripBrokenPass(prev, emitted);
    while (next !== prev) {
      prev = next;
      next = stripBrokenPass(prev, emitted);
    }
    next = relinkPlaceholderNav(unescapeAttrQuotes(next), emitted);
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
