// K-11. Контрактные тесты порта `ProfileSource` — общие для всех реализаций:
// fixture (K-11), ЕГРЮЛ (K-12a), реестр МСП (K-12b). Не тест сам по себе: вызывается из `*.test.ts`.
//
//   import { describeProfileSourceContract } from "../../../adapters/test/profile/contract.js";
//   describeProfileSourceContract("egrul", () => new EgrulProfileSource(...), { knownInn, unknownInn });
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileLookupResult, ProfileSource } from "@max-hackathon/domain";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

export interface ProfileSourceContractOptions {
  /** ИНН, для которого реализация обязана вернуть `found`. */
  knownInn: string;
  /** Корректный по форме ИНН, которого в источнике нет: ожидается `not_found`. */
  unknownInn: string;
  /** Некорректные ИНН: реализация не бросает исключение и не возвращает `found`. */
  invalidInns?: string[];
}

const CONTRACTS_DIR = join(import.meta.dirname, "../../../../contracts/v1");
const PROFILE_SCHEMA_ID = "https://contracts.max-hackathon.invalid/v1/company-profile.schema.json";
const DEFAULT_INVALID_INNS = ["", "   ", "abc", "123", "77000000161", "7700000016x", "77-00000016"];

/** Валидатор `contracts/v1/company-profile.schema.json` (Ajv 2020 + ajv-formats, `strictRequired: false`). */
export function createProfileValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  addFormats.default(ajv);
  for (const file of readdirSync(CONTRACTS_DIR).filter((name) => name.endsWith(".schema.json"))) {
    ajv.addSchema(JSON.parse(readFileSync(join(CONTRACTS_DIR, file), "utf8")));
  }
  const validate = ajv.getSchema(PROFILE_SCHEMA_ID);
  if (!validate) throw new Error(`Схема ${PROFILE_SCHEMA_ID} не найдена в ${CONTRACTS_DIR}`);
  return validate;
}

const expectWellFormed = (result: ProfileLookupResult): void => {
  expect(["found", "not_found", "unavailable"]).toContain(result.status);
  if (result.status === "unavailable") {
    expect(result.errorCode).toEqual(expect.any(String));
    expect(result.errorCode.length).toBeGreaterThan(0);
    expect(typeof result.retryable).toBe("boolean");
  }
};

/**
 * Регистрирует набор контрактных тестов для реализации `ProfileSource`.
 * `factory` вызывается перед каждым тестом: реализации с сетью подставляют в неё записанные ответы.
 */
export function describeProfileSourceContract(
  name: string,
  factory: () => ProfileSource | Promise<ProfileSource>,
  options: ProfileSourceContractOptions,
): void {
  const invalidInns = options.invalidInns ?? DEFAULT_INVALID_INNS;

  describe(`ProfileSource (контракт): ${name}`, () => {
    const validate = createProfileValidator();

    it("сообщает имя и признак модельности", async () => {
      const source = await factory();
      expect(source.info.name).toEqual(expect.any(String));
      expect(source.info.name.length).toBeGreaterThan(0);
      expect(typeof source.info.isModel).toBe("boolean");
    });

    it("известный ИНН → found, профиль проходит схему company-profile v1", async () => {
      const source = await factory();
      const result = await source.lookupByInn(options.knownInn);
      expectWellFormed(result);
      if (result.status !== "found") throw new Error(`Ожидался found, получено ${result.status}`);
      const valid = validate(result.profile);
      expect(validate.errors ?? [], JSON.stringify(validate.errors, null, 2)).toEqual([]);
      expect(valid).toBe(true);
    });

    it("ИНН профиля совпадает с запрошенным, факты принадлежат компании и имеют значение", async () => {
      const source = await factory();
      const result = await source.lookupByInn(options.knownInn);
      if (result.status !== "found") throw new Error(`Ожидался found, получено ${result.status}`);
      const { profile } = result;
      expect(profile.inn).toBe(options.knownInn);
      expect(profile.entityType).toBe(options.knownInn.length === 12 ? "individual_entrepreneur" : "legal_entity");
      const factIds = new Set<string>();
      for (const fact of profile.facts) {
        expect(fact.companyId, `факт ${fact.id}`).toBe(profile.companyId);
        expect(fact.value, `факт ${fact.id}: факт без значения не создаётся`).not.toBeNull();
        expect(fact.value, `факт ${fact.id}: факт без значения не создаётся`).toBeDefined();
        expect(factIds.has(fact.id), `повтор id факта ${fact.id}`).toBe(false);
        factIds.add(fact.id);
      }
    });

    it("модельный источник отдаёт только модельные данные", async () => {
      const source = await factory();
      const result = await source.lookupByInn(options.knownInn);
      if (result.status !== "found") throw new Error(`Ожидался found, получено ${result.status}`);
      if (!source.info.isModel) return;
      expect(result.profile.isModel).toBe(true);
      for (const fact of result.profile.facts) expect(fact.source.isModel, `факт ${fact.id}`).toBe(true);
    });

    it("неизвестный ИНН → not_found", async () => {
      const source = await factory();
      expect(await source.lookupByInn(options.unknownInn)).toEqual({ status: "not_found" });
    });

    it("некорректный ИНН не бросает исключение и не даёт found", async () => {
      const source = await factory();
      for (const inn of invalidInns) {
        const result = await source.lookupByInn(inn);
        expectWellFormed(result);
        expect(result.status, `ИНН ${JSON.stringify(inn)}`).not.toBe("found");
      }
    });
  });
}
