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

The one true path for landing anything. Used for #43–#61 without a single
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
  `.freebuff/tmp/wfschema.json`; correct PyYAML's bare-`on:` → `True` quirk
  first).
- Inline (non-file) JSON in curl on Windows silently fails → always
  `--data-binary @file`.
- Poll with the token attached: anonymous polling burns the 60/hr rate limit
  and the failure looks like a KeyError, not an error.
- python that reads files must use workspace-relative paths — native Windows
  python cannot open msys `/tmp/...` (bash redirects and curl can).
- Windows python + msys paths: write with `> file`, read with `< file` or
  workspace-relative paths. Never `open('/tmp/...')` in python.

---

## 2. Release (v0.2.5–v0.2.9 shipped this way)

1. `git checkout -b release/vX.Y.Z` from a fresh main.
2. CHANGELOG: convert the `Unreleased` block into `## [X.Y.Z] — <date>` with
   an intro + Added/Changed/Fixed; add the tag link
   `[X.Y.Z]: .../releases/tag/vX.Y.Z`. **Empty the Unreleased block** — a
   stale one double-publishes entries (caught at v0.2.9).
3. Version trio:
   `sed -i '0,/"version": "X.Y.W"/s//"version": "X.Y.Z"/'` on package.json
   and package-lock.json (the `0,` replaces only the FIRST occurrence), then
   `npm install --package-lock-only --ignore-scripts`. Verify counts: 1× in
   package.json, 2× in the lock, zero remnants.
4. Battery: `npm test` (245), `npx tsc --noEmit`, `npx eslint .`,
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

---

## 5. Generated-app loop (context for the pins CI enforces)

Generate → `npm run verify:app` (harness; `--strict` is the CI default) →
`npm run new:pin -- <projectId> <assertions.cjs> [--force]` (validates, copies
verbatim, runs the full set, rolls back on failure) → CI pins enforce forever.
Prompt rules the generator must obey: single-writer state, clear-before-refill,
never query an id/class that isn't in the shipped HTML.
