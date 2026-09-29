// K-30c: запуск процесса без токена MAX (локальный контур, ADR-0003) и разбор настроек окружения.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Requirement } from "@max-hackathon/domain";
import { createPgliteClient, PostgresRequirementRepository } from "@max-hackathon/storage";
import { readConfig, startApp } from "@max-hackathon/worker/dist/app/index.js";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");
const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe("запуск без токена MAX", () => {
  it("готовит базу и пакеты, порт не открывает, ничего не отправляет", async () => {
    const db = new PGlite();
    const client = createPgliteClient(db);
    const config = readConfig({ DATABASE_URL: "postgresql://local/test" });
    expect(config.maxEventsEnabled).toBe(false);
    expect(config.max).toBeUndefined();

    const app = await startApp(config, silent, { db: { ...client, close: () => db.close() } });

    expect(app.port).toBeUndefined();
    const packs = await new PostgresRequirementRepository(client).listPackIds();
    expect(packs).toEqual(
      expect.arrayContaining([
        "a-foodservice-fed",
        "a-foodservice-ru-16",
        "a-foodservice-opportunities-fed",
        "b-autoservice-fed",
        "k28-model",
      ]),
    );
    await app.stop();
  });

  it("повторный запуск не откатывает демо-версию пакета, опубликованную кнопкой", async () => {
    const db = new PGlite();
    const client = createPgliteClient(db);
    const config = readConfig({ DATABASE_URL: "postgresql://local/test" });
    const noClose = { ...client, close: async () => {} };

    await (await startApp(config, silent, { db: noClose })).stop();
    const requirements = new PostgresRequirementRepository(client);
    expect(await requirements.latestVersion("k28-model")).toBe(1);

    // Демо-кнопка публикует v2 поверх v1.
    const v2 = JSON.parse(readFileSync(join(ROOT, "data/fixtures/k28-rulepack-v2.json"), "utf8")) as {
      requirements: Requirement[];
    };
    await requirements.saveVersion("k28-model", 2, v2.requirements);

    await (await startApp(config, silent, { db: noClose })).stop();

    expect(await requirements.latestVersion("k28-model")).toBe(2);
    expect((await requirements.listByPack("k28-model", 1)).length).toBeGreaterThan(0);
    await db.close();
  });
});

describe("настройки окружения", () => {
  const base = { DATABASE_URL: "postgresql://local/test" };

  it("события MAX включаются только явно и требуют токен и secret", () => {
    expect(() => readConfig({ ...base, MAX_EVENTS_ENABLED: "true" })).toThrow("MAX_BOT_TOKEN");
    expect(() => readConfig({ ...base, MAX_EVENTS_ENABLED: "true", MAX_BOT_TOKEN: "t" })).toThrow("MAX_WEBHOOK_SECRET");
    const config = readConfig({
      ...base,
      MAX_EVENTS_ENABLED: "true",
      MAX_BOT_TOKEN: "t",
      MAX_WEBHOOK_SECRET: "secret_value_1",
    });
    expect(config.max?.baseUrl).toBe("https://platform-api2.max.ru");
    expect(readConfig({ ...base, MAX_EVENTS_ENABLED: "yes" }).maxEventsEnabled).toBe(false);
  });

  it("без базы и с неверным портом процесс не стартует, секреты в ошибках не выводятся", () => {
    expect(() => readConfig({})).toThrow("DATABASE_URL");
    expect(() => readConfig({ ...base, BOT_HTTP_PORT: "70000" })).toThrow("BOT_HTTP_PORT");
    expect(() => readConfig({ ...base, MAX_EVENTS_ENABLED: "true", MAX_BOT_TOKEN: "top-secret-token" })).toThrow(
      expect.not.stringContaining("top-secret-token"),
    );
  });
});
