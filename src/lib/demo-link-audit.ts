// ---------------------------------------------------------------------------
// Tag scanning — linear, and shared so three callers cannot disagree
// ---------------------------------------------------------------------------

/** A tag found by `forEachTag`: `[start, end)` of the original string. */
export type TagSpan = {
  /** Index of the `<`. */
  start: number;
  /** Index just past the `>`. */
  end: number;
};

/** ASCII letter, either case. */
function isAsciiLetter(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

/**
 * Visit every `<name ...>` tag — a `<` followed by an ASCII letter, running to
 * the first `>` after it. Exactly what `/<[a-zA-Z][^>]*>/g` matched.
 *
 * WHY NOT THE REGEX ANYMORE: that shape is quadratic on any document with an
 * unterminated tag. `[^>]*` cannot cross a `>`, so a `<` with no `>` after it
 * makes the engine consume the rest of the file looking for one, fail, advance
 * a character, and try again at the next `<` — a full pass over the remainder
 * for every unmatched `<`. Measured at 4x per doubling of the input, in four
 * separate scanners: this module's tag walk and `textBetween`, the demo gates'
 * `visibleText`, and the sanitiser's `unescapeAttrQuotes` (which sits inside a
 * fixed-point loop and so pays it more than once).
 *
 * A cleverer regex does not help. Possessive quantifiers do not apply, because
 * the cost is the engine retrying at the next `<`, not backtracking inside one
 * attempt. The fix is the loop structure, and it rests on one observation: if
 * there is no `>` after a position then there is none after any later position
 * either, so no tag can begin anywhere ahead of us. So "no `>` ahead" ends the
 * scan instead of failing one attempt.
 *
 * Behaviour is deliberately unchanged, awkward cases included. A tag still runs
 * to the FIRST `>` after its `<`, so a `>` inside a quoted attribute truncates
 * it here exactly as it did before, which callers already lived with. A `<` not
 * followed by a letter is still skipped one character at a time, so a real tag
 * later in the string can still match.
 */
export function forEachTag(
  html: string,
  visit: (tag: TagSpan) => void,
  from = 0,
  limit = Number.POSITIVE_INFINITY,
): void {
  let pos = from;
  while (pos < html.length && pos < limit) {
    const lt = html.indexOf("<", pos);
    if (lt === -1 || lt >= limit) return;
    // The regex required a letter after `<`. Without one it is not a tag, and
    // the engine moved on by a single character — so do the same, rather than
    // jumping to the next `<`, which would step over a real tag in between.
    if (!isAsciiLetter(html.charCodeAt(lt + 1))) {
      pos = lt + 1;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) return;
    visit({ start: lt, end: gt + 1 });
    pos = gt + 1;
  }
}

/**
 * Visit every `<...>` run, including a `<` not followed by a letter — the
 * behaviour of `/<[^>]*>/g`. Used where the point is to find tag-shaped
 * delimiters in text being stripped, so `3 < 5 and 6 > 2` still has its
 * bracket removed exactly as it did before. Linear for the same reason as
 * `forEachTag`, minus the letter check.
 *
 * `limit` bounds the search to html[from, limit). It matters: without it a
 * caller scanning a small window inside a large document pays for the whole
 * remainder of that document, which is quadratic once the window is asked for
 * once per link. `textBetween` is the caller that needs it.
 */
export function forEachTagRun(
  html: string,
  visit: (tag: TagSpan) => void,
  from = 0,
  limit = Number.POSITIVE_INFINITY,
): void {
  let pos = from;
  while (pos < html.length && pos < limit) {
    const lt = html.indexOf("<", pos);
    // No `<` before the limit: nothing left in the window.
    if (lt === -1 || lt >= limit) return;
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) return;
    visit({ start: lt, end: gt + 1 });
    pos = gt + 1;
  }
}

/** The tag text for a span, for callers that need it as a string. */
export function tagText(html: string, tag: TagSpan): string {
  return html.slice(tag.start, tag.end);
}

/**
 * Index of the next `</a>` in any case at or after `from`, or -1.
 * Exported because the sanitiser's relinker needs the same search.
 *
 * This was `html.toLowerCase().indexOf("</a>", tagEnd)`, which lowercased the
 * WHOLE document once per anchor — so a page with L links cost O(L x page), and
 * the measured curve was 4x per doubling.
 *
 * Comparing character codes instead of lowercasing also removes a latent index
 * bug: `toLowerCase` can change a string's LENGTH (U+0130 lowercases to two
 * code points), which would shift every index after it and make the label read
 * from the wrong offset. Matching single ASCII characters cannot shift that.
 */
export function indexOfCloseAnchor(html: string, from: number): number {
  for (let i = from; i + 4 <= html.length; i += 1) {
    if (html.charCodeAt(i) !== 60) continue; // <
    if (html.charCodeAt(i + 1) !== 47) continue; // /
    const letter = html.charCodeAt(i + 2);
    if (letter !== 97 && letter !== 65) continue; // a or A
    if (html.charCodeAt(i + 3) !== 62) continue; // >
    return i;
  }
  return -1;
}
/**
 * Link resolution for template demo file sets.
 *
 * One rule, shared by three callers so they cannot disagree:
 *  - `relinkPlaceholderNav` (template-generation) uses `pageForLabel` to
 *    decide which emitted page a `href="#"` nav item was MEANT to point at;
 *  - `auditDemoLinks` here re-derives the same decision to prove the
 *    relinker had a target to work with;
 *  - `demoLooksNavigable` is the generation gate.
 *
 * Why the audit exists at all: the original link audit answered "does every
 * href resolve to an emitted file?" and reported zero dead links on a SaaS
 * demo whose entire navbar was `href="#"`. "#" is a legal target, so a
 * resolved link is not a working link — the audit was green on a site that
 * could not be navigated at all. `inert` is that blind spot, named: a
 * placeholder href whose LABEL names a page the demo actually emitted.
 * Such a link is always wrong — the target is known, and
 * `relinkPlaceholderNav` was supposed to have wired it up. If one survives
 * into a cached demo, the relinker and the audit disagree, and that is a bug
 * worth regenerating over.
 *
 * A placeholder href whose label names nothing is NOT a failure: "skip to
 * content", "back to top" and a single-page demo's own buttons all land
 * there legitimately. They are counted (`placeholders`) and reported, never
 * failed.
 *
 * Deliberately dependency-free (no fs, no node builtins, no `@/` alias) so
 * the same file is importable from the app, from vitest, and from the plain
 * node CLI in scripts/demo-link-audit.mjs.
 */

export interface DemoAuditFile {
  path: string;
  content: string;
}

/** Why a link is a problem: it resolves to nothing, or it resolves to nothing BY NAME. */
export type DemoLinkReason = "dead" | "inert";

export interface DemoLinkProblem {
  /** File the link was found in. */
  file: string;
  reason: DemoLinkReason;
  /** The href/src value exactly as written. */
  target: string;
  /** The anchor's visible label, when the link sits in an `<a>`. */
  label?: string;
  /** For an inert nav item: the emitted page its label names. */
  page?: string;
}

export interface DemoLinkAudit {
  /** href/src attributes examined (external URLs are not links, and are not counted). */
  checked: number;
  problems: DemoLinkProblem[];
  dead: DemoLinkProblem[];
  inert: DemoLinkProblem[];
  /** `href="#"` / `href=""` links naming no emitted page — legal, counted only. */
  placeholders: number;
  ok: boolean;
}

/** Slug of a link label or a page stem: "About Us" and "about_us" both slug to "about-us". */
export function linkPageSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

/** Which emitted page (if any) a nav label names. */
export type LabelTarget =
  | { page: string; ambiguous: false }
  | { page: null; ambiguous: true };

/**
 * The page a nav label names, or null when it names none.
 *
 * Exact on the slug, and "Home" is index.html. Two pages slugging to the
 * same word (about-us.html and about_us.html) is a coin flip, so it answers
 * `ambiguous` and the caller leaves the placeholder alone rather than
 * guessing — a wrong guess is worse than a visible placeholder, which at
 * least reads as unfinished.
 */
export function pageForLabel(label: string, pages: string[]): LabelTarget | null {
  return pageForLabelIn(buildPageSlugIndex(pages), label);
}

/**
 * Slug of each emitted page -> the pages that slug to it.
 *
 * The label-to-page lookup is asked once per nav link over the whole page list,
 * so answering it by scanning and re-slugging every page each time is
 * O(links x pages) and re-slugifies the same filenames hundreds of times.
 * Measured at 113ms for 800 links against 800 pages, growing 4x per doubling.
 * Both hot callers (`auditDemoLinks`, `relinkPlaceholderNav`) build this once
 * and answer in constant time.
 *
 * A bucket holds every colliding page rather than a single winner, because the
 * ambiguity guard needs to know a second one exists.
 */
export type PageSlugIndex = Map<string, string[]>;

/** Build the index `pageForLabelIn` answers from. */
export function buildPageSlugIndex(pages: string[]): PageSlugIndex {
  const index: PageSlugIndex = new Map();
  for (const page of pages) {
    // Slug the STEM, don't compare it raw: about_us.html must collide with
    // about-us.html, which is the whole point of the ambiguity guard.
    const slug = linkPageSlug(pageStem(page));
    const bucket = index.get(slug);
    if (bucket === undefined) index.set(slug, [page]);
    else bucket.push(page);
  }
  return index;
}

/** `pageForLabel` against a prebuilt index — same answer, no per-label scan. */
export function pageForLabelIn(
  index: PageSlugIndex,
  label: string,
): LabelTarget | null {
  const slug = linkPageSlug(label);
  if (slug === "") return null;
  const key = slug === "home" ? "index" : slug;
  const bucket = index.get(key);
  if (bucket === undefined) return null;
  if (bucket.length > 1) return { page: null, ambiguous: true };
  return { page: bucket[0], ambiguous: false };
}

function pageStem(page: string): string {
  return page.toLowerCase().endsWith(".html")
    ? page.slice(0, -".html".length)
    : page;
}

/**
 * Text content of html[from, to) with any tags dropped.
 *
 * Manual exec loop rather than `.replace(/<[^>]*>/g, "")`: CodeQL reads a
 * String.replace that strips markup as an *incomplete sanitiser* and reports
 * the surviving string as a possible `<script` injection, even though the
 * value never reaches the page (it is only slugged).
 */
export function textBetween(html: string, from: number, to: number): string {
  let out = "";
  let last = from;
  forEachTagRun(
    html,
    (tag) => {
      // A tag that ends past `to` is not ours: the old loop stopped there and
      // left `last` alone, and so does this.
      if (tag.end > to) return;
      out += html.slice(last, tag.start);
      last = tag.end;
    },
    from,
    to,
  );
  out += html.slice(last, to);
  return out.trim();
}

/**
 * Text content of html[from, to) with any tags dropped.
 *
 * The walk is `forEachTagRun`, not the `/<[^>]*>/g` this used to be. That
 * pattern is quadratic on an unterminated tag — every `<` makes the engine
 * scan the rest of the file for a `>` that never comes, then retry at the next
 * `<` — and a truncated model response ends mid-tag often enough to matter.
 * See `forEachTagRun` above for why the loop structure is the fix. (This
 * comment pointed at `lib/html-tags.ts`, a module that was never merged — the
 * scanner ended up living here.)
 */
/** The label of the `<a>` whose open tag ends at `tagEnd`, or "" if unterminated. */
export function anchorLabelAt(html: string, tagEnd: number): string {
  const closeAt = indexOfCloseAnchor(html, tagEnd);
  if (closeAt === -1) return "";
  return textBetween(html, tagEnd, closeAt);
}

/**
 * Resolve a link target against the emitted file set.
 *
 * A static demo can only navigate among its own files, so a rooted path is
 * read as site-rooted ("/pricing" -> "pricing.html") rather than as "leaves
 * the demo" — the sanitizer already refuses to keep a rooted anchor, so
 * anything that reaches here is a file that should exist.
 */
export function resolveDemoPath(fromFile: string, rawPath: string): string {
  const base = rawPath.startsWith("/")
    ? []
    : fromFile.split("/").slice(0, -1);
  const out: string[] = [];
  for (const part of base.concat(rawPath.split("/"))) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.length === 0 ? "index.html" : out.join("/");
}

const AUDIT_ATTR_RE =
  /\b(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gi;
const AUDIT_ID_RE = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gi;

/** Any scheme (http:, mailto:, data:, tel:) or protocol-relative — not a link inside the demo. */
function isExternalRef(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//");
}

function tagNameOf(tag: string): string {
  const name = tag.slice(1).split(/[\s/>]/)[0] ?? "";
  return name.toLowerCase();
}

function attrValue(m: RegExpExecArray): string {
  return m[2] ?? m[3] ?? m[4] ?? "";
}

/** AUDIT_ID_RE has no leading name group, so its value slots start at 1. */
function idValue(m: RegExpExecArray): string {
  return m[1] ?? m[2] ?? m[3] ?? "";
}

function collectIds(html: string): Set<string> {
  const ids = new Set<string>();
  AUDIT_ID_RE.lastIndex = 0;
  for (let m = AUDIT_ID_RE.exec(html); m !== null; m = AUDIT_ID_RE.exec(html)) {
    const id = idValue(m);
    if (id) ids.add(id);
  }
  AUDIT_ID_RE.lastIndex = 0;
  return ids;
}

/**
 * Every href/src in a demo's html, resolved against the emitted file set.
 *
 * Two failure classes, both fatal to the demo:
 *  - `dead`   — the target is not among the emitted files (or a same-page
 *               `#fragment` names an id the page does not have);
 *  - `inert`  — the target is the placeholder "#" AND the anchor's label
 *               names an emitted page, so the correct link is knowable and
 *               the demo is failing to use it.
 */
export function auditDemoLinks(files: DemoAuditFile[]): DemoLinkAudit {
  const emitted = new Set(files.map((f) => f.path));
  const pages = files
    .map((f) => f.path)
    .filter((p) => p.toLowerCase().endsWith(".html"));
  // One index for every link on every page: the label lookup used to re-scan
  // and re-slug this list once per placeholder link.
  const pageIndex = buildPageSlugIndex(pages);
  const problems: DemoLinkProblem[] = [];
  let checked = 0;
  let placeholders = 0;

  for (const file of files) {
    if (!file.path.toLowerCase().endsWith(".html")) continue;
    const html = file.content;
    const ids = collectIds(html);
    forEachTag(html, (span) => {
      const tag = html.slice(span.start, span.end);
      const label =
        tagNameOf(tag) === "a" ? anchorLabelAt(html, span.end) : undefined;
      AUDIT_ATTR_RE.lastIndex = 0;
      for (
        let a = AUDIT_ATTR_RE.exec(tag);
        a !== null;
        a = AUDIT_ATTR_RE.exec(tag)
      ) {
        const target = attrValue(a).trim();
        if (target === "" || isExternalRef(target)) continue;
        checked++;

        const hashAt = target.indexOf("#");
        const beforeHash = hashAt === -1 ? target : target.slice(0, hashAt);
        const fragment = hashAt === -1 ? "" : target.slice(hashAt + 1);
        const queryAt = beforeHash.indexOf("?");
        const pathPart = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);

        if (pathPart === "") {
          // "#", "" or "?x=1" — the placeholder. Same-page "#id" is a real
          // target and must exist; bare "#" is only a defect when the label
          // says which page it should have been.
          if (fragment !== "") {
            if (!ids.has(fragment)) {
              problems.push({ file: file.path, reason: "dead", target, label });
            }
            continue;
          }
          if (label !== undefined) {
            const named = pageForLabelIn(pageIndex, label);
            if (named && !named.ambiguous) {
              problems.push({
                file: file.path,
                reason: "inert",
                target,
                label,
                page: named.page,
              });
              continue;
            }
          }
          placeholders++;
          continue;
        }

        if (!emitted.has(resolveDemoPath(file.path, pathPart))) {
          problems.push({ file: file.path, reason: "dead", target, label });
        }
      }
    });
  }

  const dead = problems.filter((p) => p.reason === "dead");
  const inert = problems.filter((p) => p.reason === "inert");
  return {
    checked,
    problems,
    dead,
    inert,
    placeholders,
    ok: problems.length === 0,
  };
}

/** One line per problem, for a generation log or a CLI report. */
export function formatDemoLinkProblem(p: DemoLinkProblem): string {
  const from = `${p.file} "${p.target}"`;
  if (p.reason === "inert") {
    return `${from} is inert — label "${p.label}" names ${p.page}`;
  }
  return p.label ? `${from} does not resolve (link text "${p.label}")` : `${from} does not resolve`;
}

export function formatDemoLinkAudit(audit: DemoLinkAudit): string {
  if (audit.ok) {
    return `${audit.checked} link(s) checked, all resolve`;
  }
  return audit.problems.map(formatDemoLinkProblem).join("; ");
}

/**
 * Generation gate: a demo is only cached when its navbar is actually wired.
 *
 * ONLY the inert class is fatal, and the asymmetry is deliberate:
 *
 *  - `inert` is a defect with no excuse. The correct target is knowable (the
 *    label names an emitted page), `relinkPlaceholderNav` was supposed to
 *    have wired it, and shipping it means a site that cannot be navigated.
 *  - `dead` is ordinary model sloppiness — a landing demo's footer linking
 *    to `#terms` when there is no terms section is extremely common, and
 *    failing generation over it would throw away an otherwise good demo
 *    rather than improve it. It is measured and reported
 *    (`npm run audit:demos`), not gated.
 *
 * Pairs with `demoLooksComplete`, which guards truncation and styling. Both
 * guard what a first-page preview cannot show.
 */
export function demoNavIsWired(files: DemoAuditFile[]): boolean {
  return auditDemoLinks(files).inert.length === 0;
}
