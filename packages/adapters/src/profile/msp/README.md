# `MspProfileSource` — профиль компании из реестра МСП (K-12b)

Основной источник профиля ([ADR-0006](../../../../../docs/decisions/0006-adopted-gap-proposals.md), п. 7): одним запросом по ИНН даёт ОКВЭД, регион, категорию МСП, численность и признак лицензий. Запасной источник — ЕГРЮЛ/ЕГРИП (K-12a), модельный — `FixtureProfileSource` (K-11).

```ts
import { MspProfileSource } from "@max-hackathon/adapters";

const result = await new MspProfileSource().lookupByInn(inn);
// found → result.profile (CompanyProfile v1, isModel = false)
// not_found → ИНН нет в действующем реестре МСП: брать запасной источник или спросить пользователя
// unavailable → errorCode: msp_timeout | msp_network | msp_http_<код> | msp_bad_response; retryable — можно повторить позже
```

## Источник

- Запрос: `POST https://rmsp.nalog.ru/search-proc.json`, форма `mode=quick&query=<ИНН>` — тот же, что делает страница поиска [rmsp.nalog.ru](https://rmsp.nalog.ru/search.html). Авторизация не нужна, сертификат сайта проверяется стандартными корнями Node.
- Быстрый поиск ищет и по подстроке, поэтому адаптер берёт только запись с точным совпадением ИНН.

| Поле ответа | Факт профиля | Правило |
| --- | --- | --- |
| `okved1` | `activity.okved_main` | основной ОКВЭД, строка |
| `regioncode` | `location.region_code` | код субъекта, две цифры |
| `category` | `scale.msp_category` | `1` → `micro`, `2` → `small`, `3` → `medium`; иное — факт не создаётся |
| `od2_sschr` | `employment.headcount` | среднесписочная численность; поле бывает пустым |
| `od2_sschr ≥ 1` | `employment.has_employees = true` (derived) | из нуля или отсутствия `false` не выводится (выводы K-06a) — бот спросит сам (K-09) |
| `has_licenses` | `licenses.has_any` | `0`/`1` → boolean |
| `name_ex` | `displayName` | у ИП это ФИО — не логировать |
| `ogrn` | `source.recordId` | |

Все факты — `official`, `source.system = "rmsp.nalog.ru"`, `observedAt` = момент запроса. Дополнительных ОКВЭД ответ не содержит.

## Ограничения

- **Внутренний интерфейс без спецификации.** Формат может измениться без уведомления; при несовпадении формата адаптер отвечает `unavailable` (`msp_bad_response`), а не ломает сценарий. Допустимость по ограничению кейса о «частных API» — открытый вопрос организаторам (roadmap, «Вопросы»); решение команды — использовать с описанием здесь.
- **Нестабильный отклик.** Отдельные запросы висят дольше 30 с или обрываются. Таймаут 20 с и один повтор при временной ошибке; частый опрос не делать — возможны лимиты и защита от ботов.
- **Исключённые компании.** Ответ содержит записи, исключённые из реестра (`is_active = 0`, `category = 0`); адаптер считает их `not_found`.
- **Срез, а не первичные данные.** Реестр обновляется 10-го числа месяца; численность — за прошлый год или ранее (см. [K-04b](../../../../../docs/research/k04b-msp-registers.md)).
- **Запасной вариант** при закрытии интерфейса — открытый набор ФНС [`7707329152-rsmp`](https://www.nalog.gov.ru/opendata/7707329152-rsmp/) с локальным индексом по ИНН (вариант A в K-04b).

## Тесты

- `test/profile/msp/msp.test.ts` — общий контракт `ProfileSource` и поведение адаптера на `recorded-response.json`: структура записана с реального ответа 27.09.2026, ИНН, ОГРН и названия заменены вымышленными (модельные данные).
- Живая проверка контракта на реальном ответе ФНС — только локально, ИНН в репозиторий не попадает:

```bash
MSP_LIVE_INN=<ИНН субъекта МСП> pnpm --filter @max-hackathon/adapters exec vitest run test/profile/msp --testTimeout 150000
```
