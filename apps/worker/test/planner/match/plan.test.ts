import type { ChangeEvent, CompanyProfile, Fact } from "@max-hackathon/domain";
import { describe, expect, it } from "vitest";
import { planNotificationCandidates } from "../../../src/planner/match/index.js";

const observedAt = "2026-09-24T08:00:00Z";
const fact = (companyId: string, key: string, value: string): Fact => ({
  id: `${companyId}:${key}`,
  companyId,
  key,
  value,
  kind: "official",
  source: { system: "fixture", retrievedAt: observedAt, isModel: true },
  observedAt,
});

const profile = (companyId: string, okved: string): CompanyProfile => ({
  contractVersion: 1,
  companyId,
  inn: companyId === "cafe" ? "7700000016" : "770000000082",
  entityType: companyId === "cafe" ? "legal_entity" : "individual_entrepreneur",
  facts: [fact(companyId, "activity.okved_main", okved)],
  isModel: true,
  updatedAt: observedAt,
});

const event: ChangeEvent = {
  contractVersion: 1,
  id: "event-pack-v2",
  kind: "rulepack_version",
  occurredAt: "2026-09-24T09:00:00Z",
  isModel: true,
  rulepack: {
    packId: "foodservice",
    fromVersion: 1,
    toVersion: 2,
    addedRequirementIds: ["food.water-marking"],
    changedRequirementIds: [],
    removedRequirementIds: [],
  },
};

describe("planNotificationCandidates", () => {
  it("creates a candidate only for the matching profile", () => {
    const candidates = planNotificationCandidates(
      event,
      [profile("cafe", "56.10"), profile("retail", "47.11")],
      (_change, company) => {
        const okved = company.facts.find((item) => item.key === "activity.okved_main")?.value;
        return typeof okved === "string" && okved.startsWith("56")
          ? {
              kind: "applicability",
              requirementId: "food.water-marking",
              previousStatus: "not_applies",
              newStatus: "applies",
              matchedFactKeys: ["location.region_code", "activity.okved_main", "activity.okved_main"],
            }
          : undefined;
      },
      { now: () => new Date("2026-09-24T09:00:05Z") },
    );

    expect(candidates).toEqual([
      {
        contractVersion: 1,
        id: "candidate:event-pack-v2:cafe:0",
        companyId: "cafe",
        changeEventId: "event-pack-v2",
        reason: "became_applicable",
        requirementId: "food.water-marking",
        previousStatus: "not_applies",
        newStatus: "applies",
        matchedFactKeys: ["activity.okved_main", "location.region_code"],
        dedupKey: "cafe:food.water-marking:applies:foodservice@2",
        isModel: true,
        createdAt: "2026-09-24T09:00:05.000Z",
      },
    ]);
  });

  it("returns no candidates when no profile matches", () => {
    expect(planNotificationCandidates(event, [profile("retail", "47.11")], () => undefined)).toEqual([]);
  });

  it("skips unchanged statuses and removes duplicate matches in one run", () => {
    const company = profile("cafe", "56.10");
    const changed = {
      kind: "applicability" as const,
      requirementId: "food.water-marking",
      previousStatus: "applies" as const,
      newStatus: "needs_review" as const,
      matchedFactKeys: ["activity.okved_main"],
    };

    const candidates = planNotificationCandidates(event, [company], () => [
      changed,
      changed,
      { ...changed, requirementId: "food.unchanged", previousStatus: "needs_review" },
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ reason: "no_longer_applicable", previousStatus: "applies" });
  });

  it("distinguishes repeated transitions to the same status by pack version", () => {
    const company = profile("cafe", "56.10");
    const becameApplicable = () => ({
      kind: "applicability" as const,
      requirementId: "food.water-marking",
      previousStatus: "not_applies" as const,
      newStatus: "applies" as const,
      matchedFactKeys: ["activity.okved_main"],
    });
    const toVersion = (version: number): ChangeEvent =>
      event.kind === "rulepack_version"
        ? { ...event, id: `event-pack-v${version}`, rulepack: { ...event.rulepack, toVersion: version } }
        : event;

    const [second] = planNotificationCandidates(toVersion(2), [company], becameApplicable);
    const [fourth] = planNotificationCandidates(toVersion(4), [company], becameApplicable);

    expect(second?.dedupKey).toBe("cafe:food.water-marking:applies:foodservice@2");
    expect(fourth?.dedupKey).toBe("cafe:food.water-marking:applies:foodservice@4");
    expect(second?.dedupKey).not.toBe(fourth?.dedupKey);
  });

  it("uses the event id as the transition source for a profile change", () => {
    const profileEvent: ChangeEvent = {
      contractVersion: 1,
      id: "event-profile-1",
      kind: "profile_change",
      occurredAt: observedAt,
      isModel: true,
      profile: { companyId: "cafe", changedFactKeys: ["activity.okved_main"] },
    };
    const [candidate] = planNotificationCandidates(profileEvent, [profile("cafe", "56.10")], () => ({
      kind: "applicability",
      requirementId: "food.water-marking",
      previousStatus: "not_applies",
      newStatus: "applies",
      matchedFactKeys: ["activity.okved_main"],
    }));

    expect(candidate?.dedupKey).toBe("cafe:food.water-marking:applies:event-profile-1");
  });

  it("stays silent about a first evaluation that is not applicable or out of coverage", () => {
    const first = (
      newStatus: "not_applies" | "out_of_coverage" | "applies" | "needs_review" | "insufficient_data",
    ) => ({
      kind: "applicability" as const,
      requirementId: "food.water-marking",
      newStatus,
      matchedFactKeys: [],
    });
    const plan = (newStatus: Parameters<typeof first>[0]) =>
      planNotificationCandidates(event, [profile("cafe", "56.10")], () => first(newStatus));

    expect(plan("not_applies")).toEqual([]);
    expect(plan("out_of_coverage")).toEqual([]);
    for (const status of ["applies", "needs_review", "insufficient_data"] as const) {
      expect(plan(status)).toHaveLength(1);
    }
  });

  it("creates an early signal only for a regulation document", () => {
    const regulationEvent: ChangeEvent = {
      contractVersion: 1,
      id: "event-document",
      kind: "regulation_document",
      occurredAt: observedAt,
      isModel: true,
      document: {
        documentId: "model-42",
        title: "Модельный проект акта",
        url: "https://regulation.gov.ru/model-42",
        publishedAt: observedAt,
        source: {
          system: "regulation.gov.ru",
          url: "https://regulation.gov.ru/model-42",
          retrievedAt: observedAt,
          isModel: true,
        },
      },
    };

    const [candidate] = planNotificationCandidates(regulationEvent, [profile("cafe", "56.10")], () => ({
      kind: "early_signal",
      matchedFactKeys: ["activity.okved_main"],
    }));

    expect(candidate).toMatchObject({
      reason: "early_signal",
      newStatus: "needs_review",
      dedupKey: "cafe:doc:model-42",
    });
  });

  it("rejects an early signal for another event kind", () => {
    expect(() =>
      planNotificationCandidates(event, [profile("cafe", "56.10")], () => ({
        kind: "early_signal",
        matchedFactKeys: [],
      })),
    ).toThrow("early_signal is only valid for a regulation_document event");
  });
});
