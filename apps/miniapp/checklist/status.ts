import type { ChecklistFilter, ChecklistItem, ChecklistStatus } from "./types";

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

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("ru-RU").format(date);
}
