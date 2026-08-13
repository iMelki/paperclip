#!/usr/bin/env sh
# Paperclip pre-push gate: changed-workspace verification. POSIX mirror of .ps1.
#
# This hook verifies the changed workspace without re-failing unrelated, known-red
# suites. It supplements pre-commit; exhaustive dev CI remains tracked in #67.
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
# The prior full-suite hook made every push reject while the baseline suite was red,
# including fixes to the failing tests (#73). This gate runs full typecheck plus
# uncapped tests related to the outgoing source changes. Each selected step is
# fail-closed; `git push --no-verify` remains Git's visible bypass.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT" || exit 1

FAILED=0
STEP_INDEX=0

if command -v pnpm >/dev/null 2>&1; then
  PNPM_BIN=pnpm
else
  echo "FAIL: pnpm was not found on PATH." >&2
  exit 1
fi

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  printf 'FAIL: %s\n' "$1" >> "$LOG_FILE"
  FAILED=1
}

pass() {
  echo "PASS"
  echo "PASS" >> "$LOG_FILE"
}

START_EPOCH=$(date +%s)
UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)
if [ -n "$UPSTREAM" ]; then
  MERGE_BASE=$(git merge-base HEAD "$UPSTREAM" 2>/dev/null || true)
else
  MERGE_BASE=""
fi
if [ -n "$MERGE_BASE" ]; then
  OUTGOING_FILES=$(git diff --name-only "$MERGE_BASE..HEAD") || exit 1
else
  OUTGOING_FILES=$(git diff-tree --no-commit-id --name-only -r HEAD) || exit 1
fi
TEST_FILES=$(printf '%s\n' "$OUTGOING_FILES" | grep -E '^(server|ui|cli|packages|tests)/|(^|/)(package\.json|pnpm-lock\.yaml|vitest\.[^/]+|vitest\.config\.[^/]+)$|\.(test|spec)\.[mc]?[jt]sx?$' || true)

echo "Paperclip - Pre-Push Check (changed-workspace tier)"
echo "================================================"
echo "Started $(date +%H:%M:%S)."
echo "Runs full typecheck and uncapped tests related to this push; #67 owns exhaustive dev CI."
LOG_DIR="$REPO_ROOT/.local-logs/pre-push"
mkdir -p "$LOG_DIR" || exit 1
LOG_FILE="$LOG_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
{
  echo "Paperclip - Pre-Push Check (changed-workspace tier)"
  echo "Started $(date -u +%Y-%m-%dT%H:%M:%SZ)."
} >> "$LOG_FILE"
echo "Full gate output: $LOG_FILE"

run_step() {
  # run_step <name> <failure message> command...
  NAME="$1"; MSG="$2"; shift 2
  echo
  echo "Running $NAME..."
  echo "Running $NAME..." >> "$LOG_FILE"
  STEP_START=$(date +%s)
  # Capture the step's status FIRST. Reading $? after a command substitution (the
  # elapsed-time arithmetic) would report `date`'s status instead of the step's, and
  # a gate that misreports why it failed is only marginally better than one that
  # fails silently.
  STEP_INDEX=$((STEP_INDEX + 1))
  STEP_LOG="${LOG_FILE}.step-${STEP_INDEX}"
  "$@" >"$STEP_LOG" 2>&1
  STEP_STATUS=$?
  cat "$STEP_LOG"
  cat "$STEP_LOG" >> "$LOG_FILE"
  STEP_ELAPSED=$(( $(date +%s) - STEP_START ))
  if [ "$STEP_STATUS" -eq 0 ]; then
    echo "  ($NAME took ${STEP_ELAPSED}s)"
    echo "  ($NAME took ${STEP_ELAPSED}s)" >> "$LOG_FILE"
    pass
  else
    echo "  ($NAME took ${STEP_ELAPSED}s, exit $STEP_STATUS)"
    echo "  ($NAME took ${STEP_ELAPSED}s, exit $STEP_STATUS)" >> "$LOG_FILE"
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

if [ "$FAILED" -eq 0 ] && [ -n "$TEST_FILES" ]; then
  # shellcheck disable=SC2086
  PAPERCLIP_PRECOMMIT_RELATED_CAP=0 run_step "uncapped unit/integration suites related to this push" \
    "A test related to this push failed." node scripts/run-vitest-stable.mjs --related $TEST_FILES
elif [ "$FAILED" -eq 0 ]; then
  echo "Skipping unit tests: this push has no test-bearing source files."
fi

TOTAL_MIN=$(( ( $(date +%s) - START_EPOCH ) / 60 ))
echo
echo "================================================"
if [ "$FAILED" -ne 0 ]; then
  echo "PRE-PUSH CHECK FAILED after ${TOTAL_MIN} min"
  echo "The push was rejected. Fix the failure in this push before retrying."
  exit 1
fi

echo "PRE-PUSH CHECK PASSED in ${TOTAL_MIN} min"
exit 0
