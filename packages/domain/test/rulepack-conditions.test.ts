// Тест формата условий (K-15a): примеры проходят схему, некорректные отклоняются,
// условия из примеров требований v1 соответствуют формату, перечисления TS совпадают со схемой.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { CONDITION_TYPES, ENTITY_TYPES, MSP_CATEGORIES, OKVED_SCOPES, TAX_REGIMES } from "../src/index.js";

const contractsDir = join(import.meta.dirname, "../../../contracts");
const conditionsDir = join(contractsDir, "rulepack/conditions");
const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(path, "utf8"));

const schema = readJson(join(conditionsDir, "condition.schema.json"));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
addFormats.default(ajv);
const validate = ajv.compile(schema);

const listJson = (dir: string) => readdirSync(join(conditionsDir, dir)).filter((file) => file.endsWith(".json"));

describe("формат условий", () => {
  it.each(listJson("examples"))("пример %s проходит схему", (file) => {
    const valid = validate(readJson(join(conditionsDir, "examples", file)));
    expect(validate.errors ?? [], JSON.stringify(validate.errors, null, 2)).toEqual([]);
    expect(valid).toBe(true);
  });

  it.each(listJson("invalid"))("некорректный %s отклоняется", (file) => {
    expect(validate(readJson(join(conditionsDir, "invalid", file)))).toBe(false);
  });

  it("каждый тип узла встречается в примерах", () => {
    const seen = new Set<string>();
    const walk = (node: any): void => {
      seen.add(node.type);
      node.items?.forEach(walk);
      if (node.item) walk(node.item);
    };
    for (const file of listJson("examples")) walk(readJson(join(conditionsDir, "examples", file)));
    expect(CONDITION_TYPES.filter((type) => !seen.has(type))).toEqual([]);
  });

  const requirementExamples = readdirSync(join(contractsDir, "v1/examples")).filter((file) =>
    file.startsWith("requirement."),
  );
  it.each(requirementExamples)("условие в v1/examples/%s соответствует формату", (file) => {
    const valid = validate(readJson(join(contractsDir, "v1/examples", file)).condition);
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it.each([
    ["ConditionType", schema.$defs.Condition.properties.type.enum, CONDITION_TYPES],
    ["MspCategory", schema.$defs.MspCategory.properties.in.items.enum, MSP_CATEGORIES],
    ["TaxRegime", schema.$defs.TaxRegime.properties.in.items.enum, TAX_REGIMES],
    ["OkvedScope", schema.$defs.OkvedPrefix.properties.scope.enum, OKVED_SCOPES],
    ["EntityType", schema.$defs.EntityType.properties.in.items.enum, ENTITY_TYPES],
  ] as const)("перечисление %s совпадает со схемой", (_name, fromSchema, fromTs) => {
    expect(fromSchema).toEqual([...fromTs]);
  });

  it("у каждого типа узла есть ветка if/then", () => {
    const branches = schema.$defs.Condition.allOf.map((branch: any) => branch.if.properties.type.const);
    expect(branches).toEqual([...CONDITION_TYPES]);
  });
});
