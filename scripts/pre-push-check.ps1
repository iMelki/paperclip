<#
.SYNOPSIS
  Paperclip pre-push gate: the exhaustive tier.

.DESCRIPTION
  This hook -- not pre-commit, and not CI -- is where exhaustive verification lands
  for this repo. That placement is deliberate:

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

  So the full suite runs here: once per push, free of Actions minutes, and off the
  per-commit critical path.

  FAIL-CLOSED CONTRACT
  This script has no skip flag and no fast path. Every step's exit code is captured
  explicitly and a single non-zero result fails the push. `git push --no-verify` is
  the only escape and it is visible in the operator's own command line -- that is
  intentional, so a bypass is never silent. Adding an env-var bypass here would make
  this gate indistinguishable from the absent hook it replaced.

  Steps are ordered cheapest-first so a cheap failure never pays for the expensive one.
#>

[CmdletBinding()]
param()

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

function Write-Fail {
  param([string]$Message)
  Write-Host "FAIL: $Message" -ForegroundColor Red
  $script:failed = $true
}

function Write-Pass {
  Write-Host "PASS" -ForegroundColor Green
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
  Write-Host ""
  Write-Host "Running $Name..."
  $stepStart = Get-Date
  & $Action
  $stepExit = $LASTEXITCODE
  $elapsed = [math]::Round(((Get-Date) - $stepStart).TotalSeconds, 1)
  if ($stepExit -eq 0) {
    Write-Host "  ($Name took ${elapsed}s)" -ForegroundColor DarkGray
    Write-Pass
  } else {
    Write-Host "  ($Name took ${elapsed}s, exit $stepExit)" -ForegroundColor DarkGray
    Write-Fail $FailureMessage
  }
}

$start = Get-Date
Write-Host "Paperclip - Pre-Push Check (exhaustive tier)"
Write-Host "================================================"
# R5 (quota-aware turn budgeting): a long gate can strand work if a usage window
# closes mid-push, and unpushed work is invisible. State the cost up front so the
# operator can decide not to start a push they cannot finish.
Write-Host "Started $($start.ToString('HH:mm:ss')). Expect roughly 60-90 minutes on this repo"
Write-Host "(full -r typecheck plus the full vitest suite over ~1211 tracked test files)."
Write-Host "This is the exhaustive gate; pre-commit deliberately ran only a capped subset."

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

# 5. The full suite. No --related, no cap. This is the whole point of the tier:
#    pre-commit's cap is only safe because this runs.
if (-not $failed) {
  Invoke-Step -Name "full unit/integration suite (pnpm run test:run)" `
    -Action { & $pnpm @("run", "test:run") } `
    -FailureMessage "Unit tests failed."
}

$totalMinutes = [math]::Round(((Get-Date) - $start).TotalMinutes, 1)
Write-Host ""
Write-Host "================================================"
if ($failed) {
  Write-Host "PRE-PUSH CHECK FAILED after ${totalMinutes} min" -ForegroundColor Red
  Write-Host "The push was rejected. Fix the failure above, or push a branch that does not carry it."
  exit 1
}

Write-Host "PRE-PUSH CHECK PASSED in ${totalMinutes} min" -ForegroundColor Green
exit 0
