import { decodeDeadlinesPayload } from "./payload.js";
import {
  deadlineGroups,
  renderDeadlineGroup,
  renderDeadlines,
  renderDeadlinesNoCompany,
  renderDeadlinesUnavailable,
} from "./render.js";
import type { ActionQueueSource, DeadlinesFlow } from "./types.js";

export interface DeadlinesFlowDeps {
  readonly queue: ActionQueueSource;
  readonly companyOf: (dialogId: string) => Promise<string | undefined>;
  /**
   * Модельна ли компания (K-28). Очередь действий несёт модельность только записей, поэтому без этого порта модельная
   * компания с реальными пакетами показывалась бы без пометки. Ошибка порта не мешает показу: пометки тогда нет.
   */
  readonly isModelCompany?: (companyId: string) => Promise<boolean>;
}

/** Flow не меняет состояние диалога и не вычисляет даты: он отображает готовую очередь действий. */
export const createDeadlinesFlow = (deps: DeadlinesFlowDeps): DeadlinesFlow => ({
  async handle(dialogId, payload) {
    const action = decodeDeadlinesPayload(payload);
    if (action === undefined) return undefined;

    const companyId = await deps.companyOf(dialogId);
    if (companyId === undefined) return renderDeadlinesNoCompany();
    try {
      const outcome = await deps.queue.build(companyId);
      if (outcome.status !== "ok") return renderDeadlinesNoCompany();
      const modelCompany = (await deps.isModelCompany?.(companyId).catch(() => false)) ?? false;
      if (action.type === "start") return renderDeadlines(outcome.queue, undefined, modelCompany);

      const group = deadlineGroups(outcome.queue).find((candidate) => candidate.key === action.key);
      return group
        ? renderDeadlineGroup(outcome.queue, group, modelCompany)
        : renderDeadlines(outcome.queue, "Эта группа изменилась. Ниже — актуальные сроки.", modelCompany);
    } catch {
      return renderDeadlinesUnavailable();
    }
  },
});
