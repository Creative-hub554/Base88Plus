# Token rotation runbook

Rotating the GitHub token stored in Windows Credential Manager under
`gh:github.com:Creative-hub554` used to be a three-day debugging saga (12+
attempts across 2026-09-26 → 09-28). Every failure mode is now understood and
encoded into tooling. **The next rotation is one command:**

```bash
npm run rotate
```

That runs preflight, supervises the device flow, and — once you approve a code
in the browser — swaps the CredMan credential and runs the full battery
automatically. Expect to spend ~2 minutes of human attention per attempt.

## Files

| File | Role |
| --- | --- |
| `scripts/rotate.mjs` | Orchestrator: preflight → poller supervision → battery. Holds no secrets. |
| `scripts/rotation/rotate-hard.cjs` | Device-flow poller: mints codes, polls, delegates the swap. |
| `scripts/rotation/cred-swap.ps1` | CredWriteW swap with Persist/UserName preservation, read-back verify, rollback. |
| `scripts/rotation/cred-read.ps1` | CredMan read (UTF-16LE decode) used by preflight and every battery step. |
| `.freebuff/rotation-status.txt`, `rotator.log`, `device-code.json` | Live run state (gitignored). `npm run rotate -- --status` prints them. |

## The command surface

```bash
npm run rotate                    # full rotation + battery
npm run rotate -- --gens 12       # limit generations (default 150 ≈ 36 h runway)
npm run rotate -- --no-battery    # swap only, battery later
npm run rotate -- --battery-only  # re-run B1–B5 against the current token
npm run rotate -- --status        # inspect last run + current token fingerprint
```

Environment overrides: `ROTATE_LOGIN`, `ROTATE_REPO`, `ROTATE_TARGET`
(CredMan target name), `ROTATE_GENS`, `ROTATE_CLIENT_ID` (device-flow OAuth
app), `ROTATE_SCOPES`, `ROTATE_BATTERY_ISSUE`.

## What you (the human) do

1. When a `CODE XXXX-XXXX` banner appears, open
   [github.com/login/device](https://github.com/login/device), **Continue**,
   and type the code into the 8 boxes.
2. If GitHub challenges you (sudo / re-auth: passkey, authenticator, GitHub
   Mobile, or an emailed **8-char no-dash** code), clear it **in the same
   sitting** — the challenge is per-flow and re-arms on the next flow.
3. Authorize **GitHub CLI** when prompted. The poller grabs the token within
   seconds, swaps CredMan, verifies by read-back, and the battery runs.

Codes auto-refresh every ~15 minutes; you can walk away and come back.

## Battery (automated, all via the freshly swapped token)

- **B1** CredMan read: `gho_`, expected length, fingerprint matches `TOKEN_SEEN`.
- **B2** `GET /user`: HTTP 200, login matches, scopes include `repo` + `workflow`.
- **B3** Authenticated write: comment on the battery issue (dedup-guarded by
  date marker `cm-path-check-YYYY-MM-DD`).
- **B4** Git round trip: `ls-remote` + `git push` with the token injected via
  `GIT_CONFIG_*` **environment variables** (never a config file or URL — an
  earlier variant echoed a token into the transcript that way).
- **B5** Verifier smoke: `scripts/verify-oct28.ps1` with `VERIFY_FORCE=1
  DRY_RUN=1 VERIFY_TOKEN=… SMOKE_RUN_ID=<latest main CI run>`; before
  2026-10-28 the correct verdict is `SMOKE_FAIL_NOT_PROMOTED` (exit 1).

## The four root causes (why 12+ attempts failed)

1. **The poller exited on flow errors.** A stray or wrong approval produced
   `FLOW_ERROR access_denied` / `incorrect_device_code` and the poller died,
   silently, sometimes hours before anyone looked. Fixed: unknown flow errors
   are logged, cooled down, and the next code is minted (`rotate-hard.cjs`).
   Also: 150-generation runway and per-request retries.
2. **The device-entry form does not auto-advance or accept packed input.**
   Pasting `ABCD-1234` into the first box, or the `?user_code=` URL parameter,
   both end in `not_found`. The form is 8 `aria-label="User code N"` inputs
   where **index 4 is a hidden input holding the dash**. Browser automation
   must fill each visible box via the native value setter + input/change
   events, then click **Continue**.
3. **The confirmation page's Authorize button is anti-clickjacking-disabled.**
   Its enable script may not run in embedded browsers. `form.submit()` is a
   **trap**: the POST then lacks the `authorize` submitter value and GitHub
   reads it as **deny**. The fix: `btn.disabled = false; btn.click()`.
4. **Sudo mode is a second challenge *inside* the device flow**, and it
   re-arms per flow unless cleared in the same sitting. Two gotchas:
   the emailed code has **no dash** (the dashed code is the *device* code —
   entering it on the sudo page is what killed one attempt), and a warm sudo
   window (e.g. right after revoking a grant) can remove the challenge
   entirely for the next flow.

## Revocation closure (when you want the old token *dead*, not just replaced)

The old and new tokens share one OAuth grant (same app + scopes), so a browser
**Revoke** at [github.com/settings/applications](https://github.com/settings/applications)
kills **both** — do it, then immediately run `npm run rotate` while sudo is
still warm (the device flow usually skips the email challenge in that
window). Scripted selective revocation is not possible without the OAuth app's
client secret — never extract it from tooling binaries.

Post-revoke sanity check: `npm run rotate -- --status` still shows the old
fingerprint (CredMan keeps it until the swap), but `curl -s -o /dev/null -w
"%{http_code}" -H "Authorization: Bearer $(...)" https://api.github.com/user`
must return **401** before you mint the replacement.

## Design invariants

- The token travels **env-only** between processes (`NEW_TOKEN`,
  `VERIFY_TOKEN`); it is never an argv, a file, or a transcript line.
- CredMan is the **only** persistent store; scratch state under `.freebuff/`
  is gitignored and contains no secrets (fingerprints only).
- Git auth is **env-config only** (`GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0`);
  never a bare-URL or `http.extraheader` config line on disk.
- The swap preserves `Persist`/`UserName` and rolls back automatically if the
  read-back comparison fails — a half-swapped credential cannot survive.
