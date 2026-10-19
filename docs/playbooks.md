# Playbooks

Proven, repeatable procedures for this repository. Each one has been executed
end-to-end multiple times; what follows is the distilled form, not a
narrative. Full history and the why-behind-every-mistake: the session run log
(`.freebuff/run.md`, gitignored) and `docs/rotation.md`.

Conventions: **main** = the default branch; **TOKEN** = the current CredMan
token, read via `TOKEN=$(powershell -NoProfile -ExecutionPolicy Bypass -File
scripts/rotation/cred-read.ps1 | tr -d '\r\n ')`; **pinned SHA** = the
squash-merge commit's original head SHA, embedded in the merge title — GitHub
rewrites the commit, so the PR-branch SHA is the only stable identifier for
later API queries (CI runs, artifacts).

---

## 1. PR shepherd (~10 min/cycle)

The one true path for landing anything. Used for #43–#87 without a single
failed landing once the payload-file rule was learned.

```bash
# 1. Branch + commit (identity flags; run.md NEVER staged)
git checkout -b <branch>
git add <files>            # never `git add -A`; .freebuff/ stays out
git -c user.name='Creative-hub554' -c user.email='govjiang078@gmail.com' \
  commit -m "<type>(<scope>): <subject>"

# 2. Push (token via env config, never a stored credential)
TOKEN=$(powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rotation/cred-read.ps1 | tr -d '\r\n ')
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader \
  GIT_CONFIG_VALUE_0="Authorization: Basic $(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"
git push -u origin <branch>

# 3. PR via PAYLOAD FILE (inline JSON silently fails on Windows quoting)
python -c "import json; print(json.dumps({'title':..., 'head':'<branch>', 'base':'main', 'body':...}))" > /tmp/pr.json
curl -s -w "%{http_code}\n" -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" --data-binary @/tmp/pr.json \
  https://api.github.com/repos/Creative-hub554/Base88Plus/pulls          # 201

# 4. Poll the branch CI (head_sha = the PR-BRANCH sha)
curl -s -H "Authorization: Bearer $TOKEN" \
  ".../actions/workflows/ci.yml/runs?head_sha=<sha>" → poll to completed/success

# 5. Squash-merge PINNED: title carries the branch sha + "(#N)"
python -c "import json; print(json.dumps({'merge_method':'squash', 'commit_title':'<subject> (#N)', 'sha':'<branch sha>'}))" > /tmp/merge.json
curl -s -X PUT -H "Authorization: Bearer $TOKEN" ... /pulls/N/merge      # 200

# 6. Cleanup + sync (anonymous pull works: public repo; also re-arms after rotation)
git push origin --delete <branch> && git checkout main && git branch -D <branch>
git fetch origin main && git merge --ff-only origin/main

# 7. Post-merge CI poll (head_sha = git rev-parse HEAD on main)
```

Invariants: run.md is never staged; PR bodies go through payload files; every
merge is squash + pinned sha in the title; branches die the moment they merge.
Fix-up commits during review are normal — push, re-poll, re-merge with the NEW
sha.

**Landmines (each one cost a cycle once):**
- `administration` in workflow `permissions` = GitHub App-only. Declaring it
  gets the whole workflow file REJECTED: zero jobs, instant failure, and NO
  annotation names the cause. Validate workflow YAML against SchemaStore's
  `github-workflow.json` before pushing (a copy lives at
  `.freebuff/tmp/wfschema.json`; re-fetch with `curl -sL` — schemastore.org
  301s and the bare URL returns a 171-byte redirect page; correct PyYAML's
  bare-`on:` → `True` quirk first).
- Inline (non-file) JSON in curl on Windows silently fails → always
  `--data-binary @file`. But building the payload file with `printf` is
  EQUALLY unsafe: printf processes backslash escapes in the format string
  even when single-quoted, so `{\"ref\":\"main\"}`-style JSON arrives
  mangled (the API answers "Problems parsing JSON", and non-ASCII chars
  come out as cp1252 mojibake). Build payloads with
  `python -c "import json,io; io.open(f,'w',encoding='utf-8').write(json.dumps(p))"`
  or a python heredoc — the step 3/5 templates are load-bearing.
  Verify before sending: `python -c "import json; json.load(open(f))"`.
- Poll with the token attached: anonymous polling burns the 60/hr rate limit
  and the failure looks like a KeyError, not an error.
- python that reads files must use workspace-relative paths — native Windows
  python cannot open msys `/tmp/...` (bash redirects and curl can).
- Windows python + msys paths: write with `> file`, read with `< file` or
  workspace-relative paths. Never `open('/tmp/...')` in python.
- Route tests that read multipart bodies need `// @vitest-environment node`
  as the FIRST line of the file: undici's `Request.formData()` parser (what
  the Next route runs on) chokes on jsdom's Blob with a realm-flavored
  TypeError. Hand-craft the multipart body (Buffer parts + boundary header)
  — it also pins the exact wire shape the browser sends. Pattern:
  `tests/zip-import-route.test.ts`.
- A Freebuff session restart loses git identity: `git commit` dies with
  "Author identity unknown". Never edit git config — the one-shot
  `git -c user.name=… -c user.email=…` flags in step 1 are load-bearing,
  not decorative (values from `git log --format='%an <%ae>' main`).
- A fresh checkout's `main` has no upstream: a bare `git pull` fails with
  "no tracking information". Sync explicitly — `git pull --ff-only origin
  main` — or use the `git fetch origin main` + `git merge --ff-only
  origin/main` pair in step 6.
- `eslint .` lints EVERYTHING, including brand-new ci-only scripts — an
  unused helper in a fresh `scripts/*.mjs` fails `gates` on ALL Node legs
  (caught at #75, the only red PR CI of the session). `npx eslint .` before
  pushing even infra-only changes; the battery-first habit is not
  app-code-only.

---

## 2. Release (v0.2.5–v0.5.0 shipped this way)

1. `git checkout -b release/vX.Y.Z` from a fresh main.
2. CHANGELOG: convert the `Unreleased` block into `## [X.Y.Z] — <date>` with
   an intro + Added/Changed/Fixed; add the tag link
   `[X.Y.Z]: .../releases/tag/vX.Y.Z`. **Empty the Unreleased block** — a
   stale one double-publishes entries (caught at v0.2.9).
3. Version trio:
   `sed -i '0,/"version": "X.Y.W"/s//"version": "X.Y.Z"/'` on package.json
   and package-lock.json (the `0,` replaces only the FIRST occurrence), then
   `npm install --package-lock-only --ignore-scripts`. Verify counts: 1× in
   package.json, 2× in the lock, zero remnants. A count ABOVE 2 can be
   benign — a dependency may legitimately share the version (caught at
   v0.4.0: `json-schema` and `type-check` are both 0.4.0) — verify the
   actual matches before assuming drift.
4. Battery: `npm test` (277), `npx tsc --noEmit`, `npx eslint .`,
   `npm run verify:generated -- --strict` (44/44).
5. Shepherd PR (title `chore(release): vX.Y.Z`), squash as
   `chore(release): vX.Y.Z (#N)`, ff main.
6. release.yml fires on the version bump + CI green (~90 s): poll it **with
   TOKEN**, then verify via API: latest release tag == vX.Y.Z, the tag peels
   to the release commit (use the FULL 40-char sha for `/git/tags/{sha}`),
   zip asset present.

Never hand-edit tags or create Releases manually — the workflow owns it.

---

## 3. Rotation (`npm run rotate`)

Full runbook with the why: `docs/rotation.md`. The shape:

1. `npm run rotate` — device-flow poller mints codes (~15 min each, up to
   `--gens`); approve at github.com/login/device; clear any sudo challenge in
   the same sitting.
2. Poller swaps CredMan (env-only; auto-rollback on read-back mismatch) and
   verifies.
3. Battery runs against the NEW token (CredMan read, /user scopes, issue
   write, git ls-remote + push round-trip, verifier smoke).
4. **Deploy-key leg (automatic)**: re-mints the cron deploy key — new pair,
   write-enabled registration, ADDITIVE ruleset rebind, sealed
   `DEPLOY_KEY_PEM`, sealed `PREFLIGHT_TOKEN`, strict preflight, old key
   deleted LAST. Five legs, because a rotation invalidates: the key, the
   ruleset actor (bound to key id), the PEM secret, PREFLIGHT_TOKEN (a sealed
   copy of the token — administration:read is App-only, no GITHUB_TOKEN can
   ever audit), and the preflight itself.
5. `ROTATION_OK BATTERY_GREEN` + `DEPLOY_KEY_LEG_GREEN`, or
   `npm run rotate -- --deploy-key-only` to heal just the second half.

Targeted modes: `--status`, `--battery-only`, `--deploy-key-only`,
`--skip-deploy-key`, `--keep-old-keys`.

**Landmines:** the private half of a sealed secret is UNVERIFIABLE without
the repo key — always assert plaintext properties before sealing (prefix,
length, no CR/LF; a bash `$(printf ...)` once sealed a literal literal string)
and check ciphertext length == 48 + plaintext. libsodium `crypto_box_seal`
nonce = BLAKE2b-192(ephPub ‖ recipientPub) — NOT the first 24 raw bytes
("bad nonce size" / GitHub 422 "improperly encrypted secret"). `POST /keys`
wants the FULL OpenSSH pub line; fingerprints hash the full RFC 4253 blob,
cross-checked against `ssh-keygen -lf`. tweetnacl in vitest workers needs
real `Uint8Array` copies, not Buffers from another realm.

---

## 4. Cron-day verify + check (Oct 3 snapshot, Oct 28 promotion)

Every step has a one-command human check: `npm run check:oct3` /
`check:oct28` on the cron days themselves, `check:oct4` / `check:oct29` on
the sentinel mornings after (exact exit codes in the landmine list below).

**Oct 3 (fully autonomous):**
1. 07:17 UTC — ci.yml cron: preflight → refresh → deploy-key push
   (`snapshot-push-ok` artifact + bot commit).
2. 07:47 / 09:07 / 19:17 UTC — oct3-verify.yml runs `verify-oct3.ps1` real
   (no force, no dry-run) → verdict on #18 (idempotent by run id).
3. Human: `npm run check:oct3` → expect `CONFIRMED_PASS verdict=PASS_REFRESHED`
   (exit 0). `NOT_YET`/exit 2 = armed but too early; `ATTENTION`/exit 1 names
   the next step.

**Oct 28 (autonomous + two deliberate operator acts):**
1. 07:23 / 09:33 / 13:33 / 19:33 UTC — oct28-verify.yml runs
   `verify-oct28.ps1` real → verdict on #18. The first verdict is
   `NO_DISPATCH_RUN` (exit 0 BY DESIGN): the matrix only re-classifies on a
   CI event, and firing it is the operator's act.
2. Operator: `npm run check:oct28` prints the exact dispatch curl
   (`POST .../ci.yml/dispatches {"ref":"main"}` → 204); matrix recomputes to
   gates [22,24,26], no canary.
3. Later attempts verify → `PASS_PROMOTED`; `check:oct28` → `CONFIRMED_PASS`.
4. Operator tracks the @types/node 26 Dependabot PR, then runs the verifier
   once with `CLOSE=1` — closing #18 is never automated.

Smoke rehearsals (any day, nothing posted): dispatch either workflow with
`smoke: true` — and since #80 the scripts force `DRY_RUN=1` themselves
whenever `VERIFY_FORCE`/`VERIFY_GNOMON` is set, so a faked-time rehearsal
cannot post even if you forget the flag (see the landmine list). Oct 3
smoke expects `SMOKE_PASS*`; Oct 28 smoke sets
`VERIFY_EXPECT_CANARY=1`, so `SMOKE_FAIL_NOT_PROMOTED` →
`SMOKE_PRE_PROMO_AS_EXPECTED` is the GREEN pre-promo outcome.

**Landmines:** `ConvertFrom-Json` yields `_fetchedAt` as a String on Windows
PowerShell 5.1 — but on **every PowerShell 7 it converts an ISO instant to
`[DateTime]`** (7.0–7.4 with no way to opt out at all; 7.5+ only because
`-DateKind String` exists — it is not a 7.5 regression, it is the 7 line).
Interpolating a `[DateTime]` into a URL renders a CULTURE string:
`?since=2026-10-28T00:00:00Z` becomes `?since=10/28/2026 00:00:00`, the `Z` is
gone, the instant is read as LOCAL time, and the window slides by the machine's
UTC offset. That is not theory — it is how a `PASS` recorded the day before
promotion day cleared the Oct 29 sentinel the first time the rehearsal ran on
`pwsh`. So declarations and worlds are read through `ConvertFrom-VerdictJson`
(`scripts/verdict-contract.ps1`), which uses `System.Text.Json` on PowerShell 7
(no string is ever mapped to a date) and `ConvertFrom-Json` on 5.1; ask whether
it can with a type LITERAL, never `[type]::GetType`, which sees only
already-loaded assemblies and says no on 7.4 and 7.6 alike. In PowerShell,
`string -lt [datetime]` also coerces the DATETIME to a string, so `2026-09-xx`
compares GREATER than `2026-10-03` lexicographically: cast both sides
(`[datetime]$wrapper._fetchedAt`). `VERIFY_GNOMON=yyyy-MM-dd` fakes
"today" for deterministic date rehearsal. `NO_DISPATCH_RUN` is exit 0 on
purpose — treat it as a nudge, not a failure. A failed pre-credential
rehearsal proves nothing about the credential: only a full-path test-fire
(design: `force_snapshot_refresh` on ci.yml, pinned to main) exercises the
push. A "Permission denied (publickey)" AFTER a server roundtrip means
key-not-registered, not key-not-offered.
- **An env override that fakes TIME must never reach GitHub — and what
  decides that is the TRANSPORT, not the date.** `VERIFY_FORCE=1` /
  `VERIFY_GNOMON=yyyy-MM-dd` exist for plumbing rehearsals, and a faked run
  produces a verdict that is FALSE on the real calendar, so passing the date
  gate must never unlock the post gate. Learned 2026-09-30: an oct4-sentinel
  gnomon rehearsal without `DRY_RUN` posted a false
  `SENTINEL_NO_SCHEDULED_RUN` dated 2026-10-04 onto #18 (the comment was
  deleted and #18 restored). The guard is in all four scripts (verify-oct3,
  verify-oct28, both sentinels) and asks *where the request would go*:
  `Test-VerdictSimulatedTransport` (`scripts/verdict-contract.ps1`) checks
  whether `Invoke-RestMethod` in this session is a FUNCTION — put there by
  `scripts/rehearse-sentinel-stub.ps1`, which answers every call out of a
  world file. Real cmdlet in charge → the script sets `DRY_RUN=1` itself and
  prints `FORCED_DRY_RUN`, so a rehearsal cannot post even if the operator
  forgets the flag. Stub in charge → it prints `SIMULATED_WORLD` and files
  into that world, which is how the lifecycle rehearsal exercises a real POST
  and a real 403. The Node tools read the same rule through `simulatedNow`
  (`scripts/verdict-contract.mjs`): `HEARTBEAT_GNOMON` / `RECOVER_GNOMON` are
  honoured only while `--import scripts/rehearse-world.mjs` is the transport.
- **Every chain link has a one-command check (`package.json` `scripts`).**
  `npm run check:oct3` — scheduled oct3-verify attempts on cron day + the
  latest `post-Oct-3 verifier` verdict on #18; exit 0 = `CONFIRMED_PASS
  verdict=PASS_REFRESHED` (or `PASS_UNCHANGED`), 1 = `ATTENTION` naming the
  next step, 2 = `NOT_YET` (armed, but cron day hasn't produced a verdict —
  re-run after 08:00 UTC Oct 3). `check:oct28` — same shape on promotion
  day; it routes `NO_DISPATCH_RUN` to `ATTENTION` and prints the exact
  dispatch curl, because the verifier exits 0 on that verdict BY DESIGN (a
  nudge) while the check needs the operator act now. `check:oct4` /
  `check:oct29` — run the day-after sentinels directly: exit 0 = chain
  satisfied (silent), 1 = tripped (one idempotent comment on #18), 2 = date
  gate (any day before the sentinel morning).
- **Closure is the FINAL act — premature closure blinds consumers.** #18 was
  found closed on 2026-09-29 (a month before promotion day); the Oct 29
  sentinel's `closed = mission accomplished` early-out would have gone
  silent-green no matter what the Oct 28 chain did (caught by its own smoke
  drill, fixed in #74: closure counts only when `closed_at` ≥ the chain's
  date; a premature closure falls through to runs+verdicts judgment and is
  flagged in any trip comment). Reopening is an operator act. Corollary for
  ANY new automation: never treat issue state alone as evidence — comments
  and runs are the record, state is a side effect.
- **Poll a specific run id, never `runs?per_page=1` + substring matching.**
  A break-on-`"None"` loop mis-fires twice: `null` is a legitimate
  `conclusion` for in-progress runs, and the "latest run" listing can change
  under you. Fetch the run id first, then poll `GET /actions/runs/{id}`
  until `status == completed`. The lazy variant burned a full 600 s poll
  window on a run that was already green.

---

## 5. Generated-app loop (context for the pins CI enforces)

Generate → `npm run verify:app` (harness; `--strict` is the CI default) →
`npm run new:pin -- <projectId> <assertions.cjs> [--force]` (validates, copies
verbatim, runs the full set, rolls back on failure) → CI pins enforce forever.
Prompt rules the generator must obey: single-writer state, clear-before-refill,
never query an id/class that isn't in the shipped HTML.

---

## 6. Monitoring stack (sentinels + weekly heartbeat)

Five layers, outermost first: **weekly heartbeat** (every schedule, every
week) → **date-specific sentinels** (the morning after a cron day) →
**cron-day verifiers** (the real verdicts) → **checkers**
(`check:oct3` / `check:oct28` / `check:oct4` / `check:oct29`, the one-shot
human entry) → **operator runbook**. Each layer assumes the one below it may be silently skipped —
that assumption is the whole design.

### Day-after sentinel recipe (Oct 4 / Oct 29 pattern)

1. Identify the watched chain's durable record: its #18 comment marker
   (`post-Oct-3 verifier` / `post-Oct-28 verifier`) and verdict alphabet
   (`PASS_*` / `NO_DISPATCH_RUN` / `FAIL_*` / `PRE_PROMO_*`).
2. Script (`scripts/oct4-sentinel.ps1`, `scripts/oct29-sentinel.ps1`): date
   gate (`<` first due date + 1, `VERIFY_GNOMON` to rehearse), classify from
   runs + comments (NOT issue state — see recipe 4's closure landmine),
   **latest-verdict-wins** so a late FAIL after an earlier PASS still trips,
   exit 0 silent when satisfied / exit 1 + one idempotent comment on #18
   (marker `sentinel (checked <date>)`) when tripped. Auth = `GITHUB_TOKEN`
   with `issues: write` (no PAT, no `administration` — ever).
3. Workflow: ONE date-only cron (`0 1 4 10 *`, `0 1 29 10 *`) the morning
   after the chain's last attempt + queue slack; `workflow_dispatch` =
   smoke-only drill (`VERIFY_FORCE=1 DRY_RUN=1`, exit 0/1 both acceptable =
   dry satisfied / dry tripped), log as artifact.
4. **Smoke-drill on a real runner BEFORE the real cron** — static YAML
   validation proves nothing about runtime (that drill is what caught the
   premature-closure blindness).

### Weekly heartbeat recipe (`heartbeat.yml` + `scripts/heartbeat-audit.mjs`)

Mondays 07:53 UTC; zero dependencies (hand-rolled cron math + YAML scanner,
53 unit tests). Per scheduled workflow: API `state == active`; every
`schedule:` cron line parses; forward-satisfiable within **1500 days** (a
full leap cycle — 400 misses Feb-29 crons half the time); the most recent
**due** fire has a scheduled run at/after it (a run starts AT the due
minute, so `>= due` is the evidence; in-progress counts; a RED run still
proves the schedule fired), floored by the workflow's `created_at` so
date-gated chains are `NOT_YET_DUE` before their first fire, never falsely
dead. Findings → exit 1 + one deduped comment on #18 (8-day window);
healthy → exit 0 silent. The heartbeat audits its own cron too, and excludes
GitHub's synthetic `dynamic/dependabot/...` workflow entry (no file).
Rehearse with the `dry_run` dispatch input; extend by adding crons —
the auditor picks them up automatically.

**The receipt check — a green run is not a verdict.** For every workflow listed
in `RECEIPTS` (currently `oct3-verify.yml`, `oct28-verify.yml`), a *completed*
run must have left its promised marker on #18 for the current period. Added
after the 2026-10-03 cron day: all three Oct 3 crons fired for the first time
ever, and run `37157439771` finished **green** while recording nothing anywhere
— `verify-oct3.ps1` computed `VERDICT=PASS_REFRESHED`, its POST to #18 came
back **403 "Resource not accessible by integration"**, it printed
`COMMENT_FAILED`, and then exited 0 on the strength of the PASS it had failed to
record. The only surviving copy was a workflow log that expires in 90 days.

Two properties make the check honest rather than noisy:

- the window opens at the period's **first** due slot, not the slot being
  graded — `oct28-verify` declares four retries for one morning, and grading
  the 19:33 attempt against 19:33 would discard the verdict the 07:23 attempt
  already recorded;
- the sentinels (`oct4`, `oct29`) are deliberately **absent** from `RECEIPTS`.
  They post only when they trip, so a satisfied sentinel is silent by design;
  auditing one would file a permanent false finding. Absence from the table is
  the claim "this workflow owes nobody a record".

Adding a workflow that records on #18? Add it to `RECEIPTS` *and* grant it
`issues: write`. A drift pin checks both — every contract has the permission,
and no workflow in `.github/workflows/` posts to #18 without it. That pin is
why `oct3-verify.yml`'s missing scope cannot recur silently.

### Rehearsals — running the chain on demand (`npm run rehearse:*`)

All three run in CI: the `rehearsals` job in `.github/workflows/ci.yml` runs them on
ubuntu-latest, blocking merges through `ci-ok`, on two lines of the engine the
cron workflows invoke — **7.4 (LTS) and 7.6 (newest stable)** — each installed
from PowerShell's release feed and each asserting the line it resolved, because
the failure that started all this was a property of the ENGINE and one line
cannot report on another. `npm run rehearse:which` is the job's first step, so a
runner with no PowerShell says so instead of leaving a green job that rehearsed
nothing; `scripts/rehearse-pwsh.mjs` is the one place the engine is chosen (pwsh
first, Windows PowerShell only as a fallback). To rehearse a specific engine by
hand, put it first on `PATH` and run the same npm script. All three read **the same
simulated GitHub** —
`scripts/rehearse-world.mjs`, a router over a JSON world file, reached from
PowerShell through `scripts/rehearse-sentinel-stub.ps1` and from Node through
its fetch shim — so a fact about the world cannot mean two things depending
on which language asked; `npm run rehearse:transports` below is what holds that
claim instead of asserting it. An unrouted request is an ERROR, never a forward,
and every rehearsal passes a fake token.

- `npm run rehearse:sentinels` (`scripts/rehearse-sentinels.ps1`) — 16
  scenarios for both day-after sentinels, materialised one world each: trip
  and clear paths, an attempt still running, a late FAIL outranking an
  earlier PASS, a `PASS` recorded before promotion day, a prematurely closed
  #18, the dedupe guard, the date-gate refusal. Every scenario that composes
  a record is round-tripped through the recovery pass's own parser and
  builder, and the recovered comment is handed back to the sentinel, which
  must report `ALREADY_RECORDED` rather than file the day twice. All 16 scenarios
  run in ONE PowerShell (`scripts/rehearse-sentinel-host.ps1`, started once and asked
  to run the scenario command per scenario): the command, the environment it reads and
  the exit code it reports are unchanged — which is what the committed baseline
  compares byte for byte — and the ~25 interpreter boots that were ~36 s of a ~40 s
  run are gone. Its 24 worlds come from the SAME node child the scenarios' REST calls go to
  (`scripts/rehearse-world.mjs session --endpoint <path>`, owned by the harness that drives the
  run), which is where the last of the run's process starts went: the world and the fixture are
  request fields rather than arguments the child is started with, so one process builds both
  chains this rehearsal reads and answers for both — the run was watched from outside and held
  exactly one node child for its whole length. That child LISTENS on a local endpoint (a named
  pipe on Windows, a Unix socket in the run's own 0700 directory elsewhere) instead of answering
  on its own stdin, and that is what removed the last relay: a pipe belongs to whoever started
  the child, so while the transport inside the host and the harness building worlds were two
  processes, one of them had to ask the other to ask. Both connect now, each on its own
  connection, and neither holds a pipe for the other's questions. The worlds it writes are the
  byte-for-byte ones the per-boot CLI writes, which `tests/sentinel-rehearsal.test.ts` compares
  on disk rather than taking on trust.
- `npm run rehearse:lifecycle` (`scripts/rehearse-lifecycle.mjs`) — one
  record's whole life in one world, across four tools:
  computed → filed → lost → recovered → retired. The verifier derives
  `PASS_REFRESHED` and its POST is refused (403); the harness plays the
  workflow's upload step; the Oct 4 sentinel files the gap; the heartbeat
  reports the missing receipt *and* the standing trip; the recovery pass
  re-posts the record out of the artifact and finds nothing to do on a second
  run; the auditor reports the receipt landed and the trip **stale**, and the
  sentinel stands down on the recovered record. It prints the #18 comment
  trail it produced, and it is mutation-verified 5/5. **This is the only
  rehearsal that exercises a POST and `COMMENT_FAILED`** — into the world,
  never GitHub — which is why `DRY_RUN` is deliberately not set there.
  Its harness owns the run's ONE world child and publishes its endpoint to the
  PowerShell steps it starts, so a record's whole life — four tools, eight steps — is
  answered by one node process. Each step used to be an owner and boot a child of its
  own: four children of the same file for one record, which nothing in the report could
  show (`npm run check:rehearse-children` is what showed it, `peak=1 distinct_pids=4`).
- `npm run rehearse:transports` (`scripts/rehearse-transports.mjs`) — the two
  transports of that one world, asked the same questions and compared: the
  PowerShell stub the cron tools really run against
  (`scripts/rehearse-sentinel-stub.ps1`) and the Node fetch shim the heartbeat
  auditor and the recovery pass really run against. Nine cases — an object, a
  multi-element array, a **one-element array** (which PowerShell unrolls into a
  single object with no `.Count`, the Hazard the scripts' `@(...)` wraps exist to
  survive), an empty array, a nested list, the 403 a workflow without
  `issues: write` gets (details and all), the same write accepted, a route the
  world does not describe, and a raw file the verifiers read with
  `Invoke-WebRequest` — and per case one observation from each side, compared as
  canonicalised JSON. One case is not a comparison of two answers but of what each
  side CAN do: an artifact zip, which is bytes, and only the Node transport has a
  reader for it (the case unzips it with the recovery pass's own `unzipEntry`).
  PowerShell must therefore REFUSE them — the stub's `Invoke-WebRequest` now throws
  `REHEARSAL_BINARY_UNSUPPORTED` where it used to answer
  `@{ Content = $null; StatusCode = 200 }`, a successful download of nothing — and
  the fixture declares that, so no case can quietly stop being compared with the
  other transport's answer. All ten cases go to ONE PowerShell session (one engine
  launch, each answer naming its case so the driver pairs them by name — a case that
  goes missing is then a failed case rather than a comparison shifted by one), and the
  stub the cron tools run against reaches ONE node child instead of booting node per request —
  for every rehearsal, not just this one, and (since the worlds moved into the request) that
  child is the same one the sentinel rehearsal's worlds are built by. Nothing about it is keyed
  on a world any more: the sentinel rehearsal points `REHEARSAL_WORLD` at a new file per
  scenario, and the world travels with each question. The stub does not start or own that
  child: the process that does publishes its endpoint in the run's environment, and every
  process under it — this stub included — is a client that connects. Its connection lives in
  global scope because those functions are called from a scope the caller discards — the
  rehearsal's host dot-sources the stub per request and invokes the sentinel from there, and a
  `$script:` variable is not where a function called from it resolves. The observations are what the CALLER received (`@($value)`
  on one side, the array shape on the other), because that is the claim being
  rehearsed: a fact about the world cannot mean two things depending on which
  language asked. Each side reads its own world file, so a mutation on one cannot
  be read as agreement on the other.  It found exactly one such difference the day
  it was written — the shim's `text()` returned a JSON string *quoting* a raw file
  where the stub returned the file — which is the defect class this repo keeps
  meeting: each rehearsal drove one transport, both were green, and nothing asked
  whether they agreed.
- **One world child per run, measured from outside** (`npm run check:rehearse-children`,
  `scripts/check-rehearsal-children.mjs`) — the number every rehearsal above rests on and none of
  them can show: a run keeps **exactly one** node child for its whole length
  (`scripts/rehearse-world.mjs session --endpoint <path>`), the child the harness's 24 worlds and
  the transport's REST calls are both asked of. The baselines are byte-identical whether a run
  keeps one child or twenty — measured rather than argued: with the ownership rule broken so that
  each process starts a child of its own (`Test-RehearsalWorldOwnership` answering `$true`), all
  16 scenarios stayed green while the run held **two children at once**, and every committed
  baseline would still have matched. So the count is taken from the process table rather than from
  anything the run says about itself: POSIX reads `/proc`, Windows asks `Win32_Process` through
  pwsh, and only NODE processes naming the world script are counted (a shell whose command line
  merely mentions it is the thing that started a child, not a child). Both numbers are reported and
  either one fails the check — `peak`, the most children alive at once, and `distinct_pids`, every
  child the run used at all — because either can be the only visible half: a boot per request can
  be gone before the next sample, and a boot per world is many processes even when no two overlap.
  It runs the sentinel leg by default, or anything else with `--command`, which is how the gate
  itself is rehearsed (a command that keeps two children must fail it, pinned in
  `tests/sentinel-rehearsal.test.ts`). It writes no artifact of its own — the parity job reads every
  `rehearsal-<suite>.txt` the legs upload, and a count is not a report — and the `rehearsals` job
  runs it on both engine lines, after the three legs.
- **Cross-engine parity** (`npm run check:rehearsal-parity`,
  `scripts/rehearsal-parity.mjs`) — each leg records its output, uploads it, and
  the blocking `rehearsal-parity` job compares the files byte for byte. Two
  engines rehearsing the same tools and never comparing their answers is how an
  engine-dependent defect survives a version matrix: `ConvertFrom-Json` converts
  an ISO instant to `[DateTime]` on every PowerShell 7 and never did on 5.1, and
  one engine's green was being read as both engines' verdict. It FAILS on a
  difference *and* on a single input, because a comparison that cannot fail reads
  like one that passed. Exactly three things are normalised, all of them properties
  of the capture rather than of the engine — a pipe's line endings, the directory a
  FAILING run names as its evidence, and the directory of a `fixture=` path — and
  `tests/rehearsal-parity.test.ts` pins that list so a fourth entry has to be
  deliberate. To compare engines by hand, give each one a directory and point it at
  them:

  ```
  PATH=<dir-7.4>:$PATH npm run rehearse:sentinels > out/7.4/rehearsal-sentinels.txt
  PATH=<dir-7.4>:$PATH npm run rehearse:lifecycle > out/7.4/rehearsal-lifecycle.txt
  PATH=<dir-7.4>:$PATH npm run rehearse:transports > out/7.4/rehearsal-transports.txt
  npm run rehearse:sentinels > out/7.6/rehearsal-sentinels.txt   # and so on
  npm run rehearse:lifecycle > out/7.6/rehearsal-lifecycle.txt
  npm run rehearse:transports > out/7.6/rehearsal-transports.txt
  npm run check:rehearsal-parity -- --dir out
  ```

  The same command also compares each leg against **the committed baseline**,
  `scripts/rehearsal-golden/rehearsal-<suite>.txt`, because two engines only catch
  the engines *diverging*: both run the same test on the same commit, so a scenario
  renamed, a verdict flipped or a count edited moves them together and passes a
  cross-engine comparison by construction. The baseline is the rehearsal's own
  report — the projection, not a captured stream: its report lines, machine
  directories masked, LF, one trailing newline — so a warning one engine emits, npm's
  version banner and the author's checkout path cannot end up frozen into it. An
  edit to what the rehearsals observe therefore shows up as a diff on a committed
  file somebody has to read; `npm run check:rehearsal-parity -- --write-golden`
  refreshes it from a real run (and re-reads it in the same command, so a baseline
  that does not match the run it came from cannot be left for CI). Both directions
  of absence fail too: a suite with no baseline, and a baseline no leg uploaded.
  The command's `--golden <dir>` points the baseline somewhere else — for trying a
  change to a rehearsal before committing a new baseline.

Add a new cross-tool handoff? Add a step to `scripts/rehearsal-lifecycle.json`
and an `expect` block, not another rehearsal script: a step names its actor,
its clock, the world's chain, and what must be true afterwards.

**Landmines (each cost a debugging cycle once):** a scheduled run's green
conclusion says the SCRIPT ran, not that it RECORDED anything — check the
receipt, not the checkmark; cron single values are
single values — `53` is 53, not vixie 53-max (only `a/s` means `a-max/s`);
the next-fire walk must INCLUDE the start day (later-today slots count);
comment lines INSIDE a `schedule:` block must not reset a line-scanner's
state machine (ci.yml/codeql/drill were silently skipped that way); a
typo'd cron must be a FINDING (unsatisfiable), never a skip; and a
day-after sentinel must stay meaningful when the chain is operator-in-the-
loop — `SENTINEL_AWAITING_DISPATCH` is a reminder, not a malfunction, and
the comment must say so.

---

## 7. Inline metadata editor (add a field surface)

Three shipped surfaces — builder-header **name** (#77, blur/Enter commit),
card **description** (#82, Save/Cancel), card **tags** (#85, Save/Cancel +
pills) — all ride ONE shared layer: `src/components/inline-meta-edit.tsx`
exports `useInlineMetaEdit({ projectId, field, initial, clientCap,
savedToast, clearedToast? })` (draft lifecycle, busy guard, one-field
PATCH to `/api/projects/[id]/meta`, **server-wins normalization**,
changed-only commit, failure toasts keep the prior value) and
`MetaEditButtons` (Save/Cancel row; per-surface test-id props so old
suites survive refactors). Adding a FOURTH field = widen the hook's
`field` union + the store's `setProjectMeta`/route type checks (the store
is THE validator — client caps are UX-only) + a thin shell component.
No shell should contain state-machine code; if it does, the layer is
leaking (that was the bug class #84 killed).

### The pattern (proven by the 2026-10-01 three-editor audit)

1. **Commit semantics are caller-owned** — they differ per surface and
   must not be forced into the hook: blur/Enter for the header name
   (single-click rename; its blur would fight nothing), explicit
   Save/Cancel for cards (a blur-commit fights the buttons — clicking
   Save blurs first), Escape always cancels, Enter may commit where an
   input is present.
2. **The server is the only normalizer.** Client caps/trim are UX-only;
   display what the PATCH response returned, never the draft. New field
   shapes (like comma-separated tags) are normalized in `setProjectMeta`
   and land in BOTH the UI and the export envelope through it.
3. **Overlay contract for server-rendered surfaces.** Cards are `<Link>`s:
   the editor renders as a SIBLING overlay inside a relative parent, stops
   `click`/`keydown` at its boundary (editing must never navigate), and
   reserved spacer slots keep the grid aligned in display mode.
4. **Affordances must be keyboard-visible.** Hover-revealed controls need
   `focus-visible:opacity-100` (the tags pencil shipped without it —
   found by the audit).
5. **Empty state is an affordance, filled state may be a feature** —
   with no value, the whole area invites editing ("No tags" + Add);
   once filled, functional elements (filter pills) own the area and the
   pencil owns editing.
6. **ToastHost is per-page** (module bus + portal). A mounted host renders
   `null` when idle, so absence from the DOM is normal; toasts live 6s, so
   automated probes must poll immediately after the commit (a slow probe
   reads "no toast" — probe latency, not a defect).

Verify with the per-surface suites (`tests/inline-meta-edit.test.tsx`,
`tests/project-card-description.test.tsx`,
`tests/project-card-tags.test.tsx`) — the behavior-preservation proof is
existing suites passing UNCHANGED when the layer is refactored.
---

## 8. Workflow changes (`npm run check:workflows`)

### Why this gate exists

Editing a file in `.github/workflows/` is the only routine change in this repo
that **no existing gate could see**. Everything else is code, and every gate
reads code. So a malformed workflow merged cleanly with nine green CI legs — a
green run that was not a verdict, the same failure class as the lost Oct 3
verdict.

The proof it was real: `oct3-verify.yml` line 26 and `oct28-verify.yml` lines
24–25 carried comments glued to a quoted cron since #58 —

```yaml
    - cron: '17 19 3 10 *'# Oct 3, 19:17 UTC - evening backstop
```

One missing space each. GitHub's parser tolerates it, so the crons kept firing
and nothing complained. A strict YAML reader reports `MISSING_CHAR`. Three
characters, invisible for weeks.

### The recipe

1. Edit the workflow.
2. `npm run check:workflows` — five checks on the **parsed** document:
   - **parses** with `uniqueKeys` and strict comment separation. Catches glued
     comments and duplicate keys (a lenient parser silently keeps the last
     value, so a duplicated cron or a mistyped permission is invisible in the
     run list).
   - **every cron is five fields, in range.** GitHub **silently ignores** a
     cron it cannot parse: no error, no run, no notification. This is the check
     worth having even when nothing is malformed, because the failure mode has
     no symptom at all.
   - **every comment poster is permitted**, resolved from the tree.
   - **no workflow regenerates a committed record.** A step running
     `check:rehearsal-parity --write-golden` (the rehearsal baseline) or
     `npm run new:pin` (the generated pins under `tests/generated/`) writes the
     evidence the same run is then judged by — `verify:generated --strict`
     reading a pin this run made. On a runner whose checkout is discarded that is
     a PASS about a file nobody has; committed, it re-makes the pin. The patterns
     are read from the parsed tree, so explaining the rule in a comment is fine
     and naming one in a step is not.
   - **the one pin CI does refresh stays where it can be committed.** The
     schedule snapshot (`scripts/node-schedule.json`) mirrors an upstream source
     whose freshness is the point, so the monthly run really does refresh and
     commit it — but only on a step guarded to `schedule`/`workflow_dispatch`,
     inside the one job holding `contents: write`. Unguarded it also runs on push
     and PR, where the refresh is thrown away (and on a push, self-triggering).
     The audit behind both lists — `writeFileSync` in `scripts/` finds three
     writers of committed files, and every other writer there (the rehearsals'
     temp worlds and ledgers, the rotator's gitignored `.freebuff/`, the
     matrix script's `$GITHUB_OUTPUT`, the mock provider's untracked
     `mock-requests-<port>.json`) holds no pin — is written out in
     `assessPinWrites`, re-run that grep before trusting it.
3. `npm test` — `tests/workflow-contract.test.ts` pins each of those, as
   fixtures rather than as edits to the real tree.

Exit 0 when every workflow holds, 1 otherwise, with per-file line numbers.

### Landmines

- **A job-level `permissions` block REPLACES the workflow-level one; it does not
  merge.** So a job that declares its own block is judged by that block alone,
  and a grant held only by a sibling job does not cover it. The text-grep guard
  in `tests/heartbeat-schedule-grace.test.ts` cannot express this — it answers
  the weaker question, which is why both exist.
- **A glued comment still parses.** The gate keeps the tree and still runs the
  cron and permission checks, so one file reports every defect at once. If it
  stopped at the parse error, three typos in one file would cost three CI runs
  to fix.
- **The gate only bites if it is wired in.** Four pins assert the step sits in
  `.github/actions/gates-steps/action.yml` before the tests, and that `ci-ok`
  still needs `gates`. Delete the step and every other pin still passes.
- **`on` is a string key, not YAML 1.1's boolean `true`.** A pin asserts it. If
  it ever flips, every trigger lookup finds nothing and the gate passes
  *vacuously* on every file — green, and checking nothing.
- **A cron that fires late is not a broken cron.** The schedule heartbeat judges
  those separately (playbook 6); `check:workflows` only asks whether the
  expression is one GitHub will run at all.

- **A tripped sentinel is a VERDICT, not a dead cron.** The schedule model
  treats any completed run as proof the schedule fired, which is right for
  liveness and wrong for a witness: `oct4-sentinel.yml` exits 1 precisely when
  it posts a gap. Those workflows are listed in `TRIPPERS`, and a non-success
  conclusion on one files a finding. A sentinel that fires has proven the
  schedule is alive *and* that the gap is present - only the second is news.
  The mirror of #129: a green run is not a verdict, and here a red run is
  exactly one.
## 9. Reading a red soak trend (`npm run check:soak-trend`)

### Why this gate exists

The soak's verdict is about LEAKS in one run: a port still held, a descriptor floor
that rose, a reload that did not land, a client that lost its answer. Its numbers —
what each reload cost, what each phase's floor read — were printed and thrown away,
so the question the numbers answer had no reader: **is the same work taking longer
than it did?** A leak announces itself as cost before it announces itself as a count,
so a regression here is the early warning the leak checks cannot give.

Every run now appends one trend line of its own (nothing is measured twice — the line
is a projection of the summary `--json` writes):

```bash
npm run soak:supervisor                              # leaves <dir>/soak-trend.jsonl
npm run check:soak-trend -- ./soak-trend.jsonl       # judge the newest record in it
```

### The recipe

1. Judge **one run against itself** — nothing else required:
   `npm run check:soak-trend -- path/to/soak-trend.jsonl`. Each phase's reload
   durations (asked → landed: the replacement's boot, the window, the stop of the run
   it replaced) are split into halves and their medians compared, the same halves rule
   the descriptor check uses. A phase that costs more in the second half of the soak
   than the first is the finding, and it is visible in the first run.
2. Judge **a run against the runs before it** — needs three earlier passing runs of
   the same `platform/arch/engine-major`, in the file you name. The soak's CI job
   keeps each run's line in the `soak-account` artifact, so a series is a download:
   ```bash
   for id in $(gh run list --workflow=ci.yml --limit 5 --json databaseId -q '.[].databaseId'); do
     gh run download "$id" -n soak-account -D "artifacts/$id"
   done
   npm run check:soak-trend -- $(find artifacts -name soak-trend.jsonl)
   ```
   Same per-phase medians as above, plus the floor each phase read — a floor that rose
   *across* runs is something being kept between them, which no single run can see.
3. `npm test` — `tests/soak-trend.test.ts` pins the projection and the judgment as
   units and the exit codes through the process; `tests/soak-supervisor.test.ts`
   soaks a fixture twice and asserts the file has two lines and that the gate refuses
   a series too thin to judge; `tests/workflow-contract.test.ts` pins the CI steps.
   The same file is where a LOSS is exercised rather than assumed, and one shape per half
   of the door's claim: the fixture's `FAKE_LOSE_RUNS` names the run a swap HANDS its
   clients and closes exactly one client's request with no reply (a loss AT the port
   change), while `FAKE_STALL_RUNS` names the run a reload is RETIRING and leaves one
   request already piped to it unanswered, so the client is cut off at the end of the
   drain (a loss IN FLIGHT across the change). Each spends the Nth client its run is
   HANDED (`FAKE_AFTER_CLIENTS`, the first by default) — counted, not timed, so which
   swap the loss belongs to follows from which run is named rather than from an arm
   landing in time, and a check (the supervisor's probe, the soak's own readiness probe)
   is not a client at all. In both shapes the run behind the door stays healthy, so one
   soak runs with each and one without, and the `clients lost` line is read off those
   accounts through `soak:diagnose` itself.

   WHICH client that was is a fact the two sides share rather than two counts that look
   alike: the traffic stamps each client with the ordinal it was handed to the door at
   (`_client=` on the path, taken when the connection is established), the account writes
   it down beside the loss (`swapsAtTheDoor[].spent[].client`), the run's own request log
   names the client it spent the same way, and `soak:diagnose` prints that ordinal on the
   loss line — so the report on its own says which line of the app's log to look at (see
   the SWAP EVIDENCE note under `soak:diagnose` below). One soak runs with the knob at the
   third client and both witnesses are read: the fixture's Nth and the account's Nth are
   the same client of the same set, read out of the account itself
   (`swapsAtTheDoor[].spent[]`), and the handle the report printed is used to find that
   client in the run's own log.

### Reading the whole account in one place (`npm run soak:diagnose`)

A trend line answers "is it slower"; the artifact also carries what the run FOUND (its
summary), what each reload DID (its history) and what the app itself wrote
(`server.log`), and those are one incident:

```bash
gh run download "$id" -n soak-account -D "account"
npm run soak:diagnose -- account          # 0 green, 1 something is wrong, 2 unreadable

# Two accounts: ONLY what is not the same in both, which is how a regression is read.
gh run download "$green_id" -n soak-account -D "account-green"
npm run soak:diagnose -- account-green account   # 0 compared, 2 one of them unreadable

# ONE account against a trend line you have kept: how far it drifted from the runs before it.
npm run soak:diagnose -- account --baseline soak-trend.jsonl
```

Every reload is on the run's own clock (T+0 is the earliest instant the account names,
which is usually the connection the soak held being accepted — it opens the hold before
it asks for the reload), oldest first: the hold opening (or the refusal, where it
happened), asked, each answer at the instant it arrived and against the swap, the port
changing hands — with WHICH client that swap cost, when it cost one: its place among the
clients the swap had at the door and its place among the clients of the run it went to,
which is the reading a count of lost clients cannot give — the instant the count the door
reports was read, how that connection ended, how the reload concluded, and what the soak
looked for afterwards. The problems sit at the
reload they are about, on the facts behind them, so a red door claim is read where it
happened instead of as a string at the end of a log. Nothing is restated: this goes
through the gate's own history parser, the settings page's outcome words and
`check:soak-trend`'s own judgment, so it cannot disagree with either. A file that is
not there is reported and the rest is still read — a run whose summary never got
written is diagnosed from its trend line, door count and all.

**SWAP EVIDENCE, and the client it names.** Each swap's block in the summary
(`swapsAtTheDoor`) carries what the door did to the clients that had the port in their hands
while it changed hands: `lost` is the count, and `spent` is one entry per client it cost,
naming each of them three ways. `client` is the ordinal that client was handed to the door
at — the number the client itself carried into the app (`_client=` on the path the soak's
traffic asks for), and therefore the handle the app's own request log names the same client
by, which is what makes the account's Nth client and a fixture's Nth client one client
rather than two counts that look alike; `atTheDoor` is its place among the clients the swap
had at the door; and `handed` is its place among the clients of the run it went to, that run
named by `side` and port rather than guessed at. **The timeline prints all three**, and it
prints the ordinal FIRST: the sentence reads *the 63rd client handed to the door*, and then the
marker in backticks — `_client=63` — spelled the way the app's log spells it, which is what
lets a downloaded account be correlated with that log WITHOUT opening the JSON to find the
number first. The handle is what you grep for:

```bash
npm run soak:diagnose -- account | grep -F '_client='   # the ordinal, out of the sentence
grep -F '_client=63' requests.txt                       # ...and the client it names, in the app
```

One client's ordinal is one client's line, whichever end of the loss you read it from. Two
silences stay two facts: a swap that cost nothing carries `spent: []`, and an account written
before this evidence existed carries no block at all — a count with no places named is said in
words rather than read as a swap that cost nobody. A third is said too: an account whose
clients were not the soak's own traffic (a hand-made one) carries `client: null`, and the
timeline says it names no `_client=` ordinal for that loss rather than printing a place with
the handle silently missing — the one fact a reader correlating account and log cannot supply
for themselves.

**The loss is followed into the app, not only named.** The `soak` job uploads `server.log`
beside the account — the app's own output as the supervisor streamed it, which is where its
request log lives (` GET /?_client=17 200 in 3ms (next.js: …)` per answered request, plus
anything the app wrote to stderr). `soak:diagnose` reads it and prints, under each loss AT the
swap, the lines that carry the same `_client=` ordinal: the app's own sentence about that
client, in the app's words. The match is on the whole ordinal (`_client=6` is not
`_client=63`, nor `_client=630`), a client the log names several times keeps three lines and
counts the rest, and a client the log never saw is SAID rather than silently absent — a
client cut off before it got an answer is exactly the loss that leaves no line behind, so
"the app wrote nothing for it" is the finding, not a hole. An account downloaded before the
soak saved the file is read as it was: the header says `server.log … not there`, and the
losses are named and placed exactly as before.

**And the line is classified, because its SHAPE is the reason.** The timeline does not stop at
quoting the app: it says which of four shapes the log has for that client, over every line it
names the client on rather than only the three it prints.

- `ANSWERED (200)`: the app finished the request. Nothing was cut off on its side, so what the
  swap cost is the answer on its way back through the door; where the status is not 2xx (a run
  that 503'd a client at the change) the answer IS the loss — the status the door counted, not
  a silence.
- `NO ANSWER`: the app was handed the request and never finished it. The connection ended under
  it, which is what a client cut off at the swap leaves on the app's side — the shape a drain
  that ran out of window leaves behind.
- `MIXED`: the log has both for one client (a retry, a request the app later wrote about). Part
  of what it was handed came back and part ended under the app, and the reading says both rather
  than picking one.
- `NO LINE AT ALL`: nothing in the output names the client, so the request never became a line —
  it was cut off at the door BEFORE the app was handed it. A different failure from `NO ANSWER`,
  and the reason the two are reported apart.
- `UNSEEN`: same zero lines as `NO LINE AT ALL`, and a different finding. The reader knows the
  log it has is not the whole file — it was rotated, truncated, missing at a look, or trimmed by
  the reader's own cap — so a client the log does not name may still have been answered into the
  part the reader never saw. The absence is the LOG's, and saying it was the app's is the one
  thing the evidence cannot support.

Its case is `classifyLogLines`, so the words are pinned where the prose is
(`tests/soak-diagnose.test.ts`): a status is a token of its own (`?page=200` in the request's
query is not an answer, nor is a `3ms` duration, a port or an instant), and the three shapes are
asserted both as the classifier's reading and as the sentence the timeline prints under the loss.
The fifth (`unseen`) is the one that cannot be read out of lines alone: it says what the READER
knows about the file (see the rotation note below), so it is carried in beside them.

**The watch says the same sentence while it is happening.** `npm run watch:swaps` (this
tooling's watch mode, `--attach`) judges one swap as it lands and prints it as a line — and a
swap that cost clients names them on that line the way the timeline does, because both build
the sentence with the same `nameSpent`: the ordinal first, spelled as the app's log spells it,
then the place. An incident read during the deploy and the same incident read out of the
downloaded account afterwards therefore name one client by one handle, and the grep above works
on either output. The watch judges a single swap and so cannot name the lost client's place
among the clients of the run it went to (`handed` is `null` by design, see `handedRun`) — the
handle is exactly what it can give, and the name is the part a person needs while the deploy
is still running.

**And it says why, while the deploy is still going.** The name is half a finding; whether the
app finished the request or was cut off under it is the other half. Give the watch the
deploy's own output — `--server-log <path>`, defaulting to `server.log` beside `--history`,
which is where a soak writes it — and the client each swap cost is classified from that file
at the moment the loss lands, on the same line: the app's own lines for that ordinal, then the
`ANSWERED` / `NO ANSWER` / `MIXED` / `NO LINE AT ALL` (`UNSEEN` when the log itself could not
be read whole) reading the account's timeline will print later. It is the same shapes and the
same sentence (`classifyLogLines` and `describeAppLines`, one home for both readers), so the
incident is not re-interpreted after the fact. A client the output does not name yet gets one
short second look (`appLogGraceMs`) before the silence is called the app's, because the app's
lines reach that file through the deploy's pipe while the loss is read from a record a
different process wrote — and the reading is carried in the per-swap object and the daemon
log, not only on stderr. A watch of a deploy
whose output nobody captured loses none of the above except the explanation: it names the
client, and says once at the start that it has no file to classify it from.

**A file that is rotated or truncated under the watch is read as what it is, not as the app's
silence.** The deploy's output belongs to somebody else, and a long deploy outlives the file it
started in: `server.log` is renamed to `server.log.1` and a fresh one is started, or the same
file is truncated in place. A reader that opens the path afresh at each loss then sees a file
that no longer holds what the app wrote before it was replaced — and a client the app ANSWERED
is reported as one that never reached it, the same words for two different failures. So the
watch keeps what it has read (`startAppLogView`) rather than trusting the path to be immutable:
a file that grew is appended as the delta, the tail of a rename rotation — the lines written
between the last look and the rename — is recovered from `<server.log>.1`, and a file that was
cut back or replaced without a recoverable tail is recorded as a gap. The lookup at each loss
searches everything kept, so an ordinary rotation costs nothing at all: the answer the app gave
the lost client is still found, still `ANSWERED (503)`. What the log cannot vouch for is said:
with a gap behind it, a client the log does not name is `UNSEEN` rather than `NO LINE AT ALL`,
and the gaps travel in `spent[].app` into the account, where `soak:diagnose` reads them and
prints the same `UNSEEN` rather than calling the absence the app's afterwards. The copy is
capped (`appLogKeepChars`, 2MB), and lines the cap drops are a gap like any other — an absence
that may have scrolled out is never reported as a request the app never saw.

Exit 0 within, 1 outside, 2 could not judge — and the output names every half it
skipped rather than passing on nothing.

**Two accounts are a comparison rather than two timelines.** `soak:diagnose <green>
<red>` prints only the facts that are not the same in both, grouped the way the accounts
are (the run, then each reload that differs), because the question after a red run is
what changed rather than what the red one said. The comparison is by FACT and not by
text: the two runs sit on two clocks and two ports, so a text diff would be nothing but
the port numbers. Everything that is the identity of ONE run is therefore excluded **by
name** — instants, ports, window durations, descriptor counts, and how many connections
each run happened to serve — and the report says so at its foot, which is also where it
names what it DID compare (what the traffic meant is the run's `problems`). What the run
COST is compared too, because time is the half of a regression that comparing what the two
runs DID cannot see: each phase's median reload and the run's total come off the trend line
and are held to the same allowances `check:soak-trend` judges those numbers with — 25% or 2s
on a phase's median, 20% or 10s on the total — so the two readers cannot disagree about what
`slower` is, and a run that got slower is a difference even when both accounts carry the same
problems. A movement inside those allowances is silent (two readings of one duration never
match, and a line per noise is how a diff stops being read), and a pair that ran on different
profiles is reported as **not compared** rather than diffed — two machines are not two
measurements of one thing, which is the same reason the trend gate refuses it. That
served-connection exclusion was measured, not argued: two real three-reload soaks of one
build differed by exactly one fact, reload 1 serving 8 connections against 7, which is
how a line that means nothing gets into a diff. Its exit code is about the read rather
than the answer — 0 when both were compared, 2 when one could not be read — so a pipeline
can use it without `DIFFERENT` meaning failure.

**Three or more accounts are a regression series.** Naming a third turns the same
comparison into a series read one step at a time — `soak:diagnose r1 r2 r3 r4` compares
the consecutive pairs and reports every fact that moved at the run it FIRST moved in,
which is the question a regression asks: not whether the runs differ but which run
introduced the difference. The order is the order they are named (never re-sorted by the
accounts' own instants, which a run that died early does not have), and the header names
every one of them, so a series handed over out of order is visible. A fact that moves
twice is two differences, and one that moves back and forth is one difference naming
every run it happened at; each step is judged against the run before it, exactly as
`check:soak-trend` judges a run against the runs before it, so a series whose numbers
crept up a little at every step is still a regression. A run nobody could read is named
before anything found at a step into or out of it is believed, and the exit code stays
about the read: 0 when every account was read, 2 when one was not.

**The door is compared as RATES, never as counts.** How much traffic arrived is the load
generator's business rather than the deploy's, and the difference is not small: three
fixture soaks of one build counted 61, 59 and 62 requests and answered 61, 59 and 62 of them
200, so a raw count moves between runs of the SAME build while the mix does not move at all.
What two runs can be read against each other on is each status's share of what the door was
offered, its timeouts and its connection errors as shares of the same, the clients it had in
flight per swap that had one, and the clients a swap LOST as a share of the clients those
swaps had at the door — each printed with the counts it was divided from, so a thin sample is
visible rather than hidden behind a percentage. A lost client is read against the clients AT
the door rather than the ones in flight, because the band is wider than the instant: a request
answered inside the window but after the port changed hands was at the door and never in
flight, so the in-flight count is not the set the loss was counted among (the soak's own
per-swap line says "N client(s) at the door ... L lost"). A movement inside the traffic's own
wobble stays silent (the allowance is the measured five points of mix, which is what three
requests in sixty looks like) — for every rate but the loss, which is held to HALF A CLIENT of
the sample it was counted among, and taken of the run with MORE clients at the door because that
is where one client moves the rate by the least (`1/N`): half of that step sits under every
single client either run can lose, so a client the door cost an answer is a movement at any
sample size. Half a client of the run with FEWER clients is the same idea read the wrong way
round, and it is rejected for it: a loss among forty (2.5 points) beside a run of three would
have had to clear 16.7 points and would have read as nothing, in a rate whose whole subject is a
promise made per client. And a run whose record names no traffic is reported as not
compared rather than read as a door with nothing behind it. The door's own FINDINGS are the
run's problems, which the run group compares — the reload a client was lost at and the band an
answer was never given inside — so a loss appears once there as the problem it is and once
here as its magnitude, which is the half two problem sentences cannot be compared on. A loss
the allowance calls no movement here is named by that group all the same, since the group is
what the verdict was decided on.

**One account against a stored baseline says how far it drifted.** A single download has
nothing to be compared WITH, and the question a person arrives with is usually not "what did
it say" but "is this worse than it was": `soak:diagnose account --baseline <trend.jsonl>`
names a STORED trend line — the file a soak appends one line per run to, which is the file
that accumulates across runs — and reads the run against the runs BEFORE it, which is the
comparison `check:soak-trend` makes across runs and one artifact cannot make at all. The
numbers are that gate's own, which is what makes the two agree: each phase's median reload
and the run's total, against the MEDIAN of those same numbers in the baseline, under the same
allowances (a quarter of the baseline's phase median or 2s, a fifth of its total or 10s). A
baseline is the earlier PASSING runs of this run's own profile: a run from another machine is
not a measurement of the same thing, a run that leaked must not become what normal looks
like, and the run's OWN line is not one either — a trend file kept across runs is the file the
run just appended itself to, and a run is not a baseline for itself. Each record left out is
counted and its reason said, line by line.

Two things are read rather than refused, with the caveat named instead of the number
withheld: a baseline thinner than the gate's three runs, because a lone artifact is exactly
when a person wants the number (the report says the gate would not judge a trend on it), and
a run that did NOT pass — the gate judges only a run that passed, since a stopped run's
numbers read as a fast one's, but here the artifact in hand is the red run being diagnosed,
and a red run that got slower is the finding somebody came for. The report gains a `BASELINE`
section naming the file, what of it was a baseline and why the rest was not, and the cost
facts that moved past the allowance; it ends with
`SOAK_DRIFT=DRIFTED|WITHIN|NOT_COMPARED records=N compared=N differences=N cost=<±Nms|?>`.
The exit code stays about the READ: a baseline that reads and holds nothing of this profile is
`NOT_COMPARED` and the account's own code stands, while a file that cannot be read at all is
`exit 2`, because the comparison that was asked for could not be made.

### Landmines

- **A single record cannot see a slower BUILD.** The across-runs half needs three
  earlier runs of the same profile and reports `NOT JUDGED` until it has them, which
  is what the CI step's one-record file does — there, the in-run half is the judge.
  Do not read a green CI trend step as "the build is as fast as it was".
- **A profile is part of the measurement.** Timings from a laptop and a shared runner
  are not two measurements of one thing, so records are compared only within
  `platform/arch/node-major` — and the floor is not compared across runs AT ALL on
  Windows, where the count is sampled by a 400ms watcher (its noise was measured at
  up to 15 handles under load, which is most of a floor's signal). That skip is
  printed by name, not hidden.
- **The budget is a budget.** 25% on a reload, 20% with a 10s allowance on the run's
  cost, both measured against three real runs of one build that differed by about 5%
  end to end. A gate that fires on 5% is a gate somebody turns off, and then it is not
  there for the real regression.
- **In CI, exit 2 is a wiring failure, not a verdict.** At `--reloads 12` every phase
  has the four readings this reads, so "could not judge" there means the trend file is
  missing or unreadable. That is also why a shortened soak fails this step: three
  reloads pass the soak's own checks while checking less than they claim.
- **Keep `--trend` and let `--dir` be fresh.** A trend file is meant to accumulate
  across runs; a `--dir` is meant to belong to ONE run. It holds that run's
  `reloads.jsonl` and its sentinel, and two soaks sharing one write each other's
  records into it. Measured the hard way: a stray soak left over from a killed shell
  ran alongside a freshly started one in the same dir, and the survivor reported 24
  problems about a front port that was not its own (`record 5: frontPort 59380 is not
  the door's 60305`) — none of them a leak. The trend handled it correctly: the failed
  run was recorded, was not a baseline, and was not judged.
- **A run that did not pass is judged by nothing, including itself.** A failed run is
  usually a run that STOPPED, and a stopped run's numbers read as a fast one's (the
  run above came out 48080ms against three passing runs' 73558ms). Read its problems
  instead; the trend names it and exits 2.
- **`leftoverConnections` is the DOOR's own bookkeeping, so a claim about it can be the
  door's arithmetic rather than a moved connection.** The count is every connection the
  door accepted under the port it piped it to, and one connection is forgotten twice
  (its client's socket and the upstream socket behind the door end at different
  moments). The second call used to delete that port's entry on behalf of the set it
  had installed — empty by then — so a client that arrived in the milliseconds between
  the two closes vanished from the count: measured on this repository's own build, a
  **3ms** gap was enough, and the soak was told the door had moved a connection the
  client was still holding, on a busy phase, once in six reloads. Read the run's own
  record before believing it: `held.endedAt` against `swappedAt + windowUsedMs` says
  whether the client believed it held the connection when the count was taken, and a
  door that really MOVED one also answered it from the replacement — one claim alone,
  with nothing else in the run, is the shape of a lost count.
  `tests/dev-supervisor.test.ts` pins the interleaving: a client that keeps its half
  open (`allowHalfOpen`) while the next one connects through the door.
- **The account of a red run is enough to diagnose it, and that is deliberate.** Every
  reload's held connection is in the run's own summary (`reloadsDetail[].held`) and in
  its trend line (`held`, one entry per reload, in order), and the reader NAMES the
  ones that are not the ordinary shape for a run that did not pass — it is judged by
  nothing, but the facts its door claims rest on are spelled out rather than left in a
  problem string. So a red door claim is read from the `soak-account` artifact: the
  reload the claim is about is in the problems, and its `held` entry says whether the
  connection was accepted and when, what the door said to it (with the instant each
  answer arrived) and which side of the swap any of it came from, when it ended, whether
  that was before the count, and what the count was. Re-running
  the soak to see those numbers is not the answer, and it is the reason they are
  carried here rather than derived from the supervisor's log. Each block also names its own SHAPE
  (`anybase-held/2`, declared once as `HELD_SHAPE`), and the readers take answers only from a block that names the
  shape they know: a field that happens to be there is not evidence that the shape is, so an older account is
  read as an older account and an unknown one is named rather than called quiet. `npm run soak:diagnose --
  <download>` is that read, done once and in the order things happened.
- **The trend line is not a committed record.** It is written where the caller says
  (`--trend`, default beside the history in `--dir`), never into the tracked tree, so
  the pin policy in playbook 8 does not apply and nothing is regenerated by a runner.
