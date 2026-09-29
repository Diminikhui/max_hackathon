// All companies, facts, rulepacks and sources in this file are model data.
import {
  CONTRACT_VERSION,
  type CompanyProfile,
  FACT_KEYS,
  type Requirement,
  type SourceRef,
} from "@max-hackathon/domain";
import { describe, expect, it } from "vitest";
import {
  CoverageHistoryService,
  MemoryCoverageHistoryRegistry,
  type RulepackHistorySnapshot,
} from "../../src/coverage/index.js";

const RUN_AT = "2026-09-27T12:00:00Z";
const modelSource = (recordId: string, retrievedAt = RUN_AT): SourceRef & { url: string } => ({
  system: "model-fixture",
  url: `https://example.invalid/4-13/${recordId}`,
  recordId,
  retrievedAt,
  isModel: true,
});

const profile = (okved: string, updatedAt: string): CompanyProfile => ({
  contractVersion: CONTRACT_VERSION,
  companyId: "company:model-cafe",
  inn: "7700000016",
  entityType: "legal_entity",
  isModel: true,
  updatedAt,
  facts: [
    {
      id: `fact:okved:${okved}`,
      companyId: "company:model-cafe",
      key: FACT_KEYS.okvedMain,
      value: okved,
      kind: "official",
      source: modelSource(`profile-${okved}`, updatedAt),
      observedAt: updatedAt,
    },
  ],
});

const requirement = (
  version: number,
  prefix: string,
  packId = "pack:model-foodservice",
  retrievedAt = RUN_AT,
): Requirement => ({
  contractVersion: CONTRACT_VERSION,
  id: `req:${packId}`,
  packId,
  packVersion: version,
  kind: "obligation",
  title: `Модельное правило v${version}`,
  basis: [{ act: "Модельный акт", url: "https://example.invalid/4-13/model-law" }],
  condition: { type: "okved_prefix", prefix },
  coverage: "full",
  source: modelSource(`${packId}-rule-v${version}`, retrievedAt),
});

const rulepack = (
  version: number,
  publishedAt: string,
  validity: RulepackHistorySnapshot["validity"],
  prefix: string,
  packId = "pack:model-foodservice",
): RulepackHistorySnapshot => ({
  packId,
  packVersion: version,
  title: `Модельный пакет v${version}`,
  owner: { name: "Модельная команда" },
  source: modelSource(`${packId}-v${version}`, publishedAt),
  publishedAt,
  validity,
  isModel: true,
  requirements: [requirement(version, prefix, packId, publishedAt)],
});

async function historyFixture() {
  const registry = new MemoryCoverageHistoryRegistry();
  await registry.appendProfile({
    companyId: "company:model-cafe",
    recordedAt: "2026-01-10T09:00:00Z",
    profile: profile("56.10", "2026-01-10T09:00:00Z"),
  });
  await registry.appendRulepack(rulepack(1, "2026-01-01T09:00:00Z", { from: "2026-01-01" }, "56"));
  await registry.appendProfile({
    companyId: "company:model-cafe",
    recordedAt: "2026-07-10T09:00:00Z",
    profile: profile("47.11", "2026-07-10T09:00:00Z"),
  });
  await registry.appendRulepack(rulepack(2, "2026-07-01T09:00:00Z", { from: "2026-07-01" }, "47"));
  return registry;
}

describe("CoverageHistoryService", () => {
  it("reproduces past calculations with the rule and profile versions known on each date", async () => {
    const service = new CoverageHistoryService({ history: await historyFixture(), clock: () => RUN_AT });

    const january = await service.reproduce("company:model-cafe", { asOf: "2026-01-15" });
    expect(january.status).toBe("ok");
    if (january.status !== "ok") throw new Error("expected historical calculation");
    expect(january.calculation.profileRecordedAt).toBe("2026-01-10T09:00:00Z");
    expect(january.calculation.packs).toEqual([
      expect.objectContaining({ packId: "pack:model-foodservice", packVersion: 1, isModel: true }),
    ]);
    expect(january.calculation.items[0]).toMatchObject({
      requirement: { title: "Модельное правило v1" },
      applicability: {
        status: "applies",
        evaluatedAt: RUN_AT,
        explanation: expect.arrayContaining([
          expect.objectContaining({ kind: "source", url: "https://example.invalid/4-13/model-law" }),
        ]),
      },
    });

    await expect(service.reproduce("company:model-cafe", { asOf: "2026-08-01" })).resolves.toMatchObject({
      status: "ok",
      calculation: {
        profileRecordedAt: "2026-07-10T09:00:00Z",
        packs: [{ packVersion: 2 }],
        items: [{ applicability: { status: "applies" } }],
      },
    });
  });

  it("does not let a late correction rewrite an earlier result", async () => {
    const registry = await historyFixture();
    const service = new CoverageHistoryService({ history: registry, clock: () => RUN_AT });
    const before = await service.reproduce("company:model-cafe", { asOf: "2026-01-15" });
    await registry.appendProfile({
      companyId: "company:model-cafe",
      recordedAt: "2026-09-01T09:00:00Z",
      profile: profile("01.11", "2026-01-05T09:00:00Z"),
    });
    expect(await service.reproduce("company:model-cafe", { asOf: "2026-01-15" })).toEqual(before);
  });

  it("does not use a version published after asOf even when its validity starts earlier", async () => {
    const registry = new MemoryCoverageHistoryRegistry();
    await registry.appendProfile({
      companyId: "company:model-cafe",
      recordedAt: "2026-01-01T09:00:00Z",
      profile: profile("56.10", "2026-01-01T09:00:00Z"),
    });
    await registry.appendRulepack(rulepack(1, "2026-01-01T09:00:00Z", { from: "2026-01-01" }, "56"));
    await registry.appendRulepack(rulepack(2, "2026-03-01T09:00:00Z", { from: "2026-02-01" }, "47"));
    const service = new CoverageHistoryService({ history: registry, clock: () => RUN_AT });
    await expect(service.reproduce("company:model-cafe", { asOf: "2026-02-15" })).resolves.toMatchObject({
      status: "ok",
      calculation: { packs: [{ packVersion: 1 }] },
    });
  });

  it("returns deterministic pack order, status counts, filtering and dated not-found", async () => {
    const registry = await historyFixture();
    await registry.appendRulepack(
      rulepack(1, "2026-01-02T09:00:00Z", { from: "2026-01-01" }, "77", "pack:model-agriculture"),
    );
    const service = new CoverageHistoryService({ history: registry, clock: () => RUN_AT });
    await expect(service.reproduce("company:model-cafe", { asOf: "2026-01-15" })).resolves.toMatchObject({
      status: "ok",
      calculation: {
        packs: [{ packId: "pack:model-agriculture" }, { packId: "pack:model-foodservice" }],
        statusCounts: { applies: 1, not_applies: 1, insufficient_data: 0, needs_review: 0, out_of_coverage: 0 },
      },
    });
    await expect(
      service.reproduce("company:model-cafe", {
        asOf: "2026-01-15",
        packIds: ["pack:model-foodservice", "pack:model-foodservice"],
      }),
    ).resolves.toMatchObject({ status: "ok", calculation: { packs: [{ packId: "pack:model-foodservice" }] } });
    await expect(service.reproduce("company:model-cafe", { asOf: "2025-12-31" })).resolves.toEqual({
      status: "profile_not_found_for_date",
      companyId: "company:model-cafe",
      asOf: "2025-12-31",
    });
  });
});

describe("MemoryCoverageHistoryRegistry", () => {
  it("keeps immutable copies and rejects duplicate snapshots", async () => {
    const registry = new MemoryCoverageHistoryRegistry();
    const snapshot = rulepack(1, "2026-01-01T09:00:00Z", { from: "2026-01-01" }, "56");
    await registry.appendRulepack(snapshot);
    snapshot.requirements[0]!.title = "mutated outside registry";
    const firstRead = await registry.listRulepacks();
    firstRead[0]!.requirements[0]!.title = "mutated read result";
    expect((await registry.listRulepacks())[0]?.requirements[0]?.title).toBe("Модельное правило v1");
    await expect(
      registry.appendRulepack(rulepack(1, "2026-01-02T09:00:00Z", { from: "2026-01-01" }, "56")),
    ).rejects.toThrow("already exists");
  });
});
