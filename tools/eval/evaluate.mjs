#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REQUIRED_LABELS = ["impactTypes", "effectiveDate", "industry"];

export const evaluateRuns = (dataset, predictionFile) => {
  validateDataset(dataset);
  validatePredictionFile(predictionFile, dataset.datasetId);

  const expectedById = new Map(dataset.documents.map((document) => [document.id, document.expected]));
  const reports = predictionFile.runs
    .map((run) => evaluateRun(run, expectedById, dataset.labelSet))
    .sort((left, right) => left.provider.localeCompare(right.provider));

  return {
    datasetId: dataset.datasetId,
    datasetVersion: dataset.version,
    isModelDataset: dataset.isModel,
    documents: dataset.documents.length,
    providers: reports,
  };
};

const evaluateRun = (run, expectedById, labelSet) => {
  if (!run || typeof run !== "object" || typeof run.provider !== "string" || !run.provider.trim()) {
    throw new Error("Каждый run должен содержать непустой provider");
  }
  if (!Array.isArray(run.predictions)) throw new Error(`У ${run.provider} отсутствует массив predictions`);

  const predictedById = new Map();
  for (const prediction of run.predictions) {
    if (!prediction || typeof prediction !== "object" || typeof prediction.documentId !== "string") {
      throw new Error(`У ${run.provider} есть prediction без documentId`);
    }
    if (!expectedById.has(prediction.documentId)) {
      throw new Error(`У ${run.provider} предсказание для неизвестного документа ${prediction.documentId}`);
    }
    if (predictedById.has(prediction.documentId)) {
      throw new Error(`У ${run.provider} повтор documentId ${prediction.documentId}`);
    }
    assertLabels(prediction, `${run.provider}/${prediction.documentId}`);
    if (prediction.impactTypes.some((value) => !labelSet.impactTypes.includes(value))) {
      throw new Error(`${run.provider}/${prediction.documentId}: неизвестный тип воздействия`);
    }
    if (!labelSet.industries.includes(prediction.industry)) {
      throw new Error(`${run.provider}/${prediction.documentId}: неизвестная отрасль`);
    }
    predictedById.set(prediction.documentId, prediction);
  }

  const pairs = [...expectedById].flatMap(([documentId, expected]) => {
    const predicted = predictedById.get(documentId);
    return predicted ? [{ expected, predicted }] : [];
  });
  const total = expectedById.size;
  const evaluated = pairs.length;
  const metrics = {
    impactTypes: multiLabelMetrics(pairs, labelSet.impactTypes, total),
    effectiveDate: labelMetrics(pairs, "effectiveDate", total),
    industry: labelMetrics(pairs, "industry", total),
  };
  const exactMatches = pairs.filter(
    ({ expected, predicted }) =>
      sameSet(expected.impactTypes, predicted.impactTypes) &&
      expected.effectiveDate === predicted.effectiveDate &&
      expected.industry === predicted.industry,
  ).length;

  return {
    provider: run.provider,
    ...(typeof run.model === "string" ? { model: run.model } : {}),
    isModelRun: run.isModel === true,
    evaluated,
    missing: total - evaluated,
    coverage: ratio(evaluated, total),
    exactMatch: ratio(exactMatches, total),
    metrics,
  };
};

const multiLabelMetrics = (pairs, classes, total) => {
  const exact = pairs.filter(({ expected, predicted }) => sameSet(expected.impactTypes, predicted.impactTypes)).length;
  const perClass = Object.fromEntries(
    classes.map((className) => {
      let truePositive = 0;
      let falsePositive = 0;
      let falseNegative = 0;
      for (const { expected, predicted } of pairs) {
        const actual = expected.impactTypes.includes(className);
        const guess = predicted.impactTypes.includes(className);
        if (actual && guess) truePositive += 1;
        else if (!actual && guess) falsePositive += 1;
        else if (actual && !guess) falseNegative += 1;
      }
      const precision = ratio(truePositive, truePositive + falsePositive);
      const recall = ratio(truePositive, truePositive + falseNegative);
      return [
        className,
        {
          support: truePositive + falseNegative,
          precision,
          recall,
          f1: precision + recall === 0 ? 0 : rounded((2 * precision * recall) / (precision + recall)),
        },
      ];
    }),
  );
  const f1Values = Object.values(perClass)
    .filter(({ support }) => support > 0)
    .map(({ f1 }) => f1);
  return {
    exactSetAccuracy: ratio(exact, total),
    macroF1: f1Values.length === 0 ? 0 : rounded(f1Values.reduce((sum, value) => sum + value, 0) / f1Values.length),
    perClass,
  };
};

const sameSet = (left, right) =>
  left.length === right.length && [...new Set(left)].every((value) => new Set(right).has(value));

const labelMetrics = (pairs, label, total) => {
  const correct = pairs.filter(({ expected, predicted }) => expected[label] === predicted[label]).length;
  const classes = [
    ...new Set(pairs.flatMap(({ expected, predicted }) => [labelValue(expected[label]), labelValue(predicted[label])])),
  ].sort();
  const perClass = Object.fromEntries(
    classes.map((className) => {
      let truePositive = 0;
      let falsePositive = 0;
      let falseNegative = 0;
      for (const { expected, predicted } of pairs) {
        const actual = labelValue(expected[label]);
        const guess = labelValue(predicted[label]);
        if (actual === className && guess === className) truePositive += 1;
        else if (actual !== className && guess === className) falsePositive += 1;
        else if (actual === className && guess !== className) falseNegative += 1;
      }
      const precision = ratio(truePositive, truePositive + falsePositive);
      const recall = ratio(truePositive, truePositive + falseNegative);
      return [
        className,
        {
          support: truePositive + falseNegative,
          precision,
          recall,
          f1: precision + recall === 0 ? 0 : rounded((2 * precision * recall) / (precision + recall)),
        },
      ];
    }),
  );
  const f1Values = Object.values(perClass)
    .filter(({ support }) => support > 0)
    .map(({ f1 }) => f1);
  return {
    accuracy: ratio(correct, total),
    macroF1: f1Values.length === 0 ? 0 : rounded(f1Values.reduce((sum, value) => sum + value, 0) / f1Values.length),
    perClass,
  };
};

const labelValue = (value) => (value === null ? "<null>" : String(value));
const rounded = (value) => Number(value.toFixed(4));
const ratio = (numerator, denominator) => (denominator === 0 ? 0 : rounded(numerator / denominator));

const assertLabels = (value, location) => {
  for (const label of REQUIRED_LABELS) {
    if (!(label in value)) throw new Error(`${location}: отсутствует ${label}`);
    if (label === "impactTypes") {
      if (!Array.isArray(value[label]) || value[label].some((item) => typeof item !== "string")) {
        throw new Error(`${location}: impactTypes должен быть массивом строк`);
      }
      if (new Set(value[label]).size !== value[label].length) {
        throw new Error(`${location}: impactTypes содержит повторы`);
      }
    } else if (label === "effectiveDate") {
      if (value[label] !== null && !/^\d{4}-\d{2}-\d{2}$/.test(value[label])) {
        throw new Error(`${location}: effectiveDate должен быть YYYY-MM-DD или null`);
      }
    } else if (typeof value[label] !== "string" || !value[label].trim()) {
      throw new Error(`${location}: ${label} должен быть непустой строкой`);
    }
  }
};

const validateDataset = (dataset) => {
  if (!dataset || typeof dataset !== "object" || typeof dataset.datasetId !== "string") {
    throw new Error("Некорректный datasetId");
  }
  if (!Number.isInteger(dataset.version) || dataset.version < 1) throw new Error("Некорректная версия выборки");
  if (dataset.isModel !== true) throw new Error("K-19e fixture должен быть явно помечен isModel=true");
  if (!Array.isArray(dataset.labelSet?.impactTypes) || dataset.labelSet.impactTypes.length !== 4) {
    throw new Error("labelSet должен задавать четыре типа воздействия");
  }
  if (!Array.isArray(dataset.labelSet.industries) || dataset.labelSet.industries.length === 0) {
    throw new Error("labelSet должен задавать отрасли");
  }
  if (!Array.isArray(dataset.documents) || dataset.documents.length < 30) {
    throw new Error("Размеченная выборка должна содержать минимум 30 документов");
  }
  const ids = new Set();
  for (const document of dataset.documents) {
    if (!document || typeof document !== "object" || typeof document.id !== "string" || !document.id.trim()) {
      throw new Error("Документ без id");
    }
    if (ids.has(document.id)) throw new Error(`Повтор id документа ${document.id}`);
    ids.add(document.id);
    if (document.isModel !== true) throw new Error(`${document.id}: модельный документ не помечен isModel=true`);
    if (typeof document.title !== "string" || typeof document.text !== "string") {
      throw new Error(`${document.id}: нужны title и text`);
    }
    if (typeof document.sourceUrl !== "string" || !document.sourceUrl.startsWith("https://example.invalid/")) {
      throw new Error(`${document.id}: fixture должен использовать example.invalid`);
    }
    assertLabels(document.expected, `${document.id}/expected`);
    if (document.expected.impactTypes.some((value) => !dataset.labelSet.impactTypes.includes(value))) {
      throw new Error(`${document.id}: неизвестный тип воздействия`);
    }
    if (!dataset.labelSet.industries.includes(document.expected.industry)) {
      throw new Error(`${document.id}: неизвестная отрасль`);
    }
  }
};

const validatePredictionFile = (predictionFile, datasetId) => {
  if (!predictionFile || typeof predictionFile !== "object" || predictionFile.datasetId !== datasetId) {
    throw new Error("Файл предсказаний относится к другой выборке");
  }
  if (!Array.isArray(predictionFile.runs) || predictionFile.runs.length === 0) {
    throw new Error("Файл предсказаний не содержит runs");
  }
  const providers = predictionFile.runs.map((run) => run?.provider);
  if (new Set(providers).size !== providers.length) throw new Error("Повтор provider в runs");
};

export const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const parseArgs = (argv) => {
  const options = { pretty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--pretty") options.pretty = true;
    else if (argument === "--dataset" || argument === "--predictions") {
      const value = argv[index + 1];
      if (!value) throw new Error(`После ${argument} нужен путь`);
      options[argument.slice(2)] = value;
      index += 1;
    } else throw new Error(`Неизвестный аргумент ${argument}`);
  }
  if (!options.dataset || !options.predictions) {
    throw new Error("Использование: evaluate.mjs --dataset <labels.json> --predictions <runs.json> [--pretty]");
  }
  return options;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const report = evaluateRuns(await readJson(options.dataset), await readJson(options.predictions));
  process.stdout.write(`${JSON.stringify(report, null, options.pretty ? 2 : 0)}\n`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
