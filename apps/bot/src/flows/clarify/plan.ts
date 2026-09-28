import type { ChecklistItemView, ChecklistView } from "../checklist/index.js";
import { CLARIFY_QUESTIONS, type ClarifyQuestion, questionFor } from "./questions.js";

export interface ClarifyPlan {
  /** Записи «недостаточно данных». */
  readonly blocked: readonly ChecklistItemView[];
  /** Вопросы, ответ на которые меняет результат: сначала те, что разблокируют больше записей. */
  readonly questions: readonly ClarifyQuestion[];
  /** Недостающие факты, о которых бот не спрашивает (данные реестра или числа), — только для объяснения. */
  readonly unaskedKeys: readonly string[];
}

const catalogueOrder = new Map(CLARIFY_QUESTIONS.map((question, index) => [question.key, index]));

/**
 * Вопросы строятся только из `missingFactKeys` записей со статусом «недостаточно данных»: у остальных статусов
 * ответ владельца результат не изменит. Пропущенные в этом заходе вопросы (`skipped`) повторно не задаются.
 */
export const planClarification = (checklist: ChecklistView, skipped: ReadonlySet<string> = new Set()): ClarifyPlan => {
  const blocked = checklist.items.filter((item) => item.applicability.status === "insufficient_data");
  const blockedCount = new Map<string, number>();
  for (const item of blocked) {
    for (const key of new Set(item.applicability.missingFactKeys ?? [])) {
      blockedCount.set(key, (blockedCount.get(key) ?? 0) + 1);
    }
  }

  const keys = [...blockedCount.keys()];
  const questions = keys
    .filter((key) => !skipped.has(key))
    .map(questionFor)
    .filter((question): question is ClarifyQuestion => question !== undefined)
    .sort(
      (left, right) =>
        (blockedCount.get(right.key) ?? 0) - (blockedCount.get(left.key) ?? 0) ||
        (catalogueOrder.get(left.key) ?? 0) - (catalogueOrder.get(right.key) ?? 0),
    );
  const unaskedKeys = keys.filter((key) => questionFor(key) === undefined).sort();

  return { blocked, questions, unaskedKeys };
};

/** Записи, которые ждут ответа на вопрос `key`. */
export const itemsWaitingFor = (plan: ClarifyPlan, key: string): ChecklistItemView[] =>
  plan.blocked.filter((item) => item.applicability.missingFactKeys?.includes(key));
