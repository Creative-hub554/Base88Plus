<#
oct3-check: one-shot cron-day status check for the Oct 3 snapshot refresh.

Answers the only question that matters on the day: did the scheduled
oct3-verify run complete and post a PASS verdict on issue #18?

Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/oct3-check.ps1
Env:    VERIFY_TOKEN=<tok>  token override; default is the Windows CredMan
        entry gh:github.com:Creative-hub554
Exit:   0 CONFIRMED_PASS   - a scheduled (event=schedule) oct3-verify run
                            completed on Oct 3 AND its PASS verdict is on #18
        1 ATTENTION        - a scheduled run completed with failure, or no
                            PASS verdict was posted, or the verdict is
                            ATTENTION_*/FAIL_*
        2 NOT_YET          - no scheduled run yet (or still in progress):
                            the automation is armed but cron day has not
                            produced a verdict; re-run after 08:00 UTC Oct 3
#>
$ErrorActionPreference = 'Stop'
if (-not $env:VERIFY_TOKEN) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredManOct3 {
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
  $env:VERIFY_TOKEN = [CredManOct3]::Read('gh:github.com:Creative-hub554')
}
if (-not $env:VERIFY_TOKEN) { Write-Output 'NO_TOKEN'; exit 1 }
$h = @{ Authorization = "Bearer $($env:VERIFY_TOKEN)"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
$base = 'https://api.github.com/repos/Creative-hub554/Base88Plus'
$today = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')

# 1. Scheduled oct3-verify runs on cron day (workflow_dispatch smoke runs never post - excluded by design)
$runs = Invoke-RestMethod -Uri "$base/actions/workflows/oct3-verify.yml/runs?event=schedule&created=2026-10-03..2026-10-04&per_page=20" -Headers $h
$day = @($runs.workflow_runs)
if ($day.Count -eq 0) {
  Write-Output "OCT3_CHECK NOT_YET (today=$today): no scheduled oct3-verify run yet - the automation is armed (workflow active) and fires 2026-10-03 07:47/09:07/19:17 UTC. Re-run after 08:00 UTC Oct 3."
  exit 2
}
$inProgress = @($day | Where-Object { $_.status -ne 'completed' })
if ($inProgress.Count -gt 0) {
  Write-Output "OCT3_CHECK NOT_YET: $($inProgress.Count) scheduled attempt(s) still running:"
  $inProgress | ForEach-Object { Write-Output ("  run " + $_.id + " started " + $_.created_at + " - " + $_.html_url) }
  Write-Output 'The verifier exits 0 on RUN_IN_PROGRESS so the next cron attempt re-checks; re-run this script in ~30 min.'
  exit 2
}

# 2. Verdict from #18 (the verifier's own durable record; idempotent by run id)
$comments = Invoke-RestMethod -Uri "$base/issues/18/comments?since=2026-10-03T00:00:00Z&per_page=50" -Headers $h
$verdictComments = @($comments) | Where-Object { $_.body -like '*post-Oct-3 verifier*' }
Write-Output "scheduled attempts on cron day: $($day.Count) (all completed)"
$day | ForEach-Object { Write-Output ("  run " + $_.id + " -> " + $_.conclusion + " - " + $_.html_url) }
Write-Output "#18 verifier comments since Oct 3: $($verdictComments.Count)"

if ($verdictComments.Count -eq 0) {
  Write-Output 'OCT3_CHECK ATTENTION: run(s) completed but NO verdict was posted on #18. The real-mode verifier always posts a verdict when it completes its checks - suspect it ran in a state that skipped posting (e.g. only RUN_IN_PROGRESS exits) or the comment call failed (COMMENT_FAILED in the run log). Pull oct3-verify-log artifacts from the runs above.'
  exit 1
}

# 3. Classify the LATEST verdict comment
$latest = $verdictComments | Sort-Object created_at -Descending | Select-Object -First 1
$verdict = $null
if ($latest.body -match '\*\*(PASS_[A-Z_]+)\*\*') { $verdict = $Matches[1] }
elseif ($latest.body -match '\*\*((ATTENTION|FAIL)_[A-Z_]+)\*\*') { $verdict = $Matches[1] }
elseif ($latest.body -match '\*\*(CRON_NOT_FOUND)\*\*') { $verdict = $Matches[1] }
Write-Output "── latest verdict comment ($($latest.created_at), $($latest.user.login)):"
$latest.body -split "`n" | Where-Object { $_ -match 'verifier|Scheduled run|Snapshot commit|Push status|Snapshot on main|Live upstream|\*\*' } | ForEach-Object { Write-Output ("  " + $_.Trim()) }

if ($verdict -eq 'PASS_REFRESHED' -or $verdict -eq 'PASS_UNCHANGED') {
  Write-Output "OCT3_CHECK CONFIRMED_PASS verdict=$verdict - the cron push landed (or was a verified no-op) and the snapshot is fresh. Nothing to do."
  exit 0
}
if ($verdict -eq 'PASS_WITH_CAVEAT_UPSTREAM_OUTAGE') {
  Write-Output 'OCT3_CHECK ATTENTION verdict=PASS_WITH_CAVEAT_UPSTREAM_OUTAGE - the run was green but the refresh step failed (upstream outage at run time): the snapshot did NOT freshen. Follow the Next: block (re-run the workflow once nodejs.org recovers), then re-run this check.'
  exit 1
}
if (-not $verdict) { $verdict = 'UNPARSEABLE' }
Write-Output "OCT3_CHECK ATTENTION verdict=$verdict - follow the Next: block in the comment above and the oct3-verify-log artifact."
exit 1
