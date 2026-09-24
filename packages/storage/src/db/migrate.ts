// Миграции: SQL-файлы в packages/storage/migrations/, имя `<поток>-NNN-<суть>.sql` (например k-10a-001-profiles.sql).
// Применяются по алфавиту имени, каждая в своей транзакции; применённые записываются в schema_migrations.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqlClient } from "./sql-client.js";

/** Каталог миграций пакета (рядом с src/ и dist/). */
export const MIGRATIONS_DIR = join(import.meta.dirname, "../../migrations");

const MIGRATION_NAME = /^[a-z0-9-]+-\d{3}-[a-z0-9-]+\.sql$/;

export const listMigrations = (dir: string = MIGRATIONS_DIR): string[] => {
  const files = readdirSync(dir).filter((file) => file.endsWith(".sql"));
  const invalid = files.filter((file) => !MIGRATION_NAME.test(file));
  if (invalid.length > 0) throw new Error(`Неверное имя миграции: ${invalid.join(", ")}`);
  return files.sort();
};

/** Применяет недостающие миграции; возвращает имена применённых сейчас. Повторный запуск ничего не делает. */
export const runMigrations = async (client: SqlClient, dir: string = MIGRATIONS_DIR): Promise<string[]> => {
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const { rows } = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
  const applied = new Set(rows.map((row) => row.id));
  const pending = listMigrations(dir).filter((file) => !applied.has(file));
  for (const file of pending) {
    const sql = readFileSync(join(dir, file), "utf8");
    await client.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    });
  }
  return pending;
};
