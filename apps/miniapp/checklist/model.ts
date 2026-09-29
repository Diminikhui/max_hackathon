import { CHECKLIST_STATUSES, type ChecklistItem, type CompanyChecklist } from "./types";

const titles = [
  "Оформить медицинские книжки сотрудников",
  "Подавать декларацию по акцизам",
  "Уточнить наличие посадочных мест",
  "Проверить региональные правила торговли",
  "Требования для производства сырого молока",
] as const;

const items: ChecklistItem[] = CHECKLIST_STATUSES.map((status, index) => ({
  requirement: {
    id: `model-requirement-${index + 1}`,
    title: titles[index] ?? "Модельное требование",
    summary: "Автоматически сформированное резюме для проверки интерфейса.",
    ...(index === 0 ? { deadline: "до допуска к работе" } : {}),
    basis: [{ act: "Модельное основание", url: "https://publication.pravo.gov.ru/" }],
    source: { url: "https://publication.pravo.gov.ru/", retrievedAt: "2026-09-29T12:00:00Z", isModel: true },
  },
  applicability: {
    status,
    statusReason:
      status === "insufficient_data" ? "Нужно уточнить сведения о компании." : "Результат модельной проверки.",
    evaluatedAt: "2026-09-29T12:00:00Z",
  },
}));

export const MODEL_CHECKLIST: CompanyChecklist = {
  evaluatedAt: "2026-09-29T12:00:00Z",
  asOf: "2026-09-29",
  items,
  statusCounts: {
    applies: 1,
    not_applies: 1,
    insufficient_data: 1,
    needs_review: 1,
    out_of_coverage: 1,
  },
};
