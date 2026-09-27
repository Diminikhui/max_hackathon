# shellcheck shell=bash
# Shared helpers for max-backup.sh and max-restore.sh (5-07). Sourced, not executed.
# All paths can be overridden for local checks; see docs/operations/backup-restore.md.

state_dir=${MAX_STATE_DIR:-/var/lib/max-hackathon}
backup_dir=${BACKUP_DIR:-$state_dir/backups}
repo=${MAX_REPO_DIR:-/srv/max-hackathon/repo}
compose_env=${MAX_COMPOSE_ENV:-/etc/max-hackathon/compose.env}

# Server env files exist only on the VPS and are never committed.
load_server_env() {
  local file
  set -a
  for file in ${MAX_ENV_FILES-/etc/max-hackathon/bot.env /etc/max-hackathon/monitor.env /etc/max-hackathon/backup.env}; do
    # shellcheck disable=SC1090
    [[ -r "$file" ]] && source "$file"
  done
  set +a
}

compose() {
  (cd "$repo" && docker compose --env-file "$compose_env" "$@")
}

# BACKUP_DB_CONTAINER targets a container directly (local checks); otherwise the
# Compose service `database` is used.
db_container() {
  if [[ -n "${BACKUP_DB_CONTAINER:-}" ]]; then
    printf '%s\n' "$BACKUP_DB_CONTAINER"
  else
    compose ps -q database
  fi
}

# Runs a shell snippet inside the database container. POSTGRES_USER and
# POSTGRES_DB come from the container environment, so no password is handled here.
# `container` is set by the caller after db_container.
db_sh() {
  # shellcheck disable=SC2154
  docker exec -i "$container" sh -c "$1"
}

sha256_file() {
  if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

latest_backup() {
  find "$backup_dir" -maxdepth 1 -type f -name 'max-hackathon-2*.dump' | sort | tail -n 1
}

send_alert() {
  local message=$1 payload
  if [[ -z "${MAX_ALERT_CHAT_ID:-}" || -z "${MAX_BOT_TOKEN:-}" ]]; then
    echo 'MAX alert recipient is not configured.' >&2
    return 0
  fi
  payload=$(python3 -c 'import json,sys; print(json.dumps({"text":sys.argv[1]}, ensure_ascii=False))' "$message")
  printf 'header = "Authorization: %s"\n' "$MAX_BOT_TOKEN" | \
    curl --config - --fail --silent --show-error --max-time 15 \
      --cacert "$MAX_CA_CERT_PATH" \
      --header 'Content-Type: application/json' \
      --data-binary "$payload" \
      --output /dev/null \
      "$MAX_API_BASE_URL/messages?chat_id=$MAX_ALERT_CHAT_ID"
}

# Stores the job state and alerts only on change: every failure that follows a
# success (or the very first failure) and every recovery. Repeated identical
# states do not produce repeated messages.
report_state() {
  local job=$1 new_state=$2 file old_state
  file="$state_dir/$job-state"
  old_state=$(cat "$file" 2>/dev/null || true)
  mkdir -p "$state_dir"
  printf '%s\n' "$new_state" >"$file.tmp"
  mv "$file.tmp" "$file"
  if [[ "$new_state" != "$old_state" && ( -n "$old_state" || "$new_state" != ok ) ]]; then
    send_alert "5-07 $job $(hostname): $new_state" || echo 'MAX alert delivery failed' >&2
  fi
}
