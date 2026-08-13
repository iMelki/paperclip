<#
.SYNOPSIS
  Negative-proof fixture for the pre-push gate: prove it rejects, then prove it allows.

.DESCRIPTION
  A control is untrusted until it has been observed to FAIL on a deliberately broken
  input. This matters more than usual for a husky pre-push hook, because the failure
  mode is invisible: the dispatcher `.husky/_/h` does

      s=$(dirname "$(dirname "$0")")/$n
      [ ! -f "$s" ] && exit 0

  so a MISSING .husky/pre-push exits 0 and is indistinguishable from a passing gate.
  Three repos in this fleet were discovered to have no pre-push gate at all precisely
  because "no output" was read as "passed".

  This fixture swaps .husky/pre-push for a stub that exits 1 (the push MUST be
  rejected), then for a stub that exits 0 (the push MUST be allowed), pushing to a
  throwaway bare repository so no real remote is ever contacted. The real hook file is
  restored from a backup and the restore is asserted by SHA256.

  Asserting BOTH directions is the point: a gate stuck closed rejects everything and
  proves nothing, and a gate stuck open rejects nothing. Only the pair is evidence.

.EXAMPLE
  pwsh -File scripts/prove-pre-push-fails-closed.ps1
  # exit 0 = gate proven to fail closed AND pass green
#>
[CmdletBinding()]
param(
  [string]$RepoRoot,
  [string]$ScratchRoot = $env:TEMP
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $RepoRoot = Resolve-Path (Join-Path $scriptDir "..") | Select-Object -ExpandProperty Path
}
Set-Location $RepoRoot

$hook = Join-Path $RepoRoot '.husky/pre-push'
if (-not (Test-Path $hook)) {
  Write-Host "FAIL: .husky/pre-push does not exist, so there is no gate to prove." -ForegroundColor Red
  Write-Host "      (Note this is exactly the state that exits 0 and looks like a pass.)"
  exit 1
}

# Confirm the hook is actually reachable. A hook file that git never invokes -- for
# example when core.hooksPath is an absolute path into a sibling worktree -- is
# decoration, and this fixture would otherwise 'prove' a gate that never runs.
$hooksPath = (& git config --get core.hooksPath)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($hooksPath)) { $hooksPath = ".git/hooks" }
$dispatchTarget = Join-Path (Split-Path -Parent (Join-Path $RepoRoot $hooksPath)) 'pre-push'
if (-not (Test-Path $dispatchTarget)) {
  Write-Host "FAIL: core.hooksPath is '$hooksPath', so git would look for the hook at" -ForegroundColor Red
  Write-Host "      $dispatchTarget, which does not exist. The gate cannot fire from this worktree."
  exit 1
}

$stamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')
$scratch = Join-Path $ScratchRoot "paperclip-prepush-proof-$stamp"
$bare = Join-Path $scratch 'scratch-remote.git'
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
& git init --bare $bare *> $null

$backup = "$hook.realbak"
$realHash = (Get-FileHash $hook -Algorithm SHA256).Hash
Copy-Item $hook $backup -Force

function Invoke-ProbePush {
  # --dry-run still runs pre-push: git invokes the hook before any object transfer,
  # so this exercises the real gate without writing to any remote.
  & git push --dry-run $bare HEAD:refs/heads/gate-proof *>&1 | Out-String | Write-Verbose
  return $LASTEXITCODE
}

$rejected = $false
$allowed = $false
try {
  Set-Content $hook "#!/usr/bin/env sh`nexit 1`n" -NoNewline
  $rejected = ((Invoke-ProbePush) -ne 0)
  Write-Host ("gate returns 1 -> push " + $(if ($rejected) { "REJECTED (correct)" } else { "ACCEPTED (BROKEN)" }))

  Set-Content $hook "#!/usr/bin/env sh`nexit 0`n" -NoNewline
  $allowed = ((Invoke-ProbePush) -eq 0)
  Write-Host ("gate returns 0 -> push " + $(if ($allowed) { "ALLOWED (correct)" } else { "REJECTED (stuck closed)" }))
}
finally {
  Copy-Item $backup $hook -Force
  Remove-Item $backup -Force -ErrorAction SilentlyContinue
  $after = (Get-FileHash $hook -Algorithm SHA256).Hash
  if ($after -ne $realHash) {
    Write-Host "CRITICAL: failed to restore .husky/pre-push; expected $realHash got $after" -ForegroundColor Red
  }
  Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

if ($rejected -and $allowed) {
  Write-Host "PROVEN: pre-push is wired, dispatches, and git enforces its exit code." -ForegroundColor Green
  exit 0
}

Write-Host "NOT PROVEN: the pre-push gate does not behave as a gate." -ForegroundColor Red
exit 1
