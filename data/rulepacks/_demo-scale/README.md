# Демонстрация тиражирования (3-02) — МОДЕЛЬНЫЕ ДАННЫЕ

Показывает, что новое направление и новый регион подключаются **одним файлом пакета** через `pack add` — без изменения кода.

| Что | Значение |
| --- | --- |
| Пакет | `d-beauty-spb-demo-v1.json`, `packId: d-beauty-spb-demo`, `isModel: true` |
| Четвёртое направление | D — парикмахерские и салоны красоты, ОКВЭД `96.02` (после A — общепит, B — автосервис, C — розница) |
| Третий регион | Санкт-Петербург, код `78` (после Москвы и Татарстана) |
| Записи | 3 федеральные (`d.fed.*`, условие — ОКВЭД) и 1 региональная (`d.spb.*`, условие — ОКВЭД и регион `78`) |
| Компании | `demo-companies.json`: салон в Санкт-Петербурге (`7800000010`) и салон в Воронеже (`3600000015`), модельные ИНН |

**Это модельный пакет.** Основания ссылаются на реальные акты (ПП РФ № 1514, СП 2.1.3678-20, 54-ФЗ, ПП Санкт-Петербурга № 961), но записи не прошли предметную проверку, как пакеты A и B (эталон K-06a показал, что без неё ошибаются 14 из 18 записей). Поэтому пакет и все записи помечены `isModel: true`, лежат в `_demo-scale/` и **не устанавливаются в рабочий реестр** `data/rulepacks/installed`. Все записи имеют `coverage: partial` и дают «требуется проверка», а не «применяется».

## Как воспроизвести

Из корня репозитория после `pnpm install` и `pnpm -r run build`:

```bash
# 1. Пакет проходит валидатор K-15c
node tools/rulepack-validate/rulepack-validate.mjs data/rulepacks/_demo-scale/d-beauty-spb-demo-v1.json

# 2. Отдельный реестр: пакеты A, B и новый пакет D подключаются одной командой каждый
REG=$(mktemp -d)
for pack in a/foodservice-federal-v1 b/autoservice-federal-v1 _demo-scale/d-beauty-spb-demo-v1; do
  node tools/pack/pack.mjs add "data/rulepacks/$pack.json" --registry "$REG"
done

# 3. Перечень для модельных компаний — тем же движком правил, что и в продукте
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { loadActiveRulepacks } from './packages/rules/loader/rulepack-loader.mjs';
import { assessRequirement } from './packages/rules/dist/index.js';
const packs = await loadActiveRulepacks(process.argv[1]);
for (const company of JSON.parse(readFileSync('data/rulepacks/_demo-scale/demo-companies.json', 'utf8'))) {
  console.log(company.displayName);
  for (const pack of packs) for (const requirement of pack.requirements) {
    const result = assessRequirement(requirement, company, { evaluatedAt: '2026-09-27T12:00:00Z', asOf: '2026-09-27' });
    if (result.status !== 'not_applies') console.log('  ' + result.status.padEnd(14) + requirement.id);
  }
}" "$REG"
```

Ожидаемый результат (проверено 27.09.2026):

```text
Салон «Модель», Санкт-Петербург (модельные данные)
  needs_review  d.fed.household-services-information
  needs_review  d.fed.sanitary-beauty-services
  needs_review  d.fed.cash-register-receipt
  needs_review  d.spb.signage-placement
Салон «Модель», Воронеж (модельные данные)
  needs_review  d.fed.household-services-information
  needs_review  d.fed.sanitary-beauty-services
  needs_review  d.fed.cash-register-receipt
```

Петербургский салон получает федеральные записи и региональную; воронежский — только федеральные. Записи пакетов A и B к салонам не применяются.

## Что доказывает и чего нет

- **Код не менялся.** Изменения этого потока — только `data/rulepacks/_demo-scale/`; направление и регион заданы условиями записей (`okved_prefix`, `region`), загрузчик и движок правил те же.
- **Отчёт о покрытии (K-34)** узнаёт о направлении из своего каталога (`DEFAULT_COVERAGE_CATALOG`). Для показа в боте направление D нужно добавить туда одной строкой данных; без неё салон увидит записи пакета, но сообщение о покрытии скажет «ОКВЭД вне направлений».
- **Не для пользователей.** Чтобы превратить демонстрацию в рабочий пакет, нужна предметная проверка записей по процессу K-06 → K-17 и снятие `isModel`.
