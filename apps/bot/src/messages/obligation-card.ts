import {
  type ApplicabilityStatus,
  type MessageRequirement,
  modelLabel,
  type RenderedMessage,
  renderAutomaticProcessingNote,
  renderSources,
  requirementLabel,
  STATUS_TEXT,
} from "./shared.js";

export interface ObligationCardInput {
  requirement: MessageRequirement;
  status: ApplicabilityStatus;
  statusReason?: string;
  evaluatedAt?: string;
}

/** Детерминированная карточка требования для диалога с ботом. */
export const render = (input: ObligationCardInput): RenderedMessage => {
  const { requirement } = input;
  const sources = renderSources(requirement.basis);
  const details = [
    `Статус: ${STATUS_TEXT[input.status]}`,
    ...(input.statusReason ? [`Почему: ${input.statusReason}`] : []),
    ...(requirement.summary ? [`Кратко: ${requirement.summary}`] : []),
    ...(requirement.deadline ? [`Срок: ${requirement.deadline}`] : []),
    ...renderValidity(requirement.validity),
    ...(input.evaluatedAt ? [`Проверено: ${input.evaluatedAt}`] : []),
  ];

  return {
    text: [
      `📋 ${requirementLabel(requirement.kind)}${modelLabel(requirement.source.isModel)}`,
      requirement.title,
      "",
      ...details,
      "",
      ...sources.lines,
      "",
      renderAutomaticProcessingNote(requirement.source.isModel),
    ].join("\n"),
    sourceUrls: sources.urls,
    automated: true,
  };
};

const renderValidity = (validity: MessageRequirement["validity"]): string[] => {
  if (!validity) return [];
  if (validity.from && validity.to) return [`Действует: с ${validity.from} по ${validity.to}`];
  if (validity.from) return [`Действует с: ${validity.from}`];
  if (validity.to) return [`Действует по: ${validity.to}`];
  return [];
};
