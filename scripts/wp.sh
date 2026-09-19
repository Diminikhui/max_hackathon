#!/usr/bin/env bash
# Помощник работы с потоками (work packages). Требует gh и jq.
#
#   wp.sh next                              показать доступные потоки (label ready, без исполнителя)
#   wp.sh claim [N] [--agent codex|claude|human] [--slug кратко] [--no-worktree] [--force]
#                                           взять поток N или следующий по приоритету
#   wp.sh deps N                            блокеры потока и их комментарии «Результат»
#   wp.sh result N [файл]                   оставить в Issue комментарий «Результат» (из файла, stdin или шаблон)
#   wp.sh status N <Backlog|Ready|In progress|In review|Done>   статус карточки в проекте
#   wp.sh release N                         освободить поток

set -euo pipefail

repo="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
owner="${repo%%/*}"
project_number="${WP_PROJECT_NUMBER:-1}"

die() { echo "Ошибка: $*" >&2; exit 1; }
has_label() { [[ ",$1," == *",$2,"* ]]; }

candidates() {
  gh issue list -R "$repo" -l wp -l ready --state open --limit 200 --json number,title,labels,assignees --jq '
    [.[] | select(.assignees | length == 0)
         | select([.labels[].name] | (index("agent:human") == null and index("blocked") == null))
         | {number, title,
            crit: ([.labels[].name] | index("critical-path") != null),
            core: ([.labels[].name] | index("stage:core") != null)}]
    | sort_by([(if .crit then 0 else 1 end), (if .core then 0 else 1 end), .number]) | .[]'
}

set_status() {
  local num="$1" key="$2" pid fid oid item
  if ! pid="$(gh project view "$project_number" --owner "$owner" --format json --jq .id 2>/dev/null)"; then
    echo "Предупреждение: нет доступа к проекту (выполните: gh auth refresh -s project). Статус карточки не изменён." >&2
    return 0
  fi
  read -r fid oid < <(gh project field-list "$project_number" --owner "$owner" --format json |
    jq -r --arg k "$key" '.fields[] | select(.name == "Status") | .id as $f
      | (.options[] | select(.name | ascii_downcase | contains($k | ascii_downcase)) | "\($f) \(.id)")' | head -1) || true
  [[ -n "${oid:-}" ]] || { echo "Предупреждение: в проекте нет статуса «$key»" >&2; return 0; }
  item="$(gh project item-list "$project_number" --owner "$owner" --limit 500 --format json |
    jq -r --argjson n "$num" '.items[] | select(.content.number == $n) | .id' | head -1)"
  [[ -n "$item" ]] || { echo "Предупреждение: #$num нет в проекте" >&2; return 0; }
  gh project item-edit --id "$item" --project-id "$pid" --field-id "$fid" --single-select-option-id "$oid" >/dev/null
  echo "Статус карточки #$num: $key"
}

section() { awk -v h="## $2" '$0 == h {f=1; next} /^## / {f=0} f' <<<"$1" | sed '/./,$!d'; }

cmd_next() {
  echo "Доступные потоки (сначала критический путь, затем ядро; без agent:human и blocked):"
  candidates | head -15 | jq -r '"  #\(.number)\t\(.title)"'
}

cmd_deps() {
  local num="${1:?Укажите номер Issue}" n
  echo "Блокеры #$num:"
  gh api "repos/$repo/issues/$num/dependencies/blocked_by?per_page=100" --jq '.[] | "  #\(.number) [\(.state)] \(.title)"'
  for n in $(gh api "repos/$repo/issues/$num/dependencies/blocked_by?per_page=100" --jq '.[].number'); do
    body="$(gh api "repos/$repo/issues/$n/comments?per_page=100" --jq '[.[] | select(.body | startswith("## Результат"))] | last | .body // empty')"
    if [[ -n "$body" ]]; then
      echo; echo "--- Результат из #$n:"; echo "$body" | head -40
    else
      echo; echo "--- В #$n нет комментария «Результат»: читайте PR и код блокера."
    fi
  done
}

cmd_claim() {
  local num="" agent="${WP_AGENT:-human}" slug="work" worktree=1 force=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --agent) agent="${2:?}"; shift 2 ;;
      --slug) slug="${2:?}"; shift 2 ;;
      --no-worktree) worktree=0; shift ;;
      --force) force=1; shift ;;
      [0-9]*) num="$1"; shift ;;
      *) die "неизвестный аргумент: $1" ;;
    esac
  done
  case "$agent" in codex | claude | human) ;; *) die "--agent: codex, claude или human" ;; esac

  local me
  me="$(gh api user --jq .login)"
  if [[ -z "$num" ]]; then
    num="$(candidates | head -1 | jq -r '.number // empty')"
    [[ -n "$num" ]] || die "нет доступных потоков (label ready без исполнителя)"
  fi

  local info labels assignees state title body
  info="$(gh api "repos/$repo/issues/$num")"
  labels="$(jq -r '[.labels[].name] | join(",")' <<<"$info")"
  assignees="$(jq -r '[.assignees[].login] | join(",")' <<<"$info")"
  state="$(jq -r .state <<<"$info")"; title="$(jq -r .title <<<"$info")"; body="$(jq -r '.body // ""' <<<"$info")"
  [[ "$state" == "open" ]] || die "#$num закрыт"
  if (( force == 0 )); then
    has_label "$labels" wp || die "#$num не является потоком (нет label wp)"
    has_label "$labels" ready || die "#$num ещё заблокирован: ./scripts/wp.sh deps $num"
  fi
  [[ -z "$assignees" ]] || die "#$num уже занят: $assignees"

  local token="$$-$RANDOM-$(date +%s)" cid
  cid="$(gh api "repos/$repo/issues/$num/comments" -f body="Беру поток: агент \`$agent\`, исполнитель @$me.
<!-- wp-claim:$token -->" --jq .id)"
  sleep 3
  local first
  first="$(gh api "repos/$repo/issues/$num/comments?per_page=100" --jq '[.[] | select(.body | contains("wp-claim:"))] | first | .body' |
    sed -nE 's/.*wp-claim:([^ ]+) -->.*/\1/p')"
  if [[ "$first" != "$token" ]]; then
    gh api -X DELETE "repos/$repo/issues/comments/$cid" >/dev/null
    die "#$num только что взял другой исполнитель. Выберите следующий: ./scripts/wp.sh next"
  fi

  gh issue edit "$num" -R "$repo" --add-assignee "$me" --add-label in-progress --add-label "agent:$agent" >/dev/null

  local id kind login branch path
  id="$(sed -nE 's/^\[([^]]+)\].*/\1/p' <<<"$title" | tr 'A-Z' 'a-z')"
  kind=feat
  has_label "$labels" research && kind=research
  has_label "$labels" documentation && kind=docs
  login="$(tr 'A-Z' 'a-z' <<<"$me")"
  branch="$login/$agent/$kind-${id:-$num}-$slug"
  path="$(git rev-parse --show-toplevel)/../max-${id:-$num}"
  if (( worktree == 1 )); then
    git fetch origin -q
    git worktree add "$path" -b "$branch" origin/main >/dev/null 2>&1 || echo "Предупреждение: не удалось создать worktree $path (возможно, уже существует)" >&2
  fi
  set_status "$num" "In progress"

  echo
  echo "Поток взят: #$num $title"
  echo "Ветка:     $branch"
  (( worktree == 1 )) && echo "Worktree:  $path"
  echo
  echo "=== Область изменений"; section "$body" "Область изменений (зона файлов)"
  echo; echo "=== Критерии приёмки"; section "$body" "Критерии приёмки"
  echo; cmd_deps "$num"
}

cmd_result() {
  local num="${1:?Укажите номер Issue}" file="${2:-}" text
  if [[ -n "$file" ]]; then text="$(cat "$file")"
  elif [[ ! -t 0 ]]; then text="$(cat)"
  else
    cat <<'TEMPLATE'
Шаблон (передайте текст через stdin или файл):
- Что сделано:
- PR: #
- Файлы и каталоги:
- Версия контракта и схем:
- Как использовать (команды, примеры):
- Ограничения и известные проблемы:
- Что важно знать зависимым потокам:
TEMPLATE
    return 0
  fi
  [[ -n "$text" ]] || die "пустой результат"
  gh issue comment "$num" -R "$repo" --body "## Результат
$text" >/dev/null
  echo "Комментарий «Результат» добавлен в #$num"
}

cmd_status() { set_status "${1:?Укажите номер Issue}" "${2:?Укажите статус}"; }

cmd_release() {
  local num="${1:?Укажите номер Issue}" info labels id a
  info="$(gh api "repos/$repo/issues/$num")"
  labels="$(jq -r '[.labels[].name] | join(",")' <<<"$info")"
  for a in $(jq -r '.assignees[].login' <<<"$info"); do gh issue edit "$num" -R "$repo" --remove-assignee "$a" >/dev/null; done
  for l in in-progress needs-review agent:codex agent:claude agent:human; do
    has_label "$labels" "$l" && gh issue edit "$num" -R "$repo" --remove-label "$l" >/dev/null || true
  done
  for id in $(gh api "repos/$repo/issues/$num/comments?per_page=100" --jq '.[] | select(.body | contains("wp-claim:")) | .id'); do
    gh api -X DELETE "repos/$repo/issues/comments/$id" >/dev/null
  done
  gh issue comment "$num" -R "$repo" --body "Поток освобождён: его может взять другой исполнитель." >/dev/null
  if has_label "$labels" ready; then set_status "$num" Ready; else set_status "$num" Backlog; fi
  echo "#$num освобождён"
}

case "${1:-}" in
  next) shift; cmd_next "$@" ;;
  claim) shift; cmd_claim "$@" ;;
  deps) shift; cmd_deps "$@" ;;
  result) shift; cmd_result "$@" ;;
  status) shift; cmd_status "$@" ;;
  release) shift; cmd_release "$@" ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
