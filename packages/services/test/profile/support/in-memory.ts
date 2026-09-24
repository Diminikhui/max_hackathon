// Подменные реализации портов для тестов K-25b. Семантика `ProfileRepository` повторяет
// PostgresProfileRepository (K-10a): `save` заменяет профиль целиком, `addFacts` добавляет,
// ничего не удаляя, факт с тем же id заменяется, неизвестная компания — ошибка.
import type {
  CompanyProfile,
  Fact,
  Id,
  ProfileLookupResult,
  ProfileRepository,
  ProfileSource,
  SourceInfo,
} from "@max-hackathon/domain";

export class InMemoryProfileRepository implements ProfileRepository {
  readonly #profiles = new Map<Id, CompanyProfile>();
  saveCalls = 0;

  async get(companyId: Id): Promise<CompanyProfile | undefined> {
    const profile = this.#profiles.get(companyId);
    return profile ? structuredClone(profile) : undefined;
  }

  async findByInn(inn: string): Promise<CompanyProfile | undefined> {
    for (const profile of this.#profiles.values()) if (profile.inn === inn) return structuredClone(profile);
    return undefined;
  }

  async save(profile: CompanyProfile): Promise<void> {
    this.saveCalls += 1;
    for (const other of this.#profiles.values()) {
      if (other.inn === profile.inn && other.companyId !== profile.companyId) throw new Error("ИНН уже занят");
    }
    this.#profiles.set(profile.companyId, structuredClone(profile));
  }

  async addFacts(companyId: Id, facts: Fact[]): Promise<void> {
    const profile = this.#profiles.get(companyId);
    if (!profile) throw new Error(`Компания ${companyId} не найдена`);
    for (const fact of facts) {
      const index = profile.facts.findIndex((existing) => existing.id === fact.id);
      if (index >= 0) profile.facts[index] = structuredClone(fact);
      else profile.facts.push(structuredClone(fact));
    }
  }

  async listCompanyIds(): Promise<Id[]> {
    return [...this.#profiles.keys()].sort();
  }
}

/** Источник, отдающий заранее заданный ответ (или бросающий исключение). */
export class StubProfileSource implements ProfileSource {
  readonly info: SourceInfo = { name: "stub", isModel: true };
  calls: string[] = [];

  constructor(private readonly answer: (inn: string) => ProfileLookupResult) {}

  async lookupByInn(inn: string): Promise<ProfileLookupResult> {
    this.calls.push(inn);
    return this.answer(inn);
  }
}
