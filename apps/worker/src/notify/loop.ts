// K-30a: прогон контура по новым версиям пакетов правил и цикл процесса.
// Событие rulepack_version записывается ПОСЛЕ постановки уведомлений в очередь: запись события —
// отметка «переход обработан». Упавший прогон повторяется целиком и благодаря защите пайплайна
// от дублей не создаёт второго уведомления.

import type { ChangeEventRepository, DateTime, Id, RequirementRepository } from "@max-hackathon/domain";
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
  now?: () => DateTime;
}

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
