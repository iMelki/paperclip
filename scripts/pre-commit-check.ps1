<#
.SYNOPSIS
  Windows-friendly Paperclip pre-commit checks.

.DESCRIPTION
  Mirrors scripts/pre-commit-check.sh while avoiding a hard dependency on
  sh being available from PowerShell. By default this checks staged files for
  speed; pass -All or set PAPERCLIP_PRECOMMIT_ALL=1 for a full sweep.
#>

[CmdletBinding()]
param(
  [switch]$All
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..") | Select-Object -ExpandProperty Path
Set-Location $repoRoot

$failed = $false
$runAll = $All -or ($env:PAPERCLIP_PRECOMMIT_ALL -eq "1")
$stagedFiles = @(& git diff --cached --name-only --diff-filter=ACMR)

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

function Write-InfoLine {
  param([string]$Message)
  Write-Host "INFO: $Message" -ForegroundColor DarkGray
}

function Test-StagedMatch {
  param([string]$Pattern)
  foreach ($file in $stagedFiles) {
    if ($file -match $Pattern) {
      return $true
    }
  }
  return $false
}

function Invoke-Pnpm {
  param([string[]]$Arguments)
  & $pnpm @Arguments
}

Write-Host "Paperclip - Pre-Commit Check"
Write-Host "================================================"

Write-Host "Checking pnpm lockfile consistency..."
if ($runAll -or (Test-StagedMatch '^package\.json$|^pnpm-workspace\.yaml$')) {
  if (-not (Test-StagedMatch '^pnpm-lock\.yaml$')) {
    Write-Fail "package.json or workspace config changed without pnpm-lock.yaml. Update the lockfile."
  } else {
    Write-Pass
  }
} else {
  Write-Pass
}

Write-Host ""
Write-Host "Running TypeScript check..."
if ($runAll -or (Test-StagedMatch '^(server|ui|cli|packages)/|(^|/)(package\.json|pnpm-workspace\.yaml|tsconfig\.[^/]+|tsconfig\.json)$|\.tsx?$|\.mts$|\.cts$')) {
  Invoke-Pnpm @("-r", "typecheck")
  if ($LASTEXITCODE -eq 0) {
    Write-Pass
  } else {
    Write-Fail "TypeScript check failed."
  }
} else {
  Write-InfoLine "Skipping TypeScript check (no staged TypeScript/workspace changes)."
}

Write-Host ""
Write-Host "Running unit tests..."
if ($runAll -or (Test-StagedMatch '^(server|ui|cli|packages|tests)/|(^|/)(package\.json|pnpm-lock\.yaml|vitest\.[^/]+|vitest\.config\.[^/]+)$|\.test\.[mc]?tsx?$|\.spec\.[mc]?tsx?$')) {
  Invoke-Pnpm @("run", "test:run")
  if ($LASTEXITCODE -eq 0) {
    Write-Pass
  } else {
    Write-Fail "Unit tests failed."
  }
} else {
  Write-InfoLine "Skipping unit tests (no staged test-bearing changes)."
}

Write-Host ""
Write-Host "Checking forbidden tokens..."
Invoke-Pnpm @("run", "check:tokens")
if ($LASTEXITCODE -eq 0) {
  Write-Pass
} else {
  Write-Fail "Forbidden tokens found."
}

Write-Host ""
Write-Host "Running pinned Gitleaks staged scan..."
& node scripts/verify-gitleaks.mjs --staged
if ($LASTEXITCODE -eq 0) {
  Write-Pass
} else {
  Write-Fail "Pinned Gitleaks scan failed or detected potential secrets."
}

Write-Host ""
Write-Host "================================================"
if ($failed) {
  Write-Host "PRE-COMMIT CHECK FAILED" -ForegroundColor Red
  exit 1
}

Write-Host "PRE-COMMIT CHECK PASSED" -ForegroundColor Green
exit 0
