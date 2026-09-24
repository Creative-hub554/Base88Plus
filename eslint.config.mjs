/**
 * Minimal ESLint (flat config). The project runs TypeScript 7 (native), which
 * typescript-eslint cannot parse yet (no JS API in TS 7), so parsing uses
 * @babel/eslint-parser with the TS/JSX syntax plugins — syntax only, which is
 * all the rules below need.
 *
 * The architecture rules port tests/architecture-cloudflare-access.test.ts and
 * tests/architecture-providers-file.test.ts into lint time (fail fast in the
 * editor / CI before tests run):
 *  1. no raw `settings.cloudflare` access outside its owner files — use the
 *     gateway helpers (cfCredentials / cfSubdomain / redactSettings / isKeyless);
 *  2. no string references to the settings file (providers.json) outside the
 *     gateway — use getSettings()/saveSettings().
 *
 * Targeting note: flat config only lints extensions named in some block's
 * `files`, so the main block explicitly targets ts/tsx/js/mjs — otherwise .ts
 * files are silently ignored and the rules never fire.
 *
 * Layering with the vitest guards: lint catches the structural AST forms
 * (settings.cloudflare member access, string literals) at edit time; the
 * vitest guards additionally regex raw source (catching `getSettings()
 * .cloudflare` chains) and pin the prose-only exemption. Keep both layers.
 */
import js from "@eslint/js";
import babelParser from "@babel/eslint-parser";

/** Rule 1: direct settings.cloudflare access (identifier form; `?.` included). */
const RAW_CF_ACCESS = [
  {
    selector:
      "MemberExpression[property.name=/^cloudflare$/][object.name=/^settings$/]",
    message:
      "Do not touch settings.cloudflare directly — use the gateway helpers (cfCredentials / cfSubdomain / redactSettings / isKeyless).",
  },
  {
    selector:
      "MemberExpression[computed=true][property.value='cloudflare'][object.name='settings']",
    message:
      "Do not touch settings['cloudflare'] directly — use the gateway helpers (cfCredentials / cfSubdomain / redactSettings / isKeyless).",
  },
];

/** Rule 2: any string literal mentioning the settings file. */
const RAW_SETTINGS_FILE = [
  {
    selector: "Literal[value=/providers\\.json/i]",
    message:
      "Do not reference the settings file directly — read/write settings via getSettings()/saveSettings() from @/lib/providers/gateway.",
  },
  {
    selector: "TemplateElement[value.raw=/providers\\.json/i]",
    message:
      "Do not reference the settings file directly — read/write settings via getSettings()/saveSettings() from @/lib/providers/gateway.",
  },
];

export default [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "coverage/**",
      "next-env.d.ts",
      // Generated app workspaces and thread state — not project source.
      "projects-data/**",
      ".freebuff/**",
      "lint-probe.*",
    ],
  },
  {
    // Explicit extension targeting — see the note in the header comment.
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.mjs"],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          plugins: [
            "@babel/plugin-syntax-jsx",
            // isTSX+allExtensions: .tsx pages parse JSX-with-generics; harmless
            // for .ts since we only lint syntax, not types.
            [
              "@babel/plugin-syntax-typescript",
              { isTSX: true, allExtensions: true },
            ],
          ],
        },
      },
    },
    rules: {
      "no-restricted-syntax": ["error", ...RAW_CF_ACCESS, ...RAW_SETTINGS_FILE],
    },
  },
  // Baseline JS hygiene for plain-JS files only — TS files are fully
  // covered by `tsc --noEmit`, and no-undef/no-unused-vars false-positive
  // on type-position constructs under the syntax-only Babel parse
  // ("'const' is not defined" on annotated declarations).
  {
    files: ["scripts/**/*.js", "**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ...js.configs.recommended.languageOptions,
      globals: {
        require: "readonly",
        module: "writable",
        process: "readonly",
        console: "readonly",
        __dirname: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    files: ["eslint.config.mjs"],
    languageOptions: {
      globals: { console: "readonly" },
    },
  },
  {
    // Tests legitimately name and seed the settings file: hermetic suites
    // create providers.json in isolated temp cwds, and the architecture
    // guard itself must mention the name. Rule 2 off; rule 1 still applies.
    files: ["tests/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...RAW_CF_ACCESS],
    },
  },
  {
    // Owner files: the gateway defines the settings.cloudflare accessors AND
    // legitimately names the settings file in its persistence constant; the
    // deploy settings route is the credentials writer. Gateway is fully
    // exempt; the deploy route keeps rule 2 only (flat-config rule arrays
    // replace wholesale, so it must be re-listed).
    files: ["src/lib/providers/gateway.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    files: ["src/app/api/deploy/settings/route.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...RAW_SETTINGS_FILE],
    },
  },
];
