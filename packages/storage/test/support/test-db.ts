// Тестовая БД для всех тестов пакета storage: настоящий PostgreSQL в WASM (PGlite), без Docker.
//
// Запуск WASM и применение миграций занимают сотни миллисекунд, а на медленном раннере CI — секунды. Если делать это
// в каждом тесте, он упирается в лимит 5 с. Поэтому БД одна на файл: поднимается в beforeAll (у хука свой лимит,
// см. vitest.config.ts), а данные очищаются перед каждым тестом.
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { createPgliteClient, runMigrations, type SqlClient } from "../../src/index.js";

export type TestDatabase = SqlClient & { close(): Promise<void> };

/** Новая пустая БД с применёнными миграциями. */
export const createTestDatabase = async (): Promise<TestDatabase> => {
  const db = new PGlite();
  const client = createPgliteClient(db);
  await runMigrations(client);
  return { ...client, close: () => db.close() };
};

/** Удаляет данные всех таблиц, кроме журнала миграций; счётчики сбрасываются. */
export const clearData = async (client: SqlClient): Promise<void> => {
  const { rows } = await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'",
  );
  if (rows.length === 0) return;
  const tables = rows.map((row) => `"${row.tablename}"`).join(", ");
  await client.exec(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
};

/**
 * Одна БД с миграциями на весь файл теста; перед каждым тестом данные очищаются.
 * Вызывать на верхнем уровне файла теста; возвращает функцию, отдающую БД внутри хуков и тестов.
 */
export const useSharedTestDatabase = (): (() => TestDatabase) => {
  let database: TestDatabase | undefined;
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  beforeEach(async () => {
    if (database) await clearData(database);
  });
  afterAll(async () => {
    await database?.close();
    database = undefined;
  });
  return () => {
    if (!database) throw new Error("Тестовая БД ещё не создана: вызывайте функцию внутри хуков и тестов");
    return database;
  };
};
