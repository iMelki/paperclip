#!/usr/bin/env bash
# Owned e2e home and process cleanup for the Playwright lane (pr.yml e2e_shards
# and e2e.yml). It replaces the inline cleanup step from #184, which picked kill
# targets by user plus command pattern and by any listener on port 3199, and
# rm -rf'd every paperclip-e2e-home-* in RUNNER_TEMP and /tmp. On a shared
# runner box that could kill or delete another concurrent job's work.
#
# This script only touches what this job created:
#   prepare  Create the one canonical per-run home dir under RUNNER_TEMP and
#            write an identity marker (run id, attempt, job, suffix, token).
#   run      Run a command in a new session with PAPERCLIP_E2E_HOME pointed at
#            that dir (tests/e2e/playwright.config.ts uses it as PAPERCLIP_HOME)
#            and PAPERCLIP_E2E_OWNER_TOKEN in its environment, recording the
#            session leader PID and its start time (field 22 of
#            /proc/<pid>/stat). TMPDIR is left alone: tools put unix sockets
#            under it, and a longer TMPDIR overflows the 107-byte socket path
#            limit (tsx's IPC pipe did).
#   cleanup  Kill only processes this job started, then delete only that dir.
#
# A process counts as owned only if it runs as this user, started no earlier
# than the recorded leader, and either carries this run's owner token in its
# environment or belongs to the recorded session while the leader PID still
# has its recorded start time. The PID and start time are re-checked right
# before each kill, so a reused PID is never signalled. No pkill, no fuser,
# no port lookups, no /tmp scan. cleanup is best effort and always exits 0.
#
# Inputs (env): RUNNER_TEMP, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_JOB,
# optional PAPERCLIP_E2E_OWNER_SUFFIX (e.g. the matrix shard index), and
# optional PAPERCLIP_E2E_CLEANUP_GRACE_SECONDS (default 10).
set -euo pipefail

MARKER_NAME=".paperclip-e2e-owner"
SESSION_NAME=".paperclip-e2e-session"

log() { printf 'e2e-owned-cleanup: %s\n' "$*" >&2; }

valid_part() { [[ "$1" =~ ^[A-Za-z0-9_.-]+$ ]]; }

# Prints the canonical dir path, or fails when an input is missing or unsafe.
canonical_dir() {
  local run_id="${GITHUB_RUN_ID:-}" attempt="${GITHUB_RUN_ATTEMPT:-}" job="${GITHUB_JOB:-}"
  local suffix="${PAPERCLIP_E2E_OWNER_SUFFIX:-}" temp="${RUNNER_TEMP:-}"
  if [ -z "$temp" ] || [ ! -d "$temp" ]; then log "RUNNER_TEMP is unset or missing"; return 1; fi
  local part
  for part in "$run_id" "$attempt" "$job"; do
    valid_part "$part" || { log "GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT and GITHUB_JOB must be set to [A-Za-z0-9_.-]+"; return 1; }
  done
  if [ -n "$suffix" ] && ! valid_part "$suffix"; then log "PAPERCLIP_E2E_OWNER_SUFFIX must match [A-Za-z0-9_.-]+"; return 1; fi
  local name="paperclip-e2e-home-${run_id}-${attempt}-${job}${suffix:+-$suffix}"
  printf '%s/%s\n' "${temp%/}" "$name"
}

expected_marker() {
  printf 'run_id=%s\nrun_attempt=%s\njob=%s\nsuffix=%s\n' \
    "${GITHUB_RUN_ID}" "${GITHUB_RUN_ATTEMPT}" "${GITHUB_JOB}" "${PAPERCLIP_E2E_OWNER_SUFFIX:-}"
}

# Validates that $1 is the canonical dir, really inside RUNNER_TEMP, owned by
# this user, and carries a marker for this exact run, attempt, job and suffix.
verify_owned_dir() {
  local dir="$1" uid real_dir real_temp marker
  uid="$(id -u)"
  if [ -L "$dir" ] || [ ! -d "$dir" ]; then log "no owned dir at $dir"; return 1; fi
  real_dir="$(realpath -e -- "$dir")" || return 1
  real_temp="$(realpath -e -- "$RUNNER_TEMP")" || return 1
  if [ "$(dirname -- "$real_dir")" != "$real_temp" ] || [ "$(basename -- "$real_dir")" != "$(basename -- "$dir")" ]; then
    log "refusing $dir: not directly inside RUNNER_TEMP"; return 1
  fi
  if [ "$(stat -c %u -- "$real_dir")" != "$uid" ]; then log "refusing $dir: not owned by this user"; return 1; fi
  marker="$real_dir/$MARKER_NAME"
  if [ -L "$marker" ] || [ ! -f "$marker" ] || [ "$(stat -c %u -- "$marker")" != "$uid" ]; then
    log "refusing $dir: identity marker missing"; return 1
  fi
  if [ "$(grep -v '^token=' -- "$marker")" != "$(expected_marker)" ]; then
    log "refusing $dir: identity marker is for another run or job"; return 1
  fi
  printf '%s\n' "$real_dir"
}

marker_token() { sed -n 's/^token=\([0-9a-f]\{32\}\)$/\1/p' -- "$1/$MARKER_NAME"; }

# Field 22 (starttime) and field 6 (session id) of /proc/<pid>/stat. The comm
# field can hold spaces and parens, so split after the last ") ".
proc_field() {
  local pid="$1" index="$2" stat rest
  stat="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 1
  rest="${stat##*) }"
  # rest starts at field 3, so field N is word N-2.
  # shellcheck disable=SC2086
  set -- $rest
  local n=$((index - 2))
  [ "$n" -ge 1 ] && [ "$n" -le "$#" ] || return 1
  printf '%s\n' "${!n}"
}
proc_start() { proc_field "$1" 22; }
proc_sid() { proc_field "$1" 6; }
proc_uid() { stat -c %u "/proc/$1" 2>/dev/null; }

has_token() {
  local pid="$1" token="$2"
  [ -r "/proc/$pid/environ" ] || return 1
  tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qxF "PAPERCLIP_E2E_OWNER_TOKEN=$token"
}

cmd_prepare() {
  local dir token
  dir="$(canonical_dir)"
  if [ -e "$dir" ] || [ -L "$dir" ]; then log "refusing to reuse existing $dir"; exit 1; fi
  mkdir -m 700 -- "$dir"
  token="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
  { expected_marker; printf 'token=%s\n' "$token"; } > "$dir/$MARKER_NAME"
  log "prepared $dir"
  printf '%s\n' "$dir"
}

cmd_run() {
  [ "${1:-}" = "--" ] && shift
  [ "$#" -gt 0 ] || { log "usage: run -- <command...>"; exit 2; }
  local dir real_dir token
  dir="$(canonical_dir)"
  real_dir="$(verify_owned_dir "$dir")" || { log "run prepare first"; exit 1; }
  token="$(marker_token "$real_dir")"
  [ -n "$token" ] || { log "marker has no token"; exit 1; }
  # setsid -w waits for the session leader and returns its exit status.
  exec setsid -w "$0" __session "$real_dir" "$token" "$@"
}

cmd_session() {
  local dir="$1" token="$2"; shift 2
  local start
  start="$(proc_start "$$")"
  if [ "$(proc_sid "$$")" != "$$" ]; then log "not a session leader"; exit 1; fi
  printf '%s %s\n' "$$" "$start" > "$dir/$SESSION_NAME"
  export PAPERCLIP_E2E_HOME="$dir" PAPERCLIP_E2E_OWNER_TOKEN="$token"
  exec "$@"
}

# Lists "pid start" for every process this job owns, never this shell.
owned_processes() {
  local token="$1" leader="$2" leader_start="$3" uid entry pid start leader_ok=0
  uid="$(id -u)"
  if [ "$(proc_start "$leader" 2>/dev/null || true)" = "$leader_start" ]; then leader_ok=1; fi
  for entry in /proc/[0-9]*; do
    pid="${entry#/proc/}"
    if [ "$pid" = "$$" ] || [ "$pid" = "$BASHPID" ]; then continue; fi
    [ "$(proc_uid "$pid")" = "$uid" ] || continue
    start="$(proc_start "$pid")" || continue
    [ "$start" -ge "$leader_start" ] || continue
    if has_token "$pid" "$token"; then
      printf '%s %s\n' "$pid" "$start"
    elif [ "$leader_ok" = 1 ] && [ "$(proc_sid "$pid")" = "$leader" ]; then
      printf '%s %s\n' "$pid" "$start"
    fi
  done
}

signal_if_same() {
  local sig="$1" pid="$2" start="$3"
  [ "$(proc_start "$pid" 2>/dev/null || true)" = "$start" ] || return 1
  log "kill -$sig $pid (start $start)"
  kill "-$sig" "$pid" 2>/dev/null || true
}

cmd_cleanup() {
  # This shell must never look owned to itself.
  unset PAPERCLIP_E2E_OWNER_TOKEN
  local dir real_dir token leader leader_start grace
  dir="$(canonical_dir)" || { log "nothing to clean"; return 0; }
  real_dir="$(verify_owned_dir "$dir")" || { log "nothing to clean"; return 0; }
  token="$(marker_token "$real_dir")"
  if [ -n "$token" ] && [ -f "$real_dir/$SESSION_NAME" ] && [ ! -L "$real_dir/$SESSION_NAME" ]; then
    read -r leader leader_start < "$real_dir/$SESSION_NAME" || true
    if [[ "${leader:-}" =~ ^[0-9]+$ ]] && [[ "${leader_start:-}" =~ ^[0-9]+$ ]]; then
      local owned pid start
      owned="$(owned_processes "$token" "$leader" "$leader_start")"
      while read -r pid start; do
        [ -n "$pid" ] && signal_if_same TERM "$pid" "$start"
      done <<< "$owned"
      grace="${PAPERCLIP_E2E_CLEANUP_GRACE_SECONDS:-10}"
      [[ "$grace" =~ ^[0-9]+$ ]] || grace=10
      local i alive
      for ((i = 0; i < grace * 10; i++)); do
        alive=0
        while read -r pid start; do
          [ -n "$pid" ] && [ "$(proc_start "$pid" 2>/dev/null || true)" = "$start" ] && alive=1
        done <<< "$owned"
        [ "$alive" = 0 ] && break
        sleep 0.1
      done
      while read -r pid start; do
        [ -n "$pid" ] && signal_if_same KILL "$pid" "$start"
      done <<< "$owned"
    else
      log "session record is malformed; killing nothing"
    fi
  else
    log "no session record; killing nothing"
  fi
  rm -rf -- "$real_dir"
  log "removed $real_dir"
}

case "${1:-}" in
  prepare) shift; cmd_prepare "$@" ;;
  run) shift; cmd_run "$@" ;;
  __session) shift; cmd_session "$@" ;;
  cleanup) shift; cmd_cleanup "$@" || true; exit 0 ;;
  *) log "usage: $0 prepare | run -- <command...> | cleanup"; exit 2 ;;
esac
