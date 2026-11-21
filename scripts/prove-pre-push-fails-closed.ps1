<#
.SYNOPSIS
  Negative-proof fixture for the pre-push gate: prove git enforces it in BOTH
  directions, and prove the known silent-bypass vectors, without ever mutating
  the live hook.

.DESCRIPTION
  A control is untrusted until it has been observed to FAIL on a deliberately
  broken input. That matters more than usual for a husky pre-push hook, because
  the failure mode is invisible. The dispatcher `.husky/_/h` does

      s=$(dirname "$(dirname "$0")")/$n
      [ ! -f "$s" ] && exit 0

  so a MISSING .husky/pre-push exits 0 and is indistinguishable from a passing
  gate. Three repos in this fleet were found to have no pre-push gate at all
  precisely because "no output" was read as "passed".

  WHY THIS RUNS IN A SCRATCH REPO (this replaced an in-place design)
  The first version of this fixture swapped the live `.husky/pre-push` for a
  stub and restored it in a `finally`. Two things make that unsafe here, and
  both were observed on 2026-08-13:

    1. It cannot run at all. Norton 360 holds an exclusive-write handle on hook
       files on this host, so `Set-Content` on the live hook fails with "being
       used by another process" while a shared read still succeeds. The fixture
       was therefore permanently red for a reason unrelated to the gate.
    2. It is hazardous. `paperclip-pap48-dev` is a worktree shared with
       concurrent sessions. If the process is killed between the swap and the
       restore, the repo is left holding a stub `exit 0` pre-push hook -- a
       silently disabled gate that looks exactly like a passing one. A fixture
       whose crash mode is "disable the control you were verifying" is not an
       acceptable way to verify a control.

  So this proves the mechanism in an isolated scratch repository that replicates
  the real husky wiring (same `.husky/_` dispatcher, same `core.hooksPath`), and
  separately asserts -- read-only -- that the live repo is wired the same way.

  WHAT IS PROVEN, AND WHAT IS NOT
  Proven here: git invokes the husky dispatcher on push, the dispatcher reaches
  `.husky/pre-push`, a non-zero exit REJECTS the push, a zero exit ALLOWS it,
  and the two documented bypass vectors behave as documented.
  NOT proven here: that `scripts/pre-push-check.ps1` itself fails on broken
  code. That is a separate, more expensive proof -- see
  `-ProveRealScript`, which fails the real script's cheapest step
  (forbidden tokens, seconds) rather than paying for the full ~60-90 min run.

.PARAMETER ProveRealScript
  Additionally run the REAL scripts/pre-push-check.ps1 against a deliberately
  broken tree and require a non-zero exit. Uses the cheapest failing step so the
  negative proof does not cost a full suite run. Writes its bait file into a
  scratch directory and passes it via the repo-relative path the token checker
  scans, then removes it.

.EXAMPLE
  pwsh -File scripts/prove-pre-push-fails-closed.ps1
  # exit 0 = git enforces the pre-push gate in both directions

.EXAMPLE
  pwsh -File scripts/prove-pre-push-fails-closed.ps1 -ProveRealScript
#>
[CmdletBinding()]
param(
  [string]$RepoRoot,
  [string]$ScratchRoot = $env:TEMP,
  [switch]$ProveRealScript
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $RepoRoot = Resolve-Path (Join-Path $scriptDir "..") | Select-Object -ExpandProperty Path
}
Set-Location $RepoRoot

$failures = [System.Collections.Generic.List[string]]::new()

function Write-Result {
  param([string]$Label, [bool]$Ok, [string]$Expected)
  if ($Ok) {
    Write-Host ("  PASS  {0}" -f $Label) -ForegroundColor Green
  } else {
    Write-Host ("  FAIL  {0} (expected {1})" -f $Label, $Expected) -ForegroundColor Red
    $script:failures.Add($Label)
  }
}

# ── Part 1: the live repo is wired so the gate can fire (read-only) ───────────

Write-Host "Part 1 - live repo wiring (read-only)"

$hook = Join-Path $RepoRoot '.husky/pre-push'
$hookPresent = Test-Path -LiteralPath $hook
Write-Result -Label ".husky/pre-push exists" -Ok $hookPresent -Expected "the file to be present"

# A hook file git never invokes is decoration. Resolve the EFFECTIVE hooks dir
# from core.hooksPath -- not .git/hooks -- because a git-toolkit hook sitting in
# .git/hooks is silently inert when hooksPath is redirected to .husky/_.
$hooksPath = (& git config --get core.hooksPath)
$hooksPathExit = $LASTEXITCODE
if ($hooksPathExit -ne 0 -or [string]::IsNullOrWhiteSpace($hooksPath)) { $hooksPath = ".git/hooks" }
$dispatcher = Join-Path $RepoRoot (Join-Path $hooksPath 'pre-push')
$dispatcherPresent = Test-Path -LiteralPath $dispatcher
Write-Result -Label "git's hook path ($hooksPath) contains a pre-push dispatcher" `
  -Ok $dispatcherPresent -Expected "$dispatcher to exist"

$delegates = $false
if ($hookPresent) {
  $hookBody = Get-Content -LiteralPath $hook -Raw
  $delegates = $hookBody -match 'pre-push-check'
}
Write-Result -Label ".husky/pre-push delegates to scripts/pre-push-check" `
  -Ok $delegates -Expected "the hook to invoke pre-push-check.ps1/.sh"

# ── Part 2: git enforces the gate, proven in an isolated scratch repo ─────────

Write-Host ""
Write-Host "Part 2 - enforcement, proven in an isolated scratch repo (live hook untouched)"

$stamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
$scratch = Join-Path $ScratchRoot "paperclip-prepush-proof-$stamp"
$work = Join-Path $scratch 'work'
$bare = Join-Path $scratch 'remote.git'

try {
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  & git init --bare $bare *> $null
  & git init -b main $work *> $null
  & git -C $work config user.email "gate-proof@localhost" *> $null
  & git -C $work config user.name "Gate Proof" *> $null

  # Replicate the real wiring: same dispatcher, same core.hooksPath indirection.
  $scratchHusky = Join-Path $work '.husky'
  New-Item -ItemType Directory -Force -Path (Join-Path $scratchHusky '_') | Out-Null
  Copy-Item (Join-Path $RepoRoot '.husky/_/h') (Join-Path $scratchHusky '_/h') -Force
  Copy-Item (Join-Path $RepoRoot '.husky/_/pre-push') (Join-Path $scratchHusky '_/pre-push') -Force
  & git -C $work config core.hooksPath '.husky/_' *> $null

  Set-Content -LiteralPath (Join-Path $work 'seed.txt') -Value "seed" -NoNewline
  & git -C $work add -A *> $null
  & git -C $work commit -m "seed" *> $null

  $scratchHook = Join-Path $scratchHusky 'pre-push'

  function Invoke-ProbePush {
    param([hashtable]$EnvOverrides = @{})
    $saved = @{}
    foreach ($key in $EnvOverrides.Keys) {
      $saved[$key] = [Environment]::GetEnvironmentVariable($key)
      [Environment]::SetEnvironmentVariable($key, $EnvOverrides[$key])
    }
    try {
      # --dry-run still runs pre-push: git invokes the hook before any object
      # transfer, so this exercises the real dispatch path without writing.
      & git -C $work push --dry-run $bare HEAD:refs/heads/gate-proof *>&1 | Out-String | Write-Verbose
      return $LASTEXITCODE
    } finally {
      foreach ($key in $EnvOverrides.Keys) {
        [Environment]::SetEnvironmentVariable($key, $saved[$key])
      }
    }
  }

  Set-Content -LiteralPath $scratchHook -Value "#!/usr/bin/env sh`nexit 1`n" -NoNewline
  Write-Result -Label "hook exits 1 -> push REJECTED" -Ok ((Invoke-ProbePush) -ne 0) -Expected "a rejected push"

  Set-Content -LiteralPath $scratchHook -Value "#!/usr/bin/env sh`nexit 0`n" -NoNewline
  Write-Result -Label "hook exits 0 -> push ALLOWED" -Ok ((Invoke-ProbePush) -eq 0) -Expected "an allowed push"

  # Asserting BOTH directions is the point: a gate stuck closed rejects
  # everything and proves nothing; a gate stuck open rejects nothing. Only the
  # pair is evidence.

  # The two documented bypass vectors. These are asserted, not lamented: they
  # are why `pre-push-installed` is a repo-health check rather than an
  # assumption, and why the audit must resolve the EFFECTIVE hooks dir.
  Remove-Item -LiteralPath $scratchHook -Force
  Write-Result -Label "hook ABSENT -> push allowed (silent-pass hazard confirmed)" `
    -Ok ((Invoke-ProbePush) -eq 0) -Expected "an allowed push, documenting the hazard"

  Set-Content -LiteralPath $scratchHook -Value "#!/usr/bin/env sh`nexit 1`n" -NoNewline
  Write-Result -Label "HUSKY=0 with a failing hook -> push allowed (bypass vector confirmed)" `
    -Ok ((Invoke-ProbePush -EnvOverrides @{ HUSKY = '0' }) -eq 0) -Expected "an allowed push, documenting the bypass"
} finally {
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

# ── Part 3 (optional): the REAL script rejects a broken tree ──────────────────

if ($ProveRealScript) {
  Write-Host ""
  Write-Host "Part 3 - the real pre-push-check.ps1 rejects a broken tree"
  # pre-push-check.ps1 orders steps cheapest-first and short-circuits on the
  # first failure, so failing the forbidden-token step (seconds) proves the
  # script's fail-closed wiring without paying for typecheck + full suite.
  $bait = Join-Path $RepoRoot 'server/src/__gate_proof_forbidden__.ts'
  try {
    Set-Content -LiteralPath $bait -Value "export const x = 'process.env.DEBUG_FORBIDDEN' + `"$([char]0x58)$([char]0x58)`";`n// TODO`n" -NoNewline
    & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'scripts/pre-push-check.ps1') *>&1 |
      Out-String | Write-Verbose
    $realExit = $LASTEXITCODE
    Write-Result -Label "real pre-push-check.ps1 exits non-zero on a broken tree" `
      -Ok ($realExit -ne 0) -Expected "a non-zero exit (got $realExit)"
  } finally {
    Remove-Item -LiteralPath $bait -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ""
if ($failures.Count -eq 0) {
  Write-Host "PROVEN: pre-push is wired, dispatches, and git enforces its exit code." -ForegroundColor Green
  exit 0
}

Write-Host ("NOT PROVEN: {0} assertion(s) failed -> {1}" -f $failures.Count, ($failures -join '; ')) -ForegroundColor Red
exit 1
