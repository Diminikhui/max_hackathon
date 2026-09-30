// K-25b. Сервис профиля: ИНН → `ProfileSource` → подтверждение или правка → сохранение.
// Работает только через порты `ProfileSource` и `ProfileRepository` (@max-hackathon/domain):
// в тестах подменяются fixture и in-memory реализациями, в приложении — адаптерами и PostgreSQL.
//
// Правила:
// - Правка пользователя сохраняется заявленным фактом (`kind: "declared"`, `source.system: "user"`)
//   рядом с официальным и его не затирает: какой факт брать, решает вычислитель (K-16a).
// - Заявленный факт пользователя имеет детерминированный id `<companyId>.declared.<key>`:
//   повторное заявление того же ключа заменяет прежнее, а не копит дубли.
// - Повторное подтверждение (новый lookup той же компании) обновляет официальные и прочие факты
//   источника, но сохраняет заявленные пользователем факты и прежний `companyId`.
import type {
  CompanyProfile,
  DateTime,
  Fact,
  FactValue,
  Id,
  ProfileRepository,
  ProfileSource,
  SourceInfo,
} from "@max-hackathon/domain";
import { CONTRACT_VERSION } from "@max-hackathon/domain";
import { type InnError, parseInn } from "./inn/index.js";

/** `source.system` заявленных пользователем фактов. */
export const USER_SOURCE_SYSTEM = "user";

/** Формат ключа факта из `contracts/v1/fact.schema.json`. */
const FACT_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export const PROFILE_MESSAGES = {
  not_found: "Компания с таким ИНН не найдена в реестре малого и среднего бизнеса ФНС.",
  unavailable: "Источник данных о компаниях сейчас недоступен. Попробуйте ещё раз позже.",
  company_not_found: "Профиль компании не найден. Сначала найдите компанию по ИНН и подтвердите данные.",
  invalid_key: "Неизвестный формат поля профиля.",
  invalid_value: "Недопустимое значение поля профиля.",
} as const;

/** Результат поиска по ИНН. Ничего не сохраняет: сохранение — `confirm`. */
export type ProfileLookupOutcome =
  | { status: "invalid_inn"; error: InnError }
  | {
      status: "found";
      /** Профиль из источника; если компания уже сохранена — с её `companyId` и заявленными фактами. */
      profile: CompanyProfile;
      source: SourceInfo;
      /** Компания уже сохранена: `confirm` обновит факты источника, заявленные останутся. */
      alreadySaved: boolean;
    }
  | { status: "not_found"; inn: string; message: string }
  | { status: "unavailable"; inn: string; errorCode: string; retryable: boolean; message: string };

/** Правка пользователя: значение поля, которое сохраняется заявленным фактом. */
export interface DeclaredValue {
  key: string;
  value: FactValue;
}

export type DeclareOutcome =
  | { status: "ok"; fact: Fact }
  | { status: "company_not_found"; companyId: Id; message: string }
  | { status: "invalid_key"; key: string; message: string }
  | { status: "invalid_value"; key: string; message: string };

export type ConfirmOutcome =
  | { status: "ok"; companyId: Id; profile: CompanyProfile; declared: Fact[] }
  | { status: "invalid_declaration"; key: string; message: string };

export interface ProfileServiceDeps {
  source: ProfileSource;
  repository: ProfileRepository;
  /** Текущее время ISO 8601; в тестах — фиксированное. */
  clock?: () => DateTime;
  /** Id заявленного факта. По умолчанию `<companyId>.declared.<key>`: повтор заменяет прежний. */
  declaredFactId?: (companyId: Id, key: string) => Id;
}

export const defaultDeclaredFactId = (companyId: Id, key: string): Id => `${companyId}.declared.${key}`;

/** Заявленный пользователем факт (а не заявленный факт из источника). */
export const isUserDeclared = (fact: Fact): boolean =>
  fact.kind === "declared" && fact.source.system === USER_SOURCE_SYSTEM;

export class ProfileService {
  readonly #source: ProfileSource;
  readonly #repository: ProfileRepository;
  readonly #clock: () => DateTime;
  readonly #factId: (companyId: Id, key: string) => Id;

  constructor(deps: ProfileServiceDeps) {
    this.#source = deps.source;
    this.#repository = deps.repository;
    this.#clock = deps.clock ?? (() => new Date().toISOString());
    this.#factId = deps.declaredFactId ?? defaultDeclaredFactId;
  }

  /** Ввод пользователя → проверка ИНН (K-25a) → источник. Не бросает исключений на ошибках источника. */
  async lookup(input: string): Promise<ProfileLookupOutcome> {
    const parsed = parseInn(input);
    if (!parsed.ok) return { status: "invalid_inn", error: parsed.error };
    const inn = parsed.inn;

    let result: Awaited<ReturnType<ProfileSource["lookupByInn"]>>;
    try {
      result = await this.#source.lookupByInn(inn);
    } catch {
      return unavailable(inn, "source_error", true);
    }
    if (result.status === "not_found") return { status: "not_found", inn, message: PROFILE_MESSAGES.not_found };
    if (result.status === "unavailable") return unavailable(inn, result.errorCode, result.retryable);

    const stored = await this.#repository.findByInn(inn);
    const profile = stored ? mergeWithStored(result.profile, stored) : structuredClone(result.profile);
    return { status: "found", profile, source: this.#source.info, alreadySaved: stored !== undefined };
  }

  /**
   * Подтверждение профиля (с правками или без): сохраняет профиль и возвращает `companyId`.
   * Если компания с этим ИНН уже сохранена — берутся её `companyId` и заявленные пользователем факты,
   * факты источника заменяются новыми. Правки (`corrections`) сохраняются заявленными фактами.
   */
  async confirm(profile: CompanyProfile, corrections: readonly DeclaredValue[] = []): Promise<ConfirmOutcome> {
    for (const correction of corrections) {
      const problem = validateDeclared(correction.key, correction.value);
      if (problem) return { status: "invalid_declaration", key: correction.key, message: problem.message };
    }

    const now = this.#clock();
    const stored = await this.#repository.findByInn(profile.inn);
    const merged = stored ? mergeWithStored(profile, stored) : structuredClone(profile);
    const declared = corrections.map((c) => this.#declaredFact(merged, c.key, c.value, now));
    // Правка заменяет прежнее заявление того же ключа; официальные факты остаются.
    const declaredIds = new Set(declared.map((fact) => fact.id));
    merged.facts = [...merged.facts.filter((fact) => !declaredIds.has(fact.id)), ...declared];
    merged.updatedAt = now;

    await this.#repository.save(merged);
    const saved = (await this.#repository.get(merged.companyId)) ?? merged;
    return { status: "ok", companyId: merged.companyId, profile: saved, declared };
  }

  /** Правка одного поля уже сохранённого профиля: добавляет (или заменяет) заявленный факт. */
  async declare(companyId: Id, key: string, value: FactValue): Promise<DeclareOutcome> {
    const problem = validateDeclared(key, value);
    if (problem) return { ...problem, key };
    const profile = await this.#repository.get(companyId);
    if (!profile) return { status: "company_not_found", companyId, message: PROFILE_MESSAGES.company_not_found };

    const fact = this.#declaredFact(profile, key, value, this.#clock());
    await this.#repository.addFacts(companyId, [fact]);
    return { status: "ok", fact };
  }

  #declaredFact(profile: CompanyProfile, key: string, value: FactValue, now: DateTime): Fact {
    return {
      id: this.#factId(profile.companyId, key),
      companyId: profile.companyId,
      key,
      value: Array.isArray(value) ? [...value] : value,
      kind: "declared",
      source: { system: USER_SOURCE_SYSTEM, retrievedAt: now, isModel: profile.isModel },
      observedAt: now,
    };
  }
}

const unavailable = (inn: string, errorCode: string, retryable: boolean): ProfileLookupOutcome => ({
  status: "unavailable",
  inn,
  errorCode,
  retryable,
  message: PROFILE_MESSAGES.unavailable,
});

const validateDeclared = (
  key: string,
  value: FactValue,
): { status: "invalid_key" | "invalid_value"; message: string } | undefined => {
  if (typeof key !== "string" || !FACT_KEY_PATTERN.test(key)) {
    return { status: "invalid_key", message: PROFILE_MESSAGES.invalid_key };
  }
  const valid =
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"));
  return valid ? undefined : { status: "invalid_value", message: PROFILE_MESSAGES.invalid_value };
};

/**
 * Свежий профиль источника + сохранённая версия: `companyId` берётся сохранённый (стабильный id),
 * факты — из источника, плюс заявленные пользователем факты сохранённой версии.
 */
const mergeWithStored = (fresh: CompanyProfile, stored: CompanyProfile): CompanyProfile => {
  const companyId = stored.companyId;
  const facts = fresh.facts.map((fact) => ({ ...structuredClone(fact), companyId }));
  const freshIds = new Set(facts.map((fact) => fact.id));
  const userFacts = stored.facts.filter((fact) => isUserDeclared(fact) && !freshIds.has(fact.id));
  return {
    ...structuredClone(fresh),
    contractVersion: CONTRACT_VERSION,
    companyId,
    facts: [...facts, ...structuredClone(userFacts)],
  };
};
