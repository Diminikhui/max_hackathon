// Тест схем контрактов v1: примеры из contracts/v1/examples проходят схему,
// примеры из contracts/v1/invalid отклоняются, перечисления TS совпадают со схемами.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  APPLICABILITY_STATUSES,
  CHANGE_EVENT_KINDS,
  CONDITION_OUTCOMES,
  CONTRACT_VERSION,
  ENTITY_TYPES,
  FACT_KINDS,
  NOTIFICATION_REASONS,
  NOTIFICATION_STATUSES,
  REQUIREMENT_COVERAGES,
  REQUIREMENT_KINDS,
} from "../src/index.js";

const contractsDir = join(import.meta.dirname, "../../../contracts/v1");
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8"));

const schemaFiles = readdirSync(contractsDir).filter((file) => file.endsWith(".schema.json"));
const schemas = Object.fromEntries(schemaFiles.map((file) => [file, readJson(join(contractsDir, file))]));

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
addFormats.default(ajv);
for (const schema of Object.values(schemas)) ajv.addSchema(schema);

// Имя примера: <схема>.<случай>.json → <схема>.schema.json
const schemaFor = (exampleFile: string): string => `${exampleFile.split(".")[0]}.schema.json`;
const validatorFor = (exampleFile: string) => {
  const schema = schemas[schemaFor(exampleFile)];
  if (!schema) throw new Error(`Нет схемы для примера ${exampleFile}`);
  const validate = ajv.getSchema(schema.$id as string);
  if (!validate) throw new Error(`Схема не скомпилирована: ${schemaFor(exampleFile)}`);
  return validate;
};

const listJson = (dir: string) => readdirSync(join(contractsDir, dir)).filter((file) => file.endsWith(".json"));

describe("схемы контрактов v1", () => {
  it.each(schemaFiles)("%s компилируется", (file) => {
    expect(ajv.getSchema(schemas[file]?.$id as string)).toBeTypeOf("function");
  });

  it("у каждой сущности есть корректный пример", () => {
    const covered = new Set(listJson("examples").map(schemaFor));
    const entities = schemaFiles.filter((file) => !["common.schema.json", "condition-result.schema.json"].includes(file));
    expect(entities.filter((file) => !covered.has(file))).toEqual([]);
  });
});

describe("корректные примеры", () => {
  it.each(listJson("examples"))("%s проходит схему", (file) => {
    const validate = validatorFor(file);
    const valid = validate(readJson(join(contractsDir, "examples", file)));
    expect(validate.errors ?? [], JSON.stringify(validate.errors, null, 2)).toEqual([]);
    expect(valid).toBe(true);
  });

  it.each(listJson("examples"))("%s помечен модельным", (file) => {
    const text = readFileSync(join(contractsDir, "examples", file), "utf8");
    expect(text).not.toMatch(/"isModel":\s*false/);
  });
});

describe("некорректные примеры", () => {
  it.each(listJson("invalid"))("%s отклоняется", (file) => {
    const validate = validatorFor(file);
    expect(validate(readJson(join(contractsDir, "invalid", file)))).toBe(false);
  });
});

describe("перечисления TS совпадают со схемами", () => {
  const defs = (schemas["common.schema.json"]?.$defs ?? {}) as Record<string, { enum?: unknown[]; const?: unknown }>;
  const props = (file: string) => (schemas[file]?.properties ?? {}) as Record<string, { enum?: unknown[] }>;

  it.each([
    ["ContractVersion", [defs.ContractVersion?.const], [CONTRACT_VERSION]],
    ["FactKind", defs.FactKind?.enum, FACT_KINDS],
    ["ApplicabilityStatus", defs.ApplicabilityStatus?.enum, APPLICABILITY_STATUSES],
    ["ConditionOutcome", props("condition-result.schema.json").outcome?.enum, CONDITION_OUTCOMES],
    ["RequirementKind", props("requirement.schema.json").kind?.enum, REQUIREMENT_KINDS],
    ["RequirementCoverage", props("requirement.schema.json").coverage?.enum, REQUIREMENT_COVERAGES],
    ["EntityType", props("company-profile.schema.json").entityType?.enum, ENTITY_TYPES],
    ["ChangeEventKind", props("change-event.schema.json").kind?.enum, CHANGE_EVENT_KINDS],
    ["NotificationReason", props("notification-candidate.schema.json").reason?.enum, NOTIFICATION_REASONS],
    ["NotificationStatus", props("notification.schema.json").status?.enum, NOTIFICATION_STATUSES],
  ] as const)("%s", (_name, fromSchema, fromTs) => {
    expect(fromSchema).toEqual([...fromTs]);
  });
});
