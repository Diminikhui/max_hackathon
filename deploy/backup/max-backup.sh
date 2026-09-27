#!/usr/bin/env bash
# db_sh snippets are single-quoted on purpose: they expand inside the container.
# shellcheck disable=SC2016
# 5-07: daily PostgreSQL backup of the Compose `database` service.
# Writes a custom-format dump, checks that pg_restore can read it, stores a
# SHA-256 checksum, keeps the newest BACKUP_KEEP dumps and alerts on failure.
set -Eeuo pipefail
umask 077

# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "$0")")/lib.sh"
load_server_env

keep=${BACKUP_KEEP:-7}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="max-hackathon-$stamp.dump"
tmp="$backup_dir/.$name.partial"

fail() {
  echo "backup failed: $1" >&2
  report_state backup "failed: $1"
  exit 1
}
trap 'rm -f "$tmp"' EXIT
trap 'fail "command failed at line $LINENO"' ERR

[[ "$keep" =~ ^[1-9][0-9]*$ ]] || fail "BACKUP_KEEP must be a positive integer"
mkdir -p "$backup_dir" "$state_dir"
container=$(db_container) || true
[[ -n "$container" ]] || fail "database container not found"

db_sh 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' >"$tmp"
[[ -s "$tmp" ]] || fail "empty dump"
db_sh 'pg_restore --list' <"$tmp" >/dev/null || fail "dump is not readable by pg_restore"

mv "$tmp" "$backup_dir/$name"
(cd "$backup_dir" && sha256_file "$name" >"$name.sha256")

find "$backup_dir" -maxdepth 1 -type f -name 'max-hackathon-2*.dump' | sort -r | \
  tail -n +"$((keep + 1))" | while read -r old; do
    rm -f "$old" "$old.sha256"
  done

size=$(wc -c <"$backup_dir/$name" | tr -d ' ')
printf '%s %s %s\n' "$stamp" "$name" "$size" >"$state_dir/backup-last-ok"
report_state backup ok
echo "backup ok: $backup_dir/$name ($size bytes)"
