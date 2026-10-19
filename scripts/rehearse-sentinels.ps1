<#
rehearse-sentinels.ps1: run both day-after sentinels against a SIMULATED promotion
day, so their trip and clear paths are exercised before the dates arrive.

Why this exists: oct4-sentinel and oct29-sentinel classify states that cannot be
produced on demand - a promotion day where no cron fired, a chain that fired and
recorded nothing, a FAIL that outranks an earlier PASS, a recovered PASS that
clears a standing trip, an issue closed before the chain ran. The Oct 29 chain
does not exist yet at all, so without a rehearsal its clear path would be first
executed on the day it matters, and its trip path would only ever be exercised
by a real gap.

What it does NOT do: reach the network, read #18, or post. Each scenario's command
runs in ONE PowerShell - `pwsh` where it exists, so the engine matches the cron
workflows and the runner, not the maintainer's box - started once for the whole run
(scripts/rehearse-sentinel-host.ps1) and asked to run that command per scenario, with
scripts/rehearse-sentinel-stub.ps1 dot-sourced in front of it, so
`Invoke-RestMethod` is the world (scripts/rehearse-world.mjs, the one interpreter
the lifecycle rehearsal and the Node tools read too); VERIFY_GNOMON makes the
sentinel force its own DRY_RUN, so the run ends at the printed body. That guard is
the reason a rehearsal cannot post - it was added after a gnomon rehearsal filed a
false SENTINEL_NO_SCHEDULED_RUN on #18 on 2026-09-30 - and this script does not
touch it.

WHY TWO LONG-LIVED CHILDREN, AND WHY THAT IS NOT A DIFFERENT REHEARSAL
The command text, the environment it reads, the marker line and the exit code are
what they always were: this harness used to hand that same text to a fresh child per
scenario, and now sends it to a host that stays up (the protocol is in
scripts/rehearse-sentinel-host.ps1). What changed is the number of interpreters - 25
process starts for 16 scenarios became one, and the ~36 s of a ~40 s run that was
PowerShell boots went with it - which is exactly why the reports are compared
byte-for-byte against the committed baseline (scripts/rehearsal-parity.mjs) rather
than trusted.

The worlds are built the same way, one step earlier, and by the same child: 24
`node ... materialize` boots (one per scenario, plus one per scenario that files a
record) became one child answering over a pipe, and that child and the transport's
router are now ONE node process - the run's world child
(scripts/rehearse-world-session.ps1), started and owned by THIS harness. That is where
the rest of the run's process starts went, because by then node boots were all that was
left of them - and the worlds it writes are compared against the ones the per-boot CLI
writes, on disk, by tests/sentinel-rehearsal.test.ts.

One thing changed with it, and it is why the host no longer passes anything on: the
child listens on a LOCAL ENDPOINT instead of answering on its own stdin. A pipe belongs
to the process that STARTED the child, and the questions come from two different
processes - this one building the worlds, and the transport inside the host asking for
routes - so with a pipe one of them had to ask the other to ask. Both connect now, and
neither holds a pipe for the other's questions.

Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rehearse-sentinels.ps1
    powershell ... -File scripts/rehearse-sentinels.ps1 -Only 'oct29'
    npm run rehearse:sentinels

Exit: 0 every scenario matched, 1 at least one did not (the sentinel's full
      output is printed for each failure).

Each scenario asserts, from the sentinel's own output and the stub's request
ledger:
  - the exit code, the verdict token (or that there is none), whether it reached
    the would-post path, and whether it recognised a record it had already filed;
  - that the printed body STARTS WITH the record identity the contract renders for
    that day (the string the recovery pass searches for and the heartbeat audits);
  - that the run list it asked for is bounded by the declaration's window, that
    the verdict scan used the WITNESS's declared `since`, and that the
    already-recorded guard searched from the sentinel's own record day - so a
    rehearsal fails if a sentinel reads a window it does not own;
  - and, for every scenario that composes a record, that the log ROUND-TRIPS.

EACH SCENARIO'S WORLD
---------------------
`scripts/sentinel-rehearsal.json` states a scenario as the changes it makes to an
otherwise empty world (some runs, some comments, an issue state); this script asks the
run's world child - the one it started, on the endpoint it published - to materialise that
into a world file (one world per scenario), and that file is what the transport answers
from. Nothing about the sentinel changed: it reads
the same run list, issue and comments it would read from GitHub, because the file
is interpreted by the one router those responses come from in every rehearsal.

THE ROUND TRIP
--------------
A sentinel's stdout IS the artifact its workflow uploads, and
scripts/recover-verdicts.mjs re-posts a record out of that artifact when the POST
failed. Two rehearsals that never meet the other half prove nothing about the
join, so every scenario that composes a record has its captured log handed to the
recovery pass's own parser and builder (scripts/rehearse-roundtrip.mjs - it imports
parseRecordLog and buildRecoveredBody, it does not reimplement them), and the
comment the pass says it would post must be the text the sentinel printed,
character for character. That comment is then put on the simulated issue - for the
scenarios that would have filed - and the scenario is run AGAIN: a record the pass
rebuilds differently, or a sentinel that does not recognise the record it is
handed back, is a lost verdict that returns as a stranger - or, worse, twice.
#>
[CmdletBinding()]
param(
  [string]$Fixture,
  [string]$Only
)

$ErrorActionPreference = 'Stop'
# Not a parameter default: $PSScriptRoot is not yet bound while parameter
# defaults are evaluated under -File.
if (-not $Fixture) { $Fixture = Join-Path $PSScriptRoot 'sentinel-rehearsal.json' }

. (Join-Path $PSScriptRoot 'verdict-contract.ps1')
# The one node child this RUN keeps, and how everything in it is asked: this process owns it
# (it is the run's driver), and every process it starts - the host, and the transport inside it
# - inherits the endpoint and asks the same child. That is what makes the run's routing and its
# 24 worlds one process instead of two roles and eighteen processes, with nobody relaying.
. (Join-Path $PSScriptRoot 'rehearse-world-session.ps1')
$contract = Get-VerdictContract
# Through the contract's own parser, like every other JSON door here: a scenario
# states its instants as strings, and an engine that coerces them would hand the
# world builder `10/29/2026 00:00:00T01:00:00Z` as a clock.
$rehearsal = ConvertFrom-VerdictJson (Get-Content -Raw -LiteralPath $Fixture)
$stubPath = Join-Path $PSScriptRoot 'rehearse-sentinel-stub.ps1'
$hostScript = Join-Path $PSScriptRoot 'rehearse-sentinel-host.ps1'
$worldScript = Join-Path $PSScriptRoot 'rehearse-world.mjs'
$fixturePath = (Resolve-Path -LiteralPath $Fixture).Path
$ledgerPath = Join-Path ([System.IO.Path]::GetTempPath()) 'sentinel-rehearsal-ledger.txt'
$worldDir = Join-Path ([System.IO.Path]::GetTempPath()) 'sentinel-rehearsal-worlds'
# --- the engine -------------------------------------------------------------
# The host this harness starts (and every child it used to start) runs under the SAME
# PowerShell, found the way scripts/rehearse-pwsh.mjs finds it: pwsh first, because that is the engine the
# cron workflows and CI use - the Linux runner that gates merges has no
# `powershell` at all (oct3-verify.yml runs verify-oct3.ps1 with `pwsh`).
# PowerShell 5.1 remains the fallback for a Windows box without PowerShell 7.
# -ExecutionPolicy is passed on Windows only: the policy exists there, and
# PowerShell on Linux rejects the parameter.
$pwshCommand = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
# Named $onWindows because $IsWindows is a READ-ONLY automatic variable in
# PowerShell 7 (assigning to it aborts the harness) and does not exist at all in
# 5.1, where its absence reads as $null. So the test is: the desktop edition, or
# an engine that says so.
$onWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or ($IsWindows -eq $true)
$pwshArgs = @('-NoProfile', '-NonInteractive')
if ($onWindows) { $pwshArgs += @('-ExecutionPolicy', 'Bypass') }
$dryMarker = '--- DRY RUN: comment body below (not posted) ---'

# --- the round trip ---------------------------------------------------------
# Where the captured log goes, and who reads it back: the recovery pass's own code,
# in Node, since that is what would run on the day a record is lost. The harness
# only orchestrates - it composes no comment and matches no record itself.
$roundTripScript = Join-Path $PSScriptRoot 'rehearse-roundtrip.mjs'
$roundTripDir = Join-Path ([System.IO.Path]::GetTempPath()) 'sentinel-rehearsal-roundtrip'

# --- the two children -------------------------------------------------------
# Two processes answer this harness for the whole run instead of being started per
# question, and what they share is below, once:
#
#   the host     the interpreter that runs a scenario's command
#                (scripts/rehearse-sentinel-host.ps1). The command text is the one the
#                harness always ran:
#
#                  . $env:REHEARSAL_STUB; & $env:REHEARSAL_SENTINEL; Write-Output ("REHEARSAL_EXIT=" + $LASTEXITCODE)
#
#                It used to be handed to a fresh interpreter per request, encoded so that
#                its quotes and its $LASTEXITCODE reference would survive an outer shell; it
#                now goes to the host, which runs it and answers with the command's own
#                output (see the protocol there, and the reason in this file's header). The
#                engine, the command, the environment, the marker line and the exit code are
#                unchanged.
#
#   the world    ONE node child for the whole run (scripts/rehearse-world-session.ps1),
#                listening on a local endpoint this harness owns. It answers both questions the
#                rehearsal asks of it - the scenarios' REST calls (through the stub in the
#                host) and the 24 worlds those scenarios run against (asked by this process
#                directly, because there is nothing to relay to) - and what it holds is the
#                fixture, one per run, while the scenario, the witness, the clock, the output
#                path and the recovered comment travel with each request. It used to be a
#                materialiser here (16 + 8 node boots) plus a router child per world over
#                there: the same file, started for one role at a time. The worlds it writes are
#                byte-for-byte the ones the per-boot CLI writes - both go through one builder in
#                that file, and tests/sentinel-rehearsal.test.ts compares the two shapes on disk
#                rather than taking that on trust.
#
# A child that died BETWEEN requests is replaced rather than reused - the same rule the stub
# applies to its own node child, and for the same reason: what the next request reads has to
# be ITS answer, and a line left over from a request that failed is the worst possible thing
# to read as one. A child that dies while a request is OUTSTANDING has no answer to read at
# all, and that fails the rehearsal instead of being papered over.
$script:ChildTimeoutMs = 120000

function Start-RehearsalChild {
  <#
  .SYNOPSIS
  Start one long-lived child with a pipe on its stdin and its stdout, and (optionally) something
  extra in its environment.

  The environment is set on the child's START INFO rather than on this process, so a value that
  decides what a child asks (this run's world endpoint) reaches that child and nothing else.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$FileName,
    [Parameter(Mandatory)][string[]]$Arguments,
    [hashtable]$Environment = @{}
  )

  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $FileName
  # Quoted where it has to be: a checkout under a path with a space would otherwise split
  # into two arguments. (The same treatment the stub gives the node child it starts, and for
  # the same reason: this is a command LINE, and .NET takes one string.)
  $info.Arguments = (@($Arguments) | ForEach-Object { if ($_ -match '\s') { '\"' + $_ + '\"' } else { $_ } }) -join ' '
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  # Every answer on both wires is base64, so the only thing an encoding can decide here is
  # what a byte means; naming it is how the two ends agree instead of agreeing by luck.
  $info.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
  foreach ($name in $Environment.Keys) { $info.EnvironmentVariables[$name] = [string]$Environment[$name] }
  # stderr is deliberately NOT redirected: a child's own errors (a node grandchild that could
  # not start, say) have to be visible, and a redirected error stream nobody reads is how a
  # child that fills its buffer while we wait on its stdout becomes a hang. They surface in
  # the rehearsal's own stderr, which the CI log keeps.

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info
  try {
    [void]$process.Start()
  } catch {
    throw "could not start $($FileName): $($_.Exception.Message)"
  }
  return $process
}

function Read-RehearsalChildLine {
  <#
  .SYNOPSIS
  One answer line from a child, or a reason it will not come.

  Bounded, so a child that stops answering is a failed scenario with a reason rather than a
  rehearsal that hangs until the job gives up on it.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]$Process,
    [Parameter(Mandatory)][string]$What
  )

  $reading = $Process.StandardOutput.ReadLineAsync()
  if (-not $reading.Wait($script:ChildTimeoutMs)) {
    throw "$What did not answer in $($script:ChildTimeoutMs)ms"
  }
  $line = $reading.Result
  if ([string]::IsNullOrEmpty($line)) {
    $exit = if ($Process.HasExited) { [string]$Process.ExitCode } else { 'still running' }
    throw "$What closed its output (exit $exit)"
  }
  return $line
}

function Stop-RehearsalChild {
  <#
  .SYNOPSIS
  End a child by closing its pipe, which is what its loop is waiting on.

  Closing the pipe IS the stop: the child's loop ends on EOF and it exits, so a rehearsal
  cannot leave a process behind. (A harder failure - an unhandled throw in this file - needs
  nothing: the pipe closes when this process does.)
  #>
  [CmdletBinding()]
  param([Parameter(Mandatory)]$Process)

  try { $Process.StandardInput.Close() } catch { }
  try {
    if (-not $Process.WaitForExit(5000)) { $Process.Kill() }
  } catch {
    try { if (-not $Process.HasExited) { $Process.Kill() } } catch { }
  }
  try { $Process.Dispose() } catch { }
}

# --- the host ---------------------------------------------------------------
$script:SentinelHost = $null

function Start-SentinelHost {
  <#
  .SYNOPSIS
  Start the one interpreter, if it is not already running.

  Started with this run's world endpoint in its environment, so the transport inside it asks
  the SAME child this process asks - one child for the run, with no relay between them. (If a
  run ever started the host before building a world, the host would find no endpoint and be the
  owner of its own child instead: a rehearsal is never left without a world to ask.)
  #>
  [CmdletBinding()]
  param()

  if ($null -ne $script:SentinelHost -and -not $script:SentinelHost.HasExited) { return }
  $environment = @{}
  if ($env:REHEARSAL_WORLD_SESSION) { $environment['REHEARSAL_WORLD_SESSION'] = $env:REHEARSAL_WORLD_SESSION }
  try {
    $script:SentinelHost = Start-RehearsalChild -FileName $pwshCommand -Arguments (@($pwshArgs) + @('-File', $hostScript)) -Environment $environment
  } catch {
    throw "REHEARSAL_HOST_UNAVAILABLE ($($_.Exception.Message))"
  }
}

function Stop-SentinelHost {
  <#
  .SYNOPSIS
  End the host, and with it this run's node world child.
  #>
  [CmdletBinding()]
  param()

  if ($null -eq $script:SentinelHost) { return }
  $process = $script:SentinelHost
  $script:SentinelHost = $null
  Stop-RehearsalChild -Process $process
}

# --- the worlds -------------------------------------------------------------
# Built by THIS harness's node child - the same one that answers the scenarios' REST calls
# through the stub (scripts/rehearse-world-session.ps1) - so this run keeps ONE node process
# where it used to keep a materialiser plus a router per world. What that child holds is the
# fixture; the scenario, the witness, the clock, the output path and the recovered comment
# travel with each request, which is what lets one process build all 24 worlds of a run that
# walks two chains (Oct 28 for its Oct 29 scenarios, Oct 3 for its Oct 4 ones).
#
# Asked on the endpoint directly, with nobody in the middle: the child is this run's (this
# process started it and published the endpoint to everything it starts), so a world is one
# question on one connection. A refusal comes back as the child phrased it
# (REHEARSAL_WORLD_REFUSED ...) and becomes a failed scenario that names the reason - never a
# dead process read as a verdict.

function New-ScenarioWorld {
  <#
  .SYNOPSIS
  Write one scenario's world file, through this run's world child, and hand back its path.

  Asked on the endpoint directly: this process owns the run's child, so there is nothing to
  relay to and nobody in the middle to report a failure second hand. The child's own refusal
  (REHEARSAL_WORLD_REFUSED ...) comes back as it was phrased, so a world that could not be built
  is a failed scenario that says why rather than one that says nothing.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$Witness,
    [Parameter(Mandatory)][string]$Scenario,
    [Parameter(Mandatory)][string]$Clock,
    [Parameter(Mandatory)][string]$OutPath,
    [string]$ExtraComments
  )

  # The child is started HERE rather than before the loop, so a run filtered down to no
  # scenarios starts no child it will never ask.
  return (New-RehearsalWorld -Fixture $fixturePath -Scenario $Scenario -Witness $Witness -Clock $Clock -OutPath $OutPath -ExtraComments $ExtraComments)
}

function Get-SentinelChildEnv {
  <#
  .SYNOPSIS
  The sentinel child's WHOLE environment for one run, as data.

  Sent with the request rather than set in this process for the child to inherit,
  because a reused session does not get a fresh environment the way a fresh process
  does: every one of these decides what the scenario measures, and the scenario before
  it must not be able to reach any of them.

  The paths travel as VALUES in this map, never spliced into a command string - a space
  in a checkout path must not be able to become a parse error.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$ScriptPath,
    [Parameter(Mandatory)][string]$WorldPath,
    [Parameter(Mandatory)][string]$Gnomon
  )

  [ordered]@{
    REHEARSAL_STUB         = $stubPath
    REHEARSAL_SENTINEL     = $ScriptPath
    REHEARSAL_WORLD        = $WorldPath
    REHEARSAL_WORLD_SCRIPT = $worldScript
    REHEARSAL_LEDGER       = $ledgerPath
    # A token has to be present or the sentinel exits NO_TOKEN before its date gate;
    # the stub never reads it, and never sends anything anywhere.
    VERIFY_TOKEN           = 'rehearsal-token-never-sent'
    VERIFY_GNOMON          = $Gnomon
    # Dry on purpose, and stated here rather than inherited from the guard. These
    # scenarios rehearse what a sentinel CONCLUDES; the transport is simulated, so the
    # guard would now let a trip be filed into the fixture's world, which is not what
    # this file is measuring. The round trip is where a record legitimately lands in
    # that world.
    DRY_RUN                = '1'
  }
}

function Invoke-SentinelChild {
  <#
  .SYNOPSIS
  Run one sentinel against the simulated world once, through the host, and hand back
  its output.

  Used twice per filing scenario: against the world the fixture describes, and
  against that world with the recovered record on the issue.
  #>
  [CmdletBinding()]
  param([Parameter(Mandatory)][System.Collections.IDictionary]$Env)

  Start-SentinelHost
  $hostProcess = $script:SentinelHost

  $request = [pscustomobject]@{
    env   = $Env
    # The name the scenarios must not inherit from THIS process's environment: with it
    # set, a sentinel skips the date gate the fixture is built around. (The host clears
    # it before every request; see its header.)
    unset = @('VERIFY_FORCE')
  }
  # base64, so a path or a comment body with a character the console codepage cannot
  # spell crosses this pipe as the bytes it was written as (see the host's header).
  try {
    $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $request -Depth 5 -Compress)))
    $hostProcess.StandardInput.WriteLine($payload)
    $hostProcess.StandardInput.Flush()
  } catch {
    Stop-SentinelHost
    throw "REHEARSAL_HOST_FAILED (could not send the request to the rehearsal host: $($_.Exception.Message))"
  }

  try {
    $line = Read-RehearsalChildLine -Process $hostProcess -What 'the rehearsal host'
  } catch {
    Stop-SentinelHost
    throw "REHEARSAL_HOST_FAILED ($($_.Exception.Message))"
  }
  # One framed line per request, and nothing else is read as one: a stray write to the
  # host's stdout would otherwise hand a sentence back where a verdict is expected, and a
  # shifted frame would be read as the NEXT scenario's answer.
  if ($line -notmatch '^(RUN|HOST_ERROR) (?<payload>[A-Za-z0-9+/=]+)$') {
    Stop-SentinelHost
    throw "REHEARSAL_HOST_PROTOCOL (the rehearsal host answered outside the frame: $line)"
  }
  $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Matches['payload']))
  if ($line.StartsWith('HOST_ERROR')) {
    Stop-SentinelHost
    throw "REHEARSAL_HOST_REFUSED $text"
  }

  # The exit code is read from INSIDE the run: `exit N` in a script invoked with `&`
  # ends that script and leaves the code in $LASTEXITCODE, which the host prints as a
  # marker line - so a throw (an unrouted endpoint) skips the marker line entirely, and
  # a run that never reached a verdict is not read as one that exited 0.
  $raw = $text -replace "`r`n", "`n"
  $code = $null
  if ($raw -match '(?m)^REHEARSAL_EXIT=(?<code>\d+)\s*$') { $code = [int]$Matches['code'] }
  # The sentinel's own output, without the transport line the harness asked for.
  $out = (@($raw -split "`n" | Where-Object { $_ -notmatch '^REHEARSAL_EXIT=\d+' }) -join "`n")
  return [pscustomobject]@{ Code = $code; Out = $out; Lines = @($out -split "`n") }
}

if (Test-Path -LiteralPath $roundTripDir) { Remove-Item -LiteralPath $roundTripDir -Recurse -Force }
New-Item -ItemType Directory -Path $roundTripDir | Out-Null
if (Test-Path -LiteralPath $worldDir) { Remove-Item -LiteralPath $worldDir -Recurse -Force }
New-Item -ItemType Directory -Path $worldDir | Out-Null
$seq = 0
$roundTripped = 0
$recognised = 0

Write-Output "REHEARSAL fixture=$fixturePath scenarios=$(@($rehearsal.scenarios).Count)"

$ran = 0
$failed = 0
foreach ($scenario in $rehearsal.scenarios) {
  if ($Only -and ($scenario.name -notlike "*$Only*")) { continue }
  $ran++
  $seq++
  $problems = @()

  $entry = $contract.workflows.($scenario.sentinel)
  if (-not $entry) {
    $failed++
    Write-Output "REHEARSAL FAIL $($scenario.name)"
    Write-Output "  - $($scenario.sentinel) is not a declared workflow"
    continue
  }
  $watched = $contract.workflows.($entry.witnesses)
  $scriptPath = Join-Path $PSScriptRoot (Split-Path -Leaf $entry.script)

  # The scenario's world, materialised by the one interpreter that defines the
  # format: the runs attributed to the chain this sentinel witnesses, the issue and
  # its comments exactly as the fixture declares them, and the clock at the
  # sentinel's own fire time (01:00 UTC) so anything posted is stamped with the day
  # the sentinel said it was judging.
  $worldPath = Join-Path $worldDir "$seq.world.json"
  $materialized = @()
  try {
    [void](New-ScenarioWorld -Witness $entry.witnesses -Scenario $scenario.name -Clock "$($scenario.gnomon)T01:00:00Z" -OutPath $worldPath)
  } catch {
    $materialized += $_.Exception.Message
  }
  if (-not (Test-Path -LiteralPath $worldPath)) {
    if ($materialized.Count -eq 0) { $materialized += "the writer answered but $worldPath is not there" }
    $failed++
    Write-Output "REHEARSAL FAIL $($scenario.name)"
    Write-Output "  - the scenario's world could not be materialised: $($materialized -join '; ')"
    continue
  }

  Remove-Item -LiteralPath $ledgerPath -ErrorAction SilentlyContinue
  # The child's whole environment for this run travels with the request (see
  # Get-SentinelChildEnv): the same eight values a fresh process would have inherited,
  # and nothing left over from the scenario before this one.
  $result = Invoke-SentinelChild -Env (Get-SentinelChildEnv -ScriptPath $scriptPath -WorldPath $worldPath -Gnomon $scenario.gnomon)
  $code = $result.Code
  $out = $result.Out
  $lines = $result.Lines

  # --- what the scenario says should happen -----------------------------------
  if ($null -eq $code) {
    $problems += "the sentinel never reached a verdict (no exit code; it threw)"
  } elseif ($code -ne [int]$scenario.expect.exit) {
    $problems += "exit $code, expected $($scenario.expect.exit)"
  }
  if ($scenario.expect.verdict) {
    if (-not ($out -match "(?m)^VERDICT=$([regex]::Escape($scenario.expect.verdict))$")) {
      $problems += "no VERDICT=$($scenario.expect.verdict) line"
    }
  } elseif ($out -match '(?m)^VERDICT=[A-Z_]+$') {
    $problems += "filed a verdict although the scenario expects none ($($Matches[0]))"
  }
  $reachedWouldPost = $out.Contains($dryMarker)
  if ($scenario.expect.posts -and -not $reachedWouldPost) { $problems += 'never reached the would-post path' }
  if (-not $scenario.expect.posts -and $reachedWouldPost) { $problems += 'would have posted a comment' }
  $already = $out.Contains('ALREADY_RECORDED (')
  if ($scenario.expect.alreadyRecorded -and -not $already) { $problems += 'did not recognise its own record' }
  if (-not $scenario.expect.alreadyRecorded -and $already) { $problems += 'refused to file although no record exists' }
  foreach ($needle in @($scenario.expect.stdoutContains)) {
    if (-not $out.Contains($needle)) { $problems += "output does not contain: $needle" }
  }

  # --- the record identity, straight off the contract -------------------------
  $bodyAt = [array]::IndexOf($lines, $contract.logSyntax.body)
  if ($scenario.expect.bodyHeader) {
    if ($bodyAt -lt 0) {
      $problems += "no $($contract.logSyntax.body) line, so no record body to check"
    } else {
      $body = $lines[$bodyAt + 1]
      if (-not $body.StartsWith($scenario.expect.bodyHeader)) {
        $problems += "body starts with '$((($body -split ':')[0]))', expected '$($scenario.expect.bodyHeader)'"
      }
      if ($scenario.expect.verdict -and -not $body.Contains("**$($scenario.expect.verdict)**")) {
        $problems += "body does not name **$($scenario.expect.verdict)**"
      }
    }
  }

  # --- and the windows it read, which must be the declared ones ---------------
  $calls = @()
  if (Test-Path -LiteralPath $ledgerPath) { $calls = @(Get-Content -LiteralPath $ledgerPath) }
  # A refusal before the gate is the one scenario that must NOT have asked GitHub
  # anything; every other path starts by reading a run list.
  if ([int]$scenario.expect.exit -ne 2 -and $calls.Count -eq 0) { $problems += 'made no request at all' }
  foreach ($call in $calls) {
    if ($call -notmatch 'auth=True') { $problems += "request without an Authorization header: $call" }
  }
  if ($out.Contains('scheduled ') -and -not (@($calls | Where-Object { $_ -like "*created=$($watched.recordsOn)..$($entry.recordsOn)*" }).Count)) {
    $problems += "asked for runs outside the declared window $($watched.recordsOn)..$($entry.recordsOn)"
  }
  if ($out.Contains('#18 verifier comments') -and -not (@($calls | Where-Object { $_ -like "*since=$($watched.readsSince)*" }).Count)) {
    $problems += "scanned verdicts from somewhere other than the witness window since=$($watched.readsSince)"
  }
  if ($bodyAt -ge 0 -and -not (@($calls | Where-Object { $_ -like "*since=$($entry.recordsOn)T00:00:00Z*" }).Count)) {
    $problems += "searched for its own record from somewhere other than since=$($entry.recordsOn)T00:00:00Z"
  }

  # --- the round trip: the recovery pass reading THIS log ---------------------
  # The captured stdout is written out the way the workflow writes it - the
  # script's output, then its own `exit=<code>` line appended by the workflow - so
  # what the pass parses is the artifact itself, not a tidied version of it.
  if ($bodyAt -ge 0) {
    $roundTripped++
    $logPath = Join-Path $roundTripDir "$seq.log"
    $commentPath = Join-Path $roundTripDir "$seq.comment.json"
    Remove-Item -LiteralPath $commentPath -ErrorAction SilentlyContinue
    # No BOM, LF endings: the parser looks for exact lines.
    $exitLine = if ($null -ne $code) { "exit=$code`n" } else { '' }
    [System.IO.File]::WriteAllText($logPath, (($out -replace "`n+$", '') + "`n" + $exitLine), (New-Object System.Text.UTF8Encoding($false)))

    $trip = ''
    try {
      $trip = & node $roundTripScript --log $logPath --fixture $fixturePath --scenario $scenario.name --comment-out $commentPath 2>&1 | Out-String
    } catch {
      $problems += "the recovery pass could not be run over this log: $($_.Exception.Message)"
    }
    if ($trip -notmatch '(?m)^ROUNDTRIP OK ') {
      $problems += 'the recovery pass does not rebuild this record from its own log'
      foreach ($line in @($trip -split "`r?`n" | Where-Object { $_ -ne '' })) { Write-Output "      | $line" }
    }

    # --- and back the other way: the sentinel must recognise it --------------
    if ($scenario.expect.posts -and (Test-Path -LiteralPath $commentPath)) {
      # The same world with the recovered record on it - built by the same
      # child, so the two runs differ by exactly that one comment.
      $echoWorldPath = Join-Path $worldDir "$seq.echo.json"
      try {
        [void](New-ScenarioWorld -Witness $entry.witnesses -Scenario $scenario.name -Clock "$($scenario.gnomon)T01:00:00Z" -ExtraComments $commentPath -OutPath $echoWorldPath)
      } catch {
        $problems += "the world with the recovered record could not be built: $($_.Exception.Message)"
      }
      if (-not (Test-Path -LiteralPath $echoWorldPath)) {
        $problems += "the world with the recovered record could not be built: $echoWorldPath is not there"
      }
      Remove-Item -LiteralPath $ledgerPath -ErrorAction SilentlyContinue
      $echo = Invoke-SentinelChild -Env (Get-SentinelChildEnv -ScriptPath $scriptPath -WorldPath $echoWorldPath -Gnomon $scenario.gnomon)
      $echoCalls = @()
      if (Test-Path -LiteralPath $ledgerPath) { $echoCalls = @(Get-Content -LiteralPath $ledgerPath) }
      $posted = @($echoCalls | Where-Object { $_ -like 'POSTBODY*' }).Count
      if (-not $echo.Out.Contains('ALREADY_RECORDED (')) {
        # The duplicate-record failure: the pass re-posts a record the sentinel
        # cannot see, so every recovery makes the issue say it twice.
        $problems += 'the sentinel does not recognise the recovery pass''s own record as its own'
        foreach ($line in $echo.Lines) { Write-Output "      | $line" }
      } else {
        if ($echo.Out.Contains($dryMarker)) { $problems += 'recognised the recovered record but still reached the would-post path' }
        if ($posted) { $problems += 'the recovered record made the sentinel post again' }
        if (-not $echo.Out.Contains($dryMarker) -and $posted -eq 0) { $recognised++ }
      }
    }
  }

  if ($problems.Count -eq 0) {
    Write-Output "REHEARSAL OK   $($scenario.name)"
  } else {
    $failed++
    Write-Output "REHEARSAL FAIL $($scenario.name)"
    foreach ($problem in $problems) { Write-Output "  - $problem" }
    Write-Output '  --- the sentinel said ---'
    foreach ($line in $lines) { Write-Output "  | $line" }
  }
}

# Both ends are let go of here, in the order that matters: the host first (nothing should be
# asking the child while it is stopped), then the run's world child - whose lifetime pipe this
# process holds, so closing it is what ends it. Nothing else needs cleaning up: the sentinel
# child's environment is never set in this process, it travels with each request.
Stop-SentinelHost
Stop-RehearsalWorldSession
Remove-Item -LiteralPath $ledgerPath -ErrorAction SilentlyContinue
# The logs are the only copy of a failing scenario's artifact, so they are kept
# exactly when there is something to look at - and pointed at.
if ($failed -eq 0) {
  Remove-Item -LiteralPath $roundTripDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $worldDir -Recurse -Force -ErrorAction SilentlyContinue
} else {
  if (Test-Path -LiteralPath $roundTripDir) { Write-Output "REHEARSAL_LOGS $roundTripDir" }
  if (Test-Path -LiteralPath $worldDir) { Write-Output "REHEARSAL_WORLDS $worldDir" }
}

Write-Output ''
Write-Output "REHEARSAL_DONE scenarios=$ran failed=$failed roundtrip=$roundTripped recognised=$recognised"
if ($failed -gt 0) { exit 1 }
exit 0
