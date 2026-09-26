#!/usr/bin/env bash
set -Eeuo pipefail

repo=/srv/max-hackathon/repo
state_dir=/var/lib/max-hackathon
host=135.106.227.207
set -a
# Files exist only on the VPS and are never committed.
source /etc/max-hackathon/bot.env
source /etc/max-hackathon/monitor.env
set +a
cd "$repo"
mkdir -p "$state_dir"

send_alert() {
  local message=$1 payload
  if [[ -z "${MAX_ALERT_CHAT_ID:-}" ]]; then
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

if [[ "${1:-}" == --test-alert ]]; then
  send_alert 'Тест K-08: мониторинг VPS и отправка оповещений работают.'
  exit
fi

failures=()
if ! curl --fail --silent --max-time 8 --output /dev/null "https://$host/"; then
  failures+=(https)
fi
if ! openssl x509 -in "/etc/letsencrypt/live/$host/fullchain.pem" \
  -checkend 172800 -noout >/dev/null 2>&1; then
  failures+=(certificate)
fi
for unit in nginx.service docker.service k08-cert-renew.timer max-hackathon-deploy.timer; do
  if ! systemctl is-active --quiet "$unit"; then
    failures+=("$unit")
  fi
done

for service in database bot worker miniapp-api miniapp; do
  container=$(docker compose --env-file /etc/max-hackathon/compose.env ps -q "$service" 2>/dev/null || true)
  if [[ -z "$container" ]]; then
    failures+=("container:$service")
    continue
  fi
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)
  if [[ "$health" != healthy ]]; then
    failures+=("container:$service:$health")
  fi
done

case "${MAX_INGEST_MODE:-polling}" in
  polling)
    if ! systemctl is-active --quiet k08-spike-bot.service; then
      failures+=(polling-bot)
    fi
    ;;
  webhook)
    if ! systemctl is-active --quiet max-hackathon-webhook.service || \
       ! curl --fail --silent --max-time 5 --output /dev/null http://127.0.0.1:3001/health; then
      failures+=(webhook-bot)
    fi
    subscriptions=$(printf 'header = "Authorization: %s"\n' "$MAX_BOT_TOKEN" | \
      curl --config - --fail --silent --max-time 15 --cacert "$MAX_CA_CERT_PATH" \
        "$MAX_API_BASE_URL/subscriptions") || subscriptions=''
    if ! printf '%s' "$subscriptions" | python3 -c \
      'import json,os,sys; d=json.load(sys.stdin); assert any(s.get("url") == os.environ["MAX_WEBHOOK_URL"] for s in d.get("subscriptions", []))' \
      >/dev/null 2>&1; then
      failures+=(webhook-subscription)
    fi
    ;;
  *) failures+=(invalid-ingest-mode) ;;
esac

new_state=ok
if ((${#failures[@]})); then
  new_state="failed: ${failures[*]}"
fi
old_state=$(cat "$state_dir/monitor-state" 2>/dev/null || true)
if [[ "$new_state" != "$old_state" ]]; then
  printf '%s\n' "$new_state" >"$state_dir/monitor-state.tmp"
  mv "$state_dir/monitor-state.tmp" "$state_dir/monitor-state"
  if [[ -n "$old_state" ]]; then
    send_alert "K-08 VPS $host: $new_state" || echo 'MAX alert delivery failed' >&2
  fi
fi
echo "$new_state"
[[ "$new_state" == ok ]]
