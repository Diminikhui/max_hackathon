import {
  CONTRACT_VERSION,
  type CompanyProfile,
  FACT_KEYS,
  type Id,
  type Requirement,
  type RequirementRepository,
} from "@max-hackathon/domain";
import { describe, expect, it } from "vitest";
import { ScenarioDeltaService } from "../../src/scenario/index.js";

const NOW = "2026-09-27T12:00:00Z";
const COMPANY_ID = "company:scenario-delta";
const source = { system: "model-fixture", retrievedAt: NOW, isModel: true } as const;

const modelProfile = (): CompanyProfile => ({
  contractVersion: CONTRACT_VERSION,
  companyId: COMPANY_ID,
  inn: "7700000016",
  entityType: "legal_entity",
  isModel: true,
  updatedAt: "2026-09-26T08:00:00Z",
  facts: [
    fact("fact:employees", FACT_KEYS.hasEmployees, false),
    fact("fact:okved", FACT_KEYS.okvedMain, "47.11"),
    fact("fact:region", FACT_KEYS.regionCode, "77"),
  ],
});

const fact = (id: Id, key: string, value: boolean | string) => ({
  id,
  companyId: COMPANY_ID,
  key,
  value,
  kind: "official" as const,
  source,
  observedAt: "2026-09-26T08:00:00Z",
});

const requirements: Requirement[] = [
  requirement("requirement:hire", "obligation", { type: "has_employees", value: true }),
  requirement("requirement:food", "obligation", { type: "okved_prefix", prefix: "56" }),
  requirement("requirement:tatarstan-support", "opportunity", { type: "region", codes: ["16"] }),
];

function requirement(id: Id, kind: Requirement["kind"], condition: Requirement["condition"]): Requirement {
  return {
    contractVersion: CONTRACT_VERSION,
    id,
    packId: "pack:scenario",
    packVersion: 2,
    kind,
    title: id,
    basis: [{ act: "Модельный акт", url: "https://example.invalid/model" }],
    condition,
    coverage: "full",
    source,
  };
}

class MemoryRequirements implements RequirementRepository {
  constructor(readonly records: Requirement[] = requirements) {}

  async listByPack() {
    return structuredClone(this.records);
  }

  async latestVersion() {
    return 2;
  }

  async listPackIds() {
    return ["pack:scenario"];
  }

  async saveVersion() {}
}

const service = (stored: CompanyProfile | null = modelProfile(), records = requirements) =>
  new ScenarioDeltaService({
    profiles: {
      get: async (companyId) => (stored && companyId === stored.companyId ? structuredClone(stored) : undefined),
    },
    requirements: new MemoryRequirements(records),
    clock: () => NOW,
  });

describe("ScenarioDeltaService", () => {
  it.each([
    {
      title: "найм сотрудника",
      input: { key: FACT_KEYS.hasEmployees, value: true },
      group: "obligations" as const,
      requirementId: "requirement:hire",
    },
    {
      title: "новый ОКВЭД",
      input: { key: FACT_KEYS.okvedMain, value: "56.10" },
      group: "obligations" as const,
      requirementId: "requirement:food",
    },
    {
      title: "другой регион",
      input: { key: FACT_KEYS.regionCode, value: "16" },
      group: "opportunities" as const,
      requirementId: "requirement:tatarstan-support",
    },
  ])("показывает появившийся результат: $title", async ({ input, group, requirementId }) => {
    const outcome = await service().compare(COMPANY_ID, [input]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected scenario delta");
    expect(outcome.packs).toEqual([{ packId: "pack:scenario", version: 2 }]);
    expect(outcome.delta[group].appeared).toHaveLength(1);
    expect(outcome.delta[group].appeared[0]).toMatchObject({
      requirement: { id: requirementId },
      before: { status: "not_applies", evaluatedAt: NOW },
      after: { status: "applies", evaluatedAt: NOW },
    });
  });

  it("показывает исчезнувшее обязательство", async () => {
    const stored = modelProfile();
    stored.facts[0] = fact("fact:employees", FACT_KEYS.hasEmployees, true);

    const outcome = await service(stored).compare(COMPANY_ID, [{ key: FACT_KEYS.hasEmployees, value: false }]);

    if (outcome.status !== "ok") throw new Error("expected scenario delta");
    expect(outcome.delta.obligations.disappeared).toEqual([
      expect.objectContaining({
        requirement: expect.objectContaining({ id: "requirement:hire" }),
        before: expect.objectContaining({ status: "applies" }),
        after: expect.objectContaining({ status: "not_applies" }),
      }),
    ]);
  });

  it("отделяет изменение видимого статуса от появления", async () => {
    const missingFactRequirement = requirement("requirement:unknown", "obligation", {
      type: "has_employees",
      value: true,
    });
    const stored = modelProfile();
    stored.facts = stored.facts.filter(({ key }) => key !== FACT_KEYS.hasEmployees);

    const outcome = await service(stored, [missingFactRequirement]).compare(COMPANY_ID, [
      { key: FACT_KEYS.hasEmployees, value: true },
    ]);

    if (outcome.status !== "ok") throw new Error("expected scenario delta");
    expect(outcome.delta.obligations.appeared).toEqual([]);
    expect(outcome.delta.obligations.changed[0]).toMatchObject({
      before: { status: "insufficient_data" },
      after: { status: "applies" },
    });
  });

  it("возвращает profile_not_found до чтения пакетов", async () => {
    await expect(service(null).compare("missing", [])).resolves.toEqual({
      status: "profile_not_found",
      companyId: "missing",
    });
  });

  it("отклоняет запись вне зафиксированной версии пакета", async () => {
    const invalid: Requirement = { ...requirements[0]!, packVersion: 1 };
    await expect(service(modelProfile(), [invalid]).compare(COMPANY_ID, [])).rejects.toThrow(
      "вне снимка pack:scenario@2",
    );
  });
});
