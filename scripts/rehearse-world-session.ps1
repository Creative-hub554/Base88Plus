<#
rehearse-world-session.ps1: the ONE node process a rehearsal keeps, and how every process in
that rehearsal reaches it.

WHY THIS EXISTS
---------------
Two roles used to be two children of the same file. The simulated transport
(scripts/rehearse-sentinel-stub.ps1) kept `serve --stdio` alive to answer REST calls - one
child per WORLD, because the world was an argument the child was started with and the sentinel
rehearsal walks seventeen of them - and that rehearsal kept a second child to write the worlds
those calls are answered from. Both roles are scripts/rehearse-world.mjs, and in the end they
are the same question: what does this world say. This file is the ONE child for both.

WHAT MADE ONE CHILD POSSIBLE is what a request carries. The world is not an argument any more;
it travels IN the question, exactly as the scenario, the witness, the clock and the output path
travel in a world-building request. A child that held either one at startup had to be replaced
whenever it moved - which is the whole reason there were two children, and seventeen of one of
them. What this process holds instead is parsed fixtures, by path (scripts/rehearse-world.mjs),
which is one per run.

WHY AN ENDPOINT RATHER THAN ITS OWN STDIN
-----------------------------------------
Because two different PROCESSES have questions. The rehearsal's driver builds the worlds and
the transport inside its child answers REST calls, and a pipe belongs to whoever started the
process - so with stdin as the wire, one of them must ask the other to ask the child, and the
rehearsal grows a middleman whose only job is to hold a pipe. The child listens on a LOCAL
endpoint instead (`session --endpoint <path>`): a named pipe on Windows, a Unix socket in the
run's own private directory elsewhere. No IP socket is opened, nothing leaves this machine, and
any process the run spawns can ask the same child directly. Its stdin becomes the LIFETIME pipe
- the owner holds it, and closing it stops the child, so a rehearsal that dies cannot leave one
behind (the session unlinks its socket on the way out).

ONE OWNER, EVERYONE ELSE A CLIENT
---------------------------------
The rule is one environment variable, and it is set by the process, not by the caller:

  REHEARSAL_WORLD_SESSION set      this process is a CLIENT: connect, ask, never start or stop.
  REHEARSAL_WORLD_SESSION unset    this process is the OWNER: choose the endpoint, start the
                                   child, and publish the path in its OWN environment, so every
                                   process it spawns becomes a client of the same child.

That is what makes a rehearsal one child. The sentinel rehearsal's harness owns the run's session,
and the host it starts - with the transport inside it - inherits the endpoint and connects; the
lifecycle's harness does the same for the per-step PowerShell it starts (each of those steps used
to be an owner and boot its own child: one record's life cost four children of the same file,
measured, before that harness published an endpoint). A process with no such driver - the
transport actor, run directly for a single case - is its own owner, which is what keeps that leg
working unchanged: one child for the whole process instead of one per world.

WHO OWNS THE STATE, AND IN WHICH SCOPE. The connection below lives in the GLOBAL scope, and that
is not laziness: these functions are dot-sourced into a scope the CALLER sets up and discards -
the host dot-sources the stub, and through it this file, inside a per-request command scope and
invokes the sentinel from there - while the connection has to outlive that request. `$script:`
would resolve, inside the sentinel's own scope chain, to a scope where none of this was ever set,
which is how the transport's first version of this read its timeout back empty and timed every
request out. (tests/transport-rehearsal.test.ts pins the scope, not just the names.)

Env:  REHEARSAL_WORLD_SESSION  the endpoint of this run's world child (see above)
      REHEARSAL_WORLD_SCRIPT   the file that defines the world. Optional: this file's own
                               directory is the default, so a client process needs nothing set
                               for it.
#>
$ErrorActionPreference = 'Stop'

# The contract's JSON reader is how every answer on this wire is parsed (a world's ISO instants
# have to arrive as strings - see ConvertFrom-VerdictJson), and this file asks for it itself
# rather than assuming a caller loaded it first: the harness, the host and the stub all do, but a
# caller that only needs to ask for a world should not have to know that.
. (Join-Path $PSScriptRoot 'verdict-contract.ps1')

# Loading is IDEMPOTENT, and that is not tidiness: the stub is dot-sourced once per REQUEST (the
# host runs each scenario's command in a scope it discards), so this file is re-executed while
# the connection it holds has to survive. Without this guard every dot-source ran these lines,
# forgot the run's connection - and opened another one, which is the per-request cost this file
# exists to remove.
if (-not $global:RehearsalWorldSessionLoaded) {
  $global:RehearsalWorldScript = if ($env:REHEARSAL_WORLD_SCRIPT) { $env:REHEARSAL_WORLD_SCRIPT } else { Join-Path $PSScriptRoot 'rehearse-world.mjs' }
  $global:RehearsalWorldClient = $null
  $global:RehearsalWorldChild = $null
  $global:RehearsalWorldTimeoutMs = 120000
  $global:RehearsalWorldSessionLoaded = $true
}

function Test-RehearsalWorldOwnership {
  <#
  .SYNOPSIS
  $true when this process owns the run's world child (see ONE OWNER above).
  #>
  [CmdletBinding()]
  param()

  return -not $env:REHEARSAL_WORLD_SESSION
}

function New-RehearsalWorldEndpoint {
  <#
  .SYNOPSIS
  A name no other run can be holding, in a form the platform understands.

  A fixed name in a temp directory is what two concurrent rehearsals would share (that was a
  real defect in this transport's earlier life, for the request body), so the owner draws a
  fresh one. Windows named pipes live in their own namespace, under the user's session; the
  Unix socket goes in a directory the child creates for itself with 0700, so a stray process of
  another user cannot reach it (and cannot have left something there for us to talk to).
  #>
  [CmdletBinding()]
  param()

  $name = "rehearsal-world-$([guid]::NewGuid().ToString('N'))"
  if ($IsWindows -or $PSVersionTable.PSEdition -eq 'Desktop') {
    return "\\.\pipe\$name"
  }
  return (Join-Path ([System.IO.Path]::GetTempPath()) (Join-Path $name 'world.sock'))
}

function Stop-RehearsalWorldSession {
  <#
  .SYNOPSIS
  Let go of the child: close this process's connection, and stop the child if this process owns it.

  A CLIENT does not stop the run's child - that is the owner's business, and a process that
  stopped a child other processes are still asking would take the rehearsal down with it.
  #>
  [CmdletBinding()]
  param()

  if ($null -ne $global:RehearsalWorldClient) {
    try { if ($global:RehearsalWorldClient.Reader) { $global:RehearsalWorldClient.Reader.Dispose() } } catch { }
    try { if ($global:RehearsalWorldClient.Writer) { $global:RehearsalWorldClient.Writer.Dispose() } } catch { }
    try { if ($global:RehearsalWorldClient.Transport) { $global:RehearsalWorldClient.Transport.Dispose() } } catch { }
  }
  $global:RehearsalWorldClient = $null

  if ($null -eq $global:RehearsalWorldChild) { return }
  $child = $global:RehearsalWorldChild
  $global:RehearsalWorldChild = $null
  # Closing the lifetime pipe IS the stop: the session's loop ends on EOF, its socket file goes
  # with it, and it exits. A child that ignores that is killed, so no run leaves a process.
  try { $child.StandardInput.Close() } catch { }
  try {
    if (-not $child.WaitForExit(5000)) { $child.Kill() }
  } catch {
    try { if (-not $child.HasExited) { $child.Kill() } } catch { }
  }
  try { $child.Dispose() } catch { }
}

function Start-RehearsalWorldSession {
  <#
  .SYNOPSIS
  Start the one child, as the OWNER, listening on this run's endpoint.
  #>
  [CmdletBinding()]
  param()

  $endpoint = New-RehearsalWorldEndpoint
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = 'node'
  # Quoted where it has to be: a checkout under a path with a space would otherwise split into
  # two arguments. (This is a command LINE, and .NET takes one string.)
  $info.Arguments = (@($global:RehearsalWorldScript, 'session', '--endpoint', $endpoint) | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  # stdin is the LIFETIME pipe and nothing else: this process holds it, and closing it is the
  # stop. It is redirected so that the child's life is tied to this run's, not to a console.
  $info.RedirectStandardInput = $true
  # stdout and stderr are deliberately NOT redirected. They are not wires any more - every
  # answer travels on the endpoint - so the child's own diagnostics have to be visible in the
  # rehearsal's output, and a redirected stream nobody reads is how a child that fills its
  # buffer while we wait on its socket becomes a hang.

  $child = New-Object System.Diagnostics.Process
  $child.StartInfo = $info
  try {
    [void]$child.Start()
  } catch {
    throw "REHEARSAL_ROUTER_UNAVAILABLE (could not start node: $($_.Exception.Message))"
  }
  $global:RehearsalWorldChild = $child
  # Published in this process's own environment: every process started from here inherits the
  # endpoint and becomes a client of this exact child.
  $env:REHEARSAL_WORLD_SESSION = $endpoint
}

function Connect-RehearsalWorldSession {
  <#
  .SYNOPSIS
  Open this process's connection to the run's world child, or say why it will not open.

  One connection per process, reused for every question it asks: a client that reconnected per
  question would pay the connect (and, on a named pipe, the process handshake) for each one -
  the cost this file exists to remove, one level down.
  #>
  [CmdletBinding()]
  param()

  if ($null -ne $global:RehearsalWorldClient) { return $global:RehearsalWorldClient }

  # The owner starts the child if it has not started one (and if the one it had has died between
  # questions: a child is replaced, never reused - what the next question reads has to be ITS
  # answer). A CLIENT never starts one: if the run's child is gone, the run is broken and saying
  # so is the only honest answer.
  if ((Test-RehearsalWorldOwnership) -and ($null -eq $global:RehearsalWorldChild -or $global:RehearsalWorldChild.HasExited)) {
    Stop-RehearsalWorldSession
    Start-RehearsalWorldSession
  }
  $endpoint = $env:REHEARSAL_WORLD_SESSION
  if (-not $endpoint) {
    throw 'REHEARSAL_ROUTER_UNAVAILABLE (no world child for this run: REHEARSAL_WORLD_SESSION is not set and this process is not the owner)'
  }

  $transport = $null
  try {
    if ($endpoint -like '\\.\pipe\*') {
      # Windows, on every engine: a named pipe in the local pipe namespace. The constructor wants
      # the pipe's NAME - the namespace prefix is not part of it - and that is stripped here by
      # hand rather than with Split-Path: asked for the leaf of `\.\pipe\<name>`, Windows
      # PowerShell 5.1 answers with an EMPTY string, and the client then fails to construct with
      # `pipeName cannot be an empty string`, which took the whole fallback-engine rehearsal down
      # (every request a REHEARSAL_ROUTER_UNAVAILABLE) until it was run there. No engine's
      # Split-Path may decide whether this run can reach its child.
      $name = $endpoint.Substring('\\.\pipe\'.Length)
      $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $name, [System.IO.Pipes.PipeDirection]::InOut)
      $pipe.Connect(5000)
      $transport = $pipe
    } else {
      # Everywhere else, on PowerShell 7 (which is the only engine these rehearsals run on
      # outside Windows): a Unix domain socket at the path the owner named.
      $socket = New-Object System.Net.Sockets.Socket(
        [System.Net.Sockets.AddressFamily]::Unix,
        [System.Net.Sockets.SocketType]::Stream,
        [System.Net.Sockets.ProtocolType]::Unspecified)
      $socket.Connect([System.Net.Sockets.UnixDomainSocketEndPoint]::new($endpoint))
      $transport = New-Object System.Net.Sockets.NetworkStream($socket, $true)
    }
  } catch {
    throw "REHEARSAL_ROUTER_UNAVAILABLE (could not connect to the world child at ${endpoint}: $($_.Exception.Message))"
  }

  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $global:RehearsalWorldClient = [pscustomobject]@{
    Transport = $transport
    Reader    = New-Object System.IO.StreamReader($transport, $utf8)
    Writer    = New-Object System.IO.StreamWriter($transport, $utf8)
  }
  return $global:RehearsalWorldClient
}

function Send-RehearsalWorldFrame {
  <#
  .SYNOPSIS
  Ask the run's child one question and hand back its answer, or a reason there will not be one.

  There is deliberately NO RETRY for a question already sent: a write that failed may or may not
  have reached the child, and a question that mutates the world (a POST) asked twice would file
  the record twice. A connection that fails is dropped instead, so the NEXT question opens a
  fresh one - and if this process owns the child, that question starts a new child.

  Bounded, so a child that stops answering is a failure with a reason rather than a rehearsal
  that hangs until the job gives up on it.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]$Frame,
    [Parameter(Mandatory)][string]$What
  )

  $client = Connect-RehearsalWorldSession
  try {
    $line = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Frame -Depth 20 -Compress)))
    $client.Writer.WriteLine($line)
    $client.Writer.Flush()
  } catch {
    Stop-RehearsalWorldSession
    throw "REHEARSAL_ROUTER_FAILED (could not send $What to the world child: $($_.Exception.Message))"
  }

  $reading = $client.Reader.ReadLineAsync()
  $answered = $false
  try {
    $answered = $reading.Wait($global:RehearsalWorldTimeoutMs)
  } catch {
    # The connection faulted while we waited (a reset, a child that killed the socket): a failed
    # question with a reason, which is also what the caller needs in order to decide whether the
    # question was asked at all - never a raw transport exception in the middle of a rehearsal.
    Stop-RehearsalWorldSession
    throw "REHEARSAL_ROUTER_FAILED (could not read the answer to ${What}: $($_.Exception.Message))"
  }
  if (-not $answered) {
    Stop-RehearsalWorldSession
    throw "REHEARSAL_ROUTER_TIMEOUT (no answer in $($global:RehearsalWorldTimeoutMs)ms for $What)"
  }
  try {
    $answer = $reading.Result
  } catch {
    Stop-RehearsalWorldSession
    throw "REHEARSAL_ROUTER_FAILED (could not read the answer to ${What}: $($_.Exception.Message))"
  }
  if ([string]::IsNullOrEmpty($answer)) {
    # How it ended matters: `still running` is a connection that closed under us, and the child
    # may be perfectly alive for its other clients - either way this question has no answer.
    $state = if ($global:RehearsalWorldChild -and $global:RehearsalWorldChild.HasExited) { "exit $($global:RehearsalWorldChild.ExitCode)" } else { 'still running' }
    Stop-RehearsalWorldSession
    throw "REHEARSAL_ROUTER_FAILED (the world child closed the connection, $state) for $What"
  }
  # Through the contract's own reader, like every other JSON door in the rehearsal: the
  # envelopes carry the world's ISO instants, and PowerShell's own reader would turn each of
  # them into a [DateTime] on every PowerShell 7 (see ConvertFrom-VerdictJson).
  return ConvertFrom-VerdictJson ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($answer)))
}

function Invoke-RehearsalRoute {
  <#
  .SYNOPSIS
  One REST question, answered out of the world named in it.

  The world travels with the question - that is what lets ONE child answer for a rehearsal that
  moves the world between scenarios - and the router re-reads it from its file per question, so
  a scenario's timeline still moves through the FILE: nothing about a world's meaning lives in
  the child.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$World,
    [Parameter(Mandatory)][string]$Method,
    [Parameter(Mandatory)][string]$Uri,
    [string]$Body,
    [string]$Token
  )

  $answer = Send-RehearsalWorldFrame -What "$Method $Uri" -Frame ([pscustomobject]@{
      kind   = 'route'
      world  = $World
      method = $Method
      uri    = $Uri
      token  = $Token
      # The body is the raw JSON text a write sends - multi-line, quoted - and it travels
      # INSIDE the request rather than as an argument or a temp file: the protocol is JSON in,
      # JSON out, so neither side has to quote anything.
      body   = $Body
    })
  # A line the child could not read at all comes back phrased for both readers (see the
  # protocol in scripts/rehearse-world.mjs): the envelope is what the transport throws on.
  if ($answer.kind -eq 'refusal') { return $answer.envelope }
  if ($answer.kind -ne 'route') {
    throw "REHEARSAL_ENVELOPE_UNKNOWN $($answer.kind) (a routing question was answered with a $($answer.kind) frame)"
  }
  return $answer.envelope
}

function New-RehearsalWorld {
  <#
  .SYNOPSIS
  Write one scenario's world file through the run's child, and hand back its path.

  Whoever builds a world is on this same endpoint, so there is no relay in the middle: the
  rehearsal's driver asks the child it owns, and a client asks the child the run published.

  Throws with the child's own reason, so a world that could not be built is a failed scenario
  that says why rather than one that says nothing.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$Fixture,
    [Parameter(Mandatory)][string]$Scenario,
    [Parameter(Mandatory)][string]$Witness,
    [Parameter(Mandatory)][string]$Clock,
    [Parameter(Mandatory)][string]$OutPath,
    [string]$ExtraComments
  )

  $answer = Send-RehearsalWorldFrame -What "the world for $Scenario" -Frame ([pscustomobject]@{
      kind          = 'materialize'
      fixture       = $Fixture
      scenario      = $Scenario
      witness       = $Witness
      clock         = $Clock
      out           = $OutPath
      extraComments = $ExtraComments
    })
  if ($answer.kind -eq 'refusal') { throw "REHEARSAL_WORLD_REFUSED $($answer.error)" }
  if ($answer.kind -ne 'materialize') {
    throw "REHEARSAL_WORLD_PROTOCOL (a world request was answered with a $($answer.kind) frame)"
  }
  if ($answer.error) { throw "REHEARSAL_WORLD_REFUSED $($answer.error)" }
  return [string]$answer.out
}
