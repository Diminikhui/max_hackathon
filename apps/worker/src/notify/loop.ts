// K-30a: прогон контура по новым версиям пакетов правил и цикл процесса.
// Контур — единственный источник событий rulepack_version (#295). Порядок для одного перехода:
//   1) уведомления в очередь; 2) обновление снимков применимости с причиной-событием;
//   3) запись события — отметка «переход обработан».
// Упавший прогон повторяется целиком: пайплайн не создаёт второго уведомления, а уже обновлённый
// снимок при повторе не меняется.

import type {
  ChangeEvent,
  ChangeEventRepository,
  DateTime,
  Id,
  ProfileRepository,
  RequirementRepository,
} from "@max-hackathon/domain";
import type { NotificationPipeline, PipelineReport } from "./pipeline.js";
import { requirementDeltaRenderer, transitionRequirements } from "./render.js";
import {
  hasRequirementChanges,
  latestTransition,
  rulepackEvent,
  rulepackEventId,
  rulepackMatcher,
} from "./rulepack.js";

export interface RulepackNotificationDeps {
  requirements: Pick<RequirementRepository, "listPackIds" | "latestVersion" | "listByPack">;
  events: ChangeEventRepository;
  pipeline: Pick<NotificationPipeline, "process">;
  /**
   * Снимки применимости (2-09). Без них следующий пересчёт профиля сравнит старый снимок с новым пакетом
   * и выпустит `profile_change` о том же переходе. Не задан — снимки не трогаются (демо-кнопка K-29).
   */
  snapshots?: ApplicabilitySnapshots;
  now?: () => DateTime;
}

/** Обновление снимков применимости компаний после перехода пакета. */
export interface ApplicabilitySnapshots {
  listCompanyIds(): Promise<Id[]>;
  /** Пересчитывает снимок компании, относя дельту к `event`; своего события не создаёт. */
  refresh(companyId: Id, event: ChangeEvent): Promise<void>;
}

/** Порт пересчёта 2-09 (`ProfileRecalculationService.recalculate`) в форме, нужной контуру. */
export type RecalculateWithCause = (
  companyId: Id,
  options: { changedFactKeys: readonly string[]; evaluatedAt: DateTime; cause: ChangeEvent },
) => Promise<unknown>;

/** Снимки через сервис пересчёта: факты профиля не менялись, изменился пакет. */
export const recalculationSnapshots = (
  recalculate: RecalculateWithCause,
  profiles: Pick<ProfileRepository, "listCompanyIds">,
): ApplicabilitySnapshots => ({
  listCompanyIds: () => profiles.listCompanyIds(),
  refresh: async (companyId, event) => {
    await recalculate(companyId, { changedFactKeys: [], evaluatedAt: event.occurredAt, cause: event });
  },
});

export interface RulepackRunReport {
  processed: PipelineReport[];
  /** Переходы, уже обработанные ранее (событие записано). */
  alreadyProcessed: Id[];
}

/** Обрабатывает последний переход каждого пакета, если он ещё не обработан. */
export const runRulepackNotifications = async (deps: RulepackNotificationDeps): Promise<RulepackRunReport> => {
  const now = deps.now ?? (() => new Date().toISOString());
  const report: RulepackRunReport = { processed: [], alreadyProcessed: [] };

  for (const packId of [...(await deps.requirements.listPackIds())].sort()) {
    const transition = await latestTransition(deps.requirements, packId);
    if (!transition || !hasRequirementChanges(transition)) continue;

    const eventId = rulepackEventId(transition.change);
    if (await deps.events.get(eventId)) {
      report.alreadyProcessed.push(eventId);
      continue;
    }

    const occurredAt = now();
    const event = rulepackEvent(transition, occurredAt);
    const matcher = rulepackMatcher(transition, { evaluatedAt: occurredAt });
    report.processed.push(
      await deps.pipeline.process(event, matcher, requirementDeltaRenderer(transitionRequirements(transition))),
    );
    if (deps.snapshots) {
      for (const companyId of [...new Set(await deps.snapshots.listCompanyIds())].sort()) {
        await deps.snapshots.refresh(companyId, event);
      }
    }
    await deps.events.append(event);
  }

  return report;
};

export interface NotificationLoopOptions {
  signal: AbortSignal;
  /** Пауза между прогонами. По умолчанию 60 с. */
  intervalMs?: number;
  onReport?: (report: RulepackRunReport) => void;
  /** Ошибка прогона не останавливает цикл; в журнал — без текста уведомлений и ПДн. */
  onError?: (error: unknown) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/** Цикл процесса worker: прогон, пауза, до отмены signal. Отправку ведёт отдельный runSendLoop (K-21a). */
export const runNotificationLoop = async (
  deps: RulepackNotificationDeps,
  options: NotificationLoopOptions,
): Promise<void> => {
  const sleep = options.sleep ?? abortableSleep;
  while (!options.signal.aborted) {
    try {
      options.onReport?.(await runRulepackNotifications(deps));
    } catch (error) {
      options.onError?.(error);
    }
    await sleep(options.intervalMs ?? 60_000, options.signal);
  }
};
