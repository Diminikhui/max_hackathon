# Контракты

Контракты данных между потоками: JSON Schema (draft 2020-12) — источник правды, TypeScript-типы и порты — в [`packages/domain`](../packages/domain/src/). Тест `pnpm --filter @max-hackathon/domain test` проверяет, что примеры проходят схемы, некорректные примеры отклоняются, а перечисления TS совпадают со схемами.

## Версия

`contractVersion = 1`. Каждый документ верхнего уровня несёт поле `contractVersion`.

После слияния K-02 каталог `contracts/` меняется только отдельным PR `contract: …`: повысьте `contractVersion` при несовместимом изменении, обновите типы в `packages/domain`, примеры и тест, перечислите в PR затронутые Issue. Запросить изменение — форма «Запрос изменения контракта».

## Состав v1

| Схема | Что это | Кто производит → кто потребляет |
|---|---|---|
| [`common`](v1/common.schema.json) | `SourceRef`, `LegalBasis`, `Period`, `Inn`, `FactKind`, `ApplicabilityStatus` | — |
| [`fact`](v1/fact.schema.json) | Факт о компании с происхождением | адаптеры профиля, сервис профиля → вычислитель |
| [`company-profile`](v1/company-profile.schema.json) | Профиль: ИНН + факты | `ProfileSource` → сервис профиля, хранилище |
| [`requirement`](v1/requirement.schema.json) | Запись пакета: обязанность или возможность, основание, условие | пакеты правил, `RequirementSource` → вычислитель |
| [`condition-result`](v1/condition-result.schema.json) | Результат узла условия (да / нет / неизвестно) и трасса | K-16a → K-16b, K-16c |
| [`applicability-result`](v1/applicability-result.schema.json) | Один из 5 статусов, трасса и цепочка объяснения | K-16b, K-16c → перечень, бот, мини-приложение |
| [`change-event`](v1/change-event.schema.json) | Новая версия пакета, документ из ленты или изменение профиля | ingest, публикация пакета, сервис профиля → планировщик |
| [`notification-candidate`](v1/notification-candidate.schema.json) | «Этой компании нужно сообщить» | K-20a → K-20b |
| [`notification`](v1/notification.schema.json) | Сообщение бота и статус доставки | K-20b, K-23 → K-21a |

Примеры — [`v1/examples/`](v1/examples/), заведомо некорректные — [`v1/invalid/`](v1/invalid/). Имя файла: `<схема>.<случай>.json`. Все примеры — модельные данные с вымышленными ИНН.

## Правила, заложенные в схемы

- **Пять статусов:** `applies`, `not_applies`, `insufficient_data`, `needs_review`, `out_of_coverage`. Для `insufficient_data` обязателен непустой `missingFactKeys` — что спросить у пользователя.
- **Неизвестно ≠ null.** Отсутствующий факт означает «неизвестно»; `value: null` запрещён.
- **Четыре типа фактов:** `official`, `declared`, `derived` (с обязательным `derivedFrom`), `scenario`. Заявленный факт хранится рядом с официальным и не затирает его.
- **Модельные данные:** `SourceRef.isModel`, `CompanyProfile.isModel`, `ChangeEvent.isModel`, `Notification.isModel`. Если `true` — интерфейс помечает данные модельными.
- **Первоисточник:** у `Requirement` минимум одно основание со ссылкой; у `Notification` минимум одна ссылка в `sourceUrls`; шаг объяснения `source` обязан иметь `url`. `Notification.automated` — в тексте есть пометка об автоматической обработке.
- **Условие применимости** (`Requirement.condition`) в v1 — объект с полем `type`; полный формат задаёт K-15a в `contracts/rulepack/conditions/`. `Requirement.coverage`: `full`, `partial` (результат не выше `needs_review`), `none` (`out_of_coverage`).
- **Лента изменений** даёт только ранний сигнал: кандидат `early_signal` имеет статус не выше `needs_review`. Сферы regulation.gov.ru (`sphereIds`) — не коды ОКВЭД.

## Известные ключи фактов v1

Ключ — сегменты в нижнем регистре через точку. Список открыт: новый ключ добавьте сюда и в `FACT_KEYS` (`packages/domain/src/contracts.ts`) в своём PR.

| Ключ | Значение | Источник |
|---|---|---|
| `activity.okved_main` | основной ОКВЭД, строка `56.10` | реестр МСП, ЕГРЮЛ |
| `activity.okved_additional` | дополнительные ОКВЭД, массив строк | реестр МСП, ЕГРЮЛ |
| `location.region_code` | код субъекта РФ, строка `77` | реестр МСП |
| `scale.msp_category` | `micro`, `small`, `medium` | реестр МСП |
| `employment.headcount` | среднесписочная численность, число | реестр МСП |
| `employment.has_employees` | есть ли работники, boolean | вычисляется из `headcount` или заявляется |
| `tax.regime` | налоговый режим, строка | заявляется |
| `licenses.has_any` | есть ли лицензии, boolean | реестр МСП |
| `sales.alcohol` | `none`, `beer`, `strong` | заявляется |

## Порты

`packages/domain/src/ports.ts`: `ProfileSource`, `RequirementSource`, `ProfileRepository`, `RequirementRepository`, `ApplicabilityRepository`, `ChangeEventRepository`, `NotificationRepository`. Каждая реализация источника сообщает `info.isModel`. Порт `DocumentStore` задаёт K-18b, `OpportunitySource` — 2-06.
