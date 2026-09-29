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
  /**
   * Внешняя причина пересчёта, о которой уже сообщили (#295): новая версия пакета правил, которую
   * обработал контур уведомлений K-30a. Дельта снимка относится к этому событию: своё событие
   * `profile_change` не создаётся и причина в журнал не пишется — её записывает владелец.
   */
  cause?: ChangeEvent;
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

/** Эксклюзивная аренда пересчёта одной компании. */
export interface RecalculationLease {
  readonly token: string;
}

/**
 * Durable service-local state used to resume the same logical operation after a crash.
 *
 * Пересчёты одной компании сериализуются арендой с истечением: `acquire` выдаёт её только одному
 * исполнителю, а `save` записывает состояние, только пока аренда действует (fencing). Упавший
 * процесс не держит компанию дольше срока аренды, а его pending-операцию доигрывает следующий.
 */
export interface RecalculationStateRepository {
  /** Аренда компании на `ttlMs`; `undefined`, если её держит другой исполнитель. */
  acquire(companyId: Id, ttlMs: number): Promise<RecalculationLease | undefined>;
  release(companyId: Id, lease: RecalculationLease): Promise<void>;
  get(companyId: Id): Promise<RecalculationState | undefined>;
  /** Записывает состояние; `false`, если аренда истекла или перехвачена. */
  save(companyId: Id, lease: RecalculationLease, state: RecalculationState): Promise<boolean>;
}

/** Компанию пересчитывает другой исполнитель дольше допустимого ожидания. */
export class RecalculationBusyError extends Error {
  constructor(readonly companyId: Id) {
    super(`Пересчёт компании ${companyId} уже выполняется`);
    this.name = "RecalculationBusyError";
  }
}

/** Аренда потеряна во время пересчёта: результат не зафиксирован, операцию нужно повторить. */
export class RecalculationLeaseLostError extends Error {
  constructor(readonly companyId: Id) {
    super(`Аренда пересчёта компании ${companyId} потеряна`);
    this.name = "RecalculationLeaseLostError";
  }
}

export interface ProfileRecalculationDeps {
  profiles: ProfileRepository;
  requirements: RequirementRepository;
  applicability: ApplicabilityRepository;
  events: ChangeEventRepository;
  recalculationState: RecalculationStateRepository;
  clock?: () => DateTime;
  /** Срок аренды компании; должен с запасом покрывать один пересчёт. По умолчанию 60 с. */
  leaseTtlMs?: number;
  /** Сколько ждать аренду, занятую другим исполнителем. По умолчанию 10 с. */
  leaseWaitMs?: number;
  /** Пауза между попытками взять аренду. По умолчанию 50 мс. */
  leaseRetryMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_LEASE_WAIT_MS = 10_000;
const DEFAULT_LEASE_RETRY_MS = 50;

/**
 * Пересчитывает снимок применимости после изменения профиля.
 *
 * Сначала вычисляется полный новый снимок на зафиксированных версиях пакетов. Для дельты
 * pending-операция сохраняется до публикации `profile_change` и замены снимка. Её
 * монотонная ревизия даёт один ID всем retry одной операции и новый ID следующему
 * независимому переходу, даже если значения профиля и timestamps совпадают.
 *
 * Пересчёты одной компании выполняются строго по очереди под арендой. Если найдена pending-операция
 * прошлого (упавшего) исполнителя, она сначала доигрывается, а затем выполняется собственный пересчёт,
 * чтобы изменения профиля вызывающего не потерялись.
 */
export class ProfileRecalculationService {
  readonly #deps: ProfileRecalculationDeps;
  readonly #clock: () => DateTime;

  constructor(deps: ProfileRecalculationDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? (() => new Date().toISOString());
  }

  async recalculate(companyId: Id, options: ProfileRecalculationOptions): Promise<ProfileRecalculationOutcome> {
    const lease = await this.#acquire(companyId);
    try {
      return await this.#recalculateLocked(companyId, lease, options);
    } finally {
      await this.#deps.recalculationState.release(companyId, lease);
    }
  }

  async #acquire(companyId: Id): Promise<RecalculationLease> {
    const ttl = this.#deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    const wait = this.#deps.leaseWaitMs ?? DEFAULT_LEASE_WAIT_MS;
    const retry = this.#deps.leaseRetryMs ?? DEFAULT_LEASE_RETRY_MS;
    const sleep = this.#deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let waited = 0; ; waited += retry) {
      const lease = await this.#deps.recalculationState.acquire(companyId, ttl);
      if (lease) return lease;
      if (waited >= wait) throw new RecalculationBusyError(companyId);
      await sleep(retry);
    }
  }

  async #recalculateLocked(
    companyId: Id,
    lease: RecalculationLease,
    options: ProfileRecalculationOptions,
  ): Promise<ProfileRecalculationOutcome> {
    const profile = await this.#deps.profiles.get(companyId);
    if (!profile) return { status: "profile_not_found", companyId };

    let storedState = (await this.#deps.recalculationState.get(companyId)) ?? { committedRevision: 0 };
    const resumed = storedState.pending;
    if (resumed) {
      await this.#completePending(companyId, lease, resumed);
      storedState = { committedRevision: resumed.revision };
    }

    const evaluatedAt = options.evaluatedAt ?? this.#clock();
    const asOf = options.asOf ?? evaluatedAt.slice(0, 10);
    const previous = sortResults(await this.#deps.applicability.listByCompany(companyId));
    const requirements = await this.#requirementsSnapshot();
    const current = sortResults(requirements.map((item) => assessRequirement(item, profile, { evaluatedAt, asOf })));
    const delta = calculateDelta(previous, current);

    if (delta.appeared.length === 0 && delta.disappeared.length === 0) {
      await this.#deps.applicability.replaceForCompany(companyId, current);
      await this.#save(companyId, lease, { committedRevision: storedState.committedRevision + 1 });
      // Retry прерванной операции: сообщаем о доведённом переходе, а не о пустом пересчёте поверх него.
      if (resumed) return { ...changedOutcome(resumed), current };
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
    const eventId =
      options.cause?.id ?? options.eventId?.({ companyId, evaluatedAt, changedFactKeys }) ?? defaultEventId;
    const existingEvent = options.cause ?? (await this.#deps.events.get(eventId));
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
    await this.#save(companyId, lease, { committedRevision: storedState.committedRevision, pending });
    await this.#completePending(companyId, lease, pending);
    return { status: "changed", previous, current, delta, event };
  }

  /** Идемпотентно доводит pending-операцию: событие, снимок, фиксация ревизии. */
  async #completePending(
    companyId: Id,
    lease: RecalculationLease,
    pending: PendingRecalculationOperation,
  ): Promise<void> {
    // Внешнюю причину (`cause`) записывает её владелец: для K-30a запись события — отметка «переход обработан».
    if (pending.event.kind === "profile_change") await this.#deps.events.append(pending.event);
    const snapshot = sortResults(await this.#deps.applicability.listByCompany(companyId));
    if (snapshotDigest(snapshot) !== pending.targetDigest) {
      await this.#deps.applicability.replaceForCompany(companyId, pending.target);
    }
    await this.#save(companyId, lease, { committedRevision: pending.revision });
  }

  async #save(companyId: Id, lease: RecalculationLease, state: RecalculationState): Promise<void> {
    if (!(await this.#deps.recalculationState.save(companyId, lease, state))) {
      throw new RecalculationLeaseLostError(companyId);
    }
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

const changedOutcome = (
  pending: PendingRecalculationOperation,
): Exclude<ProfileRecalculationOutcome, { status: "profile_not_found" }> => ({
  status: "changed",
  previous: pending.previous,
  current: pending.target,
  delta: pending.delta,
  event: pending.event,
});

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
