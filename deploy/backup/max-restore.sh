#!/usr/bin/env bash
# db_sh snippets are single-quoted on purpose: they expand inside the container.
# shellcheck disable=SC2016
# 5-07: restore drill and restore of the Compose `database` service.
#
#   max-restore.sh verify [DUMP]      restore into a temporary database, compare
#                                     tables with the archive, drop it; checks
#                                     that the latest backup is fresh
#   max-restore.sh restore DUMP --yes replace the working database with DUMP
#                                     after a safety dump of the current state
set -Eeuo pipefail
umask 077

# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "$0")")/lib.sh"
load_server_env

max_age_hours=${BACKUP_MAX_AGE_HOURS:-26}
read -r -a app_services <<<"${RESTORE_STOP_SERVICES-bot worker miniapp-api}"

usage() {
  sed -n '/^#   max-restore/,/^set /p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//' >&2
  exit 2
}

# Cleanup runs on any exit, including `set -e` aborts.
check_db=''
stopped_services=0
cleanup() {
  if [[ -n "$check_db" ]]; then
    db_sh "dropdb -U \"\$POSTGRES_USER\" --if-exists $check_db" || echo "drop $check_db manually" >&2
  fi
  if ((stopped_services)); then
    compose start "${app_services[@]}" || echo 'start application services manually' >&2
  fi
}
trap cleanup EXIT

check_dump() {
  local dump=$1
  [[ -f "$dump" ]] || { echo "dump not found: $dump" >&2; return 1; }
  [[ -f "$dump.sha256" ]] || { echo "checksum not found: $dump.sha256" >&2; return 1; }
  (cd "$(dirname "$dump")" && sha256_file -c "$(basename "$dump").sha256" >/dev/null) || {
    echo "checksum mismatch: $dump" >&2
    return 1
  }
}

verify() {
  local dump=${1:-} started age_hours expected actual
  started=$(date +%s)
  mkdir -p "$state_dir"
  if [[ -z "$dump" ]]; then
    dump=$(latest_backup)
    [[ -n "$dump" ]] || { echo "no backups in $backup_dir" >&2; return 1; }
    age_hours=$(( (started - $(stat -c %Y "$dump" 2>/dev/null || stat -f %m "$dump")) / 3600 ))
    if (( age_hours >= max_age_hours )); then
      echo "latest backup is ${age_hours}h old (limit ${max_age_hours}h): $dump" >&2
      return 1
    fi
  fi
  check_dump "$dump"

  container=$(db_container)
  [[ -n "$container" ]] || { echo "database container not found" >&2; return 1; }
  check_db="restore_check_$(date -u +%Y%m%d%H%M%S)"
  db_sh "createdb -U \"\$POSTGRES_USER\" $check_db"
  db_sh "pg_restore -U \"\$POSTGRES_USER\" -d $check_db --no-owner --exit-on-error" <"$dump"
  expected=$(db_sh 'pg_restore --list' <"$dump" | awk '$4 == "TABLE" && $5 != "DATA"' | wc -l | tr -d ' ')
  actual=$(db_sh "psql -U \"\$POSTGRES_USER\" -d $check_db -Atc \"select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema')\"")
  if [[ "$expected" != "$actual" ]]; then
    echo "restored $actual tables, archive has $expected" >&2
    return 1
  fi
  printf '%s %s tables=%s seconds=%s\n' "$(date -u +%Y%m%dT%H%M%SZ)" "$(basename "$dump")" \
    "$actual" "$(( $(date +%s) - started ))" | tee "$state_dir/restore-check-last-ok"
}

restore() {
  local dump=$1 stamp safety
  check_dump "$dump"
  container=$(db_container)
  [[ -n "$container" ]] || { echo "database container not found" >&2; return 1; }

  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  safety="$backup_dir/max-hackathon-pre-restore-$stamp.dump"
  mkdir -p "$backup_dir" "$state_dir"
  db_sh 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' >"$safety"
  (cd "$backup_dir" && sha256_file "$(basename "$safety")" >"$(basename "$safety").sha256")
  echo "safety dump of the current database: $safety"

  if ((${#app_services[@]})); then
    stopped_services=1
    compose stop "${app_services[@]}"
  fi
  db_sh 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --single-transaction --exit-on-error' <"$dump"
  echo "restored $(basename "$dump"); to roll back: $0 restore $safety --yes"
}

case "${1:-}" in
  verify)
    if (($# > 2)); then usage; fi
    trap 'trap - ERR; report_state restore-check "failed at line $LINENO: see journalctl -u max-hackathon-restore-check"' ERR
    verify "${2:-}"
    report_state restore-check ok
    ;;
  restore)
    if (($# != 3)) || [[ "$3" != --yes ]]; then usage; fi
    restore "$2"
    ;;
  *) usage ;;
esac
