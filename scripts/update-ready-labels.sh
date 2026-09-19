#!/usr/bin/env bash
# Обновляет label `ready` у потоков, зависящих от указанного Issue.
# Использование: scripts/update-ready-labels.sh <номер-issue> [--dry-run]

set -euo pipefail

issue="${1:?Укажите номер Issue}"
dry_run="${2:-}"
repo="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"

dependents="$(gh api "repos/$repo/issues/$issue/dependencies/blocking?per_page=100" --jq '.[].number')"

for dep in $dependents; do
  info="$(gh api "repos/$repo/issues/$dep" --jq '{state: .state, ready: ([.labels[].name] | index("ready") != null)}')"
  state="$(jq -r .state <<<"$info")"
  has_ready="$(jq -r .ready <<<"$info")"
  [[ "$state" == "open" ]] || continue

  open_blockers="$(gh api "repos/$repo/issues/$dep/dependencies/blocked_by?per_page=100" \
    --jq '[.[] | select(.state == "open")] | length')"

  if [[ "$open_blockers" == "0" && "$has_ready" == "false" ]]; then
    echo "#$dep: все блокеры закрыты, ставлю ready"
    if [[ -z "$dry_run" ]]; then
      gh api -X POST "repos/$repo/issues/$dep/labels" -f 'labels[]=ready' >/dev/null
      gh api -X POST "repos/$repo/issues/$dep/comments" \
        -f body="Все зависимости закрыты (последняя — #$issue). Поток доступен: см. docs/agents/work-packages.md." >/dev/null
    fi
  elif [[ "$open_blockers" != "0" && "$has_ready" == "true" ]]; then
    echo "#$dep: снова есть открытые блокеры ($open_blockers), снимаю ready"
    if [[ -z "$dry_run" ]]; then
      gh api -X DELETE "repos/$repo/issues/$dep/labels/ready" >/dev/null
    fi
  fi
done
