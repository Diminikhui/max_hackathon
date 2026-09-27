// K-30a: текст уведомления берётся из шаблонов K-23 (apps/bot/src/messages), чтобы бот и рассылка
// говорили одинаково. Отдельного экспорта у пакета бота нет, поэтому импорт идёт из его сборки.

import { renderRequirementDelta } from "@max-hackathon/bot/dist/messages/index.js";
import type { Id, Requirement } from "@max-hackathon/domain";
import type { RulepackTransition } from "./rulepack.js";
import type { NotificationRenderer } from "./types.js";

/**
 * Рендерер уведомлений о переходе статуса требования. Для удалённой записи используется её прежний текст.
 * Кандидат без записи или без ссылки на первоисточник не рендерится: контракт требует sourceUrls.
 */
export const requirementDeltaRenderer = (requirements: ReadonlyMap<Id, Requirement>): NotificationRenderer => {
  return (candidate) => {
    const requirement = candidate.requirementId === undefined ? undefined : requirements.get(candidate.requirementId);
    if (!requirement) return undefined;
    const message = renderRequirementDelta({
      requirement,
      reason: candidate.reason,
      ...(candidate.previousStatus ? { previousStatus: candidate.previousStatus } : {}),
      ...(candidate.newStatus ? { newStatus: candidate.newStatus } : {}),
      changedAt: candidate.createdAt,
    });
    if (message.sourceUrls.length === 0) return undefined;
    return { text: message.text, sourceUrls: message.sourceUrls, automated: message.automated };
  };
};

/** Записи обеих версий: новая версия важнее прежней. */
export const transitionRequirements = (transition: RulepackTransition): Map<Id, Requirement> =>
  new Map([...transition.from, ...transition.to].map((requirement) => [requirement.id, requirement]));
