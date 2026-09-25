// Валидатор документов по схемам contracts/v1 (Ajv 2020 + ajv-formats, strictRequired: false).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const contractsDir = join(import.meta.dirname, "../../../../contracts/v1");

export const contractValidator = (name: string): ValidateFunction => {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  addFormats.default(ajv);
  for (const file of readdirSync(contractsDir).filter((file) => file.endsWith(".schema.json"))) {
    ajv.addSchema(JSON.parse(readFileSync(join(contractsDir, file), "utf8")));
  }
  const validate = ajv.getSchema(`https://contracts.max-hackathon.invalid/v1/${name}.schema.json`);
  if (!validate) throw new Error(`Схема ${name} не найдена`);
  return validate;
};
