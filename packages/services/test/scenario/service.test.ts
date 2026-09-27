import {
  CONTRACT_VERSION,
  type CompanyProfile,
  FACT_KEYS,
  type Fact,
  type ProfileRepository,
  type Requirement,
} from "@max-hackathon/domain";
import { assessRequirement } from "@max-hackathon/rules";
import { describe, expect, it } from "vitest";
import { ScenarioProfileService } from "../../src/scenario/index.js";

const NOW = "2026-09-27T12:00:00Z";
const source = { system: "model-fixture", retrievedAt: NOW, isModel: true } as const;

const profile = (): CompanyProfile => ({
  contractVersion: CONTRACT_VERSION,
  companyId: "company:model-scenario",
  inn: "7700000016",
  entityType: "legal_entity",
  displayName: "Модельное кафе",
  isModel: true,
  updatedAt: "2026-09-26T08:00:00Z",
  facts: [
    {
      id: "fact:employees",
      companyId: "company:model-scenario",
      key: FACT_KEYS.hasEmployees,
      value: false,
      kind: "official",
      source,
      observedAt: "2026-09-26T08:00:00Z",
    },
  ],
});

const requirement: Requirement = {
  contractVersion: CONTRACT_VERSION,
  id: "requirement:model-employer",
  packId: "pack:model",
  packVersion: 1,
  kind: "obligation",
  title: "Модельная обязанность работодателя",
  basis: [{ act: "Модельный нормативный акт", url: "https://example.invalid/model" }],
  condition: { type: "has_employees", value: true },
  coverage: "full",
  source,
};

class TrackingProfiles implements ProfileRepository {
  readonly stored: CompanyProfile;
  saveCalls = 0;
  addFactsCalls = 0;

  constructor(value = profile()) {
    this.stored = value;
  }

  async get(companyId: string) {
    return companyId === this.stored.companyId ? this.stored : undefined;
  }

  async findByInn() {
    return this.stored;
  }

  async save() {
    this.saveCalls += 1;
  }

  async addFacts(_companyId: string, _facts: Fact[]) {
    this.addFactsCalls += 1;
  }

  async listCompanyIds() {
    return [this.stored.companyId];
  }
}

describe("ScenarioProfileService", () => {
  it("создаёт независимую копию и не изменяет реальный профиль", async () => {
    const profiles = new TrackingProfiles();
    const before = structuredClone(profiles.stored);
    const service = new ScenarioProfileService({ profiles, clock: () => NOW });

    const outcome = await service.create(profiles.stored.companyId, [{ key: FACT_KEYS.hasEmployees, value: true }]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected scenario");
    expect(profiles.stored).toEqual(before);
    expect(profiles.saveCalls).toBe(0);
    expect(profiles.addFactsCalls).toBe(0);
    expect(outcome.scenario).toMatchObject({
      isModel: true,
      createdAt: NOW,
      baseProfileUpdatedAt: before.updatedAt,
      scenarioFactIds: [`scenario:${before.companyId}:0:${FACT_KEYS.hasEmployees}`],
    });
    expect(outcome.scenario.profile).not.toBe(profiles.stored);
    expect(outcome.scenario.profile.facts.at(-1)).toMatchObject({
      key: FACT_KEYS.hasEmployees,
      value: true,
      kind: "scenario",
      source: { system: "scenario", isModel: true },
    });
  });

  it("сценарное значение действует только в режиме scenario", async () => {
    const profiles = new TrackingProfiles();
    const service = new ScenarioProfileService({ profiles, clock: () => NOW });
    const outcome = await service.create(profiles.stored.companyId, [{ key: FACT_KEYS.hasEmployees, value: true }]);
    if (outcome.status !== "ok") throw new Error("expected scenario");

    const current = assessRequirement(requirement, outcome.scenario.profile, { evaluatedAt: NOW });
    const scenario = assessRequirement(requirement, outcome.scenario.profile, {
      evaluatedAt: NOW,
      mode: "scenario",
    });

    expect(current.status).toBe("not_applies");
    expect(current.trace?.factIds).toEqual(["fact:employees"]);
    expect(scenario.status).toBe("applies");
    expect(scenario.trace?.factIds).toEqual(outcome.scenario.scenarioFactIds);
  });

  it("не переносит старые сценарные факты и глубоко копирует значения", async () => {
    const stored = profile();
    stored.facts.push({
      id: "scenario:old",
      companyId: stored.companyId,
      key: FACT_KEYS.taxRegime,
      value: "usn_income",
      kind: "scenario",
      source,
      observedAt: "2026-09-20T00:00:00Z",
    });
    const profiles = new TrackingProfiles(stored);
    const service = new ScenarioProfileService({ profiles, clock: () => NOW });
    const regimes = ["osn"];

    const outcome = await service.create(stored.companyId, [{ key: FACT_KEYS.taxRegime, value: regimes }]);
    regimes.push("psn");

    if (outcome.status !== "ok") throw new Error("expected scenario");
    expect(outcome.scenario.profile.facts.filter(({ kind }) => kind === "scenario")).toEqual([
      expect.objectContaining({ value: ["osn"] }),
    ]);
    expect(profiles.stored.facts.at(-1)?.id).toBe("scenario:old");
  });

  it("возвращает profile_not_found и отклоняет повторяющиеся ключи", async () => {
    const profiles = new TrackingProfiles();
    const service = new ScenarioProfileService({ profiles });

    await expect(service.create("missing", [])).resolves.toEqual({
      status: "profile_not_found",
      companyId: "missing",
    });
    await expect(
      service.create(profiles.stored.companyId, [
        { key: FACT_KEYS.regionCode, value: "16" },
        { key: FACT_KEYS.regionCode, value: "77" },
      ]),
    ).rejects.toThrow(`Сценарный факт ${FACT_KEYS.regionCode} задан повторно`);
  });
});
