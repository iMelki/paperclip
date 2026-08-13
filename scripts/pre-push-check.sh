#!/usr/bin/env sh
# Paperclip pre-push gate: the exhaustive tier. POSIX mirror of pre-push-check.ps1.
#
# This hook -- not pre-commit, and not CI -- is where exhaustive verification lands.
#
#   * pre-commit is scoped and capped (affected typecheck + `vitest --related` under a
#     hard suite cap). It guards a local commit and is explicitly NOT authoritative:
#     on a hub module it selects 160-288 of 1130 specs, and an uncapped related run
#     costs MORE than the full suite it replaced because cost is dominated by module
#     import (measured 2026-08-13: 247.3s import vs 16.2s execution for 12 suites).
#
#   * CI cannot cover this repo's real work. .github/workflows/pr.yml is scoped to
#     `pull_request: branches: [master]` while all development happens on `dev`
#     (origin/dev was 1212 commits ahead of origin/master on 2026-08-13, with only 3
#     PRs ever opened into dev). CI is reserved for what only CI can do -- Linux/POSIX
#     behaviour, clean-environment installs, reviewer-independent verification.
#
# FAIL-CLOSED CONTRACT: no skip flag, no fast path. Each step's status is captured
# explicitly and any non-zero result rejects the push. `git push --no-verify` is the
# only escape and it is visible in the operator's own command line -- a bypass must
# never be silent. Steps run cheapest-first so a cheap failure never pays for the
# expensive one.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT" || exit 1

FAILED=0

if command -v pnpm >/dev/null 2>&1; then
  PNPM_BIN=pnpm
else
  echo "FAIL: pnpm was not found on PATH." >&2
  exit 1
fi

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  FAILED=1
}

pass() {
  echo "PASS"
}

START_EPOCH=$(date +%s)
echo "Paperclip - Pre-Push Check (exhaustive tier)"
echo "================================================"
# Quota awareness: a long gate can strand work if a usage window closes mid-push, and
# unpushed work is invisible. State the cost up front.
echo "Started $(date +%H:%M:%S). Expect roughly 60-90 minutes on this repo"
echo "(full -r typecheck plus the full vitest suite over ~1211 tracked test files)."
echo "This is the exhaustive gate; pre-commit deliberately ran only a capped subset."

run_step() {
  # run_step <name> <failure message> command...
  NAME="$1"; MSG="$2"; shift 2
  echo
  echo "Running $NAME..."
  STEP_START=$(date +%s)
  # Capture the step's status FIRST. Reading $? after a command substitution (the
  # elapsed-time arithmetic) would report `date`'s status instead of the step's, and
  # a gate that misreports why it failed is only marginally better than one that
  # fails silently.
  "$@"
  STEP_STATUS=$?
  STEP_ELAPSED=$(( $(date +%s) - STEP_START ))
  if [ "$STEP_STATUS" -eq 0 ]; then
    echo "  ($NAME took ${STEP_ELAPSED}s)"
    pass
  else
    echo "  ($NAME took ${STEP_ELAPSED}s, exit $STEP_STATUS)"
    fail "$MSG"
  fi
}

run_step "workspace link preflight" "Workspace link preflight failed." \
  "$PNPM_BIN" run preflight:workspace-links

[ "$FAILED" -eq 0 ] && run_step "forbidden token check" "Forbidden tokens found." \
  "$PNPM_BIN" run check:tokens

# NO deep history secret scan here -- deliberately, and this is not a coverage cut.
# The first draft ran `verify-gitleaks.mjs --history`: measured 2026-08-13 it scanned
# 7837 commits in 28.3s and exited 2 with 24 pre-existing findings, all in test fixtures
# and mock data. That makes the gate unpassable for reasons no push introduced or can
# fix, and an unpassable gate just trains everyone to use --no-verify -- which disables
# the test coverage below too. History is immutable, so scanning it per push re-checks
# the same commits forever; new content is already covered by the pre-commit staged scan.
# Relative to the pre-existing state (no pre-push hook at all) this removes nothing. The
# useful scope -- only the range being pushed -- needs a mode verify-gitleaks.mjs does
# not expose yet (it hardcodes --log-opts=--all). Tracked as a follow-up issue.

[ "$FAILED" -eq 0 ] && run_step "full TypeScript check (pnpm -r typecheck)" \
  "TypeScript check failed." "$PNPM_BIN" -r typecheck

[ "$FAILED" -eq 0 ] && run_step "full unit/integration suite (pnpm run test:run)" \
  "Unit tests failed." "$PNPM_BIN" run test:run

TOTAL_MIN=$(( ( $(date +%s) - START_EPOCH ) / 60 ))
echo
echo "================================================"
if [ "$FAILED" -ne 0 ]; then
  echo "PRE-PUSH CHECK FAILED after ${TOTAL_MIN} min"
  echo "The push was rejected. Fix the failure above, or push a branch that does not carry it."
  exit 1
fi

echo "PRE-PUSH CHECK PASSED in ${TOTAL_MIN} min"
exit 0
