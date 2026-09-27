// Модельный перечень кафе: по одной записи на каждый из пяти статусов. Тексты и ссылки вымышленные, кроме домена
// pravo.gov.ru, который нужен шаблону K-23 как HTTP(S)-первоисточник.
import {
  type ApplicabilityResult,
  type ApplicabilityStatus,
  CONTRACT_VERSION,
  type Requirement,
} from "@max-hackathon/domain";
import type { ChecklistOutcomeView, ChecklistView } from "../../../../src/flows/checklist/index.js";

export const EVALUATED_AT = "2026-09-27T09:00:00.000Z";

const requirement = (id: string, title: string, isModel = true): Requirement => ({
  contractVersion: CONTRACT_VERSION,
  id,
  packId: "model-foodservice",
  packVersion: 3,
  kind: "obligation",
  title,
  summary: `Кратко: ${title.toLowerCase()}.`,
  deadline: "до начала работы",
  basis: [{ act: "Модельный закон № 1-ФЗ", article: `ст. ${id.length}`, url: `https://pravo.gov.ru/model/${id}` }],
  condition: { type: "always" },
  coverage: "full",
  source: { system: "model", retrievedAt: EVALUATED_AT, isModel },
});

const applicability = (req: Requirement, status: ApplicabilityStatus, statusReason?: string): ApplicabilityResult => ({
  contractVersion: req.contractVersion,
  companyId: "model-cafe",
  requirementId: req.id,
  packId: req.packId,
  packVersion: req.packVersion,
  status,
  ...(statusReason ? { statusReason } : {}),
  explanation: [],
  evaluatedAt: EVALUATED_AT,
});

const item = (id: string, title: string, status: ApplicabilityStatus, reason?: string) => {
  const req = requirement(id, title);
  return { requirement: req, applicability: applicability(req, status, reason) };
};

export const modelItems = [
  item("a-not-1", "Лицензия на ремонт автомобилей", "not_applies", "ОКВЭД компании — 56.10"),
  item("a-applies-1", "Уведомить о начале деятельности", "applies", "Основной ОКВЭД 56.10 — общепит"),
  item("a-review-1", "Разработать программу производственного контроля", "needs_review", "Норма требует толкования"),
  item("a-insufficient-1", "Лицензия на продажу алкоголя", "insufficient_data", "Неизвестно, продаёте ли вы алкоголь"),
  item("a-applies-2", "Медицинские книжки работников", "applies"),
  item("a-out-1", "Региональные требования Москвы", "out_of_coverage", "Регион вне покрытия"),
];

export const modelChecklist = (items = modelItems): ChecklistView => {
  const counts: Record<ApplicabilityStatus, number> = {
    applies: 0,
    not_applies: 0,
    insufficient_data: 0,
    needs_review: 0,
    out_of_coverage: 0,
  };
  for (const entry of items) counts[entry.applicability.status] += 1;
  return {
    evaluatedAt: EVALUATED_AT,
    asOf: "2026-09-27",
    packs: [{ packId: "model-foodservice", packVersion: 3 }],
    items,
    statusCounts: counts,
  };
};

export const okOutcome = (checklist = modelChecklist()): ChecklistOutcomeView => ({
  status: "ok",
  profile: { isModel: true },
  checklist,
});
