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

## ProfileRepository (K-10a)

- `save(profile)` заменяет профиль целиком, включая набор фактов.
- `addFacts(companyId, facts)` добавляет факты, ничего не удаляя; тот же `id` — замена (повтор идемпотентен). Заявленный факт хранится рядом с официальным — какой брать, решает вычислитель (K-16a).
- `id` факта глобально уникален: факт с `id` другой компании отклоняется.

## RequirementRepository (K-10b)

- `saveVersion(packId, version, requirements)` публикует версию. **Версии неизменяемы и строго растут:** повтор версии или версия не выше последней — ошибка; так старый расчёт воспроизводим. Все записи должны иметь те же `packId` и `packVersion`, `id` — уникальны. Две публикации одного пакета не идут одновременно (advisory-блокировка).
- `listByPack(packId, version?)` — записи версии в исходном порядке; без версии — последняя опубликованная.
- `diff(packId, toVersion, fromVersion?)` — `RulepackChange` для события `rulepack_version` (`ChangeEvent`): добавленные, изменённые, удалённые записи. «Изменена» — отличается чем-либо, кроме `packVersion`; порядок ключей не важен.

Публикация новой версии пакета (K-17, 3-01, демо-триггер): `saveVersion` → `diff` → `ChangeEvent` → планировщик (K-20a/K-30a).
