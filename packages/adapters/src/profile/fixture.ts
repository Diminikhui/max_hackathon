// K-11. Fixture-реализация `ProfileSource`: отдаёт модельные профили по ИНН без обращения к внешним системам.
// По умолчанию — модельные компании K-28 (`data/fixtures/k28-companies.json`). Все данные — модельные.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompanyProfile, ProfileLookupResult, ProfileSource, SourceInfo } from "@max-hackathon/domain";

/** Путь к модельным компаниям K-28 (одинаков для `src/` и `dist/`). */
export const K28_COMPANIES_PATH = join(import.meta.dirname, "../../../../data/fixtures/k28-companies.json");

/** Корректная форма ИНН: 10 цифр (организация) или 12 цифр (ИП). Контрольная сумма не проверяется. */
const INN_PATTERN = /^\d{10}(\d{2})?$/;

/** Читает список модельных профилей из JSON-файла (по умолчанию — K-28). */
export function loadFixtureProfiles(path: string = K28_COMPANIES_PATH): CompanyProfile[] {
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data)) throw new Error(`Файл фикстуры ${path} должен содержать массив профилей`);
  return data as CompanyProfile[];
}

/**
 * Модельный источник профиля. Принимает только профили с `isModel = true`, чтобы модельные данные
 * нельзя было выдать за реальные. Возвращает копию профиля: вызывающий код не меняет фикстуру.
 */
export class FixtureProfileSource implements ProfileSource {
  readonly info: SourceInfo = { name: "fixture", isModel: true };
  readonly #byInn = new Map<string, CompanyProfile>();

  constructor(profiles: readonly CompanyProfile[] = loadFixtureProfiles()) {
    for (const profile of profiles) {
      if (profile.isModel !== true) {
        throw new Error(`Профиль ${profile.companyId} не помечен модельным (isModel = true)`);
      }
      if (this.#byInn.has(profile.inn)) throw new Error(`ИНН ${profile.inn} встречается в фикстуре дважды`);
      this.#byInn.set(profile.inn, profile);
    }
  }

  async lookupByInn(inn: string): Promise<ProfileLookupResult> {
    const normalized = typeof inn === "string" ? inn.trim() : "";
    if (!INN_PATTERN.test(normalized)) return { status: "not_found" };
    const profile = this.#byInn.get(normalized);
    return profile ? { status: "found", profile: structuredClone(profile) } : { status: "not_found" };
  }
}
