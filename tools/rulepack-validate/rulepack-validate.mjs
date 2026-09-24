#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, "../..");
const domainRequire = createRequire(join(repositoryRoot, "packages/domain/package.json"));
const { Ajv2020 } = domainRequire("ajv/dist/2020.js");
const addFormats = domainRequire("ajv-formats");

const packSchemaId = "https://contracts.max-hackathon.invalid/rulepack/pack/pack.schema.json";

const schemaPaths = [
  "contracts/v1/common.schema.json",
  "contracts/v1/requirement.schema.json",
  "contracts/rulepack/conditions/condition.schema.json",
  "contracts/rulepack/pack/pack.schema.json",
];

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const createValidator = () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  addFormats.default(ajv);

  for (const schemaPath of schemaPaths) ajv.addSchema(readJson(join(repositoryRoot, schemaPath)));

  const validate = ajv.getSchema(packSchemaId);
  if (!validate) throw new Error(`Не удалось скомпилировать схему пакета: ${packSchemaId}`);
  return validate;
};

const formatSchemaErrors = (errors = []) =>
  errors.map((error) => {
    const path = error.instancePath || "/";
    const missing = error.keyword === "required" ? ` (${error.params.missingProperty})` : "";
    return `${path}: ${error.message ?? error.keyword}${missing}`;
  });

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const validatePeriod = (period, path, errors) => {
  if (period?.from && period?.to && period.from > period.to) {
    errors.push(`${path}.from должен быть не позже ${path}.to`);
  }
};

const validateSemantics = (pack) => {
  const errors = [];
  const requirements = pack.requirements;

  validatePeriod(pack.validity, "validity", errors);

  if (pack.isModel !== pack.source.isModel) {
    errors.push("isModel пакета должен совпадать с source.isModel пакета");
  }

  const seenIds = new Set();
  requirements.forEach((requirement, index) => {
    const path = `requirements[${index}]`;

    if (requirement.contractVersion !== pack.contractVersion) {
      errors.push(`${path}.contractVersion должен совпадать с contractVersion пакета`);
    }
    if (requirement.packId !== pack.packId) {
      errors.push(`${path}.packId должен совпадать с packId пакета`);
    }
    if (requirement.packVersion !== pack.packVersion) {
      errors.push(`${path}.packVersion должен совпадать с packVersion пакета`);
    }
    if (seenIds.has(requirement.id)) {
      errors.push(`${path}.id повторяет идентификатор ${JSON.stringify(requirement.id)}`);
    }
    seenIds.add(requirement.id);

    validatePeriod(requirement.validity, `${path}.validity`, errors);
    if (requirement.validity?.from && pack.validity?.from && requirement.validity.from < pack.validity.from) {
      errors.push(`${path}.validity.from не может быть раньше validity.from пакета`);
    }
    if (requirement.validity?.to && pack.validity?.to && requirement.validity.to > pack.validity.to) {
      errors.push(`${path}.validity.to не может быть позже validity.to пакета`);
    }
    if (requirement.source.isModel !== pack.isModel) {
      errors.push(`${path}.source.isModel должен совпадать с isModel пакета`);
    }
  });

  return errors;
};

export const validateRulepack = (pack) => {
  const validate = createValidator();
  const schemaErrors = validate(pack) ? [] : formatSchemaErrors(validate.errors);
  if (!isObject(pack)) return schemaErrors.length > 0 ? schemaErrors : ["корень пакета должен быть объектом"];

  const canCheckSemantics = isObject(pack.source) && Array.isArray(pack.requirements) && pack.requirements.every(isObject);
  return canCheckSemantics ? [...schemaErrors, ...validateSemantics(pack)] : schemaErrors;
};

export const run = (args, io = { stdout: process.stdout, stderr: process.stderr }) => {
  if (args.length !== 1 || args[0] === "--help" || args[0] === "-h") {
    io.stderr.write("Использование: node tools/rulepack-validate/rulepack-validate.mjs <путь-к-пакету.json>\n");
    return 2;
  }

  const path = isAbsolute(args[0]) ? args[0] : resolve(process.cwd(), args[0]);
  let pack;
  try {
    pack = readJson(path);
  } catch (error) {
    io.stderr.write(`Не удалось прочитать JSON ${path}: ${error.message}\n`);
    return 1;
  }

  let errors;
  try {
    errors = validateRulepack(pack);
  } catch (error) {
    io.stderr.write(`Не удалось проверить пакет: ${error.message}\n`);
    return 1;
  }

  if (errors.length > 0) {
    io.stderr.write(`Пакет правил невалиден (${errors.length}):\n${errors.map((error) => `- ${error}`).join("\n")}\n`);
    return 1;
  }

  io.stdout.write(`Пакет правил валиден: ${path}\n`);
  return 0;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = run(process.argv.slice(2));
