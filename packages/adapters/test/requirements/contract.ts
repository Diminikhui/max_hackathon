// K-13a. Shared contract tests for RequirementSource implementations.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RequirementQuery, RequirementSource } from "@max-hackathon/domain";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const CONTRACTS_DIR = join(import.meta.dirname, "../../../../contracts/v1");
const REQUIREMENT_SCHEMA_ID = "https://contracts.max-hackathon.invalid/v1/requirement.schema.json";

export interface RequirementSourceContractOptions {
  query?: RequirementQuery;
  expectAtLeast?: number;
}

export function createRequirementValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  addFormats.default(ajv);
  for (const file of readdirSync(CONTRACTS_DIR).filter((name) => name.endsWith(".schema.json"))) {
    ajv.addSchema(JSON.parse(readFileSync(join(CONTRACTS_DIR, file), "utf8")));
  }
  const validate = ajv.getSchema(REQUIREMENT_SCHEMA_ID);
  if (!validate) throw new Error(`Схема ${REQUIREMENT_SCHEMA_ID} не найдена в ${CONTRACTS_DIR}`);
  return validate;
}

export function describeRequirementSourceContract(
  name: string,
  factory: () => RequirementSource | Promise<RequirementSource>,
  options: RequirementSourceContractOptions = {},
): void {
  describe(`RequirementSource (контракт): ${name}`, () => {
    const validate = createRequirementValidator();
    const query = options.query ?? {};

    it("сообщает имя и признак модельности", async () => {
      const { info } = await factory();
      expect(info.name.length).toBeGreaterThan(0);
      expect(typeof info.isModel).toBe("boolean");
    });

    it("возвращает уникальные Requirement v1", async () => {
      const source = await factory();
      const requirements = await source.listRequirements(query);
      expect(requirements.length).toBeGreaterThanOrEqual(options.expectAtLeast ?? 0);
      expect(new Set(requirements.map(({ id }) => id)).size).toBe(requirements.length);
      for (const requirement of requirements) {
        const valid = validate(requirement);
        expect(validate.errors ?? [], `${requirement.id}: ${JSON.stringify(validate.errors, null, 2)}`).toEqual([]);
        expect(valid).toBe(true);
      }
    });

    it("возвращает независимые результаты и не мутирует данные источника", async () => {
      const source = await factory();
      const first = await source.listRequirements(query);
      const expected = structuredClone(first);
      if (first[0]) first[0].title = "изменено вызывающим кодом";
      expect(await source.listRequirements(query)).toEqual(expected);
    });

    it("модельный источник отдаёт только явно модельные записи", async () => {
      const source = await factory();
      if (!source.info.isModel) return;
      const requirements = await source.listRequirements(query);
      for (const requirement of requirements) expect(requirement.source.isModel, requirement.id).toBe(true);
    });
  });
}
