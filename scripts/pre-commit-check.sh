#!/usr/bin/env sh
# Paperclip pre-commit checks
#
# Defaults to checking staged files for speed.
# Use --all or PAPERCLIP_PRECOMMIT_ALL=1 for full sweep.

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

FAILED=0
RUN_ALL="${PAPERCLIP_PRECOMMIT_ALL:-0}"
STAGED_FILES="$(git diff --cached --name-only --diff-filter=ACMR)"

if [ "${1:-}" = "--all" ]; then
  RUN_ALL=1
fi

PNPM_BIN="pnpm"
if command -v pnpm.cmd >/dev/null 2>&1; then
  PNPM_BIN="pnpm.cmd"
fi

echo "🔒 Paperclip - Pre-Commit Check"
echo "================================================"

fail() {
  echo "FAIL: $1"
  FAILED=1
}

pass() {
  echo "PASS"
}

info() {
  echo "INFO: $1"
}

has_staged_match() {
  printf '%s\n' "$STAGED_FILES" | grep -Eq "$1"
}

echo "✓ Checking pnpm lockfile consistency..."
if [ "$RUN_ALL" = "1" ] || has_staged_match '^package\.json$|^pnpm-workspace\.yaml$'; then
  if ! has_staged_match '^pnpm-lock\.yaml$'; then
    fail "package.json or workspace config changed without pnpm-lock.yaml. Update the lockfile."
  else
    pass
  fi
else
  pass
fi

echo
echo "✓ Running TypeScript check..."
if [ "$RUN_ALL" = "1" ] || has_staged_match '^(server|ui|cli|packages)/|(^|/)(package\.json|pnpm-workspace\.yaml|tsconfig\.[^/]+|tsconfig\.json)$|\.tsx?$|\.mts$|\.cts$'; then
  if $PNPM_BIN -r typecheck; then
    pass
  else
    fail "TypeScript check failed."
  fi
else
  info "Skipping TypeScript check (no staged TypeScript/workspace changes)."
fi

echo
echo "✓ Running unit tests..."
if [ "$RUN_ALL" = "1" ] || has_staged_match '^(server|ui|cli|packages|tests)/|(^|/)(package\.json|pnpm-lock\.yaml|vitest\.[^/]+|vitest\.config\.[^/]+)$|\.test\.[mc]?tsx?$|\.spec\.[mc]?tsx?$'; then
  if $PNPM_BIN run test:run; then
    pass
  else
    fail "Unit tests failed."
  fi
else
  info "Skipping unit tests (no staged test-bearing changes)."
fi

echo
echo "✓ Checking forbidden tokens..."
if $PNPM_BIN run check:tokens; then
  pass
else
  fail "Forbidden tokens found."
fi

if command -v gitleaks >/dev/null 2>&1; then
  echo
  echo "✓ Running Gitleaks (local)..."
  if gitleaks protect --staged --verbose; then
    pass
  else
    fail "Gitleaks detected potential secrets."
  fi
else
  echo
  info "Gitleaks not found. Skipping deep secret scan."
fi

echo
echo "================================================"
if [ "$FAILED" -eq 1 ]; then
  echo "❌ PRE-COMMIT CHECK FAILED"
  exit 1
fi

echo "✅ PRE-COMMIT CHECK PASSED"
