// Интеграционные тесты RequirementRepository на PostgreSQL (PGlite): версии неизменяемы и растут,
// чтение возвращает записанное в исходном порядке, diff даёт RulepackChange для ChangeEvent.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Requirement } from "@max-hackathon/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { PostgresRequirementRepository } from "../../src/index.js";
import { type TestDatabase, useSharedTestDatabase } from "../support/test-db.js";

const examples = join(import.meta.dirname, "../../../../contracts/v1/examples");
const read = (file: string) => JSON.parse(readFileSync(join(examples, file), "utf8")) as Requirement;
const sout = read("requirement.obligation.json");
const rate = read("requirement.opportunity.json");

const at = (version: number, ...requirements: Requirement[]): Requirement[] =>
  requirements.map((requirement) => ({ ...requirement, packVersion: version }));

const testDatabase = useSharedTestDatabase();
let db: TestDatabase;
let repository: PostgresRequirementRepository;

beforeEach(() => {
  db = testDatabase();
  repository = new PostgresRequirementRepository(db);
});

describe("PostgresRequirementRepository", () => {
  it("пустое хранилище", async () => {
    expect(await repository.listPackIds()).toEqual([]);
    expect(await repository.latestVersion("a-fed")).toBeUndefined();
    expect(await repository.listByPack("a-fed")).toEqual([]);
  });

  it("чтение возвращает записанное в исходном порядке; без версии — последняя", async () => {
    await repository.saveVersion("a-fed", 1, at(1, sout, rate));
    await repository.saveVersion("a-fed", 2, at(2, rate));
    expect(await repository.listByPack("a-fed", 1)).toEqual(at(1, sout, rate));
    expect(await repository.listByPack("a-fed")).toEqual(at(2, rate));
    expect(await repository.latestVersion("a-fed")).toBe(2);
  });

  it("версии неизменяемы: повтор и версия не выше последней отклоняются", async () => {
    await repository.saveVersion("a-fed", 2, at(2, sout));
    await expect(repository.saveVersion("a-fed", 2, at(2, rate))).rejects.toThrow(/неизменяемы/);
    await expect(repository.saveVersion("a-fed", 1, at(1, rate))).rejects.toThrow(/неизменяемы/);
    expect(await repository.listByPack("a-fed", 2)).toEqual(at(2, sout));
  });

  it("несогласованные записи отклоняются до записи в БД", async () => {
    await expect(repository.saveVersion("a-fed", 1, at(2, sout))).rejects.toThrow(/не принадлежат/);
    await expect(repository.saveVersion("other", 1, at(1, sout))).rejects.toThrow(/не принадлежат/);
    await expect(repository.saveVersion("a-fed", 1, at(1, sout, sout))).rejects.toThrow(/Повтор id/);
    await expect(repository.saveVersion("a-fed", 0, [])).rejects.toThrow(/≥ 1/);
    expect(await repository.listPackIds()).toEqual([]);
  });

  it("ошибка при записи откатывает версию целиком", async () => {
    const broken = { ...sout, id: "broken", kind: "unknown" as Requirement["kind"] };
    await expect(repository.saveVersion("a-fed", 1, at(1, sout, broken))).rejects.toThrow();
    expect(await repository.latestVersion("a-fed")).toBeUndefined();
  });

  it("пустая версия допустима (все записи удалены)", async () => {
    await repository.saveVersion("a-fed", 1, at(1, sout));
    await repository.saveVersion("a-fed", 2, []);
    expect(await repository.listByPack("a-fed")).toEqual([]);
  });

  it("listPackIds — все пакеты по порядку", async () => {
    await repository.saveVersion("b-fed", 1, []);
    await repository.saveVersion("a-fed", 1, []);
    expect(await repository.listPackIds()).toEqual(["a-fed", "b-fed"]);
  });

  describe("diff", () => {
    it("первая публикация — все записи добавлены", async () => {
      await repository.saveVersion("a-fed", 1, at(1, sout, rate));
      expect(await repository.diff("a-fed", 1)).toEqual({
        packId: "a-fed",
        toVersion: 1,
        addedRequirementIds: [sout.id, rate.id],
        changedRequirementIds: [],
        removedRequirementIds: [],
      });
    });

    it("добавлено, изменено, удалено; смена только packVersion — не изменение", async () => {
      const water = { ...sout, id: "a.fed.water-marking", title: "Маркировка воды (модельная запись)" };
      await repository.saveVersion("a-fed", 1, at(1, sout, rate));
      await repository.saveVersion("a-fed", 2, at(2, { ...sout, deadline: "ежегодно" }, water));
      await repository.saveVersion("a-fed", 3, at(3, { ...sout, deadline: "ежегодно" }, water));
      expect(await repository.diff("a-fed", 2, 1)).toEqual({
        packId: "a-fed",
        fromVersion: 1,
        toVersion: 2,
        addedRequirementIds: [water.id],
        changedRequirementIds: [sout.id],
        removedRequirementIds: [rate.id],
      });
      const unchanged = await repository.diff("a-fed", 3, 2);
      expect([unchanged.addedRequirementIds, unchanged.changedRequirementIds, unchanged.removedRequirementIds]).toEqual(
        [[], [], []],
      );
    });

    it("порядок ключей в документе не считается изменением", async () => {
      const reordered = Object.fromEntries(Object.entries(sout).reverse()) as Requirement;
      await repository.saveVersion("a-fed", 1, at(1, sout));
      await repository.saveVersion("a-fed", 2, at(2, reordered));
      expect((await repository.diff("a-fed", 2, 1)).changedRequirementIds).toEqual([]);
    });

    it("неизвестная версия — ошибка", async () => {
      await expect(repository.diff("a-fed", 1)).rejects.toThrow(/не найдена/);
    });
  });
});
