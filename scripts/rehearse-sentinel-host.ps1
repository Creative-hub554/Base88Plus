<#
rehearse-sentinel-host.ps1: the one process the sentinel rehearsal keeps.

ONE JOB: it runs the rehearsal's child command per request, so 16 scenarios pay one
interpreter boot instead of ~25. That is what this file owns.

It does NOT own the world. The run's one node child belongs to the harness that drives
the run (scripts/rehearse-world-session.ps1), which publishes its endpoint in the
environment of everything it starts; this process inherits it and its stub - dot-sourced
in front of each scenario's command - asks that same child for every REST call. The
worlds the scenarios run against are asked by the harness on the same endpoint, so there
is no relay between the two processes: they are two clients of one child, and neither
holds a pipe for the other's questions.

WHY THIS EXISTS
---------------
The command a scenario has always run is three statements:

    . $env:REHEARSAL_STUB; & $env:REHEARSAL_SENTINEL; Write-Output ("REHEARSAL_EXIT=" + $LASTEXITCODE)

scripts/rehearse-sentinels.ps1 used to hand that text to a FRESH PowerShell per
request (-EncodedCommand) - 25 process starts for 16 scenarios: two for every
scenario that files a record (the world, then the world with the recovered record
on it) plus one for the rest. A PowerShell boot is ~1.2 s and the command it ran is
usually shorter than that, so ~36 s of a ~40 s rehearsal was interpreter starts and
not rehearsal. This file is the interpreter that is started once and asked to run
that command again and again.

The command, the environment it reads, the marker line and the exit code are
exactly what they were; only the number of interpreters changed. That is not a
promise - scripts/rehearsal-parity.mjs compares every rehearsal's report
byte-for-byte against its committed baseline (scripts/rehearsal-golden/).

WHY A LOOP HERE, AND NOT `& $env:REHEARSAL_SENTINEL` IN A LOOP IN THE HARNESS
-----------------------------------------------------------------------------
Because a sentinel ends every path with `exit N` and this process has to survive
that. Measured, on both engine lines (7.6.5 and 5.1): `exit` inside a script
invoked with `&` ends THAT script and leaves its code in $LASTEXITCODE - it does not
take the caller down. So the loop below is the same `& $env:REHEARSAL_SENTINEL`
invocation the child ran, with the same marker line printed after it. $LASTEXITCODE
is reset to $null before each run, which is also how "the sentinel never reached a
verdict (it threw)" is still told apart from "the sentinel exited": no marker line,
no code. The harness reads the marker, so the exit code it asserts on is the
sentinel's own, not this process's.

WHAT A REQUEST CARRIES, AND WHAT IT MUST NOT INHERIT
----------------------------------------------------
A child process inherits its caller's environment; a reused session does not, so the
environment travels as DATA - the whole environment for that request, never a delta:

  request   one line: base64(UTF-8 of JSON {"env":{NAME:VALUE,...},"unset":[NAME,...]})
  response  one line: RUN <base64>        the command ran; the payload is its captured text
                      HOST_ERROR <base64> the request could not be run at all

There used to be a third kind here - `materialize`, a world for the harness to run against -
because the world child's pipe was this process's and nothing else could reach it. The child
now listens on an endpoint both processes connect to, so that kind is gone: the harness asks
it directly, and this file is only about running the command.

Every name the previous request set and every name this request does not mention is
removed before the new environment is applied, and so is every name in `unset`: a
scenario must not inherit the scenario before it, nor a VERIFY_FORCE the operator
happened to have exported - VERIFY_FORCE bypasses the date gate the fixture is
built around.

Base64 is what keeps that wire ASCII, and it is not decoration: the values include
paths and comment bodies, and a character the console's codepage cannot spell would
otherwise be mangled by whichever codepage the two ends happen to disagree about.

The JSON is read through ConvertFrom-VerdictJson, the contract's own reader, for the
reason it exists: `2026-10-29` must stay the string the fixture wrote. PowerShell 7's
ConvertFrom-Json hands back a [DateTime], whose culture string is
`10/29/2026 00:00:00` - the gnomon would arrive at the sentinel's own date gate as
local time and slide the gate by the machine's UTC offset.

ONE LINE PER REQUEST IS THE PROTOCOL
------------------------------------
Nothing may reach this process's stdout except a response line, or the caller reads a
sentence where it expected an answer. Two things follow:

  - the command's other streams are folded into the capture (`*>&1`), which is what
    the caller's `2>&1` on the old child did - a warning or a verbose line belongs in
    the artifact, not in the frame;
  - progress records are silenced ($ProgressPreference below). They render to the
    HOST, which here is a pipe, so there is nowhere for them to land but the frame -
    the same reason scripts/rehearse-lifecycle.mjs sets that preference for the
    children it starts.

A script that wrote straight to the console (`Write-Host`, `[Console]::WriteLine`)
would still step outside the frame. tests/sentinel-rehearsal.test.ts pins that the
rehearsed scripts do not, and the caller fails loudly (REHEARSAL_HOST_PROTOCOL)
rather than reading a shifted frame as somebody else's answer.

USAGE
-----
Not a command a maintainer runs by hand: scripts/rehearse-sentinels.ps1 starts it
and writes one request line per scenario run to its stdin. Closing that pipe is the stop -
the loop ends on EOF and this process exits, with its own connection to the run's world child
and nothing else. Reads nothing but its own protocol from stdin; writes nothing to disk.

Exit: 0 when its stdin closed - a clean stop, whatever the scenarios concluded. A
      scenario's exit code is the marker line's business, not this process's.
#>
$ErrorActionPreference = 'Stop'
# Progress records render to the console, and this process's console is a pipe carrying a
# protocol. See ONE LINE PER REQUEST above.
$ProgressPreference = 'SilentlyContinue'

# The declared JSON reader, for the one reason it exists (see ConvertFrom-VerdictJson).
. (Join-Path $PSScriptRoot 'verdict-contract.ps1')
# How this process reaches the run's world child - the endpoint came in with the environment, and
# this process is a CLIENT of it: it connects for the routes its stub asks, and stops nothing
# the run owns. Loaded here as well as in the stub because the child scopes the stub is
# dot-sourced into are discarded, and the shutdown below still has to let go of the connection.
. (Join-Path $PSScriptRoot 'rehearse-world-session.ps1')

# The command, verbatim as the child ran it: the stub is dot-sourced into the scope the
# sentinel is then invoked from, so the sentinel's own scope chain reaches the shadowed
# Invoke-RestMethod. Created once and invoked per request; each invocation gets a fresh
# child scope, so nothing a scenario defines leaks into the next one.
$command = [scriptblock]::Create('. $env:REHEARSAL_STUB; & $env:REHEARSAL_SENTINEL; Write-Output ("REHEARSAL_EXIT=" + $LASTEXITCODE)')

# The names the previous request set, so this one cannot inherit them.
$applied = @()

function Send-RehearsalHostResponse {
  <#
  .SYNOPSIS
  One framed line per request: `RUN <base64>` or `HOST_ERROR <base64>`.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][ValidateSet('RUN', 'HOST_ERROR')][string]$Kind,
    [AllowEmptyString()][string]$Text
  )

  [Console]::Out.WriteLine("$Kind " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Text)))
  # Flushed per response: a caller waiting on its read must not wait on this buffer.
  [Console]::Out.Flush()
}

while ($true) {
  $line = [Console]::In.ReadLine()
  # EOF: the caller closed the pipe. That is the stop, which is why no shutdown request
  # exists to be forgotten.
  if ($null -eq $line) { break }

  $request = $null
  try {
    $request = ConvertFrom-VerdictJson ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Trim())))
  } catch {
    # Reported, not thrown: a refusal keeps the frame intact, and the caller turns it into a
    # failed rehearsal with this text in it.
    Send-RehearsalHostResponse -Kind 'HOST_ERROR' -Text "REHEARSAL_HOST_REQUEST_UNREADABLE ($($_.Exception.Message))"
    continue
  }
  if ($null -eq $request.env -or $null -eq $request.unset) {
    Send-RehearsalHostResponse -Kind 'HOST_ERROR' -Text 'REHEARSAL_HOST_REQUEST_INCOMPLETE (a request names the environment to set and the names to clear)'
    continue
  }

  $next = @($request.env.PSObject.Properties | ForEach-Object { $_.Name })
  # Every name the last request set and this one does not mention: gone. A reused session must
  # not be a place where the scenario before it can be read.
  foreach ($name in $applied) {
    if ($next -notcontains $name) { [Environment]::SetEnvironmentVariable($name, $null) }
  }
  foreach ($name in @($request.unset) | Where-Object { $_ }) {
    [Environment]::SetEnvironmentVariable([string]$name, $null)
  }
  foreach ($property in $request.env.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value)
  }
  $applied = $next

  # Collected as the pipeline runs, not after it: a sentinel that throws half way through its
  # output is the failure a reader most needs, and assigning afterwards would keep none of it.
  $collected = New-Object System.Collections.ArrayList
  try {
    # Reset first. A run that never exits (it throws) must not inherit the previous run's code
    # and print a marker line it did not earn.
    $global:LASTEXITCODE = $null
    & $command *>&1 | ForEach-Object { [void]$collected.Add($_) }
  } catch {
    # The console used to render this in the child; what the rehearsal's failure report showed
    # was the message, so that is what is carried at the end of the output. No marker line is
    # printed, which is how the harness still reads this as a run that never reached a verdict.
    [void]$collected.Add("Exception: $($_.Exception.Message)")
  }
  # The child's stdout was its objects, each followed by a newline: this is that text.
  $text = (@($collected | ForEach-Object { [string]$_ }) -join "`n") + "`n"
  Send-RehearsalHostResponse -Kind 'RUN' -Text $text
}

# The caller is gone. Let go of the connection to the run's world child here (the child itself
# belongs to the harness that drives the run, and stops when the harness's own pipe closes); the
# call is safe either way - a CLIENT closes its connection, an owner stops the child it started -
# so a run leaves nothing behind whichever of the two this process turned out to be.
Stop-RehearsalWorldSession
