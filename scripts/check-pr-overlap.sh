#!/usr/bin/env bash
# Комментирует PR: какие файлы правятся и в других открытых PR, и какие файлы вне зоны потока.
# Это предупреждение, а не блокировка.
# Использование: scripts/check-pr-overlap.sh <номер-PR> | --all  [--dry-run]

set -euo pipefail

target="${1:?Укажите номер PR или --all}"
dry_run="${2:-}"
repo="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
marker="<!-- pr-overlap -->"
ignored='^(docs/plan-dependencies\.md|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$'
closing='(close[sd]?|fix(e[sd])?|resolve[sd]?) +#[0-9]+'

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

open_prs="$(gh api "repos/$repo/pulls?state=open&per_page=100" \
  --jq '.[] | [.number, .draft, (.title | gsub("[\\t\\n]"; " "))] | @tsv')"

while IFS=$'\t' read -r n _ _; do
  [[ -n "$n" ]] || continue
  { gh api --paginate "repos/$repo/pulls/$n/files?per_page=100" --jq '.[].filename' | grep -vE "$ignored" | sort -u; } >"$tmp/$n.files" || true
done <<<"$open_prs"

in_zone() { # файл, файл со списком зон, идентификаторы потока (через пробел)
  local file="$1" zones="$2" ids="$3" z base id root rest cand
  while IFS= read -r z; do
    [[ -n "$z" ]] || continue
    if [[ "$z" == *"*"* ]]; then
      # shellcheck disable=SC2053
      [[ "$file" == $z ]] && return 0
    elif [[ "$file" == "$z"* ]]; then
      return 0
    elif [[ "$z" =~ ^(packages|apps)/[^/]+/ ]]; then
      # ADR-0005: зона packages/X/Y/ означает packages/X/src/Y/ (тесты — в test/)
      root="$(cut -d/ -f1-2 <<<"$z")"; rest="${z#"$root"/}"
      for cand in "$root/src/$rest" "$root/test/$rest" "$root/tests/$rest"; do
        [[ "$file" == "$cand"* ]] && return 0
      done
      case "$file" in
        "$root/package.json" | "$root/tsconfig.json" | "$root"/tsconfig.*.json | "$root/src/index.ts" | "$root/src/main.ts") return 0 ;;
      esac
    fi
  done <"$zones"
  base="${file##*/}"
  if [[ "$file" == data/fixtures/* || "$file" == packages/storage/migrations/* ]]; then
    for id in $ids; do [[ "$base" == "$id"* ]] && return 0; done
  fi
  return 1
}

report() {
  local pr="$1" info issue ibody title zone_body rest ids overlap="" outside="" n draft title2 state common
  info="$(gh api "repos/$repo/pulls/$pr")"
  [[ "$(jq -r .state <<<"$info")" == "open" ]] || return 0

  while IFS=$'\t' read -r n draft title2; do
    [[ -n "$n" && "$n" != "$pr" ]] || continue
    common="$(comm -12 "$tmp/$pr.files" "$tmp/$n.files")"
    [[ -n "$common" ]] || continue
    state="на проверке"; [[ "$draft" == "true" ]] && state="черновик"
    overlap+="- #$n ($state): $title2"$'\n'
    overlap+="$(head -8 <<<"$common" | sed 's/^/  - `/; s/$/`/')"$'\n'
  done <<<"$open_prs"

  issue="$({ jq -r '.body // ""' <<<"$info" | grep -oiE "$closing" | grep -oE '[0-9]+' | head -1; } || true)"
  if [[ -n "$issue" ]]; then
    ibody="$(gh api "repos/$repo/issues/$issue" --jq '.body // ""' 2>/dev/null || true)"
    title="$(gh api "repos/$repo/issues/$issue" --jq '.title' 2>/dev/null || true)"
    zone_body="$(awk '/^## Область изменений/{f=1;next} /^## /{f=0} f' <<<"$ibody")"
    rest="$(sed -E 's/`[^`]*`//g' <<<"$zone_body" | tr -d '[:space:],.;:()')"
    if [[ -n "$zone_body" && -z "$rest" ]]; then
      grep -oE '`[^`]+`' <<<"$zone_body" | tr -d '`' >"$tmp/zones"
      local id
      id="$(sed -nE 's/^\[([^]]+)\].*/\1/p' <<<"$title" | tr 'A-Z' 'a-z')"
      ids="$id ${id//-/}"
      while IFS= read -r f; do
        [[ -n "$f" ]] || continue
        in_zone "$f" "$tmp/zones" "$ids" || outside+="- \`$f\`"$'\n'
      done <"$tmp/$pr.files"
    fi
  fi

  local body="" existing
  if [[ -n "$overlap" ]]; then
    body+="**Те же файлы правятся в других открытых PR.** Договоритесь через комментарий в Issue потока или слейте один из PR первым и подтяните \`main\` (\`./scripts/wp.sh sync\`):"$'\n\n'"$overlap"$'\n'
  fi
  if [[ -n "$outside" ]]; then
    body+="**Файлы вне зоны потока #$issue.** Меняйте только зону из Issue; если правка необходима, объясните её в описании PR или вынесите в отдельный PR:"$'\n\n'"$(head -15 <<<"$outside")"$'\n'
  fi
  if [[ -n "$body" ]]; then
    body="$marker"$'\n'"### Проверка пересечений"$'\n\n'"$body"$'\n'"Это предупреждение, а не блокировка. Генерируемые файлы (\`docs/plan-dependencies.md\`, lock-файлы) не учитываются."
  else
    body="$marker"$'\n'"### Проверка пересечений"$'\n\n'"Пересечений с другими открытыми PR и правок вне зоны потока не найдено."
  fi

  if [[ -n "$dry_run" ]]; then
    echo "=== PR #$pr"; echo "$body"; echo; return 0
  fi
  existing="$(gh api "repos/$repo/issues/$pr/comments?per_page=100" --jq "[.[] | select(.body | contains(\"$marker\"))] | first | {id, body}" 2>/dev/null || true)"
  if [[ -n "$existing" && "$existing" != "null" ]]; then
    if [[ "$(jq -r .body <<<"$existing")" != "$body" ]]; then
      gh api -X PATCH "repos/$repo/issues/comments/$(jq -r .id <<<"$existing")" -f body="$body" >/dev/null
    fi
  elif [[ -n "$overlap$outside" ]]; then
    gh api -X POST "repos/$repo/issues/$pr/comments" -f body="$body" >/dev/null
  fi
}

if [[ "$target" == "--all" ]]; then
  while IFS=$'\t' read -r n _ _; do [[ -n "$n" ]] && report "$n"; done <<<"$open_prs"
else
  report "$target"
fi
