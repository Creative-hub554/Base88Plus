# Anybase

[![CI](https://github.com/Creative-hub554/Base88Plus/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Creative-hub554/Base88Plus/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Creative-hub554/Base88Plus)](https://github.com/Creative-hub554/Base88Plus/releases/latest)
[![Node ≥22 <27](https://img.shields.io/badge/node-%E2%89%A522%20%3C27-brightgreen?logo=nodedotjs&logoColor=white)](https://github.com/Creative-hub554/Base88Plus/blob/main/package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/Creative-hub554/Base88Plus/blob/main/LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://makeapullrequest.com)

**An open, Base44-style AI app builder that works with ANY AI provider.**

Describe an app in chat → the AI writes the files → you see it running in a live
preview. Refine by chatting. Download or publish when done.

The core difference from Base44: **the AI engine is pluggable**. Bring your own
key for any of **29 hosted providers** — OpenAI, Anthropic, Google Gemini, Groq,
Mistral, DeepSeek, OpenRouter, Together, Fireworks, xAI, Azure OpenAI, Amazon
Bedrock, Cohere, Perplexity, Cerebras, SambaNova, NVIDIA, DeepInfra, SiliconFlow,
Alibaba Qwen, Kimi, Z.ai (GLM), MiniMax, Hugging Face, Novita, Nebius, Upstage,
AI21 and free-tier Cloudflare Workers AI — or run fully local with Ollama,
LM Studio, or any vLLM/llama.cpp server. One unified gateway
(`src/lib/providers/gateway.ts`)
normalizes them all through the [Vercel AI SDK](https://ai-sdk.dev)'s
OpenAI-compatible adapter, so adding a new vendor is a one-line catalog entry —
no vendor SDKs, no code changes.

## Download

No clone needed: grab `anybase-vX.Y.Z.zip` from the
[Releases page](https://github.com/Creative-hub554/Base88Plus/releases/latest)
(published automatically by CI on every version bump), unzip, then follow
[Quick start](#quick-start).

## Quick start

```bash
npm install
npm run dev
```

`npm run dev` starts the server under a supervisor: if Turbopack's transform
worker pool dies — which leaves the already-built routes working and every
uncompiled one 500ing, with no error and no exit — it kills the server tree,
restarts it on the same port, and re-requests the pages that were in use so
they are compiled before your next click instead of while you wait. See
[Scripts](#scripts) for the knobs, or `npm run dev:plain` for bare `next dev`.

Open http://localhost:3000 → **Settings → AI Providers** → add a key (or point
at a local Ollama server, which needs no key) → **New app** → describe what you
want → watch the files stream in and the preview boot up.

API keys are stored locally in `providers.json` (gitignored) — BYOK, nothing
phones home. Alternatively set env vars per provider (see `.env.example`).

## Architecture

```
src/
  app/
    page.tsx                        # project list
    new/page.tsx                    # create app
    app/[projectId]/page.tsx        # builder workspace (chat + code + preview)
    settings/page.tsx               # provider settings
    api/
      chat/route.ts                 # streaming generation endpoint (AI SDK 7)
      settings/route.ts             # provider CRUD + active selection
      projects/route.ts             # project CRUD
      projects/[projectId]/files    # generated files API
      projects/[projectId]/messages # chat history
      projects/[projectId]/download # zip export
      preview/[projectId]/[...path] # serves generated files to the sandbox
  lib/
    providers/registry.ts           # provider catalog (add vendors here)
    providers/gateway.ts            # unified model resolution for ALL providers
    providers/model-facts.ts        # models.dev facts for providers that publish none
    models-catalog.ts               # provider /models: ids, published facts, cache
    prompt.ts                       # app-generation system prompt + parser
    store.ts                        # file-based persistence (projects-data/)
    types.ts                        # shared types
  components/builder-client.tsx     # workspace UI
```

## How generation works

1. Chat messages are converted with `convertToModelMessages` and sent to the
   configured provider via `streamText` — through one gateway, whatever vendor
   you picked.
2. The model answers with a fenced ` ```anybase ` block containing
   `=== path ===` sections for each file.
3. The server parses complete blocks as they stream, persists files under
   `projects-data/<projectId>/`, and emits typed `data-files` parts to the UI.
4. Narration text (everything outside code blocks) streams live into chat.
5. The workspace renders files in an editor panel and boots the app in a
   sandboxed iframe pointed at `/api/preview/...`.

## The model catalog

Every picker — the header's active-model select and each project's model pin —
reads `/api/models`, which asks each configured provider's own
OpenAI-compatible `GET /models`. [models-catalog.ts](src/lib/models-catalog.ts)
is the only path that talks to them, and it caches: a five-minute fresh window,
one shared request for concurrent opens, a briefly remembered failure, and the
last good catalog kept — marked `stale`, with the error still reported — when a
refresh fails, because a provider blip must not empty a dropdown that was
working.

Whatever a provider publishes about a model rides along: context window, price
per million tokens, max completion tokens, input modalities, tool support. The
picker shows exactly that, or nothing at all. Each row carries a compact badge
of the two numbers a choice turns on — context window and price — so they are
readable in the list and in the closed select without hovering; the full line
sits on the option's title and under the select for the current selection. The
badge is deliberately short because an option's text *is* its accessible name,
so the detail that would not fit is what stays on hover. No number is ever
guessed from a model name, a one-sided price reads `$3/$?` rather than
inventing the missing side, and a model that neither the vendor nor the dataset
(below) describes gets no badge and no line rather than a zero.

Most providers publish nothing about their models — OpenAI, Anthropic, Gemini
and Groq answer with bare ids — so those facts come from
[models.dev](https://models.dev) (MIT, keyless, one public document) via
[model-facts.ts](src/lib/providers/model-facts.ts). The mapping from our
provider to theirs is **declared, never guessed**: one dataset provider per one
of ours, and then an id has to match exactly — no normalisation, no prefix
stripping, and never a scan for something that looks close, because a
confidently displayed wrong price is worse than an empty line. A row from the
dataset is attributed in the picker (`via models.dev`): a curated third party's
number is not the same claim as the vendor's own. Adding a provider that
publishes nothing means adding one line to that table (and to its pinned test).

The same facts answer the same question in **Settings**: each card shows the
facts of its current model and a *Browse N models* disclosure holding that
provider's own catalogue, ordered by catalogue, cheapest input price, or
largest context window. Picking a row only fills the card's model field — the
card's diff-save is still the only thing that writes. In both orders, a model
nobody published a number for sorts last: an unpublished price is not a cheap
one.

## Adding a new provider

Either use **Settings → Custom OpenAI-compatible** (base URL + key + model —
works for anything with an OpenAI chat-completions API, e.g. NovelAI or an
in-house gateway), or add a row
to `DEFAULT_PROVIDERS` in `src/lib/providers/registry.ts`.

## CI

Gates run on every push and PR to `main`. The Node version matrix isn't
hardcoded — it's **computed at run time** from the official Node.js release
schedule ([nodejs/Release `schedule.json`](https://github.com/nodejs/Release/blob/main/schedule.json)):

- **Blocking gates** — every released Node major that is currently LTS
  (today: 22 and 24). All of them must pass; the run is red otherwise.
- **Canary** — the newest released major that is scheduled for LTS but hasn't
  gotten there yet (today: 26). It runs the *identical* gate sequence, but
  non-blocking: a canary failure is a yellow warning, never a red run. On its
  LTS date (26 graduates **2026-10-28**) it promotes into the gates matrix
  automatically — no workflow edit, no PR, no drift.
- **`ci-ok`** — a single stable check that is green only when every blocking
  gate passed. Branch protection **requires `ci-ok` and nothing else**
  (enforced by the `main-protection` ruleset): per-leg check names change on
  promotion day, and the canary is intentionally allowed to fail.
- **The soak's cost is watched too, not only its leaks** — the same `soak` job then runs
  `npm run check:soak-trend` on the trend line the run just wrote: a phase whose reloads cost more in the
  second half of the soak than the first fails the job, which is a leak's first symptom and is visible in a
  single run. A file of runs (a few downloaded `soak-account` artifacts, or a `--trend` path you keep) is judged
  against them as well, and says `NOT JUDGED` for the half it cannot read rather than passing on nothing.
- **The soak is a gate, not a habit** — the `soak` job runs
  `npm run soak:supervisor -- --reloads 12` on the oldest blocking leg against a
  **real `next start` over a real `.next`**, and `ci-ok` waits on it. So a reload
  that leaks a port, a descriptor, a descendant or a client's answer fails the
  merge instead of being something somebody runs by hand. Twelve reloads is the
  smallest count at which every traffic phase's descriptor floor is actually
  *judged* (four readings each) — at three the soak says so in its own notes
  rather than checking. It is also the only CI step that builds the app, so a
  build break cannot merge green. It runs in parallel with the gates, which stay
  the long pole, so it costs the merge no wall-clock time.
- **Engines are a contract** — `package.json` engines (`>=22 <27`) must cover
  every blocking leg, and `.nvmrc` must pin one of them. `npm run check:node`
  enforces this locally and in CI, and fails loudly when the schedule says the
  floor needs a *manual* bump (e.g. after Node 22 EOL on 2027-04-30).
- **Monthly self-check** — at 07:17 UTC on the 3rd of each month, CI re-runs
  on the default branch with the schedule re-classified, so promotions and
  EOL demotions surface even with zero pushes. The same run refreshes the
  committed release-schedule snapshot (used when nodejs.org is unreachable)
  and pushes it as a `github-actions[bot]` commit when it changed.

For contributors: open a PR and make `ci-ok` green. A persistent canary
warning is an early signal worth fixing before that Node version becomes a
required gate.

#### Running the gates on every blocking leg, locally

`npm test` runs on **your** Node — and if that is the newest release, it is the
canary, the one leg that never gates a merge. `npm run check:legs` closes that
gap: it computes the blocking legs from the same schedule CI uses, downloads
and **checksum-verifies** the official runtime for each (cached in the
gitignored `.node-legs/`, no version manager required), and runs CI's own gate
sequence on it — read out of
[.github/actions/gates-steps/action.yml](.github/actions/gates-steps/action.yml),
so it cannot drift from the gate — plus the superlinearity gate on the oldest
leg, exactly as the `perf-gate` job pins it. Exit **0** every leg passed, **1**
a check failed (with the leg and the output), **2** it could not be run.
`--legs 22` narrows it, `--only test` runs one step, `--node-bin 22=/path` uses
an install you already have, `--help` lists the rest.

It does **not** cover the rehearsals or the cross-engine parity check: those are
a PowerShell *engine* axis (7.x vs 5.1), not a Node one, and a machine has one of
each — run `npm run rehearse:sentinels`, `rehearse:lifecycle` and
`rehearse:transports` for the engine you have.

## Security

Four protections are enabled on this repo, and the
[Security tab](https://github.com/Creative-hub554/Base88Plus/security) is
where everything lands:

- **Dependabot alerts + automated security fixes** — CVEs in dependencies
  surface automatically, and the fix PR is opened alongside each alert
  (minor/patch grouped weekly; majors arrive individually).
- **Secret scanning + push protection** — known token formats are detected
  in pushed content, and a push containing one is refused before it lands.
- **CodeQL code scanning** — weekly static analysis of `main` (Mondays
  09:23 UTC) plus a check on every PR reporting *new* alerts in the changed
  code (`.github/workflows/codeql.yml`, actions pinned to commit SHAs like
  the rest of CI).

**Triage** is solo-maintainer cadence, and every decision leaves a written
record:

- *Dependency alerts*: Dependabot's fix PR is merged when green and
  compatible. A major that conflicts with a project contract (e.g.
  `@types/node` 26 vs `engines >=22 <27` until the 2026-10-28 promotion) or
  needs a coordinated migration (babel 8) is **closed with the reason on the
  PR** — Dependabot re-opens equivalents once the underlying work happens.
- *Code scanning*: the PR check is advisory — the merge gate stays `ci-ok`
  (see [CI](#ci)) — so triage happens in the Security tab: real findings get
  a fix plus a test pinning the behavior, and no alert is ever dismissed
  without a written reason.

**False-positive policy (CodeQL):** a finding is dismissed only as
`false positive` with a written justification naming the design constraint
and cross-referencing the fix PR. Precedent: CodeQL's first scan flagged the
demo sanitizer (`js/incomplete-multi-character-sanitization`). The splice
holes it described were genuinely fixed (#15, #16 — one alternation replace
iterated to a fixed point, both splice shapes test-pinned), and the residual
"output may contain `<script`" claim was then dismissed: generated apps
legitimately run their own emitted scripts, and the sanitizer is demo
cosmetics, not a sandbox.

Beyond the scanners: all third-party workflow actions are pinned to verified
commit SHAs, and `main` accepts changes only through PRs gated on `ci-ok`.

The monthly schedule-refresh commit is pushed over SSH by a dedicated
read/write deploy key (`docs/keys/cron-refresh.pub`), which the
`main-protection` ruleset exempts through its Deploy keys bypass actor. The
private key exists only as the `DEPLOY_KEY_PEM` Actions secret and is loaded
at push time (`webfactory/ssh-agent`); `github-actions[bot]` itself cannot be
a bypass actor on personal repos. Rotate or retire the bot push by rotating
the deploy key and updating the secret together.

## Roadmap ideas

- Project templates & import/export
- Streaming file diffs with accept/reject per file
- Multi-file awareness in prompt context (currently full contents for context)
- Sandboxed Node runtime for generated backends (Bun/Cloudflare Workers)
- Team workspaces & hosted deployments

## Scripts

- `npm run dev` — start dev server, supervised: a dead Turbopack worker pool is restarted for you, and
  the pages that were in use are recompiled as soon as it is back (`DEV_MAX_RESTARTS`, `DEV_HEALTHY_MS`,
  `DEV_BACKOFF_MS`, `DEV_BACKOFF_MAX_MS`, `DEV_PORT`, `DEV_WARM`, `DEV_WARM_LIMIT`, `DEV_WARM_TIMEOUT_MS`
  tune it)
- `npm run dev:plain` — bare `next dev`, no supervision
- `npm run build` — production build
- `npm start` — start the production server, supervised: a server that dies is restarted, with the same
  tree kill, audit, backoff and restart budget as the dev supervisor, and a crash loop exits 1 instead of
  restarting forever (`PROD_MAX_RESTARTS`, `PROD_HEALTHY_MS`, `PROD_BACKOFF_MS`, `PROD_BACKOFF_MAX_MS`,
  `PROD_PORT`, `PROD_ROLLBACK_MS`, `PROD_ROLLBACK_MIN_MS`, `PROD_ROLLBACK_CONNECTIONS` tune it). A clean exit — Ctrl+C, `docker
  stop`, systemd's SIGTERM — is
  respected rather than restarted, and a port somebody else holds or a missing build stops it with the
  reason instead of flapping. The supervisor also holds the public port itself — the "front door" — and
  runs the server behind it on a port of its own, which is what makes a **reload** possible without a
  gap: `kill -HUP <pid>`, or touching the file `PROD_RELOAD_FILE` names, starts a replacement beside the
  server that is serving, waits for it to answer, and points the port at it (a reload that cannot produce
  a server leaves the one that is serving alone). The server it replaced is not stopped at the swap: it
  is kept **warm** — still running, on its own port, out of the way — while the replacement is
  health-checked, so a deploy that comes up and then breaks (gone, or answering 5xx on `/`) is taken out
  and the port goes back to the server that was working. How long it is kept is decided by the app rather
  than by the clock — and by the RATE the app is using the replacement at: the front door counts the real
  connections it hands it and remembers when they arrived, so once `PROD_ROLLBACK_CONNECTIONS` (3) of them
  have gone through it with health checks passed across them, the server it replaced is retired there and
  then (a couple of seconds under load), and short of that proof the window is as long as the observed
  rate needs to produce one. A busy deploy's window therefore closes in seconds while one nobody is using
  stays open much longer — `PROD_ROLLBACK_MS` (90s) is its ceiling and `PROD_ROLLBACK_MIN_MS` (2s) its
  floor, because a window with no traffic in it has no evidence in it either. Reloads need a front door;
  `PROD_FRONT=0` gives the port back to the server
  and runs as before, `PROD_ROLLBACK_MS=0` retires at the swap and gives up the way back, and
  `PROD_ROLLBACK_CONNECTIONS=0` leaves the window a clock at its ceiling whatever the traffic does. Every reload
  that is performed can also be written down for a machine rather than a person: name
  `PROD_RELOAD_HISTORY` and each one appends a line of JSON — when it began, when the port changed hands,
  what became of it (replaced, rolled back, or nothing changed), what closed the window, and the numbers
  that verdict rests on — so a deploy pipeline checks the record instead of reading a log. One
  implementation, two policies: `scripts/supervise.mjs` is the loop, `scripts/dev.mjs` and `scripts/start.mjs` supply what a
  line MEANS — neither imports the other, and the loop refuses to run without that policy
- `npm run check:reload-history` — judge the reload `npm start` last performed, from the history
  `PROD_RELOAD_HISTORY` names, and say so with an exit code rather than a sentence: **0** it landed, **1** it
  was rolled back, nothing changed, or a replacement landed broken with no run to go back to, **2** there was
  nothing it could judge (no history, no record recent enough, a line it cannot read). `touch
  "$PROD_RELOAD_FILE" && npm run check:reload-history -- --wait 150000` is the ask-and-check step a deploy
  runs, and the wait has to cover the window the reload is allowed — the record is written when the reload
  CONCLUDES, and a reload nobody uses runs to `PROD_ROLLBACK_MS` (90s by default) before it concludes.
  `history`, `--since <when>`, `--all` and `--json` are the rest of its command line. The same
  record is on the app's own **/settings** page, under *Reloads*: the last ten reloads with the same words
  and the same verdicts, read from `PROD_RELOAD_HISTORY` through `GET /api/deploy/reloads` — set that
  variable in the environment `npm start` runs in, and the supervisor and the server it starts both see it
- `npm run soak:supervisor` — reload the production server many times back to back and check what each one
  left behind, which is the one thing no single reload can show: `node scripts/soak-supervisor.mjs --reloads 30`
  asks for 30 reloads in a row (each only after the previous one's record has landed, so 30 asks are 30
  reloads), cycling the traffic through **busy**, **trickle** and **quiet** — the app's own rate is what
  decides the rollback window, so all three branches are exercised — and after every single one it checks
  that the run that was retired left nothing behind: its port is free, the supervisor's own log reported an
  audited tree kill, the supervisor is not holding more descriptors than it was (the count is the lowest of
  several readings, compared per traffic phase, because a retirement's own sockets take a moment to
  release), and the front door answered every request with the app's own answer throughout. It also holds
  the door to what it DOES at a swap, which is the moment it exists for: every answer is timed, so the
  clients that had a connection open while the port changed hands are known — none of them may be a 503 or a
  refused connection — and one connection is held open across each swap and judged against the run it was
  piped to. It is held with the head of a request whose terminating empty line never arrives: a run cannot
  dispatch it (there is no request), cannot answer it (there is nothing to answer), and cannot reach it with
  the clock that ends an idle connection, because no response of its ever finishes. Nothing more is asked on
  it until the verdict is wanted, and then the head is finished and whatever answers is the verdict. The
  door's own `leftoverConnections` says the run it was piped to was still holding it when it was retired, and
  once that run is gone the connection ends with it rather than being answered by the replacement. The count
  is the door's own number, taken at one instant — the swap plus the window the reload used, which is what the
  record's arithmetic names — and it is read only for a connection that was still open then: one that had
  already ended leaves the retired run legitimately holding nothing, and an ending before that instant is a
  client the swap cost its connection. The one clock of a run's that DOES reach this shape — `headersTimeout`,
  which a run applies to a request head it never received the end of — announces itself rather than closing
  quietly (a 408 on the held connection), so an ending is not laid at the door's feet when the run said it was
  the one that ended it; that clock is also why the connection is held for one reload and not for ever (a held
  connection lives ~10–20s here, against ~90s of a default header clock), and it is measured by the test suite
  rather than assumed away. Every swap reports how many clients it had, and a busy one
  that had none says so instead of passing on nothing. At the end it
  binds every port the records name, reads the history back with the gate's own parser (one record per
  reload, all of them `replaced`), and exits **0** for a clean soak, **1** for a leak or a reload that did
  not behave as its phase says it should, **2** when it could not be run at all. It supervises the real
  `next start` over `.next` (so it needs `npm run build` first) — `--server '<command>'` soaks something
  else, which is how the test suite runs it against a fixture. CI runs it too, against a real build, on every
  PR: `--reloads 12` on the oldest blocking leg, as the `soak` job gated through `ci-ok` (see [CI](#ci)).
  The suite soaks the same tool on every leg against a fixture server, since a test cannot demand that
  somebody ran `npm run build` first; the job is what keeps the real-build path from rotting. `--reloads`, `--phases`, `--window-ms`,
  `--busy-rate`, `--max-in-flight` (concurrency, not rate, is what wedges an app that cannot serve it) and
  `--json` are the rest of its command line; `--rearm-ms` is refused by name rather than accepted, because the
  connection the soak holds is the unfinished head of a request and there is nothing left to re-arm in it.
  Every run also appends **one trend line** of its own — where each reload's cost was, what each phase's
  descriptor floor read, how the reloads ended, and what each reload's held connection was (each block naming its
  own shape — `anybase-held/2` — so an older account cannot be read as a quiet one, then whether the door
  accepted it and when, anything it was answered and when, when it ended, and the count the retired run
  reported) — to `--trend`
  (default `<dir>/soak-trend.jsonl`). Point
  `--trend` at a path you keep and the runs accumulate there, while `--dir` stays the fresh one per run it
  defaults to: the history inside a dir belongs to ONE run, and two runs sharing one leave records neither can
  read (measured — a concurrent pair blamed each other's front port).
- `npm run check:soak-trend -- <trend.jsonl...>` — **is the soak getting slower?** The soak's own verdict is
  about one run's leaks, and cost is the thing no single run can see: a leak announces itself as reloads that
  cost more before it announces itself as a count. This reads a file of trend lines and judges the newest run
  two ways. Against **itself**: each phase's reload durations (asked → landed — the replacement's boot, the
  window, the stop of the run it replaced) in the second half of its reloads versus the first, so a run whose
  reloads degrade as it goes is caught on the first run, with no history at all. And against the **runs before
  it**, when the file has three of the same platform/arch/engine major: the same per-phase medians, plus the
  floor each phase read, because the same work taking longer is a regression whether or not anything leaked
  this time. Exits **0** within, **1** outside (a phase slower as it went on, slower than before, a floor that
  rose across runs, or a reload that did not land), **2** when it could not judge — and it says *which* of the
  two halves it skipped and why rather than passing quietly: fewer than three earlier runs of that profile, or
  a descriptor floor on a platform whose reading is sampled (Windows) rather than live (`/proc`), whose noise
  was measured at 15 handles under load. CI runs it in the `soak` job, on the trend the run just wrote, where
  the across-runs half is `NOT JUDGED` by design — one artifact is one record; download a few `soak-account`
  artifacts and name them all and the comparison has a baseline. A run that did not pass is judged by nothing
  and still says what it held: the reloads whose held connection is not the ordinary shape are named with the
  facts the door's claim was judged on, so a red door claim is diagnosable from the uploaded artifact instead
  of a re-run — and `npm run soak:diagnose -- <downloaded soak-account>` prints that account as one incident
  timeline when the file alone is not enough to read it.
- `npm run soak:diagnose -- <soak-account>` — **read a downloaded artifact in one place.** The `soak` job uploads
  four files and each answers a different question (the summary is what the run FOUND, the history is what each
  reload DID, the trend line is what the run COST, and `server.log` is the app's own output — its request log);
  this reads them all and prints ONE incident timeline: every
  reload on the run's own clock (whose zero is the earliest instant the account names — usually the connection the
  soak held being accepted, since it opens the hold before it asks for the reload), oldest first, with the hold
  opening (or being refused where the refusal happened), each answer at the instant it arrived and against the
  swap, the port changing hands **with which client that swap cost** when it cost one — that client's ordinal, the
  one it was handed to the door at, spelled the way the app's own request log spells it (`_client=63`), so the client
  a loss is about is looked up in that log **without opening the JSON to find the number first**; then its place
  among the clients the swap had at the door and its place among the clients of the run it went to, which is the
  reading a count of lost clients cannot give, and an account that carries no such ordinal for a loss says so rather
  than printing the places with the handle missing. **The client is then followed, not just named:** the loss is
  printed with that client's own lines from the app's log in the same account, found by the ordinal, so the report
  carries what the app said to it — or says the app wrote no line for it, which is what a client cut off before its
  answer looks like from the app's side — instead of sending the reader to grep a second file. **And those lines are
  classified, which is what says why the loss looks the way it does:** `ANSWERED` (the app finished the request, so
  what was lost is the answer on its way back through the door — or the status the door would not pass), `NO ANSWER`
  (the app was handed the request and never finished it, so the connection ended under it), `MIXED` (both shapes for
  one client) or `NO LINE AT ALL` (the request never reached the app, so it was cut off at the door first). The
  classification is made over every line the log has for that client, including the ones the report keeps to three. Then the instant the
  count the door reports was read, how that connection ended, how the
  reload concluded and what the soak looked for afterwards — and with the problems of the account sitting at the
  reload they are about instead of in a list at the end. Nothing is measured twice and no vocabulary is restated:
  the history goes through the deploy gate's own parser, the outcome words are the ones the settings page colours
  its rows with, and the trend line is judged by `check:soak-trend`'s own reader, so this command cannot disagree
  with either. Exit **0** for an account with nothing wrong in it, **1** for one that carries a problem (the
  soak's own, the trend's, or a line of the history nobody can use), **2** when there is nothing to read. A file
  that is not there is reported and the account is read from the rest — a soak that could not be run writes no
  summary and no trend line either, and the run's problems are then read from the line it did write.
  Name a **SECOND** account and it compares the two instead, printing only the facts that are not the same in both:
  `npm run soak:diagnose -- account-green account-red` is how a regression is read, because after a red run the
  question is almost never what it said but what is different from the run that passed. Two runs sit on two clocks
  and two ports, so the comparison is by FACT rather than by text, and the facts that are the identity of ONE run —
  its instants, its ports, its window durations, its descriptor counts, and how many connections it happened to
  serve — are excluded **by name** and said so at the foot of the report (what the traffic MEANT is the run's
  problems, which is compared). What the run **COST** is compared as well, because time is the one measurement a
  text comparison cannot name: each phase's median reload and the run's total, read off the trend line and held to
  the same allowances `check:soak-trend` judges those numbers with (a quarter of a phase's median or 2s, a fifth of
  the total or 10s), so a diff can say a run got **slower** — not only that it went red. A movement inside those
  allowances is not reported (two readings of one duration never match, and a line per noise teaches a reader to
  skim), and a pair that ran on different profiles is reported as not compared rather than diffed, since two
  machines are not two measurements of one thing. What the door was **ANSWERED** is compared as well, and as
  **rates** rather than counts, because how much traffic arrived is the load generator's rather than the deploy's:
  three soaks of one build through the same fixture counted 61, 59 and 62 requests and served 61, 59 and 62 of them
  200, so the raw count moves between runs of the SAME build while the mix does not move at all. Each status's share
  of what the door was offered, its timeouts and its connection errors as shares of the same, the clients in flight
  per swap that had one, and the clients a swap **lost** as a share of the clients those swaps had at the door, are
  therefore what two runs are read against each other on — with the counts printed beside every rate, a movement
  inside the traffic's own wobble (measured at about five percentage points of the mix) left silent, and a run whose
  record names no traffic reported as not compared rather than read as a door with nothing behind it. A lost client
  is the one rate **not** held to those points: it is held to **half a client**, taken of the run with more clients
  at the door, where one client moves the rate by the least — half of that step is under every single client either
  run can lose, so a client the door cost an answer is a movement at any sample size, and the five points, which
  get looser as the sample grows, would have swallowed exactly the loss a large run can hide. A loss has to be
  exercised as well as read, and a soak through the fixture never loses a client: two knobs move it, one per half of
  the door's claim, and in both the run itself stays healthy. `FAKE_LOSE_RUNS` names the run a swap HANDS its
  clients, which closes exactly one client's request with no reply — a loss **at** the port change — and
  `FAKE_STALL_RUNS` names the run a reload is RETIRING, which leaves one request already piped to it unanswered, so
  the client is cut off at the end of the drain — a loss **in flight across** the change. Which client each spends
  is a COUNT rather than a delay (`FAKE_AFTER_CLIENTS`: the Nth client the named run is handed, the first unless
  told otherwise), so neither shape depends on an arm landing inside a window — and a check is not a client: the
  supervisor's probe and the soak's own readiness probe carry the marker that says so, which is why a shape is never
  spent on one. That count is the same place the account names, rather than a second ordering that happens to agree:
  every client the soak's traffic hands over carries the ordinal it was handed over at into the app (`_client=` on
  the path it asks for, taken when its connection is established — the moment the door's queue receives it), the
  account writes that ordinal down beside the loss (`spent[].client`), the timeline `soak:diagnose` prints names it
  in those terms, and the Nth the fixture spends and the Nth the account names are therefore one client of one set —
  read out of the run's own log by grepping the handle the report printed. The suite runs one soak with each shape, one without, and
  one at the THIRD client read back through the run's own request log — so the rate above is read off real accounts
  either way, and so is the client each one spent. A lost client
  is a rate rather than a restatement of the run's problem: the reload it was lost at is the run group's fact (a run
  that lost one did not pass), and how much of what was at the door the swap cost is this line's, read against the
  clients **at the door** rather than the ones in flight — the band is wider than the instant, so a client answered
  inside the window but after the port changed hands was at the door and never in flight. Name **three or more** and the same comparison is a regression
  **series**: the runs are compared in the order they are named (oldest first, and the header names every one of
  them, so a series given out of order is visible rather than silently re-sorted), and every fact that moved is
  reported at the run it **first** changed in — with every run a repeated change happened at — so
  `soak:diagnose -- r1 r2 r3 r4` answers which run introduced the regression rather than only that the runs differ.
  Exit **0** when every account was compared and **2** when one could not be read: `DIFFERENT` is the answer
  rather than a failure, and only `SAME` says the runs agreed about everything comparable.
  **One** account on its own has nothing to be compared with, and the question a person with a single download
  still has is how far the run drifted: `npm run soak:diagnose -- account --baseline soak-trend.jsonl` names a
  STORED trend line — the file a soak appends one line per run to, which is what a person keeps across runs — and
  reads the run against the runs BEFORE it, the comparison `check:soak-trend` makes across runs and one artifact
  cannot make at all. The numbers are that gate's own, which is what keeps the two readers from disagreeing about
  what `slower` is: each phase's median reload and the run's total, against the **median** of those same numbers in
  the baseline, under the allowances it judges them with. What counts as a baseline is its decision too — an earlier
  run on another profile is not one (two machines are not two measurements of one thing), a run that did not pass is
  not one (a run that leaked must not become what normal looks like), and the run's OWN line is not one, which is
  what a trend file kept across runs has in it — and every record left out is counted with its reason said. A
  baseline thinner than the gate's three runs is read all the same, and says the gate would not judge a trend on it;
  a run that did not pass is measured too, with that caveat named, because a red run that got slower is exactly the
  finding somebody came for. It ends with a second machine line,
  `SOAK_DRIFT=DRIFTED|WITHIN|NOT_COMPARED records=N compared=N differences=N cost=<±Nms|?>`, and the exit code stays
  about the read: **2** when the baseline file named could not be read at all, since the comparison asked for could
  not be made, and the account's own code when the baseline simply holds nothing of this profile.
  `--summary`/`--history`/`--trend`/`--log` name a file directly, and `--json` puts the account on stdout as one object.
- `npm run watch:swaps -- <port> --history <path>` — **watch a deploy somebody else is running** and report
  what each swap it performs does to the clients at its front door: `node scripts/soak-supervisor.mjs
  --attach 3000 --history ./reloads.jsonl` holds load against a front door nobody here started, keeps one
  connection open through it, and reads the deploy's OWN reload history as it grows, so **each swap is
  reported as it lands** rather than in a summary at the end — a line on stderr a person reads, and with
  `--json` one object per swap on stdout (the last line is the summary). A swap that cost clients names them
  on that line the way a downloaded account's timeline does: by the ordinal each was handed to the door at,
  `the 63rd client handed to the door` with `` `_client=63` `` beside it, so the client the live finding is
  about is found in the app's own request log (and in the account read afterwards) by the same handle — one
  sentence for the incident whether it is read during the deploy or after it. **And the line says WHY it looks
  the way it does, at the loss rather than at the end of the deploy:** point the watch at the deploy's own
  output (`--server-log`, default `server.log` beside `--history`, which is where a soak keeps it) and the
  lost client is classified from the app's own lines as the swap lands — the same `ANSWERED (503)`, `NO ANSWER`,
  `MIXED` or `NO LINE AT ALL` sentence `soak:diagnose` prints under that loss in the downloaded account,
  because both readers share `classifyLogLines` and `describeAppLines`. A client the output does not name is
  given one short second look before the silence is called the app's (the lines reach that file through the
  deploy's pipe, a poll away from the record the loss was read from); the reading rides in the per-swap object
  and the daemon log as well as on stderr, and a watch of a deploy whose output nobody captured still names
  the client — it says once at the start that it cannot explain it. **That output is somebody else's file, so
  the watch is not fooled by it being rotated or truncated:** what it reads is KEPT across the file being
  replaced (`startAppLogView`), the tail of a rename rotation is recovered from `<server.log>.1`, and a client
  the kept copy cannot name, in output the watch knows it could not read whole, is reported `UNSEEN` — the
  log's absence, not the app's — rather than as `NO LINE AT ALL`. The classification is `absent` only when
  the reader can vouch for the file it read, so an ordinary rotation costs no reading at all and a real
  truncation is never passed off as a request the app never saw. The claim is the one the soak makes
  about a swap: no client that had the port in its hands while it changed hands may be handed a 503 or a
  refused connection, and the connection held across it must be the retired run's — still on it when the door
  stopped it (the count that says so is read only for a connection that was still open when the door took it,
  and an ending before then is the door's unless the run announced its own give-up), and ended WITH it rather
  than handed to the replacement.
  What is different is that the reloads are the deploy's: a swap that happened before the watch attached is
  reported as **NOT JUDGED** rather than judged on evidence nothing was watching for — and so is a reload
  that never swapped the port at all (`swappedAt: null`, which is what a reload that changes nothing leaves
  behind): there was no change at the door, so it is reported and not counted against the deploy. A swap with
  no client at the door is a finding for every swap (the load is always on), and the deploy's own outcome is
  not a finding — a rollback is a legitimate thing for a deploy to do. Only the door fails this watch: a
  client it cost an answer. `--swaps N` stops
  after N judged swaps, `--wait MS` after a duration, and it exits **0** when every judged swap kept the
  claim, **1** when one did not, **2** when there was nothing to judge (nothing serving on that port, no
  reload landed while it was up, or every reload it saw changed nothing). `--require-swap` reads the two of
  those that are a verdict as a failure rather than an abstention: a watch that judged no swap at all cannot
  say the deploy proved it can swap the port under load, which is the question a pipeline is asking, so it
  exits **1** with the reason (how many reloads landed and that none of them changed the port). A watch that
  never got as far as a verdict — nothing was serving on that port, or the daemon log could not be written —
  is still a **2**, because there the check could not be run rather than ran and answered no. It changes
  nothing about what a judged swap has to have done. `--alert pagerduty` — or `--alert <url>` — **pages
  somebody when the door costs a client an answer**, at the moment the finding lands rather than when the
  deploy ends: `pagerduty` posts a PagerDuty Events API v2 trigger and reads its routing key from
  `PAGERDUTY_ROUTING_KEY` (never an argument, never a line in the log), while an http(s) URL posts the same
  account as JSON to that endpoint, which is what a chat webhook or an automation wants. The alert includes
  the app-side classification for each lost client — its status or why it did not answer — without forwarding
  raw request lines that may contain private URL/query data; a loss with no app reading carries a concise
  `NOT CLASSIFIED` reason. Only the door's own findings page — a client answered 503 or refused, a held
  connection that was not the retired run's, a swap with no client at the door, or evidence the watch could
  not place. The deploy's own outcome, a reload that
  changed nothing, a pre-attach swap and `--require-swap`'s nothing-to-judge never do. Every finding
  of one deploy shares one dedup key (`anybase-swap-watch:<port>:<history>`), so the three bad swaps of one
  deploy are one incident with three entries rather than three pages, and a run that judged swaps and found
  nothing at the door resolves it. A page that could not be sent is said loudly and recorded as
  `alert.failed` in the summary; the verdict and the exit code stay the door's. `--daemon <log>` is the same watch held open for a deploy that is longer
  than one step: it **appends one JSON line per swap to a file as it lands** — the same objects `--json`
  prints, so the log and the stream cannot disagree — and ends the file with the summary when it stops, so a
  step that follows the file (`tail -F`) reads each verdict at the moment it is reached and a later reader
  still gets the whole account. The file is appended to, not restarted, and there is no stopping count with
  it: `--swaps` is refused there (a watch that exits at a count exits while the deploy is still going), and
  a daemon ends on SIGINT, SIGTERM, or `--wait` if one was named. It does none of the leak checking the soak
  does: there are no descendants to count, no ports to bind after a retirement and nothing to stop, because
  the supervisor is somebody
  else's. Its load is real traffic as far as that supervisor is concerned, so a deploy watched under load
  closes its rollback window earlier than one watched by nobody
- `npm run start:plain` — bare `next start`, no supervision
- `npm run typecheck` — TypeScript check
- `npm run test` — Vitest suite (CI gates on it)
- `npm run lint` — ESLint
- `npm run check:legs` — run the gate CI blocks a merge on, on **every blocking Node leg**, not just the
  one you happen to have: the legs come from the release schedule and the steps from CI's own composite
  action (so neither is a transcription that can drift), each leg's runtime is downloaded into a
  gitignored cache and verified against its published SHA-256 before anything is extracted or executed,
  and the extracted binary is asked its own version before it is used. The superlinearity gate runs on
  the oldest leg, as the `perf-gate` job pins it. Exit 0 every leg passed, 1 a check failed (the leg and
  the output are printed), 2 it could not be run — which is a different answer from a pass. `--legs`,
  `--canary` (advisory, as on a runner), `--only <step|list>`, `--no-install`, `--no-perf`,
  `--node-bin <major>=<dir>`, `--index`, `--dist`, `--cache`, `--clean`, `--json`. It does not cover the
  pwsh rehearsals or the cross-engine parity check: those are an engine axis, not a Node one
- `npm run check:node` — verify `.nvmrc`, `engines`, and the CI matrix agree
- `npm run check:schedule-age` — warn when the committed schedule snapshot ages
  past 30 days; fails past the 60-day staleness backstop
