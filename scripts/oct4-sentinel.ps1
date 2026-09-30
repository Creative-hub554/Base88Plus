<#
Oct 4 sentinel: the day-after alarm for the Oct 3 cron chain.

GitHub silently skips scheduled workflows when the repo is inactive (60-day
rule), the schedule is auto-disabled, or the runner queue stalls - none of
which produce a red run. oct3-verify's own crons (Oct 3 only, 07:47/09:07/
19:17 UTC) therefore have NO witness the morning after. This sentinel runs
Oct 4 01:00 UTC and asks two questions:

  1. Did a SCHEDULED oct3-verify run attempt fire in the Oct 3..Oct 4 window?
     (event=schedule - dispatch smoke runs are excluded by design)
  2. Did it record a PASS_* verdict on issue #18?
     (verifier comment marker 'post-Oct-3 verifier', verdict in **PASS_...**)

Both yes  -> exit 0, nothing posted (idempotent; re-runs stay silent).
Either no -> exit 1 AND post a SENTINEL_* comment on #18 naming exactly what
             is missing (no run at all = cron chain never fired; run but no
             PASS = chain fired but did not land a pass, includes the run's
             own conclusion). Posting uses GITHUB_TOKEN (issues: write) - the
             same mechanism oct3-verify uses, no PAT in the workflow.

Usage:  pwsh -NoProfile -File scripts/oct4-sentinel.ps1
Env:    VERIFY_TOKEN=<tok>   token override; default on Windows is the
                             Credential Manager entry gh:github.com:Creative-hub554,
                             in CI the workflow passes github.token
        VERIFY_GNOMON=yyyy-MM-dd  fake today (deterministic date-gate rehearsal,
                             same precedent as verify-oct28.ps1)
        VERIFY_FORCE=1       bypass the date gate (plumbing tests only)
        DRY_RUN=1            print the would-be #18 comment instead of posting
Exit:   0 sentinel satisfied (run + PASS verdict exist) or in-progress attempts
             found on sentinel morning (give them until the next cron; only a
             completed day with no PASS fails)
        1 sentinel tripped - the gap was posted on #18
        2 date gate refused (not on/after Oct 4)
#>
$ErrorActionPreference = 'Stop'
if (-not $env:VERIFY_TOKEN) {
  try {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredManOct4 {
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
    $env:VERIFY_TOKEN = [CredManOct4]::Read('gh:github.com:Creative-hub554')
  } catch { } # non-Windows: VERIFY_TOKEN must be provided by the caller
}
if (-not $env:VERIFY_TOKEN) { Write-Output 'NO_TOKEN'; exit 1 }
$h = @{ Authorization = "Bearer $($env:VERIFY_TOKEN)"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
$base = 'https://api.github.com/repos/Creative-hub554/Base88Plus'

# --- 1. date gate: the sentinel only means anything on/after Oct 4 ---
$today = if ($env:VERIFY_GNOMON) { $env:VERIFY_GNOMON } else { (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd') }
if ($today -lt '2026-10-04' -and $env:VERIFY_FORCE -ne '1') {
  Write-Output "REFUSED_DATE_GATE today=$today sentinel fires 2026-10-04T01:00Z (VERIFY_FORCE=1 or VERIFY_GNOMON overrides for plumbing tests)"; exit 2
}

# --- 2. question 1: did a scheduled oct3-verify attempt fire in the window? ---
# Same window convention as the verifier itself (created=2026-10-03..2026-10-04
# is inclusive of both endpoints at day granularity).
$runs = Invoke-RestMethod -Uri "$base/actions/workflows/oct3-verify.yml/runs?event=schedule&created=2026-10-03..2026-10-04&per_page=20" -Headers $h
$day = @($runs.workflow_runs)
Write-Output "scheduled oct3-verify attempts in 2026-10-03..2026-10-04: $($day.Count)"
$day | ForEach-Object { Write-Output ("  run " + $_.id + " " + $_.status + "/" + $_.conclusion + " started " + $_.created_at + " - " + $_.html_url) }

if ($day.Count -eq 0) {
  $verdict = 'SENTINEL_NO_SCHEDULED_RUN'
  $comment = "post-Oct-3 sentinel (checked $today): **SENTINEL_NO_SCHEDULED_RUN**`n`nThe Oct 4 sentinel found NO scheduled (event=schedule) oct3-verify run in the 2026-10-03..2026-10-04 window - none of the three Oct 3 crons (07:47/09:07/19:17 UTC) ever fired. GitHub skips scheduled workflows silently (60-day repo inactivity auto-disable, schedule disabled manually, or runner-queue stall), so there is no red run to alert on; this comment is that alert.`n`nNext: open Actions > Oct 3 verifier and check the workflow state (re-enable if 'disabled_manually'/'disabled_inactivity'), confirm the repo was not idle >60 days, then run the verification manually (ci.yml dispatch with force_snapshot_refresh, or an oct3-verify workflow_dispatch is smoke-only - it does NOT post) and post the verdict on #18. Then re-run the sentinel to clear."
  Write-Output "VERDICT=$verdict"
} else {
  $inProgress = @($day | Where-Object { $_.status -ne 'completed' })
  if ($inProgress.Count -gt 0) {
    # The verifier exits 0 on RUN_IN_PROGRESS and the next cron attempt re-checks;
    # on the morning after cron day a still-running attempt is unusual but not a
    # failure - fail the alarm only on evidence, not on a race.
    Write-Output "SENTINEL_IN_PROGRESS $($inProgress.Count) attempt(s) still running on sentinel morning - not a gap; re-run later"
    exit 0
  }
  # --- 3. question 2: did a completed run post a PASS_* verdict on #18? ---
  $comments = Invoke-RestMethod -Uri "$base/issues/18/comments?since=2026-10-03T00:00:00Z&per_page=100" -Headers $h
  $verdictComments = @($comments) | Where-Object { $_.body -like '*post-Oct-3 verifier*' }
  $pass = @($verdictComments) | Where-Object { $_.body -match '\*\*PASS_[A-Z_]+\*\*' }
  Write-Output "#18 verifier comments since Oct 3: $($verdictComments.Count) (PASS: $($pass.Count))"
  if ($pass.Count -gt 0) {
    $latest = $pass | Sort-Object created_at -Descending | Select-Object -First 1
    Write-Output ("SENTINEL_OK latest PASS from run comment " + $latest.id + " at " + $latest.created_at + " - the chain fired and landed a PASS verdict")
    exit 0
  }
  $latestConclusion = ($day | Sort-Object created_at -Descending | Select-Object -First 1).conclusion
  $verdict = 'SENTINEL_RUN_NO_PASS'
  $comment = "post-Oct-3 sentinel (checked $today): **SENTINEL_RUN_NO_PASS**`n`nThe Oct 4 sentinel found $($day.Count) completed scheduled oct3-verify attempt(s) in the 2026-10-03..2026-10-04 window (latest conclusion: $latestConclusion), but NO comment on #18 carries a PASS verdict marker (bold PASS_...; verifier comments found: $($verdictComments.Count)). The chain fired but did not land a pass - either every attempt failed before recording, or the recorded verdict was ATTENTION_*/FAIL_*/CRON_NOT_FOUND.`n`nNext: pull the oct3-verify-log artifacts from the runs above and the verifier comments on #18 for the specific verdict, follow its Next: block, fix, and re-verify. Then re-run the sentinel to clear."
  Write-Output "VERDICT=$verdict"
}

# --- 4. record the gap on #18 (idempotent by sentinel-day marker) ---
$prior = Invoke-RestMethod -Uri "$base/issues/18/comments?since=2026-10-04T00:00:00Z&per_page=50" -Headers $h
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
