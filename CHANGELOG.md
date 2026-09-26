# Changelog

All notable changes to Anybase are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org) — patch for fixes, minor for features, major
for breaking changes.

Releases are published automatically when a version bump lands on `main`
and CI goes green — see [CONTRIBUTING.md](CONTRIBUTING.md) for the release
process. Download zips: the
[Releases page](https://github.com/Creative-hub554/Base88Plus/releases/latest).

## [0.2.3] — 2026-09-26

Onboarding-release: everything here came out of a fresh-clone newcomer
audit that followed the README and CONTRIBUTING literally.

### Fixed

- **`.env.example` is actually in the repo now** — both README and
  CONTRIBUTING told newcomers to copy it, but the file had never been
  committed (the `.env*` ignore rule swallowed it and the real copy only
  existed in an old workspace). It is tracked via an ignore-rule negation
  (`!.env.example`); real `.env*` files stay ignored (#24)
- **`.gitattributes` added** — CONTRIBUTING asked Windows contributors to
  keep things "`.gitattributes`-friendly" while the file itself was missing.
  LF policy for text files plus binary exemptions, via `text=auto`;
  deliberately no renormalization commit, so existing history is untouched
  (#24)
- **Local gate list matches CI** — CONTRIBUTING claimed its command list was
  "exactly what CI runs" but ordered it differently; it now mirrors the CI
  composite action (`check:node` → `typecheck` → `lint` → `test`) (#24)
- **Release-checklist template includes `check:node`** — the gate CI itself
  runs was missing from the template used to verify releases (#24)

## [0.2.2] — 2026-09-26

Maintenance release — the first cut where every change landed through PRs
gated by the `main-protection` ruleset and was scanned by CodeQL from the
first commit. No application behavior changes beyond the sanitizer
hardening.

### Added

- **CodeQL code scanning** — advanced setup in our own workflow file
  (`.github/workflows/codeql.yml`): `github/codeql-action` pinned to the
  v4.38.2 commit SHA, weekly javascript-typescript analysis of `main`, and a
  new-alerts check on every PR. The Security tab now shows **Code scanning**
  alongside the Dependabot alerts (#14)
- **Node 26 promotion day pre-verified** — the 2026-10-28 zero-touch
  promotion was confirmed by simulating the date (matrix `[22, 24, 26]`, the
  version-contract guard holds, `ci-ok` keeps its identity), and the failure
  edges were probed: the post-EOL engines-floor alarm (2027-05-01), the
  snapshot-staleness backstop (~2026-11-24, refusal reasons stack), and an
  upstream outage on promotion day itself. Tracked in the promotion-day
  checklist issue and the babel 8 migration issue (#17, #20)

### Fixed

- **Demo-sanitizer splice holes** — CodeQL's first scan flagged
  `js/incomplete-multi-character-sanitization` in `sanitizeDemoFiles`: the
  chained one-shot replaces could leave a broken tag behind when an earlier
  deletion spliced the surrounding text into a new well-formed tag. The
  sanitizer is now ONE alternation replace over all three tag shapes
  (img/script/link), iterated to a fixed point, with both splice shapes
  pinned by tests (#15, #16). The residual "`<script` may remain" finding
  was dismissed as a false positive by design: generated apps legitimately
  run their own emitted scripts, and the real splice holes are closed and
  test-pinned

## [0.2.1] — 2026-09-26

Maintenance release: the first cut with the `main-protection` branch ruleset
guarding `main` — every change below landed as a PR gated on green `ci-ok`.

### Changed

- **Dependency refresh** via Dependabot (all merged with head checks green):
  `next` ^16.3.6, `@ai-sdk/react` ^4.0.114, `jsdom` ^30.1.1 plus lockfile
  refreshes (#8, grouped minor/patch); CI tooling updated in place —
  `actions/setup-node` re-pinned to the v7.0.0 SHA (#1) and
  `actions/checkout` to the v7.0.1 SHA (#2), keeping the supply-chain pin
  policy intact
- **Dependabot queue triaged to zero** — the expected-red babel 8 major bumps
  (#4, #5) and the `@types/node` 26 bump (#6, conflicts with
  `engines: ">=22 <27"` until the Node 26 canary promotes on 2026-10-28)
  were closed with explanations; Dependabot re-opens equivalents when the
  underlying migrations happen

### Fixed

- **UTC-midnight-proof fallback-age assertion** — the schedule-fallback test
  pinned the committed snapshot's age as a literal `0d ago`, which is only
  true on the UTC day the snapshot was committed; CI went red the morning of
  2026-09-26 while same-tree local runs hours earlier had passed. The
  assertion now checks the message shape (`fetched <date>, <n>d ago`) instead
  of the literal (#10). Caught by the new branch ruleset on its first day: a
  red `ci-ok` refused the merge exactly as designed

### Added

- **`main-protection` ruleset** (repository setting, not code) — `main` now
  requires the `ci-ok` status check, blocks branch deletion and history
  rewrites, and lets changes land only through PRs (0 approvals, solo
  friendly). Verified both ways: a direct push is refused (GH013) and a
  red-PR merge is refused (405) (#10)

## [0.2.0] — 2026-09-25

First published release, and the first produced by the automated
tag-and-zip pipeline: tagged by the Release workflow at the commit CI
validated, with `anybase-v0.2.0.zip` attached to the
[GitHub Release](https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.0).

The release ships the complete application — the Next.js 16 app builder with
streaming multi-provider generation, live preview, and the fix → pin → publish
recovery flows — together with the full CI hardening arc. 28 test files /
207 tests green; TypeScript strict and ESLint clean.

### Added

- **App builder core** — describe an app in chat; the model streams files into
  a sandboxed live preview; refine by chatting; download or publish when done
  (`465569e`)
- **Pluggable AI engine** — one gateway normalizes OpenAI, Anthropic, Gemini,
  Groq, Mistral, DeepSeek, OpenRouter, Together, Fireworks, xAI, plus local
  Ollama / LM Studio / vLLM and any OpenAI-compatible endpoint; BYOK, keys
  stay local (`465569e`)
- **Fix → pin → publish recovery flows** — one-click AI repair of broken
  generations, pinning of known-good builds, force-guarded publishing with
  the dirty-state badge; real end-to-end test runs the actual route handlers
  with only the provider mocked (`465569e`)
- **CI as the schedule-driven contract** — the Node matrix is computed at run
  time from the official release schedule: blocking gates for every LTS major
  (22, 24), a non-blocking canary for the next one (26, auto-promotes on its
  LTS date 2026-10-28), and `ci-ok` as the single stable required check
  (`fc6b3b6`)
- **Node-range enforcement** — `engines: ">=22 <27"`, engine-strict npm, a
  `.nvmrc` pin (24), and `npm run check:node` as a drift guard proving
  `.nvmrc`, `engines`, and the CI matrix agree; post-EOL floor bumps are
  forced to be explicit (`a29d229`)
- **Outage-proof schedule fallback** — a committed snapshot used when
  nodejs.org is unreachable, refused (never silently stale) when too old,
  when a transition has passed, or when a released even major lacks its LTS
  date (`6ade908`)
- **Monthly self-check with bot-maintained snapshot** — cron `17 7 3 * *`
  re-classifies the schedule with zero pushes and refreshes the committed
  snapshot as a `github-actions[bot]` commit; both steps degrade gracefully
  if branch protection blocks the push, aging toward a loud 60-day refusal
  that names the fix (`1e4d4b0`, `5de09ea`)
- **Automated releases** — `workflow_run` trigger on CI success publishes a
  tag + source zip per `package.json` version; one tag per version, no
  manual steps, asset uploads via the correct host (`7c5921b`, `5de09ea`)
- **Dependabot version updates** — weekly npm and github-actions PRs, grouped
  minor/patch; SHA-pinned actions updated together with their `# vX.Y.Z`
  comments (`31b1123`)
- **Security alerting** — Dependabot vulnerability alerts with automated
  security fixes, secret scanning, and push protection enabled on the
  repository (`b7f400e`)
- **Docs & contributor surface** — README with CI/Release/Node/license badges
  and a CI design section, MIT license, CONTRIBUTING.md, a reusable
  release-checklist issue template with chooser config, and this changelog

### Changed

- CI actions pinned to verified commit SHAs (supply-chain hardening) with a
  Node 22/24 matrix instead of a single-version gate (`b94c01e`)

## [0.1.0] — 2026-09-25

Internal bootstrap version: the initial application commit carried 0.1.0 and
was superseded by the 0.2.0 bump before anything was ever published. No
artifacts exist for this version; it is recorded here so the semver story
stays honest.

[0.2.3]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.3
[0.2.2]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.2
[0.2.1]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.1
[0.2.0]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.0
[0.1.0]: https://github.com/Creative-hub554/Base88Plus/commits/465569e
