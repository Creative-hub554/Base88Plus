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
 * WHY THIS FILE CONTAINS NO REGEX AT ALL
 * Every shape below is a linear string scan rather than a pattern, and that is
 * not a style preference. CodeQL's inefficient-regex query failed this file
 * three times on three different shapes while this rule was being written: an
 * unbounded wildcard between two literals, then an unbounded `+` wrapping an
 * alternation containing `*`, then a plain `\s*=` after a literal alternation.
 * Each was rewritten and the next one appeared — a rule whose entire purpose
 * is to keep a scanner green kept turning that scanner red. A rule for "your
 * scanner cries wolf" should itself be scanner-proof, so the shapes are now
 * ordinary loops. `tests/markup-sanitiser-replace.test.ts` pins that: the
 * pattern shape checks there reject a reintroduced nested quantifier, and this
 * file cannot pass while a regex literal sits in a shape.
 *
 * Escape hatch: `// eslint-disable-next-line anybase/no-markup-sanitiser-replace`
 * for the rare non-markup rewrite whose pattern unavoidably looks like one.
 */

/** Attribute names whose `name=` in a pattern means markup handling. */
const ATTRIBUTE_NAMES = new Set([
  "href",
  "src",
  "action",
  "class",
  "style",
  "target",
  "rel",
]);

/** HTML entities that mean the pattern is decoding or encoding markup. */
const HTML_ENTITIES = new Set(["quot", "amp", "lt", "gt", "nbsp"]);

/** Characters a name may be built from in regex SOURCE text (`on[a-z]+`). */
const NAME_CHARS = /[A-Za-z0-9_-]/;
/** Characters that open a tag: a name start, a declaration, or a group. */
const TAG_OPEN = /[A-Za-z!?(]/;
/** An ASCII digit. */
const DIGIT = /[0-9]/;
/** An ASCII hex letter (a-f). */
const HEX_LETTER = /[a-fA-F]/;
/** A quote delimiter. */
const QUOTE = /["'`]/;
/** Whitespace, as it appears in regex source text. */
const SPACE = /\s/;

/**
 * Does the text contain a tag open — `<a`, `</script`, `<(?:style)`, `[<>]`?
 *
 * Scans forward from every `<`, tolerating the regex source's own escaping
 * (`<\/div>`, `<\/?[a-z]+>`) by skipping backslashes, whitespace and a
 * closing slash before looking at the tag-open character.
 */
function hasTagOpen(text) {
  for (let i = text.indexOf("<"); i !== -1; i = text.indexOf("<", i + 1)) {
    let j = i + 1;
    while (j < text.length) {
      const c = text[j];
      if (c === "\\" || SPACE.test(c) || c === "/") {
        j += 1;
        continue;
      }
      if (TAG_OPEN.test(c)) return true;
      break;
    }
  }
  return false;
}

/**
 * Does the text contain a generic tag match — `<[^>]*>`, `[<>]`, `<(a|b)>`?
 *
 * A `<` with a `>` after it and no `<` in between: that is a tag sweep in
 * every spelling this repo has produced.
 */
function hasTagSweep(text) {
  for (let i = text.indexOf("<"); i !== -1; i = text.indexOf("<", i + 1)) {
    const close = text.indexOf(">", i + 1);
    if (close === -1) return false;
    if (text.indexOf("<", i + 1) === -1 || text.indexOf("<", i + 1) > close) {
      return true;
    }
  }
  return false;
}

/**
 * Strip regex-source noise so an attribute NAME can be read out of a pattern:
 * bracket classes (`[a-z]`, `[\w-]`), escape shorthands (`\b`, `\s`) and
 * quantifiers (`+`, `*`, `?`, `{2,}`) all vanish, leaving `on[a-z]+=` as
 * `on=` and `\bhref\s*=` as `href=`.
 *
 * A character loop, not a regex: this module deliberately contains no
 * quantifier at all, so CodeQL's inefficient-regex query has nothing here to
 * object to.
 */
function denoise(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "[" || c === "\\") {
      // Skip a whole bracket class, or an escape and whatever it escapes.
      if (c === "\\") {
        i += 2;
      } else {
        i += 1;
        while (i < text.length && text[i] !== "]") i += 1;
        i += 1;
      }
      continue;
    }
    if (c === "+" || c === "*" || c === "?") {
      i += 1;
      // A lazy/possessive marker or a following digit count (`*2`) rides
      // along with the quantifier.
      if (i < text.length && (text[i] === "+" || text[i] === "?" || DIGIT.test(text[i]))) {
        i += 1;
      }
      continue;
    }
    if (c === "{") {
      const close = text.indexOf("}", i);
      if (close !== -1 && isCount(text.slice(i + 1, close))) {
        i = close + 1;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Does the text contain an HTML attribute — `href=`, `on[a-z]+=`, `data-*=`?
 *
 * Walks back from every `=` over whatever name survives denoising, so the
 * three spellings of an event handler all reduce to one answer: `onclick=`,
 * `on[a-z]+=`, `on\w+=`. An `on…` or `data-` prefix counts whatever follows;
 * a bare `=`, or a variable on the left, is not an attribute.
 */
function hasAttribute(text) {
  const flat = denoise(text);
  for (let i = flat.indexOf("="); i !== -1; i = flat.indexOf("=", i + 1)) {
    let j = i;
    while (j > 0 && NAME_CHARS.test(flat[j - 1])) j -= 1;
    const name = flat.slice(j, i).toLowerCase();
    if (!name) continue;
    if (
      ATTRIBUTE_NAMES.has(name) ||
      name.startsWith("on") ||
      name.startsWith("data-")
    ) {
      return true;
    }
  }
  return false;
}

/** Does the text contain an HTML entity — `&quot;`, `&#39;`, `&amp;`? */
function hasEntity(text) {
  for (let i = text.indexOf("&"); i !== -1; i = text.indexOf("&", i + 1)) {
    const close = text.indexOf(";", i + 1);
    if (close === -1) return false;
    const body = text.slice(i + 1, close);
    if (HTML_ENTITIES.has(body.toLowerCase())) return true;
    if (isNumericReference(body)) return true;
  }
  return false;
}

/** Is this a numeric character reference body — `#39`, `#x27`, `#X1F600`? */
function isNumericReference(body) {
  if (!body.startsWith("#") || body.length < 2) return false;
  const digits = body.slice(1);
  if (digits.startsWith("x") || digits.startsWith("X")) {
    return HEX_DIGITS_ONLY(digits.slice(1));
  }
  return DIGITS_ONLY(digits);
}

/** Every character is an ASCII digit? */
function DIGITS_ONLY(text) {
  for (const c of text) if (!DIGIT.test(c)) return false;
  return text.length > 0;
}

/** Is this the body of a `{n}` or `{n,m}` quantifier? */
function isCount(text) {
  if (text.length === 0) return false;
  let i = 0;
  while (i < text.length && DIGIT.test(text[i])) i += 1;
  if (i === 0) return false;
  if (i === text.length) return true;
  if (text[i] !== ",") return false;
  i += 1;
  while (i < text.length && DIGIT.test(text[i])) i += 1;
  return i === text.length;
}

/** Every character is an ASCII hex digit? */
function HEX_DIGITS_ONLY(text) {
  for (const c of text) {
    if (!DIGIT.test(c) && !HEX_LETTER.test(c)) return false;
  }
  return text.length > 0;
}

/** Does the text contain an escaped quote inside markup — `\"`, `\'`? */
function hasEscapedQuote(text) {
  for (const q of ['\\"', "\\'", "\\`"]) {
    if (text.includes(q)) return true;
  }
  return false;
}

/** Does the text hold a quote delimiter (anywhere)? */
function hasQuote(text) {
  return QUOTE.test(text);
}

/**
 * Markup shapes, judged against the SOURCE TEXT of the call's arguments
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
  { what: "an HTML tag (`<a`, `</script`, `<(?:script|style)`)", test: hasTagOpen },
  { what: "a generic tag match (`<[^>]*>`)", test: hasTagSweep },
  { what: "an HTML attribute (`href=`, `src=`, `onclick=`, `data-*=`)", test: hasAttribute },
  {
    // Attribute-by-construction: a quote AND an `=` in the same pattern, with
    // no attribute name to go on (`\s+on[a-z]+="[^"]*"`). Pattern only: the
    // replacement of a legitimate quote-trimming replace is a delimiter or
    // empty, and pairing a quote with an `=` across the two arguments would
    // flag plain text substitutions.
    what: "a quoted attribute value (`…=\"…\"`)",
    test: (t) => hasQuote(t) && t.includes("="),
    onPatternOnly: true,
  },
  { what: "an escaped quote inside markup (`\\\"`)", test: hasEscapedQuote },
  { what: "an HTML entity (`&quot;`, `&#39;`, `&amp;`)", test: hasEntity },
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