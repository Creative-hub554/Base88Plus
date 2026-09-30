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
    - #18 is CLOSED (closure is operator-only via CLOSE=1 after a PASS -
      mission accomplished even if a later verifier comment re-opened the
      classification), OR
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
$base = 'https://api.github.com/repos/Creative-hub554/Base88Plus'

# --- 1. date gate: the sentinel only means anything on/after Oct 29 ---
$today = if ($env:VERIFY_GNOMON) { $env:VERIFY_GNOMON } else { (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd') }
if ($today -lt '2026-10-29' -and $env:VERIFY_FORCE -ne '1') {
  Write-Output "REFUSED_DATE_GATE today=$today sentinel fires 2026-10-29T01:00Z (VERIFY_FORCE=1 or VERIFY_GNOMON overrides for plumbing tests)"; exit 2
}

# --- 2. early-out: an operator-closed #18 IS the mission accomplished ---
$issue = Invoke-RestMethod -Uri "$base/issues/18" -Headers $h
Write-Output "ISSUE18 state=$($issue.state) comments=$($issue.comments)"
if ($issue.state -eq 'closed') {
  Write-Output 'SENTINEL_OK #18 is closed - the promotion chain completed (closure is operator-only via CLOSE=1 after a PASS).'
  exit 0
}

# --- 3. question 1: did a scheduled oct28-verify attempt fire in the window? ---
$runs = Invoke-RestMethod -Uri "$base/actions/workflows/oct28-verify.yml/runs?event=schedule&created=2026-10-28..2026-10-29&per_page=20" -Headers $h
$day = @($runs.workflow_runs)
Write-Output "scheduled oct28-verify attempts in 2026-10-28..2026-10-29: $($day.Count)"
$day | ForEach-Object { Write-Output ("  run " + $_.id + " " + $_.status + "/" + $_.conclusion + " started " + $_.created_at + " - " + $_.html_url) }

if ($day.Count -eq 0) {
  $verdict = 'SENTINEL_NO_SCHEDULED_RUN'
  $comment = "post-Oct-28 sentinel (checked $today): **SENTINEL_NO_SCHEDULED_RUN**`n`nThe Oct 29 sentinel found NO scheduled (event=schedule) oct28-verify run in the 2026-10-28..2026-10-29 window - none of the four Oct 28 crons (07:23/09:33/13:33/19:33 UTC) ever fired. GitHub skips scheduled workflows silently (60-day repo inactivity auto-disable, schedule disabled manually, or runner-queue stall), so there is no red run to alert on; this comment is that alert.`n`nNext: open Actions > Oct 28 verifier and check the workflow state (re-enable if 'disabled_manually'/'disabled_inactivity'), confirm the repo was not idle >60 days, then run the verification manually (run scripts/verify-oct28.ps1 after firing the promotion dispatch) and post the verdict on #18. Then re-run the sentinel to clear."
  Write-Output "VERDICT=$verdict"
} else {
  $inProgress = @($day | Where-Object { $_.status -ne 'completed' })
  if ($inProgress.Count -gt 0) {
    Write-Output "SENTINEL_IN_PROGRESS $($inProgress.Count) attempt(s) still running on sentinel morning - not a gap; re-run later"
    exit 0
  }
  # --- 4. question 2: what did the chain record on #18? (latest verdict wins) ---
  $comments = Invoke-RestMethod -Uri "$base/issues/18/comments?since=2026-10-28T00:00:00Z&per_page=100" -Headers $h
  $verdictComments = @($comments) | Where-Object { $_.body -like '*post-Oct-28 verifier*' }
  $latest = $verdictComments | Sort-Object created_at -Descending | Select-Object -First 1
  Write-Output "#18 verifier comments since Oct 28: $($verdictComments.Count)"
  if ($verdictComments.Count -gt 0) {
    Write-Output ("  latest: " + $latest.id + " at " + $latest.created_at + ": " + (($latest.body -split "`n" | Select-Object -First 1) -join ''))
  }
  $v = $null
  if ($latest -and $latest.body -match '\*\*(PASS_[A-Z_]+)\*\*') { $v = $Matches[1] }
  elseif ($latest -and $latest.body -match '\*\*(NO_DISPATCH_RUN)\*\*') { $v = 'NO_DISPATCH_RUN' }
  elseif ($latest -and $latest.body -match '\*\*((FAIL|PRE_PROMO)_[A-Z_]+)\*\*') { $v = $Matches[1] }
  Write-Output "VERDICT_CLASSIFIED=$v"

  if ($v -like 'PASS*') {
    Write-Output "SENTINEL_OK latest verifier verdict $v - the chain fired, verified the promotion, and recorded it."
    exit 0
  }
  if ($v -eq 'NO_DISPATCH_RUN') {
    $verdict = 'SENTINEL_AWAITING_DISPATCH'
    $comment = "post-Oct-28 sentinel (checked $today): **SENTINEL_AWAITING_DISPATCH**`n`nThe Oct 29 sentinel found $($day.Count) completed scheduled oct28-verify attempt(s) (latest conclusion: $(($day | Sort-Object created_at -Descending | Select-Object -First 1).conclusion)), but the latest verdict on #18 is still **NO_DISPATCH_RUN**: promotion day ended with the operator dispatch never fired, ~24h later. This is NOT a chain malfunction - NO_DISPATCH_RUN is exit 0 BY DESIGN in the verifier (firing the ci.yml dispatch is a deliberate operator act) - but the day after should not pass silently with Node 26 still not a required gate.`n`nNext: fire the promotion dispatch (POST /repos/Creative-hub554/Base88Plus/actions/workflows/ci.yml/dispatches, body {`"ref`":`"refs/heads/main`"}, expect 204; use a payload file, never inline printf JSON), wait for it to finish, then re-run scripts/verify-oct28.ps1 (or wait for a verifier cron if today is still Oct 28) so PASS_PROMOTED lands on #18. Then re-run the sentinel to clear."
    Write-Output "VERDICT=$verdict"
  } else {
    $verdict = 'SENTINEL_RUN_NO_PASS'
    $tail = if ($latest) { "the latest verdict is $v" } else { "NO verdict was posted at all" }
    $comment = "post-Oct-28 sentinel (checked $today): **SENTINEL_RUN_NO_PASS**`n`nThe Oct 29 sentinel found $($day.Count) completed scheduled oct28-verify attempt(s) (latest conclusion: $(($day | Sort-Object created_at -Descending | Select-Object -First 1).conclusion)), but $tail (verifier comments found: $($verdictComments.Count)). The chain fired but did not land a pass.`n`nNext: pull the oct28-verify-log artifacts from the runs above and the verifier comments on #18 for the specific verdict, follow its Next: block, fix, and re-verify. Then re-run the sentinel to clear."
  }
}

# --- 5. record the gap on #18 (idempotent by sentinel-day marker) ---
$prior = Invoke-RestMethod -Uri "$base/issues/18/comments?since=2026-10-29T00:00:00Z&per_page=50" -Headers $h
$marker = "sentinel (checked $today)"
if (@($prior) | Where-Object { $_.body -like "*$marker*" }) { Write-Output "ALREADY_RECORDED ($marker)"; exit 1 }
if ($env:DRY_RUN -eq '1') { Write-Output '--- DRY RUN: comment body below (not posted) ---'; Write-Output $comment; exit 1 }
$cb = @{ body = $comment } | ConvertTo-Json
try {
  $r = Invoke-RestMethod -Uri "$base/issues/18/comments" -Method Post -Headers $h -ContentType 'application/json' -Body $cb
  Write-Output (("COMMENT_POSTED id=") + $r.id)
} catch {
  Write-Output (("COMMENT_FAILED ") + $_.Exception.Message)
  if ($_.ErrorDetails) { Write-Output $_.ErrorDetails.Message }
  if ($comment -match '[^\x00-\x7F]') { Write-Output 'HINT non-ASCII characters detected in body' }
}
exit 1
