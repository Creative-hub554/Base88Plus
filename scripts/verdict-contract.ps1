<#
verdict-contract.ps1: the PowerShell door into scripts/verdict-contract.json.

The declaration is read by three consumers in two languages - the PowerShell
scripts that WRITE the records, the recovery pass that re-posts a lost one, and
the heartbeat auditor that asks whether it landed. This file is the only place a
PowerShell script learns a marker, a window, a verdict shape or the record-issue
number, so a script cannot hold a second copy of any of them.

That is not tidiness. The copies had already drifted: verify-oct3.ps1 and
verify-oct28.ps1 searched prior comments for `verifier run <id>` while writing
`post-Oct-X verifier (run <id>, <day>)`, so the string they looked for never
appeared in the string they wrote, ALREADY_RECORDED could never fire, and a
re-run posted a duplicate record. Both sides now render the same `header`.

Usage, from a script that writes a record:
    . (Join-Path $PSScriptRoot 'verdict-contract.ps1')
    $contract = Get-VerdictContract
    $record   = Get-VerdictRecord -Contract $contract -ScriptPath $PSCommandPath
    $header   = Format-VerdictHeader -Record $record -Run $run.id -Day $today

A sentinel also resolves the chain it witnesses, and inherits its window:
    $watched  = $contract.workflows.($record.witnesses)

Anything that parses a declaration or a rehearsed world goes through
ConvertFrom-VerdictJson, never ConvertFrom-Json directly - see the note there.
#>

function ConvertFrom-VerdictJson {
  <#
  .SYNOPSIS
  Parse JSON as declared: an ISO instant stays the STRING it was written as.

  A FACT ABOUT THE CONTRACT MUST NOT MEAN TWO THINGS DEPENDING ON THE ENGINE.

  PowerShell's own reader does not promise that. `ConvertFrom-Json` turns
  `"2026-10-28T00:00:00Z"` into a [DateTime] on EVERY PowerShell 7 (measured on
  7.4.20 and 7.6.x: Kind Utc for a Z instant, Kind Local for an offset one):
  7.0-7.4 with no way to opt out at all, and 7.5+ only because `-DateKind String`
  exists. Windows PowerShell 5.1 does not convert - and 5.1 is the engine the
  rehearsals happened to run on, on a maintainer's box.

  Why it matters, in one line of arithmetic: a [DateTime] interpolated into a URL
  is a CULTURE string. On a UTC+07:00 box, `?since=$($watched.readsSince)` went
  out as `?since=10/28/2026 00:00:00`, which loses the Z, so the API reads the
  instant as LOCAL time and the window slides by the machine's UTC offset. It
  pulled a 2026-10-27 comment into a window declared to start 2026-10-28T00:00:00Z,
  and the Oct 29 sentinel classified a PASS recorded the day BEFORE promotion day
  as promotion day's own record - the exact false clearance its scenario in
  scripts/sentinel-rehearsal.json exists to catch, from the loader rather than
  from a script. The rehearsal caught it the first time it ran on pwsh 7.

  So this file does not ask the engine's reader to be honest, and does not sniff
  the version for a knob that only some engines have (that was the first attempt,
  and the 7.4 CI leg failed it: 7.4 converts and offers no `-DateKind`). On
  PowerShell 7 the parse is System.Text.Json, which maps no string to a date at
  all, so every value arrives as written - including the fractional and
  offset-bearing instants ConvertFrom-Json would rewrite. On Windows PowerShell
  5.1, where System.Text.Json does not exist, ConvertFrom-Json is already
  verbatim for these shapes, so the plain call is the honest one.

  Malformed JSON is not swallowed: Get-VerdictContract throws on a declaration it
  cannot read, and the rehearsal transport throws on an envelope the router did
  not send.
  #>
  [CmdletBinding()]
  param([Parameter(Mandatory, ValueFromPipeline)][string]$Json)

  process {
    # A capability test, not a version test: what decides the parse is what this
    # engine can do. It is a type LITERAL, because `[type]::GetType` searches only
    # the assemblies already loaded and answers $null on 7.4 and on 7.6 alike -
    # a probe that says no on every engine, which is how this helper's first
    # version quietly fell back to the coercing parser on the engine it was
    # written for.
    if (Test-VerdictVerbatimJson) {
      $document = [System.Text.Json.JsonDocument]::Parse($Json)
      try {
        return (ConvertFrom-VerdictJsonElement -Element $document.RootElement)
      } finally {
        $document.Dispose()
      }
    }
    return ($Json | ConvertFrom-Json)
  }
}

function Test-VerdictVerbatimJson {
  <#
  .SYNOPSIS
  Does this engine have a JSON reader that maps no string to a date?

  Asked by actually parsing a constant through the type literal, because the
  literal is what resolves (and loads) the assembly PowerShell ships: 5.1 throws
  "Unable to find type", PowerShell 7 parses. The answer cannot change within a
  session, so it is asked once.
  #>
  [CmdletBinding()]
  param()

  if ($null -ne $script:verdictVerbatimJson) { return $script:verdictVerbatimJson }
  $script:verdictVerbatimJson = $false
  try {
    $null = [System.Text.Json.JsonDocument]::Parse('{}')
    $script:verdictVerbatimJson = $true
  } catch {
    # No System.Text.Json (Windows PowerShell 5.1): ConvertFrom-Json is already
    # verbatim there. Nothing to report - the fallback is the answer, not a fault.
    $script:verdictVerbatimJson = $false
  }
  return $script:verdictVerbatimJson
}

function ConvertFrom-VerdictJsonElement {
  <#
  .SYNOPSIS
  One System.Text.Json node as the PSCustomObject shape every consumer already
  reads (the shape ConvertFrom-Json produces, minus its date handling).

  Numbers stay numbers, booleans stay booleans, JSON null is $null, and a nested
  array is an array rather than a value PowerShell unrolled on the way out - the
  rehearsal transport's whole "one element arrives as one object whose .Count is
  empty" hazard depends on that shape surviving.
  #>
  [CmdletBinding()]
  param([Parameter(Mandatory)][System.Text.Json.JsonElement]$Element)

  switch ($Element.ValueKind) {
    'Object' {
      $object = [pscustomobject]@{}
      foreach ($property in $Element.EnumerateObject()) {
        $object | Add-Member -NotePropertyName $property.Name `
          -NotePropertyValue (ConvertFrom-VerdictJsonElement -Element $property.Value)
      }
      return $object
    }
    'Array' {
      $items = @()
      foreach ($item in $Element.EnumerateArray()) {
        $items += , (ConvertFrom-VerdictJsonElement -Element $item)
      }
      # ,$items: a one-element array must not be unwrapped into its element on
      # the way out, or a one-comment response would become a comment.
      return , $items
    }
    'String' { return $Element.GetString() }
    'Number' {
      $integer = 0L
      if ($Element.TryGetInt64([ref]$integer)) { return $integer }
      return $Element.GetDouble()
    }
    'True' { return $true }
    'False' { return $false }
    'Null' { return $null }
    default { return $Element.GetRawText() }
  }
}

function Get-VerdictContract {
  <#
  .SYNOPSIS
  Read the declaration. The one and only source of contract facts.
  #>
  [CmdletBinding()]
  param([string]$Path = (Join-Path $PSScriptRoot 'verdict-contract.json'))

  if (-not (Test-Path -LiteralPath $Path)) {
    # Loud, never silent: a script that cannot read the contract must not fall
    # back to a remembered marker, because a wrong marker posts a record nobody
    # will ever find.
    throw "VERDICT_CONTRACT_MISSING $Path"
  }
  $contract = ConvertFrom-VerdictJson (Get-Content -Raw -LiteralPath $Path)

  # A sentinel does not declare its own window - it watches the chain's, exactly
  # as the JS loader resolves it. Two lines of derivation, in one place per
  # language, instead of a duplicated ISO timestamp in two files.
  #
  # The workflow file name is itself a declaration key, so it is materialised as
  # `workflow` here: a script that must name the workflow it runs as (or watches)
  # reads it back, rather than spelling it out a second time in a URL.
  foreach ($name in $contract.workflows.PSObject.Properties.Name) {
    $entry = $contract.workflows.$name
    if (-not $entry.PSObject.Properties['workflow']) {
      $entry | Add-Member -NotePropertyName workflow -NotePropertyValue $name
    }
    if ($entry.witnesses) {
      $witness = $contract.workflows.($entry.witnesses)
      if (-not $witness) {
        throw "VERDICT_CONTRACT_NO_WITNESS $name -> $($entry.witnesses)"
      }
      if (-not $entry.readsSince) {
        $entry | Add-Member -NotePropertyName readsSince -NotePropertyValue $witness.readsSince
      }
    }
  }
  return $contract
}

function Get-VerdictRecord {
  <#
  .SYNOPSIS
  The contract entry for the script asking - resolved by its own file name.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$ScriptPath,
    $Contract
  )

  if (-not $Contract) { $Contract = Get-VerdictContract }
  $leaf = Split-Path -Leaf $ScriptPath
  foreach ($property in $Contract.workflows.PSObject.Properties) {
    if ((Split-Path -Leaf $property.Value.script) -eq $leaf) { return $property.Value }
  }
  throw "VERDICT_CONTRACT_NO_ENTRY $leaf"
}

function Format-VerdictHeader {
  <#
  .SYNOPSIS
  Render the identity of ONE record: the text this script writes into the comment
  AND the text it must search for when asking whether it already posted.

  .PARAMETER Run
  The run id, or 'none' when the script looked for a run and found none (which is
  itself a record: CRON_NOT_FOUND, NO_DISPATCH_RUN).
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]$Record,
    [string]$Run = 'none',
    [Parameter(Mandatory)][string]$Day
  )

  # One record really is phrased without a run segment (oct28's NO_DISPATCH_RUN),
  # so the declaration carries that phrasing rather than this function inventing it.
  $template = if ($Run -eq 'none' -and $Record.headerNoRun) { $Record.headerNoRun } else { $Record.header }
  return $template.Replace('{run}', $Run).Replace('{day}', $Day)
}

function Test-VerdictSimulatedTransport {
  <#
  .SYNOPSIS
  $true when the only REST transport in this session is a rehearsal's simulated one.

  A rehearsal fakes the calendar (VERIFY_GNOMON / VERIFY_FORCE), so the record it
  derives can be FALSE on the real one - which is why a faked date must not post.
  What that guard is really protecting is "not to GitHub", and the thing that
  decides it is the TRANSPORT, not the date: scripts/rehearse-sentinel-stub.ps1
  defines a FUNCTION named Invoke-RestMethod, and PowerShell resolves a function
  before the cmdlet, so a function here means every request in this session is
  answered out of a world file (scripts/rehearse-world.mjs) or throws. With the
  cmdlet in charge, a faked date still forces DRY_RUN - the gnomon rehearsal of
  2026-09-30 that filed a false SENTINEL_NO_SCHEDULED_RUN on #18 is why this
  exists at all.
  #>
  [CmdletBinding()]
  param()
  $command = Get-Command Invoke-RestMethod -ErrorAction SilentlyContinue
  return [bool]($command -and $command.CommandType -eq 'Function')
}
