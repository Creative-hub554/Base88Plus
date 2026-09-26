# Contributing to Anybase

Thanks for your interest in the project. This guide covers what you need to
know to get a change merged: the local setup, the PR flow, how CI gates
work, and how releases happen (they're automatic — here's what that means
for you).

## Quick start

```bash
npm install        # Node ≥22 <27 enforced; .nvmrc pins 24
npm run dev        # http://localhost:3000
npm test           # the full Vitest suite
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run check:node # verify .nvmrc + engines + CI matrix agree
```

Add a provider key in **Settings → AI Providers** (stored locally in
`providers.json`, gitignored) or copy `.env.example` to `.env.local`.

## Branch and PR flow

1. Branch from `main`:
   ```bash
   git switch -c feat/your-change main
   ```
2. Commit in small, focused units. Messages: imperative mood, first line
   under ~72 chars, blank line, then *why* (the diff shows the what).
3. Before pushing, run the gates locally — they are exactly what CI runs:
   ```bash
   npm test && npm run typecheck && npm run lint && npm run check:node
   ```
4. Push and open a PR against `main`. Fill in the description: what changed,
   why, and anything you deliberately did *not* do.
5. CI runs automatically on every PR. **`ci-ok` must be green before merge.**

If a maintainer asks for changes, push follow-up commits to the same branch —
the PR updates automatically. Avoid force-pushing over review discussion
unless asked.

## How CI works (and what you're signing up for)

CI is **schedule-driven**: the Node matrix is computed at run time from the
official Node.js release schedule, not hardcoded.

- **Blocking gates** — every released major that is currently LTS. All must
  pass; one red leg = red PR.
- **Canary** — the newest released major scheduled for LTS but not there yet.
  It runs the identical gate sequence but is **non-blocking**: a yellow ⚠ on
  a PR never blocks merge. It still matters — that version becomes a blocking
  gate on its LTS date, so fix canary warnings before they graduate.
- **`ci-ok`** — the single stable check that requires the branch protection
  ruleset. Never wire anything to per-leg names (`gates (22)`, …): they
  change on promotion day, by design.

Practical consequences:

- If CI fails on one Node leg only, look for version-specific behavior
  (API differences between 22/24, engine-specific deprecations).
- `npm run check:node` fails locally when your change (or the schedule)
  breaks the contract that `.nvmrc`, `engines`, and the CI matrix agree —
  fix it locally rather than waiting for CI to tell you.

## If CodeQL flags your PR

Besides the CI gates, every PR gets a **CodeQL** check that reports *new*
security findings in the code your diff touches. It is **advisory** —
`ci-ok` remains the only merge gate — but treat a red CodeQL check as a
design review, not noise:

1. **Read the annotation** on the check (it names the rule and the exact
   `file:line`) and the corresponding entry in the
   [Security tab](https://github.com/Creative-hub554/Base88Plus/security/code-scanning).
2. **Most findings are real.** Fix them in the PR, and pin the behavior with
   a test — that's the house pattern (see the demo-sanitizer fixpoint
   restructuring, where the fix came with splice-shape tests).
3. **If it's a genuine false positive**, say so in the PR with the design
   constraint spelled out — don't just reword the code to dodge the scanner.
   A maintainer dismisses the alert with a written justification; precedent:
   the "output may contain `<script`" finding on the demo sanitizer, where
   generated apps legitimately run their own emitted scripts.

Repo-level alerts (dependency CVEs, secret scanning) are triaged by the
maintainers per the [README Security section](README.md#security). And if
you find a security issue in the app itself, **don't open a public issue** —
use **Report a vulnerability** (Security tab → Private vulnerability
reporting).

## The release process (it's automatic)

Releases require **no human tagging**:

1. Bump `version` in `package.json` (the lockfile updates with it — commit
   both). This is the *only* signal.
2. Land it on `main` (PR, green `ci-ok`).
3. The Release workflow fires on CI success and, at that exact commit:
   - tags `vX.Y.Z` (from `package.json`)
   - builds the source zip via `git archive`
   - publishes a GitHub Release with `anybase-vX.Y.Z.zip` attached
   - no-ops cleanly if the tag already exists (one tag per version, strictly)

So: **bump to release, don't touch anything else.** A merged change without a
bump simply ships in the next one. Use semver: patch for fixes, minor for
features, major for breaking changes (the app is pre-1.0 — be kind, note
breaking changes in the PR).

The release checklist lives as a reusable issue template
(**New issue → Release checklist**) — use it when you want to verify a
release end to end.

## House rules

- **Never commit secrets.** `providers.json`, `.env*`, and `projects-data/`
  are gitignored on purpose. Keys belong in the settings UI or `.env.local`.
- **Pinned actions stay pinned.** `ci.yml` and `release.yml` reference
  actions by commit SHA (supply-chain hardening). Dependabot updates the SHAs
  and their `# vX.Y.Z` comments together, weekly — merge those PRs.
- **Windows is a first-class platform.** Many contributors develop on
  Windows; keep line endings consistent (`.gitattributes`-friendly), don't
  assume POSIX-only shell in test fixtures.
- **Match the codebase.** TypeScript strictness, test style, and the
  comment-dense style of `scripts/` are deliberate. When in doubt, mirror
  the file you're editing.

## Reporting issues

- Bugs → blank issue, with reproduction steps and what you expected.
- Release/download problems → check the
  [Releases page](https://github.com/Creative-hub554/Base88Plus/releases) first.
- CI confusion → the
  [Actions tab](https://github.com/Creative-hub554/Base88Plus/actions) usually
  names the failing leg and why.

## Licensing

By contributing, you agree that your contributions are licensed under the
MIT License that covers the project.
