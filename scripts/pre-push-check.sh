#!/usr/bin/env sh
# Paperclip pre-push gate: deterministic changed-workspace verification.
#
# Git's four-field pre-push update stream is captured before any child can
# consume stdin. A canonical Node planner resolves every outgoing commit/path,
# maps exact suites to their real runner, and fails closed on missing coverage.
# Hosted-only changes may be pushed to a topic branch for PR validation but may
# not be pushed directly to dev or master.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT" || exit 1

REMOTE_NAME=${1-}
REMOTE_LOCATION=${2-}
if [ -z "$REMOTE_NAME" ]; then
  echo "FAIL: the pre-push hook did not supply a remote name." >&2
  exit 2
fi
if [ -z "$REMOTE_LOCATION" ]; then
  echo "FAIL: the pre-push hook did not supply a remote location." >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node was not found on PATH." >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "FAIL: pnpm was not found on PATH." >&2
  exit 1
fi

NODE_BIN=node
PNPM_BIN=pnpm
GIT_LOG_PATH=$(git rev-parse --git-path paperclip-gate-logs/pre-push) || exit 2
case "$GIT_LOG_PATH" in
  /* | [A-Za-z]:/*) LOG_DIR="$GIT_LOG_PATH" ;;
  *) LOG_DIR="$REPO_ROOT/$GIT_LOG_PATH" ;;
esac
DEFAULT_LOG_FILE="$LOG_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
LOG_FILE=${PAPERCLIP_PRE_PUSH_LOG_PATH:-$DEFAULT_LOG_FILE}
mkdir -p "$(dirname -- "$LOG_FILE")" || exit 1
UPDATES_FILE="${LOG_FILE}.updates"

cleanup() {
  CLEANUP_STATUS=$?
  trap - 0 HUP INT TERM
  rm -f "$UPDATES_FILE" || :
  if [ -n "${STEP_LOG-}" ]; then
    rm -f "$STEP_LOG" || :
  fi
  exit "$CLEANUP_STATUS"
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

cat > "$UPDATES_FILE" || exit 2
if [ ! -s "$UPDATES_FILE" ]; then
  echo "FAIL: Git supplied no pre-push ref updates on stdin." >&2
  exit 2
fi

FAILED=0
STEP_INDEX=0
START_EPOCH=$(date +%s)

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  printf 'FAIL: %s\n' "$1" >> "$LOG_FILE"
  FAILED=1
}

pass() {
  echo "PASS"
  echo "PASS" >> "$LOG_FILE"
}

run_step() {
  NAME="$1"; MESSAGE="$2"; shift 2
  echo
  echo "Running $NAME..."
  echo "Running $NAME..." >> "$LOG_FILE"
  STEP_START=$(date +%s)
  STEP_INDEX=$((STEP_INDEX + 1))
  STEP_LOG="${LOG_FILE}.step-${STEP_INDEX}"
  "$@" > "$STEP_LOG" 2>&1
  STEP_STATUS=$?
  cat "$STEP_LOG"
  cat "$STEP_LOG" >> "$LOG_FILE"
  rm -f "$STEP_LOG" || :
  STEP_LOG=
  STEP_ELAPSED=$(( $(date +%s) - STEP_START ))
  if [ "$STEP_STATUS" -eq 0 ]; then
    echo "  ($NAME took ${STEP_ELAPSED}s)"
    echo "  ($NAME took ${STEP_ELAPSED}s)" >> "$LOG_FILE"
    pass
  else
    echo "  ($NAME took ${STEP_ELAPSED}s, exit $STEP_STATUS)"
    echo "  ($NAME took ${STEP_ELAPSED}s, exit $STEP_STATUS)" >> "$LOG_FILE"
    fail "$MESSAGE"
  fi
}

{
  echo "Paperclip - Pre-Push Check (deterministic changed-workspace tier)"
  echo "Started $(date -u +%Y-%m-%dT%H:%M:%SZ)."
  echo "Exact local suites plus hosted dev PR CI replace uncapped import-graph selection."
} | tee -a "$LOG_FILE"
echo "Full gate output: $LOG_FILE"

run_step "adapter/runtime no-git-push policy" \
  "Adapter/runtime git-push policy failed or could not scan its full subject." \
  "$NODE_BIN" scripts/check-no-git-push.mjs

[ "$FAILED" -eq 0 ] && run_step "PR workflow trigger policy" \
  "PR workflow must cover master and dev without a push:dev trigger." \
  "$NODE_BIN" scripts/check-pr-workflow-trigger.mjs

[ "$FAILED" -eq 0 ] && run_step "outgoing commit secret scan" \
  "An outgoing commit contains a secret or its exact scan failed." \
  "$NODE_BIN" scripts/scan-pre-push-secrets.mjs \
  --repo-root "$REPO_ROOT" \
  --remote-name "$REMOTE_NAME" \
  --remote-location "$REMOTE_LOCATION" \
  --updates-file "$UPDATES_FILE"

[ "$FAILED" -eq 0 ] && run_step "workspace link preflight" \
  "Workspace link preflight failed." "$PNPM_BIN" run preflight:workspace-links

[ "$FAILED" -eq 0 ] && run_step "forbidden token check" \
  "Forbidden tokens found." "$PNPM_BIN" run check:tokens

[ "$FAILED" -eq 0 ] && run_step "full TypeScript check (pnpm -r typecheck)" \
  "TypeScript check failed." "$PNPM_BIN" -r typecheck

[ "$FAILED" -eq 0 ] && run_step "deterministic exact test plan" \
  "Exact test selection, hosted-CI policy, or a selected test failed." \
  "$NODE_BIN" scripts/run-pre-push-tests.mjs \
  --repo-root "$REPO_ROOT" \
  --remote-name "$REMOTE_NAME" \
  --remote-location "$REMOTE_LOCATION" \
  --updates-file "$UPDATES_FILE"

TOTAL_MIN=$(( ( $(date +%s) - START_EPOCH ) / 60 ))
echo
echo "=================================================================="
if [ "$FAILED" -ne 0 ]; then
  echo "PRE-PUSH CHECK FAILED after ${TOTAL_MIN} min"
  echo "The push was rejected. Fix the named failure before retrying."
  exit 1
fi

echo "PRE-PUSH CHECK PASSED in ${TOTAL_MIN} min"
exit 0
