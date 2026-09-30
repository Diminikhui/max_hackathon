import type { CompanyProfile, Fact, FactValue, NotificationButton, SourceInfo } from "@max-hackathon/domain";
import { composeText, modelLabel, renderAutomaticProcessingNote } from "../../messages/shared.js";
import { encodeButtonPayload } from "../../transport/index.js";
import type { FlowReply } from "../checklist/index.js";

const INN_HINT = "Отправьте ИНН компании: 10 цифр для организации или 12 цифр для ИП.";

export const startButton = (): NotificationButton => ({
  text: "Ввести ИНН",
  payload: encodeButtonPayload({ type: "start" }),
});
/** До меню событие `home` возвращает к приветствию. */
export const restartButton = (): NotificationButton => ({
  text: "↩️ В начало",
  payload: encodeButtonPayload({ type: "home" }),
});
export const confirmProfileButton = (): NotificationButton => ({
  text: "✅ Всё верно",
  payload: encodeButtonPayload({ type: "confirm_profile" }),
});
export const editProfileButton = (): NotificationButton => ({
  text: "✏️ Другой ИНН",
  payload: encodeButtonPayload({ type: "edit_profile" }),
});

const reply = (lines: readonly string[], buttons: NotificationButton[], isModel = false): FlowReply => ({
  text: composeText(lines, renderAutomaticProcessingNote(isModel)),
  sourceUrls: [],
  automated: true,
  buttons,
});

const withNotice = (notice: string | undefined, lines: readonly string[]): string[] =>
  notice ? [notice, "", ...lines] : [...lines];

const GREETING =
  "👋 Бот подскажет, какие обязательные требования касаются вашей компании, и сообщит, когда они изменятся.";

/** Приветствие: что делает бот и с чего начать. */
export const renderWelcome = (notice?: string): FlowReply =>
  reply(
    withNotice(notice, [GREETING, "", "Для начала нужен ИНН: по нему бот найдёт компанию в открытых источниках."]),
    [startButton()],
  );

/** Первый экран после «Начать»: приветствие и сразу запрос ИНН. */
export const renderIntro = (): FlowReply => reply([GREETING, "", INN_HINT], [restartButton()]);

/** Запрос ИНН. `notice` — что пошло не так на прошлом шаге. */
export const renderRequestInn = (notice?: string): FlowReply =>
  reply(withNotice(notice, [INN_HINT]), [restartButton()]);

/** Ввод не прошёл проверку ИНН (K-25a): текст ошибки уже объясняет, что исправить. */
export const renderInvalidInn = (message: string): FlowReply =>
  reply([`⚠️ ${message}`, "", INN_HINT], [restartButton()]);

/**
 * Реальный источник бота — реестр МСП (K-12b). «Не найдено» означает только «нет в этом реестре»: компания может быть
 * крупной, исключённой из реестра или появиться в нём после ежемесячного обновления (#370). Поэтому текст прямо
 * говорит, что это не ошибка в номере и не отсутствие компании.
 */
const PROFILE_NOT_FOUND_HINT =
  "Это не значит, что номер неверный или что компании нет. В этом реестре нет крупных компаний, компаний, исключённых из реестра, и компаний, которые попали в него недавно: реестр обновляется раз в месяц. Проверьте номер ещё раз или отправьте ИНН другой компании.";

export const renderProfileNotFound = (message?: string): FlowReply =>
  reply(
    [
      `🔍 ${message ?? "Компания с таким ИНН не найдена в реестре малого и среднего бизнеса ФНС."}`,
      "",
      PROFILE_NOT_FOUND_HINT,
    ],
    [restartButton()],
  );

export const renderLookupFailed = (retryable: boolean, message?: string): FlowReply =>
  reply(
    [
      `⏳ ${message ?? "Не удалось получить данные о компании."}`,
      "",
      retryable ? "Отправьте ИНН ещё раз через минуту." : "Попробуйте позже или отправьте ИНН другой компании.",
    ],
    [restartButton()],
  );

/** Поиск прервался (например, бот перезапустился): начинаем ввод ИНН заново. */
export const renderLookupInterrupted = (): FlowReply =>
  renderRequestInn("Поиск компании прервался. Давайте попробуем ещё раз.");

const ENTITY_TYPE_TEXT: Record<CompanyProfile["entityType"], string> = {
  legal_entity: "организация",
  individual_entrepreneur: "индивидуальный предприниматель",
};

const FACT_LABELS: Readonly<Record<string, string>> = {
  "activity.okved_main": "Основной ОКВЭД",
  "activity.okved_additional": "Дополнительные ОКВЭД",
  "location.region_code": "Код региона",
  "scale.msp_category": "Категория МСП",
  "employment.has_employees": "Есть работники",
  "employment.headcount": "Численность работников",
  "sales.alcohol": "Продажа алкоголя",
  "tax.regime": "Налоговый режим",
};

const VALUE_TEXT: Readonly<Record<string, string>> = {
  micro: "микропредприятие",
  small: "малое предприятие",
  medium: "среднее предприятие",
  none: "нет",
  beer: "пиво",
  strong: "крепкий алкоголь",
  usn_income: "УСН «доходы»",
  usn_income_expense: "УСН «доходы минус расходы»",
  psn: "патент",
  osn: "общая система",
  npd: "налог на профессиональный доход",
};

const formatValue = (value: FactValue): string => {
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value))
    return value.length === 0 ? "нет" : value.map((item) => VALUE_TEXT[item] ?? item).join(", ");
  return VALUE_TEXT[value] ?? value;
};

// Как вычислитель K-16a: официальный факт главнее производного, производный — заявленного. Сценарные факты
// («что если») к реальному профилю не относятся и не показываются.
const KIND_RANK: Readonly<Partial<Record<Fact["kind"], number>>> = { official: 0, derived: 1, declared: 2 };

/** Известные поля профиля в фиксированном порядке; по каждому ключу — один факт с наивысшим приоритетом. */
const profileLines = (facts: readonly Fact[]): string[] =>
  Object.entries(FACT_LABELS).flatMap(([key, label]) => {
    const fact = facts
      .filter((candidate) => candidate.key === key && KIND_RANK[candidate.kind] !== undefined)
      .sort((left, right) => (KIND_RANK[left.kind] ?? 0) - (KIND_RANK[right.kind] ?? 0))[0];
    if (fact === undefined) return [];
    const declared = fact.kind === "declared" ? " (по вашим словам)" : "";
    return [`• ${label}: ${formatValue(fact.value)}${declared}`];
  });

/** Карточка найденной компании на подтверждение. */
export const renderProfileCard = (
  profile: CompanyProfile,
  source: SourceInfo | undefined,
  options: { readonly alreadySaved?: boolean; readonly notice?: string } = {},
): FlowReply => {
  const isModel = profile.isModel || (source?.isModel ?? false);
  const facts = profileLines(profile.facts);
  const lines = withNotice(options.notice, [
    `🏢 Это ваша компания?${modelLabel(isModel)}`,
    "",
    ...(profile.displayName ? [profile.displayName] : []),
    `ИНН ${profile.inn} · ${ENTITY_TYPE_TEXT[profile.entityType]}`,
    ...(facts.length > 0 ? ["", ...facts] : []),
    "",
    ...(source ? [`Источник: ${source.name}.`] : []),
    ...(options.alreadySaved ? ["Компания уже сохранена: данные обновятся, ваши уточнения останутся."] : []),
    "По этим данным бот определит, какие требования касаются компании.",
  ]);
  return reply(lines, [confirmProfileButton(), editProfileButton(), restartButton()], isModel);
};

export const switchCompanyButton = (): NotificationButton => ({
  text: "🔄 Другая компания",
  payload: encodeButtonPayload({ type: "edit_profile" }),
});

/** Главное меню после подтверждения профиля. */
export const renderMenu = (notice?: string): FlowReply =>
  reply(withNotice(notice, ["Главное меню. Что показать?"]), [
    { text: "📋 Мой перечень", payload: encodeButtonPayload({ type: "open_requirements" }) },
    { text: "🔔 Уведомления", payload: encodeButtonPayload({ type: "open_notification_settings" }) },
    switchCompanyButton(),
  ]);

/** Ввод ИНН другой компании из меню: текущая остаётся, пока новая не подтверждена. */
export const renderSwitchCompany = (): FlowReply =>
  reply(
    [
      "🔄 Смена компании",
      "",
      INN_HINT,
      "Текущая компания останется, пока вы не подтвердите новую. «↩️ В начало» вернёт в меню без изменений.",
    ],
    [restartButton()],
  );
