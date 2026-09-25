import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPLICABILITY_STATUSES,
  type ApplicabilityStatus,
  type CompanyProfile,
  type Fact,
  type Id,
  type ProfileRepository,
  type Requirement,
  type RequirementRepository,
} from "@max-hackathon/domain";
import { describe, expect, it } from "vitest";
import { ChecklistService } from "../../src/checklist/index.js";

const root = join(import.meta.dirname, "../../../..");
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(root, "data/fixtures", name), "utf8")) as T;

interface PackFixture {
  packId: Id;
  packVersion: number;
  requirements: Requirement[];
}

interface ExpectedFixture {
  evaluatedAt: string;
  statuses: Record<string, Record<string, Record<string, { status: ApplicabilityStatus; missingFactKeys?: string[] }>>>;
}

class MemoryProfiles implements ProfileRepository {
  readonly #profiles = new Map<Id, CompanyProfile>();

  constructor(profiles: readonly CompanyProfile[]) {
    for (const profile of profiles) this.#profiles.set(profile.companyId, structuredClone(profile));
  }

  async get(companyId: Id): Promise<CompanyProfile | undefined> {
    return structuredClone(this.#profiles.get(companyId));
  }

  async findByInn(inn: string): Promise<CompanyProfile | undefined> {
    return structuredClone([...this.#profiles.values()].find((profile) => profile.inn === inn));
  }

  async save(profile: CompanyProfile): Promise<void> {
    this.#profiles.set(profile.companyId, structuredClone(profile));
  }

  async addFacts(companyId: Id, facts: Fact[]): Promise<void> {
    const profile = this.#profiles.get(companyId);
    if (!profile) throw new Error(`Профиль ${companyId} не найден`);
    profile.facts.push(...structuredClone(facts));
  }

  async listCompanyIds(): Promise<Id[]> {
    return [...this.#profiles.keys()];
  }
}

class MemoryRequirements implements RequirementRepository {
  readonly #packs = new Map<Id, Map<number, Requirement[]>>();

  constructor(packs: readonly PackFixture[]) {
    for (const pack of packs) void this.saveVersion(pack.packId, pack.packVersion, pack.requirements);
  }

  async listByPack(packId: Id, version?: number): Promise<Requirement[]> {
    const target = version ?? (await this.latestVersion(packId));
    if (target === undefined) return [];
    return structuredClone(this.#packs.get(packId)?.get(target) ?? []);
  }

  async latestVersion(packId: Id): Promise<number | undefined> {
    const versions = [...(this.#packs.get(packId)?.keys() ?? [])];
    return versions.length === 0 ? undefined : Math.max(...versions);
  }

  async listPackIds(): Promise<Id[]> {
    // Обратный порядок специально проверяет детерминированную сортировку сервиса.
    return [...this.#packs.keys()].reverse();
  }

  async saveVersion(packId: Id, version: number, requirements: Requirement[]): Promise<void> {
    const versions = this.#packs.get(packId) ?? new Map<number, Requirement[]>();
    versions.set(version, structuredClone(requirements));
    this.#packs.set(packId, versions);
  }
}

const companies = fixture<CompanyProfile[]>("k28-companies.json");
const modelPack = fixture<PackFixture>("k28-rulepack-v1.json");
const expected = fixture<ExpectedFixture>("k28-expected.json");

describe("ChecklistService", () => {
  it.each(companies.map((company) => [company.companyId, company] as const))(
    "строит ожидаемый перечень K-28 для %s",
    async (companyId) => {
      const service = new ChecklistService({
        profiles: new MemoryProfiles(companies),
        requirements: new MemoryRequirements([modelPack]),
        clock: () => expected.evaluatedAt,
      });

      const outcome = await service.build(companyId);

      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") return;
      expect(outcome.checklist.packs).toEqual([
        { packId: "k28-model", packVersion: 1, itemCount: modelPack.requirements.length },
      ]);
      expect(
        Object.fromEntries(
          outcome.checklist.items.map(({ requirement, applicability }) => [
            requirement.id,
            applicability.missingFactKeys
              ? { status: applicability.status, missingFactKeys: applicability.missingFactKeys }
              : { status: applicability.status },
          ]),
        ),
      ).toEqual(expected.statuses["1"]?.[companyId]);
      expect(
        outcome.checklist.items.every(({ applicability }) => applicability.evaluatedAt === expected.evaluatedAt),
      ).toBe(true);
      expect(Object.values(outcome.checklist.statusCounts).reduce((sum, count) => sum + count, 0)).toBe(
        modelPack.requirements.length,
      );
    },
  );

  it("подключает новый пакет без изменения сервиса и умеет выбрать подмножество пакетов", async () => {
    const foodRequirement: Requirement = {
      ...structuredClone(modelPack.requirements[0]!),
      id: "foodservice.dynamic-duty",
      packId: "foodservice",
      packVersion: 1,
      title: "Динамически подключённая обязанность общепита (модельная запись)",
    };
    const requirements = new MemoryRequirements([
      modelPack,
      { packId: "foodservice", packVersion: 1, requirements: [foodRequirement] },
    ]);
    const service = new ChecklistService({
      profiles: new MemoryProfiles(companies),
      requirements,
      clock: () => expected.evaluatedAt,
    });

    const all = await service.build("k28-cafe-msk");
    expect(all.status).toBe("ok");
    if (all.status !== "ok") return;
    expect(all.checklist.packs.map(({ packId }) => packId)).toEqual(["foodservice", "k28-model"]);
    expect(all.checklist.items.find((item) => item.requirement.id === foodRequirement.id)?.applicability.status).toBe(
      "applies",
    );

    const selected = await service.build("k28-cafe-msk", { packIds: ["k28-model", "k28-model"] });
    expect(selected.status).toBe("ok");
    if (selected.status !== "ok") return;
    expect(selected.checklist.packs.map(({ packId }) => packId)).toEqual(["k28-model"]);
  });

  it("возвращает явный результат для отсутствующего профиля", async () => {
    const service = new ChecklistService({
      profiles: new MemoryProfiles([]),
      requirements: new MemoryRequirements([modelPack]),
    });

    await expect(service.build("missing-company")).resolves.toEqual({
      status: "profile_not_found",
      companyId: "missing-company",
    });
  });

  it("инициализирует счётчики для всех пяти статусов", async () => {
    const service = new ChecklistService({
      profiles: new MemoryProfiles(companies),
      requirements: new MemoryRequirements([modelPack]),
      clock: () => expected.evaluatedAt,
    });
    const outcome = await service.build("k28-cafe-msk");
    if (outcome.status !== "ok") throw new Error("Профиль фикстуры не найден");

    expect(Object.keys(outcome.checklist.statusCounts)).toEqual([...APPLICABILITY_STATUSES]);
    expect(outcome.checklist.statusCounts).toEqual({
      applies: 4,
      not_applies: 0,
      insufficient_data: 0,
      needs_review: 1,
      out_of_coverage: 1,
    });
  });
});
