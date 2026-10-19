<#
rehearse-sentinel-stub.ps1: the simulated transport a rehearsed PowerShell tool talks to.

Dot-source it, then run any of the scripts that record a verdict (the two
verifiers and the two day-after sentinels) in the same session, and their own code
runs unchanged. PowerShell resolves a command by alias, then FUNCTION, then cmdlet,
then external, so defining a function named `Invoke-RestMethod` shadows the cmdlet
for every caller here - including a script invoked with `&`, whose scope chains up
to this one. The scripts keep their date gate, run filtering, the `@(...)` counting
a single comment would break, verdict classification, header rendering and the
ALREADY_RECORDED guard; only the transport is fake.

The WORLD is not in this file. Every request is marshalled to
scripts/rehearse-world.mjs - one interpreter, shared with the Node tools (the
heartbeat auditor and the recovery pass reach it through a fetch shim) - so a fact
about the world cannot mean two things depending on which language asked. Nor is the
PROCESS it is marshalled to: scripts/rehearse-world-session.ps1 owns the one node
child a rehearsal keeps, the local endpoint it listens on, and the frames it answers. The
process that STARTS a rehearsal owns that child - in the sentinel rehearsal, the harness -
and every process the run starts is a client of it: this stub connects for its routes, and
the harness asks the same child for its worlds (see that file). What this file owns is the
transport:

  - It cannot reach the network. A routed request is answered from the world file;
    an unrouted one THROWS. `Invoke-WebRequest` is shadowed for the same reason: if
    a script ever grows a second way out, the rehearsal fails loudly here rather
    than calling GitHub with the rehearsal's deliberately fake token.
  - The responses are shaped like the API's, down to the unrolling. A route whose
    real answer is a top-level JSON array is written to the output stream item by
    item, which is what makes a one-element response arrive as a single object whose
    `.Count` is empty - the exact Hazard the scripts' `@(...)` wraps exist to
    survive. Serving a tidy array instead would rehearse a kinder GitHub than the
    real one.
  - Every request is appended to $env:REHEARSAL_LEDGER, so a rehearsal can assert
    which windows were asked for - the declaration's, or somebody else's.

Env:  REHEARSAL_WORLD   the world file the router answers from
      REHEARSAL_LEDGER  request log

The world travels with each request rather than being an argument the child is started
with, which is what lets ONE child answer a rehearsal that moves the world between
scenarios (scripts/rehearse-world-session.ps1 states the whole of it). REHEARSAL_WORLD_SCRIPT
still names the file that defines the world where a caller sets it; the session defaults it
to scripts/rehearse-world.mjs next to that file.
#>

$ErrorActionPreference = 'Stop'

# The parser the contract loader uses, from the one file that defines it. The
# envelopes below carry the world's ISO instants, and PowerShell's own reader
# would turn each of them into a [DateTime] (every PowerShell 7 does; Windows
# PowerShell 5.1 does not); the Node transport (JSON.parse in
# scripts/rehearse-world.mjs) never would. "One interpreter, two transports - a
# fact about the world cannot mean two things depending on which language asked"
# is the whole reason the router exists, so the transport reads its answers the
# way the declaration is read - and on every engine alike. See
# ConvertFrom-VerdictJson for the whole story.
. (Join-Path $PSScriptRoot 'verdict-contract.ps1')

if (-not $env:REHEARSAL_WORLD -or -not $env:REHEARSAL_LEDGER) {
  throw 'REHEARSAL_ENV_MISSING: set REHEARSAL_WORLD (path) and REHEARSAL_LEDGER (path)'
}
if (-not (Test-Path -LiteralPath $env:REHEARSAL_WORLD)) {
  throw "REHEARSAL_WORLD_MISSING $($env:REHEARSAL_WORLD)"
}

function Write-RehearsalLedger {
  param([string]$Line)
  Add-Content -LiteralPath $env:REHEARSAL_LEDGER -Value $Line
}

# ------------------------------------------------------------------- the world child
#
# The child this session asks, and the frames it answers, are
# scripts/rehearse-world-session.ps1's: ONE process per rehearsal PROCESS, answering both a
# routing question and a world-building one. It used to be kept here, one child per WORLD,
# because the world was an argument the child was started with and the sentinel rehearsal
# moves the world between scenarios - which also meant a second child (the rehearsal's own
# materialiser) running the same file for the same run. The world now travels with each
# question, so nothing has to be keyed, restarted or duplicated:
#
#     { kind: "route", world, method, uri, token, body }  ->  { kind: "route", envelope }
#
# It is the SAME router: the same world file, the same `route()`, the same envelope - what a
# rehearsal exercises does not change, which is why every rehearsal's report, and every
# committed baseline, is unchanged by this. Only the number of processes is.
. (Join-Path $PSScriptRoot 'rehearse-world-session.ps1')

function Invoke-RestMethod {
  <#
  .SYNOPSIS
  The simulated API. Same parameters the scripts pass, no network.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$Uri,
    [string]$Method = 'Get',
    [hashtable]$Headers,
    [string]$ContentType,
    [string]$Body
  )

  $verb = $Method.ToUpper()
  Write-RehearsalLedger "$Method $Uri auth=$([bool]($Headers -and $Headers['Authorization']))"
  if ($verb -eq 'POST' -and $Body) { Write-RehearsalLedger "POSTBODY $Body" }

  # The credential travels with the request: a world where a write is refused is a
  # world refusing THIS token, the way GitHub refuses a workflow without
  # `issues: write`.
  $token = $null
  if ($Headers -and $Headers['Authorization']) { $token = ([string]$Headers['Authorization']) -replace '^Bearer\s+', '' }
  $requestBody = if ($verb -in @('POST', 'PATCH')) { $Body } else { $null }
  # The world travels with the question: the same file for every call in a run unless the
  # rehearsal moved it, which is why it is read from the environment per request rather than
  # baked into a child at startup.
  $response = if ($null -eq $requestBody) {
    Invoke-RehearsalRoute -World $env:REHEARSAL_WORLD -Method $verb -Uri $Uri -Token $token
  } else {
    Invoke-RehearsalRoute -World $env:REHEARSAL_WORLD -Method $verb -Uri $Uri -Body $requestBody -Token $token
  }

  if ($response.status -ne 200) {
    # Thrown like the cmdlet throws, details and all: the scripts print
    # `COMMENT_FAILED $($_.Exception.Message)` and then `$_.ErrorDetails.Message`,
    # which is how a lost record's artifact carries the 403's body.
    $record = New-Object System.Management.Automation.ErrorRecord(
      [System.Net.WebException]::new($response.message), 'RehearsalHttpError', 'InvalidOperation', $null)
    if ($response.details) {
      $record.ErrorDetails = [System.Management.Automation.ErrorDetails]::new([string]$response.details)
    }
    throw $record
  }

  switch ($response.kind) {
    'array' {
      # Item by item, exactly as the real response unrolls: one element arrives as
      # one object (no .Count), none arrives as $null.
      foreach ($item in $response.items) { Write-Output $item }
    }
    'object' { $response.value }
    'web' { @{ Content = $response.content; StatusCode = 200 } }
    default { throw "REHEARSAL_ENVELOPE_UNKNOWN $($response.kind)" }
  }
}

function Invoke-WebRequest {
  <#
  .SYNOPSIS
  Raw files (the verifiers' live upstream compare), also from the world - a URL the
  world does not describe is an error, never a request.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory, Position = 0)][string]$Uri,
    [switch]$UseBasicParsing,
    [hashtable]$Headers,
    [Parameter(ValueFromRemainingArguments = $true)]$Rest
  )

  Write-RehearsalLedger "WEBGET $Uri"
  $response = Invoke-RehearsalRoute -World $env:REHEARSAL_WORLD -Method 'GET' -Uri $Uri
  if ($response.status -ne 200) {
    throw "REHEARSAL_NETWORK_BLOCKED (no world entry for $Uri) - a rehearsal must not reach the network"
  }
  # A body this transport cannot carry is a FAILURE, not an empty success. The real
  # cmdlet hands back a [byte[]] for a non-text response (an artifact zip is what the
  # recovery pass downloads), and the envelope here is JSON/text - so answering
  # `@{ Content = $null; StatusCode = 200 }` would rehearse a successful download of
  # nothing, and the script reading it would look broken instead of the transport.
  # No script in this repo downloads an artifact (the recovery pass is Node, and the
  # one Invoke-WebRequest here reads a raw text file), so this is the only honest
  # answer; scripts/rehearse-transports.mjs pins it with the artifact-zip case.
  if ($response.kind -eq 'binary') {
    throw "REHEARSAL_BINARY_UNSUPPORTED (the world answered $Uri with bytes; this transport carries JSON, so it cannot hand back a download)"
  }
  if ($response.kind -ne 'web') {
    throw "REHEARSAL_ENVELOPE_UNKNOWN $($response.kind) (Invoke-WebRequest reads a raw file, not a $($response.kind) response)"
  }
  return @{ Content = $response.content; StatusCode = 200 }
}
