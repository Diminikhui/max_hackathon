# @max-hackathon/storage

Хранилище на PostgreSQL: подключение, миграции и реализации портов из `@max-hackathon/domain` (`ports.ts`).

## Подключение

Все репозитории принимают `SqlClient` — `query(sql, params)`, `exec(sql)` для скриптов из нескольких выражений и `transaction(fn)`.

```ts
import { createPgClient, runMigrations, PostgresProfileRepository } from "@max-hackathon/storage";

const db = createPgClient(process.env.DATABASE_URL!); // node-postgres
await runMigrations(db);                               // при старте приложения
const profiles = new PostgresProfileRepository(db);
```

`createPgliteClient(new PGlite())` даёт тот же интерфейс поверх PGlite — PostgreSQL в WASM без сервера. Он используется в тестах; `@electric-sql/pglite` — только devDependency.

## Миграции

- Файлы в `migrations/`, имя `<поток>-NNN-<суть>.sql` (например `k-10a-001-profiles.sql`); другое имя — ошибка.
- Применяются **по алфавиту имени**, каждая в своей транзакции; применённые записываются в `schema_migrations`. Повторный запуск ничего не делает.
- Применённую миграцию не меняйте — добавляйте новую со следующим номером.
- **Порядок между потоками — по имени файла:** `k-10a-…` < `k-10b-…` < `k-10c-…`. Миграция может ссылаться (внешний ключ) только на таблицы из миграций с меньшим именем.
- Для Docker (K-07): каталог `migrations/` должен попасть в образ рядом с `dist/` — путь считается от `dist/db/migrate.js` (`MIGRATIONS_DIR`).

## Тесты

Интеграционные тесты идут на настоящем PostgreSQL в PGlite — Docker не нужен ни локально, ни в CI.

```ts
import { createTestDatabase } from "../support/test-db.js"; // packages/storage/test/support/
const db = await createTestDatabase(); // новая пустая БД с применёнными миграциями
// …
await db.close();
```

## Как хранятся данные

Документ контракта целиком лежит в колонке `data jsonb` — чтение возвращает ровно то, что записано (включая формат дат). Отдельные колонки (`inn`, `key`, `kind` и т. п.) нужны для поиска, индексов и ограничений. Этот шаблон рекомендуется и для K-10b/K-10c.

| Таблица | Поток | Что хранит |
|---|---|---|
| `companies` | K-10a | `CompanyProfile` без фактов; ИНН уникален |
| `facts` | K-10a | `Fact` с порядком внутри профиля |
| `rulepack_versions` | K-10b | опубликованные версии пакетов правил |
| `requirements` | K-10b | `Requirement` версии пакета в исходном порядке |
| `change_events` | K-10c | `ChangeEvent`; id уникален |
| `notification_candidates` | K-10c | `NotificationCandidate`; пара (`company_id`, `dedup_key`) уникальна |
| `notifications` | K-10c | `Notification` со статусом доставки; `idempotency_key` уникален |

## ProfileRepository (K-10a)

- `save(profile)` заменяет профиль целиком, включая набор фактов.
- `addFacts(companyId, facts)` добавляет факты, ничего не удаляя; тот же `id` — замена (повтор идемпотентен). Заявленный факт хранится рядом с официальным — какой брать, решает вычислитель (K-16a).
- `id` факта глобально уникален: факт с `id` другой компании отклоняется.

## RequirementRepository (K-10b)

- `saveVersion(packId, version, requirements)` публикует версию. **Версии неизменяемы и строго растут:** повтор версии или версия не выше последней — ошибка; так старый расчёт воспроизводим. Все записи должны иметь те же `packId` и `packVersion`, `id` — уникальны. Две публикации одного пакета не идут одновременно (advisory-блокировка).
- `listByPack(packId, version?)` — записи версии в исходном порядке; без версии — последняя опубликованная.
- `diff(packId, toVersion, fromVersion?)` — `RulepackChange` для события `rulepack_version` (`ChangeEvent`): добавленные, изменённые, удалённые записи. «Изменена» — отличается чем-либо, кроме `packVersion`; порядок ключей не важен.

Публикация новой версии пакета (K-17, 3-01, демо-триггер): `saveVersion` → `diff` → `ChangeEvent` → планировщик (K-20a/K-30a).

## ChangeEventRepository и NotificationRepository (K-10c)

```ts
import { PostgresChangeEventRepository, PostgresNotificationRepository } from "@max-hackathon/storage";

const events = new PostgresChangeEventRepository(db);
const notifications = new PostgresNotificationRepository(db);
```

- `append(event)` идемпотентен по `id`: повтор ничего не меняет, остаётся первая запись. `get(id)` возвращает записанное.
- `saveCandidate(candidate)` — пара (`companyId`, `dedupKey`) уникальна: повтор с тем же `dedupKey` или `id` ничего не меняет. `hasCandidate(companyId, dedupKey)` — проверка перед созданием уведомления (K-20b). Вне порта: `getCandidate(id)`.
- `enqueue(notification)` идемпотентен по `idempotencyKey` (и `id`): повтор не создаёт дубль и не меняет записанное, в том числе статус. Узнать, что уже есть, — `findByIdempotencyKey(key)` (K-21a).
- `listQueued(limit)` — только `queued`, по возрастанию `createdAt` (сравниваются моменты времени, не строки), при равенстве — по `id`.
- `updateStatus(id, { status, attempts, sentAt?, error? })` обновляет колонки и документ в одной транзакции. `sentAt` и `error` берутся из `update`: не переданное поле удаляется из документа (например, `error` при возврате в очередь). `sent` требует `sentAt`, `failed` — `error` (схема `notification` v1), иначе ошибка; неизвестный `id` — ошибка.
- Внешних ключей на `companies` и между таблицами нет: события и уведомления бывают по модельным компаниям без сохранённого профиля.
- Хранилище документов (`DocumentStore`, K-18b) в этот поток не входит: порта нет в `@max-hackathon/domain`.
