#!/usr/bin/env bash
# Помощник работы с потоками (work packages). Требует gh и jq.
#
#   wp.sh next                              показать доступные потоки (label ready, без исполнителя)
#   wp.sh claim [N] [--agent codex|claude|human] [--slug кратко] [--no-worktree] [--no-pr] [--force]
#                                           взять поток N или следующий по приоритету; открывает черновой PR
#   wp.sh active                            кто что сейчас делает: открытые PR, потоки в работе, заметки
#   wp.sh overlap                           файлы текущей ветки, которые правятся и в других открытых PR
#   wp.sh sync                              подтянуть origin/main в текущую ветку
#   wp.sh note N "текст"                    короткая заметка в Issue потока для соседей
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
ignored='^(docs/plan-dependencies\.md|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$'
zone_list() { awk '/^## Область изменений/{f=1;next} /^## /{f=0} f' <<<"$1" | grep -oE '`[^`]+`' | tr -d '`' || true; }

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
  local num="" agent="${WP_AGENT:-human}" slug="work" worktree=1 force=0 draft_pr=1
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --agent) agent="${2:?}"; shift 2 ;;
      --slug) slug="${2:?}"; shift 2 ;;
      --no-worktree) worktree=0; shift ;;
      --no-pr) draft_pr=0; shift ;;
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

  local pr_url="" pt mz n obody z1 z2
  if (( worktree == 1 && draft_pr == 1 )); then
    pt="$(jq -Rr '.[0:90]' <<<"${title#*] }")"
    if git -C "$path" commit -q --allow-empty -m "chore: start ${id:-$num}" && git -C "$path" push -q -u origin "$branch" 2>/dev/null; then
      pr_url="$(gh pr create -R "$repo" --draft --base main --head "$branch" --title "[${id:-$num}] $pt" --body "Closes #$num

Черновой PR создан командой \`wp.sh claim\`, чтобы другие исполнители видели, какие файлы вы правите. Перед \`gh pr ready\` замените название на \`feat: …\` (оно станет сообщением коммита) и заполните шаблон PR." 2>/dev/null | tail -1)"
    else
      echo "Предупреждение: не удалось открыть черновой PR; откройте его вручную после первого коммита." >&2
    fi
  fi

  mz="$(zone_list "$body")"
  for n in $(gh issue list -R "$repo" -l in-progress --state open --json number --jq '.[].number'); do
    [[ "$n" != "$num" ]] || continue
    obody="$(gh api "repos/$repo/issues/$n" --jq '.body // ""')"
    while IFS= read -r z1; do
      [[ -n "$z1" ]] || continue
      while IFS= read -r z2; do
        [[ -n "$z2" ]] || continue
        if [[ "$z1" == "$z2"* || "$z2" == "$z1"* ]]; then
          echo "Внимание: зона $z1 пересекается с потоком #$n (зона $z2). Согласуйте правки: ./scripts/wp.sh note $n \"...\"" >&2
        fi
      done <<<"$(zone_list "$obody")"
    done <<<"$mz"
  done

  echo
  echo "Поток взят: #$num $title"
  echo "Ветка:     $branch"
  (( worktree == 1 )) && echo "Worktree:  $path"
  [[ -z "$pr_url" ]] || echo "Черновой PR: $pr_url"
  echo "Что делают соседи: ./scripts/wp.sh active"
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
  local pr
  for pr in $(gh pr list -R "$repo" --state open --json number,isDraft,commits,body --jq ".[] | select((.body // \"\") | test(\"#$num([^0-9]|\$)\")) | select(.isDraft and (.commits | length) == 1) | .number"); do
    if gh pr close "$pr" -R "$repo" --delete-branch --comment "Поток освобождён: закрываю пустой черновик." >/dev/null 2>&1; then
      echo "Пустой черновой PR #$pr закрыт"
    else
      echo "Черновой PR #$pr закрыт, ветку удалите вручную (git push origin --delete <ветка>)"
    fi
  done
  for pr in $(gh pr list -R "$repo" --state open --json number,isDraft,commits,body --jq ".[] | select((.body // \"\") | test(\"#$num([^0-9]|\$)\")) | select((.isDraft | not) or (.commits | length) > 1) | .number"); do
    echo "Внимание: с потоком связан PR #$pr с работой. Закройте его или передайте вручную."
  done
  if has_label "$labels" ready; then set_status "$num" Ready; else set_status "$num" Backlog; fi
  echo "#$num освобождён"
}

cmd_active() {
  echo "Открытые PR (работа в процессе и на проверке):"
  gh pr list -R "$repo" --state open --limit 50 --json number,title,isDraft,headRefName,updatedAt,files,body --jq '
    .[] | (((.body // "") | capture("(close[sd]?|fix(e[sd])?|resolve[sd]?) +#(?<i>[0-9]+)"; "i") | .i) // "-") as $i
    | "  #\(.number) [\(if .isDraft then "черновик" else "на проверке" end)] \(.title[0:64])\n      ветка \(.headRefName) · Issue #\($i) · обновлён \(.updatedAt[0:16]) · файлов: \(.files | length) · каталоги: \([.files[].path | split("/") | .[0:2] | join("/")] | unique | join(", "))"'
  echo
  echo "Потоки в работе (label in-progress):"
  local n
  for n in $(gh issue list -R "$repo" -l in-progress --state open --json number --jq '.[].number'); do
    gh issue view "$n" -R "$repo" --json number,title,assignees,labels --jq '"  #\(.number) \(.title[0:64]) - \([.assignees[].login] | join(",")) / \([.labels[].name | select(startswith("agent:"))] | join(","))"'
    gh api "repos/$repo/issues/$n/comments?per_page=100" --jq '[.[] | select(.body | startswith("## Заметка"))] | last | .body // empty' | sed '1d; s/^/      заметка: /' | head -3
  done
}

cmd_overlap() {
  git rev-parse --git-dir >/dev/null 2>&1 || die "запустите внутри репозитория"
  git fetch origin -q
  local branch tmp found
  branch="$(git rev-parse --abbrev-ref HEAD)"
  tmp="$(mktemp)"
  { git diff --name-only origin/main...HEAD; git diff --name-only; git diff --name-only --cached; git ls-files --others --exclude-standard; } | sort -u | grep -vE "$ignored" >"$tmp" || true
  if [[ ! -s "$tmp" ]]; then echo "В ветке $branch пока нет изменений относительно origin/main."; rm -f "$tmp"; return 0; fi
  echo "Ветка $branch: изменённых файлов - $(wc -l <"$tmp" | tr -d ' ')"
  found="$(gh pr list -R "$repo" --state open --limit 50 --json number,title,isDraft,headRefName,files --jq ".[] | select(.headRefName != \"$branch\") | .number as \$n | .title as \$t | (if .isDraft then \"черновик\" else \"на проверке\" end) as \$d | .files[].path | [\$n, \$d, \$t, .] | @tsv" | awk -F'\t' 'NR==FNR{m[$0]=1; next} ($4 in m)' "$tmp" -)"
  rm -f "$tmp"
  if [[ -z "$found" ]]; then echo "Пересечений с открытыми PR нет."; return 0; fi
  echo "Те же файлы правятся в других открытых PR:"
  echo "$found" | awk -F'\t' '{k="#"$1" ["$2"] "$3; if (k != p) {print "  " k; p = k} print "      " $4}'
  echo "Договоритесь через ./scripts/wp.sh note <Issue> \"...\" или слейте один PR первым и выполните ./scripts/wp.sh sync."
}

cmd_sync() {
  git rev-parse --git-dir >/dev/null 2>&1 || die "запустите внутри репозитория"
  [[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "сначала закоммитьте или отложите изменения"
  git fetch origin -q
  if git merge --no-edit origin/main >/dev/null 2>&1; then echo "Ветка обновлена: origin/main подтянут."; return 0; fi
  local conflicts
  conflicts="$(git diff --name-only --diff-filter=U)"
  if [[ "$conflicts" == "docs/plan-dependencies.md" ]]; then
    python3 scripts/work_packages.py report >/dev/null && git add docs/plan-dependencies.md && git commit -q --no-edit &&
      echo "Конфликт в docs/plan-dependencies.md разрешён пересборкой отчёта." && return 0
  fi
  echo "Конфликты слияния в файлах:"; echo "$conflicts" | sed 's/^/  /'
  echo "Разрешите их (или git merge --abort) и повторите. Если файл вне вашей зоны, оставьте заметку владельцу потока: ./scripts/wp.sh note <Issue> \"...\""
  return 1
}

cmd_note() {
  local num="${1:?Укажите номер Issue}"; shift
  local text="$*"
  [[ -n "$text" ]] || die "пустая заметка"
  gh issue comment "$num" -R "$repo" --body "## Заметка
$text" >/dev/null
  echo "Заметка добавлена в #$num"
}

case "${1:-}" in
  active) shift; cmd_active "$@" ;;
  overlap) shift; cmd_overlap "$@" ;;
  sync) shift; cmd_sync "$@" ;;
  note) shift; cmd_note "$@" ;;
  next) shift; cmd_next "$@" ;;
  claim) shift; cmd_claim "$@" ;;
  deps) shift; cmd_deps "$@" ;;
  result) shift; cmd_result "$@" ;;
  status) shift; cmd_status "$@" ;;
  release) shift; cmd_release "$@" ;;
  *) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
