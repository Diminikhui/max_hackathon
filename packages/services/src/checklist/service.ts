import {
  APPLICABILITY_STATUSES,
  type ApplicabilityResult,
  type ApplicabilityStatus,
  type CompanyProfile,
  type DateTime,
  type Id,
  type IsoDate,
  type ProfileRepository,
  type Requirement,
  type RequirementRepository,
} from "@max-hackathon/domain";
import { assessRequirement } from "@max-hackathon/rules";

export interface ChecklistItem {
  requirement: Requirement;
  applicability: ApplicabilityResult;
}

export interface ChecklistPack {
  packId: Id;
  packVersion: number;
  itemCount: number;
}

export type ChecklistStatusCounts = Record<ApplicabilityStatus, number>;

export interface CompanyChecklist {
  companyId: Id;
  evaluatedAt: DateTime;
  asOf: IsoDate;
  /** Пакеты в детерминированном порядке по `packId`; версия фиксируется до чтения записей. */
  packs: ChecklistPack[];
  /** Записи идут в порядке пакетов, а внутри пакета — в порядке репозитория. */
  items: ChecklistItem[];
  statusCounts: ChecklistStatusCounts;
}

export type ChecklistOutcome =
  | { status: "ok"; profile: CompanyProfile; checklist: CompanyChecklist }
  | { status: "profile_not_found"; companyId: Id };

export interface BuildChecklistOptions {
  /** По умолчанию подключаются все опубликованные пакеты из репозитория. */
  packIds?: readonly Id[];
  /** Один момент расчёта используется для всех записей перечня. */
  evaluatedAt?: DateTime;
  /** По умолчанию — календарная дата из `evaluatedAt`. */
  asOf?: IsoDate;
}

export interface ChecklistServiceDeps {
  profiles: ProfileRepository;
  requirements: RequirementRepository;
  clock?: () => DateTime;
}

/**
 * Строит перечень компании только через порты хранения и rule-engine.
 * Новая версия или новый пакет подключаются публикацией в `RequirementRepository` —
 * специальных веток по идентификатору пакета в сервисе нет.
 */
export class ChecklistService {
  readonly #profiles: ProfileRepository;
  readonly #requirements: RequirementRepository;
  readonly #clock: () => DateTime;

  constructor(deps: ChecklistServiceDeps) {
    this.#profiles = deps.profiles;
    this.#requirements = deps.requirements;
    this.#clock = deps.clock ?? (() => new Date().toISOString());
  }

  async build(companyId: Id, options: BuildChecklistOptions = {}): Promise<ChecklistOutcome> {
    const profile = await this.#profiles.get(companyId);
    if (!profile) return { status: "profile_not_found", companyId };

    const evaluatedAt = options.evaluatedAt ?? this.#clock();
    const asOf = options.asOf ?? evaluatedAt.slice(0, 10);
    const packIds = await this.#packIds(options.packIds);
    const packs: ChecklistPack[] = [];
    const items: ChecklistItem[] = [];

    for (const packId of packIds) {
      // Сначала фиксируем версию: параллельная публикация не должна смешать версии в одном перечне.
      const packVersion = await this.#requirements.latestVersion(packId);
      if (packVersion === undefined) continue;
      const requirements = await this.#requirements.listByPack(packId, packVersion);
      assertPackSnapshot(packId, packVersion, requirements);

      packs.push({ packId, packVersion, itemCount: requirements.length });
      for (const requirement of requirements) {
        items.push({
          requirement,
          applicability: assessRequirement(requirement, profile, { evaluatedAt, asOf }),
        });
      }
    }

    return {
      status: "ok",
      profile,
      checklist: {
        companyId,
        evaluatedAt,
        asOf,
        packs,
        items,
        statusCounts: countStatuses(items),
      },
    };
  }

  async #packIds(requested: readonly Id[] | undefined): Promise<Id[]> {
    const ids = requested ?? (await this.#requirements.listPackIds());
    return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
  }
}

const countStatuses = (items: readonly ChecklistItem[]): ChecklistStatusCounts => {
  const counts = Object.fromEntries(APPLICABILITY_STATUSES.map((status) => [status, 0])) as ChecklistStatusCounts;
  for (const item of items) counts[item.applicability.status] += 1;
  return counts;
};

const assertPackSnapshot = (packId: Id, packVersion: number, requirements: readonly Requirement[]): void => {
  const mismatched = requirements.find(
    (requirement) => requirement.packId !== packId || requirement.packVersion !== packVersion,
  );
  if (mismatched) {
    throw new Error(`Репозиторий вернул запись ${mismatched.id} вне запрошенного снимка ${packId}@${packVersion}`);
  }
};
