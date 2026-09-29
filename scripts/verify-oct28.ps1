<#
post-Oct-28 promotion-day verifier: proves Node 26's canary->gate promotion
on a real CI run (gates [22,24,26], NO canary, ci-ok green), tracks the
@types/node 26 Dependabot PR, and records + closes issue #18.

Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File .freebuff/verify-oct28.ps1
Env:    VERIFY_TOKEN=<tok>  token override (CI drill / non-Windows); default is the
                        Windows Credential Manager entry gh:github.com:Creative-hub554
        VERIFY_FORCE=1           bypass the date gate (plumbing tests only)
        VERIFY_GNOMON=yyyy-MM-dd fake today (deterministic rehearsal of date gates)
        DRY_RUN=1                print the #18 comment instead of posting/closing
        CLOSE=1                  ALLOW closing #18 (real run + comment posted + PASS)
        SMOKE_RUN_ID=<id>        inspect a specific pre-Oct-28 dispatch run instead of
                                 today's (plumbing only; verdict prefixed SMOKE_; always dry)
        VERIFY_EXPECT_CANARY=1   accept a canary check on the inspected run (pre-promo smoke)
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
$base = 'https://api.github.com/repos/Creative-hub554/Base88Plus'

# --- 1. date gate: promotion day is 2026-10-28 ---
# VERIFY_GNOMON=yyyy-MM-dd fakes today for deterministic rehearsal of the
# date-dependent branches (date gate, provenance alarm) without waiting.
$today = if ($env:VERIFY_GNOMON) { $env:VERIFY_GNOMON } else { (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd') }
if ($today -lt '2026-10-28' -and $env:VERIFY_FORCE -ne '1') {
  Write-Output "REFUSED_DATE_GATE today=$today promotion day is 2026-10-28 (VERIFY_FORCE=1 overrides for plumbing tests)"; exit 2
}

# --- 2. find the promotion-day dispatch run ---
$smoke = $env:SMOKE_RUN_ID
$comment = $null
$verdict = $null
if ($smoke) {
  # plumbing mode: inspect one known pre-promotion run; verdicts prefixed SMOKE_, always dry
  $run = Invoke-RestMethod -Uri "$base/actions/runs/$smoke" -Headers $h
  Write-Output "SMOKE inspecting run $($run.id) event=$($run.event) created=$($run.created_at) url=$($run.html_url)"
} else {
  $runs = Invoke-RestMethod -Uri "$base/actions/workflows/ci.yml/runs?event=workflow_dispatch&created=$today..$today&per_page=20" -Headers $h
  $run = $runs.workflow_runs | Where-Object { $_.conclusion -ne 'cancelled' } | Sort-Object created_at -Descending | Select-Object -First 1
  if (-not $run -and @($runs.workflow_runs).Count -gt 0) { $run = $runs.workflow_runs | Sort-Object created_at -Descending | Select-Object -First 1 } # all cancelled: report the newest anyway
  if (-not $run) {
    $verdict = 'NO_DISPATCH_RUN'
    $comment = "post-Oct-28 verifier ($today): **NO_DISPATCH_RUN**`n`nNo workflow_dispatch CI run exists on $today. Node 26 promoted to LTS today; the gates matrix only re-classifies on the next CI event. Fire one:`n`nPOST /repos/Creative-hub554/Base88Plus/actions/workflows/ci.yml/dispatches with body {`"ref`":`"main`"} (expect 204), then re-run this verifier.`n`n(NO_DISPATCH_RUN is exit 0 - firing the dispatch is a deliberate operator act, not a failure.)"
    Write-Output "VERDICT=$verdict"
  }
}
if ($run) {
  if ($run.status -ne 'completed') {
    Write-Output "RUN_IN_PROGRESS id=$($run.id) url=$($run.html_url) - re-run this script later"; exit 0
  }
  Write-Output "RUN id=$($run.id) event=$($run.event) conclusion=$($run.conclusion) url=$($run.html_url)"

  # --- 3. run-scoped job conclusions via the Jobs API ---
  # (NOT /commits/{sha}/check-runs: after a concurrency cancel one sha can
  # carry check-runs from TWO runs and per-name dedup poisons the verdict.)
  $jobs = Invoke-RestMethod -Uri "$base/actions/runs/$($run.id)/jobs?per_page=100" -Headers $h
  $gateNames = @('gates (22)','gates (24)','gates (26)')
  $gateState = @{}
  foreach ($g in $gateNames) {
    $j = @($jobs.jobs) | Where-Object { $_.name -eq $g } | Select-Object -First 1
    $gateState[$g] = if ($j) { $j.conclusion } else { 'ABSENT' }
  }
  $ciokJob = @($jobs.jobs) | Where-Object { $_.name -eq 'ci-ok' } | Select-Object -First 1
  $ciokState = if ($ciokJob) { $ciokJob.conclusion } else { 'ABSENT' }
  $canaryJob = @($jobs.jobs) | Where-Object { $_.name -like 'canary*' } | Select-Object -First 1
  $canaryState = if ($canaryJob) { $canaryJob.conclusion } else { 'ABSENT' }
  foreach ($g in $gateNames) { Write-Output "CHECK $g = $($gateState[$g])" }
  Write-Output "CHECK ci-ok = $ciokState"
  Write-Output "CHECK canary = $canaryState"
  $checkLine = "gates (22)=$($gateState['gates (22)']), gates (24)=$($gateState['gates (24)']), gates (26)=$($gateState['gates (26)']), ci-ok=$ciokState, canary=$canaryState"
  # --- 4. snapshot age + Oct 3 cron provenance note ---
  $sn = Invoke-RestMethod -Uri "$base/contents/scripts/node-schedule.json?ref=main" -Headers $h
  $wrapper = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($sn.content)) | ConvertFrom-Json
  $age = [int](((Get-Date).ToUniversalTime() - [datetime]$wrapper._fetchedAt).TotalDays)
  $cronNote = 'OK (refreshed by the Oct 3 cron push)'
  # Cast the LEFT side: ConvertFrom-Json yields _fetchedAt as a String, and a
  # string -lt [datetime] coerces the datetime to a string, so '2026-09-xx'
  # compares GREATER than '2026-10-03' lexicographically ('9' > '1') and the
  # STALE PROVENANCE alarm could never fire. Rehearsed 2026-09-29.
  # Date-guarded: BEFORE Oct 3 the snapshot legitimately predates the cron,
  # so the alarm applies only on/after cron day ($today is ISO, string-safe).
  if ($today -ge '2026-10-03' -and [datetime]$wrapper._fetchedAt -lt [datetime]'2026-10-03') {
    $cronNote = 'STALE PROVENANCE - snapshot predates the Oct 3 cron; the Oct 3 refresh never landed (see the post-Oct-3 verifier / runbook step 3)'
  } elseif ($age -gt 25) {
    $cronNote = "WARNING - snapshot is $age days old (expected a refresh within ~a month of Oct 28)"
  }
  Write-Output "SNAPSHOT _fetchedAt=$($wrapper._fetchedAt) age=${age}d ($cronNote)"

  # --- 4b. API-visible push-status marker (artifact NAME encodes the verdict) ---
  $pushVerdict = 'UNKNOWN'
  try {
    $arts = Invoke-RestMethod -Uri "$base/actions/runs/$($run.id)/artifacts?per_page=100" -Headers $h
    $pa = @($arts.artifacts) | Where-Object { $_.name -like 'snapshot-push-*' } | Select-Object -First 1
    if ($pa) { $pushVerdict = $pa.name.Substring('snapshot-push-'.Length) }
  } catch { Write-Output "ARTIFACT_QUERY_FAILED $($_.Exception.Message)" }
  Write-Output "PUSH_MARKER $pushVerdict"

  # --- 5. @types/node 26 PR detection (re-opens AFTER promotion; #6 stays closed) ---
  $prLine = 'not open yet - arrives on Dependabot''s next sweep (days; do not force)'
  $prs = Invoke-RestMethod -Uri "$base/pulls?state=open&per_page=50" -Headers $h
  $typesPr = @($prs) | Where-Object { $_.head.ref -like 'dependabot/npm_and_yarn/types/node-26*' } | Select-Object -First 1
  $typesVerdict = 'PENDING'
  if ($typesPr) {
    Write-Output "TYPES_PR id=$($typesPr.number) head=$($typesPr.head.ref) url=$($typesPr.html_url)"
    # run-scoped: latest ci.yml run on the PR head sha (sha check-runs can mix runs)
    $tpRuns = Invoke-RestMethod -Uri "$base/actions/workflows/ci.yml/runs?head_sha=$($typesPr.head.sha)&per_page=10" -Headers $h
    $tpRun = $tpRuns.workflow_runs | Sort-Object created_at -Descending | Select-Object -First 1
    $tpState = 'ABSENT'
    if ($tpRun) {
      Write-Output "TYPES_PR run id=$($tpRun.id) conclusion=$($tpRun.conclusion)"
      $tpJobs = Invoke-RestMethod -Uri "$base/actions/runs/$($tpRun.id)/jobs?per_page=100" -Headers $h
      $tpCiok = @($tpJobs.jobs) | Where-Object { $_.name -eq 'ci-ok' } | Select-Object -First 1
      $tpState = if ($tpCiok) { $tpCiok.conclusion } else { 'ABSENT' }
    }
    Write-Output "TYPES_PR ci-ok=$tpState"
    $prLine = "open as PR #$($typesPr.number), head ci-ok=$tpState - $($typesPr.html_url)"
    if ($tpState -eq 'success') {
      $typesVerdict = 'READY_TO_MERGE (merge ONLY with explicit operator confirm; squash via PUT /pulls/' + "$($typesPr.number)/merge)"
    } elseif ($tpState -eq 'failure') {
      $typesVerdict = 'CI_RED (inspect before touching - after promotion the head run computes 3 legs, so red means a real break)'
    } else {
      $typesVerdict = "INCOMPLETE (ci-ok=$tpState)"
    }
  }
  Write-Output "TYPES $typesVerdict"

  # --- 6. verdict tree ---
  $expectCanary = ($env:VERIFY_EXPECT_CANARY -eq '1')
  if ($run.conclusion -ne 'success') {
    $verdict = 'FAIL_RUN_RED'
    $next = 'Pull the matrix/gates logs. Grep "TOO STALE" = nodejs.org outage + snapshot predating v26.lts - recovery is a workflow re-run after upstream recovers, never a bypass change. Push-status artifact: snapshot-push-' + $pushVerdict + '.'
  } elseif ($gateState['gates (26)'] -ne 'success' -or $canaryState -ne 'ABSENT') {
    $verdict = 'FAIL_NOT_PROMOTED'
    $next = "Gates did not absorb node 26 (canary=$canaryState). Check run.head_sha is the Oct 28 main tip; then run NOW=2026-10-28 node scripts/ci-compute-matrix.js locally - if it does not print [22,24,26] with no canary, the classification itself drifted. Push-status artifact: snapshot-push-$pushVerdict (failed = a push died in this run)."
  } elseif ($ciokState -ne 'success') {
    $verdict = 'FAIL_CI_OK_RED'
    $next = 'Gates legs passed individually but ci-ok is not green - check whether an unrelated matrix child polluted the gates result.'
  } else {
    $verdict = 'PASS_PROMOTED'
    $next = 'Node 26 is a required gate. Track the @types/node 26 PR when Dependabot opens it, then close #18 (run with CLOSE=1).'
  }
  if ($verdict -like 'PASS*' -and $typesVerdict -eq 'READY_TO_MERGE') { $verdict = 'PASS_TYPES_READY' }
  if ($verdict -eq 'FAIL_NOT_PROMOTED' -and $expectCanary) { $verdict = 'PRE_PROMO_AS_EXPECTED' }
  if ($smoke) { $verdict = "SMOKE_$verdict" }
  Write-Output "VERDICT=$verdict"
  $comment = "post-Oct-28 verifier (run $($run.id), $today): **$verdict**`n`n- Dispatch run: $($run.conclusion) - $($run.html_url)`n- Check-runs: $checkLine`n- Snapshot on main: _fetchedAt $($wrapper._fetchedAt) ($age days old)`n- Push status artifact: snapshot-push-$pushVerdict`n- @types/node 26 PR: $prLine`n`nNext: $next"
}

if (-not $comment) { exit 0 }

# --- 7. record on #18 (idempotent per run id) ---
$marker = if ($run) { "verifier run $($run.id)" } else { "verifier no-run $today" }
$prior = Invoke-RestMethod -Uri "$base/issues/18/comments?since=2026-10-28T00:00:00Z&per_page=50" -Headers $h
if (@($prior) | Where-Object { $_.body -like "*$marker*" }) { Write-Output "ALREADY_RECORDED ($marker)"; exit 0 }
if ($env:DRY_RUN -eq '1' -or $smoke) {
  Write-Output '--- DRY RUN: comment body below (not posted, #18 not closed) ---'
  Write-Output $comment
  if ($verdict -like '*PASS*' -or $verdict -eq 'NO_DISPATCH_RUN' -or $verdict -like '*PRE_PROMO_AS_EXPECTED') { exit 0 } else { exit 1 }
}

# --- 8. post the promotion record ---
$cb = @{ body = $comment } | ConvertTo-Json
try {
  $r = Invoke-RestMethod -Uri "$base/issues/18/comments" -Method Post -Headers $h -ContentType 'application/json' -Body $cb
  Write-Output ("COMMENT_POSTED id=" + $r.id)
} catch {
  Write-Output ("COMMENT_FAILED " + $_.Exception.Message)
  if ($_.ErrorDetails) { Write-Output $_.ErrorDetails.Message }
  if ($comment -match '[^\x00-\x7F]') { Write-Output 'HINT non-ASCII characters detected in body' }
  exit 1
}

# --- 9. close #18 only on an explicit, passing, real run ---
if ($env:CLOSE -eq '1' -and $verdict -like 'PASS*') {
  try {
    Invoke-RestMethod -Uri "$base/issues/18" -Method Patch -Headers $h -ContentType 'application/json' -Body '{"state":"closed","state_reason":"completed"}'
    Write-Output 'ISSUE18_CLOSED (state=completed)'
  } catch {
    Write-Output ("CLOSE_FAILED " + $_.Exception.Message)
    if ($_.ErrorDetails) { Write-Output $_.ErrorDetails.Message }
    exit 1
  }
} elseif ($verdict -like 'PASS*') {
  Write-Output 'ISSUE18_LEFT_OPEN (PASS but CLOSE=1 not set - record posted, closure withheld)'
}
if ($verdict -like 'PASS*' -or $verdict -eq 'NO_DISPATCH_RUN') { exit 0 } else { exit 1 }
