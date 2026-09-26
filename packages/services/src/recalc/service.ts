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

export interface PendingRecalculationOperation {
  revision: number;
  targetDigest: string;
  previous: ApplicabilityResult[];
  target: ApplicabilityResult[];
  delta: RecalculationDelta;
  event: ChangeEvent;
}

export interface RecalculationState {
  committedRevision: number;
  pending?: PendingRecalculationOperation;
}

/** Durable service-local state used to resume the same logical operation after a crash. */
export interface RecalculationStateRepository {
  get(companyId: Id): Promise<RecalculationState | undefined>;
  save(companyId: Id, state: RecalculationState): Promise<void>;
}

export interface ProfileRecalculationDeps {
  profiles: ProfileRepository;
  requirements: RequirementRepository;
  applicability: ApplicabilityRepository;
  events: ChangeEventRepository;
  recalculationState: RecalculationStateRepository;
  clock?: () => DateTime;
}

/**
 * Пересчитывает снимок применимости после изменения профиля.
 *
 * Сначала вычисляется полный новый снимок на зафиксированных версиях пакетов. Для дельты
 * pending-операция сохраняется до публикации `profile_change` и замены снимка. Её
 * монотонная ревизия даёт один ID всем retry одной операции и новый ID следующему
 * независимому переходу, даже если значения профиля и timestamps совпадают.
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

    const storedState = (await this.#deps.recalculationState.get(companyId)) ?? { committedRevision: 0 };
    if (storedState.pending) return this.#resumePending(companyId, storedState.pending);

    const evaluatedAt = options.evaluatedAt ?? this.#clock();
    const asOf = options.asOf ?? evaluatedAt.slice(0, 10);
    const previous = sortResults(await this.#deps.applicability.listByCompany(companyId));
    const requirements = await this.#requirementsSnapshot();
    const current = sortResults(requirements.map((item) => assessRequirement(item, profile, { evaluatedAt, asOf })));
    const delta = calculateDelta(previous, current);

    if (delta.appeared.length === 0 && delta.disappeared.length === 0) {
      await this.#deps.applicability.replaceForCompany(companyId, current);
      await this.#deps.recalculationState.save(companyId, {
        committedRevision: storedState.committedRevision + 1,
      });
      return { status: "unchanged", previous, current, delta };
    }

    const changedFactKeys = [...new Set(options.changedFactKeys)].sort();
    const revision = storedState.committedRevision + 1;
    const targetDigest = snapshotDigest(current);
    const defaultEventId = operationEventId({
      companyId,
      revision,
      targetDigest,
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
    const pending: PendingRecalculationOperation = {
      revision,
      targetDigest,
      previous,
      target: current,
      delta,
      event,
    };
    await this.#deps.recalculationState.save(companyId, { ...storedState, pending });
    return this.#resumePending(companyId, pending);
  }

  async #resumePending(companyId: Id, pending: PendingRecalculationOperation): Promise<ProfileRecalculationOutcome> {
    await this.#deps.events.append(pending.event);
    const snapshot = sortResults(await this.#deps.applicability.listByCompany(companyId));
    if (snapshotDigest(snapshot) !== pending.targetDigest) {
      await this.#deps.applicability.replaceForCompany(companyId, pending.target);
    }
    await this.#deps.recalculationState.save(companyId, { committedRevision: pending.revision });
    return {
      status: "changed",
      previous: pending.previous,
      current: pending.target,
      delta: pending.delta,
      event: pending.event,
    };
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

const operationEventId = (input: { companyId: Id; revision: number; targetDigest: string }): Id => {
  const identity = JSON.stringify({
    kind: "profile_change",
    companyId: input.companyId,
    revision: input.revision,
    targetDigest: input.targetDigest,
  });
  return `profile-change:${createHash("sha256").update(identity).digest("hex")}`;
};

const snapshotDigest = (results: readonly ApplicabilityResult[]): string => {
  const identity = results.map(({ evaluatedAt: _evaluatedAt, ...result }) => result);
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
};
