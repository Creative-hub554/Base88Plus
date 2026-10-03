/**
 * Quality gates for template demo file sets.
 *
 * Everything here answers a question the existing checks never asked. The
 * completeness guard asks "is there a body and a stylesheet"; the link audit
 * asks "do the links resolve". Both are trivially satisfied by a page that is
 * technically present and completely empty — and all six shipped demos were
 * exactly that, while passing every check. A page-by-page walk of the real
 * cached demos found:
 *
 *   - blog: a THREE-page brief shipped as ONE page. The brief names
 *     post.html, about.html and posts.js; none were emitted, so the post grid
 *     was three `href="#"` links and the page held 145 characters of text.
 *   - saas: one app.js is linked from every page (the design system requires
 *     it) but selects `#pricingTable` / `#togglePricing` / `#contactForm`
 *     unconditionally, so it threw on three of four pages. The visible
 *     damage: pricing.html's own comparison table was forced to
 *     `display:none` with no toggle on that page to restore it, and
 *     contact.html's form never attached a submit handler, so "Send" did a
 *     GET and put the user's message in the URL.
 *   - saas/portfolio/event: the body copy was literal filler — "Feature 1",
 *     "Integration 2", "Project 3", "Sponsor 1".
 *
 * So three gates, each pinned by tests. They are deliberately STRUCTURAL
 * rather than quantitative: there is no character-count floor, because a
 * number is a crude proxy for quality and a demo that cannot reach it is
 * LOST from the gallery rather than shown as thin. Thinness is answered by
 * the prompt instead (see TEMPLATE_SUFFIX), which is where it belongs.
 *
 * Dependency-free like lib/demo-link-audit.ts, so the app, vitest and the
 * scripts/ CLI can all import the same rules.
 */
import { forEachTagRun } from "./demo-link-audit";
// The `.ts` extension matches lib/demo-link-audit.ts, which the plain node CLI
// loads without extension resolution. See the comment there.
import { chargeWork } from "./perf-counter.ts";

export interface GateFile {
  path: string;
  content: string;
}

export type GateKind = "plan" | "filler" | "selector";

export interface GateProblem {
  kind: GateKind;
  detail: string;
}

export interface GateResult {
  ok: boolean;
  problems: GateProblem[];
}

/* ------------------------------------------------------------------ *
 * Plan: the brief is the file plan
 * ------------------------------------------------------------------ */

const FILE_TOKEN_RE = /\b[\w-]+\.(?:html|js|css|json)\b/gi;

/**
 * Every file the brief names must actually be emitted.
 *
 * This is the gate the #97 entry predicted was enforceable ("a lint-level
 * rule can enforce brief-as-file-plan for PAGES") and never built. Only the
 * saas and blog briefs name files at all, so it fires for exactly those two
 * and cannot false-positive on the other four.
 */
export function missingBriefFiles(brief: string, files: GateFile[]): string[] {
  // One pass over the brief. Charged as the document, for the same reason as
  // every other single-regex pass in this file: the engine's own reads are not
  // observable, and the document is the honest upper bound on them.
  chargeWork(brief.length);
  const emitted = new Set(files.map((f) => f.path.toLowerCase()));
  const wanted = new Set<string>();
  for (const m of brief.matchAll(FILE_TOKEN_RE)) {
    wanted.add(m[0].toLowerCase());
  }
  return [...wanted].filter((name) => !emitted.has(name)).sort();
}

/* ------------------------------------------------------------------ *
 * Filler: literal placeholder copy
 * ------------------------------------------------------------------ */

/**
 * Nouns that are meaningless as a NUMBERED pair. Kept tight on purpose:
 * "Tier 1/2/3" and "Step 1/2/3" are ordinary real copy and must NOT trip
 * this, so those words are absent even though the pattern would match them.
 *
 * The digit is REQUIRED. A bare domain noun is not filler — the landing demo
 * has a section simply headed "Integration", which is thin but perfectly real
 * copy, and a rule that flagged it would have failed the one demo that
 * actually earns its place in the gallery.
 */
const FILLER_WORDS = [
  "feature",
  "integration",
  "project",
  "sponsor",
  "item",
  "column",
  "placeholder",
];
const FILLER_RE = new RegExp(`\\b(${FILLER_WORDS.join("|")})\\s*\\d+\\b`, "gi");
const FILLER_OTHER_RE = /\b(your\s+text\s+here|lorem ipsum|TODO|placeholder\s+text)\b/gi;

const SCRIPT_STYLE_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Visible text of an html file: no tags, no script/style bodies. */
export function visibleText(html: string): string {
  let stripped = "";
  SCRIPT_STYLE_RE.lastIndex = 0;
  let cursor = 0;
  for (
    let m = SCRIPT_STYLE_RE.exec(html);
    m !== null;
    m = SCRIPT_STYLE_RE.exec(html)
  ) {
    stripped += html.slice(cursor, m.index);
    cursor = m.index + m[0].length;
  }
  stripped += html.slice(cursor);
  // The script/style pass, above: one read of the document. The tag walk that
  // follows charges itself through `forEachTagRun`.
  chargeWork(html.length);

  // A removed tag must LEAVE A SPACE behind it. Dropping "</li><li>" with
  // nothing in between fuses the two words into "FeaturesFeature", which no
  // word-boundary regex can see — the filler scan then finds nothing in a
  // document made entirely of filler.
  // `forEachTagRun`, not the `/<[^>]*>/g` this replaces. That pattern is
  // quadratic on an unterminated tag — measured at 4x per doubling here — and
  // the fix is to end the scan at the first `<` with no `>` ahead instead of
  // retrying at the next one. See `forEachTag` in lib/demo-link-audit.
  let text = "";
  let last = 0;
  forEachTagRun(stripped, (tag) => {
    text += stripped.slice(last, tag.start) + " ";
    last = tag.end;
  });
  text += stripped.slice(last);
  // And `split`/`join` reads the whole stripped document a third time.
  chargeWork(text.length);
  return text.split(/\s+/).filter(Boolean).join(" ");
}

export function fillerHits(files: GateFile[]): string[] {
  const hits = new Set<string>();
  // Both filler regexes read the visible text of every page; accumulated and
  // charged once rather than per match, for the cost reason in the header.
  let scanned = 0;
  for (const f of files) {
    if (!f.path.toLowerCase().endsWith(".html")) continue;
    const text = visibleText(f.content);
    scanned += text.length;
    FILLER_RE.lastIndex = 0;
    for (let m = FILLER_RE.exec(text); m !== null; m = FILLER_RE.exec(text)) {
      hits.add(m[0].trim());
    }
    FILLER_OTHER_RE.lastIndex = 0;
    for (
      let m = FILLER_OTHER_RE.exec(text);
      m !== null;
      m = FILLER_OTHER_RE.exec(text)
    ) {
      hits.add(m[0].trim());
    }
  }
  chargeWork(scanned);
  return [...hits].sort();
}

/* ------------------------------------------------------------------ *
 * Selector: the demo's own JS must run against the demo's own HTML
 * ------------------------------------------------------------------ */

const ID_RE = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const SCRIPT_SRC_RE =
  /<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
const SELECTOR_RE =
  /(?:const|let|var)\s+(\w+)\s*=\s*document\.(?:querySelector\(\s*['"]#([\w-]+)['"]\s*\)|getElementById\(\s*['"]([\w-]+)['"]\s*\))/g;
const GUARD_RE =
  /if\s*\(\s*!?\s*(\w+)\s*\)|(\w+)\s*\?\.|(\w+)\s*&&|return\s+if\s+!?\s*(\w+)/;

/** Guarded within a few lines of the binding — the defensive shape the suffix asks for. */
function isGuarded(script: string, binding: string, from: number): boolean {
  const window = script.slice(from, from + 400);
  const g = GUARD_RE.exec(window);
  if (!g) return false;
  return g.slice(1).some((name) => name === binding);
}

function idsIn(html: string): Set<string> {
  const ids = new Set<string>();
  chargeWork(html.length);
  ID_RE.lastIndex = 0;
  for (let m = ID_RE.exec(html); m !== null; m = ID_RE.exec(html)) {
    const id = m[1] ?? m[2];
    if (id) ids.add(id);
  }
  return ids;
}

function scriptsLinkedFrom(html: string): string[] {
  const out: string[] = [];
  chargeWork(html.length);
  SCRIPT_SRC_RE.lastIndex = 0;
  for (let m = SCRIPT_SRC_RE.exec(html); m !== null; m = SCRIPT_SRC_RE.exec(html)) {
    const src = (m[1] ?? m[2] ?? "").split("?")[0].trim();
    if (src) out.push(src);
  }
  return out;
}

/**
 * Every id a linked script selects must exist on the page that links it,
 * unless the script guards the lookup.
 *
 * The defect this exists for is structural, not sloppiness: the template
 * rules put ONE app.js on every page (that is how a no-build multi-page demo
 * works), so any selector is a selector against four different documents. The
 * model writes it for the page it was thinking about, and the other three
 * pages throw — silently, because the gallery only ever renders page one.
 *
 * The guard check is a documented heuristic (a null check within a few lines
 * of the binding). It errs toward REPORTING, which is the safe direction for
 * a gate: a false report costs one regeneration, a false silence ships a
 * broken demo.
 */
export function selectorProblems(files: GateFile[]): string[] {
  const byPath = new Map(files.map((f) => [f.path.toLowerCase(), f]));
  const problems: string[] = [];
  // Every linked script is read once per page that links it, plus a 400-char
  // guard window per selector it binds. Both are real passes over real
  // characters, so both are counted.
  let scanned = 0;
  for (const page of files) {
    if (!page.path.toLowerCase().endsWith(".html")) continue;
    const ids = idsIn(page.content);
    for (const src of scriptsLinkedFrom(page.content)) {
      const script =
        byPath.get(src.toLowerCase()) ??
        byPath.get(src.split("/").pop()?.toLowerCase() ?? "");
      if (!script) continue;
      scanned += script.content.length;
      SELECTOR_RE.lastIndex = 0;
      for (
        let m = SELECTOR_RE.exec(script.content);
        m !== null;
        m = SELECTOR_RE.exec(script.content)
      ) {
        const binding = m[1];
        const id = m[2] ?? m[3];
        if (!id || ids.has(id)) continue;
        // `isGuarded` slices its 400-character window whether or not the guard
        // is there, so the window is charged before the answer is known.
        scanned += 400;
        if (isGuarded(script.content, binding, m.index + m[0].length)) continue;
        problems.push(
          `${page.path} links ${script.path}, which uses #${id} unguarded — that page has no #${id}`,
        );
      }
    }
  }
  chargeWork(scanned);
  return [...new Set(problems)].sort();
}

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

export function runDemoGates(brief: string, files: GateFile[]): GateResult {
  const problems: GateProblem[] = [];
  for (const name of missingBriefFiles(brief, files)) {
    problems.push({ kind: "plan", detail: `brief names ${name}, demo never emitted it` });
  }
  for (const hit of fillerHits(files)) {
    problems.push({ kind: "filler", detail: `placeholder copy "${hit}"` });
  }
  for (const detail of selectorProblems(files)) {
    problems.push({ kind: "selector", detail });
  }
  return { ok: problems.length === 0, problems };
}

export function formatGateProblem(p: GateProblem): string {
  return `${p.kind}: ${p.detail}`;
}

export function formatGateResult(r: GateResult): string {
  return r.problems.map(formatGateProblem).join("; ");
}
