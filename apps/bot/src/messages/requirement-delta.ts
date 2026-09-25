import {
  type ApplicabilityStatus,
  composeText,
  formatDate,
  type MessageRequirement,
  modelLabel,
  type NotificationReason,
  type RenderedMessage,
  renderAutomaticProcessingNote,
  renderSources,
  requirementLabel,
  STATUS_TEXT,
} from "./shared.js";

export type { NotificationReason } from "./shared.js";

export interface RequirementDeltaInput {
  requirement: MessageRequirement;
  reason: NotificationReason;
  previousStatus?: ApplicabilityStatus;
  newStatus?: ApplicabilityStatus;
  changedAt?: string;
}

const REASON_TEXT: Record<NotificationReason, string> = {
  became_applicable: "Требование стало применяться к вашей компании",
  no_longer_applicable: "Требование больше не применяется к вашей компании",
  status_changed: "Изменился статус требования",
  early_signal: "Опубликован проект изменения. Это ещё не действующая норма — нужна проверка",
};

/** Детерминированное уведомление о дельте применимости требования. */
export const render = (input: RequirementDeltaInput): RenderedMessage => {
  const { requirement } = input;
  const sources = renderSources(requirement.basis);
  const statuses = [
    ...(input.previousStatus ? [`Было: ${STATUS_TEXT[input.previousStatus]}`] : []),
    ...(input.newStatus ? [`Стало: ${STATUS_TEXT[input.newStatus]}`] : []),
  ];

  return {
    text: composeText(
      [
        `${input.reason === "early_signal" ? "📝 Проект изменения" : "🔔 Изменение"}: ${requirementLabel(requirement.kind).toLowerCase()}${modelLabel(requirement.source.isModel)}`,
        requirement.title,
        "",
        REASON_TEXT[input.reason],
        ...statuses,
        ...(input.changedAt ? [`Зафиксировано: ${formatDate(input.changedAt)}`] : []),
        "",
        ...sources.lines,
      ],
      renderAutomaticProcessingNote(requirement.source.isModel),
    ),
    sourceUrls: sources.urls,
    automated: true,
  };
};
