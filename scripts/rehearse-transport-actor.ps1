<#
rehearse-transport-actor.ps1: the PowerShell transport's answers, one per case, in ONE session.

The PowerShell half of scripts/rehearse-transports.mjs, and nothing else: it dot-sources
scripts/rehearse-sentinel-stub.ps1 - the transport the sentinels, the verifiers and
therefore the cron chain really run against - issues the request each case file describes,
and prints what the CALLER received as one JSON document per case.

ONE SESSION, EVERY CASE. An engine launch is the better part of a second, and ten questions
do not need ten of them. Each case is asked in its own function scope, so nothing a case
assigns can reach the next, and the transport is the same stub against the same world - the
report is byte for byte what one-case-per-session produced, which is why the committed
baseline did not move when this changed.

Every line names its case, so the driver pairs observations BY NAME rather than by position:
a session that died half way through is then a failed CASE with its reason, instead of a
comparison quietly shifted by one.

"What the caller received" is the whole point. `items` is `@($value)`, the array the
scripts' own wraps produce, so a one-element response (which PowerShell unrolls into a
single object with no `.Count`) and a three-element one are comparable with the Node
transport without either side pretending the other's shape. The instants inside arrive as
the strings the world served, because the case is read with the same verbatim reader the
scripts use (ConvertFrom-VerdictJson, dot-sourced with the stub) - a transport that coerced
them would print a culture-formatted instant, and the comparison would fail. That is the
defect this rehearsal exists to keep visible.

Usage: invoked by scripts/rehearse-transports.mjs, which supplies the environment the stub
requires (REHEARSAL_WORLD, REHEARSAL_WORLD_SCRIPT, REHEARSAL_LEDGER) and one case file per
line of $CaseList - a list file rather than arguments because `-File` binds only ONE value
to an array parameter and would take the rest as positionals (found the hard way, on the
first run of the batched version):

  { "name": "issue-get", "method": "GET", "uri": "...", "token": "...", "body": "<JSON>", "web": false }

Output: one compressed line per case, `{ "name": <case>, "observation": { ... } }`.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$CaseList
)

$ErrorActionPreference = 'Stop'
# Only observations go to the output stream; progress chatter would be parsed as one.
$ProgressPreference = 'SilentlyContinue'

# The transport under rehearsal. Dot-sourcing defines Invoke-RestMethod and
# Invoke-WebRequest in this session, so the calls below are the real ones.
. (Join-Path $PSScriptRoot 'rehearse-sentinel-stub.ps1')

function Get-RehearsalCase {
  <#
  .SYNOPSIS
  Ask the world one case's question and wrap the answer with the case it answers.

  A function rather than inline code for the scope, not for reuse: a case's variables live
  and die here, so one case cannot leave something behind that decides what the next one
  observes.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$Case
  )

  $spec = ConvertFrom-VerdictJson (Get-Content -LiteralPath $Case -Raw)
  $headers = @{ Authorization = "Bearer $($spec.token)" }

  $observation = $null
  try {
    if ($spec.web) {
      # The verifiers' live upstream compare, which the real script makes with
      # Invoke-WebRequest and reads .Content from.
      $response = Invoke-WebRequest -Uri $spec.uri -UseBasicParsing
      $observation = [pscustomobject]@{
        kind    = 'web'
        status  = [int]$response.StatusCode
        content = [string]$response.Content
      }
    }
    else {
      $call = @{
        Uri         = $spec.uri
        Method      = $spec.method
        Headers     = $headers
        ContentType = 'application/json'
      }
      # Only when the case carries one: passing an empty body would send a
      # `--body-file` for a GET, which is not how a script asks.
      if ($spec.body) { $call.Body = $spec.body }
      $value = Invoke-RestMethod @call
      # @(...) is what every caller does with a response, so it is what is compared:
      # one element arrives as ONE object here, and the count must still be 1.
      $items = @($value)
      $observation = [pscustomobject]@{
        kind  = 'items'
        count = $items.Count
        items = $items
      }
    }
  }
  catch {
    # The refusal a script sees: the cmdlet's message, and the body the workflow's
    # own error handling prints ($_.ErrorDetails.Message) when the world sent one.
    $details = $null
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $details = [string]$_.ErrorDetails.Message }
    $observation = [pscustomobject]@{
      kind    = 'error'
      message = [string]$_.Exception.Message
      details = $details
    }
  }

  return [pscustomobject]@{
    name        = $spec.name
    observation = $observation
  }
}

# One path per line, blank lines dropped: the order the driver wrote them is the order they
# are asked, which is the order the report reads in.
$cases = @(Get-Content -LiteralPath $CaseList | Where-Object { $_.Trim() })
foreach ($case in $cases) {
  Write-Output (ConvertTo-Json -InputObject (Get-RehearsalCase -Case $case.Trim()) -Depth 20 -Compress)
}
