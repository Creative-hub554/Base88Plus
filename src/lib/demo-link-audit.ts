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
  const slug = linkPageSlug(label);
  if (slug === "") return null;
  const key = slug === "home" ? "index" : slug;
  let found: string | null = null;
  for (const page of pages) {
    // Slug the STEM, don't compare it raw: about_us.html must collide with
    // about-us.html, which is the whole point of the ambiguity guard.
    if (linkPageSlug(pageStem(page)) === key) {
      if (found !== null) return { page: null, ambiguous: true };
      found = page;
    }
  }
  return found === null ? null : { page: found, ambiguous: false };
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
const LABEL_TAG_RE = /<[^>]*>/g;

export function textBetween(html: string, from: number, to: number): string {
  let out = "";
  let last = from;
  LABEL_TAG_RE.lastIndex = from;
  for (
    let m = LABEL_TAG_RE.exec(html);
    m !== null && m.index + m[0].length <= to;
    m = LABEL_TAG_RE.exec(html)
  ) {
    out += html.slice(last, m.index);
    last = m.index + m[0].length;
  }
  LABEL_TAG_RE.lastIndex = 0;
  out += html.slice(last, to);
  return out.trim();
}

/** The label of the `<a>` whose open tag ends at `tagEnd`, or "" if unterminated. */
export function anchorLabelAt(html: string, tagEnd: number): string {
  const closeAt = html.toLowerCase().indexOf("</a>", tagEnd);
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

const AUDIT_TAG_RE = /<[a-zA-Z][^>]*>/g;
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
  const problems: DemoLinkProblem[] = [];
  let checked = 0;
  let placeholders = 0;

  for (const file of files) {
    if (!file.path.toLowerCase().endsWith(".html")) continue;
    const html = file.content;
    const ids = collectIds(html);
    AUDIT_TAG_RE.lastIndex = 0;
    for (
      let t = AUDIT_TAG_RE.exec(html);
      t !== null;
      t = AUDIT_TAG_RE.exec(html)
    ) {
      const tag = t[0];
      const label =
        tagNameOf(tag) === "a" ? anchorLabelAt(html, t.index + tag.length) : undefined;
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
            const named = pageForLabel(label, pages);
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
    }
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
