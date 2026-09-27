// All records in this file are model data. Cases 165513 and 165887 reproduce failure classes from prior portal research.
import { describe, expect, it } from "vitest";
import type { NpaProject } from "../../../src/ingest/client/index.js";
import {
  type FeedSelectionRule,
  type LabeledFeedProject,
  measureFeedSelection,
  selectFeedProjects,
} from "../../../src/ingest/text/index.js";

const RULES: FeedSelectionRule[] = [
  {
    id: "public-catering",
    sphereIds: [23],
    titleKeywords: ["общественного питания", "кафе", "ресторан*", "кейтеринг*", "столов*", "общепит*"],
    departments: ["Роспотребнадзор"],
  },
];

const project = (id: string, title: string, sphereIds: number[] = [], department?: string): NpaProject => ({
  id,
  url: `https://regulation.gov.ru/projects/${id}`,
  title,
  sphereIds,
  ...(department ? { department } : {}),
});

const SAMPLE: LabeledFeedProject[] = [
  { project: project("165513", "Об изменении Правил оказания услуг общественного питания", [1]), relevant: true },
  { project: project("m02", "Санитарные требования к организациям общественного питания", [1]), relevant: true },
  { project: project("m03", "Требования к кафе и барам", [1]), relevant: true },
  { project: project("m04", "Изменения для гостиниц и ресторанов", [23]), relevant: true },
  { project: project("m05", "О внесении изменений в отраслевые правила", [23]), relevant: true },
  { project: project("m06", "О внесении изменений в санитарные нормы", [1], "Роспотребнадзор"), relevant: true },
  { project: project("m07", "Правила оказания услуг кейтеринга", [1]), relevant: true },
  { project: project("m08", "Требования к столовым на предприятиях", [1]), relevant: true },
  { project: project("m09", "Правила работы предприятий общепита", [1]), relevant: true },
  { project: project("m10", "О безопасности услуг", [23]), relevant: true },
  { project: project("m11", "Правила обслуживания посетителей ресторанов", [1]), relevant: true },
  {
    project: project("m12", "О внесении изменений в постановление Правительства", [1], "Минэкономразвития"),
    relevant: true,
  },
  { project: project("m13", "Правила классификации гостиниц", [23]), relevant: false },
  { project: project("m14", "Требования к туристическим базам", [23]), relevant: false },
  { project: project("m15", "Календарь профилактических прививок", [1], "Роспотребнадзор"), relevant: false },
  { project: project("m16", "О качестве питьевой воды", [1], "Роспотребнадзор"), relevant: false },
  { project: project("165887", "Требования к ремонту автотранспортных средств", [45]), relevant: false },
  { project: project("m18", "Правила розничной торговли", [22]), relevant: false },
  { project: project("m19", "О добыче полезных ископаемых", [7]), relevant: false },
  { project: project("m20", "Порядок оказания медицинской помощи", [1], "Минздрав России"), relevant: false },
  { project: project("m21", "О реставрации объектов культурного наследия", [1]), relevant: false },
  { project: project("m22", "Требования к блокам питания электронной техники", [1]), relevant: false },
  { project: project("m23", "Об аттестации кафедр вузов", [1]), relevant: false },
  { project: project("m24", "О порядке ведения документации", [1]), relevant: false },
];

describe("selectFeedProjects", () => {
  it("combines signals with OR, reports evidence and always returns needs_review", () => {
    const selected = selectFeedProjects([SAMPLE[5]!.project, SAMPLE[0]!.project, SAMPLE[4]!.project], RULES);
    expect(selected.map(({ project: item }) => item.id)).toEqual(["165513", "m05", "m06"]);
    expect(selected.every(({ status }) => status === "needs_review")).toBe(true);
    expect(selected[0]?.matches).toContainEqual({
      ruleId: "public-catering",
      kind: "title_keyword",
      value: "общественного питания",
    });
    expect(selected[1]?.matches).toContainEqual({ ruleId: "public-catering", kind: "sphere", value: "23" });
    expect(selected[2]?.matches).toContainEqual({
      ruleId: "public-catering",
      kind: "department",
      value: "роспотребнадзор",
    });
  });

  it("is independent of project and rule order", () => {
    expect(
      selectFeedProjects(
        SAMPLE.map(({ project: item }) => item),
        RULES,
      ),
    ).toEqual(selectFeedProjects(SAMPLE.map(({ project: item }) => item).reverse(), [...RULES].reverse()));
  });

  it("does not match inside a word and rejects ambiguous input", () => {
    expect(selectFeedProjects([SAMPLE[20]!.project, SAMPLE[22]!.project], RULES)).toEqual([]);
    expect(() => selectFeedProjects([], [{ id: "empty" }])).toThrow("at least one signal");
    expect(() => selectFeedProjects([SAMPLE[0]!.project, SAMPLE[0]!.project], RULES)).toThrow(
      "Duplicate portal project id",
    );
  });

  it("measures misses and extra matches on 24 model projects", () => {
    expect(measureFeedSelection(SAMPLE, RULES)).toEqual({
      total: 24,
      truePositive: 11,
      falsePositive: 4,
      falseNegative: 1,
      trueNegative: 8,
      precision: 11 / 15,
      recall: 11 / 12,
    });
  });
});
