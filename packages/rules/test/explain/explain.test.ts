// Тесты цепочки объяснения (K-16c): строится для любого статуса, детерминирована,
// показывает только решающие факты и условия, а итог проходит схему ApplicabilityResult.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPLICABILITY_STATUSES,
  type ApplicabilityResult,
  CONTRACT_VERSION,
  type ConditionNode,
  type Fact,
  type FactKind,
  type FactValue,
  type Requirement,
} from "@max-hackathon/domain";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { buildExplanation, decisiveLeaves, evaluateCondition } from "../../src/index.js";

const fact = (id: string, key: string, value: FactValue, kind: FactKind = "official"): Fact => ({
  id,
  companyId: "model-company",
  key,
  value,
  kind,
  source: { system: "rmsp.nalog.ru", retrievedAt: "2026-09-25T00:00:00Z", isModel: true },
  observedAt: "2026-09-01T00:00:00Z",
  ...(kind === "derived" ? { derivedFrom: ["f-headcount"] } : {}),
});

const requirement = (condition: ConditionNode): Requirement => ({
  contractVersion: CONTRACT_VERSION,
  id: "a.fed.sout",
  packId: "a-fed",
  packVersion: 1,
  kind: "obligation",
  title: "Провести специальную оценку условий труда",
  basis: [
    { act: "Федеральный закон № 426-ФЗ", article: "ст. 8", url: "http://pravo.gov.ru/" },
    { act: "Трудовой кодекс РФ", url: "http://pravo.gov.ru/" },
  ],
  condition,
  coverage: "full",
  source: { system: "fixture", retrievedAt: "2026-09-25T00:00:00Z", isModel: true },
});

const cafeCondition: ConditionNode = {
  type: "all",
  items: [
    { type: "okved_prefix", prefix: "56" },
    { type: "has_employees", value: true },
  ],
};
const okved = fact("f-okved", "activity.okved_main", "56.10");
const employees = fact("f-employees", "employment.has_employees", true, "derived");

const explain = (condition: ConditionNode, facts: Fact[], status = "applies" as ApplicabilityResult["status"]) =>
  buildExplanation({
    requirement: requirement(condition),
    status,
    trace: evaluateCondition(condition, facts).result,
    facts,
  });

describe("цепочка объяснения", () => {
  it("порядок шагов: факты → условия → правило → результат → источники", () => {
    const steps = explain(cafeCondition, [okved, employees]);
    expect(steps.map((step) => step.kind)).toEqual([
      "fact",
      "fact",
      "condition",
      "condition",
      "condition",
      "rule",
      "result",
      "source",
      "source",
    ]);
    expect(steps[0]).toEqual({
      kind: "fact",
      text: "Основной ОКВЭД: 56.10 (по данным rmsp.nalog.ru, модельные данные)",
      refId: "f-okved",
    });
    expect(steps[1]?.text).toBe("Есть работники: да (вычислено из других данных, модельные данные)");
    expect(steps[2]).toEqual({ kind: "condition", text: "ОКВЭД начинается с 56 — выполнено", refId: "$.items[0]" });
    expect(steps[4]?.text).toBe("Итог условия: выполнены все условия — выполнено");
    expect(steps[5]).toEqual({
      kind: "rule",
      text: "Обязанность: Провести специальную оценку условий труда (модельная запись)",
      refId: "a.fed.sout",
    });
    expect(steps[6]).toEqual({ kind: "result", text: "Применяется" });
    expect(steps.slice(7)).toEqual([
      { kind: "source", text: "Федеральный закон № 426-ФЗ, ст. 8", url: "http://pravo.gov.ru/" },
      { kind: "source", text: "Трудовой кодекс РФ", url: "http://pravo.gov.ru/" },
    ]);
  });

  it("не применяется — показывает только условие, которое не выполнено", () => {
    const steps = explain(cafeCondition, [fact("f-okved", "activity.okved_main", "47.11"), employees], "not_applies");
    const conditions = steps.filter((step) => step.kind === "condition").map((step) => step.text);
    expect(conditions).toEqual([
      "ОКВЭД начинается с 56 — не выполнено",
      "Итог условия: выполнены все условия — не выполнено",
    ]);
    expect(steps.filter((step) => step.kind === "fact").map((step) => step.refId)).toEqual(["f-okved"]);
  });

  it("недостаточно данных — шаг «нет данных» по недостающему факту", () => {
    const steps = buildExplanation({
      requirement: requirement(cafeCondition),
      status: "insufficient_data",
      trace: evaluateCondition(cafeCondition, [okved]).result,
      facts: [okved],
      statusReason: "Неизвестно, есть ли работники",
    });
    expect(steps.filter((step) => step.kind === "fact")).toEqual([
      { kind: "fact", text: "Есть работники: нет данных", refId: "employment.has_employees" },
    ]);
    expect(steps.find((step) => step.kind === "result")?.text).toBe(
      "Недостаточно данных: Неизвестно, есть ли работники",
    );
  });

  it("без трассы (вне покрытия) — правило, результат и источники", () => {
    const steps = buildExplanation({
      requirement: requirement({ type: "always" }),
      status: "out_of_coverage",
      facts: [],
      statusReason: "регион не поддерживается",
    });
    expect(steps.map((step) => step.kind)).toEqual(["rule", "result", "source", "source"]);
  });

  it("отрицание помечается как исключение", () => {
    const condition: ConditionNode = {
      type: "all",
      items: [
        { type: "okved_prefix", prefix: "56" },
        { type: "not", item: { type: "region", codes: ["77"] } },
      ],
    };
    const steps = explain(condition, [okved, fact("f-region", "location.region_code", "16")]);
    expect(steps.map((step) => step.text)).toContain("Исключение «регион: 77» — не выполнено");
  });

  it("any = yes — только выполненные варианты", () => {
    const condition: ConditionNode = {
      type: "any",
      items: [
        { type: "okved_prefix", prefix: "45.2" },
        { type: "okved_prefix", prefix: "56" },
      ],
    };
    const leaves = decisiveLeaves(evaluateCondition(condition, [okved]).result);
    expect(leaves.map((leaf) => leaf.node.path)).toEqual(["$.items[1]"]);
  });

  it("условие «применяется ко всем»", () => {
    const steps = explain({ type: "always" }, []);
    expect(steps.filter((step) => step.kind === "condition").map((step) => step.text)).toEqual([
      "Итог условия: применяется ко всем — выполнено",
    ]);
  });

  it("детерминирована: порядок фактов на входе не влияет", () => {
    expect(explain(cafeCondition, [okved, employees])).toEqual(explain(cafeCondition, [employees, okved]));
  });
});

describe("цепочка проходит схему ApplicabilityResult для любого статуса и примера условия", () => {
  const contractsDir = join(import.meta.dirname, "../../../../contracts");
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  addFormats.default(ajv);
  for (const file of readdirSync(join(contractsDir, "v1")).filter((name) => name.endsWith(".schema.json"))) {
    ajv.addSchema(JSON.parse(readFileSync(join(contractsDir, "v1", file), "utf8")));
  }
  const validate = ajv.getSchema("https://contracts.max-hackathon.invalid/v1/applicability-result.schema.json")!;
  const examplesDir = join(contractsDir, "rulepack/conditions/examples");
  const cafe = [
    okved,
    employees,
    fact("f-region", "location.region_code", "77"),
    fact("f-alcohol", "sales.alcohol", "beer", "declared"),
  ];

  const cases = readdirSync(examplesDir).flatMap((file) =>
    APPLICABILITY_STATUSES.map((status) => [file, status] as const),
  );
  it.each(cases)("%s → %s", (file, status) => {
    const condition = JSON.parse(readFileSync(join(examplesDir, file), "utf8")) as ConditionNode;
    const evaluation = evaluateCondition(condition, cafe);
    const withTrace = status !== "out_of_coverage" && status !== "needs_review";
    const result: ApplicabilityResult = {
      contractVersion: CONTRACT_VERSION,
      companyId: "model-company",
      requirementId: "a.fed.sout",
      packId: "a-fed",
      packVersion: 1,
      status,
      ...(status === "insufficient_data" ? { missingFactKeys: ["employment.headcount"] } : {}),
      ...(withTrace ? { trace: evaluation.result } : {}),
      explanation: buildExplanation({
        requirement: requirement(condition),
        status,
        facts: cafe,
        ...(withTrace ? { trace: evaluation.result } : {}),
      }),
      evaluatedAt: "2026-09-25T09:00:00Z",
    };
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
  });
});
