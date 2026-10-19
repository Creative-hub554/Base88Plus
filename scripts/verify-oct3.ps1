<#
post-Oct-3 verifier: checks the monthly scheduled CI run, the snapshot
commit, and records the outcome on issue #18.

Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File .freebuff/verify-oct3.ps1
Env:    VERIFY_TOKEN=<tok>  token override (CI drill / non-Windows); default is the
                        Windows Credential Manager entry gh:github.com:Creative-hub554
        VERIFY_GNOMON=yyyy-MM-dd  fake today (deterministic rehearsal: the gate,
                        and the day the record is dated)
        VERIFY_FORCE=1  bypass the date gate (plumbing tests only)
        DRY_RUN=1       print the #18 comment instead of posting it
Exit:   0 pass/in-progress, 1 attention/fail, 2 date gate refused
#>
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredMan {
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
# Token source: VERIFY_TOKEN env (CI drill / non-Windows) or Windows Credential Manager.
$tok = if ($env:VERIFY_TOKEN) { $env:VERIFY_TOKEN } else { [CredMan]::Read('gh:github.com:Creative-hub554') }
if (-not $tok) { Write-Output 'NO_TOKEN'; exit 1 }
$h = @{ Authorization = "Bearer $tok"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
# --- 0. the contract (scripts/verdict-contract.json) ---
# The marker this script writes, the window it scans, the header that identifies
# one of its records and the day it records on are all declared once, for the
# recovery pass and the heartbeat auditor to read too. Restating any of them here
# is what let this script search for a string it never wrote.
. (Join-Path $PSScriptRoot 'verdict-contract.ps1')
$contract = Get-VerdictContract
$record = Get-VerdictRecord -Contract $contract -ScriptPath $PSCommandPath
$base = "https://api.github.com/repos/$($contract.repo)"
$issue = $contract.issue
$windowEnd = ([datetime]$record.recordsOn).AddDays(1).ToString('yyyy-MM-dd')

# --- 1. date gate ---
# VERIFY_GNOMON=yyyy-MM-dd fakes today - the same seam the two sentinels and the
# Oct 28 verifier already have. A rehearsal that is modelling a cron day has to be
# able to say which day that is, or the script derives a record dated the day the
# rehearsal ran and the timeline under test is some other timeline.
$today = if ($env:VERIFY_GNOMON) { $env:VERIFY_GNOMON } else { (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd') }
# A faked calendar must not be able to file a record on GitHub; the transport, not
# the date, decides whether it can (see Test-VerdictSimulatedTransport).
if ($env:VERIFY_FORCE -eq '1' -or $env:VERIFY_GNOMON) {
  if (Test-VerdictSimulatedTransport) {
    Write-Output 'SIMULATED_WORLD (faked date + rehearsal transport - a record filed here lands in the simulated world, never on GitHub)'
  } else {
    $env:DRY_RUN = '1'
    Write-Output 'FORCED_DRY_RUN (VERIFY_FORCE/VERIFY_GNOMON set - rehearsals never post)'
  }
}
if ($today -lt $record.recordsOn -and $env:VERIFY_FORCE -ne '1') {
  Write-Output "REFUSED_DATE_GATE today=$today cron fires $($record.recordsOn)T07:17Z (VERIFY_FORCE=1 or VERIFY_GNOMON=... overrides for plumbing tests)"; exit 2
}

# --- 2. scheduled run (SMOKE_RUN_ID=<id> inspects a specific run; always dry) ---
$smoke = $env:SMOKE_RUN_ID
$run = $null
if ($smoke) {
  $run = Invoke-RestMethod -Uri "$base/actions/runs/$smoke" -Headers $h
  Write-Output "SMOKE inspecting run $($run.id) event=$($run.event) created=$($run.created_at) url=$($run.html_url)"
} else {
  $runs = Invoke-RestMethod -Uri "$base/actions/workflows/ci.yml/runs?event=schedule&created=$($record.recordsOn)..$windowEnd&per_page=10" -Headers $h
  $run = $runs.workflow_runs | Sort-Object created_at -Descending | Select-Object -First 1
}
if (-not $run) {
  $wf = Invoke-RestMethod -Uri "$base/actions/workflows/ci.yml" -Headers $h
  $verdict = 'CRON_NOT_FOUND'
  $comment = "$(Format-VerdictHeader -Record $record -Day $today): NO scheduled CI run found in the $($record.recordsOn)..$windowEnd window. ci.yml workflow state: $($wf.state). If 'disabled_manually' or 'disabled_inactivity', re-enable via Settings - Actions or a repo activity push, then investigate why it was disabled."
  Write-Output "$($contract.logSyntax.verdict)$verdict"
} elseif ($run.status -ne 'completed') {
  Write-Output "RUN_IN_PROGRESS url=$($run.html_url) - re-run this script later"; exit 0
} else {
  Write-Output "RUN id=$($run.id) conclusion=$($run.conclusion) url=$($run.html_url)"
  # --- 3. snapshot commit on cron day ---
  $commits = Invoke-RestMethod -Uri "$base/commits?path=scripts/node-schedule.json&since=$($record.recordsOn)T07:00:00Z&until=$($record.recordsOn)T23:59:59Z&per_page=10" -Headers $h
  $commit = @($commits) | Select-Object -First 1
  # --- 4. matrix job step conclusions ---
  $jobs = Invoke-RestMethod -Uri "$base/actions/runs/$($run.id)/jobs?per_page=100" -Headers $h
  $mj = @($jobs.jobs) | Where-Object { $_.name -eq 'matrix' } | Select-Object -First 1
  $refresh = @($mj.steps) | Where-Object { $_.name -like 'Refresh the committed schedule snapshot*' } | Select-Object -First 1
  $commitStep = @($mj.steps) | Where-Object { $_.name -like 'Commit the refreshed snapshot*' } | Select-Object -First 1
  # --- 5. snapshot state + live upstream compare (only when no commit) ---
  $sn = Invoke-RestMethod -Uri "$base/contents/scripts/node-schedule.json?ref=main" -Headers $h
  $wrapper = ConvertFrom-VerdictJson ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($sn.content)))
  $age = [int](((Get-Date).ToUniversalTime() - [datetime]$wrapper._fetchedAt).TotalDays)
  $liveNote = 'not compared (commit found)'
  if (-not $commit) {
    try {
      $liveResp = Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json' -UseBasicParsing
      $live = ConvertFrom-VerdictJson $liveResp.Content
      function Sig($s) { $rows = @(); foreach ($p in $s.PSObject.Properties) { if ($p.Name -notmatch '^v\d+$') { continue }; $e = $p.Value; $rows += ($p.Name + ':' + $e.start + ':' + $e.lts + ':' + $e.maintenance + ':' + $e.end) }; return (($rows | Sort-Object) -join '|') }
      # upstream schedule.json is FLAT - no .schedule wrapper
      if ((Sig $live) -eq (Sig $wrapper.schedule)) { $liveNote = 'live upstream REACHED and IDENTICAL to committed snapshot' } else { $liveNote = 'live upstream REACHED and DIFFERS from committed snapshot' }
    } catch { $liveNote = "live upstream UNREACHABLE ($($_.Exception.Message))" }
  }
  # --- 5b. API-visible push-status marker (artifact NAME encodes the verdict) ---
  $pushVerdict = 'UNKNOWN'
  try {
    $arts = Invoke-RestMethod -Uri "$base/actions/runs/$($run.id)/artifacts?per_page=100" -Headers $h
    $pa = @($arts.artifacts) | Where-Object { $_.name -like 'snapshot-push-*' } | Select-Object -First 1
    if ($pa) { $pushVerdict = $pa.name.Substring('snapshot-push-'.Length) }
  } catch { Write-Output "ARTIFACT_QUERY_FAILED $($_.Exception.Message)" }
  Write-Output "PUSH_MARKER $pushVerdict"

  # --- 6. verdict tree ---
  if ($run.conclusion -ne 'success') {
    $verdict = 'FAIL_RUN_RED'
    $next = 'Pull the matrix/gates logs (grep "TOO STALE" = outage + stale snapshot; recovery is a workflow re-run after upstream recovers, never a bypass change).'
  } elseif ($commit) {
    $verdict = 'PASS_REFRESHED'
    $next = 'Nothing to do. Deploy-key bypass worked as designed.'
  } elseif ($refresh -and $refresh.conclusion -eq 'failure') {
    $verdict = 'PASS_WITH_CAVEAT_UPSTREAM_OUTAGE'
    $next = 'The refresh step failed (upstream outage at run time). Re-run the workflow once nodejs.org recovers so the snapshot freshens; live compare now: ' + $liveNote + '.'
  } elseif ($commitStep -and $commitStep.conclusion -eq 'failure') {
    $verdict = 'ATTENTION_PUSH_STEP_FAILED'
    $next = 'Refresh succeeded but the commit/push step failed. Push-status artifact: snapshot-push-' + $pushVerdict + ' (failed = dead push confirmed via API; UNKNOWN = pre-tripwire run, check the commit step annotations for exit 128). If live differs from the snapshot, suspect the deploy key / DEPLOY_KEY_PEM secret / ruleset bypass actor; verify all three, then re-run the workflow. Live compare now: ' + $liveNote + '.'
  } elseif ($liveNote -like '*IDENTICAL*') {
    $verdict = 'PASS_UNCHANGED'
    $next = 'Run green, no commit, live upstream identical. Confirm the no-op was graceful: open the matrix job and check the Commit the refreshed snapshot step annotations. An annotation [failure] Process completed with exit code 128 means the push DIED (host-key or auth), not a no-op - re-fire the workflow after fixing, do not accept the green run.'
  } else {
    $verdict = 'ATTENTION_COMMIT_MISSING'
    $next = 'Run green, steps succeeded, no commit, but live upstream differs now. First rule out a dead push: check the Commit step annotations for exit code 128 (host-key/auth failure looks identical to a no-op from the API - rehearsed 2026-09-26, run 36251046188). If annotations are clean, upstream may have changed after the run; re-check tomorrow and re-run the workflow if it persists.'
  }
  # marker overrides: the artifact is authoritative evidence about the push
  if ($verdict -eq 'PASS_UNCHANGED' -and $pushVerdict -eq 'failed') {
    $verdict = 'ATTENTION_PUSH_STEP_FAILED'
    $next = 'Steps reported success but the snapshot-push-failed artifact proves the push died; verify deploy key / DEPLOY_KEY_PEM / ruleset bypass, then re-run the workflow. Live compare now: ' + $liveNote + '.'
  }
  if ($verdict -eq 'PASS_UNCHANGED' -and $pushVerdict -eq 'ok') {
    $verdict = 'PASS_REFRESHED'
    $next = 'The snapshot-push-ok artifact attests the push landed even though the path-scoped commits query found nothing in the cron-day window (query edge or race). Treat as refreshed; spot-check the bot commit on main if you want belt and braces.'
  }
  if ($verdict -eq 'ATTENTION_COMMIT_MISSING' -and $pushVerdict -eq 'ok') {
    $next = 'The snapshot-push-ok artifact RULES OUT a dead push - the push succeeded in this run, so the commit exists on main (possibly outside the query window) and the live upstream changed some other way. List bot commits directly (commits?path=scripts/node-schedule.json with a wide window) before assuming drift.'
  }
  if ($smoke) { $verdict = "SMOKE_$verdict" }
  $author = if ($commit) { if ($commit.author) { $commit.author.login } else { $commit.commit.author.email } } else { 'n/a' }
  $commitLine = if ($commit) { "$($commit.sha.Substring(0,8)) by $author - $($commit.commit.message)" } else { 'NONE FOUND' }
  Write-Output "COMMIT $commitLine"
  Write-Output "STEPS refresh=$($refresh.conclusion) commit=$($commitStep.conclusion)"
  Write-Output "SNAPSHOT _fetchedAt=$($wrapper._fetchedAt) age=${age}d"
  Write-Output "LIVE $liveNote"
  $comment = "$(Format-VerdictHeader -Record $record -Run $run.id -Day $today): **$verdict**`n`n- Scheduled run: $($run.conclusion) - $($run.html_url)`n- Snapshot commit on cron day: $commitLine`n- Steps: refresh=$($refresh.conclusion), commit=$($commitStep.conclusion)`n- Push status artifact: snapshot-push-$pushVerdict`n- Snapshot on main: _fetchedAt $($wrapper._fetchedAt) ($age days old)`n- Live upstream compare: $liveNote`n`nNext: $next"
  Write-Output "$($contract.logSyntax.verdict)$verdict"
}
if (-not $comment) { exit 0 }

# --- 7. record on #18 (idempotent by run id marker) ---
# Print the composed body ALWAYS, not only on the dry path. The uploaded
# oct3-verify-log artifact is the recovery source for scripts/recover-verdicts.mjs,
# and a log that carries the exact comment cannot be mis-transcribed the way a
# hand recovery can - the 2026-10-09 hand recovery of this very verdict read
# `age=1d` from the artifact and wrote "0 days old" into #18.
Write-Output $contract.logSyntax.body
Write-Output $comment
# The identity of THIS record, rendered from the contract's header - and the same
# string searched for in the prior comments. The two sides have to be the same
# text: this script used to search for 'verifier run <id>' while writing
# 'post-Oct-3 verifier (run <id>, <day>)', so the guard could never fire and a
# re-run posted a duplicate record for the same run.
$header = Format-VerdictHeader -Record $record -Run $(if ($run) { $run.id } else { 'none' }) -Day $today
$prior = Invoke-RestMethod -Uri "$base/issues/$issue/comments?since=$($record.readsSince)&per_page=50" -Headers $h
if (@($prior) | Where-Object { $_.body -like "*$header*" }) { Write-Output "ALREADY_RECORDED ($header)"; exit 0 }
if ($env:DRY_RUN -eq '1' -or $smoke) { Write-Output '--- DRY RUN: comment body below (not posted) ---'; Write-Output $comment; exit 0 }
$cb = @{ body = $comment } | ConvertTo-Json
try {
  $r = Invoke-RestMethod -Uri "$base/issues/$issue/comments" -Method Post -Headers $h -ContentType 'application/json' -Body $cb
  Write-Output ("COMMENT_POSTED id=" + $r.id)
} catch {
  Write-Output ($contract.logSyntax.commentFailed + $_.Exception.Message)
  if ($_.ErrorDetails) { Write-Output $_.ErrorDetails.Message }
  if ($comment -match '[^\x00-\x7F]') { Write-Output 'HINT non-ASCII characters detected in body' }
}
if ($verdict -like 'PASS*') { exit 0 } else { exit 1 }
