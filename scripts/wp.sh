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
#
# Чтение данных идёт через REST API, чтобы не расходовать общую квоту GraphQL всех агентов.

set -euo pipefail

if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
  repo="$GITHUB_REPOSITORY"
else
  repo="$(git config --get remote.origin.url 2>/dev/null | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##' || true)"
  [[ "$repo" == */* ]] || repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
fi
owner="${repo%%/*}"
project_number="${WP_PROJECT_NUMBER:-1}"

die() { echo "Ошибка: $*" >&2; exit 1; }
has_label() { [[ ",$1," == *",$2,"* ]]; }
ignored='^(docs/plan-dependencies\.md|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$'
zone_list() { awk '/^## Область изменений/{f=1;next} /^## /{f=0} f' <<<"$1" | grep -oE '`[^`]+`' | tr -d '`' || true; }
trunc() { jq -Rr ".[0:$2]" <<<"$1"; }

add_assignee() { gh api -X POST "repos/$repo/issues/$1/assignees" -f "assignees[]=$2" >/dev/null; }
remove_assignee() { gh api -X DELETE "repos/$repo/issues/$1/assignees" -f "assignees[]=$2" >/dev/null; }
add_labels() { local n="$1" args=() l; shift; for l in "$@"; do args+=(-f "labels[]=$l"); done; gh api -X POST "repos/$repo/issues/$n/labels" "${args[@]}" >/dev/null; }
remove_label() { gh api -X DELETE "repos/$repo/issues/$1/labels/${2//:/%3A}" >/dev/null 2>&1 || true; }
comment() { gh api -X POST "repos/$repo/issues/$1/comments" -f body="$2" >/dev/null; }

candidates() {
  gh api --paginate "repos/$repo/issues?labels=wp,ready&state=open&per_page=100" --jq '
    .[] | select(.pull_request == null) | select(.assignees | length == 0)
        | select([.labels[].name] | (index("agent:human") == null and index("blocked") == null))
        | {number, title,
           crit: ([.labels[].name] | index("critical-path") != null),
           core: ([.labels[].name] | index("stage:core") != null)}' |
    jq -sc 'sort_by([(if .crit then 0 else 1 end), (if .core then 0 else 1 end), .number]) | .[]'
}

in_progress_numbers() {
  gh api --paginate "repos/$repo/issues?labels=in-progress&state=open&per_page=100" --jq '.[] | select(.pull_request == null) | .number'
}

# Пишет в каталог $1: prs.tsv (номер, черновик, ветка, обновлён, Issue, название) и <номер>.files
load_open_prs() {
  local n
  gh api --paginate "repos/$repo/pulls?state=open&per_page=100" --jq '
    .[] | [.number, .draft, .head.ref, .updated_at[0:16],
           (((.body // "") | capture("(close[sd]?|fix(e[sd])?|resolve[sd]?) +#(?<i>[0-9]+)"; "i") | .i) // "-"),
           (.title | gsub("[\\t\\n]"; " "))] | @tsv' >"$1/prs.tsv"
  while IFS=$'\t' read -r n _; do
    [[ -n "$n" ]] || continue
    { gh api --paginate "repos/$repo/pulls/$n/files?per_page=100" --jq '.[].filename' | LC_ALL=C sort -u; } >"$1/$n.files" || true
  done <"$1/prs.tsv"
}

# Статус карточки: два лёгких запроса GraphQL (данные проекта и элемента, затем мутация).
set_status() {
  local num="$1" key="$2" data pid fid oid item
  if ! data="$(gh api graphql -f query='query($o:String!,$n:Int!,$r:String!,$i:Int!){
      user(login:$o){projectV2(number:$n){id field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}}}}
      repository(owner:$o,name:$r){issue(number:$i){projectItems(first:10){nodes{id project{number}}}}}}' \
      -f o="$owner" -F n="$project_number" -f r="${repo#*/}" -F i="$num" 2>/dev/null)"; then
    echo "Предупреждение: нет доступа к проекту (gh auth refresh -s project) или исчерпан лимит API. Статус карточки не изменён." >&2
    return 0
  fi
  pid="$(jq -r '.data.user.projectV2.id // empty' <<<"$data")"
  fid="$(jq -r '.data.user.projectV2.field.id // empty' <<<"$data")"
  oid="$(jq -r --arg k "$key" '.data.user.projectV2.field.options[]? | select(.name | ascii_downcase | contains($k | ascii_downcase)) | .id' <<<"$data" | head -1)"
  item="$(jq -r --argjson p "$project_number" '.data.repository.issue.projectItems.nodes[]? | select(.project.number == $p) | .id' <<<"$data" | head -1)"
  [[ -n "$pid" && -n "$fid" && -n "$oid" ]] || { echo "Предупреждение: в проекте нет статуса «$key»" >&2; return 0; }
  [[ -n "$item" ]] || { echo "Предупреждение: #$num нет в проекте" >&2; return 0; }
  if gh api graphql -f query='mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){clientMutationId}}' \
    -f p="$pid" -f i="$item" -f f="$fid" -f o="$oid" >/dev/null 2>&1; then
    echo "Статус карточки #$num: $key"
  else
    echo "Предупреждение: не удалось изменить статус карточки #$num" >&2
  fi
}

section() { awk -v h="## $2" '$0 == h {f=1; next} /^## / {f=0} f' <<<"$1" | sed '/./,$!d'; }

cmd_next() {
  echo "Доступные потоки (сначала критический путь, затем ядро; без agent:human и blocked):"
  candidates | head -15 | jq -r '"  #\(.number)\t\(.title)"'
}

cmd_deps() {
  local num="${1:?Укажите номер Issue}" n body
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

  add_assignee "$num" "$me"
  add_labels "$num" in-progress "agent:$agent"

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
    pt="$(trunc "${title#*] }" 90)"
    if git -C "$path" commit -q --allow-empty -m "chore: start ${id:-$num}" && git -C "$path" push -q -u origin "$branch" 2>/dev/null; then
      pr_url="$(gh pr create -R "$repo" --draft --base main --head "$branch" --title "[${id:-$num}] $pt" --body "Closes #$num

Черновой PR создан командой \`wp.sh claim\`, чтобы другие исполнители видели, какие файлы вы правите. Перед \`gh pr ready\` замените название на \`feat: …\` (оно станет сообщением коммита) и заполните шаблон PR." 2>/dev/null | tail -1)" || pr_url=""
      if [[ "$pr_url" != http* ]]; then
        pr_url=""
        echo "Предупреждение: черновой PR не создан (возможно, исчерпан лимит API). Ветка запушена; создайте PR позже: gh pr create --draft --head $branch" >&2
      fi
    else
      echo "Предупреждение: не удалось открыть черновой PR; откройте его вручную после первого коммита." >&2
    fi
  fi

  mz="$(zone_list "$body")"
  for n in $(in_progress_numbers); do
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
  comment "$num" "## Результат
$text"
  echo "Комментарий «Результат» добавлен в #$num"
}

cmd_status() { set_status "${1:?Укажите номер Issue}" "${2:?Укажите статус}"; }

cmd_release() {
  local num="${1:?Укажите номер Issue}" info labels id a l tmp n d ref info_pr
  info="$(gh api "repos/$repo/issues/$num")"
  labels="$(jq -r '[.labels[].name] | join(",")' <<<"$info")"
  for a in $(jq -r '.assignees[].login' <<<"$info"); do remove_assignee "$num" "$a"; done
  for l in in-progress needs-review agent:codex agent:claude agent:human; do
    if has_label "$labels" "$l"; then remove_label "$num" "$l"; fi
  done
  for id in $(gh api "repos/$repo/issues/$num/comments?per_page=100" --jq '.[] | select(.body | contains("wp-claim:")) | .id'); do
    gh api -X DELETE "repos/$repo/issues/comments/$id" >/dev/null
  done
  comment "$num" "Поток освобождён: его может взять другой исполнитель."

  tmp="$(mktemp -d)"
  gh api --paginate "repos/$repo/pulls?state=open&per_page=100" --jq '.[] | [.number, .head.ref, ((.body // "") | test("#'"$num"'([^0-9]|$)"))] | @tsv' >"$tmp/prs.tsv" || true
  while IFS=$'\t' read -r n ref d; do
    [[ "$d" == "true" ]] || continue
    info_pr="$(gh api "repos/$repo/pulls/$n" --jq '[.draft, .commits] | @tsv')"
    if [[ "$info_pr" == $'true\t1' ]]; then
      gh api -X POST "repos/$repo/issues/$n/comments" -f body="Поток освобождён: закрываю пустой черновик." >/dev/null
      gh api -X PATCH "repos/$repo/pulls/$n" -f state=closed >/dev/null
      gh api -X DELETE "repos/$repo/git/refs/heads/$ref" >/dev/null 2>&1 || true
      echo "Пустой черновой PR #$n закрыт, ветка $ref удалена"
    else
      echo "Внимание: с потоком связан PR #$n с работой. Закройте его или передайте вручную."
    fi
  done <"$tmp/prs.tsv"
  rm -rf "$tmp"
  if has_label "$labels" ready; then set_status "$num" Ready; else set_status "$num" Backlog; fi
  echo "#$num освобождён"
}

cmd_active() {
  local tmp n d ref upd iss title state
  tmp="$(mktemp -d)"
  load_open_prs "$tmp"
  echo "Открытые PR (работа в процессе и на проверке):"
  [[ -s "$tmp/prs.tsv" ]] || echo "  нет"
  while IFS=$'\t' read -r n d ref upd iss title; do
    [[ -n "$n" ]] || continue
    state="на проверке"; [[ "$d" == "true" ]] && state="черновик"
    echo "  #$n [$state] $(trunc "$title" 64)"
    echo "      ветка $ref · Issue #$iss · обновлён $upd · файлов: $(wc -l <"$tmp/$n.files" | tr -d ' ') · каталоги: $(cut -d/ -f1-2 "$tmp/$n.files" | LC_ALL=C sort -u | paste -sd, - | sed 's/,/, /g')"
  done <"$tmp/prs.tsv"
  rm -rf "$tmp"
  echo
  echo "Потоки в работе (label in-progress):"
  for n in $(in_progress_numbers); do
    gh api "repos/$repo/issues/$n" --jq '"  #\(.number) \(.title[0:64]) - \([.assignees[].login] | join(",")) / \([.labels[].name | select(startswith("agent:"))] | join(","))"'
    gh api "repos/$repo/issues/$n/comments?per_page=100" --jq '[.[] | select(.body | startswith("## Заметка"))] | last | .body // empty' | sed '1d; s/^/      заметка: /' | head -3
  done
}

cmd_overlap() {
  git rev-parse --git-dir >/dev/null 2>&1 || die "запустите внутри репозитория"
  git fetch origin -q
  local branch tmp n d ref upd iss title state common found=0
  branch="$(git rev-parse --abbrev-ref HEAD)"
  tmp="$(mktemp -d)"
  { git diff --name-only origin/main...HEAD; git diff --name-only; git diff --name-only --cached; git ls-files --others --exclude-standard; } |
    LC_ALL=C sort -u | grep -vE "$ignored" >"$tmp/mine" || true
  if [[ ! -s "$tmp/mine" ]]; then echo "В ветке $branch пока нет изменений относительно origin/main."; rm -rf "$tmp"; return 0; fi
  echo "Ветка $branch: изменённых файлов - $(wc -l <"$tmp/mine" | tr -d ' ')"
  load_open_prs "$tmp"
  while IFS=$'\t' read -r n d ref upd iss title; do
    [[ -n "$n" && "$ref" != "$branch" ]] || continue
    common="$(LC_ALL=C comm -12 "$tmp/mine" "$tmp/$n.files")"
    [[ -n "$common" ]] || continue
    if (( found == 0 )); then echo "Те же файлы правятся в других открытых PR:"; found=1; fi
    state="на проверке"; [[ "$d" == "true" ]] && state="черновик"
    echo "  #$n [$state] $(trunc "$title" 64)"
    echo "$common" | sed 's/^/      /'
  done <"$tmp/prs.tsv"
  rm -rf "$tmp"
  if (( found == 0 )); then echo "Пересечений с открытыми PR нет."; return 0; fi
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
  comment "$num" "## Заметка
$text"
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
