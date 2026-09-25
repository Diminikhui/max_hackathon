// Модельные уведомления для тестов очереди (на основе примера контракта notification v1) и валидатор схемы.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Notification } from "@max-hackathon/domain";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const contractsDir = join(import.meta.dirname, "../../../../../../contracts/v1");

const example = JSON.parse(readFileSync(join(contractsDir, "examples/notification.sent.json"), "utf8")) as Notification;

/** Модельное уведомление в очереди. */
export const queued = (id: string, overrides: Partial<Notification> = {}): Notification => {
  const { sentAt: _sentAt, ...base } = example;
  return {
    ...base,
    id,
    candidateId: `cand-${id}`,
    idempotencyKey: `key-${id}`,
    status: "queued",
    attempts: 0,
    createdAt: "2026-09-25T12:00:00Z",
    ...overrides,
  };
};

let validator: ValidateFunction | undefined;

/** Валидатор схемы notification v1 (Ajv 2020 + ajv-formats, strictRequired: false). */
export const notificationValidator = (): ValidateFunction => {
  if (validator) return validator;
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  addFormats.default(ajv);
  for (const file of readdirSync(contractsDir).filter((file) => file.endsWith(".schema.json"))) {
    ajv.addSchema(JSON.parse(readFileSync(join(contractsDir, file), "utf8")));
  }
  const validate = ajv.getSchema("https://contracts.max-hackathon.invalid/v1/notification.schema.json");
  if (!validate) throw new Error("Схема notification не найдена");
  validator = validate;
  return validate;
};

/** Управляемые часы: время в миллисекундах, двигается только вручную. */
export const manualClock = (start = Date.parse("2026-09-25T12:00:00Z")) => {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
};
