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

  it("carries no unbounded wildcard between two literals (its own CodeQL trip)", () => {
    // The first cut of the quoted-attribute shape was `/["'`][^]*=/`, and
    // CodeQL failed THIS PR on it: "Inefficient regular expression — may
    // cause exponential backtracking on strings containing many repetitions
    // of '\\[\\]'". A rule whose whole point is to keep a scanner red ought
    // not to be the thing that reds it, so the shape is two independent
    // tests now and this pin refuses the regex form coming back.
    const source = readFileSync(
      path.resolve(process.cwd(), "eslint-rules", "markup-sanitiser-replace.mjs"),
      "utf8",
    );
    // The flagged construct verbatim: an unbounded `[^]` (or `[\s\S]`)
    // standing between two literals. Anything looser would trip on the
    // `[^>]*` examples the rule's own comments legitimately quote.
    expect(source).not.toContain("[^]*");
    expect(source).not.toMatch(/\[\^\][^/]*?\s*[+*]/);
    // And the shape still fires, from the pattern alone.
    expect(
      lint(`const o = tag.replace(/\\s+on[a-z]+="[^"]*"/gi, "");`),
    ).toHaveLength(1);
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