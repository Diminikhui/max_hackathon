// Миграции применяются с нуля, повторный запуск ничего не меняет, неверное имя файла отклоняется.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createPgliteClient, listMigrations, runMigrations } from "../src/index.js";

describe("миграции", () => {
  it("применяются с нуля и не применяются повторно", async () => {
    const db = new PGlite();
    const client = createPgliteClient(db);
    const first = await runMigrations(client);
    expect(first).toEqual(listMigrations());
    expect(first).toContain("k-10a-001-profiles.sql");
    expect(await runMigrations(client)).toEqual([]);
    const { rows } = await client.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id");
    expect(rows.map((row) => row.id)).toEqual(first);
    await db.close();
  });

  it("ошибка в миграции откатывает её целиком и не отмечает применённой", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrations-"));
    writeFileSync(join(dir, "test-001-ok.sql"), "CREATE TABLE ok_table (id int);");
    writeFileSync(join(dir, "test-002-broken.sql"), "CREATE TABLE half (id int); SELECT * FROM missing_table;");
    const db = new PGlite();
    const client = createPgliteClient(db);
    await expect(runMigrations(client, dir)).rejects.toThrow();
    const { rows } = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
    expect(rows.map((row) => row.id)).toEqual(["test-001-ok.sql"]);
    const half = await client.query("SELECT to_regclass('half') AS t");
    expect(half.rows[0]).toEqual({ t: null });
    await db.close();
  });

  it("неверное имя файла миграции отклоняется", () => {
    const dir = mkdtempSync(join(tmpdir(), "migrations-"));
    writeFileSync(join(dir, "profiles.sql"), "SELECT 1;");
    expect(() => listMigrations(dir)).toThrow(/profiles\.sql/);
  });
});
