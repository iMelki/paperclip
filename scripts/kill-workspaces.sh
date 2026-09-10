#!/usr/bin/env bash
#
# Inspect and clean local Paperclip workspace runtime service registrations.
#
# Persisted PID and process-group numbers are observation-only: without a live
# child handle or OS-stable process birth identity this script never sends a
# signal. Numeric PID/PGID absence is not a kernel tree-exit receipt because
# detached descendants and identifier reuse remain possible, so V1 records are
# retained for human review. Use scripts/kill-dev.sh for Paperclip server
# processes.
#
# Usage:
#   scripts/kill-workspaces.sh        # remove proven-stale registrations
#   scripts/kill-workspaces.sh --dry  # preview without removing anything
#

set -euo pipefail
shopt -s nullglob

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry|--dry-run|-n)
      DRY_RUN=true
      ;;
    --help|-h)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: scripts/kill-workspaces.sh [--dry]" >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_PARENT="$(dirname "$REPO_ROOT")"

expand_home() {
  local value="$1"
  if [[ "$value" == "~" ]]; then
    printf '%s\n' "$HOME"
  elif [[ "$value" == "~/"* ]]; then
    printf '%s\n' "$HOME/${value#"~/"}"
  else
    printf '%s\n' "$value"
  fi
}

runtime_dirs=()
runtime_scan_error_dirs=()
declare -A seen_runtime_dirs=()

append_runtime_dir() {
  local dir="$1"
  [[ -e "$dir" ]] || return 0
  if [[ ! -d "$dir" ]]; then
    runtime_scan_error_dirs+=("$dir")
    return 0
  fi
  local resolved_dir
  if ! resolved_dir="$(cd "$dir" && pwd)"; then
    runtime_scan_error_dirs+=("$dir")
    return 0
  fi
  dir="$resolved_dir"
  if [[ -z "${seen_runtime_dirs[$dir]:-}" ]]; then
    seen_runtime_dirs["$dir"]=1
    runtime_dirs+=("$dir")
  fi
}

paperclip_home="$(expand_home "${PAPERCLIP_HOME:-$HOME/.paperclip}")"
paperclip_instance_id="${PAPERCLIP_INSTANCE_ID:-default}"
append_runtime_dir "$paperclip_home/instances/$paperclip_instance_id/runtime-services"

if [[ "${PAPERCLIP_KILL_WORKSPACES_ONLY_CURRENT:-}" != "1" ]]; then
  for dir in \
    "$HOME"/.paperclip/instances/*/runtime-services \
    "$HOME"/.paperclip-worktrees/instances/*/runtime-services \
    "$REPO_ROOT"/.paperclip/instances/*/runtime-services \
    "$REPO_ROOT"/.paperclip/runtime-services/instances/*/runtime-services
  do
    append_runtime_dir "$dir"
  done

  for sibling_root in "$REPO_PARENT"/paperclip*; do
    [[ -d "$sibling_root" ]] || continue
    for dir in \
      "$sibling_root"/.paperclip/instances/*/runtime-services \
      "$sibling_root"/.paperclip/runtime-services/instances/*/runtime-services
    do
      append_runtime_dir "$dir"
    done
  done
fi

record_lines=()
if [[ ${#runtime_dirs[@]} -gt 0 || ${#runtime_scan_error_dirs[@]} -gt 0 ]]; then
  node_bin="${PAPERCLIP_KILL_WORKSPACES_NODE_BIN:-node}"
  scanner_output=""
  if ! scanner_output="$("$node_bin" - "${runtime_dirs[@]}" "${runtime_scan_error_dirs[@]}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

function clean(value) {
  return String(value ?? "").replace(/[\x1f\t\r\n]+/g, " ");
}

function probePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "unproven";
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    return error && error.code === "ESRCH" ? "dead" : "unproven";
  }
}

function probeProcessGroup(processGroupId) {
  // Windows has no POSIX process-group probe. A persisted group identifier may
  // be null while descendants survive a dead wrapper, so no group shape proves
  // tree absence without Job Object evidence.
  if (process.platform === "win32") return "unproven";
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return "unproven";
  if (processGroupId === 1) return "unproven";
  try {
    process.kill(-processGroupId, 0);
    return "live";
  } catch {
    // Numeric group absence is advisory only. It cannot prove that detached
    // descendants exited, nor bind a future observation to the original group.
    return "unproven";
  }
}

function emitInvalidRegistry(filePath, fileName) {
  console.log([
    filePath,
    fileName.endsWith(".json") ? fileName.slice(0, -".json".length) : fileName,
    "invalid-registry",
    "",
    "",
    "",
    "",
    "",
    "",
    "unproven",
    "unproven",
  ].map(clean).join("\x1f"));
}

for (const dir of process.argv.slice(2)) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      emitInvalidRegistry(path.resolve(dir, "registry-scan-unreadable.json"), "registry-scan-unreadable.json");
    }
    continue;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.resolve(dir, entry.name);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      emitInvalidRegistry(filePath, entry.name);
      continue;
    }
    const expectedServiceKey = entry.name.slice(0, -".json".length);
    const validProcessGroup = record?.processGroupId == null
      || (
        Number.isInteger(record.processGroupId)
        && record.processGroupId > 0
        && record.processGroupId <= 0x7fffffff
      );
    const validSchema = record
      && record.version === 1
      && record.serviceKey === expectedServiceKey
      && typeof record.profileKind === "string"
      && record.profileKind.trim().length > 0
      && typeof record.serviceName === "string"
      && record.serviceName.trim().length > 0
      && typeof record.command === "string"
      && record.command.trim().length > 0
      && typeof record.cwd === "string"
      && record.cwd.trim().length > 0
      && typeof record.envFingerprint === "string"
      && typeof record.startedAt === "string"
      && !Number.isNaN(Date.parse(record.startedAt))
      && typeof record.lastSeenAt === "string"
      && !Number.isNaN(Date.parse(record.lastSeenAt))
      && Number.isInteger(record.pid)
      && record.pid > 0
      && record.pid <= 0x7fffffff
      && validProcessGroup;
    if (!validSchema) {
      emitInvalidRegistry(filePath, entry.name);
      continue;
    }
    // Other fully valid local-service profiles are owned by their own command.
    if (record.profileKind !== "workspace-runtime") continue;

    const pid = Number.isInteger(record.pid) && record.pid > 0 ? record.pid : null;
    const processGroupId =
      Number.isInteger(record.processGroupId) && record.processGroupId > 0
        ? record.processGroupId
        : null;

    console.log([
      filePath,
      record.serviceKey,
      record.serviceName,
      pid,
      processGroupId,
      Number.isInteger(record.port) && record.port > 0 ? record.port : "",
      record.cwd,
      record.url,
      record.runtimeServiceId,
      probePid(pid),
      probeProcessGroup(processGroupId),
    ].map(clean).join("\x1f"));
  }
}
NODE
)"; then
    echo "Needs human review: the workspace registry scanner failed; registry state is unknown." >&2
    echo "No signal was sent and no registry record was removed." >&2
    exit 3
  fi
  if [[ -n "$scanner_output" ]]; then
    mapfile -t record_lines <<< "$scanner_output"
  fi
fi

active_files=()
stale_files=()
display_lines=()

for line in "${record_lines[@]}"; do
  IFS=$'\x1f' read -r file service_key service_name pid pgid port cwd url runtime_service_id pid_state group_state <<< "$line"

  evidence_type=""
  evidence_id=""
  if [[ "$group_state" == "live" ]]; then
    evidence_type="group"
    evidence_id="$pgid"
  elif [[ "$pid_state" == "live" ]]; then
    evidence_type="pid"
    evidence_id="$pid"
  elif [[ "$group_state" == "unproven" ]]; then
    evidence_type="group-unproven"
    evidence_id="${pgid:-unknown}"
  elif [[ "$pid_state" == "unproven" ]]; then
    evidence_type="pid-unproven"
    evidence_id="${pid:-unknown}"
  fi

  active_files+=("$file")
  short_file="${file/#$HOME\//}"
  short_cwd="${cwd/#$HOME\//}"
  evidence_label="${evidence_type:-unproven}:${evidence_id:-unknown}"
  display_lines+=("$(printf "  %-24s pid %-7s evidence %-20s port %-6s cwd %-45s registry %s" \
    "${service_name:-workspace-runtime}" "${pid:-"-"}" "$evidence_label" "${port:-"-"}" "${short_cwd:-"-"}" "$short_file")")
  if [[ -n "${url:-}" ]]; then
    display_lines+=("$(printf "  %-24s url %s" "" "$url")")
  fi
  if [[ -n "${runtime_service_id:-}" ]]; then
    display_lines+=("$(printf "  %-24s runtimeServiceId %s" "" "$runtime_service_id")")
  fi
  if [[ -n "${service_key:-}" ]]; then
    display_lines+=("$(printf "  %-24s serviceKey %s" "" "$service_key")")
  fi
done

if [[ ${#active_files[@]} -eq 0 && ${#stale_files[@]} -eq 0 ]]; then
  echo "No Paperclip workspace runtime services found."
  exit 0
fi

if [[ ${#active_files[@]} -gt 0 ]]; then
  echo "Found ${#active_files[@]} Paperclip workspace runtime service record(s):"
  echo ""
  printf '%s\n' "${display_lines[@]}"
  echo ""
  echo "Needs human review: live or unproven persisted PID/process-group evidence is observation-only without a live child handle or OS-stable birth identity." >&2
  echo "No signal was sent and ${#active_files[@]} active registry record(s) will be retained." >&2
  echo "" >&2
fi

if [[ ${#stale_files[@]} -gt 0 ]]; then
  echo "Found ${#stale_files[@]} stale workspace runtime service registry record(s)."
  if [[ "$DRY_RUN" == true ]]; then
    stale_preview_limit=20
    stale_preview_count=0
    for file in "${stale_files[@]}"; do
      if (( stale_preview_count >= stale_preview_limit )); then
        remaining=$(( ${#stale_files[@]} - stale_preview_count ))
        echo "  ... ${remaining} more stale record(s)"
        break
      fi
      echo "  stale ${file/#$HOME\//}"
      ((stale_preview_count += 1))
    done
  fi
  echo ""
fi

if [[ "$DRY_RUN" == true ]]; then
  echo "Dry run — no signals are ever sent; re-run without --dry to remove proven-stale registry records only."
  if [[ ${#active_files[@]} -gt 0 ]]; then
    exit 2
  fi
  exit 0
fi

if [[ ${#stale_files[@]} -gt 0 ]]; then
  echo "Removing proven-stale workspace runtime service registry records..."
  for file in "${stale_files[@]:-}"; do
    [[ -n "$file" ]] || continue
    rm -f "$file"
    echo "  removed ${file/#$HOME\//}"
  done
fi

if [[ ${#active_files[@]} -gt 0 ]]; then
  exit 2
fi

echo "Done."
