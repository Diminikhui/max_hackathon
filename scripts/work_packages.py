#!/usr/bin/env python3
"""Потоки из docs/roadmap.md: проверка, отчёт о зависимостях, синхронизация с GitHub Issues.

  validate            проверить таблицы и граф зависимостей
  report [--check]    сформировать docs/plan-dependencies.md (или проверить, что он актуален)
  sync [--apply [--refresh]]   создать labels, milestones, эпики, Issues, sub-issues и зависимости; --refresh обновляет тексты созданных Issue
  project [--number N] [--apply] [--dates] [--views]   заполнить поля существующего GitHub Project, пересчитать даты, настроить виды (нужен scope `project`)
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ROADMAP = ROOT / "docs" / "roadmap.md"
REPORT = ROOT / "docs" / "plan-dependencies.md"

ID_RE = re.compile(r"(?:K|[2-5])-\d\d[a-e]?")
SECTION_STAGE = {"4": "core", "5": "2", "6": "3", "7": "4", "8": "5"}
STAGES = ["core", "2", "3", "4", "5"]
STAGE_TITLE = {
    "core": "Ядро (этап 1)",
    "2": "Этап 2",
    "3": "Этап 3",
    "4": "Этап 4",
    "5": "Этап 5",
}
MILESTONES = {
    "core": ("Ядро (этап 1)", "2026-09-24", "Самодостаточный MVP: бот в MAX, профиль, перечень обязанностей, уведомления."),
    "2": ("Этап 2. Мини-приложение и глубина", "2026-09-27", "Мини-приложение, объяснимость, меры поддержки, пересчёт."),
    "3": ("Этап 3. Масштабирование и сдача", "2026-09-29", "Тиражирование пакетами, синтетика, презентация, сдача онлайн-этапа."),
    "4": ("Этап 4. Полная концепция", "2026-10-29", "Расширенное vision на модельных данных для финала."),
    "5": ("Этап 5. Реальные интеграции", None, "После хакатона: замена моков реальными источниками."),
}
WAVE_TITLE = {
    0: "Волна 0. Основания",
    1: "Волна 1. Независимые потоки против контрактов",
    2: "Волна 2. Сборка логики",
    3: "Волна 3. Сборка, качество, сдача",
}
SIZE_DAYS = {"S": 0.5, "M": 1.0, "L": 2.0}
HUMAN_ONLY = {"K-00", "2-16", "4-17b", "5-01", "5-06"}
VIS_DAYS = {"S": 1, "M": 2, "L": 3}
BASE_DATE = date(2026, 9, 19)
DEP_OVERRIDES = {
    "K-33a": ["K-07"],
    "3-07": [],
}
LABELS = {
    "wp": ("0052CC", "Рабочий поток из дорожной карты"),
    "epic": ("3E4B9E", "Эпик: группа потоков"),
    "ready": ("0E8A16", "Все зависимости закрыты, поток можно брать"),
    "critical-path": ("B60205", "Критический путь"),
    "in-progress": ("FBCA04", "Поток взят в работу"),
    "needs-review": ("D876E3", "Есть PR, нужна проверка"),
    "contract-change": ("C2E0C6", "Запрос изменения контракта"),
    "stage:core": ("FBCA04", "Ядро (этап 1)"),
    "stage:2": ("FEF2C0", "Этап 2"),
    "stage:3": ("FEF2C0", "Этап 3"),
    "stage:4": ("FEF2C0", "Этап 4"),
    "stage:5": ("FEF2C0", "Этап 5"),
    "size:S": ("C5DEF5", "До полудня"),
    "size:M": ("C5DEF5", "Около дня"),
    "size:L": ("C5DEF5", "Два дня и более"),
}


def cut(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 1].rsplit(" ", 1)[0].rstrip(",;:—-( ") + "…"


class Wp:
    def __init__(self, **kw):
        self.__dict__.update(kw)

    @property
    def title(self) -> str:
        return cut(f"[{self.id}] {self.name}", 100)

    @property
    def zone_paths(self) -> list[str]:
        return [p.strip() for p in self.zone.replace("`", "").split(",") if p.strip()]


def parse() -> dict[str, Wp]:
    wps: dict[str, Wp] = {}
    stage = wave = None
    for line in ROADMAP.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^## (\d+)\.", line)
        if m:
            stage, wave = SECTION_STAGE.get(m.group(1)), None
            continue
        m = re.match(r"^### Волна (\d)", line)
        if m:
            wave = int(m.group(1))
            continue
        if not stage or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        wid = cells[0].replace("⚑", "").strip()
        if not re.fullmatch(ID_RE, wid):
            continue
        if wid in wps:
            raise ValueError(f"Повторяющийся ID {wid}")
        wps[wid] = Wp(
            id=wid,
            critical="⚑" in cells[0],
            stage=stage,
            wave=wave,
            name=cells[1],
            raw_deps=cells[2],
            done=cells[3],
            zone=cells[4] if len(cells) > 4 else "",
            size=cells[5] if len(cells) > 5 else "M",
            deps=[],
        )
    return wps


def resolve_deps(wps: dict[str, Wp]) -> None:
    for wp in wps.values():
        if wp.id in DEP_OVERRIDES:
            wp.deps = list(DEP_OVERRIDES[wp.id])
        else:
            out: list[str] = []
            for tok in ID_RE.findall(wp.raw_deps):
                if tok in wps:
                    out.append(tok)
                    continue
                parts = sorted(i for i in wps if i.startswith(tok) and len(i) == len(tok) + 1)
                if not parts:
                    raise ValueError(f"{wp.id}: неизвестная зависимость {tok}")
                out.extend(parts)
            wp.deps = list(dict.fromkeys(out))
        for d in wp.deps:
            if d not in wps:
                raise ValueError(f"{wp.id}: неизвестная зависимость {d}")
            if d == wp.id:
                raise ValueError(f"{wp.id}: зависит от себя")
    for wp in wps.values():
        wp.blocks = sorted(o.id for o in wps.values() if wp.id in o.deps)


def order(wps: dict[str, Wp]) -> list[str]:
    indeg = {i: len(w.deps) for i, w in wps.items()}
    level = {i: 0 for i in wps}
    ready = sorted(i for i, n in indeg.items() if n == 0)
    seen = []
    while ready:
        cur = ready.pop(0)
        seen.append(cur)
        for nxt in wps[cur].blocks:
            level[nxt] = max(level[nxt], level[cur] + 1)
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                ready.append(nxt)
    if len(seen) != len(wps):
        cyc = sorted(set(wps) - set(seen))
        raise ValueError(f"Цикл в зависимостях: {', '.join(cyc)}")
    for i, w in wps.items():
        w.level = level[i]
    return sorted(wps, key=lambda i: (wps[i].level, STAGES.index(wps[i].stage), i))


def critical_path(wps: dict[str, Wp]) -> tuple[list[str], float]:
    finish: dict[str, float] = {}
    prev: dict[str, str | None] = {}

    def fin(i: str) -> float:
        if i in finish:
            return finish[i]
        best, arg = 0.0, None
        for d in wps[i].deps:
            if fin(d) > best:
                best, arg = fin(d), d
        prev[i] = arg
        finish[i] = best + SIZE_DAYS.get(wps[i].size, 1.0)
        return finish[i]

    end = max(wps, key=fin)
    path, cur = [], end
    while cur:
        path.append(cur)
        cur = prev[cur]
    return path[::-1], finish[end]


def schedule(wps: dict[str, Wp], done: dict[str, date] | None = None,
             today: date | None = None) -> dict[str, tuple[date, date]]:
    """Условное расписание: ранний старт при неограниченном числе исполнителей.

    Без аргументов считает от BASE_DATE. Со `today` и `done` (закрытые потоки и даты закрытия)
    считает скользящее расписание: закрытые потоки не задерживают открытые, открытые не начинаются
    раньше сегодняшнего дня. Этап 4 не начинается до фиксации сданной версии (3-11b), этап 5 — после
    этапа 4. Даты показывают порядок и параллельность потоков, а не сроки.
    """
    done = done or {}
    origin = today or BASE_DATE
    fin: dict[str, int] = {}

    def floors(w: Wp) -> list[str]:
        if w.stage == "4":
            return ["3-11b"]
        if w.stage == "5":
            return [i for i, x in wps.items() if x.stage == "4"]
        return []

    def finish(i: str) -> int:
        if i not in fin:
            w = wps[i]
            if i in done:
                w.start_day, fin[i] = 0, 0
            else:
                w.start_day = max([finish(d) for d in w.deps + floors(w)] or [0])
                fin[i] = w.start_day + VIS_DAYS.get(w.size, 2)
        return fin[i]

    for i in wps:
        finish(i)
    return {i: ((done[i], done[i]) if i in done else
                (origin + timedelta(days=w.start_day), origin + timedelta(days=fin[i] - 1)))
            for i, w in wps.items()}


def load() -> tuple[dict[str, Wp], list[str]]:
    wps = parse()
    if not wps:
        raise ValueError("В docs/roadmap.md не найдено ни одного потока")
    resolve_deps(wps)
    return wps, order(wps)


def short(name: str) -> str:
    return cut(name, 70)


def build_report(wps: dict[str, Wp], ordered: list[str]) -> str:
    path, days = critical_path(wps)
    layers = defaultdict(list)
    for i in ordered:
        layers[wps[i].level].append(i)
    out = [
        "# План реализации: зависимости потоков",
        "",
        "Файл формируется командой `python3 scripts/work_packages.py report` из [docs/roadmap.md](roadmap.md). Не редактируйте его вручную.",
        "",
        "**Слой** — глубина потока по зависимостям. Все потоки одного слоя независимы друг от друга, их можно брать одновременно. "
        "Поток доступен, когда закрыты все Issue из колонки «Старт после».",
        "",
        "## Сводка",
        "",
        f"- Потоков: {len(wps)}; слоёв: {len(layers)}.",
        f"- Самый длинный путь по зависимостям: {len(path)} потоков, около {days:g} рабочих дней при последовательной работе.",
        "- Потоков без зависимостей (можно начать сразу): "
        + str(sum(1 for w in wps.values() if not w.deps))
        + ".",
        "",
        "## Самый длинный путь",
        "",
        " → ".join(path),
        "",
        "## Слои",
    ]
    for lvl in sorted(layers):
        ids = layers[lvl]
        out += ["", f"### Слой {lvl} — потоков: {len(ids)}", "", "| ID | Поток | Этап | Р. | Старт после | Разблокирует |", "|---|---|---|---|---|---|"]
        for i in ids:
            w = wps[i]
            mark = " ⚑" if w.critical else ""
            out.append(
                f"| {i}{mark} | {short(w.name)} | {STAGE_TITLE[w.stage]} | {w.size} | "
                f"{', '.join(w.deps) or '—'} | {', '.join(w.blocks) or '—'} |"
            )
    return "\n".join(out) + "\n"


def cmd_validate(_: argparse.Namespace) -> int:
    wps, ordered = load()
    path, days = critical_path(wps)
    sched = schedule(wps)
    horizon = (max(b for _, b in sched.values()) - BASE_DATE).days + 1
    print(f"OK: {len(wps)} потоков, слоёв {max(w.level for w in wps.values()) + 1}, "
          f"путь {len(path)} потоков (~{days:g} дн.), условное расписание {horizon} дн.")
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    wps, ordered = load()
    text = build_report(wps, ordered)
    if args.check:
        if not REPORT.exists() or REPORT.read_text(encoding="utf-8") != text:
            print("docs/plan-dependencies.md устарел: выполните python3 scripts/work_packages.py report")
            return 1
        print("docs/plan-dependencies.md актуален")
        return 0
    REPORT.write_text(text, encoding="utf-8")
    print(f"Записан {REPORT.relative_to(ROOT)}")
    return 0


# ---------- GitHub ----------

_last_write = 0.0


def gh(*args: str, data=None, write=False) -> str:
    global _last_write
    for attempt in range(6):
        if write:
            time.sleep(max(0.0, 1.2 - (time.time() - _last_write)))
        r = subprocess.run(["gh", *args], input=json.dumps(data) if data is not None else None,
                           capture_output=True, text=True)
        if write:
            _last_write = time.time()
        if r.returncode == 0:
            return r.stdout
        err = r.stderr.lower()
        network = any(s in err for s in ("i/o timeout", "connection reset", "eof", "tls handshake", "no such host"))
        if network and not write:
            time.sleep(5 * (attempt + 1))
            continue
        if any(s in err for s in ("rate limit", "abuse", "secondary", "429", "502", "503")):
            wait = 30 * (attempt + 1)
            print(f"  … ограничение GitHub, пауза {wait} с", file=sys.stderr)
            time.sleep(wait)
            continue
        raise RuntimeError(f"gh {' '.join(args)}\n{r.stderr.strip()}")
    raise RuntimeError("Слишком много повторов")


def api(method: str, path: str, data=None, write=False):
    args = ["api", "-X", method, path, "-H", "Accept: application/vnd.github+json"]
    if data is not None:
        args += ["--input", "-"]
    out = gh(*args, data=data, write=write or method != "GET")
    return json.loads(out) if out.strip() else None


def api_list(path: str) -> list[dict]:
    out = gh("api", "--paginate", path, "--jq", ".[]")
    return [json.loads(line) for line in out.splitlines() if line.strip()]


def repo_name() -> str:
    return gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner").strip()


def area_labels(w: Wp) -> list[str]:
    z = w.zone.replace("`", "")
    if "apps/miniapp" in z:
        return ["area:frontend"]
    if "apps/bot" in z or "sender/max" in z or w.id.startswith("K-05"):
        return ["area:max"]
    if any(s in z for s in ("adapters", "docs/research", "ingest", "data/", "classifier", "synthetic")):
        return ["area:data"]
    zones = w.zone_paths
    if zones and all(p.startswith("docs/") or p == "README.md" for p in zones):
        return ["documentation"]
    return ["area:backend"]


def branch_hint(w: Wp) -> str:
    kind = "research" if "docs/research" in w.zone and w.name.startswith(("Разведка", "MAX")) else (
        "docs" if area_labels(w) == ["documentation"] else "feat")
    return f"<участник>/<исполнитель>/{kind}-{w.id.lower()}-<кратко>"


def epic_key(w: Wp) -> tuple[str, int | None]:
    return (w.stage, w.wave if w.stage == "core" else None)


def epic_title(key: tuple[str, int | None]) -> str:
    stage, wave = key
    return f"[Эпик] {STAGE_TITLE[stage]}" + (f" · {WAVE_TITLE[wave]}" if wave is not None else "")


def issue_body(w: Wp, numbers: dict[str, int]) -> str:
    deps = "\n".join(f"- #{numbers[d]} **{d}** — {short(numbers_title[d])}" for d in w.deps) or "Зависимостей нет — поток можно начинать сразу."
    extra = re.sub(ID_RE, "", w.raw_deps)
    extra = re.sub(r"[\s,;—()*\-]+", " ", extra).strip()
    note = f"\n\nУсловие старта из плана: {w.raw_deps}" if extra else ""
    return f"""**Поток {w.id}** · {STAGE_TITLE[w.stage]} · размер {w.size}{' · ⚑ критический путь' if w.critical else ''}

## Результат

{w.name}

## Критерии приёмки

- {w.done}
- Выполнен Definition of Done из [TEAM_GUIDE.md](../blob/main/TEAM_GUIDE.md).

## Область изменений (зона файлов)

{w.zone or 'Не ограничена планом; уточните перед началом.'}

## Старт после

{deps}{note}

## Как взять поток

1. Проверьте, что у Issue есть label `ready` (все блокирующие Issue закрыты).
2. Назначьте себя и поставьте label исполнителя (`agent:codex`, `agent:claude` или `agent:human`).
3. Создайте ветку `{branch_hint(w)}` и отдельный worktree от актуальной `origin/main`.
4. Меняйте только свою зону файлов. Контракты в `contracts/` — только отдельным PR `contract: …`.
5. В PR укажите `Closes #<номер этого Issue>`.

Подробности: [docs/agents/work-packages.md](../blob/main/docs/agents/work-packages.md) · план: [docs/roadmap.md](../blob/main/docs/roadmap.md) · зависимости: [docs/plan-dependencies.md](../blob/main/docs/plan-dependencies.md).
"""


numbers_title: dict[str, str] = {}


def cmd_sync(args: argparse.Namespace) -> int:
    wps, ordered = load()
    for i, w in wps.items():
        numbers_title[i] = w.name
    epics = sorted({epic_key(w) for w in wps.values()}, key=lambda k: (STAGES.index(k[0]), k[1] or 0))
    edges = sum(len(w.deps) for w in wps.values())
    print(f"Потоков {len(wps)}, эпиков {len(epics)}, зависимостей {edges}")
    if not args.apply:
        print("Пробный запуск. Для выполнения добавьте --apply.")
        first = ordered[0]
        print(f"\n--- пример Issue {wps[first].title}\n")
        print(issue_body(wps[ordered[-1]], {d: 0 for d in wps}))
        return 0

    repo = repo_name()
    print(f"Репозиторий: {repo}")

    have = {l["name"] for l in api_list(f"repos/{repo}/labels?per_page=100")}
    for name, (color, desc) in LABELS.items():
        if name not in have:
            api("POST", f"repos/{repo}/labels", {"name": name, "color": color, "description": desc})
            print(f"  label {name}")

    ms_have = {m["title"]: m["number"] for m in api_list(f"repos/{repo}/milestones?state=all&per_page=100")}
    ms_no: dict[str, int] = {}
    for stage, (title, due, desc) in MILESTONES.items():
        if title not in ms_have:
            body = {"title": title, "description": desc}
            if due:
                body["due_on"] = f"{due}T00:00:00Z"
            ms_have[title] = api("POST", f"repos/{repo}/milestones", body)["number"]
            print(f"  milestone {title}")
        ms_no[stage] = ms_have[title]

    existing = {}
    for it in api_list(f"repos/{repo}/issues?state=all&per_page=100&labels=wp"):
        m = re.match(r"\[([^\]]+)\]", it["title"])
        if m:
            existing[m.group(1)] = it
    if args.refresh:
        known = {i: it["number"] for i, it in existing.items()}
        changed = 0
        for i in ordered:
            it = existing.get(i)
            if not it:
                continue
            body = issue_body(wps[i], known)
            if it["title"] != wps[i].title or (it.get("body") or "") != body:
                api("PATCH", f"repos/{repo}/issues/{it['number']}", {"title": wps[i].title, "body": body})
                changed += 1
                print(f"  обновлён #{it['number']} {wps[i].title}")
        print(f"Обновлено Issues: {changed}")
        return 0

    epic_existing = {it["title"]: it for it in api_list(f"repos/{repo}/issues?state=all&per_page=100&labels=epic")}

    epic_issue: dict[tuple, dict] = {}
    for key in epics:
        title = epic_title(key)
        if title in epic_existing:
            epic_issue[key] = epic_existing[title]
            continue
        members = [w for w in wps.values() if epic_key(w) == key]
        body = (f"Группа потоков: **{title[8:]}**.\n\nПотоков: {len(members)}. "
                f"Состав и прогресс — в разделе sub-issues. План: [docs/roadmap.md](../blob/main/docs/roadmap.md).")
        epic_issue[key] = api("POST", f"repos/{repo}/issues", {
            "title": title, "body": body, "labels": ["epic", f"stage:{key[0]}"], "milestone": ms_no[key[0]]})
        print(f"  эпик #{epic_issue[key]['number']} {title}")

    nums: dict[str, int] = {}
    ids: dict[str, int] = {}
    for i, it in existing.items():
        nums[i], ids[i] = it["number"], it["id"]
    created = 0
    for i in ordered:
        if i in nums:
            continue
        w = wps[i]
        labels = ["wp", f"stage:{w.stage}", f"size:{w.size}"] + area_labels(w)
        if w.critical:
            labels.append("critical-path")
        if not w.deps:
            labels.append("ready")
        if i in HUMAN_ONLY:
            labels.append("agent:human")
        if w.name.startswith("Разведка") or (i.startswith("K-05") or i == "K-18c"):
            labels.append("research")
        it = api("POST", f"repos/{repo}/issues", {
            "title": w.title, "body": issue_body(w, nums), "labels": labels, "milestone": ms_no[w.stage]})
        nums[i], ids[i] = it["number"], it["id"]
        created += 1
        print(f"  #{it['number']} {w.title}")
    print(f"Создано Issues: {created}")

    for key, epic in epic_issue.items():
        have_sub = {s["id"] for s in api_list(f"repos/{repo}/issues/{epic['number']}/sub_issues?per_page=100")}
        for w in sorted((w for w in wps.values() if epic_key(w) == key), key=lambda x: x.id):
            if ids[w.id] not in have_sub:
                api("POST", f"repos/{repo}/issues/{epic['number']}/sub_issues", {"sub_issue_id": ids[w.id]})
        print(f"  sub-issues: {epic['title']}")

    added = 0
    for i in ordered:
        w = wps[i]
        if not w.deps:
            continue
        have_dep = {d["id"] for d in api_list(f"repos/{repo}/issues/{nums[i]}/dependencies/blocked_by?per_page=100")}
        for d in w.deps:
            if ids[d] not in have_dep:
                api("POST", f"repos/{repo}/issues/{nums[i]}/dependencies/blocked_by", {"issue_id": ids[d]})
                added += 1
    print(f"Добавлено зависимостей: {added}")
    return 0


# ---------- GitHub Project ----------

VIEWS = [
    ("Доступно сейчас", "TABLE_LAYOUT", "is:open label:ready"),
    ("Критический путь", "TABLE_LAYOUT", "is:open label:critical-path"),
    ("Ядро", "TABLE_LAYOUT", 'is:open label:"stage:core"'),
]
PROGRESS_VIEW = ("Прогресс этапов", "TABLE_LAYOUT", "label:epic")
VIEW_FIELDS = {
    "Канбан": ["Title", "Assignees", "Linked pull requests", "Priority", "Size", "Этап", "Sub-issues progress"],
    "Бэклог": ["Title", "Assignees", "Priority", "Size", "Area", "Этап", "Слой", "Target date", "Sub-issues progress"],
    "Моя работа": ["Title", "Status", "Linked pull requests", "Priority", "Size", "Этап", "Target date", "Sub-issues progress"],
    "Доступно сейчас": ["Title", "Assignees", "Status", "Этап", "Size", "Priority", "Sub-issues progress"],
    "Критический путь": ["Title", "Assignees", "Status", "Слой", "Size", "Sub-issues progress"],
    "Ядро": ["Title", "Assignees", "Status", "Слой", "Size", "Критический путь", "Sub-issues progress"],
    "Прогресс этапов": ["Title", "Этап", "Status", "Start date", "Target date", "Sub-issues progress"],
}
SIZE_MAP = {"S": "Small", "M": "Medium", "L": "Large"}
AREA_MAP = {"area:frontend": "Mini app", "area:max": "MAX integration", "area:data": "Data",
            "area:backend": "Backend", "documentation": "Product"}
EXTRA_FIELDS = {
    "Этап": ("SINGLE_SELECT", [(STAGE_TITLE[k], "BLUE", "") for k in STAGES]),
    "Критический путь": ("SINGLE_SELECT", [("Да", "RED", ""), ("Нет", "GRAY", "")]),
    "Слой": ("NUMBER", None),
    "Start date": ("DATE", None),
    "Поток": ("TEXT", None),
}


def gql(query: str, **variables) -> dict:
    args = ["api", "graphql", "-f", f"query={query}"]
    for k, v in variables.items():
        if v is None:
            continue
        args += ["-F" if isinstance(v, int) and not isinstance(v, bool) else "-f", f"{k}={v}"]
    out = json.loads(gh(*args, write=True))
    if out.get("errors"):
        raise RuntimeError(json.dumps(out["errors"], ensure_ascii=False))
    return out["data"]


def options_literal(options: list[tuple[str, str, str]]) -> str:
    return "[" + ",".join(
        "{name:%s,color:%s,description:%s}" % (json.dumps(n, ensure_ascii=False), c, json.dumps(d, ensure_ascii=False))
        for n, c, d in options) + "]"


def cmd_project(args: argparse.Namespace) -> int:
    wps, ordered = load()
    repo = repo_name()
    owner = repo.split("/")[0]
    print(f"Проект №{args.number} пользователя {owner}: заполнение полей для {len(wps)} потоков")
    issues = {it["number"]: it for it in api_list(f"repos/{repo}/issues?state=all&per_page=100&labels=wp")
              + api_list(f"repos/{repo}/issues?state=all&per_page=100&labels=epic")}
    done: dict[str, date] = {}
    for it in issues.values():
        m = re.match(r"\[([^\]]+)\]", it["title"])
        if m and m.group(1) in wps and it["state"] == "closed" and it.get("state_reason") == "completed" and it.get("closed_at"):
            done[m.group(1)] = date.fromisoformat(it["closed_at"][:10])
    today = date.today()
    sched = schedule(wps, done, today)
    submit = [b for i, (_, b) in sched.items() if wps[i].stage in ("core", "2", "3") and i != "2-16"]
    print(f"Закрыто потоков: {len(done)} из {len(wps)}. Условное расписание от {today}: "
          f"ядро и этапы 2–3 заканчиваются {max(submit, default=today)} (при неограниченном числе исполнителей)")
    if not args.apply:
        print("Пробный запуск. Для выполнения добавьте --apply (нужен scope `project`).")
        return 0

    project = gql("query($l:String!,$n:Int!){user(login:$l){projectV2(number:$n){id title url}}}",
                  l=owner, n=args.number)["user"]["projectV2"]
    pid = project["id"]
    print(f"Проект: {project['title']} {project['url']}")

    def fields() -> dict[str, dict]:
        d = gql("query($p:ID!){node(id:$p){... on ProjectV2{fields(first:60){nodes{"
                "... on ProjectV2FieldCommon{id name dataType}"
                "... on ProjectV2SingleSelectField{id name dataType options{id name}}}}}}}", p=pid)
        return {f["name"]: f for f in d["node"]["fields"]["nodes"] if f}

    have = fields()
    for fname, (kind, opts) in EXTRA_FIELDS.items():
        if fname in have:
            continue
        extra = f",singleSelectOptions:{options_literal(opts)}" if opts else ""
        gql("mutation($p:ID!,$n:String!){createProjectV2Field(input:{projectId:$p,dataType:%s,name:$n%s}){clientMutationId}}"
            % (kind, extra), p=pid, n=fname)
        print(f"  поле {fname}")
    have = fields()

    def field_ids(names: list[str]) -> str:
        for n in names:
            if n not in have:
                print(f"  предупреждение: в проекте нет поля «{n}», столбец пропущен", file=sys.stderr)
        return "[" + ",".join('"%s"' % have[n]["id"] for n in names if n in have) + "]"

    def setup_views() -> None:
        vs = gql("query($p:ID!){node(id:$p){... on ProjectV2{views(first:30){nodes{id name}}}}}", p=pid)["node"]["views"]["nodes"]
        by_name = {v["name"]: v["id"] for v in vs}
        vname, layout, flt = PROGRESS_VIEW
        if vname not in by_name:
            v = gql("mutation($p:ID!,$n:String!){createProjectV2View(input:{projectId:$p,name:$n,layout:%s}){projectV2View{id}}}"
                    % layout, p=pid, n=vname)["createProjectV2View"]["projectV2View"]
            gql("mutation($v:ID!,$f:String!){updateProjectV2View(input:{viewId:$v,filter:$f}){clientMutationId}}", v=v["id"], f=flt)
            by_name[vname] = v["id"]
            print(f"  вид {vname}")
        for name, cols in VIEW_FIELDS.items():
            if name in by_name:
                gql("mutation($v:ID!){updateProjectV2View(input:{viewId:$v,configuration:{visibleFieldIds:%s}}){clientMutationId}}"
                    % field_ids(cols), v=by_name[name])
                print(f"  поля вида «{name}»: {', '.join(cols)}")

    if args.views:
        setup_views()
        if not args.dates:
            print(f"Готово: {project['url']}")
            return 0

    def option(field: str, key: str) -> str:
        for o in have[field]["options"]:
            if key.lower() in o["name"].lower():
                return o["id"]
        raise ValueError(f"В поле {field} нет варианта «{key}»")

    views = gql("query($p:ID!){node(id:$p){... on ProjectV2{views(first:30){nodes{id name}}}}}", p=pid)["node"]["views"]["nodes"]
    have_views = {v["name"] for v in views}
    for vname, layout, flt in VIEWS:
        if vname in have_views:
            continue
        v = gql("mutation($p:ID!,$n:String!){createProjectV2View(input:{projectId:$p,name:$n,layout:%s}){projectV2View{id}}}"
                % layout, p=pid, n=vname)["createProjectV2View"]["projectV2View"]
        gql("mutation($v:ID!,$f:String!){updateProjectV2View(input:{viewId:$v,filter:$f}){clientMutationId}}", v=v["id"], f=flt)
        print(f"  вид {vname}")

    epic_range: dict[str, tuple[date, date]] = {}
    for key in {epic_key(w) for w in wps.values()}:
        rng = [sched[w.id] for w in wps.values() if epic_key(w) == key]
        epic_range[epic_title(key)] = (min(a for a, _ in rng), max(b for _, b in rng))
    items = json.loads(gh("project", "item-list", str(args.number), "--owner", owner, "--limit", "500", "--format", "json"))["items"]

    def lit(kind: str, val) -> str:
        return {"select": lambda: '{singleSelectOptionId:"%s"}' % val, "number": lambda: "{number:%s}" % val,
                "text": lambda: "{text:%s}" % json.dumps(val, ensure_ascii=False), "date": lambda: '{date:"%s"}' % val}[kind]()

    mutations: list[str] = []

    def setv(item_id: str, field: str, kind: str, val) -> None:
        mutations.append('m%d:updateProjectV2ItemFieldValue(input:{projectId:"%s",itemId:"%s",fieldId:"%s",value:%s}){clientMutationId}'
                         % (len(mutations), pid, item_id, have[field]["id"], lit(kind, val)))

    touched = 0
    for it in items:
        num = (it.get("content") or {}).get("number")
        issue = issues.get(num)
        if not issue or (it["content"].get("type") != "Issue"):
            continue
        labels = {l["name"] for l in issue["labels"]}
        m = re.match(r"\[([^\]]+)\]", issue["title"])
        w = wps.get(m.group(1)) if m and "epic" not in labels else None
        stage = w.stage if w else next((l.split(":", 1)[1] for l in labels if l.startswith("stage:")), "core")
        iid, cur_status = it["id"], it.get("status") or ""
        want = "Done" if issue["state"] == "closed" else ("Ready" if "ready" in labels else "Backlog")
        if not cur_status or ("Done" in cur_status and issue["state"] == "open"):
            setv(iid, "Status", "select", option("Status", want))
        span = sched[w.id] if w else epic_range.get(issue["title"])
        if span:
            setv(iid, "Start date", "date", span[0].isoformat())
            setv(iid, "Target date", "date", span[1].isoformat())
        if args.dates:
            touched += 1
            continue
        setv(iid, "Этап", "select", option("Этап", STAGE_TITLE[stage]))
        if not it.get("agent"):
            setv(iid, "Agent", "select", option("Agent", "Без агента"))
        if w:
            setv(iid, "Критический путь", "select", option("Критический путь", "Да" if w.critical else "Нет"))
            setv(iid, "Слой", "number", w.level)
            setv(iid, "Поток", "text", w.id)
            if not it.get("size"):
                setv(iid, "Size", "select", option("Size", SIZE_MAP[w.size]))
            if not it.get("priority"):
                setv(iid, "Priority", "select", option("Priority", "High" if w.critical else "Medium"))
            if not it.get("area"):
                area = "Research" if "research" in labels else next((AREA_MAP[l] for l in labels if l in AREA_MAP), None)
                if area:
                    setv(iid, "Area", "select", option("Area", area))
        touched += 1
    print(f"Карточек к обновлению: {touched}, изменений полей: {len(mutations)}")
    for i in range(0, len(mutations), 12):
        chunk = mutations[i:i + 12]
        gql("mutation{%s}" % " ".join(f"m{n}:" + c.split(":", 1)[1] for n, c in enumerate(chunk)))
        print(f"  записано {min(i + 12, len(mutations))}/{len(mutations)}")
    print(f"Готово: {project['url']}")
    return 0


def main() -> int:
    sys.stdout.reconfigure(line_buffering=True)
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("validate").set_defaults(fn=cmd_validate)
    r = sub.add_parser("report")
    r.add_argument("--check", action="store_true")
    r.set_defaults(fn=cmd_report)
    s = sub.add_parser("sync")
    s.add_argument("--apply", action="store_true")
    s.add_argument("--refresh", action="store_true", help="обновить заголовки и тексты уже созданных Issue из roadmap.md")
    s.set_defaults(fn=cmd_sync)
    pr = sub.add_parser("project")
    pr.add_argument("--number", type=int, default=1, help="номер существующего проекта пользователя")
    pr.add_argument("--dates", action="store_true", help="обновить только Start date и Target date (скользящее расписание от сегодня)")
    pr.add_argument("--views", action="store_true", help="настроить видимые поля видов и создать вид «Прогресс этапов»")
    pr.add_argument("--apply", action="store_true")
    pr.set_defaults(fn=cmd_project)
    args = p.parse_args()
    try:
        return args.fn(args)
    except (ValueError, RuntimeError) as e:
        print(f"Ошибка: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
