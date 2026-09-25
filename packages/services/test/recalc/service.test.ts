import {
  type ApplicabilityRepository,
  type ApplicabilityResult,
  type ChangeEvent,
  type ChangeEventRepository,
  CONTRACT_VERSION,
  type CompanyProfile,
  FACT_KEYS,
  type ProfileRepository,
  type Requirement,
  type RequirementRepository,
} from "@max-hackathon/domain";
import { describe, expect, it } from "vitest";
import { ProfileRecalculationService } from "../../src/recalc/index.js";

const NOW = "2026-09-26T08:00:00Z";
const source = { system: "model-fixture", retrievedAt: NOW, isModel: true } as const;

const profile = (okved: string, size: string): CompanyProfile => ({
  contractVersion: CONTRACT_VERSION,
  companyId: "company:model-1",
  inn: "7700000016",
  entityType: "legal_entity",
  isModel: true,
  updatedAt: NOW,
  facts: [
    {
      id: "fact:okved",
      companyId: "company:model-1",
      key: FACT_KEYS.okvedMain,
      value: okved,
      kind: "official",
      source,
      observedAt: NOW,
    },
    {
      id: "fact:size",
      companyId: "company:model-1",
      key: FACT_KEYS.mspCategory,
      value: size,
      kind: "official",
      source,
      observedAt: NOW,
    },
  ],
});

const requirement = (id: string, condition: Requirement["condition"]): Requirement => ({
  contractVersion: CONTRACT_VERSION,
  id,
  packId: "pack:model",
  packVersion: 1,
  kind: "obligation",
  title: id,
  basis: [{ act: "Модельный нормативный акт", url: "https://example.invalid/model" }],
  condition,
  coverage: "full",
  source,
});

class MemoryProfiles implements ProfileRepository {
  constructor(public value: CompanyProfile) {}
  async get(): Promise<CompanyProfile | undefined> {
    return this.value;
  }
  async findByInn(): Promise<CompanyProfile | undefined> {
    return this.value;
  }
  async save(value: CompanyProfile) {
    this.value = value;
  }
  async addFacts() {}
  async listCompanyIds() {
    return [this.value.companyId];
  }
}

class MemoryRequirements implements RequirementRepository {
  constructor(readonly records: Requirement[]) {}
  async listByPack(_packId: string, version?: number) {
    return version === 1 ? this.records : [];
  }
  async latestVersion() {
    return 1;
  }
  async listPackIds() {
    return ["pack:model"];
  }
  async saveVersion() {}
}

class MemoryApplicability implements ApplicabilityRepository {
  value: ApplicabilityResult[] = [];
  async listByCompany() {
    return structuredClone(this.value);
  }
  async replaceForCompany(_companyId: string, results: ApplicabilityResult[]) {
    this.value = structuredClone(results);
  }
}

class MemoryEvents implements ChangeEventRepository {
  readonly values: ChangeEvent[] = [];
  async append(event: ChangeEvent) {
    if (!this.values.some((item) => item.id === event.id)) this.values.push(event);
  }
  async get(id: string) {
    return this.values.find((item) => item.id === id);
  }
}

const setup = () => {
  const profiles = new MemoryProfiles(profile("47.11", "micro"));
  const applicability = new MemoryApplicability();
  const events = new MemoryEvents();
  const requirements = new MemoryRequirements([
    requirement("req:food", { type: "okved_prefix", prefix: "56" }),
    requirement("req:small", { type: "msp_category", in: ["small"] }),
  ]);
  const service = new ProfileRecalculationService({ profiles, requirements, applicability, events, clock: () => NOW });
  return { profiles, applicability, events, service };
};

describe("ProfileRecalculationService", () => {
  it("даёт дельту появилось/исчезло при смене ОКВЭД и размера и публикует модельное событие", async () => {
    const state = setup();
    await state.service.recalculate("company:model-1", { changedFactKeys: [] });
    state.profiles.value = profile("56.10", "small");

    const result = await state.service.recalculate("company:model-1", {
      changedFactKeys: [FACT_KEYS.mspCategory, FACT_KEYS.okvedMain, FACT_KEYS.okvedMain],
      eventId: () => "event:profile-change-1",
    });

    expect(result.status).toBe("changed");
    if (result.status !== "changed") throw new Error("expected changed");
    expect(result.delta.appeared.map((item) => item.requirementId)).toEqual(["req:food", "req:small"]);
    expect(result.delta.disappeared).toEqual([]);
    expect(result.event).toMatchObject({
      id: "event:profile-change-1",
      kind: "profile_change",
      isModel: true,
      profile: { companyId: "company:model-1", changedFactKeys: [FACT_KEYS.okvedMain, FACT_KEYS.mspCategory] },
    });

    state.profiles.value = profile("47.11", "micro");
    const reversed = await state.service.recalculate("company:model-1", {
      changedFactKeys: [FACT_KEYS.okvedMain, FACT_KEYS.mspCategory],
      eventId: () => "event:profile-change-2",
    });
    if (reversed.status === "profile_not_found") throw new Error("expected recalculation");
    expect(reversed.delta.disappeared.map((item) => item.requirementId)).toEqual(["req:food", "req:small"]);
  });

  it("повторный пересчёт идемпотентен: обновляет снимок, но не создаёт событие без дельты", async () => {
    const state = setup();
    const first = await state.service.recalculate("company:model-1", { changedFactKeys: [FACT_KEYS.okvedMain] });
    const second = await state.service.recalculate("company:model-1", { changedFactKeys: [FACT_KEYS.okvedMain] });

    expect(first.status).toBe("unchanged");
    expect(second).toMatchObject({ status: "unchanged", delta: { appeared: [], disappeared: [] } });
    expect(state.events.values).toHaveLength(0);
    expect(state.applicability.value).toHaveLength(2);
  });

  it("возвращает profile_not_found и не меняет снимок", async () => {
    const state = setup();
    state.profiles.get = async () => undefined;
    await expect(state.service.recalculate("missing", { changedFactKeys: [] })).resolves.toEqual({
      status: "profile_not_found",
      companyId: "missing",
    });
    expect(state.applicability.value).toEqual([]);
  });
});
