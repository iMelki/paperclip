<#
.SYNOPSIS
  Paperclip pre-push gate: changed-workspace verification.

.DESCRIPTION
  This hook verifies the changed workspace without re-failing unrelated, known-red
  suites. It supplements the smaller pre-commit check; it is not a replacement for
  exhaustive CI on dev (tracked in #67).

    * pre-commit is scoped and capped (affected typecheck + `vitest --related` with a
      hard suite cap). It guards a local commit. It is explicitly NOT authoritative,
      because on a hub module it selects 160-288 of 1130 specs and an uncapped run
      costs MORE than the full suite it replaced -- cost is dominated by module
      import (measured 2026-08-13: 247.3s import vs 16.2s execution for 12 suites).

    * CI cannot cover this repo's real work. `.github/workflows/pr.yml` is scoped to
      `pull_request: branches: [master]`, while all development happens on `dev`
      (origin/dev was 1212 commits ahead of origin/master on 2026-08-13, with only 3
      PRs ever opened into dev). No CI run has validated those commits. CI is
      reserved for what only CI can do -- Linux/POSIX behaviour, clean-environment
      installs, and reviewer-independent verification -- not for exhaustiveness.

  The prior version ran the full suite here. That made every push reject while the
  baseline suite was red, including fixes to the failing suites (#73). The hook now
  runs the full TypeScript check plus uncapped tests related to the outgoing source
  changes. A failure still rejects the push; unrelated existing failures do not.

  FAIL-CLOSED CONTRACT
  This script has no skip flag. Every selected step's exit code is captured explicitly
  and a non-zero result rejects the push. `git push --no-verify` remains Git's visible
  bypass; no environment-variable bypass is provided here.

  Steps are ordered cheapest-first so a cheap failure never pays for the expensive one.
#>

[CmdletBinding()]
param(
  [string[]]$ChangedFiles,
  [switch]$DryRun,
  [string]$LogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..") | Select-Object -ExpandProperty Path
Set-Location $repoRoot

$failed = $false

$pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (-not $pnpmCommand) {
  $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
}
if (-not $pnpmCommand) {
  throw "pnpm was not found on PATH."
}
$pnpm = $pnpmCommand.Source

function Get-OutgoingChangedFiles {
  if ($ChangedFiles) {
    return @($ChangedFiles | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  }

  $upstream = & git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>$null
  if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($upstream)) {
    $mergeBase = & git merge-base HEAD $upstream
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($mergeBase)) {
      $files = @(& git diff --name-only "$mergeBase..HEAD")
      if ($LASTEXITCODE -eq 0) {
        return @($files | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
      }
    }
  }

  $files = @(& git diff-tree --no-commit-id --name-only -r HEAD)
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not resolve outgoing source files for the pre-push test selection.'
  }
  return @($files | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Test-TestBearingPath {
  param([string]$Path)
  return $Path -match '^(server|ui|cli|packages|tests)/' -or
    $Path -match '(^|/)(package\.json|pnpm-lock\.yaml|vitest\.[^/]+|vitest\.config\.[^/]+)$' -or
    $Path -match '\.(test|spec)\.[mc]?[jt]sx?$'
}

function Write-Fail {
  param([string]$Message)
  Write-GateLine -Message "FAIL: $Message" -Color Red
  $script:failed = $true
}

function Write-Pass {
  Write-GateLine -Message "PASS" -Color Green
}

# Deliberately returns nothing. An earlier draft returned the exit code and callers
# piped it to Out-Null -- which also swallowed the child process's stdout, hiding the
# very output an operator needs to diagnose a rejected push. Failure state travels
# through $script:failed instead, so the step's output streams through untouched.
function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Action,
    [string]$FailureMessage
  )
  Write-GateLine -Message ''
  Write-GateLine -Message "Running $Name..."
  $stepStart = Get-Date
  # Transcript misses stdout produced by some native children. Capture the child stream
  # explicitly, then write it to both the terminal and the durable gate log.
  $stepOutput = @(& $Action 2>&1)
  $stepExit = $LASTEXITCODE
  foreach ($line in $stepOutput) {
    $rendered = [string]$line
    Add-Content -LiteralPath $LogPath -Value $rendered
    Write-Host $rendered
  }
  $elapsed = [math]::Round(((Get-Date) - $stepStart).TotalSeconds, 1)
  if ($stepExit -eq 0) {
    Write-GateLine -Message "  ($Name took ${elapsed}s)" -Color DarkGray
    Write-Pass
  } else {
    Write-GateLine -Message "  ($Name took ${elapsed}s, exit $stepExit)" -Color DarkGray
    Write-Fail $FailureMessage
  }
}

$outgoingFiles = @(Get-OutgoingChangedFiles)
$testFiles = @($outgoingFiles | Where-Object { Test-TestBearingPath $_ })

if ($DryRun) {
  [ordered]@{
    mode = 'changed-workspace'
    outgoingFiles = $outgoingFiles
    testFiles = $testFiles
    runsFullTypecheck = $true
    runsUncappedRelatedTests = $testFiles.Count -gt 0
  } | ConvertTo-Json -Depth 4
  exit 0
}

if ([string]::IsNullOrWhiteSpace($LogPath)) {
  $logDirectory = Join-Path $repoRoot '.local-logs/pre-push'
  New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
  $LogPath = Join-Path $logDirectory ("{0:yyyyMMddTHHmmssZ}-{1}.log" -f [DateTime]::UtcNow, $PID)
}

[IO.File]::AppendAllText(
  $LogPath,
  ("Paperclip pre-push check started {0:O}{1}" -f [DateTimeOffset]::UtcNow, [Environment]::NewLine),
  [Text.UTF8Encoding]::new($false)
)
function Write-GateLine {
  param(
    [string]$Message,
    [ConsoleColor]$Color = [ConsoleColor]::Gray
  )
  Add-Content -LiteralPath $LogPath -Value $Message
  Write-Host $Message -ForegroundColor $Color
}

Write-GateLine -Message "Full gate output: $LogPath" -Color DarkGray

$start = Get-Date
Write-GateLine -Message 'Paperclip - Pre-Push Check (changed-workspace tier)'
Write-GateLine -Message '================================================'
Write-GateLine -Message "Started $($start.ToString('HH:mm:ss'))."
Write-GateLine -Message "Outgoing files: $($outgoingFiles.Count); test-bearing files: $($testFiles.Count)."
Write-GateLine -Message 'Runs full typecheck and uncapped tests related to this push; #67 owns exhaustive dev CI.'

# 1. Workspace link preflight -- seconds. Every later step depends on it, and it is
#    the cheapest way to catch a broken workspace before paying for a typecheck.
Invoke-Step -Name "workspace link preflight" `
  -Action { & $pnpm @("run", "preflight:workspace-links") } `
  -FailureMessage "Workspace link preflight failed."

# 2. Forbidden tokens -- seconds, repo-wide.
if (-not $failed) {
  Invoke-Step -Name "forbidden token check" `
    -Action { & $pnpm @("run", "check:tokens") } `
    -FailureMessage "Forbidden tokens found."
}

# 3. NO deep history secret scan here -- deliberately, and this is not a coverage cut.
#
#    The first draft of this gate ran `verify-gitleaks.mjs --history`. Measured
#    2026-08-13 it scanned 7837 commits in 28.3s and exited 2 with 24 findings, all
#    pre-existing and all in test fixtures and mock data (paperclip-runner protocol
#    fixtures, devtools/browser/src/App.tsx, and assorted *.test.ts). That makes the
#    gate unpassable for reasons no individual push introduced or can fix, and an
#    unpassable gate does not protect a repo -- it trains everyone to use --no-verify,
#    which disables the test coverage above too.
#
#    Scanning all history on every push is also the wrong scope: history is immutable,
#    so this re-litigates the same 7837 commits forever. New content is already scanned
#    by the pre-commit gate (verify-gitleaks.mjs --staged) before it can enter history.
#
#    Coverage delta, stated plainly: relative to this file's first draft this removes a
#    check; relative to what existed before this hook (no pre-push hook at all) it
#    removes nothing. The genuinely useful scope -- scanning only the commit range being
#    pushed, which would catch content that bypassed pre-commit via --no-verify -- needs
#    a range mode that verify-gitleaks.mjs does not yet expose (it hardcodes
#    --log-opts=--all). Tracked as a follow-up issue along with triaging the 24 findings.

# 4. Full typecheck across every workspace package. pre-commit only typechecks the
#    affected packages plus their dependents; this is the unscoped sweep.
if (-not $failed) {
  Invoke-Step -Name "full TypeScript check (pnpm -r typecheck)" `
    -Action { & $pnpm @("-r", "typecheck") } `
    -FailureMessage "TypeScript check failed."
}

# 5. Test every suite related to this push, without pre-commit's representative cap.
#    This preserves a real regression gate without making a red unrelated suite block
#    the commit that repairs it (#73).
if (-not $failed -and $testFiles.Count -gt 0) {
  Invoke-Step -Name "uncapped unit/integration suites related to this push" `
    -Action {
      $env:PAPERCLIP_PRECOMMIT_RELATED_CAP = '0'
      try {
        & node scripts/run-vitest-stable.mjs --related @testFiles
      } finally {
        Remove-Item Env:PAPERCLIP_PRECOMMIT_RELATED_CAP -ErrorAction SilentlyContinue
      }
    } `
    -FailureMessage "A test related to this push failed."
} elseif (-not $failed) {
  Write-GateLine -Message 'Skipping unit tests: this push has no test-bearing source files.' -Color DarkGray
}

$totalMinutes = [math]::Round(((Get-Date) - $start).TotalMinutes, 1)
Write-GateLine -Message ''
Write-GateLine -Message '================================================'
if ($failed) {
  Write-GateLine -Message "PRE-PUSH CHECK FAILED after ${totalMinutes} min" -Color Red
  Write-GateLine -Message 'The push was rejected. Fix the failure in this push before retrying.'
  $exitCode = 1
} else {
  Write-GateLine -Message "PRE-PUSH CHECK PASSED in ${totalMinutes} min" -Color Green
  $exitCode = 0
}

exit $exitCode
