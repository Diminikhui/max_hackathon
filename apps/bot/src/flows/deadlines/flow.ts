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
      if (action.type === "start") return renderDeadlines(outcome.queue);

      const group = deadlineGroups(outcome.queue).find((candidate) => candidate.key === action.key);
      return group
        ? renderDeadlineGroup(outcome.queue, group)
        : renderDeadlines(outcome.queue, "Эта группа изменилась. Ниже — актуальные сроки.");
    } catch {
      return renderDeadlinesUnavailable();
    }
  },
});
