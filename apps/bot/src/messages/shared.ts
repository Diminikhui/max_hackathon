import type { ApplicabilityStatus, LegalBasis, Requirement } from "@max-hackathon/domain";

export type { ApplicabilityStatus, NotificationReason } from "@max-hackathon/domain";

export type MessageBasis = LegalBasis;

export type MessageRequirement = Pick<Requirement, "kind" | "title" | "summary" | "deadline" | "validity" | "basis"> & {
  source: Pick<Requirement["source"], "isModel">;
};

export interface RenderedMessage {
  text: string;
  sourceUrls: string[];
  automated: true;
}

export const STATUS_TEXT: Record<ApplicabilityStatus, string> = {
  applies: "Применяется",
  not_applies: "Не применяется",
  insufficient_data: "Недостаточно данных",
  needs_review: "Требуется проверка",
  out_of_coverage: "Вне покрытия системы",
};

export const renderAutomaticProcessingNote = (isModel: boolean): string =>
  [
    "ℹ️ Текст сформирован автоматически. Сверяйтесь с первоисточником.",
    ...(isModel ? ["🧪 Модельные данные — не результат реальной интеграции."] : []),
  ].join("\n");

export const renderSources = (basis: readonly MessageBasis[]): { lines: string[]; urls: string[] } => {
  if (basis.length === 0) throw new Error("Для сообщения нужен хотя бы один официальный первоисточник");

  const urls: string[] = [];
  const seen = new Set<string>();
  const lines = basis.map((item) => {
    assertWebUrl(item.url);
    if (!seen.has(item.url)) {
      seen.add(item.url);
      urls.push(item.url);
    }
    return `• ${item.act}${item.article ? `, ${item.article}` : ""} — ${item.url}`;
  });

  return { lines: ["Первоисточник:", ...lines], urls };
};

const assertWebUrl = (value: string): void => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Некорректная ссылка на первоисточник: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Ссылка на первоисточник должна использовать HTTP(S): ${value}`);
  }
};

export const requirementLabel = (kind: MessageRequirement["kind"]): string =>
  kind === "opportunity" ? "Возможность" : "Обязанность";

/** Лимит длины текста сообщения MAX (K-05c). */
export const MAX_TEXT_LENGTH = 4000;

const MOSCOW_DATE = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const MOSCOW_TIME = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** `2026-09-25` → `25.09.2026`; ISO с временем → `25.09.2026, 12:00 (МСК)`. Нераспознанное значение выводится как есть. */
export const formatDate = (value: string): string => {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) return `${dateOnly[3]}.${dateOnly[2]}.${dateOnly[1]}`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${MOSCOW_DATE.format(date)}, ${MOSCOW_TIME.format(date)} (МСК)`;
};

/**
 * Собирает текст сообщения в пределах лимита MAX. Если тело не помещается, оно обрезается,
 * а пометка об автоматической обработке сохраняется всегда.
 */
export const composeText = (body: readonly string[], note: string): string => {
  const text = [...body, "", note].join("\n");
  if (text.length <= MAX_TEXT_LENGTH) return text;
  const tail = `…\n\n${note}`;
  return body.join("\n").slice(0, MAX_TEXT_LENGTH - tail.length) + tail;
};

export const modelLabel = (isModel: boolean): string => (isModel ? " · МОДЕЛЬНЫЕ ДАННЫЕ" : "");
