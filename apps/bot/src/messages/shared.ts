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

export const modelLabel = (isModel: boolean): string => (isModel ? " · МОДЕЛЬНЫЕ ДАННЫЕ" : "");
