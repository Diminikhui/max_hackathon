#!/usr/bin/env bash
# 5-07: end-to-end check of max-backup.sh and max-restore.sh against a
# disposable PostgreSQL container. Needs Docker; uses only synthetic (model) data.
set -Eeuo pipefail

here=$(dirname "$(readlink -f "$0")")
work=$(mktemp -d)
name="max-backup-test-$$"
export BACKUP_DB_CONTAINER=$name MAX_STATE_DIR=$work/state BACKUP_DIR=$work/backups
export MAX_ENV_FILES='' RESTORE_STOP_SERVICES='' MAX_ALERT_CHAT_ID=''

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
expect_fail() { if "$@"; then echo "expected failure: $*" >&2; exit 1; fi; }
psql_db() { docker exec -i "$name" psql -U model -d model_db -Atc "$1"; }

step 'start disposable postgres:17-alpine'
docker run -d --name "$name" -e POSTGRES_USER=model -e POSTGRES_DB=model_db \
  -e POSTGRES_PASSWORD=model-only postgres:17-alpine >/dev/null
for _ in $(seq 60); do
  docker exec "$name" pg_isready -U model -d model_db >/dev/null 2>&1 && break
  sleep 1
done
# pg_isready succeeds during the init restart; wait for the final server.
sleep 2
docker exec "$name" pg_isready -U model -d model_db >/dev/null

psql_db "create table model_company (id int primary key, name text not null);
  create schema model_extra; create table model_extra.model_note (id int, body text);
  insert into model_company values (1, 'Модельная компания 1'), (2, 'Модельная компания 2'), (3, 'Модельная компания 3');
  insert into model_extra.model_note values (1, 'модельная запись');" >/dev/null

step 'backup and rotation (BACKUP_KEEP=2)'
for _ in 1 2 3; do
  BACKUP_KEEP=2 "$here/max-backup.sh"
  sleep 1
done
count=$(find "$BACKUP_DIR" -name 'max-hackathon-2*.dump' | wc -l | tr -d ' ')
[[ "$count" == 2 ]] || { echo "expected 2 dumps after rotation, got $count" >&2; exit 1; }
[[ "$(cat "$MAX_STATE_DIR/backup-state")" == ok ]]
latest=$(find "$BACKUP_DIR" -name 'max-hackathon-2*.dump' | sort | tail -n 1)
[[ -f "$latest.sha256" ]]

step 'restore drill into a temporary database'
"$here/max-restore.sh" verify
grep -q 'tables=2 ' "$MAX_STATE_DIR/restore-check-last-ok"
[[ "$(cat "$MAX_STATE_DIR/restore-check-state")" == ok ]]
[[ "$(psql_db "select count(*) from pg_database where datname like 'restore_check_%'")" == 0 ]]

step 'drill fails on stale backup and on checksum mismatch'
expect_fail env BACKUP_MAX_AGE_HOURS=0 "$here/max-restore.sh" verify
[[ "$(cat "$MAX_STATE_DIR/restore-check-state")" == failed* ]]
cp "$latest.sha256" "$work/sum"
sed 's/^./0/' "$work/sum" >"$latest.sha256"
expect_fail "$here/max-restore.sh" verify
cp "$work/sum" "$latest.sha256"
"$here/max-restore.sh" verify >/dev/null
[[ "$(cat "$MAX_STATE_DIR/restore-check-state")" == ok ]]

step 'backup failure is reported'
expect_fail env BACKUP_DB_CONTAINER=missing-container "$here/max-backup.sh"
[[ "$(cat "$MAX_STATE_DIR/backup-state")" == failed* ]]

step 'restore requires --yes'
expect_fail "$here/max-restore.sh" restore "$latest" 2>/dev/null

step 'recover after data loss'
psql_db "delete from model_company where id > 1; drop table model_extra.model_note;" >/dev/null
"$here/max-restore.sh" restore "$latest" --yes
[[ "$(psql_db 'select count(*) from model_company')" == 3 ]]
[[ "$(psql_db 'select count(*) from model_extra.model_note')" == 1 ]]
safety=$(find "$BACKUP_DIR" -name 'max-hackathon-pre-restore-*.dump' | head -n 1)
[[ -n "$safety" && -f "$safety.sha256" ]]

step 'safety dump rolls the restore back'
"$here/max-restore.sh" restore "$safety" --yes >/dev/null
[[ "$(psql_db 'select count(*) from model_company')" == 1 ]]

printf '\nbackup/restore checks passed\n'
