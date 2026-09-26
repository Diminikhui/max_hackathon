import { createHash } from "node:crypto";
import {
  type ApplicabilityRepository,
  type ApplicabilityResult,
  type ChangeEvent,
  type ChangeEventRepository,
  CONTRACT_VERSION,
  type DateTime,
  type Id,
  type IsoDate,
  type ProfileRepository,
  type Requirement,
  type RequirementRepository,
} from "@max-hackathon/domain";
import { assessRequirement } from "@max-hackathon/rules";

export interface RecalculationDelta {
  /** Требования, которые после изменения профиля стали применимы. */
  appeared: ApplicabilityResult[];
  /** Требования, которые после изменения профиля перестали быть применимы. */
  disappeared: ApplicabilityResult[];
}

export type ProfileRecalculationOutcome =
  | { status: "profile_not_found"; companyId: Id }
  | {
      status: "unchanged" | "changed";
      previous: ApplicabilityResult[];
      current: ApplicabilityResult[];
      delta: RecalculationDelta;
      event?: ChangeEvent;
    };

export interface ProfileRecalculationOptions {
  changedFactKeys: readonly string[];
  evaluatedAt?: DateTime;
  asOf?: IsoDate;
  eventId?: (input: { companyId: Id; evaluatedAt: DateTime; changedFactKeys: readonly string[] }) => Id;
}

export interface ProfileRecalculationDeps {
  profiles: ProfileRepository;
  requirements: RequirementRepository;
  applicability: ApplicabilityRepository;
  events: ChangeEventRepository;
  clock?: () => DateTime;
}

/**
 * Пересчитывает снимок применимости после изменения профиля.
 *
 * Сначала вычисляется полный новый снимок на зафиксированных версиях пакетов. Для дельты
 * идемпотентное `profile_change` сохраняется до замены снимка. ID по умолчанию привязан к
 * стабильной идентичности операции (версия профиля + предыдущий снимок + новые
 * статусы), а не к clock вызова. Поэтому повтор безопасен и после failed append, и после
 * successful append + failed replace. Без дельты событие не создаётся.
 */
export class ProfileRecalculationService {
  readonly #deps: ProfileRecalculationDeps;
  readonly #clock: () => DateTime;

  constructor(deps: ProfileRecalculationDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? (() => new Date().toISOString());
  }

  async recalculate(companyId: Id, options: ProfileRecalculationOptions): Promise<ProfileRecalculationOutcome> {
    const profile = await this.#deps.profiles.get(companyId);
    if (!profile) return { status: "profile_not_found", companyId };

    const evaluatedAt = options.evaluatedAt ?? this.#clock();
    const asOf = options.asOf ?? evaluatedAt.slice(0, 10);
    const previous = sortResults(await this.#deps.applicability.listByCompany(companyId));
    const requirements = await this.#requirementsSnapshot();
    const current = sortResults(requirements.map((item) => assessRequirement(item, profile, { evaluatedAt, asOf })));
    const delta = calculateDelta(previous, current);

    if (delta.appeared.length === 0 && delta.disappeared.length === 0) {
      await this.#deps.applicability.replaceForCompany(companyId, current);
      return { status: "unchanged", previous, current, delta };
    }

    const changedFactKeys = [...new Set(options.changedFactKeys)].sort();
    const defaultEventId = operationEventId({
      companyId,
      profileUpdatedAt: profile.updatedAt,
      changedFactKeys,
      previous,
      current,
    });
    const eventId = options.eventId?.({ companyId, evaluatedAt, changedFactKeys }) ?? defaultEventId;
    const existingEvent = await this.#deps.events.get(eventId);
    const event: ChangeEvent = existingEvent ?? {
      contractVersion: CONTRACT_VERSION,
      id: eventId,
      kind: "profile_change",
      occurredAt: evaluatedAt,
      isModel: profile.isModel,
      profile: { companyId, changedFactKeys },
    };
    await this.#deps.events.append(event);
    await this.#deps.applicability.replaceForCompany(companyId, current);
    return { status: "changed", previous, current, delta, event };
  }

  async #requirementsSnapshot(): Promise<Requirement[]> {
    const result: Requirement[] = [];
    const packIds = [...new Set(await this.#deps.requirements.listPackIds())].sort();
    for (const packId of packIds) {
      const version = await this.#deps.requirements.latestVersion(packId);
      if (version === undefined) continue;
      const records = await this.#deps.requirements.listByPack(packId, version);
      const invalid = records.find((record) => record.packId !== packId || record.packVersion !== version);
      if (invalid) throw new Error(`Репозиторий вернул запись ${invalid.id} вне снимка ${packId}@${version}`);
      result.push(...records);
    }
    return result;
  }
}

export const calculateDelta = (
  previous: readonly ApplicabilityResult[],
  current: readonly ApplicabilityResult[],
): RecalculationDelta => {
  const before = new Map(previous.map((item) => [item.requirementId, item]));
  const after = new Map(current.map((item) => [item.requirementId, item]));
  return {
    appeared: current.filter(
      (item) => item.status === "applies" && before.get(item.requirementId)?.status !== "applies",
    ),
    disappeared: previous.filter(
      (item) => item.status === "applies" && after.get(item.requirementId)?.status !== "applies",
    ),
  };
};

const sortResults = (results: ApplicabilityResult[]): ApplicabilityResult[] =>
  [...results].sort((left, right) => left.requirementId.localeCompare(right.requirementId));

const operationEventId = (input: {
  companyId: Id;
  profileUpdatedAt: DateTime;
  changedFactKeys: readonly string[];
  previous: readonly ApplicabilityResult[];
  current: readonly ApplicabilityResult[];
}): Id => {
  const identity = JSON.stringify({
    kind: "profile_change",
    companyId: input.companyId,
    profileUpdatedAt: input.profileUpdatedAt,
    changedFactKeys: input.changedFactKeys,
    // evaluatedAt предыдущего снимка — durable anchor между успешными replace.
    // evaluatedAt текущего расчёта исключён: clock меняется при retry.
    previous: input.previous.map(snapshotIdentity),
    current: input.current.map(({ evaluatedAt: _evaluatedAt, ...result }) => result),
  });
  return `profile-change:${createHash("sha256").update(identity).digest("hex")}`;
};

const snapshotIdentity = (result: ApplicabilityResult): ApplicabilityResult => result;
