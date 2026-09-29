import type { NotificationButton } from "@max-hackathon/domain";
import { composeText, modelLabel, renderAutomaticProcessingNote, STATUS_TEXT } from "../../messages/shared.js";
import type { ChecklistItemView, ChecklistView, FlowReply } from "../checklist/index.js";
import { homeButton, renderRequirementList } from "../checklist/index.js";
import { encodeClarifyPayload } from "./payload.js";
import type { ClarifyPlan } from "./plan.js";
import { itemsWaitingFor } from "./plan.js";
import { type ClarifyOption, type ClarifyQuestion, questionFor } from "./questions.js";

/** Кнопка под перечнем: начать уточнение. K-30b показывает её, если в перечне есть «недостаточно данных». */
export const clarifyButton = (): NotificationButton => ({
  text: "❔ Уточнить данные",
  payload: encodeClarifyPayload({ type: "start" }),
});

const finishButton = (): NotificationButton => ({
  text: "← К перечню",
  payload: encodeClarifyPayload({ type: "finish" }),
});

/** Сколько записей перечислять под вопросом: остальные — числом, чтобы вопрос оставался коротким. */
const MAX_WAITING_TITLES = 5;

/** Подписи недостающих фактов, о которых бот не спрашивает (их берёт профиль из реестра). */
const UNASKED_LABELS: Readonly<Record<string, string>> = {
  "activity.okved_main": "основной ОКВЭД",
  "activity.okved_additional": "дополнительные ОКВЭД",
  "location.region_code": "регион",
  "scale.msp_category": "категория МСП",
  "employment.headcount": "численность работников",
};

const factLabel = (key: string): string => questionFor(key)?.label.toLowerCase() ?? UNASKED_LABELS[key] ?? key;

export interface StatusChange {
  readonly title: string;
  readonly from: ChecklistItemView["applicability"]["status"];
  readonly to: ChecklistItemView["applicability"]["status"];
  /** Первоисточник записи: строка о смене статуса — автоматическое юридически значимое резюме (TEAM_GUIDE, п. 7). */
  readonly sourceUrl?: string;
}

/** Записи, у которых после ответа изменился статус. Новые и удалённые записи сюда не попадают. */
export const statusChanges = (before: ChecklistView, after: ChecklistView): StatusChange[] => {
  const previous = new Map(before.items.map((item) => [item.requirement.id, item.applicability.status]));
  return after.items.flatMap((item) => {
    const from = previous.get(item.requirement.id);
    return from === undefined || from === item.applicability.status
      ? []
      : [
          {
            title: item.requirement.title,
            from,
            to: item.applicability.status,
            ...(item.requirement.basis[0] ? { sourceUrl: item.requirement.basis[0].url } : {}),
          },
        ];
  });
};

/** Подтверждение ответа и изменения перечня: первые строки следующего экрана. */
export const renderAnswerPreface = (answer: ClarifyOption, changes: readonly StatusChange[]): string[] => [
  `✍️ Записали по вашим словам: ${answer.answerText}.`,
  ...(changes.length === 0
    ? ["Перечень пересчитан, статусы записей пока не изменились."]
    : [
        "Перечень пересчитан:",
        ...changes.flatMap((c) => [
          `• ${c.title}: ${STATUS_TEXT[c.from]} → ${STATUS_TEXT[c.to]}`,
          ...(c.sourceUrl ? [`  Первоисточник: ${c.sourceUrl}`] : []),
        ]),
      ]),
];

/** Ссылки на первоисточники записей, у которых сменился статус: попадают в `sourceUrls` ответа. */
export const changeSourceUrls = (changes: readonly StatusChange[]): string[] => [
  ...new Set(changes.flatMap((change) => (change.sourceUrl ? [change.sourceUrl] : []))),
];

export interface QuestionView {
  readonly question: ClarifyQuestion;
  readonly plan: ClarifyPlan;
  readonly isModel: boolean;
  readonly preface?: readonly string[];
}

/** Экран вопроса: какие записи ждут ответа, варианты кнопками, «Пропустить» и возврат к перечню. */
export const renderQuestion = ({ question, plan, isModel, preface = [] }: QuestionView): FlowReply => {
  const waiting = itemsWaitingFor(plan, question.key);
  const shown = waiting.slice(0, MAX_WAITING_TITLES);
  const remaining = plan.questions.length;
  const lines = [
    ...(preface.length > 0 ? [...preface, ""] : []),
    `❔ Уточнение${modelLabel(isModel)}`,
    "",
    question.text,
    ...(question.hint ? [question.hint] : []),
    "",
    `Ответ нужен для записей (${waiting.length}):`,
    ...shown.map((item) => `• ${item.requirement.title}`),
    ...(waiting.length > shown.length ? [`• и ещё ${waiting.length - shown.length}`] : []),
    "",
    remaining === 1 ? "Это последний вопрос." : `Осталось вопросов: ${remaining}.`,
    "Ответ сохранится с пометкой «по вашим словам». Если не уверены — нажмите «Пропустить».",
  ];

  const optionButtons = question.options.map(
    (option, index): NotificationButton => ({
      text: option.label,
      payload: encodeClarifyPayload({ type: "answer", key: question.key, option: index }),
    }),
  );

  return {
    text: composeText(lines, renderAutomaticProcessingNote(isModel)),
    sourceUrls: [],
    automated: true,
    buttons: [
      ...optionButtons,
      { text: "Пропустить", payload: encodeClarifyPayload({ type: "skip", key: question.key }) },
      finishButton(),
      homeButton(),
    ],
    stateOverride: "requirement_list",
  };
};

export interface FinishView {
  readonly checklist: ChecklistView;
  readonly plan: ClarifyPlan;
  readonly profileIsModel: boolean;
  readonly preface?: readonly string[];
}

/**
 * Итог уточнения: актуальный перечень. Если записи без итогового статуса остались, объясняется почему, и под
 * перечнем есть кнопка вернуться к неотвеченным вопросам — тупика нет.
 */
export const renderFinished = ({ checklist, plan, profileIsModel, preface = [] }: FinishView): FlowReply => {
  const missing = [...new Set(plan.blocked.flatMap((item) => item.applicability.missingFactKeys ?? []))];
  const open = missing.filter((key) => questionFor(key) !== undefined);
  const summary: string[] = [...preface, ...(preface.length > 0 ? [""] : [])];
  if (plan.blocked.length === 0) {
    summary.push("✅ Уточнение завершено: у всех записей есть итоговый статус.");
  } else {
    summary.push(`Без итогового статуса осталось записей: ${plan.blocked.length}.`);
    if (open.length > 0) {
      summary.push(`Нет ответа на вопросы: ${open.map(factLabel).join(", ")}. Вернуться к ним — «❔ Уточнить данные».`);
    }
    if (plan.unaskedKeys.length > 0) {
      summary.push(
        `Бот не спрашивает в диалоге: ${plan.unaskedKeys.map(factLabel).join(", ")}. Эти данные берутся из реестра при обновлении профиля.`,
      );
    }
  }

  const list = renderRequirementList(checklist, { profileIsModel, notice: summary.join("\n") });
  const buttons = open.length > 0 ? insertBeforeLast(list.buttons, clarifyButton()) : list.buttons;
  return { ...list, buttons, stateOverride: "requirement_list" };
};

/** Кнопка «🏠 Меню» остаётся последней. */
const insertBeforeLast = (buttons: readonly NotificationButton[], button: NotificationButton): NotificationButton[] => [
  ...buttons.slice(0, -1),
  button,
  ...buttons.slice(-1),
];

/** Ответ не сохранился: объяснение и тот же вопрос ещё раз. */
export const renderDeclareFailed = (view: QuestionView, message: string | undefined): FlowReply =>
  renderQuestion({
    ...view,
    preface: [`Не удалось сохранить ответ${message ? `: ${message}` : "."} Попробуйте ещё раз.`],
  });
