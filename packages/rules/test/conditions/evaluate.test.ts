// Юнит-тесты вычислителя условий (K-16a): каждый тип узла — yes / no / unknown,
// логика Клини, missingFactKeys, выбор факта, ошибки типов, трасса по схеме контракта.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ConditionNode,
  ConditionOutcome,
  ConditionResult,
  Fact,
  FactKind,
  FactValue,
} from "@max-hackathon/domain";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { allOf, anyOf, evaluateCondition, negate } from "../../src/index.js";

let counter = 0;
const fact = (key: string, value: FactValue, kind: FactKind = "official", extra: Partial<Fact> = {}): Fact => ({
  id: `f${++counter}`,
  companyId: "model-company",
  key,
  value,
  kind,
  source: { system: "fixture", retrievedAt: "2026-09-25T00:00:00Z", isModel: true },
  observedAt: "2026-09-01T00:00:00Z",
  ...(kind === "derived" ? { derivedFrom: ["f0"] } : {}),
  ...extra,
});

const outcome = (condition: ConditionNode, facts: Fact[]): ConditionOutcome =>
  evaluateCondition(condition, facts).result.outcome;

describe("листья: yes / no / unknown на каждый тип", () => {
  const cases: [string, ConditionNode, Fact[], Fact[]][] = [
    [
      "okved_prefix",
      { type: "okved_prefix", prefix: "56" },
      [fact("activity.okved_main", "56.10")],
      [fact("activity.okved_main", "47.11")],
    ],
    [
      "region",
      { type: "region", codes: ["77", "16"] },
      [fact("location.region_code", "16")],
      [fact("location.region_code", "63")],
    ],
    [
      "msp_category",
      { type: "msp_category", in: ["micro", "small"] },
      [fact("scale.msp_category", "micro")],
      [fact("scale.msp_category", "medium")],
    ],
    [
      "has_employees",
      { type: "has_employees", value: true },
      [fact("employment.has_employees", true)],
      [fact("employment.has_employees", false)],
    ],
    [
      "headcount",
      { type: "headcount", min: 1, max: 15 },
      [fact("employment.headcount", 15)],
      [fact("employment.headcount", 16)],
    ],
    [
      "tax_regime",
      { type: "tax_regime", in: ["usn_income"] },
      [fact("tax.regime", ["psn", "usn_income"])],
      [fact("tax.regime", "osno")],
    ],
    [
      "fact_equals",
      { type: "fact_equals", key: "sales.alcohol", value: "strong" },
      [fact("sales.alcohol", "strong")],
      [fact("sales.alcohol", "beer")],
    ],
    [
      "fact_in",
      { type: "fact_in", key: "sales.alcohol", values: ["beer", "strong"] },
      [fact("sales.alcohol", "beer")],
      [fact("sales.alcohol", "none")],
    ],
    [
      "fact_range",
      { type: "fact_range", key: "employment.headcount", min: 16 },
      [fact("employment.headcount", 16)],
      [fact("employment.headcount", 3)],
    ],
  ];

  it.each(cases)("%s", (_name, condition, yesFacts, noFacts) => {
    expect(outcome(condition, yesFacts)).toBe("yes");
    expect(outcome(condition, noFacts)).toBe("no");
    const unknown = evaluateCondition(condition, []);
    expect(unknown.result.outcome).toBe("unknown");
    expect(unknown.missingFactKeys).toEqual(unknown.result.factKeys);
    expect(unknown.issues).toEqual([]);
  });

  it("always — yes без фактов", () => {
    expect(outcome({ type: "always" }, [])).toBe("yes");
  });

  it("okved_prefix — префикс по иерархии, не по подстроке", () => {
    const condition: ConditionNode = { type: "okved_prefix", prefix: "45.2" };
    expect(outcome(condition, [fact("activity.okved_main", "45.20.1")])).toBe("yes");
    expect(outcome(condition, [fact("activity.okved_main", "45.11")])).toBe("no");
    expect(outcome(condition, [fact("activity.okved_main", "14.52")])).toBe("no");
  });

  it("границы headcount и fact_range включительны; одна граница допустима", () => {
    expect(outcome({ type: "headcount", min: 16 }, [fact("employment.headcount", 16)])).toBe("yes");
    expect(outcome({ type: "headcount", max: 15 }, [fact("employment.headcount", 15)])).toBe("yes");
    expect(outcome({ type: "headcount", max: 15 }, [fact("employment.headcount", 16)])).toBe("no");
  });
});

describe("okved_prefix со scope = main_or_additional", () => {
  const condition: ConditionNode = { type: "okved_prefix", prefix: "47", scope: "main_or_additional" };
  const main = (code: string) => fact("activity.okved_main", code);
  const additional = (codes: string[]) => fact("activity.okved_additional", codes);

  it("yes по основному коду — дополнительные не нужны", () => {
    expect(evaluateCondition(condition, [main("47.11")]).result.outcome).toBe("yes");
  });

  it("yes по дополнительному коду", () => {
    expect(outcome(condition, [main("56.10"), additional(["47.25"])])).toBe("yes");
    expect(outcome(condition, [additional(["47.25"])])).toBe("yes");
  });

  it("no, только когда известны оба факта и ни один не подходит", () => {
    expect(outcome(condition, [main("56.10"), additional([])])).toBe("no");
    const partial = evaluateCondition(condition, [main("56.10")]);
    expect(partial.result.outcome).toBe("unknown");
    expect(partial.missingFactKeys).toEqual(["activity.okved_additional"]);
  });
});

describe("логика Клини", () => {
  const values: ConditionOutcome[] = ["yes", "no", "unknown"];

  it.each(values.flatMap((a) => values.map((b) => [a, b] as const)))("all/any(%s, %s)", (a, b) => {
    const table = { yes: 2, unknown: 1, no: 0 } as const;
    const back = ["no", "unknown", "yes"] as const;
    expect(allOf([a, b])).toBe(back[Math.min(table[a], table[b])]);
    expect(anyOf([a, b])).toBe(back[Math.max(table[a], table[b])]);
  });

  it("not", () => {
    expect(values.map(negate)).toEqual(["no", "yes", "unknown"]);
  });

  it("no поглощает unknown в all, yes — в any", () => {
    const facts = [fact("activity.okved_main", "47.11")];
    const okved: ConditionNode = { type: "okved_prefix", prefix: "56" };
    const employees: ConditionNode = { type: "has_employees", value: true };
    const all = evaluateCondition({ type: "all", items: [okved, employees] }, facts);
    expect(all.result.outcome).toBe("no");
    expect(all.missingFactKeys).toEqual([]);
    const any = evaluateCondition({ type: "any", items: [{ type: "okved_prefix", prefix: "47" }, employees] }, facts);
    expect(any.result.outcome).toBe("yes");
    expect(any.missingFactKeys).toEqual([]);
  });

  it("not сохраняет unknown и ключи недостающих фактов", () => {
    const result = evaluateCondition({ type: "not", item: { type: "has_employees", value: true } }, []);
    expect(result.result.outcome).toBe("unknown");
    expect(result.missingFactKeys).toEqual(["employment.has_employees"]);
    expect(
      outcome({ type: "not", item: { type: "has_employees", value: true } }, [fact("employment.has_employees", false)]),
    ).toBe("yes");
  });
});

describe("missingFactKeys", () => {
  it("только ключи, от которых зависит результат, без повторов", () => {
    const condition: ConditionNode = {
      type: "all",
      items: [
        { type: "okved_prefix", prefix: "56" },
        { type: "fact_in", key: "sales.alcohol", values: ["beer", "strong"] },
        {
          type: "any",
          items: [
            { type: "has_employees", value: true },
            { type: "fact_equals", key: "sales.alcohol", value: "strong" },
          ],
        },
      ],
    };
    const result = evaluateCondition(condition, [fact("activity.okved_main", "56.10")]);
    expect(result.result.outcome).toBe("unknown");
    expect(result.missingFactKeys).toEqual(["sales.alcohol", "employment.has_employees"]);
  });

  it("пусто, если результат известен", () => {
    expect(
      evaluateCondition({ type: "has_employees", value: true }, [fact("employment.has_employees", true)])
        .missingFactKeys,
    ).toEqual([]);
  });
});

describe("выбор факта", () => {
  const condition: ConditionNode = { type: "has_employees", value: true };

  it("официальный важнее заявленного и вычисленного", () => {
    const official = fact("employment.has_employees", false);
    const declared = fact("employment.has_employees", true, "declared", { observedAt: "2026-09-25T00:00:00Z" });
    const derived = fact("employment.has_employees", true, "derived");
    const result = evaluateCondition(condition, [declared, derived, official]);
    expect(result.result.outcome).toBe("no");
    expect(result.result.factIds).toEqual([official.id]);
  });

  it("вычисленный важнее заявленного", () => {
    expect(
      outcome(condition, [
        fact("employment.has_employees", false, "declared"),
        fact("employment.has_employees", true, "derived"),
      ]),
    ).toBe("yes");
  });

  it("одного типа — более свежий; порядок фактов не влияет", () => {
    const old = fact("employment.headcount", 3, "official", { observedAt: "2025-01-01T00:00:00Z" });
    const fresh = fact("employment.headcount", 20, "official", { observedAt: "2026-01-01T00:00:00Z" });
    const headcount: ConditionNode = { type: "headcount", min: 16 };
    expect(outcome(headcount, [old, fresh])).toBe("yes");
    expect(outcome(headcount, [fresh, old])).toBe("yes");
  });

  it("сценарный факт учитывается только в режиме scenario", () => {
    const facts = [fact("employment.has_employees", false), fact("employment.has_employees", true, "scenario")];
    expect(evaluateCondition(condition, facts).result.outcome).toBe("no");
    expect(evaluateCondition(condition, facts, { mode: "scenario" }).result.outcome).toBe("yes");
    expect(evaluateCondition(condition, [facts[1]!]).result.outcome).toBe("unknown");
  });

  it("asOf отбрасывает факты вне периода действия", () => {
    const expired = fact("employment.has_employees", true, "official", {
      validity: { from: "2025-01-01", to: "2025-12-31" },
    });
    expect(evaluateCondition(condition, [expired]).result.outcome).toBe("yes");
    expect(evaluateCondition(condition, [expired], { asOf: "2026-09-25" }).result.outcome).toBe("unknown");
    expect(evaluateCondition(condition, [expired], { asOf: "2025-06-01" }).result.outcome).toBe("yes");
  });
});

describe("ошибки данных", () => {
  it("несовпадение типа факта — unknown и issue, а не no", () => {
    const wrong = fact("employment.headcount", "двенадцать");
    const result = evaluateCondition({ type: "headcount", min: 1 }, [wrong]);
    expect(result.result.outcome).toBe("unknown");
    expect(result.missingFactKeys).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({ path: "$", factId: wrong.id })]);
  });

  it("fact_equals сравнивает с учётом типа", () => {
    const result = evaluateCondition({ type: "fact_equals", key: "location.region_code", value: 77 }, [
      fact("location.region_code", "77"),
    ]);
    expect(result.result.outcome).toBe("unknown");
    expect(result.issues).toHaveLength(1);
  });

  it("неизвестный тип узла — unknown и issue, без исключения", () => {
    const result = evaluateCondition({ type: "okved" } as unknown as ConditionNode, []);
    expect(result.result).toMatchObject({ outcome: "unknown", conditionType: "okved" });
    expect(result.issues[0]?.message).toContain("okved");
  });
});

describe("трасса", () => {
  const facts = [fact("activity.okved_main", "56.10"), fact("employment.has_employees", true, "derived")];
  const condition: ConditionNode = {
    type: "all",
    items: [
      { type: "okved_prefix", prefix: "56" },
      { type: "not", item: { type: "region", codes: ["77"] } },
    ],
  };

  it("повторяет дерево условия с путями $, $.items[i], $.item", () => {
    const { result } = evaluateCondition(condition, facts);
    const paths = (node: ConditionResult): string[] => [node.path, ...(node.children ?? []).flatMap(paths)];
    expect(paths(result)).toEqual(["$", "$.items[0]", "$.items[1]", "$.items[1].item"]);
    expect(result.children?.[0]).toMatchObject({ outcome: "yes", expected: "ОКВЭД начинается с 56", actual: "56.10" });
  });

  it("детерминирована: одинаковый вход — одинаковый результат", () => {
    expect(evaluateCondition(condition, facts)).toEqual(evaluateCondition(condition, [...facts].reverse()));
  });
});

describe("примеры условий из contracts/rulepack/conditions/examples", () => {
  const contractsDir = join(import.meta.dirname, "../../../../contracts");
  const examplesDir = join(contractsDir, "rulepack/conditions/examples");
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  addFormats.default(ajv);
  for (const file of readdirSync(join(contractsDir, "v1")).filter((name) => name.endsWith(".schema.json"))) {
    ajv.addSchema(JSON.parse(readFileSync(join(contractsDir, "v1", file), "utf8")));
  }
  const validateTrace = ajv.getSchema("https://contracts.max-hackathon.invalid/v1/condition-result.schema.json")!;

  const cafe = [
    fact("activity.okved_main", "56.10"),
    fact("activity.okved_additional", ["47.25"]),
    fact("location.region_code", "77"),
    fact("scale.msp_category", "micro"),
    fact("employment.headcount", 12),
    fact("employment.has_employees", true, "derived"),
    fact("tax.regime", "usn_income"),
    fact("sales.alcohol", "beer", "declared"),
  ];

  it.each(readdirSync(examplesDir))("%s: трасса проходит схему condition-result, без ошибок данных", (file) => {
    const condition = JSON.parse(readFileSync(join(examplesDir, file), "utf8")) as ConditionNode;
    for (const facts of [cafe, []]) {
      const evaluation = evaluateCondition(condition, facts);
      expect(validateTrace(evaluation.result), JSON.stringify(validateTrace.errors)).toBe(true);
      expect(evaluation.issues).toEqual([]);
    }
  });
});
