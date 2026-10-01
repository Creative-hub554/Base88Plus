# Changelog

All notable changes to Anybase are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org) — patch for fixes, minor for features, major
for breaking changes.

Releases are published automatically when a version bump lands on `main`
and CI goes green — see [CONTRIBUTING.md](CONTRIBUTING.md) for the release
process. Download zips: the
[Releases page](https://github.com/Creative-hub554/Base88Plus/releases/latest).

## [Unreleased]

## [0.8.0] — 2026-10-01

Thirteenth release: project tags — a third inline metadata editor on the
dashboard cards, shipped as a thin shell over the shared meta-edit layer
so the extraction from #84 pays for itself — and the shared layer itself
now covers every inline editor.

### Added

- Project tags: a third inline metadata editor on the dashboard cards —
  one comma-separated string, stored normalized (per-tag trim, empties
  dropped) by the same meta route and store validator as name and
  description, and carried by the export/import envelope so tags
  survive a round-trip. Built as a thin shell over the shared
  `useInlineMetaEdit` layer, so the new surface shares the wire
  contract, server-wins normalization, and failure handling with the
  name and description editors.

### Changed

- The builder-header name editor and the dashboard card description
  editor share one inline meta-edit state machine (wire contract,
  server-wins normalization, failure handling) instead of two copies;
  the header editor is now covered by tests.

## [0.7.0] — 2026-09-30

Twelfth release: metadata editing reaches the list view, and the
automation-hardening work gets its publish — every cron chain now has a
day-after witness and a weekly heartbeat.

### Added

- **Description editing on dashboard project cards** — the metadata
  lifecycle now reaches the list view: click a card's description to edit
  it in place (save, cancel, or clear it back to "No description"),
  backed by the same server-validated PATCH as the builder header.

- **Monitoring stack** — three year-round/one-shot layers under the
  cron-day verifiers so a silently skipped schedule is caught within
  days, not on its next cron day: a day-after sentinel for the Oct 3
  chain (Oct 4 01:00 UTC cron; requires a scheduled oct3-verify attempt
  and a `PASS_*` verdict on #18, trips with a `SENTINEL_*` comment
  otherwise), the same for the Oct 28 promotion chain (Oct 29 cron,
  with a distinct "awaiting dispatch" reminder state), and a weekly
  schedule heartbeat (Mondays 07:53 UTC) that audits every scheduled
  workflow's API state, cron syntax, satisfiability, and last due fire
  vs actual runs — self-auditing, zero dependencies.

### Fixed

- The Oct 29 sentinel ignores premature #18 closures (only a closure
  dated on/after promotion day counts as done), after its own smoke
  drill found the issue closed a month before promotion day.

## [0.6.0] - 2026-09-30

Eleventh release: projects are no longer frozen with the name they were
born with — rename and describe them in place, from the builder header.

### Added

- Rename + describe projects in place: the builder header now shows the
  project's name (`anybase / <name>`) with a pencil — click to edit,
  Enter/blur commits, Escape cancels. `PATCH /api/projects/[id]/meta`
  is the human-edit leg of the metadata lifecycle: the store validates
  (trim, 80/500 caps, non-empty name), bumps `updatedAt`, and returns
  the persisted record; the server-normalized value always wins.
  Ids never change, so dashboard links, snapshots, and the published
  slug stay valid, and the new identity flows through export/import
  via the metadata envelope (round-trip tested through the real
  download route).

## [0.5.0] - 2026-09-29

Tenth release: assets now enter projects as easily as files do — drop
them on the file panel.

### Added

- Drag-and-drop asset upload in the builder file panel: click "+" or drop
  images/fonts onto the file list to add them to a project directly — no
  zip round-trip, no chat detour. The server re-validates everything
  (extension allowlist, 2 MB per-asset cap, basename-only filenames,
  duplicates rejected with an explicit error — replace via zip import).
  The extension allowlist now lives in one isomorphic module shared by
  the store's disk kernel, the importer, the upload route, and the
  picker's accept list.

## [0.4.0] - 2026-09-29

Ninth release and the arc's capstone: projects can carry real images and
fonts — through export, import, publish, restore, and deploy — byte-exact.

### Added

- Binary asset support — projects can now contain real images and fonts.
  Binary assets (png/jpg/webp/gif/ico/woff/woff2/ttf/otf/mp3/mp4/webm/pdf/
  wasm/zip/…) ride the file layer as base64 (`encoding: "base64"`) and are
  written to disk as raw bytes, so they survive export → import
  byte-exact, publish, restore, fork, deploy versions, and Cloudflare
  deploys (hashed and uploaded as true bytes). Serving routes (preview,
  public /p page, template gallery, version history) emit the raw bytes
  with proper content types; the code editor shows a size summary instead
  of a base64 wall; the generation prompt lists binary assets by name
  instead of inlining their contents into the model's context.

## [0.3.1] - 2026-09-29

Eighth release, second of the portability arc: an export now carries its
identity back in, and a clobber hazard on foreign project.json is closed.

### Added

- Metadata-aware imports: exports now embed the project record (anybase
  marker + name/description) as the zip's root project.json, and importing
  an Anybase export restores the app's original name and description. The
  uploaded filename is only a fallback hint for foreign zips — explicit
  name overrides still win, and the envelope's old id/timestamps never
  leak into the fresh project.

### Fixed

- A foreign zip's root project.json is no longer silently dropped: it is
  skipped with an explicit "reserved by Anybase" reason (case-insensitive,
  since writing PROJECT.JSON would clobber the project record on Windows).
  Nested project.json files remain ordinary files — though the store
  excludes that basename from workspace listings at any depth.

## [0.3.0] - 2026-09-29

Seventh release and the first feature drop of the portability arc:
projects can come back in, not just out.

### Added

- Project import — the return leg of the portability story: "Import zip" on
  the dashboard accepts an Anybase export (or any static-site zip), creates
  a fresh project from the sanitized entries, and lands you in the builder.
  Per-entry skip reasons are surfaced (traversal paths, macOS/Windows junk,
  binary assets, size outliers), so one poison file never blocks the rest
  of the bundle.

## [0.2.9] — 2026-09-29

Sixth release of the day: promotion day gets the same autonomous treatment
as Oct 3, and a rehearsal of the verifier's never-taken path caught a dead
alarm before it could matter. No application behavior changes.

### Added

- **Oct 28 promotion-day verifier workflow** — `oct28-verify.yml` runs
  `scripts/verify-oct28.ps1` for real on promotion day (four Oct-28-only
  crons: 07:23 / 09:33 / 13:33 / 19:33 UTC) and posts the verdict on issue
  #18. Firing the promotion dispatch and closing #18 stay deliberate
  operator acts (`NO_DISPATCH_RUN` is exit 0 by design; `CLOSE=1` is never
  set by the workflow). The date-aware smoke mode expects
  `SMOKE_FAIL_NOT_PROMOTED` before promotion — the verifier is supposed to
  say so while 26 is still a canary (#58)
- **One-command promotion-day check** — `npm run check:oct28` answers
  CONFIRMED_PASS / ATTENTION / NOT_YET from the scheduled runs and the #18
  verdicts, routing `NO_DISPATCH_RUN` to the exact dispatch curl (#58)

### Fixed

- **Oct 28 provenance alarm could never fire** — `ConvertFrom-Json` yields
  `_fetchedAt` as a String, and PowerShell's `string -lt [datetime]`
  coerces the datetime to a string, so `2026-09-xx` compared *greater* than
  `2026-10-03` lexicographically (`'9' > '1'`); the "Oct 3 refresh never
  landed" tripwire was dead code. Both sides now cast to `[datetime]`, the
  alarm is date-guarded to on/after Oct 3, and a new `VERIFY_GNOMON` env
  makes the date-dependent branches deterministically rehearsable (#59)

## [0.2.8] — 2026-09-29

Fifth release of the day, and an infrastructure-ops one: the monthly
snapshot-refresh path went from silently broken to self-healing. It started
with a test-fire that caught a dead deploy-key push (the grant-revocation
pass had removed the key and the ruleset bypass actor), and ended with the
repo auditing its own credentials on every CI run. No application behavior
changes.

### Added

- **Deploy-key preflight on every CI run** — `npm run check:deploy-key`
  audits the three legs the monthly snapshot push rides on (a write-enabled
  deploy key, the main-protection ruleset's DeployKey bypass actor, and the
  `DEPLOY_KEY_PEM` secret). A silent revocation now turns CI red within
  days instead of surfacing only on cron day. Uses the `PREFLIGHT_TOKEN`
  secret because `administration: read` is a GitHub App–only permission no
  `GITHUB_TOKEN` can hold; fork PRs auto-SKIP; offline `--self-test` covers
  the verdict matrix (#53)
- **Rotation re-mints the cron deploy key** — `npm run rotate` now re-mints
  the full deploy-key path after every token swap: new keypair, write-enabled
  registration, additive ruleset rebind, sealed `DEPLOY_KEY_PEM`, sealed
  `PREFLIGHT_TOKEN`, strict preflight, and only then old-key deletion. New
  flags: `--deploy-key-only`, `--skip-deploy-key`, `--keep-old-keys` (#54)
- **Pure-Node libsodium sealed box** — `scripts/rotation/sealed-box.mjs`
  (tweetnacl + blakejs) implements `crypto_box_seal` exactly, nonce =
  BLAKE2b-192(ephPub ‖ recipientPub), KAT-verified against stdlib
  `hashlib.blake2b(digest_size=24)` and proven by GitHub accepting its
  secrets; ten offline tests pin the construction (#54)
- **Cron-day Oct 3 verifier workflow** — `oct3-verify.yml` runs
  `scripts/verify-oct3.ps1` for real on Oct 3 (07:47 / 09:07 / 19:17 UTC)
  and posts the verdict on issue #18; a dispatch smoke mode proves the
  plumbing any day (`SMOKE_PASS_UNCHANGED` proven live on Sep 29) (#55)
- **One-command cron-day check** — `npm run check:oct3` answers
  CONFIRMED_PASS / ATTENTION / NOT_YET from the scheduled runs and the #18
  verdicts, with exit codes for scripting (#56)

### Fixed

- **The Oct 3 snapshot push path itself** — the Sep 29 test-fire failed with
  `Permission denied (publickey)` because the repo had zero deploy keys and
  the ruleset had lost its DeployKey bypass actor; re-minted key v3, resealed
  the secret, rebound the actor, and re-fired to `snapshot-push-ok` with a
  bot commit on main (#53 groundwork)

## [0.2.7] — 2026-09-29

Fourth release of the day: the id-drift defect class gets closed at both
ends — the builder can no longer quietly query ids that don't exist, and CI
can no longer quietly accept a pin that does. No application behavior
changes.

### Added

- **Builder prompt: never query nonexistent ids** — a new rule in the
  "Interactive apps: state and timers" section requires cross-checking every
  id/class queried in `app.js` against the HTML shipped in the same reply.
  One wrong id throws on load and kills the app — three of three audited
  generated apps had at least one such defect (#51)
- **Strict-selector mode in the generated-app verifier** —
  `verify:generated -- --strict` (now the CI default) fails any pin whose
  app queries `#id`/`.class` selectors its assertions never seeded, with
  named `STRICT` warnings; previously the auto-creating stubs silently
  satisfied such queries, hiding load-time crashes (#51)

### Changed

- **Pomodoro pin suite aligned with its app** — the suite now seeds exactly
  the selectors `app.js` queries, so the pin passes strict mode with zero
  warnings; the strict sweep over all pins is what surfaced the mismatch
  (#51)

## [0.2.6] — 2026-09-29

Third release of the day: the generated-app quality loop gets a clear-before-
refill rule, two more regression pins, and a one-command pin helper. No
application behavior changes — everything here is prompt, tooling, and CI.

### Added

- **Third CI pin: to-do list with storage** — `tests/generated/todo/` pins
  add/toggle/remove flows, remaining-count semantics, localStorage
  persistence (including a simulated reload), and a pinned quirk. Its
  generation also surfaced the id-drift defect class (three id mismatches
  against its own HTML, fixed before pinning) (#49)
- **One-command pinning** — `npm run new:pin -- <projectId-or-dir>
  <assertions.cjs>` resolves the project, validates the assertions up
  front, copies the app verbatim, runs the full pin set, and rolls the new
  pin back automatically if anything fails (#48)
- **Harness fidelity upgrades** — `textContent` stringifies on assignment
  like the real DOM, `className` syncs with `classList`, `el.dispatch(type)`
  fires submit/keydown listeners, synthetic events carry
  `preventDefault`/`stopPropagation`, and assertions files can require the
  harness back (for reload-style tests) without circular-require surprises
  (#49)

### Changed

- **Builder prompt: clear-before-refill** — handlers that rebuild a dynamic
  list (summaries, results, logs) must clear the container first and rebuild
  fresh; appending on every click stacks duplicate output forever. Pinned by
  the regenerated wizard's refresh-not-append suite (#47)

## [0.2.5] — 2026-09-29

Closing the loop on the generated-app pipeline: how apps get created, how
they run in previews, and how their quality is enforced. Two behavior
changes to the builder flow (#41, #42); the rest is generation-prompt
guardrails, verification tooling, and CI (#43–#45).

### Added

- **Kickoff auto-generate** — creating an app from the `/new` gallery now
  starts the first generation from the typed brief automatically (fires
  once, only when the project has no messages yet, and survives React
  Strict Mode's dev double-mount) (#41)
- **Builder prompt guardrails against mode clobbering** — a new
  "Interactive apps: state and timers" section in the builder system
  prompt: a mode/UI-state function is the single writer and is called
  exactly once per user action, auto-start blocks only start the timer,
  and phase changes belong in the tick expiry branch where counters also
  update (#44)
- **Headless generated-app verifier** — `npm run verify:app` runs any
  generated app in a `vm` sandbox with stubbed DOM/storage and a
  manually-driven interval clock against a small per-app assertions file
  (`setup`/`run` contract); exit 0 = `LOGIC_PASS`, matching the repo
  verifier convention (#44)
- **CI pins for generated apps** — apps pinned under
  `tests/generated/<app>/` (verbatim `app.js` + `assertions.cjs`) are
  re-verified on every push and PR in BOTH the blocking gates and the
  canary via the shared gate steps, so a regeneration that reintroduces a
  pinned bug fails CI instead of shipping silently. First pin: the
  Pomodoro suite, whose mode-clobber guards were proven by mutant testing
  (#45)
- **One-command token rotation** — `npm run rotate` performs the full
  CredMan credential rotation: preflight fingerprint read, supervised
  GitHub device flow (long-runway code minting that survives flow
  errors), swap with read-back verification and auto-rollback, then the
  automated credential battery; operator runbook in `docs/rotation.md`
  (#43)

### Fixed

- **Generated apps using localStorage no longer crash in previews** — the
  preview runtime now installs a storage shim for sandboxed windows whose
  storage accessors throw before any script runs (#42)

## [0.2.4] — 2026-09-27

CI-hardening release: the monthly snapshot bot push went from silently
broken to tripwired, and the promotion-day verifiers now get exercised
every week instead of only on their dates. No application behavior
changes — everything here is workflow, tooling, and docs.

### Added

- **Snapshot push tripwired from three angles** — the deploy-key bot
  push used to be able to die invisibly behind a green run. The monthly
  refresh now exports its push outcome as a `snapshot-push-ok` /
  `-failed` / `-skipped` run artifact (#32), a freshness check in the
  CI matrix job fails the run when the committed snapshot is more than
  30 days stale, so the outage fallback alarms instead of quietly
  rotting (#27), and both runbook verifiers read that artifact FIRST
  when judging a cron run, so a dead push can no longer masquerade as a
  graceful no-op (#34)
- **Weekly verifier drill** — a new `verifier-drill` workflow runs every
  Monday 08:23 UTC (+ on-demand dispatch), fires nothing, and needs no
  secrets: it picks the latest successful CI run on `main` and
  smoke-runs BOTH promotion-day verifiers against it
  (`VERIFY_FORCE=1 DRY_RUN=1 SMOKE_RUN_ID`), with date-aware verdict
  assertions so the pre-promotion canary state is a pass, not a false
  alarm. Verifier logs are embedded in the run summary; any failure
  drops a reminder comment on the promotion-day issue (#34–#36)
- **Promotion-day verifiers are tracked code now** —
  `scripts/verify-oct3.ps1` and `scripts/verify-oct28.ps1` moved out of
  local scratch into the repo, with a `VERIFY_TOKEN` override so they
  run on CI; the Windows Credential Manager path stays the default
  locally (#34)
- **Manual dispatch for CI** — `ci.yml` gained a `workflow_dispatch`
  trigger with an opt-in `force_snapshot_refresh` input (pinned to the
  default branch), so promotion-day verification can be fired by hand
  without waiting for the monthly cron or pushing an empty commit (#28)

### Fixed

- **The monthly snapshot push actually works** — two-stage repair after
  the cron rehearsal exposed a push that died before authenticating:
  the runner now pins the `ssh.github.com:443` host key via
  `ssh-keyscan` (TOFU backstop) (#29), and the deploy key was rotated to
  a URL-commented key so `webfactory/ssh-agent` writes the per-host SSH
  config itself — the bot push goes out over `git@github.com:22` with no
  hand-maintained config. The old key was deleted only after the new
  one was proven end-to-end on a real push (#30)
- **Runbook updated** — the ops notes now carry the full
  host-key/deploy-key/tripwire arc, the verifier smoke harness gotchas,
  and the token-rotation state (#33)

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

[0.8.0]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.8.0
[0.7.0]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.7.0
[0.6.0]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.6.0
[0.5.0]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.5.0
[0.4.0]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.4.0
[0.3.1]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.3.1
[0.3.0]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.3.0
[0.2.9]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.9
[0.2.8]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.8
[0.2.7]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.7
[0.2.6]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.6
[0.2.5]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.5
[0.2.4]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.4
[0.2.3]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.3
[0.2.2]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.2
[0.2.1]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.1
[0.2.0]: https://github.com/Creative-hub554/Base88Plus/releases/tag/v0.2.0
[0.1.0]: https://github.com/Creative-hub554/Base88Plus/commits/465569e
