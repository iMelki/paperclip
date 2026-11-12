#!/usr/bin/env bash
# The "Clean up leftover e2e server and temp home" step body from pr.yml and
# e2e.yml at d07bd93d (#184), kept only so e2e-owned-cleanup.test.mjs can show
# that its regression tests fail against the old logic
# (E2E_CLEANUP_IMPL=legacy). Never call this from a workflow.
#
# The selection logic is verbatim. Four changes make it safe to run on a shared
# box, and none of them changes which targets it picks:
#   - port 3199 is ${LEGACY_PORT}, so the test never needs the real e2e port;
#   - /tmp is ${LEGACY_SYSTEM_TMP}, a fixture dir standing in for /tmp;
#   - kill "$pid" is sandbox_kill "$pid", which only signals PIDs the test
#     spawned (SANDBOX_KILLABLE) and logs every other pick as WOULD_KILL;
#   - rm -rf runs through sandbox_rm, which only removes paths inside the
#     test's fixture root (SANDBOX_ROOT) and logs every other pick.
sandbox_kill() {
  case " ${SANDBOX_KILLABLE:-} " in
    *" $1 "*) kill "$1" ;;
    *) echo "WOULD_KILL $1" >> "${SANDBOX_LOG:-/dev/null}"; return 0 ;;
  esac
}
sandbox_rm() {
  local root f
  root="$(realpath -e "$SANDBOX_ROOT")"
  for f in "$@"; do
    case "$(realpath -m "$f")" in
      "$root"/*) rm -rf "$f" ;;
      *) echo "WOULD_RM $f" >> "${SANDBOX_LOG:-/dev/null}" ;;
    esac
  done
}
export -f sandbox_rm

          uid="$(id -u)"
          pids=""
          for pattern in '[p]aperclipai onboard' '[p]aperclip-e2e-home-'; do
            pids="$pids $(pgrep -u "$uid" -f "$pattern" || true)"
          done
          if command -v lsof >/dev/null 2>&1; then
            pids="$pids $(lsof -t -a -u "$uid" -iTCP:"${LEGACY_PORT}" -sTCP:LISTEN 2>/dev/null || true)"
          elif command -v ss >/dev/null 2>&1; then
            pids="$pids $(ss -Htlnp "sport = :${LEGACY_PORT}" 2>/dev/null | grep -oE ',pid=[0-9]+,fd=' | grep -oE '[0-9]+' || true)"
          fi
          for pid in $(printf '%s\n' $pids | sort -un); do
            [ "$pid" = "$$" ] && continue
            [ "$(stat -c %u "/proc/$pid" 2>/dev/null)" = "$uid" ] || continue
            echo "killing leftover e2e pid $pid"
            sandbox_kill "$pid" 2>/dev/null || true
          done
          for dir in "${RUNNER_TEMP:-}" "${LEGACY_SYSTEM_TMP}"; do
            [ -n "$dir" ] && [ -d "$dir" ] || continue
            find "$dir" -maxdepth 1 -user "$uid" -name 'paperclip-e2e-home-*' \
              -exec bash -c 'sandbox_rm "$@"' _ {} + 2>/dev/null || true
          done
          echo "e2e cleanup done"
