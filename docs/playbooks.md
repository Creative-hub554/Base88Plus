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

The one true path for landing anything. Used for #43–#75 without a single
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
`smoke: true`. Oct 3 smoke expects `SMOKE_PASS*`; Oct 28 smoke sets
`VERIFY_EXPECT_CANARY=1`, so `SMOKE_FAIL_NOT_PROMOTED` →
`SMOKE_PRE_PROMO_AS_EXPECTED` is the GREEN pre-promo outcome.

**Landmines:** `ConvertFrom-Json` yields `_fetchedAt` as a String — in
PowerShell, `string -lt [datetime]` coerces the DATETIME to a string, so
`2026-09-xx` compares GREATER than `2026-10-03` lexicographically. Cast both
sides (`[datetime]$wrapper._fetchedAt`). `VERIFY_GNOMON=yyyy-MM-dd` fakes
"today" for deterministic date rehearsal. `NO_DISPATCH_RUN` is exit 0 on
purpose — treat it as a nudge, not a failure. A failed pre-credential
rehearsal proves nothing about the credential: only a full-path test-fire
(design: `force_snapshot_refresh` on ci.yml, pinned to main) exercises the
push. A "Permission denied (publickey)" AFTER a server roundtrip means
key-not-registered, not key-not-offered.
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
(`check:oct3` / `check:oct28`, the one-shot human entry) → **operator
runbook**. Each layer assumes the one below it may be silently skipped —
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
25 unit tests). Per scheduled workflow: API `state == active`; every
`schedule:` cron line parses; forward-satisfiable within **1500 days** (a
full leap cycle — 400 misses Feb-29 crons half the time); the most recent
**due** fire has a scheduled run at/after it (a run starts AT the due
minute, so `>= due` is the evidence; in-progress counts; a RED run still
proves the schedule fired), floored by the workflow's `created_at` so
date-gated chains are `NOT_YET_DUE` before their first fire, never falsely
dead. Findings → exit 1 + one deduped comment on #18 (8-day window);
healthy → exit 0 silent. The heartbeat audits its own cron too, and excludes
GitHub's synthetic `dynamic/dependabot/...` workflow entry (no file).
Rehearse with the `dry_run` dispatch input; extend by adding crons — the
auditor picks them up automatically.

**Landmines (each cost a debugging cycle once):** cron single values are
single values — `53` is 53, not vixie 53-max (only `a/s` means `a-max/s`);
the next-fire walk must INCLUDE the start day (later-today slots count);
comment lines INSIDE a `schedule:` block must not reset a line-scanner's
state machine (ci.yml/codeql/drill were silently skipped that way); a
typo'd cron must be a FINDING (unsatisfiable), never a skip; and a
day-after sentinel must stay meaningful when the chain is operator-in-the-
loop — `SENTINEL_AWAITING_DISPATCH` is a reminder, not a malfunction, and
the comment must say so.
