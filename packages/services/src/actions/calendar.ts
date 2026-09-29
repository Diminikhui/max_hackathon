import type { Id, IsoDate, Requirement } from "@max-hackathon/domain";

/**
 * Правило срока для одной записи пакета. Разобрано человеком из свободного текста `deadline`,
 * а не выведено эвристикой: дата появляется только там, где её можно назвать без догадок.
 */
export type DueRule =
  /**
   * Обязанность повторяется каждый день: срок — дата расчёта. `action` называет обязанность («Ежедневная
   * влажная уборка…»), а не командует: граница продукта — сообщаем об обязанности, не рекомендуем действие.
   */
  | { type: "daily"; action: string }
  /** Срок наступает при событии (продажа, поставка, допуск работника); календарной даты нет. */
  | { type: "event"; trigger: string }
  /** Требование действует постоянно; отдельного срока исполнения нет. */
  | { type: "continuous" }
  /** Периодическое действие; дата зависит от последнего исполнения, которого нет в фактах. */
  | { type: "periodic"; period: string };

export interface DueCalendarEntry {
  packId: Id;
  requirementId: Id;
  /** Правило относится к этой версии записи; для другой версии дата не выдаётся. */
  packVersion: number;
  rule: DueRule;
}

export const UNDATED_REASONS = [
  "event",
  "continuous",
  "periodic_without_last_date",
  "calendar_outdated",
  "not_in_calendar",
] as const;
export type UndatedReason = (typeof UNDATED_REASONS)[number];

export type DueResolution =
  | { type: "dated"; dueDate: IsoDate; source: "deadline_text" | "calendar"; action?: string }
  | { type: "undated"; reason: UndatedReason; detail?: string };

export type DueResolver = (requirement: Requirement, asOf: IsoDate) => DueResolution;

const entry = (packId: Id, requirementId: Id, rule: DueRule): DueCalendarEntry => ({
  packId,
  requirementId,
  packVersion: 1,
  rule,
});

const food = (id: string, rule: DueRule) => entry("a-foodservice-fed", `a.fed.${id}`, rule);
const auto = (id: string, rule: DueRule) => entry("b-autoservice-fed", `b.fed.${id}`, rule);
const tatarstan = (id: string, rule: DueRule) => entry("a-foodservice-ru-16", `a.tatarstan.${id}`, rule);
const opportunity = (id: string, rule: DueRule) =>
  entry("a-foodservice-opportunities-fed", `a.opportunity.${id}`, rule);

/**
 * Модельный календарь сроков для опубликованных пакетов v1: федеральные общепит и автосервис,
 * общепит Татарстана и возможности общепита. Сверен с полем `deadline` записей; при выпуске
 * новой версии пакета его нужно пересмотреть.
 */
export const DEFAULT_DUE_CALENDAR: readonly DueCalendarEntry[] = [
  food("start-notification", {
    type: "event",
    trigger: "до начала работы по адресу, при смене адреса или прекращении",
  }),
  food("haccp-production-control", { type: "continuous" }),
  food("technical-documents", { type: "continuous" }),
  food("incoming-control-traceability", { type: "event", trigger: "при каждой поставке" }),
  food("storage-and-temperature-control", {
    type: "daily",
    action: "Ежедневная запись температуры (на складах — и влажности)",
  }),
  food("staff-medical-and-hygiene", { type: "periodic", period: "периодический медосмотр — раз в год" }),
  food("staff-daily-health-check", { type: "daily", action: "Ежедневный осмотр здоровья работников смены" }),
  food("cleaning-pest-control", { type: "daily", action: "Ежедневная влажная уборка производственных помещений" }),
  food("consumer-information-menu", { type: "event", trigger: "при заключении договора (заказа)" }),
  food("cash-register-before-payment", { type: "event", trigger: "при каждом расчёте" }),
  food("mercury-incoming-evsd", { type: "event", trigger: "в течение 24 часов после доставки или реализации партии" }),
  food("fire-safety", { type: "event", trigger: "инструктаж — до допуска к работе" }),
  food("occupational-safety", { type: "periodic", period: "повторный инструктаж — не реже раза в 6 месяцев" }),
  food("special-assessment-of-working-conditions", { type: "periodic", period: "не реже раза в 5 лет" }),
  food("no-smoking", { type: "event", trigger: "знак — до открытия заведения" }),
  food("alcohol-catering-rules", { type: "event", trigger: "при каждой продаже алкоголя" }),
  food("alcohol-strong-license", { type: "event", trigger: "лицензия — до первой продажи" }),
  food("energy-drinks-minors", { type: "event", trigger: "при каждой продаже" }),
  food("catering-delivery", { type: "event", trigger: "до проведения кейтеринга" }),
  auto("consumer-information", { type: "event", trigger: "до заключения договора" }),
  auto("written-service-contract", { type: "event", trigger: "до начала оказания услуг" }),
  auto("vehicle-acceptance-act", { type: "event", trigger: "при передаче автомобиля исполнителю" }),
  auto("cash-register-receipt", { type: "event", trigger: "при каждом расчёте" }),
  auto("automotive-occupational-safety", { type: "event", trigger: "до допуска работника к самостоятельной работе" }),
  auto("hazardous-waste-passports", { type: "event", trigger: "до передачи отхода I–IV класса" }),
  auto("fire-safety-regime", { type: "event", trigger: "до начала эксплуатации объекта" }),
  tatarstan("alcohol-regional-restrictions", {
    type: "event",
    trigger: "до первой продажи алкоголя и при изменении адреса, формата объекта или региональных правил",
  }),
  // «С 01.09.2026» — дата начала действия запрета, а не срок исполнения.
  tatarstan("energy-drinks-places", { type: "event", trigger: "при каждой продаже (с 01.09.2026)" }),
  opportunity("foodservice-vat-exemption", {
    type: "event",
    trigger: "перед применением освобождения — по итогам предшествующего календарного года",
  }),
  // Окно 01.04–31.12.2026 — период действия льготы; срока исполнения для компании в тексте нет.
  opportunity("foodservice-vat-transition-2026", { type: "continuous" }),
  opportunity("foodservice-reduced-insurance-rate", { type: "event", trigger: "при расчёте взносов за каждый месяц" }),
  opportunity("foodservice-patent-tax-system", { type: "event", trigger: "заявление — до начала применения патента" }),
];

/**
 * Сначала берёт явную дату `YYYY-MM-DD` из текста срока, затем правило календаря.
 * Запись без правила или с правилом другой версии пакета остаётся без даты.
 */
export const createDueResolver = (calendar: readonly DueCalendarEntry[] = DEFAULT_DUE_CALENDAR): DueResolver => {
  const byKey = new Map(calendar.map((item) => [`${item.packId}\u0000${item.requirementId}`, item]));

  return (requirement, asOf) => {
    const explicit = earliestIsoDate(requirement.deadline ?? "");
    if (explicit) return { type: "dated", dueDate: explicit, source: "deadline_text" };

    const item = byKey.get(`${requirement.packId}\u0000${requirement.id}`);
    if (!item) return { type: "undated", reason: "not_in_calendar" };
    if (item.packVersion !== requirement.packVersion) {
      return { type: "undated", reason: "calendar_outdated", detail: `правило для версии ${item.packVersion}` };
    }

    const { rule } = item;
    switch (rule.type) {
      case "daily":
        return { type: "dated", dueDate: asOf, source: "calendar", action: rule.action };
      case "event":
        return { type: "undated", reason: "event", detail: rule.trigger };
      case "continuous":
        return { type: "undated", reason: "continuous" };
      case "periodic":
        return { type: "undated", reason: "periodic_without_last_date", detail: rule.period };
    }
  };
};

/** Самая ранняя корректная дата `YYYY-MM-DD` в тексте. */
export const earliestIsoDate = (text: string): IsoDate | undefined =>
  (text.match(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g) ?? []).filter(isIsoDate).sort()[0];

export const isIsoDate = (value: string): value is IsoDate => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
