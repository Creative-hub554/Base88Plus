# Changelog

All notable changes to Anybase are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org) — patch for fixes, minor for features, major
for breaking changes.

Releases are published automatically when a version bump lands on `main`
and CI goes green — see [CONTRIBUTING.md](CONTRIBUTING.md) for the release
process. Download zips: the
[Releases page](https://github.com/Creative-hub554/Base88Plus/releases/latest).

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

[0.2.0]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.0
[0.1.0]: https://github.com/Creative-hub554/Base88Plus/commits/465569e
