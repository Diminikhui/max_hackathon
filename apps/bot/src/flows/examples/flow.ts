import type { CompanyProfile, NotificationButton } from "@max-hackathon/domain";
import type { DialogEvent } from "../../dialog/index.js";
import type { FlowReply } from "../checklist/index.js";

export const EXAMPLE_PAYLOAD_PREFIX = "examples:company:";

interface ExampleCandidate {
  readonly inn: string;
  readonly label: string;
}

/**
 * Только модельные компании K-28, для которых сценарий показывает заметно разные перечни.
 * Наличие профиля в фактической конфигурации процесса проверяется в `selectExampleCompanies`.
 */
const CANDIDATES: readonly ExampleCandidate[] = [
  { inn: "7700000016", label: "☕ Кафе, Москва" },
  { inn: "1600000011", label: "☕ Кафе, Татарстан" },
  { inn: "770000000082", label: "👤 ИП без работников" },
];

export interface ExampleCompany extends ExampleCandidate {
  readonly isModel: true;
}

/** Не предлагает отсутствующий, реальный или ошибочно не помеченный модельным профиль. */
export const selectExampleCompanies = (
  profiles: readonly Pick<CompanyProfile, "inn" | "isModel">[],
): ExampleCompany[] =>
  CANDIDATES.flatMap((candidate) => {
    const profile = profiles.find((item) => item.inn === candidate.inn);
    return profile?.isModel === true ? [{ ...candidate, isModel: true as const }] : [];
  });

export interface ExamplesFlow {
  /** Добавляет примеры перед навигационной кнопкой экрана ввода ИНН. */
  decorate(reply: FlowReply): FlowReply;
  /** Превращает только кнопку настроенного примера в тот же `submit_inn`, что и ручной ввод. */
  eventFor(payload: string): DialogEvent | undefined;
}

type CallbackButton = Extract<NotificationButton, { readonly payload: string }>;

const buttonFor = (company: ExampleCompany): CallbackButton => ({
  text: company.label,
  payload: `${EXAMPLE_PAYLOAD_PREFIX}${company.inn}`,
});

export const createExamplesFlow = (companies: readonly ExampleCompany[]): ExamplesFlow => {
  const byPayload = new Map(companies.map((company) => [buttonFor(company).payload, company]));

  return {
    decorate: (reply) => {
      if (companies.length === 0) return reply;
      const buttons = companies.map(buttonFor);
      const beforeNavigation = reply.buttons.length === 0 ? 0 : reply.buttons.length - 1;
      return {
        ...reply,
        buttons: [...reply.buttons.slice(0, beforeNavigation), ...buttons, ...reply.buttons.slice(beforeNavigation)],
      };
    },
    eventFor: (payload) => {
      const company = byPayload.get(payload);
      return company === undefined ? undefined : { type: "submit_inn", inn: company.inn };
    },
  };
};
