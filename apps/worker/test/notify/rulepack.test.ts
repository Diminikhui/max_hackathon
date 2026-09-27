// K-30a: разница версий пакета и сопоставление перехода с профилем. Записи и профиль модельные.
import type { CompanyProfile, Requirement, RequirementRepository } from "@max-hackathon/domain";
import { describe, expect, it } from "vitest";
import { latestTransition, rulepackEvent, rulepackMatcher } from "../../src/notify/index.js";
import { planNotificationCandidates } from "../../src/planner/match/index.js";

const NOW = "2026-09-28T09:00:00.000Z";

const requirement = (id: string, version: number, overrides: Partial<Requirement> = {}): Requirement => ({
  contractVersion: 1,
  id,
  packId: "model-pack",
  packVersion: version,
  kind: "obligation",
  title: `${id} (модельная запись)`,
  basis: [{ act: "Модельный акт", url: "https://example.invalid/model" }],
  condition: { type: "always" },
  coverage: "full",
  source: { system: "fixture", retrievedAt: `2026-09-2${version}T00:00:00Z`, isModel: true },
  ...overrides,
});

const repository = (
  versions: Record<number, Requirement[]>,
): Pick<RequirementRepository, "latestVersion" | "listByPack"> => ({
  latestVersion: async () => Math.max(...Object.keys(versions).map(Number)),
  listByPack: async (_packId, version) => structuredClone(versions[version ?? 0] ?? []),
});

const profile: CompanyProfile = {
  contractVersion: 1,
  companyId: "model-company",
  inn: "7700000000",
  entityType: "legal_entity",
  facts: [],
  isModel: true,
  updatedAt: NOW,
};

describe("latestTransition", () => {
  it("находит добавленные, изменённые и удалённые записи, не считая изменением новую версию и дату выгрузки", async () => {
    const transition = await latestTransition(
      repository({
        1: [requirement("same", 1), requirement("edited", 1), requirement("removed", 1)],
        3: [requirement("same", 3), requirement("edited", 3, { title: "Новая редакция" }), requirement("added", 3)],
      }),
      "model-pack",
    );

    expect(transition?.change).toEqual({
      packId: "model-pack",
      fromVersion: 1,
      toVersion: 3,
      addedRequirementIds: ["added"],
      changedRequirementIds: ["edited"],
      removedRequirementIds: ["removed"],
    });
    expect(transition && rulepackEvent(transition, NOW)).toMatchObject({ id: "rulepack_version:model-pack:1->3" });
  });

  it("не даёт перехода для единственной версии", async () => {
    expect(await latestTransition(repository({ 1: [requirement("a", 1)] }), "model-pack")).toBeUndefined();
  });
});

describe("rulepackMatcher", () => {
  it("удалённая применимая запись даёт «больше не применяется», новая — «стала применяться»", async () => {
    const transition = await latestTransition(
      repository({ 1: [requirement("removed", 1)], 2: [requirement("added", 2)] }),
      "model-pack",
    );
    if (!transition) throw new Error("ожидался переход");
    const event = rulepackEvent(transition, NOW);

    const candidates = planNotificationCandidates(event, [profile], rulepackMatcher(transition, { evaluatedAt: NOW }), {
      now: () => new Date(NOW),
    });

    expect(
      candidates.map(({ requirementId, reason, previousStatus, newStatus }) => ({
        requirementId,
        reason,
        previousStatus,
        newStatus,
      })),
    ).toEqual([
      { requirementId: "added", reason: "became_applicable", previousStatus: undefined, newStatus: "applies" },
      { requirementId: "removed", reason: "no_longer_applicable", previousStatus: "applies", newStatus: "not_applies" },
    ]);
  });
});
