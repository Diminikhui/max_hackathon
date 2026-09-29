// Тесты агрегатора статусов (K-16b): каждый из 5 статусов, приоритет правил, воспроизводимость,
// ApplicabilityResult проходит схему контракта на модельных данных из contracts/v1/examples.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPLICABILITY_STATUSES,
  type ApplicabilityStatus,
  CONTRACT_VERSION,
  type CompanyProfile,
  type ConditionNode,
  type Fact,
  type FactValue,
  type Requirement,
} from "@max-hackathon/domain";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { assessRequirement, determineStatus, evaluateCondition, REASONS } from "../../src/index.js";

const fact = (id: string, key: string, value: FactValue, extra: Partial<Fact> = {}): Fact => ({
  id,
  companyId: "model-company",
  key,
  value,
  kind: "official",
  source: { system: "fixture", retrievedAt: "2026-09-25T00:00:00Z", isModel: true },
  observedAt: "2026-09-01T00:00:00Z",
  ...extra,
});

const condition: ConditionNode = {
  type: "all",
  items: [
    { type: "okved_prefix", prefix: "56" },
    { type: "has_employees", value: true },
  ],
};

const requirement = (extra: Partial<Requirement> = {}): Requirement => ({
  contractVersion: CONTRACT_VERSION,
  id: "a.fed.sout",
  packId: "a-fed",
  packVersion: 1,
  kind: "obligation",
  title: "Провести СОУТ (модельная запись)",
  basis: [{ act: "Федеральный закон № 426-ФЗ", url: "http://pravo.gov.ru/" }],
  condition,
  coverage: "full",
  source: { system: "fixture", retrievedAt: "2026-09-25T00:00:00Z", isModel: true },
  ...extra,
});

const okved = (code: string) => fact("f-okved", "activity.okved_main", code);
const employees = (value: FactValue) => fact("f-employees", "employment.has_employees", value);
const asOf = "2026-09-25";

const decide = (req: Requirement, facts: Fact[]) =>
  determineStatus({
    requirement: req,
    asOf,
    evaluation: evaluateCondition(req.condition as ConditionNode, facts, { asOf }),
  });

describe("determineStatus", () => {
  it("applies — условие выполнено, покрытие полное", () => {
    expect(decide(requirement(), [okved("56.10"), employees(true)])).toEqual({ status: "applies" });
  });

  it("not_applies — необходимое условие не выполнено, даже при нехватке других фактов", () => {
    expect(decide(requirement(), [okved("47.11")])).toEqual({ status: "not_applies" });
  });

  it("insufficient_data — не хватает факта; причина и ключи для уточнения", () => {
    expect(decide(requirement(), [okved("56.10")])).toEqual({
      status: "insufficient_data",
      statusReason: "Не хватает данных: Есть работники",
      missingFactKeys: ["employment.has_employees"],
    });
  });

  it("needs_review — условие выполнено, но формализовано частично", () => {
    expect(decide(requirement({ coverage: "partial" }), [okved("56.10"), employees(true)])).toEqual({
      status: "needs_review",
      statusReason: REASONS.partial,
    });
  });

  it("needs_review — ошибка данных без недостающих фактов", () => {
    expect(decide(requirement(), [okved("56.10"), employees("да")])).toEqual({
      status: "needs_review",
      statusReason: REASONS.dataIssue,
    });
  });

  it("partial + не выполнено → not_applies; partial + нехватка → insufficient_data", () => {
    expect(decide(requirement({ coverage: "partial" }), [okved("47.11")]).status).toBe("not_applies");
    expect(decide(requirement({ coverage: "partial" }), [okved("56.10")]).status).toBe("insufficient_data");
  });

  it("out_of_coverage — coverage none, вычисление не нужно", () => {
    expect(determineStatus({ requirement: requirement({ coverage: "none" }), asOf })).toEqual({
      status: "out_of_coverage",
      statusReason: REASONS.outOfCoverage,
    });
  });

  it("not_applies — норма не действует на дату расчёта", () => {
    const future = requirement({ validity: { from: "2027-03-01" } });
    expect(decide(future, [okved("56.10"), employees(true)])).toEqual({
      status: "not_applies",
      statusReason: "Норма не действует на 2026-09-25",
    });
    const expired = requirement({ validity: { to: "2025-12-31" } });
    expect(decide(expired, [okved("56.10"), employees(true)]).status).toBe("not_applies");
    const current = requirement({ validity: { from: "2026-09-25", to: "2026-09-25" } });
    expect(decide(current, [okved("56.10"), employees(true)]).status).toBe("applies");
  });

  it("без результата вычисления для full/partial — ошибка вызова", () => {
    expect(() => determineStatus({ requirement: requirement(), asOf })).toThrow();
  });
});

describe("assessRequirement", () => {
  const profile = { companyId: "model-company", facts: [okved("56.10"), employees(true)] };
  const options = { evaluatedAt: "2026-09-25T09:00:00Z" };

  it("собирает ApplicabilityResult: статус, трасса, объяснение", () => {
    const result = assessRequirement(requirement(), profile, options);
    expect(result).toMatchObject({
      contractVersion: 1,
      companyId: "model-company",
      requirementId: "a.fed.sout",
      packId: "a-fed",
      packVersion: 1,
      status: "applies",
      evaluatedAt: "2026-09-25T09:00:00Z",
    });
    expect(result.trace?.outcome).toBe("yes");
    expect(result.explanation.at(-1)).toEqual({
      kind: "source",
      text: "Федеральный закон № 426-ФЗ",
      url: "http://pravo.gov.ru/",
    });
  });

  it("asOf по умолчанию — дата из evaluatedAt: факт с истёкшим сроком не учитывается", () => {
    const expiredEmployees = fact("f-employees", "employment.has_employees", true, { validity: { to: "2026-01-01" } });
    const stale = { companyId: "model-company", facts: [okved("56.10"), expiredEmployees] };
    expect(assessRequirement(requirement(), stale, options).status).toBe("insufficient_data");
    expect(assessRequirement(requirement(), stale, { ...options, asOf: "2025-12-01" }).status).toBe("applies");
  });

  it("out_of_coverage — без трассы", () => {
    const result = assessRequirement(requirement({ coverage: "none" }), profile, options);
    expect(result.status).toBe("out_of_coverage");
    expect(result.trace).toBeUndefined();
  });

  it("сценарный режим учитывает сценарные факты", () => {
    const scenario = {
      companyId: "model-company",
      facts: [okved("56.10"), employees(false), fact("f-s", "employment.has_employees", true, { kind: "scenario" })],
    };
    expect(assessRequirement(requirement(), scenario, options).status).toBe("not_applies");
    expect(assessRequirement(requirement(), scenario, { ...options, mode: "scenario" }).status).toBe("applies");
  });

  it("entity_type берётся из profile.entityType; без него — needs_review", () => {
    const onlyIp = requirement({
      condition: {
        type: "all",
        items: [
          { type: "okved_prefix", prefix: "56" },
          { type: "entity_type", in: ["individual_entrepreneur"] },
        ],
      },
    });
    expect(assessRequirement(onlyIp, { ...profile, entityType: "individual_entrepreneur" }, options).status).toBe(
      "applies",
    );
    expect(assessRequirement(onlyIp, { ...profile, entityType: "legal_entity" }, options).status).toBe("not_applies");
    expect(assessRequirement(onlyIp, profile, options).status).toBe("needs_review");
  });

  it("воспроизводим: одинаковый вход — одинаковый результат", () => {
    const reversed = { ...profile, facts: [...profile.facts].reverse() };
    expect(assessRequirement(requirement(), profile, options)).toEqual(
      assessRequirement(requirement(), reversed, options),
    );
  });
});

describe("ApplicabilityResult проходит схему контракта для всех 5 статусов", () => {
  const contractsDir = join(import.meta.dirname, "../../../../contracts/v1");
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  addFormats.default(ajv);
  for (const file of readdirSync(contractsDir).filter((name) => name.endsWith(".schema.json"))) {
    ajv.addSchema(JSON.parse(readFileSync(join(contractsDir, file), "utf8")));
  }
  const validate = ajv.getSchema("https://contracts.max-hackathon.invalid/v1/applicability-result.schema.json")!;
  const cafe = JSON.parse(
    readFileSync(join(contractsDir, "examples/company-profile.cafe.json"), "utf8"),
  ) as CompanyProfile;
  const sout = JSON.parse(
    readFileSync(join(contractsDir, "examples/requirement.obligation.json"), "utf8"),
  ) as Requirement;
  const options = { evaluatedAt: "2026-09-25T09:00:00Z" };

  const scenarios: [ApplicabilityStatus, Requirement, Pick<CompanyProfile, "companyId" | "facts">][] = [
    ["applies", sout, cafe],
    [
      "not_applies",
      sout,
      { ...cafe, facts: cafe.facts.map((f) => (f.key === "activity.okved_main" ? { ...f, value: "47.11" } : f)) },
    ],
    ["insufficient_data", sout, { ...cafe, facts: cafe.facts.filter((f) => f.key !== "employment.has_employees") }],
    ["needs_review", { ...sout, coverage: "partial" }, cafe],
    ["out_of_coverage", { ...sout, coverage: "none" }, cafe],
  ];

  it("сценарии покрывают все статусы", () => {
    expect(scenarios.map(([status]) => status)).toEqual([...APPLICABILITY_STATUSES]);
  });

  it.each(scenarios)("%s", (status, req, profile) => {
    const result = assessRequirement(req, profile, options);
    expect(result.status).toBe(status);
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
  });
});
