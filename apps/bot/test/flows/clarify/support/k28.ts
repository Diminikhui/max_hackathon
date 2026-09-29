// Модельные данные K-28 (data/fixtures/k28-*): компании и пакет вымышлены. Хранилища — в памяти процесса.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CompanyProfile,
  Fact,
  Id,
  ProfileRepository,
  ProfileSource,
  Requirement,
  RequirementRepository,
} from "@max-hackathon/domain";
import { ChecklistService, ProfileService } from "@max-hackathon/services";

const root = join(import.meta.dirname, "../../../../../..");
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(root, "data/fixtures", name), "utf8")) as T;

export const K28_COMPANIES = fixture<CompanyProfile[]>("k28-companies.json");
const K28_PACK = fixture<{ packId: Id; packVersion: number; requirements: Requirement[] }>("k28-rulepack-v1.json");

export const EVALUATED_AT = "2026-09-28T09:00:00.000Z";

export class MemoryProfiles implements ProfileRepository {
  readonly #profiles = new Map<Id, CompanyProfile>();

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
    const ids = new Set(facts.map((fact) => fact.id));
    profile.facts = [...profile.facts.filter((fact) => !ids.has(fact.id)), ...structuredClone(facts)];
  }

  async listCompanyIds(): Promise<Id[]> {
    return [...this.#profiles.keys()];
  }
}

class MemoryRequirements implements RequirementRepository {
  readonly #requirements: Requirement[];

  constructor(requirements: readonly Requirement[]) {
    this.#requirements = structuredClone([...requirements]);
  }

  async listByPack(packId: Id, version?: number): Promise<Requirement[]> {
    return structuredClone(
      this.#requirements.filter((r) => r.packId === packId && (version === undefined || r.packVersion === version)),
    );
  }

  async latestVersion(packId: Id): Promise<number | undefined> {
    return packId === K28_PACK.packId ? K28_PACK.packVersion : undefined;
  }

  async listPackIds(): Promise<Id[]> {
    return [K28_PACK.packId];
  }

  async saveVersion(): Promise<void> {
    throw new Error("Модельный пакет K-28 только для чтения");
  }
}

/** Модельный источник профиля: отвечает профилями K-28 вместо реестра МСП. */
const k28Source: ProfileSource = {
  info: { name: "fixture", isModel: true },
  async lookupByInn(inn) {
    const profile = K28_COMPANIES.find((company) => company.inn === inn);
    return profile ? { status: "found", profile: structuredClone(profile) } : { status: "not_found" };
  },
};

/** Сервисы ядра на модельных данных K-28 и онбординг по ИНН, как в сценарии K-24a. */
export const createK28Services = () => {
  const repository = new MemoryProfiles();
  const clock = () => EVALUATED_AT;
  const profiles = new ProfileService({ source: k28Source, repository, clock });
  const checklist = new ChecklistService({
    profiles: repository,
    requirements: new MemoryRequirements(K28_PACK.requirements),
    clock,
  });

  const onboard = async (inn: string): Promise<Id> => {
    const found = await profiles.lookup(inn);
    if (found.status !== "found") throw new Error(`Модельный ИНН ${inn} не найден: ${found.status}`);
    const saved = await profiles.confirm(found.profile);
    if (saved.status !== "ok") throw new Error(`Профиль ${inn} не сохранён`);
    return saved.companyId;
  };

  return { repository, profiles, checklist, onboard };
};
