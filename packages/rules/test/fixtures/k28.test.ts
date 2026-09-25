// Проверка модельных данных K-28 (data/fixtures/k28-*): схемы, ИНН, пометка «модельные»,
// ожидаемые статусы для каждой пары «компания × запись» и результат демо-изменения v1 → v2.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPLICABILITY_STATUSES,
  type ApplicabilityStatus,
  type CompanyProfile,
  type Fact,
  type Requirement,
} from "@max-hackathon/domain";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { assessRequirement } from "../../src/index.js";

const root = join(import.meta.dirname, "../../../..");
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(root, "data/fixtures", name), "utf8"));

interface Pack {
  packId: string;
  packVersion: number;
  isModel: boolean;
  requirements: Requirement[];
}
type Expected = { status: ApplicabilityStatus; missingFactKeys?: string[] };
interface ExpectedFile {
  evaluatedAt: string;
  statuses: Record<string, Record<string, Record<string, Expected>>>;
  demoChange: {
    rulepackChange: { addedRequirementIds: string[]; changedRequirementIds: string[]; removedRequirementIds: string[] };
    becameApplicable: Record<string, string[]>;
  };
}

const companies = fixture<CompanyProfile[]>("k28-companies.json");
const packs: Record<number, Pack> = { 1: fixture("k28-rulepack-v1.json"), 2: fixture("k28-rulepack-v2.json") };
const expected = fixture<ExpectedFile>("k28-expected.json");
const options = { evaluatedAt: expected.evaluatedAt };

const innIsValid = (inn: string): boolean => {
  const digits = [...inn].map(Number);
  const check = (weights: number[]) =>
    (weights.reduce((sum, weight, index) => sum + weight * digits[index]!, 0) % 11) % 10;
  if (digits.length === 10) return check([2, 4, 10, 3, 5, 9, 4, 6, 8]) === digits[9];
  return (
    check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === digits[10] && check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === digits[11]
  );
};

describe("K-28: данные корректны и помечены модельными", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  addFormats.default(ajv);
  const contracts = join(root, "contracts");
  for (const file of readdirSync(join(contracts, "v1")).filter((name) => name.endsWith(".schema.json"))) {
    ajv.addSchema(JSON.parse(readFileSync(join(contracts, "v1", file), "utf8")));
  }
  ajv.addSchema(JSON.parse(readFileSync(join(contracts, "rulepack/conditions/condition.schema.json"), "utf8")));
  ajv.addSchema(JSON.parse(readFileSync(join(contracts, "rulepack/pack/pack.schema.json"), "utf8")));
  const validateProfile = ajv.getSchema("https://contracts.max-hackathon.invalid/v1/company-profile.schema.json")!;
  const validatePack = ajv.getSchema("https://contracts.max-hackathon.invalid/rulepack/pack/pack.schema.json")!;

  it.each(companies.map((company) => [company.companyId, company] as const))("профиль %s", (_id, company) => {
    expect(validateProfile(company), JSON.stringify(validateProfile.errors)).toBe(true);
    expect(company.isModel).toBe(true);
    expect(company.facts.every((fact) => fact.source.isModel)).toBe(true);
    expect(innIsValid(company.inn)).toBe(true);
  });

  it.each([1, 2])("пакет v%i", (version) => {
    const pack = packs[version]!;
    expect(validatePack(pack), JSON.stringify(validatePack.errors)).toBe(true);
    expect(pack.isModel).toBe(true);
    expect(pack.requirements.every((r) => r.source.isModel && r.packVersion === version)).toBe(true);
  });

  it("ИНН уникальны", () => {
    expect(new Set(companies.map((company) => company.inn)).size).toBe(companies.length);
  });
});

describe("K-28: ожидаемые статусы", () => {
  it.each([1, 2])("версия %i: assessRequirement даёт k28-expected.json", (version) => {
    const actual = Object.fromEntries(
      companies.map((company) => [
        company.companyId,
        Object.fromEntries(
          packs[version]!.requirements.map((requirement) => {
            const result = assessRequirement(requirement, company, options);
            return [
              requirement.id,
              result.missingFactKeys
                ? { status: result.status, missingFactKeys: result.missingFactKeys }
                : { status: result.status },
            ];
          }),
        ),
      ]),
    );
    expect(actual).toEqual(expected.statuses[String(version)]);
  });

  it("в версии 1 встречаются все 5 статусов", () => {
    const seen = new Set(
      Object.values(expected.statuses["1"]!).flatMap((row) => Object.values(row).map((cell) => cell.status)),
    );
    expect([...APPLICABILITY_STATUSES].filter((status) => !seen.has(status))).toEqual([]);
  });

  it("сценарий шага 2: ответы на уточняющие вопросы переводят «недостаточно данных» в «применяется»", () => {
    const kzn = companies.find((company) => company.companyId === "k28-cafe-kzn")!;
    const answer = (key: string, value: Fact["value"]): Fact => ({
      id: `${kzn.companyId}.answer.${key}`,
      companyId: kzn.companyId,
      key,
      value,
      kind: "declared",
      source: { system: "user", retrievedAt: expected.evaluatedAt, isModel: true },
      observedAt: expected.evaluatedAt,
    });
    const answered = {
      ...kzn,
      facts: [...kzn.facts, answer("employment.has_employees", true), answer("sales.alcohol", "beer")],
    };
    const byId = new Map(packs[1]!.requirements.map((r) => [r.id, r]));
    expect(assessRequirement(byId.get("k28.employer-duty")!, answered, options).status).toBe("applies");
    expect(assessRequirement(byId.get("k28.alcohol-accounting")!, answered, options).status).toBe("applies");
  });
});

describe("K-28: демо-изменение v1 → v2", () => {
  it("разница версий совпадает с ожидаемой", () => {
    const before = new Set(packs[1]!.requirements.map((r) => r.id));
    const after = new Set(packs[2]!.requirements.map((r) => r.id));
    expect({
      addedRequirementIds: [...after].filter((id) => !before.has(id)),
      removedRequirementIds: [...before].filter((id) => !after.has(id)),
    }).toEqual({
      addedRequirementIds: expected.demoChange.rulepackChange.addedRequirementIds,
      removedRequirementIds: expected.demoChange.rulepackChange.removedRequirementIds,
    });
  });

  it("уведомление получают ровно компании, у которых новая запись стала применяться", () => {
    const [v1, v2] = [expected.statuses["1"]!, expected.statuses["2"]!];
    const became = Object.fromEntries(
      Object.entries(v2)
        .map(([company, row]): [string, string[]] => [
          company,
          Object.entries(row)
            .filter(([id, cell]) => cell.status === "applies" && v1[company]?.[id]?.status !== "applies")
            .map(([id]) => id),
        ])
        .filter(([, ids]) => ids.length > 0),
    );
    expect(became).toEqual(expected.demoChange.becameApplicable);
  });
});
