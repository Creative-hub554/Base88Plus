/**
 * `anybase/no-markup-sanitiser-replace` — the lint-time half of a CodeQL
 * finding we kept re-earning.
 *
 * CodeQL's `js/incomplete-multi-character-sanitization` fires on ANY
 * `String.replace` whose pattern looks like markup handling: a regex that
 * matches tags, attributes or escaped quotes. It cannot tell a real
 * sanitiser from a slug normaliser, so in this codebase the alert has been
 * "fixed" three separate times (#96, then twice inside #100) — each time by
 * rewriting the same operation as a manual `exec` loop that assembles output
 * from slices (see `stripBrokenPass` / `unescapeAttrQuotes` in
 * src/lib/template-generation.ts). CodeQL goes quiet; the next person writes
 * the one-line version again and the alert returns days later, on a PR
 * someone has to unblock.
 *
 * So this rule is the enforceable form of the same constraint, and it runs in
 * the blocking `gates` job via `npm run lint`: the line that introduces the
 * sink fails immediately, at the line, with the fix named.
 *
 * It is deliberately PATTERN-shaped rather than "is the receiver called html":
 * static analysis of a call site cannot see where the string came from, and a
 * name-based heuristic would be defeated by naming a variable `out`.
 *
 * The shapes below are the ones that actually appeared in this repo's
 * sanitiser code. Legitimate `.replace()` work is untouched: slug
 * normalisation (`/[^a-z0-9]+/gi`), extension and separator stripping
 * (`/\.html$/`, `/\/$/`), code-fence trimming, whitespace collapsing, and
 * even the quote-trimming in store.ts (`/^["']|["']$/g` — a git ref path)
 * have patterns that look nothing like markup, so they never fire.
 *
 * Escape hatch: `// eslint-disable-next-line anybase/no-markup-sanitiser-replace`
 * for the rare non-markup rewrite whose pattern unavoidably looks like one.
 */

/**
 * Markup shapes, matched against the SOURCE TEXT of the call's arguments
 * rather than a parsed RegExp: the pattern is usually a regex literal whose
 * source is the entire signal (`/href="#"/` says "attribute";
 * `/^-+|-+$/` says nothing), and a string pattern is as much a sink as a
 * regex one.
 *
 * Most shapes may be satisfied by the REPLACEMENT string too, because
 * `html.replace(/"/g, "&quot;")` is as much an entity sanitiser as
 * `html.replace(/&quot;/g, '"')` and CodeQL reads both identically.
 * `onPatternOnly: true` restricts one to the search pattern.
 */
const MARKUP_SHAPES = [
  {
    what: "an HTML tag (`<a`, `</script`, `<(?:script|style)`)",
    // Tolerates the regex source's own escaping: `<\/div>`, `<\/?[a-z]+>`.
    test: (t) => /<\\?\s*\/?\s*[a-zA-Z!?(]/.test(t),
  },
  {
    // The generic `<…>` sweep: `<[^>]*>`, `<[^<]*>`, `[<>]`, `<(a|b)>`.
    what: "a generic tag match (`<[^>]*>`)",
    test: (t) => /<[^<]*>/.test(t),
  },
  {
    what: "an HTML attribute (`href=`, `src=`, `onclick=`, `data-*=`)",
    // Three unnested regexes rather than one alternation. The obvious single
    // form — `on(?:\[[^\]]*\]|[^\s"'=`])+` — nests an unbounded `+` around an
    // alternation containing `*`, which is the exact shape CodeQL's
    // inefficient-regex query flags (it did, on this file, in the first cut
    // of this rule). The middle one covers the handler name as a regex
    // SOURCE, where it is written `\s+on[a-z]+=` and contains no literal
    // attribute name at all.
    test: (t) =>
      /\b(?:href|src|action|class|style|target|rel)\s*=/i.test(t) ||
      /\bdata-[\w-]{0,20}\s*=/i.test(t) ||
      /\bon[a-z]{0,20}\s*=/i.test(t) ||
      /\bon\[[^\]]{0,20}\]\+?\s*=/.test(t),
  },
  {
    // Attribute-by-construction: a quote AND an `=` in one pattern, with no
    // attribute name to go on (`\s+on[a-z]+="[^"]*"`). Two independent tests
    // rather than the single regex that spans them: an unbounded wildcard
    // between the two is exactly the shape CodeQL's inefficient-regex query
    // flags, and a lint rule that trips its own scanner is a poor advert for
    // the idea. Pattern only: the replacement of a legitimate quote-trimming
    // replace is a delimiter or empty, and pairing a quote with an `=` across
    // the two arguments would flag plain text substitutions.
    what: "a quoted attribute value (`…=\"…\"`)",
    test: (t) => /["'`]/.test(t) && t.includes("="),
    onPatternOnly: true,
  },
  {
    what: "an escaped quote inside markup (`\\\"`)",
    test: (t) => /\\["'`]/.test(t),
  },
  {
    what: "an HTML entity (`&quot;`, `&#39;`, `&amp;`)",
    test: (t) => /&(?:quot|amp|lt|gt|nbsp|#\d+|#x[0-9a-f]+);/i.test(t),
  },
];

/** The member names that are String mutation sinks. */
const REPLACE_METHODS = new Set(["replace", "replaceAll"]);

function replacedPropertyName(callee) {
  if (callee.type !== "MemberExpression") return null;
  if (!callee.computed && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  if (callee.computed && callee.property.type === "Literal") {
    return callee.property.value;
  }
  return null;
}

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow String.replace/replaceAll whose pattern looks like HTML sanitisation (CodeQL js/incomplete-multi-character-sanitization).",
      recommended: true,
    },
    schema: [],
    messages: {
      markupReplace:
        "Do not sanitise markup with String.{{method}} — the pattern matches {{what}}. " +
        "CodeQL reads any markup-handling replace as the js/incomplete-multi-character-sanitization " +
        "sink, so this fails code scanning. Rewrite it as a manual exec loop that assembles output " +
        "from slices (stripBrokenPass in src/lib/template-generation.ts), or use a real parser. " +
        "If this genuinely is not markup handling, restructure it so the pattern does not look like " +
        "one, or silence the line with // eslint-disable-next-line anybase/no-markup-sanitiser-replace.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return {
      CallExpression(node) {
        const method = replacedPropertyName(node.callee);
        if (method === null || !REPLACE_METHODS.has(method)) return;
        const pattern = node.arguments[0];
        // A spread or a variable pattern: nothing static to judge.
        if (!pattern || pattern.type === "SpreadElement") return;
        const patternText = sourceCode.getText(pattern);
        const replacement = node.arguments[1];
        const both = [
          patternText,
          replacement && replacement.type !== "SpreadElement"
            ? sourceCode.getText(replacement)
            : "",
        ].join(" ");
        const shape = MARKUP_SHAPES.find((s) =>
          s.test(s.onPatternOnly ? patternText : both),
        );
        if (!shape) return;
        context.report({
          node: pattern,
          messageId: "markupReplace",
          data: { method, what: shape.what },
        });
      },
    };
  },
};