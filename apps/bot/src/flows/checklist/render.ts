import type { ApplicabilityStatus, NotificationButton } from "@max-hackathon/domain";
import { renderObligationCard } from "../../messages/index.js";
import {
  composeText,
  formatDate,
  MAX_TEXT_LENGTH,
  modelLabel,
  renderAutomaticProcessingNote,
  STATUS_TEXT,
} from "../../messages/shared.js";
import { encodeButtonPayload } from "../../transport/index.js";
import type { ChecklistItemView, ChecklistView, FlowReply } from "./types.js";

/**
 * Порядок разделов перечня: сначала то, что касается компании, затем то, что требует действий по уточнению.
 * «Не применяется» выводится одной строкой с количеством: иначе кафе увидело бы все записи автосервиса.
 */
export const LISTED_STATUSES = [
  "applies",
  "insufficient_data",
  "needs_review",
  "out_of_coverage",
] as const satisfies readonly ApplicabilityStatus[];

const STATUS_MARK: Record<ApplicabilityStatus, string> = {
  applies: "✅",
  insufficient_data: "❔",
  needs_review: "⚠️",
  out_of_coverage: "⬜",
  not_applies: "➖",
};

/** Лимит клавиатуры MAX — 210 кнопок; под перечнем ещё «🏠 Меню», остальное — запас. */
const MAX_ITEM_BUTTONS = 200;

export const homeButton = (): NotificationButton => ({
  text: "🏠 Меню",
  payload: encodeButtonPayload({ type: "home" }),
});
export const backToListButton = (): NotificationButton => ({
  text: "← К перечню",
  payload: encodeButtonPayload({ type: "back" }),
});

/** Записи, которые показываются списком, в порядке разделов. Номер записи = позиция в этом массиве + 1. */
export const listedItems = (checklist: ChecklistView): ChecklistItemView[] =>
  LISTED_STATUSES.flatMap((status) => checklist.items.filter((item) => item.applicability.status === status));

const isModelChecklist = (checklist: ChecklistView, profileIsModel: boolean): boolean =>
  profileIsModel || checklist.items.some((item) => item.requirement.source.isModel);

/** Перечень: счётчики всех пяти статусов, нумерованные записи по разделам и кнопки-номера для открытия карточки. */
export const renderRequirementList = (
  checklist: ChecklistView,
  options: { readonly profileIsModel: boolean; readonly notice?: string },
): FlowReply => {
  const items = listedItems(checklist);
  const isModel = isModelChecklist(checklist, options.profileIsModel);
  const lines: string[] = [`📋 Ваш перечень${modelLabel(isModel)}`, ""];
  if (options.notice) lines.push(options.notice, "");

  lines.push(
    ...LISTED_STATUSES.map(
      (status) => `${STATUS_MARK[status]} ${STATUS_TEXT[status]}: ${checklist.statusCounts[status]}`,
    ),
    `${STATUS_MARK.not_applies} ${STATUS_TEXT.not_applies}: ${checklist.statusCounts.not_applies}`,
  );

  const note = renderAutomaticProcessingNote(isModel);
  const footer = (shown: number): string[] => [
    "",
    ...(shown < items.length
      ? [`Показаны ${shown} из ${items.length} записей: остальные не поместились в сообщение.`]
      : []),
    items.length > 0
      ? "Нажмите номер, чтобы открыть карточку: почему это касается вас, срок и первоисточник."
      : "Записей, которые касаются компании или требуют уточнения, нет.",
    `Расчёт на ${formatDate(checklist.asOf)}. Пакеты правил: ${formatPacks(checklist)}.`,
  ];
  // Записи добавляются, пока сообщение с подвалом помещается в лимит MAX и хватает кнопок: у каждой показанной
  // записи есть кнопка с её номером, а подвал с датой расчёта не обрезается.
  const fits = (candidate: readonly string[], shown: number): boolean =>
    [...candidate, ...footer(shown), "", note].join("\n").length <= MAX_TEXT_LENGTH;

  const shownItems: ChecklistItemView[] = [];
  // Первая не поместившаяся запись останавливает весь вывод: иначе короткая запись из следующего раздела
  // попала бы в сообщение, а пропущенные перед ней — нет.
  fill: for (const status of LISTED_STATUSES) {
    const section = items.filter((item) => item.applicability.status === status);
    const heading = ["", `${STATUS_MARK[status]} ${STATUS_TEXT[status]}:`];
    let headed = false;
    for (const item of section) {
      if (shownItems.length >= MAX_ITEM_BUTTONS) break fill;
      const line = `${shownItems.length + 1}. ${item.requirement.title}`;
      const addition = headed ? [line] : [...heading, line];
      if (!fits([...lines, ...addition], shownItems.length + 1)) break fill;
      lines.push(...addition);
      headed = true;
      shownItems.push(item);
    }
  }
  lines.push(...footer(shownItems.length));

  const itemButtons = shownItems.map(
    ({ requirement }, index): NotificationButton => ({
      text: String(index + 1),
      payload: encodeButtonPayload({ type: "select_requirement", requirementId: requirement.id }),
    }),
  );

  return {
    text: composeText(lines, note),
    sourceUrls: [],
    automated: true,
    buttons: [...itemButtons, homeButton()],
  };
};

const formatPacks = (checklist: ChecklistView): string =>
  checklist.packs.length === 0
    ? "нет опубликованных"
    : checklist.packs.map((pack) => `${pack.packId} v${pack.packVersion}`).join(", ");

/** Карточка записи: шаблон K-23 (статус, причина, срок, дата проверки, первоисточник) и навигация. */
export const renderRequirementCard = (item: ChecklistItemView): FlowReply => {
  const card = renderObligationCard({
    requirement: item.requirement,
    status: item.applicability.status,
    ...(item.applicability.statusReason ? { statusReason: item.applicability.statusReason } : {}),
    evaluatedAt: item.applicability.evaluatedAt,
  });
  return { ...card, buttons: [backToListButton(), homeButton()] };
};

/** Ответ, когда перечень построить не для кого: диалог ещё не знает компанию или профиль удалён. */
export const renderNoCompany = (): FlowReply => ({
  text: composeText(["Чтобы показать перечень, сначала укажите ИНН компании."], renderAutomaticProcessingNote(false)),
  sourceUrls: [],
  automated: true,
  buttons: [{ text: "Ввести ИНН", payload: encodeButtonPayload({ type: "start" }) }],
  // Из idle кнопка «Ввести ИНН» (`start`) ведёт к вводу ИНН; из перечня машина её бы не приняла.
  stateOverride: "idle",
});
