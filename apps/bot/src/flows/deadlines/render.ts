import type { NotificationButton } from "@max-hackathon/domain";
import {
  composeText,
  formatDate,
  MAX_TEXT_LENGTH,
  modelLabel,
  renderAutomaticProcessingNote,
} from "../../messages/shared.js";
import { encodeButtonPayload } from "../../transport/index.js";
import type { FlowReply } from "../checklist/index.js";
import { encodeDeadlineGroup } from "./payload.js";
import type { ActionQueueView, DatedActionView, UndatedActionView, UndatedReason } from "./types.js";

type GroupItem = DatedActionView | UndatedActionView;

export interface DeadlineGroup {
  readonly key: string;
  readonly title: string;
  readonly items: readonly GroupItem[];
}

const PREVIEW_SIZE = 3;

const REASON_TITLES: Readonly<Record<UndatedReason, string>> = {
  event: "При событии",
  continuous: "Постоянно",
  periodic_without_last_date: "Периодически — нужна дата последнего исполнения",
  calendar_outdated: "Без даты — календарь нужно сверить",
  not_in_calendar: "Без даты — нет правила в календаре",
};

const homeButton = (): NotificationButton => ({
  text: "🏠 Меню",
  payload: encodeButtonPayload({ type: "home" }),
});

const backButton = (): NotificationButton => ({
  text: "← К срокам",
  payload: "deadlines:start",
});

const isDated = (item: GroupItem): item is DatedActionView => "dueDate" in item;

/** Модельная пометка нужна, если модельна компания (K-28) или хотя бы одна запись очереди. */
const isModelQueue = (queue: ActionQueueView, modelCompany: boolean): boolean =>
  modelCompany || [...queue.actions, ...queue.undated].some((item) => item.isModel);

/** Группировка использует только готовые `dueDate` и `reason`; текст срока здесь не интерпретируется. */
export const deadlineGroups = (queue: ActionQueueView): DeadlineGroup[] => {
  const groups: DeadlineGroup[] = [];
  const byDate = new Map<string, DatedActionView[]>();
  for (const item of queue.actions) {
    const items = byDate.get(item.dueDate) ?? [];
    items.push(item);
    byDate.set(item.dueDate, items);
  }
  for (const [date, items] of byDate) {
    groups.push({
      key: `date:${date}`,
      title: date === queue.asOf ? `Сегодня — ${formatDate(date)}` : `По дате — ${formatDate(date)}`,
      items,
    });
  }
  for (const reason of Object.keys(REASON_TITLES) as UndatedReason[]) {
    const items = queue.undated.filter((item) => item.reason === reason);
    if (items.length > 0) groups.push({ key: `reason:${reason}`, title: REASON_TITLES[reason], items });
  }
  return groups;
};

const itemLines = (item: GroupItem): string[] => {
  const source = item.basis[0]?.url;
  return [
    `• ${item.title}`,
    `  Срок: ${item.deadline}`,
    ...(!isDated(item) && item.reason === "event" && item.detail ? [`  Событие: ${item.detail}`] : []),
    ...(isDated(item) && item.dueAction ? [`  На эту дату: ${item.dueAction}`] : []),
    `  Источник: ${source ?? "не указан"}`,
  ];
};

const sourceUrls = (items: readonly GroupItem[]): string[] => [
  ...new Set(items.flatMap((item) => item.basis[0]?.url ?? []).filter(Boolean)),
];

export const renderDeadlines = (queue: ActionQueueView, notice?: string, modelCompany = false): FlowReply => {
  const groups = deadlineGroups(queue);
  const isModel = isModelQueue(queue, modelCompany);
  const note = renderAutomaticProcessingNote(isModel);
  const lines = [`📅 Что и когда делать${modelLabel(isModel)}`, ""];
  if (notice) lines.push(notice, "");
  if (groups.length === 0) {
    lines.push("Применимых обязанностей со сроком сейчас нет.", `Расчёт на ${formatDate(queue.asOf)}.`);
    return { text: composeText(lines, note), sourceUrls: [], automated: true, buttons: [homeButton()] };
  }

  const shown: GroupItem[] = [];
  const buttons: NotificationButton[] = [];
  for (const group of groups) {
    const preview = group.items.slice(0, PREVIEW_SIZE);
    lines.push(`▸ ${group.title}`, ...preview.flatMap(itemLines));
    shown.push(...preview);
    const hidden = group.items.length - preview.length;
    if (hidden > 0) {
      lines.push(`  … ещё ${hidden}`);
      buttons.push({ text: `Ещё ${hidden}: ${group.title}`, payload: encodeDeadlineGroup(group.key) });
    }
    lines.push("");
  }
  lines.push(`Расчёт на ${formatDate(queue.asOf)}. Даты показаны только там, где их вернул сервис очереди.`);
  return {
    text: composeText(lines, note),
    sourceUrls: sourceUrls(shown),
    automated: true,
    buttons: [...buttons, homeButton()],
  };
};

export const renderDeadlineGroup = (queue: ActionQueueView, group: DeadlineGroup, modelCompany = false): FlowReply => {
  const isModel = isModelQueue(queue, modelCompany);
  const note = renderAutomaticProcessingNote(isModel);
  const lines = [`📅 ${group.title}${modelLabel(isModel)}`, ""];
  const shown: GroupItem[] = [];
  for (const item of group.items) {
    const addition = itemLines(item);
    const footer = ["", `Расчёт на ${formatDate(queue.asOf)}.`, "", note].join("\n");
    if ([...lines, ...addition].join("\n").length + footer.length > MAX_TEXT_LENGTH) break;
    lines.push(...addition);
    shown.push(item);
  }
  if (shown.length < group.items.length) {
    lines.push(`Показаны ${shown.length} из ${group.items.length}: остальные не поместились в сообщение.`);
  }
  lines.push("", `Расчёт на ${formatDate(queue.asOf)}.`);
  return {
    text: composeText(lines, note),
    sourceUrls: sourceUrls(shown),
    automated: true,
    buttons: [backButton(), homeButton()],
  };
};

export const renderDeadlinesNoCompany = (): FlowReply => ({
  text: composeText(["Чтобы показать сроки, сначала укажите ИНН компании."], renderAutomaticProcessingNote(false)),
  sourceUrls: [],
  automated: true,
  buttons: [{ text: "Ввести ИНН", payload: encodeButtonPayload({ type: "start" }) }],
  stateOverride: "idle",
});

export const renderDeadlinesUnavailable = (): FlowReply => ({
  text: composeText(
    ["Не получилось построить очередь действий. Попробуйте ещё раз позже."],
    renderAutomaticProcessingNote(false),
  ),
  sourceUrls: [],
  automated: true,
  buttons: [homeButton()],
});
