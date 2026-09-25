import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run, validateRulepack } from "./rulepack-validate.mjs";

const repositoryRoot = join(import.meta.dirname, "../..");
const examplePath = join(repositoryRoot, "contracts/rulepack/pack/examples/model-cafe.json");
const example = () => JSON.parse(readFileSync(examplePath, "utf8"));

test("принимает корректный модельный пакет", () => {
  assert.deepEqual(validateRulepack(example()), []);
});

test("сообщает о каждой обязательной межполевой проверке", () => {
  const pack = example();
  pack.validity = { from: "2026-12-01", to: "2026-01-01" };
  pack.source.isModel = false;
  pack.requirements.push({ ...pack.requirements[0], contractVersion: 2, packId: "other", packVersion: 2 });
  const errors = validateRulepack(pack);

  assert(errors.some((error) => error.includes("validity.from должен быть не позже")));
  assert(errors.some((error) => error.includes("source.isModel пакета")));
  assert(errors.some((error) => error.includes("contractVersion должен совпадать")));
  assert(errors.some((error) => error.includes("packId должен совпадать")));
  assert(errors.some((error) => error.includes("packVersion должен совпадать")));
  assert(errors.some((error) => error.includes("повторяет идентификатор")));
});

test("отклоняет структурно неверный пакет с понятной причиной", () => {
  const pack = example();
  delete pack.title;
  const errors = validateRulepack(pack);
  assert(errors.some((error) => error.includes("title")));
});

test("CLI возвращает ошибку для неразбираемого JSON", () => {
  const directory = mkdtempSync(join(tmpdir(), "rulepack-validate-"));
  const path = join(directory, "broken.json");
  writeFileSync(path, "{", "utf8");
  const stderr = [];

  try {
    assert.equal(run([path], { stdout: { write() {} }, stderr: { write: (text) => stderr.push(text) } }), 1);
    assert.match(stderr.join(""), /Не удалось прочитать JSON/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
