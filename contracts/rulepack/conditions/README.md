# Формат условий применимости

Условие применимости записи пакета правил (`Requirement.condition`) — дерево узлов. Схема — [`condition.schema.json`](condition.schema.json), TS-типы — `ConditionNode` в `@max-hackathon/domain`. Как условие встраивается в пакет, задаёт K-15b.

Условие проверяет только факты профиля (`contracts/README.md`, «Известные ключи фактов»). Всё, что нельзя выразить через факты, не пишется в условие: запись получает `coverage: partial` или `none` (`contracts/v1/requirement.schema.json`).

## Вычисление: три значения

Каждый узел даёт `yes`, `no` или `unknown` (`ConditionResult.outcome`). Вычисление детерминировано и не использует ИИ.

- **Лист** (всё, кроме `all`, `any`, `not`, `always`): нужного факта нет в профиле → `unknown`; факт есть → `yes` или `no`. Факт `scenario` учитывается только в режиме «что будет, если…».
- **`all`**: `no`, если хотя бы один дочерний узел `no`; `yes`, если все `yes`; иначе `unknown`.
- **`any`**: `yes`, если хотя бы один `yes`; `no`, если все `no`; иначе `unknown`.
- **`not`**: `yes` ↔ `no`; `unknown` остаётся `unknown`.
- **`always`**: всегда `yes`.

`unknown` в корне даёт статус `insufficient_data`; `missingFactKeys` — ключи отсутствующих фактов из листьев с `unknown`, которые влияют на результат. Трасса (`ConditionResult`) повторяет дерево: путь корня `$`, дочерних — `$.items[0]`, `$.item`.

Если для ключа есть и официальный, и заявленный факт, вычислитель берёт официальный (заявленный не затирает официальный, K-25b). Это правило K-16a, а не формата.

## Узлы

| type | Поля | Факт | yes, если |
|---|---|---|---|
| `always` | — | — | всегда |
| `all` | `items` (≥1) | — | все дочерние `yes` |
| `any` | `items` (≥1) | — | хотя бы один дочерний `yes` |
| `not` | `item` | — | дочерний `no` |
| `okved_prefix` | `prefix`, `scope` = `main` (по умолчанию) или `main_or_additional` | `activity.okved_main` (+ `activity.okved_additional`) | код начинается с `prefix` |
| `region` | `codes` (≥1, две цифры) | `location.region_code` | код входит в `codes` |
| `msp_category` | `in` (≥1): `micro`, `small`, `medium` | `scale.msp_category` | категория входит в `in` |
| `has_employees` | `value` (boolean) | `employment.has_employees` | факт равен `value` |
| `headcount` | `min`, `max` (хотя бы одно, включительно) | `employment.headcount` | `min ≤ численность ≤ max` |
| `tax_regime` | `in` (≥1) | `tax.regime` | режим входит в `in`; если режимов в факте несколько — есть пересечение |
| `fact_equals` | `key`, `value` | `key` | факт равен `value` |
| `fact_in` | `key`, `values` (≥1) | `key` | факт входит в `values`; для факта-массива — есть пересечение |
| `fact_range` | `key`, `min`, `max` (хотя бы одно, включительно) | `key` (число) | `min ≤ факт ≤ max` |

Уточнения:

- **`okved_prefix`** — строковый префикс по иерархии ОКВЭД: `56` находит `56`, `56.10`, `56.10.1`; `45.2` находит `45.20`, `45.20.1`. Префикс — от двух цифр (`^[0-9]{2}(\.[0-9]{1,2}){0,2}$`). При `main_or_additional`: `yes`, если подходит основной или любой дополнительный код; `no` — если оба факта есть и ни один не подходит; иначе `unknown`.
- **`has_employees`** читает только `employment.has_employees`. Вычисление этого факта из `employment.headcount` — дело профиля (факт `derived`), а не условия.
- Сравнение с фактом другого типа (строка вместо числа и т. п.) — ошибка данных, а не `no`: вычислитель возвращает `unknown` и сообщает об ошибке.

## Значения фактов для условий

| Ключ | Значения |
|---|---|
| `tax.regime` | `osno` — общий режим; `usn_income` — УСН «доходы»; `usn_income_expenses` — УСН «доходы минус расходы»; `psn` — патент; `eshn` — ЕСХН; `ausn` — АУСН; `npd` — налог на профессиональный доход. Строка или массив строк (патент вместе с УСН) |
| `scale.msp_category` | `micro`, `small`, `medium` |
| `sales.alcohol` | `none`, `beer`, `strong` |

## Пример

Кофейня с работниками (ОКВЭД 56 и есть работники):

```json
{
  "type": "all",
  "items": [
    { "type": "okved_prefix", "prefix": "56" },
    { "type": "has_employees", "value": true }
  ]
}
```

Остальные примеры — [`examples/`](examples/): все модельные, условия и пороги в них иллюстративные и не являются юридическими утверждениями. Заведомо некорректные — [`invalid/`](invalid/).

## Изменение формата

Новый тип узла или новое значение перечисления — PR `contract: …`: схема, `ConditionNode` и константы в `packages/domain/src/conditions.ts`, пример в `examples/`, строка в таблице выше. Тест `pnpm --filter @max-hackathon/domain test` проверяет, что у каждого типа есть пример и ветка в схеме, а перечисления TS совпадают со схемой.
