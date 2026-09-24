// Тестовая БД для всех тестов пакета storage: настоящий PostgreSQL в WASM (PGlite), без Docker.
// Каждый вызов — новая пустая БД с применёнными миграциями.
import { PGlite } from "@electric-sql/pglite";
import { createPgliteClient, runMigrations, type SqlClient } from "../../src/index.js";

export const createTestDatabase = async (): Promise<SqlClient & { close(): Promise<void> }> => {
  const db = new PGlite();
  const client = createPgliteClient(db);
  await runMigrations(client);
  return { ...client, close: () => db.close() };
};
