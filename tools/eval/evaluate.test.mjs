import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateRuns } from "./evaluate.mjs";

const documents = Array.from({ length: 30 }, (_, index) => ({
  id: `doc-${index + 1}`,
  title: `Модельный документ ${index + 1}`,
  text: "Модельный текст",
  sourceUrl: `https://example.invalid/doc-${index + 1}`,
  isModel: true,
  expected: {
    impactTypes: [index % 2 === 0 ? "new_obligation" : "changed_obligation"],
    effectiveDate: index % 3 === 0 ? null : "2026-10-01",
    industry: index % 2 === 0 ? "foodservice" : "retail",
  },
}));
const dataset = {
  datasetId: "test",
  version: 1,
  isModel: true,
  labelSet: {
    impactTypes: ["new_obligation", "changed_obligation", "removed_obligation", "new_opportunity"],
    industries: ["foodservice", "retail", "unknown"],
  },
  documents,
};
const perfect = documents.map(({ id: documentId, expected }) => ({ documentId, ...expected }));

test("считает точные метрики отдельно по провайдерам", () => {
  const imperfect = perfect.map((prediction, index) =>
    index === 0 ? { ...prediction, impactTypes: ["changed_obligation"] } : prediction,
  );
  const report = evaluateRuns(dataset, {
    datasetId: "test",
    runs: [
      { provider: "template", isModel: true, predictions: imperfect },
      { provider: "test-double", isModel: true, predictions: perfect },
    ],
  });

  assert.equal(report.documents, 30);
  assert.deepEqual(
    report.providers.map(({ provider }) => provider),
    ["template", "test-double"],
  );
  assert.equal(report.providers[1].exactMatch, 1);
  assert.equal(report.providers[0].exactMatch, 0.9667);
  assert.equal(report.providers[0].metrics.impactTypes.exactSetAccuracy, 0.9667);
  assert.equal(report.providers[0].metrics.effectiveDate.accuracy, 1);
});

test("считает пропуск как снижение coverage и accuracy", () => {
  const report = evaluateRuns(dataset, {
    datasetId: "test",
    runs: [{ provider: "local", isModel: true, predictions: perfect.slice(0, 15) }],
  });

  assert.equal(report.providers[0].coverage, 0.5);
  assert.equal(report.providers[0].missing, 15);
  assert.equal(report.providers[0].metrics.industry.accuracy, 0.5);
});

test("отклоняет неизвестные и повторные documentId", () => {
  assert.throws(
    () =>
      evaluateRuns(dataset, {
        datasetId: "test",
        runs: [{ provider: "local", predictions: [{ ...perfect[0], documentId: "unknown" }] }],
      }),
    /неизвестного документа/,
  );
  assert.throws(
    () =>
      evaluateRuns(dataset, {
        datasetId: "test",
        runs: [{ provider: "local", predictions: [perfect[0], perfect[0]] }],
      }),
    /повтор documentId/,
  );
});

test("требует 30+ явно модельных документов", () => {
  assert.throws(
    () => evaluateRuns({ ...dataset, documents: documents.slice(0, 29) }, { datasetId: "test", runs: [] }),
    /минимум 30/,
  );
  assert.throws(
    () =>
      evaluateRuns(
        { ...dataset, documents: [{ ...documents[0], isModel: false }, ...documents.slice(1)] },
        { datasetId: "test", runs: [] },
      ),
    /isModel=true/,
  );
});

test("метрики fixture K-19e воспроизводятся для каждого сохранённого provider run", () => {
  const root = join(import.meta.dirname, "../..");
  const read = (name) => JSON.parse(readFileSync(join(root, "data/fixtures", name), "utf8"));
  const report = evaluateRuns(read("k19e-classification-sample.json"), read("k19e-model-predictions.json"));

  assert.equal(report.documents, 32);
  const template = report.providers.find(({ provider }) => provider === "template");
  const testDouble = report.providers.find(({ provider }) => provider === "test-double");
  assert.equal(template.coverage, 1);
  assert.equal(template.exactMatch, 0);
  assert.equal(template.metrics.effectiveDate.accuracy, 0.25);
  assert.equal(testDouble.coverage, 1);
  assert.equal(testDouble.exactMatch, 1);
  assert.equal(testDouble.metrics.impactTypes.macroF1, 1);
});
