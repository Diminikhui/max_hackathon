import { CHECKLIST_STATUSES, type ChecklistFilter, type ChecklistItem, type ChecklistStatus } from "./types";

export const STATUS_META: Readonly<Record<ChecklistStatus, { label: string; shortLabel: string; tone: string }>> = {
  applies: { label: "Применяется", shortLabel: "Для вас", tone: "positive" },
  not_applies: { label: "Не применяется", shortLabel: "Не для вас", tone: "neutral" },
  insufficient_data: { label: "Недостаточно данных", shortLabel: "Нужны данные", tone: "warning" },
  needs_review: { label: "Требуется проверка", shortLabel: "Проверить", tone: "attention" },
  out_of_coverage: { label: "Вне покрытия", shortLabel: "Вне покрытия", tone: "muted" },
};

export function filterChecklist(items: readonly ChecklistItem[], filter: ChecklistFilter): readonly ChecklistItem[] {
  return filter === "all" ? items : items.filter((item) => item.applicability.status === filter);
}

export function sourceUrl(item: ChecklistItem): string | undefined {
  return item.requirement.basis[0]?.url ?? item.requirement.source.url;
}

/** Подписанный блок открытой карточки. */
export interface RequirementDetail {
  readonly label: string;
  readonly lines: readonly string[];
}

/**
 * Блоки открытой карточки в порядке чтения: суть, срок, причина статуса, основание (#372). Пустые блоки не выводятся;
 * срок показывается целиком, основание — актом и статьёй.
 */
export function requirementDetails(item: ChecklistItem): readonly RequirementDetail[] {
  const { requirement, applicability } = item;
  const basis = requirement.basis.map((entry) =>
    keepNumberSign(entry.article ? `${entry.act}, ${entry.article}` : entry.act),
  );
  const blocks: RequirementDetail[] = [
    { label: "Суть требования", lines: requirement.summary ? [requirement.summary] : [] },
    { label: "Срок", lines: requirement.deadline ? [requirement.deadline] : [] },
    { label: "Почему такой статус", lines: applicability.statusReason ? [applicability.statusReason] : [] },
    { label: "Основание", lines: basis },
  ];
  return blocks.filter((block) => block.lines.length > 0);
}

/** «№ 294-ФЗ» не разрывается переносом строки: после «№» ставится неразрывный пробел. */
function keepNumberSign(text: string): string {
  return text.replace(/№ /g, "№\u00a0");
}

/** Фильтры статусов, в которых есть записи: пустой фильтр только занимает место на экране телефона (#372). */
export function visibleStatusFilters(counts: Readonly<Record<ChecklistStatus, number>>): readonly ChecklistStatus[] {
  return CHECKLIST_STATUSES.filter((status) => counts[status] > 0);
}

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("ru-RU").format(date);
}
