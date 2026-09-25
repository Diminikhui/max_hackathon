#!/usr/bin/env bash
# Выставляет метки in-progress / needs-review у Issue, закрываемых Pull Request.
# Использование: scripts/sync-pr-labels.sh <номер-PR> [--dry-run]

set -euo pipefail

pr="${1:?Укажите номер PR}"
dry_run="${2:-}"
repo="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"

info="$(gh api "repos/$repo/pulls/$pr")"
state="$(jq -r .state <<<"$info")"
merged="$(jq -r .merged <<<"$info")"
draft="$(jq -r .draft <<<"$info")"
issues="$(jq -r '.body // ""' <<<"$info" | grep -oiE '(close[sd]?|fix(e[sd])?|resolve[sd]?) +#[0-9]+' | grep -oE '[0-9]+' | sort -u || true)"

add() { [[ -n "$dry_run" ]] || gh api -X POST "repos/$repo/issues/$1/labels" -f "labels[]=$2" >/dev/null; }
remove() { [[ -n "$dry_run" ]] || gh api -X DELETE "repos/$repo/issues/$1/labels/$2" >/dev/null 2>&1 || true; }

for n in $issues; do
  if [[ "$merged" == "true" ]]; then
    echo "#$n: PR влит, снимаю рабочие метки"; remove "$n" needs-review; remove "$n" in-progress
  elif [[ "$state" == "open" && "$draft" == "false" ]]; then
    echo "#$n: PR готов к проверке"; add "$n" needs-review; remove "$n" in-progress
  elif [[ "$state" == "closed" && "$(gh api "repos/$repo/issues/$n" --jq '.assignees | length')" == "0" ]]; then
    echo "#$n: PR закрыт, поток свободен, снимаю рабочие метки"; remove "$n" needs-review; remove "$n" in-progress
  else
    echo "#$n: работа продолжается"; add "$n" in-progress; remove "$n" needs-review
  fi
done
