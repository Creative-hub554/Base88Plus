<#
oct28-check: one-shot promotion-day status check for the Node 26
canary->gate promotion (2026-10-28).

Answers the only question that matters on the day: did the scheduled
oct28-verify run complete and what did it post on issue #18?

Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/oct28-check.ps1
Env:    VERIFY_TOKEN=<tok>  token override; default is the Windows CredMan
        entry gh:github.com:Creative-hub554
Exit:   0 CONFIRMED_PASS   - latest #18 verdict is PASS_PROMOTED /
                            PASS_TYPES_READY (gates [22,24,26], no canary)
        1 ATTENTION        - NO_DISPATCH_RUN (fire the dispatch - exact curl
                            printed), or FAIL_*, or completed run(s) with no
                            posted verdict
        2 NOT_YET          - no scheduled oct28-verify run yet (or still in
                            progress): armed, but promotion day has not
                            produced a verdict; re-run after 08:00 UTC Oct 28

Reminder: NO_DISPATCH_RUN is exit 0 BY DESIGN in the verifier - firing the
promotion dispatch is a deliberate operator act, not a failure. This check
still routes it to ATTENTION because it needs exactly that act.
#>
$ErrorActionPreference = 'Stop'
if (-not $env:VERIFY_TOKEN) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredManOct28 {
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
  $env:VERIFY_TOKEN = [CredManOct28]::Read('gh:github.com:Creative-hub554')
}
if (-not $env:VERIFY_TOKEN) { Write-Output 'NO_TOKEN'; exit 1 }
$h = @{ Authorization = "Bearer $($env:VERIFY_TOKEN)"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
$base = 'https://api.github.com/repos/Creative-hub554/Base88Plus'
$today = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')

# 1. Scheduled oct28-verify runs on promotion day (smoke dispatches never post - excluded)
try {
  $runs = Invoke-RestMethod -Uri "$base/actions/workflows/oct28-verify.yml/runs?event=schedule&created=2026-10-28..2026-10-29&per_page=20" -Headers $h
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code -eq 404) {
    Write-Output 'OCT28_CHECK ATTENTION: oct28-verify.yml has no runs endpoint (404) - the workflow is not on the default branch yet (merge pending?) or was renamed/deleted.'
    exit 1
  }
  Write-Output "OCT28_CHECK ATTENTION: workflow-runs query failed (HTTP $code): $($_.Exception.Message)"
  exit 1
}
$day = @($runs.workflow_runs)
if ($day.Count -eq 0) {
  Write-Output "OCT28_CHECK NOT_YET (today=$today): no scheduled oct28-verify run yet - the automation is armed and fires 2026-10-28 07:23/09:33/13:33/19:33 UTC. Re-run after 08:00 UTC Oct 28."
  exit 2
}
$inProgress = @($day | Where-Object { $_.status -ne 'completed' })
if ($inProgress.Count -gt 0) {
  Write-Output "OCT28_CHECK NOT_YET: $($inProgress.Count) scheduled attempt(s) still running:"
  $inProgress | ForEach-Object { Write-Output ("  run " + $_.id + " started " + $_.created_at + " - " + $_.html_url) }
  Write-Output 'Re-run this script in ~30 min.'
  exit 2
}

# 2. The verdict from #18 (the verifier's durable record, idempotent per run id)
$comments = Invoke-RestMethod -Uri "$base/issues/18/comments?since=2026-10-28T00:00:00Z&per_page=50" -Headers $h
$verdictComments = @($comments) | Where-Object { $_.body -like '*post-Oct-28 verifier*' }
Write-Output "scheduled attempts on promotion day: $($day.Count) (all completed)"
$day | ForEach-Object { Write-Output ("  run " + $_.id + " -> " + $_.conclusion + " - " + $_.html_url) }
Write-Output "#18 verifier comments since Oct 28: $($verdictComments.Count)"

if ($verdictComments.Count -eq 0) {
  Write-Output 'OCT28_CHECK ATTENTION: run(s) completed but NO verdict was posted on #18. Pull the oct28-verify-log artifacts from the runs above (COMMENT_FAILED or an early exit).'
  exit 1
}

$latest = $verdictComments | Sort-Object created_at -Descending | Select-Object -First 1
$verdict = $null
if ($latest.body -match '\*\*(PASS_[A-Z_]+)\*\*') { $verdict = $Matches[1] }
elseif ($latest.body -match '\*\*(NO_DISPATCH_RUN)\*\*') { $verdict = $Matches[1] }
elseif ($latest.body -match '\*\*((FAIL|PRE_PROMO)_[A-Z_]+)\*\*') { $verdict = $Matches[1] }
Write-Output "── latest verdict comment ($($latest.created_at), $($latest.user.login)):"
$latest.body -split "`n" | Where-Object { $_ -match 'verifier|Dispatch run|Check-runs|Snapshot on main|Push status|@types|Next:|\*\*' } | ForEach-Object { Write-Output ("  " + $_.Trim()) }

if ($verdict -eq 'PASS_PROMOTED' -or $verdict -eq 'PASS_TYPES_READY') {
  Write-Output "OCT28_CHECK CONFIRMED_PASS verdict=$verdict - Node 26 is a required gate (or the @types PR is ready). Track/close #18 per the Next: block (CLOSE=1 is an operator act)."
  exit 0
}
if ($verdict -eq 'NO_DISPATCH_RUN') {
  Write-Output 'OCT28_CHECK ATTENTION verdict=NO_DISPATCH_RUN - promotion needs a CI event to re-classify the matrix. Fire the dispatch, wait for it to finish, re-run the 09:33+ verifier attempt or this check:'
  Write-Output '  curl -s -o /dev/null -w "%{http_code}\n" -X POST \'
  Write-Output '    -H "Authorization: Bearer <TOKEN>" -H "Accept: application/vnd.github+json" \'
  Write-Output '    -d ''{"ref":"refs/heads/main"}'' \'
  Write-Output '    https://api.github.com/repos/Creative-hub554/Base88Plus/actions/workflows/ci.yml/dispatches   # expect 204'
  exit 1
}
if (-not $verdict) { $verdict = 'UNPARSEABLE' }
Write-Output "OCT28_CHECK ATTENTION verdict=$verdict - follow the Next: block in the comment above and the oct28-verify-log artifact."
exit 1
