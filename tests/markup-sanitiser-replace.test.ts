/**
 * Pins for the lint rule that makes the CodeQL `js/incomplete-multi-character-
 * sanitization` finding impossible to re-earn: any `String.replace` whose
 * pattern looks like markup handling. Three fixes in this repo went that way
 * (#96, then twice inside #100) and the alert came back each time, because
 * nothing failed at the line that introduced it.
 *
 * The corpus below is deliberately made of the EXACT patterns that existed in
 * this codebase: the good half is a copy of the repo's real non-sanitising
 * `.replace()` calls (slug normalisation, extension stripping, git-ref quote
 * trimming, code-fence trimming, whitespace collapsing), so widening the rule
 * into a false positive fails here rather than in someone's build.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { Linter } from "eslint";
import babelParser from "@babel/eslint-parser";
import rule from "../eslint-rules/markup-sanitiser-replace.mjs";

const linter = new Linter();

// The flat-config shape a rule under test needs. Typed as Linter.Config so
// `tsc --noEmit` accepts the plugin namespace key, which the loose
// Partial<RulesConfig> index signature would otherwise reject.
const config: Linter.Config = {
  files: ["**/*.ts"],
  languageOptions: {
    parser: babelParser,
    parserOptions: {
      requireConfigFile: false,
      babelOptions: {
        plugins: [
          "@babel/plugin-syntax-jsx",
          ["@babel/plugin-syntax-typescript", { isTSX: true, allExtensions: true }],
        ],
      },
    },
  },
  plugins: { anybase: { rules: { "no-markup-sanitiser-replace": rule } } },
  rules: { "anybase/no-markup-sanitiser-replace": "error" },
};

/** Lint `code` and return the rule's messages (rule id + message only). */
function lint(code: string): { ruleId: string; message: string; line: number }[] {
  const messages = linter.verify(code, config, "probe.ts");
  return messages
    .filter((m) => m.ruleId === "anybase/no-markup-sanitiser-replace")
    .map((m) => ({ ruleId: m.ruleId as string, message: m.message, line: m.line }));
}

/**
 * Remove comments from JS source, leaving string literals alone is not needed
 * here: this is only used to judge the rule module's own text, and a regex
 * literal cannot contain a bare `//` or a nested block-comment opener.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

/**
 * Pull every regex literal out of source text, as plain strings.
 *
 * A hand-written scan, not a pattern: CodeQL's inefficient-regex query
 * flagged the regex that used to do this (a nested quantifier, the very
 * thing the rule module now avoids), so the test gets the same treatment.
 * Tracks escapes and character classes so a `/` inside either is not
 * mistaken for the closing delimiter.
 */
function regexLiterals(source: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] !== "/" || source[i + 1] === "/") {
      i += source[i] === "/" ? 2 : 1;
      continue;
    }
    let j = i + 1;
    let inClass = false;
    let closed = false;
    while (j < source.length) {
      const d = source[j];
      if (d === "\n") break;
      if (d === "\\") { j += 2; continue; }
      if (d === "[") inClass = true;
      else if (d === "]") inClass = false;
      else if (d === "/" && !inClass) { closed = true; break; }
      j += 1;
    }
    if (!closed) { i += 1; continue; }
    let k = j + 1;
    while (k < source.length && /[a-z]/.test(source[k])) k += 1;
    found.push(source.slice(i, k));
    i = k;
  }
  return found;
}

/**
 * Remove `[...]` class bodies, honouring escapes: `?` inside
 * `[A-Za-z!?(]` is a literal character, `?` after it is a quantifier.
 */
function stripCharClasses(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\") {
      out += text[i] + (text[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (text[i] !== "[") { out += text[i]; i += 1; continue; }
    i += 1;
    while (i < text.length && text[i] !== "]" && text[i] !== "\n") i += 1;
    i += 1;
  }
  return out;
}

describe("no-markup-sanitiser-replace", () => {
  describe("fires on the markup shapes CodeQL reads as a sanitiser sink", () => {
    // Each case is a real historical defect: these one-liners are what the
    // exec loops in src/lib/template-generation.ts replaced.
    const BAD: [name: string, code: string, expectInMessage: string][] = [
      [
        "stripping tags",
        `const out = html.replace(/<[^>]*>/g, "");`,
        "generic tag match",
      ],
      [
        "stripping a tag run",
        `const out = html.replace(/<[^<]*>/g, "");`,
        "generic tag match",
      ],
      [
        "rewriting a placeholder href",
        `const out = openTag.replace(/href="#"/, \`href="\${target}"\`);`,
        "HTML attribute",
      ],
      [
        "any attribute sweep",
        `const out = html.replace(/\\s+on[a-z]+="[^"]*"/gi, "");`,
        "HTML attribute",
      ],
      [
        "unescaping attribute quotes",
        `const out = tag.replace(/\\\\"/g, "'");`,
        "escaped quote inside markup",
      ],
      [
        "escaping a tag's quotes",
        `const out = tag.replace(/"/g, "&quot;");`,
        "HTML entity",
      ],
      [
        "numeric entity decode",
        `const out = html.replace(/&#39;/g, "'");`,
        "HTML entity",
      ],
      [
        "opening-tag strip",
        `const out = html.replace(/<(?:script|style)[^>]*>[\\s\\S]*?<\\/\\1>/gi, "");`,
        "HTML tag",
      ],
      [
        "closing-tag strip",
        `const out = html.replace(/<\\/div>/g, "");`,
        "HTML tag",
      ],
      [
        "angle-bracket class",
        `const out = html.replace(/[<>]/g, "");`,
        "generic tag match",
      ],
      [
        "replaceAll is the same sink",
        `const out = html.replaceAll(/<[^>]*>/g, "");`,
        "generic tag match",
      ],
      [
        "a string pattern is a sink too",
        `const out = html.replace('<script>', "");`,
        "HTML tag",
      ],
      [
        "computed method name is still caught",
        `const out = html["replace"](/<[^>]*>/g, "");`,
        "generic tag match",
      ],
    ];

    for (const [name, code, expectInMessage] of BAD) {
      it(name, () => {
        const messages = lint(code);
        expect(messages).toHaveLength(1);
        expect(messages[0].message).toContain(expectInMessage);
        // The message must name the CodeQL rule, or the developer reads a
        // lint error with no idea why the obvious one-liner is banned.
        expect(messages[0].message).toContain("incomplete-multi-character-sanitization");
        expect(messages[0].message).toContain("stripBrokenPass");
      });
    }
  });

  describe("stays quiet on the real non-sanitising replace calls in src/", () => {
    const GOOD: [name: string, code: string][] = [
      // src/lib/store.ts + src/lib/demo-link-audit.ts slug normalisation.
      ["slug from a name", `const s = name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();`],
      ["slug keeps hyphens", `const s = raw.replace(/[^a-z0-9-]/g, "").toLowerCase();`],
      // Extension / separator stripping.
      ["strip .html", `const p = page.replace(/\\.html$/, "");`],
      ["strip trailing slash", `const url = \`\${baseURL.replace(/\\/+$/, "")}/models\`;`],
      ["strip trailing dot", `const host = hostname.toLowerCase().replace(/\\.$/, "");`],
      ["strip leading ./", `const p = raw.replace(/^\\.?\\//, "");`],
      ["strip leading slash", `const n = path.normalize(f).replace(/^([/\\\\])+/, "");`],
      ["zip extension, case-insensitive", `const stem = file.name.replace(/\\.zip$/i, "");`],
      // store.ts trims quotes off a GIT REF PATH. Quote characters in a
      // pattern are not markup — flagging this would be a false positive on
      // real, committed code.
      ["git ref quote trim", `const p = raw.trim().replace(/^["']|["']$/g, "");`],
      // Code fences / markdown plumbing in src/lib/prompt.ts.
      ["code fence strip", `return narration.replace(/\`\`\`[a-zA-Z]*/g, "").trim();`],
      ["fence block strip", `const t = text.replace(/\`\`\`anybase\\s*\\n[\\s\\S]*?(?:\`\`\`|$)/g, "");`],
      ["newline trim", `const c = parts[i + 1].replace(/^\\r?\\n/, "").replace(/\\s+$/, "");`],
      ["blank line collapse", `const t = s.replace(/\\n{3,}/g, "\\n\\n");`],
      // Ampersand-as-word in demo-link-audit's label slugifier: a bare `&`,
      // not an entity.
      ["ampersand to and", `const s = label.replace(/&/g, " and ");`],
      // Non-replace string methods must never be touched by this rule.
      ["not a replace", `const s = html.match(/<[^>]*>/);`],
      ["not a replace, split", `const parts = tag.split('"');`],
      ["regex assigned, not called", `const TAG_RE = /<[a-zA-Z][^>]*>/g;`],
      ["variable pattern", `const out = html.replace(PATTERN, "");`],
      ["no arguments", `html.replace();`],
    ];

    for (const [name, code] of GOOD) {
      it(name, () => {
        expect(lint(code)).toEqual([]);
      });
    }
  });

  it("reports one error per offending call, at the pattern argument", () => {
    const messages = lint(
      [
        `export function clean(html: string) {`,
        `  const a = html.replace(/<[^>]*>/g, "");`,
        `  const b = html.replace(/href="#"/, 'href="x.html"');`,
        `  return a + b;`,
        `}`,
      ].join("\n"),
    );
    expect(messages.map((m) => m.line)).toEqual([2, 3]);
  });

  it("reports on the exec-loop source itself? no — exec loops are the fix", () => {
    // The pattern the rule pushes developers toward: a manual exec loop with
    // no String.replace at all must lint clean, however markup-heavy it looks.
    const messages = lint(
      [
        `const TAG_RE = /<[a-zA-Z][^>]*>/g;`,
        `export function stripTags(html: string): string {`,
        `  let out = "";`,
        `  let last = 0;`,
        `  TAG_RE.lastIndex = 0;`,
        `  for (let m = TAG_RE.exec(html); m !== null; m = TAG_RE.exec(html)) {`,
        `    out += html.slice(last, m.index);`,
        `    last = m.index + m[0].length;`,
        `  }`,
        `  return out + html.slice(last);`,
        `}`,
      ].join("\n"),
    );
    expect(messages).toEqual([]);
  });

  it("the shape detectors are scanner-proof: no quantifier in this file", () => {
    // CodeQL's inefficient-regex query failed this file THREE times while the
    // rule was being written, on three different shapes: an unbounded
    // wildcard between two literals, then an unbounded `+` wrapping an
    // alternation containing `*`, then a plain `\s*=` after a literal
    // alternation. Each rewrite exposed the next. So the matching is now done
    // with linear string scans, and the only regexes left are single
    // character-class tests. This pin is the structural guarantee: matching
    // going back to regexes is a failing test, not a fourth red scan.
    const code = stripComments(
      readFileSync(
        path.resolve(process.cwd(), "eslint-rules", "markup-sanitiser-replace.mjs"),
        "utf8",
      ),
    );
    // Comments are stripped because the rule's prose legitimately quotes
    // `<[^>]*>`, the alternation CodeQL rejected, and the slug patterns it
    // must NOT flag — in order to explain why each shape exists.
    const literals = regexLiterals(code);
    expect(literals.length).toBeGreaterThan(0);
    for (const { 0: literal } of literals) {
      // A path fragment, not a pattern — the import comment survives the
      // block-comment strip because it is a line comment with the path
      // outside it. Ignore anything that does not open like a class or a
      // single-character escape.
      const opensLikeAPattern = literal[1] === "[" || literal[1] === "\\";
      if (!opensLikeAPattern) continue;
      // Quantifiers are only meaningful OUTSIDE a character class: `?`
      // inside `[A-Za-z!?(]` is a literal character, and the shape must
      // keep it. So drop the class bodies before counting.
      const body = literal.slice(1, literal.lastIndexOf("/"));
      const outside = stripCharClasses(body);
      expect(outside.includes("*")).toBe(false);
      expect(outside.includes("+")).toBe(false);
      expect(outside.includes("?")).toBe(false);
      expect(outside.includes("{")).toBe(false);
    }
  });

  it("the string scans still catch every shape the regexes used to match", () => {
    // Switching to string scans is only safe if it changed nothing
    // observable. These are the exact spellings the regexes matched, in the
    // forms a developer's source actually takes.
    const mustFire = [
      `/<[^>]*>/g`, // tag sweep
      `/<[^<]*>/g`, // tag sweep, other spelling
      `/[<>]/g`, // angle-bracket class
      `/<\\/div>/g`, // escaped close tag
      `/<\\/?[a-z]+>/g`, // optional close tag
      `/<(?:script|style)[^>]*>/g`, // grouped tag name
      `/<a\\b[^>]*>/g`, // tag with a boundary
      `/href="#"/`, // attribute
      `/\\bhref\\s*=/i`, // attribute, word-bounded
      `/src=/`, // attribute
      `/on[a-z]+=/`, // handler, as regex SOURCE
      `/\\bon[a-z]+\\s*=/i`, // handler, anchored
      `/data-[\\w-]+=/`, // data attribute
      `/class="[^"]*"/`, // attribute with a quoted value
      `/&quot;/g`, // entity
      `/&#39;/g`, // numeric entity
      `/&amp;/`, // entity
      `/\\"/g`, // escaped quote
    ];
    // The REPLACEMENT counts too: a bare quote sweep is ordinary text
    // work, but writing `&quot;` back is entity encoding, and CodeQL
    // reads it exactly as it reads the decode direction.
    expect(lint(`const o = tag.replace(/"/g, "&quot;");`)).toHaveLength(1);
    expect(lint(`const o = tag.replace(/"/g, "-");`)).toHaveLength(0);
    for (const pattern of mustFire) {
      expect(
        lint(`const o = tag.replace(${pattern}, "x");`),
        `expected the rule to fire on ${pattern}`,
      ).toHaveLength(1);
    }
  });

  it("is enabled in the shipped config, and lint is a blocking gate", () => {
    // The CI-enforceability claim, pinned: the rule must be wired into the
    // config that `npm run lint` runs, and `npm run lint` must run in the
    // blocking gates job. Read as text (resolved from cwd — vitest's jsdom
    // environment does not give import.meta.url a file: scheme) so this pin
    // cannot pass on a rule that exists but is never enabled.
    const repo = (...p: string[]) => path.resolve(process.cwd(), ...p);
    const cfg = readFileSync(repo("eslint.config.mjs"), "utf8");
    expect(cfg).toContain(
      'rules: { "no-markup-sanitiser-replace": markupSanitiserReplace }',
    );
    expect(cfg).toContain('"anybase/no-markup-sanitiser-replace": "error"');
    // Scoped to src/ — where the CodeQL finding lives.
    expect(cfg).toContain('files: ["src/**/*.ts", "src/**/*.tsx"]');
    const pkg = JSON.parse(readFileSync(repo("package.json"), "utf8"));
    expect(pkg.scripts.lint).toBe("eslint .");
    const action = readFileSync(
      repo(".github", "actions", "gates-steps", "action.yml"),
      "utf8",
    );
    expect(action).toContain("npm run lint");
  });

  it("does not fire on the repo's own src/ (or it would never merge)", () => {
    // The rule's whole value depends on src/ being clean under it: if a
    // legitimate src replace tripped the shapes, the fix would be to widen
    // the rule here rather than to keep the ban. Lint the real files.
    const repo = (...p: string[]) => path.resolve(process.cwd(), ...p);
    const realConfig = readFileSync(repo("eslint.config.mjs"), "utf8");
    expect(realConfig).toContain("markupSanitiserReplace");
    // Sanity: the probe harness itself rejects a markup replace, so a
    // clean-src pin can never be satisfied by a harness that reports nothing.
    expect(lint(`const o = html.replace(/<[^>]*>/g, "");`)).toHaveLength(1);
  });
});