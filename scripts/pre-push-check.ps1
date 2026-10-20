<#
.SYNOPSIS
  Paperclip pre-push gate: deterministic changed-workspace verification.

.DESCRIPTION
  Reads Git's real four-field pre-push protocol, resolves every outgoing path,
  runs cheap fail-closed policy checks, performs the full TypeScript check, and
  executes only exact changed or deterministic sibling tests. Runner ownership
  is explicit: Node test files use node:test, registered workspace suites use
  Vitest, and Playwright/unregistered/config changes are declared for hosted PR
  CI. Direct pushes of hosted-only changes to dev or master are rejected.

  There is no environment-variable skip. Git's visible --no-verify bypass is
  unchanged. A malformed/empty update stream, unresolved Git range, missing
  test, uncovered production file, or non-zero child exit rejects the push.
#>

[CmdletBinding()]
param(
  [string]$RemoteName,
  [string]$RemoteLocation,
  [string[]]$ChangedFiles,
  [string]$TargetRef = 'refs/heads/topic',
  [switch]$DryRun,
  [string]$LogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir '..') | Select-Object -ExpandProperty Path
Set-Location $repoRoot
. (Join-Path $scriptDir 'gate-native.ps1')

$node = Resolve-GateExecutable $(if ($IsWindows) { 'node.exe' } else { 'node' })
$git = Resolve-GateExecutable $(if ($IsWindows) { 'git.exe' } else { 'git' })

$previousErrorActionPreference = $ErrorActionPreference
try {
  $ErrorActionPreference = 'Continue'
  $gitLogResult = Invoke-GateNative -FilePath $git -ArgumentList @('rev-parse', '--git-path', 'paperclip-gate-logs/pre-push') -WorkingDirectory $repoRoot -Capture -TimeoutMs 120000
  $gitLogOutput = @($gitLogResult.Stdout.TrimEnd() -split "`r?`n")
  $gitLogExit = $gitLogResult.ExitCode
} finally {
  $ErrorActionPreference = $previousErrorActionPreference
}
$gitLogPath = if ($gitLogOutput.Count -eq 1) { [string]$gitLogOutput[0] } else { '' }
if ($gitLogExit -ne 0 -or [string]::IsNullOrWhiteSpace($gitLogPath)) {
  throw 'Could not resolve the Git-private pre-push log directory.'
}
if ([IO.Path]::IsPathRooted($gitLogPath)) {
  $logDirectory = [IO.Path]::GetFullPath($gitLogPath)
} else {
  $logDirectory = [IO.Path]::GetFullPath((Join-Path $repoRoot $gitLogPath))
}
if ([string]::IsNullOrWhiteSpace($LogPath)) {
  $LogPath = Join-Path $logDirectory ("{0:yyyyMMddTHHmmssZ}-{1}.log" -f [DateTime]::UtcNow, $PID)
}

$planArgs = @(
  (Join-Path $repoRoot 'scripts/run-pre-push-tests.mjs'),
  '--repo-root',
  $repoRoot
)
$updatesPath = $null

try {
if ($ChangedFiles -and $ChangedFiles.Count -gt 0) {
  if (-not $DryRun) {
    throw 'ChangedFiles is available only with DryRun; a real gate requires Git update objects for secret scanning.'
  }
  foreach ($file in $ChangedFiles) {
    if (-not [string]::IsNullOrWhiteSpace($file)) {
      $planArgs += @('--changed-file', $file)
    }
  }
  $planArgs += @('--target-ref', $TargetRef)
} else {
  if ([string]::IsNullOrWhiteSpace($RemoteName)) {
    throw 'RemoteName is required when ChangedFiles is not supplied.'
  }
  if ([string]::IsNullOrWhiteSpace($RemoteLocation)) {
    throw 'RemoteLocation is required when ChangedFiles is not supplied.'
  }
  New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
  $updatesPath = "$LogPath.updates"
  $updates = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($updates)) {
    throw 'Git supplied no pre-push ref updates on stdin.'
  }
  [IO.File]::WriteAllText($updatesPath, $updates, [Text.UTF8Encoding]::new($false))
  $planArgs += @(
    '--remote-name', $RemoteName,
    '--remote-location', $RemoteLocation,
    '--updates-file', $updatesPath
  )
}

if ($DryRun) {
  $dryResult = Invoke-GateNative -FilePath $node -ArgumentList @($planArgs + '--dry-run') -WorkingDirectory $repoRoot
  exit $dryResult.ExitCode
}

function Invoke-WorkspaceGate {
  param([string[]]$Arguments)
  return Invoke-GateNative -FilePath $node -ArgumentList (@('scripts/run-workspace-gate.mjs') + $Arguments) -WorkingDirectory $repoRoot -NativeLogPath $LogPath
}

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
[IO.File]::AppendAllText(
  $LogPath,
  ("Paperclip pre-push check started {0:O}{1}" -f [DateTimeOffset]::UtcNow, [Environment]::NewLine),
  [Text.UTF8Encoding]::new($false)
)

$failed = $false

function Write-GateLine {
  param(
    [string]$Message,
    [ConsoleColor]$Color = [ConsoleColor]::Gray
  )
  Add-Content -LiteralPath $LogPath -Value $Message
  Write-Host $Message -ForegroundColor $Color
}

function Write-Fail {
  param([string]$Message)
  Write-GateLine -Message "FAIL: $Message" -Color Red
  $script:failed = $true
}

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Action,
    [string]$FailureMessage
  )
  Write-GateLine -Message ''
  Write-GateLine -Message "Running $Name..."
  $stepStart = Get-Date
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $stepResult = & $Action
    $stepExit = $stepResult.ExitCode
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  $elapsed = [math]::Round(((Get-Date) - $stepStart).TotalSeconds, 1)
  if ($stepExit -eq 0) {
    Write-GateLine -Message "  ($Name took ${elapsed}s)" -Color DarkGray
    Write-GateLine -Message 'PASS' -Color Green
  } else {
    Write-GateLine -Message "  ($Name took ${elapsed}s, exit $stepExit)" -Color DarkGray
    Write-Fail $FailureMessage
  }
}

Write-GateLine -Message "Full gate output: $LogPath" -Color DarkGray
$start = Get-Date
Write-GateLine -Message 'Paperclip - Pre-Push Check (deterministic changed-workspace tier)'
Write-GateLine -Message '=================================================================='
Write-GateLine -Message "Started $($start.ToString('HH:mm:ss'))."
Write-GateLine -Message 'Exact local suites plus hosted dev PR CI replace uncapped import-graph selection.'

Invoke-Step -Name 'adapter/runtime no-git-push policy' `
  -Action { Invoke-GateNative -FilePath $node -ArgumentList @('scripts/check-no-git-push.mjs') -WorkingDirectory $repoRoot -NativeLogPath $LogPath } `
  -FailureMessage 'Adapter/runtime git-push policy failed or could not scan its full subject.'

if (-not $failed) {
  Invoke-Step -Name 'PR workflow trigger policy' `
    -Action { Invoke-GateNative -FilePath $node -ArgumentList @('scripts/check-pr-workflow-trigger.mjs') -WorkingDirectory $repoRoot -NativeLogPath $LogPath } `
    -FailureMessage 'PR workflow must cover master and dev without a push:dev trigger.'
}

if (-not $failed) {
  Invoke-Step -Name 'outgoing commit secret scan' `
    -Action {
      Invoke-GateNative -FilePath $node -ArgumentList @('scripts/scan-pre-push-secrets.mjs', '--repo-root', [string]$repoRoot, '--remote-name', $RemoteName, '--remote-location', $RemoteLocation, '--updates-file', $updatesPath) -WorkingDirectory $repoRoot -NativeLogPath $LogPath
    } `
    -FailureMessage 'An outgoing commit contains a secret or its exact scan failed.'
}

if (-not $failed) {
  Invoke-Step -Name 'workspace link preflight' `
    -Action { Invoke-WorkspaceGate -Arguments @('preflight') } `
    -FailureMessage 'Workspace link preflight failed.'
}

if (-not $failed) {
  Invoke-Step -Name 'forbidden token check' `
    -Action { Invoke-WorkspaceGate -Arguments @('tokens') } `
    -FailureMessage 'Forbidden tokens found.'
}

if (-not $failed) {
  Invoke-Step -Name 'full TypeScript check (pnpm -r typecheck)' `
    -Action { Invoke-WorkspaceGate -Arguments @('typecheck') } `
    -FailureMessage 'TypeScript check failed.'
}

if (-not $failed) {
  Invoke-Step -Name 'deterministic exact test plan' `
    -Action { Invoke-GateNative -FilePath $node -ArgumentList $planArgs -WorkingDirectory $repoRoot -NativeLogPath $LogPath } `
    -FailureMessage 'Exact test selection, hosted-CI policy, or a selected test failed.'
}

$totalMinutes = [math]::Round(((Get-Date) - $start).TotalMinutes, 1)
Write-GateLine -Message ''
Write-GateLine -Message '=================================================================='
if ($failed) {
  Write-GateLine -Message "PRE-PUSH CHECK FAILED after ${totalMinutes} min" -Color Red
  Write-GateLine -Message 'The push was rejected. Fix the named failure before retrying.'
  exit 1
}

Write-GateLine -Message "PRE-PUSH CHECK PASSED in ${totalMinutes} min" -Color Green
exit 0
} finally {
  if ($updatesPath -and (Test-Path -LiteralPath $updatesPath)) {
    Remove-Item -LiteralPath $updatesPath -Force -ErrorAction SilentlyContinue
  }
}
