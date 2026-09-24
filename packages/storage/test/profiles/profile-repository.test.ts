// Интеграционные тесты ProfileRepository на PostgreSQL (PGlite): чтение возвращает записанное,
// заявленное не затирает официальное, повтор идемпотентен, профиль проходит схему контракта.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompanyProfile, Fact } from "@max-hackathon/domain";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresProfileRepository } from "../../src/index.js";
import { createTestDatabase } from "../support/test-db.js";

const contractsDir = join(import.meta.dirname, "../../../../contracts/v1");
const cafe = JSON.parse(
  readFileSync(join(contractsDir, "examples/company-profile.cafe.json"), "utf8"),
) as CompanyProfile;

const declared = (id: string, key: string, value: Fact["value"]): Fact => ({
  id,
  companyId: cafe.companyId,
  key,
  value,
  kind: "declared",
  source: { system: "user", retrievedAt: "2026-09-25T10:00:00Z", isModel: true },
  observedAt: "2026-09-25T10:00:00Z",
});

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let repository: PostgresProfileRepository;

beforeEach(async () => {
  db = await createTestDatabase();
  repository = new PostgresProfileRepository(db);
});
afterEach(() => db.close());

describe("PostgresProfileRepository", () => {
  it("get и findByInn возвращают ровно сохранённый профиль", async () => {
    await repository.save(cafe);
    expect(await repository.get(cafe.companyId)).toEqual(cafe);
    expect(await repository.findByInn(cafe.inn)).toEqual(cafe);
  });

  it("неизвестная компания — undefined", async () => {
    expect(await repository.get("missing")).toBeUndefined();
    expect(await repository.findByInn("7700000009")).toBeUndefined();
  });

  it("save заменяет профиль целиком, включая набор фактов", async () => {
    await repository.save(cafe);
    const updated: CompanyProfile = {
      ...cafe,
      displayName: "Новое название (модельные данные)",
      facts: cafe.facts.slice(0, 2),
    };
    await repository.save(updated);
    expect(await repository.get(cafe.companyId)).toEqual(updated);
  });

  it("addFacts: заявленный факт добавляется рядом с официальным и не затирает его", async () => {
    await repository.save(cafe);
    const claim = declared("fact-cafe-okved-declared", "activity.okved_main", "47.11");
    await repository.addFacts(cafe.companyId, [claim]);
    const profile = await repository.get(cafe.companyId);
    const okved = profile?.facts.filter((fact) => fact.key === "activity.okved_main");
    expect(okved?.map((fact) => fact.kind)).toEqual(["official", "declared"]);
    expect(profile?.facts.at(-1)).toEqual(claim);
  });

  it("addFacts идемпотентен: повтор с тем же id заменяет факт, а не дублирует", async () => {
    await repository.save(cafe);
    await repository.addFacts(cafe.companyId, [declared("d1", "sales.alcohol", "beer")]);
    await repository.addFacts(cafe.companyId, [declared("d1", "sales.alcohol", "strong")]);
    const alcohol = (await repository.get(cafe.companyId))?.facts.filter((fact) => fact.id === "d1");
    expect(alcohol).toHaveLength(1);
    expect(alcohol?.[0]?.value).toBe("strong");
  });

  it("addFacts к неизвестной компании и чужие факты отклоняются", async () => {
    await expect(repository.addFacts("missing", [])).rejects.toThrow(/не найдена/);
    await repository.save(cafe);
    await expect(
      repository.addFacts(cafe.companyId, [{ ...declared("x", "sales.alcohol", "none"), companyId: "other" }]),
    ).rejects.toThrow(/другой компании/);
  });

  it("факт с id другой компании не перезаписывается", async () => {
    await repository.save(cafe);
    const other: CompanyProfile = { ...cafe, companyId: "model-company-other", inn: "1600000004", facts: [] };
    await repository.save(other);
    const stolen = { ...declared("fact-cafe-okved", "activity.okved_main", "47.11"), companyId: other.companyId };
    await expect(repository.addFacts(other.companyId, [stolen])).rejects.toThrow(/другой компании/);
    expect(await repository.get(cafe.companyId)).toEqual(cafe);
  });

  it("ИНН уникален; неверный ИНН отклоняется базой", async () => {
    await repository.save(cafe);
    await expect(repository.save({ ...cafe, companyId: "duplicate" })).rejects.toThrow();
    await expect(repository.save({ ...cafe, companyId: "bad", inn: "123" })).rejects.toThrow();
  });

  it("ошибка внутри save откатывает транзакцию", async () => {
    await repository.save(cafe);
    const invalidFact = { ...cafe.facts[0]!, id: "broken", kind: "unknown" as Fact["kind"] };
    const broken = { ...cafe, displayName: "не должно сохраниться", facts: [...cafe.facts, invalidFact] };
    await expect(repository.save(broken)).rejects.toThrow();
    expect(await repository.get(cafe.companyId)).toEqual(cafe);
  });

  it("listCompanyIds — все компании по порядку", async () => {
    await repository.save({ ...cafe, companyId: "b", inn: "1600000004", facts: [] });
    await repository.save({ ...cafe, companyId: "a", facts: [] });
    expect(await repository.listCompanyIds()).toEqual(["a", "b"]);
  });

  it("прочитанный профиль проходит схему company-profile v1", async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
    addFormats.default(ajv);
    for (const file of readdirSync(contractsDir).filter((name) => name.endsWith(".schema.json"))) {
      ajv.addSchema(JSON.parse(readFileSync(join(contractsDir, file), "utf8")));
    }
    await repository.save(cafe);
    await repository.addFacts(cafe.companyId, [declared("d1", "sales.alcohol", "beer")]);
    const validate = ajv.getSchema("https://contracts.max-hackathon.invalid/v1/company-profile.schema.json")!;
    expect(validate(await repository.get(cafe.companyId)), JSON.stringify(validate.errors)).toBe(true);
  });
});
