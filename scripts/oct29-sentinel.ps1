<#
Oct 29 sentinel: the day-after alarm for the Oct 28 promotion chain.

GitHub skips scheduled workflows SILENTLY (60-day repo inactivity
auto-disable, a manually disabled schedule, runner-queue stalls): there is
no red run, no notification, nothing. oct28-verify's four Oct 28 crons
(07:23/09:33/13:33/19:33 UTC) are therefore unverifiable from inside
themselves - if none of them ever fires, nothing on Earth notices. This
sentinel runs Oct 29 01:00 UTC and reads the promotion day's durable
record (issue #18) plus the run list, and classifies four states:

  SATISFIED (exit 0, silent):
    - the latest 'post-Oct-28 verifier' verdict on #18 is PASS_* (the
      promotion was verified and recorded), OR
    - #18 is CLOSED on/after promotion day (closure is operator-only via
      CLOSE=1 after a PASS; a closure dated BEFORE the chain ran is
      premature and does NOT blind the sentinel), OR
    - scheduled attempts exist and the latest is still in progress (fail
      on evidence, not on a race)
  SENTINEL_NO_SCHEDULED_RUN (exit 1 + comment): none of the four Oct 28
    crons ever fired - the silent-skip gap this sentinel exists for.
  SENTINEL_AWAITING_DISPATCH (exit 1 + comment): the chain fired and the
    latest verifier verdict is NO_DISPATCH_RUN - promotion day ended with
    the operator act still undone (~24h later). A loud reminder, NOT a
    chain malfunction: NO_DISPATCH_RUN is exit 0 BY DESIGN in the verifier
    (firing the dispatch is a deliberate operator act); this sentinel just
    refuses to let the day after pass silently with promotion unacted.
  SENTINEL_RUN_NO_PASS (exit 1 + comment): the chain fired but the latest
    verdict is FAIL_*/PRE_PROMO_* or no verdict was posted at all.

Latest-verdict-wins: the newest post-Oct-28 verifier comment decides, so a
late FAIL after an earlier PASS trips the alarm (an earlier PASS does not
whitewash a later failure). Sentinel's own comments are excluded from the
verdict scan. Posting uses GITHUB_TOKEN (issues: write) - the same
mechanism the verifiers use; no PAT in the workflow.

Usage:  pwsh -NoProfile -File scripts/oct29-sentinel.ps1
Env:    VERIFY_TOKEN=<tok>   token override; default on Windows is the
                             Credential Manager entry gh:github.com:Creative-hub554,
                             in CI the workflow passes github.token
        VERIFY_GNOMON=yyyy-MM-dd  fake today (deterministic date-gate rehearsal)
        VERIFY_FORCE=1       bypass the date gate (plumbing tests only)
        DRY_RUN=1            print the would-be #18 comment instead of posting
Exit:   0 sentinel satisfied (PASS recorded / #18 closed / attempts in progress)
        1 sentinel tripped - the gap was posted on #18
        2 date gate refused (not on/after Oct 29)
#>
$ErrorActionPreference = 'Stop'
if (-not $env:VERIFY_TOKEN) {
  try {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredManOct29 {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredReadW(string target, int type, int flags, out IntPtr credPtr);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) return null;
    CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
    byte[] blob = new byte[c.CredentialBlobSize];
    Marshal.Copy(c.CredentialBlob, blob, 0, blob.Length);
    Marshal.FreeCoTaskMem(p);
    string uni = System.Text.Encoding.Unicode.GetString(blob).TrimEnd('\0');
    if (uni != null && uni.StartsWith("gh")) return uni;
    return System.Text.Encoding.UTF8.GetString(blob).TrimEnd('\0');
  }
}
"@
    $env:VERIFY_TOKEN = [CredManOct29]::Read('gh:github.com:Creative-hub554')
  } catch { } # non-Windows: VERIFY_TOKEN must be provided by the caller
}
if (-not $env:VERIFY_TOKEN) { Write-Output 'NO_TOKEN'; exit 1 }
$h = @{ Authorization = "Bearer $($env:VERIFY_TOKEN)"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
# --- 0. the contract (scripts/verdict-contract.json) ---
# The chain this sentinel witnesses, the marker/window/shape it reads out of that
# chain's records, and the marker and day of its OWN record are declared once and
# derived here, like the Oct 4 sentinel - the recovery pass and the heartbeat
# auditor read the same declaration.
. (Join-Path $PSScriptRoot 'verdict-contract.ps1')
$contract = Get-VerdictContract
$record = Get-VerdictRecord -Contract $contract -ScriptPath $PSCommandPath
$watched = $contract.workflows.($record.witnesses)
$base = "https://api.github.com/repos/$($contract.repo)"
# Named differently from the others because $issue below is the fetched issue
# OBJECT, not its number - and an object interpolated into a URL is a 404.
$issueNumber = $contract.issue
$windowStart = $watched.recordsOn
$windowEnd = $record.recordsOn

# --- 1. date gate: the sentinel only means anything on/after Oct 29 ---
$today = if ($env:VERIFY_GNOMON) { $env:VERIFY_GNOMON } else { (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd') }
# A faked calendar must not be able to file a record on GitHub; the transport, not
# the date, decides whether it can (see Test-VerdictSimulatedTransport, and the
# 2026-09-30 gnomon rehearsal that filed a false record on #18 - it had no
# simulated transport, and that case still forces DRY_RUN here).
if ($env:VERIFY_FORCE -eq '1' -or $env:VERIFY_GNOMON) {
  if (Test-VerdictSimulatedTransport) {
    Write-Output 'SIMULATED_WORLD (faked date + rehearsal transport - a record filed here lands in the simulated world, never on GitHub)'
  } else {
    $env:DRY_RUN = '1'
    Write-Output 'FORCED_DRY_RUN (VERIFY_FORCE/VERIFY_GNOMON set - rehearsals never post)'
  }
}
if ($today -lt $record.recordsOn -and $env:VERIFY_FORCE -ne '1') {
  Write-Output "REFUSED_DATE_GATE today=$today sentinel fires $($record.recordsOn)T01:00Z (VERIFY_FORCE=1 or VERIFY_GNOMON overrides for plumbing tests)"; exit 2
}

# --- 2. early-out: an operator-closed #18 on/after promotion day IS the mission accomplished ---
# Guard on closed_at: closure is the operator's LAST act (CLOSE=1 after
# PASS_PROMOTED on Oct 28). A closure BEFORE the chain ran (rehearsed live
# 2026-09-30: #18 was found closed since 2026-09-29) must NOT blind the
# sentinel - fall through and judge on runs + verdicts like normal, and flag
# the premature closure in any trip comment. Cast BOTH sides (playbook
# landmine: string-vs-DateTime comparison direction).
$issueObj = Invoke-RestMethod -Uri "$base/issues/$issueNumber" -Headers $h
Write-Output "ISSUE18 state=$($issueObj.state) closed_at=$($issueObj.closed_at) comments=$($issueObj.comments)"
$closedEarly = $false
if ($issueObj.state -eq 'closed') {
  # The promotion-day floor is the witnessed chain's own day, not a retyped date.
  if ([datetime]$issueObj.closed_at -ge [datetime]$watched.recordsOn) {
    Write-Output 'SENTINEL_OK #18 closed on/after promotion day - the promotion chain completed (closure is operator-only via CLOSE=1 after a PASS).'
    exit 0
  }
  $closedEarly = $true
  Write-Output "WARN_CLOSED_EARLY #18 was closed at $($issueObj.closed_at), BEFORE the promotion chain ran - closure cannot mean mission-accomplished; judging on runs + verdicts instead."
}

# --- 3. question 1: did a scheduled oct28-verify attempt fire in the window? ---
$runs = Invoke-RestMethod -Uri "$base/actions/workflows/$($record.witnesses)/runs?event=schedule&created=$windowStart..$windowEnd&per_page=20" -Headers $h
$day = @($runs.workflow_runs)
Write-Output "scheduled $($record.witnesses) attempts in $windowStart..${windowEnd}: $($day.Count)"
$day | ForEach-Object { Write-Output ("  run " + $_.id + " " + $_.status + "/" + $_.conclusion + " started " + $_.created_at + " - " + $_.html_url) }

if ($day.Count -eq 0) {
  $verdict = 'SENTINEL_NO_SCHEDULED_RUN'
  $comment = "$(Format-VerdictHeader -Record $record -Day $today): **SENTINEL_NO_SCHEDULED_RUN**`n`nThe Oct 29 sentinel found NO scheduled (event=schedule) $($record.witnesses) run in the $windowStart..$windowEnd window - none of the four Oct 28 crons (07:23/09:33/13:33/19:33 UTC) ever fired. GitHub skips scheduled workflows silently (60-day repo inactivity auto-disable, schedule disabled manually, or runner-queue stall), so there is no red run to alert on; this comment is that alert.`n`nNext: open Actions > Oct 28 verifier and check the workflow state (re-enable if 'disabled_manually'/'disabled_inactivity'), confirm the repo was not idle >60 days, then run the verification manually (run scripts/verify-oct28.ps1 after firing the promotion dispatch) and post the verdict on #18. Then re-run the sentinel to clear."
  Write-Output "$($contract.logSyntax.verdict)$verdict"
} else {
  $inProgress = @($day | Where-Object { $_.status -ne 'completed' })
  if ($inProgress.Count -gt 0) {
    Write-Output "SENTINEL_IN_PROGRESS $($inProgress.Count) attempt(s) still running on sentinel morning - not a gap; re-run later"
    exit 0
  }
  # --- 4. question 2: what did the chain record on #18? (latest verdict wins) ---
  $comments = Invoke-RestMethod -Uri "$base/issues/$issueNumber/comments?since=$($watched.readsSince)&per_page=100" -Headers $h
  # Same @(...) result-wrap as the Oct 4 sentinel: a single verdict comment is
  # one PSCustomObject, whose .Count is EMPTY rather than 1, so the
  # `-gt 0` gate below would skip the latest-verdict branch on the one case it
  # exists to read. A promotion day legitimately posts as few as one.
  $verdictComments = @(@($comments) | Where-Object { $_.body -like "*$($watched.marker)*" })
  $latest = $verdictComments | Sort-Object created_at -Descending | Select-Object -First 1
  Write-Output "#18 verifier comments since Oct 28: $($verdictComments.Count)"
  if ($verdictComments.Count -gt 0) {
    Write-Output ("  latest: " + $latest.id + " at " + $latest.created_at + ": " + (($latest.body -split "`n" | Select-Object -First 1) -join ''))
  }
  # One shape, from the witness's declared vocabulary - which is why PRE_PROMO_*
  # and NO_DISPATCH_RUN need no branches of their own here: they are what that
  # verifier posts, and the declaration is where that is written down.
  $v = $null
  if ($latest -and $latest.body -match $watched.recordShape) { $v = $Matches[1] }
  Write-Output "VERDICT_CLASSIFIED=$v"

  if ($v -like 'PASS*') {
    Write-Output "SENTINEL_OK latest verifier verdict $v - the chain fired, verified the promotion, and recorded it."
    exit 0
  }
  if ($v -eq 'NO_DISPATCH_RUN') {
    $verdict = 'SENTINEL_AWAITING_DISPATCH'
    $comment = "$(Format-VerdictHeader -Record $record -Day $today): **SENTINEL_AWAITING_DISPATCH**`n`nThe Oct 29 sentinel found $($day.Count) completed scheduled oct28-verify attempt(s) (latest conclusion: $(($day | Sort-Object created_at -Descending | Select-Object -First 1).conclusion)), but the latest verdict on #18 is still **NO_DISPATCH_RUN**: promotion day ended with the operator dispatch never fired, ~24h later. This is NOT a chain malfunction - NO_DISPATCH_RUN is exit 0 BY DESIGN in the verifier (firing the ci.yml dispatch is a deliberate operator act) - but the day after should not pass silently with Node 26 still not a required gate.`n`nNext: fire the promotion dispatch (POST /repos/$($contract.repo)/actions/workflows/ci.yml/dispatches, body {`"ref`":`"refs/heads/main`"}, expect 204; use a payload file, never inline printf JSON), wait for it to finish, then re-run scripts/verify-oct28.ps1 (or wait for a verifier cron if today is still Oct 28) so PASS_PROMOTED lands on #18. Then re-run the sentinel to clear."
    Write-Output "$($contract.logSyntax.verdict)$verdict"
  } else {
    $verdict = 'SENTINEL_RUN_NO_PASS'
    $tail = if ($latest) { "the latest verdict is $v" } else { "NO verdict was posted at all" }
    $comment = "$(Format-VerdictHeader -Record $record -Day $today): **SENTINEL_RUN_NO_PASS**`n`nThe Oct 29 sentinel found $($day.Count) completed scheduled oct28-verify attempt(s) (latest conclusion: $(($day | Sort-Object created_at -Descending | Select-Object -First 1).conclusion)), but $tail (verifier comments found: $($verdictComments.Count)). The chain fired but did not land a pass.`n`nNext: pull the oct28-verify-log artifacts from the runs above and the verifier comments on #18 for the specific verdict, follow its Next: block, fix, and re-verify. Then re-run the sentinel to clear."
    # This branch used to be the one trip path that printed no VERDICT= line.
    # scripts/recover-verdicts.mjs reads that line as the difference between "no
    # verdict was computed" and "a verdict was computed and LOST": without it, a
    # SENTINEL_RUN_NO_PASS whose comment failed to post is not recoverable from its
    # own artifact and needs a human. Found by the rehearsal, not by a live gap.
    Write-Output "$($contract.logSyntax.verdict)$verdict"
  }
}

# --- 5. record the gap on #18 (idempotent by sentinel-day marker) ---
if ($closedEarly) {
  $comment = $comment + "`n`nNote: #18 is currently CLOSED (since $($issueObj.closed_at)) even though the promotion chain has not completed - reopening it is an operator call (the runbook reserves closure for after PASS_PROMOTED on Oct 28)."
}
# Print the composed body ALWAYS, not only on the dry path (and after the
# closed-early suffix above, so the artifact carries the final text). The
# uploaded oct29-sentinel-log artifact is the recovery source for
# scripts/recover-verdicts.mjs, and a log carrying the exact comment cannot be
# mis-transcribed the way a hand recovery can.
Write-Output $contract.logSyntax.body
Write-Output $comment
# This record's identity, rendered from the contract: written and searched-for are
# the same string, by construction.
$header = Format-VerdictHeader -Record $record -Day $today
$prior = Invoke-RestMethod -Uri "$base/issues/$issueNumber/comments?since=$($record.recordsOn)T00:00:00Z&per_page=50" -Headers $h
if (@($prior) | Where-Object { $_.body -like "*$header*" }) { Write-Output "ALREADY_RECORDED ($header)"; exit 1 }
if ($env:DRY_RUN -eq '1') { Write-Output '--- DRY RUN: comment body below (not posted) ---'; Write-Output $comment; exit 1 }
$cb = @{ body = $comment } | ConvertTo-Json
try {
  $r = Invoke-RestMethod -Uri "$base/issues/$issueNumber/comments" -Method Post -Headers $h -ContentType 'application/json' -Body $cb
  Write-Output (("COMMENT_POSTED id=") + $r.id)
} catch {
  Write-Output (($contract.logSyntax.commentFailed) + $_.Exception.Message)
  if ($_.ErrorDetails) { Write-Output $_.ErrorDetails.Message }
  if ($comment -match '[^\x00-\x7F]') { Write-Output 'HINT non-ASCII characters detected in body' }
}
exit 1
