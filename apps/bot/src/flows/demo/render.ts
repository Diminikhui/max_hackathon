import type { ApplicabilityResult, NotificationButton, Requirement } from "@max-hackathon/domain";
import {
  composeText,
  renderAutomaticProcessingNote,
  renderSources,
  requirementLabel,
  STATUS_TEXT,
} from "../../messages/shared.js";
import { encodeButtonPayload } from "../../transport/index.js";
import { homeButton } from "../checklist/index.js";
import type { FlowReply } from "../checklist/types.js";
import { requirementCardButton } from "./deep-link.js";

/** Payload кнопки демо-триггера. Как и «Что проверяется» (K-34), обрабатывается вне машины диалога. */
export const DEMO_CHANGE_CALLBACK_PAYLOAD = "demo_change";

/** Видимая кнопка демо-триггера: её показывают меню и перечень. */
export const demoChangeButton = (): NotificationButton => ({
  text: "🧪 Показать пример изменения (модельное)",
  payload: DEMO_CHANGE_CALLBACK_PAYLOAD,
});

export type ChangeKind = "added" | "changed" | "removed";

/** Запись демо-изменения, как она выглядит для компании нажавшего. */
export interface DemoChangeItem {
  readonly kind: ChangeKind;
  readonly requirement: Requirement;
  /** Результат для компании по новой версии; у удалённой записи его нет. */
  readonly applicability?: ApplicabilityResult;
  /** Что сделал общий контур уведомлений для этой записи и компании. */
  readonly notification: "sent_here" | "sent_elsewhere" | "not_created" | "not_needed";
}

export interface DemoChangeView {
  readonly packTitle: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly items: readonly DemoChangeItem[];
  /** Модельная компания, на которой видно уведомление, если изменение не касается компании нажавшего. */
  readonly example?: { readonly inn: string; readonly title: string };
  /**
   * Показывать кнопку «Открыть карточку» (`open_app`). По умолчанию скрыта: пока корень сайта отдаёт не мини-приложение,
   * а страницу проверки K-05b, кнопка открывает технический JSON (Issue #347).
   */
  readonly cardLink?: boolean;
}

const CHANGE_TEXT: Record<ChangeKind, string> = {
  added: "Добавлена",
  changed: "Изменена",
  removed: "Удалена",
};

/** Касается ли запись компании: о таких статусах контур уведомляет (K-20a молчит о «не применяется»). */
export const concernsCompany = (item: Pick<DemoChangeItem, "applicability">): boolean =>
  item.applicability !== undefined &&
  item.applicability.status !== "not_applies" &&
  item.applicability.status !== "out_of_coverage";

/** Факты и проверенные условия из объяснения K-16 — без итоговой строки, она повторяет статус. */
const reasonLines = (applicability: ApplicabilityResult): string[] => {
  const steps = applicability.explanation.filter(
    (step) => (step.kind === "fact" || step.kind === "condition") && !step.text.startsWith("Итог условия"),
  );
  const lines = steps.map((step) => `   · ${step.text}`);
  if (applicability.statusReason) lines.unshift(`   · ${applicability.statusReason}`);
  return lines;
};

const NOTIFICATION_TEXT: Record<DemoChangeItem["notification"], string | undefined> = {
  sent_here: "🔔 Уведомление об этом изменении создано общим контуром рассылки и приходит в этот чат.",
  sent_elsewhere: "🔔 Уведомление об этом изменении уже создано раньше — для чата, где кнопку нажали первым.",
  not_created:
    "Уведомление в этот чат не создано: например, уведомления для компании отключены в настройках или исчерпан месячный лимит.",
  not_needed: undefined,
};

const describeItem = (item: DemoChangeItem): string[] => {
  const label = requirementLabel(item.requirement.kind).toLowerCase();
  const heading = `• ${CHANGE_TEXT[item.kind]} ${label}: ${item.requirement.title}`;
  if (!item.applicability) return [heading, "   Для вашей компании: больше не применяется."];
  return [heading, `   Для вашей компании: ${STATUS_TEXT[item.applicability.status].toLowerCase()}.`];
};

/**
 * Самодостаточный ответ демо-триггера: что изменилось, почему касается компании, первоисточник и пометка
 * «модельное изменение». Текст зависит только от данных, поэтому повторное нажатие даёт тот же ответ.
 */
export const renderDemoChange = (view: DemoChangeView): FlowReply => {
  const concerning = view.items.filter(concernsCompany);
  const other = view.items.filter((item) => !concernsCompany(item));
  const lines = [
    "🧪 Пример изменения · МОДЕЛЬНОЕ ИЗМЕНЕНИЕ",
    `«${view.packTitle}»: опубликована версия ${view.toVersion} вместо ${view.fromVersion}.`,
    "",
    "Что изменилось:",
    ...view.items.flatMap(describeItem),
    "",
  ];

  if (concerning.length > 0) {
    lines.push("Почему это касается вашей компании:");
    for (const item of concerning) {
      lines.push(`• ${item.requirement.title}`, ...reasonLines(item.applicability as ApplicabilityResult));
    }
    lines.push("");
    const notices = [...new Set(concerning.map((item) => NOTIFICATION_TEXT[item.notification]))];
    lines.push(...notices.filter((notice): notice is string => notice !== undefined), "");
  } else {
    lines.push("Вашей компании это изменение не касается:");
    for (const item of other) {
      lines.push(`• ${item.requirement.title}`, ...(item.applicability ? reasonLines(item.applicability) : []));
    }
    if (view.example) {
      lines.push("", `Чтобы увидеть уведомление, укажите модельный ИНН ${view.example.inn} — ${view.example.title}.`);
    }
    lines.push("");
  }

  const sources = renderSources(view.items.flatMap((item) => item.requirement.basis));
  lines.push(
    ...sources.lines,
    "",
    "Это модельное изменение: заранее подготовленная версия пакета показывает, как работает уведомление. " +
      "Оно не является юридическим утверждением. Повторное нажатие показывает тот же результат и не создаёт дубль.",
  );
  const firstConcern = concerning[0];

  return {
    text: composeText(lines, renderAutomaticProcessingNote(true)),
    sourceUrls: sources.urls,
    automated: true,
    buttons:
      firstConcern && view.cardLink === true
        ? [requirementCardButton(firstConcern.requirement.id), homeButton()]
        : [homeButton()],
  };
};

/** Компания ещё не выбрана: демо показывает изменение на конкретной компании. */
export const renderDemoNeedsCompany = (example?: DemoChangeView["example"]): FlowReply => ({
  text: composeText(
    [
      "🧪 Пример изменения (модельное)",
      "",
      "Чтобы показать, как приходит уведомление, сначала укажите ИНН компании.",
      ...(example ? [`Для демонстрации подойдёт модельный ИНН ${example.inn} — ${example.title}.`] : []),
    ],
    renderAutomaticProcessingNote(true),
  ),
  sourceUrls: [],
  automated: true,
  buttons: [{ text: "Ввести ИНН", payload: encodeButtonPayload({ type: "start" }) }],
  stateOverride: "idle",
});

/** Модельный пакет не загружен: публиковать следующую версию не поверх чего. */
export const renderDemoUnavailable = (): FlowReply => ({
  text: composeText(
    [
      "🧪 Пример изменения (модельное)",
      "",
      "Демонстрация сейчас недоступна: модельный пакет правил не загружен. Остальные функции бота работают.",
    ],
    renderAutomaticProcessingNote(true),
  ),
  sourceUrls: [],
  automated: true,
  buttons: [homeButton()],
});
