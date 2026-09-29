// K-34. Покрытие на реальных пакетах A и B и модельных компаниях K-28.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompanyProfile, Fact, Id, ProfileRepository, Requirement, RequirementRepository } from "@max-hackathon/domain";
import { describe, expect, it } from "vitest";
import {
  ChecklistService,
  type CoverageCatalog,
  DEFAULT_COVERAGE_CATALOG,
  describeCoverage,
  matchesOkved,
  regionName,
} from "../../../src/index.js";

const root = join(import.meta.dirname, "../../../../..");
const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(root, path), "utf8")) as T;
const k28 = readJson<CompanyProfile[]>("data/fixtures/k28-companies.json");
const packs = [
  "data/rulepacks/a/foodservice-federal-v1.json",
  "data/rulepacks/a/tatarstan/foodservice-tatarstan-v1.json",
  "data/rulepacks/b/autoservice-federal-v1.json",
].map((path) =>
  readJson<{ packId: Id; packVersion: number; requirements: Requirement[] }>(path),
);

const withFact = (profile: CompanyProfile, key: string, value: Fact["value"] | undefined, companyId: Id): CompanyProfile => {
  const clone = structuredClone(profile);
  clone.companyId = companyId;
  clone.facts = clone.facts.filter((fact) => fact.key !== key).map((fact) => ({ ...fact, companyId }));
  if (value !== undefined) {
    clone.facts.push({ ...(profile.facts[0] as Fact), id: `${companyId}.${key}`, companyId, key, value });
  }
  return clone;
};

const cafeMsk = k28.find((profile) => profile.companyId === "k28-cafe-msk") as CompanyProfile;
const profiles: CompanyProfile[] = [
  ...k28,
  withFact(cafeMsk, "location.region_code", "36", "model-cafe-vrn"),
  withFact(cafeMsk, "location.region_code", undefined, "model-cafe-no-region"),
  withFact(cafeMsk, "activity.okved_main", undefined, "model-no-okved"),
];

const profileRepo: ProfileRepository = {
  get: async (id) => structuredClone(profiles.find((profile) => profile.companyId === id)),
  findByInn: async () => undefined,
  save: async () => {},
  addFacts: async () => {},
  listCompanyIds: async () => profiles.map((profile) => profile.companyId),
};
const requirementRepo: RequirementRepository = {
  listByPack: async (packId) => structuredClone(packs.find((pack) => pack.packId === packId)?.requirements ?? []),
  latestVersion: async (packId) => packs.find((pack) => pack.packId === packId)?.packVersion,
  listPackIds: async () => packs.map((pack) => pack.packId),
  saveVersion: async () => {},
};

const service = new ChecklistService({ profiles: profileRepo, requirements: requirementRepo, clock: () => "2026-09-27T12:00:00Z" });

async function coverageOf(companyId: Id, catalog?: CoverageCatalog) {
  const outcome = await service.build(companyId);
  if (outcome.status !== "ok") throw new Error(outcome.status);
  return { report: describeCoverage(outcome.profile, outcome.checklist, catalog), checklist: outcome.checklist };
}

describe("describeCoverage", () => {
  it("кафе из другого региона получает федеральный перечень и «вне покрытия» для региона", async () => {
    const { report, checklist } = await coverageOf("model-cafe-vrn");
    expect(report.direction).toEqual({ status: "covered", id: "a", title: "Общепит" });
    expect(report.regional).toEqual({ status: "out_of_coverage", code: "36", name: "Воронежская область" });
    expect(report.relevantItemCount).toBeGreaterThan(0);
    expect(checklist.items.filter((item) => item.requirement.packId === "a-foodservice-fed").length).toBe(21);
    expect(report.packs).toEqual([{ packId: "a-foodservice-fed", packVersion: 1, checkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }]);
    expect(report.actualAt).toBe(report.packs[0]?.checkedAt);
  });

  it("Москва для общепита — региональная часть проверена", async () => {
    const { report } = await coverageOf("k28-cafe-msk");
    expect(report.regional).toMatchObject({ status: "covered", code: "77", name: "Москва" });
    expect(report.isModel).toBe(true);
    expect(report.testCompanies).toBeUndefined();
  });

  it("Татарстан для общепита — региональная часть проверена, дата учитывает региональный пакет", async () => {
    const { report, checklist } = await coverageOf("k28-cafe-kzn");
    expect(report.regional).toMatchObject({ status: "covered", code: "16", name: "Республика Татарстан" });
    expect(report.packs.map((pack) => pack.packId)).toEqual(["a-foodservice-fed", "a-foodservice-ru-16"]);
    const regionalPack = report.packs.find((pack) => pack.packId === "a-foodservice-ru-16");
    expect(regionalPack?.checkedAt).toBe("2026-09-27");
    expect(report.actualAt).toBe("2026-09-27");
    expect(checklist.items.filter((item) => item.requirement.packId === "a-foodservice-ru-16").length).toBeGreaterThan(0);
  });

  it("автосервис в Москве — региональная часть вне покрытия", async () => {
    const auto = (await coverageOf("k28-autoservice-msk")).report;
    expect(auto.direction).toMatchObject({ status: "covered", id: "b" });
    expect(auto.regional).toMatchObject({ status: "out_of_coverage", code: "77" });
  });

  it("ОКВЭД вне направлений — понятный статус и тестовые ИНН", async () => {
    const { report } = await coverageOf("k28-retail-ip-msk");
    expect(report.direction).toEqual({ status: "outside_directions", okvedMain: "47.11" });
    expect(report.regional).toBeUndefined();
    expect(report.packs).toEqual([]);
    expect(report.testCompanies?.map((company) => company.inn)).toEqual(["7700000016", "1600000011", "7700000023"]);
  });

  it("нет ОКВЭД или региона — статусы unknown, а не ошибка", async () => {
    expect((await coverageOf("model-no-okved")).report.direction).toEqual({ status: "unknown_okved" });
    expect((await coverageOf("model-cafe-no-region")).report.regional).toEqual({ status: "unknown_region" });
  });

  it("регион из каталога делает региональную часть покрытой без правок кода", async () => {
    const catalog: CoverageCatalog = {
      ...DEFAULT_COVERAGE_CATALOG,
      directions: DEFAULT_COVERAGE_CATALOG.directions.map((direction) =>
        direction.id === "a" ? { ...direction, regions: [...direction.regions, { code: "36", note: "модельная проверка" }] } : direction,
      ),
    };
    expect((await coverageOf("model-cafe-vrn", catalog)).report.regional).toMatchObject({ status: "covered", code: "36" });
  });

  it("сопоставление ОКВЭД по префиксу и названия регионов", () => {
    expect(matchesOkved("56.10", "56")).toBe(true);
    expect(matchesOkved("56", "56")).toBe(true);
    expect(matchesOkved("560", "56")).toBe(false);
    expect(matchesOkved("45.20", "45.2")).toBe(true);
    expect(matchesOkved("45.11", "45.2")).toBe(false);
    expect(regionName("16")).toBe("Республика Татарстан");
    expect(regionName("99")).toBe("регион 99");
  });

  it("каждое направление каталога ссылается на существующий пакет", () => {
    const ids = packs.map((pack) => pack.packId);
    for (const direction of DEFAULT_COVERAGE_CATALOG.directions) {
      for (const packId of direction.packIds) expect(ids).toContain(packId);
    }
  });
});
