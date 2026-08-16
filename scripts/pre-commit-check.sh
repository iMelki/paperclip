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
  if [ "$RUN_ALL" = "1" ]; then
    TYPECHECK_STATUS=0
    $PNPM_BIN -r typecheck || TYPECHECK_STATUS=$?
  else
    # Scope the typecheck to the packages the staged files actually touch, expanded to their
    # dependents via pnpm's "...<pkg>" selector so a changed type surface is still checked
    # against every consumer. A staged root build input (lockfile, workspace manifest, root
    # tsconfig) reports fullSweep and falls back to the full -r run.
    TYPECHECK_STATUS=0
    AFFECTED_JSON="$(node scripts/affected-workspace-packages.mjs --json)" || TYPECHECK_STATUS=$?
    if [ "$TYPECHECK_STATUS" != "0" ]; then
      fail "Could not resolve affected workspace packages."
    elif printf '%s' "$AFFECTED_JSON" | grep -q '"fullSweep": true'; then
      info "Full typecheck sweep: staged change touches a root build input."
      $PNPM_BIN -r typecheck || TYPECHECK_STATUS=$?
    else
      AFFECTED_PACKAGES="$(printf '%s' "$AFFECTED_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).packages||[];process.stdout.write(p.join("\n"))})')"
      if [ -z "$AFFECTED_PACKAGES" ]; then
        info "Skipping TypeScript check (staged files are outside every workspace package)."
      else
        FILTER_ARGS=""
        for PACKAGE_NAME in $AFFECTED_PACKAGES; do
          FILTER_ARGS="$FILTER_ARGS --filter ...$PACKAGE_NAME"
        done
        info "Typechecking affected packages plus dependents:$FILTER_ARGS"
        # shellcheck disable=SC2086
        $PNPM_BIN $FILTER_ARGS typecheck || TYPECHECK_STATUS=$?
      fi
    fi
  fi

  if [ "$TYPECHECK_STATUS" = "0" ]; then
    pass
  else
    fail "TypeScript check failed."
  fi
else
  info "Skipping TypeScript check (no staged TypeScript/workspace changes)."
fi

echo
echo "✓ Running unit tests..."
if [ "$RUN_ALL" = "1" ]; then
  if $PNPM_BIN run test:run; then
    pass
  else
    fail "Unit tests failed."
  fi
elif has_staged_match '^(server|ui|cli|packages|tests)/|(^|/)(package\.json|pnpm-lock\.yaml|vitest\.[^/]+|vitest\.config\.[^/]+)$|\.test\.[mc]?tsx?$|\.spec\.[mc]?tsx?$'; then
  # Run only the suites whose module graph reaches a staged file. Pre-push replaces
  # this approximate graph with exact changed/sibling suites; exhaustive Linux lanes
  # run on pull requests into dev and master.
  #
  # .github/workflows/pr.yml now covers pull requests into both long-lived branches
  # and a static policy rejects removing either trigger or adding push:dev.
  #
  # The cap is safe only with both backstops: deterministic exact pre-push suites and
  # exhaustive hosted PR CI. Set PAPERCLIP_PRECOMMIT_ALL=1 for a full local sweep.
  RELATED_SEEDS="$(printf '%s\n' "$STAGED_FILES" | grep -E '\.([mc]?[jt]sx?|json)$' || true)"
  if [ -z "$RELATED_SEEDS" ]; then
    info "Skipping unit tests (no staged JavaScript/TypeScript sources)."
  else
    info "Running suites related to staged source files."
    # Mirrors the `test:run` script: the workspace-link preflight has to run before vitest,
    # then the stable runner supplies the isolated PAPERCLIP_HOME/TMPDIR sandbox.
    RELATED_STATUS=0
    $PNPM_BIN run preflight:workspace-links || RELATED_STATUS=$?
    if [ "$RELATED_STATUS" != "0" ]; then
      fail "Workspace link preflight failed."
    else
      # shellcheck disable=SC2086
      if node scripts/run-vitest-stable.mjs --related $RELATED_SEEDS; then
        pass
      else
        fail "Unit tests failed."
      fi
    fi
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

echo
echo "✓ Running pinned Gitleaks staged scan..."
if node scripts/verify-gitleaks.mjs --staged; then
  pass
else
  fail "Pinned Gitleaks scan failed or detected potential secrets."
fi

echo
echo "================================================"
if [ "$FAILED" -eq 1 ]; then
  echo "❌ PRE-COMMIT CHECK FAILED"
  exit 1
fi

echo "✅ PRE-COMMIT CHECK PASSED"
