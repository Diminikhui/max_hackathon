import type { DateTime, RegulationDocument } from "@max-hackathon/domain";
import type { NpaProject } from "./client/index.js";

export type NormalizationError = "missing_title" | "invalid_published_at" | "invalid_url";

export type NormalizationResult =
  | { ok: true; document: RegulationDocument }
  | { ok: false; documentId: string; error: NormalizationError };

export interface NormalizeProjectOptions {
  retrievedAt: DateTime;
  /** true разрешён только для явно модельной ленты/фикстуры. Живой regulation.gov.ru — false. */
  isModel?: boolean;
}

function clean(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function isoFromRussianDate(value: string): string | undefined {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
  if (!match) return undefined;
  const [, dayText, monthText, yearText, hourText = "00", minuteText = "00", secondText = "00"] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return undefined;
  }
  return date.toISOString();
}

/** ISO 8601 или дата портала дд.мм.гггг[ чч:мм:сс] → канонический UTC. */
export function normalizeDateTime(value: string | undefined): DateTime | undefined {
  const candidate = clean(value);
  if (!candidate) return undefined;
  const russian = isoFromRussianDate(candidate);
  if (russian) return russian;
  const timestamp = Date.parse(candidate);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Преобразует сырой проект портала в RegulationDocument v1, не выдумывая обязательные поля. */
export function normalizeProject(project: NpaProject, options: NormalizeProjectOptions): NormalizationResult {
  const title = clean(project.title);
  if (!title) return { ok: false, documentId: project.id, error: "missing_title" };
  const publishedAt = normalizeDateTime(project.publishedAt);
  if (!publishedAt) return { ok: false, documentId: project.id, error: "invalid_published_at" };
  if (!isHttpUrl(project.url)) return { ok: false, documentId: project.id, error: "invalid_url" };

  const stage = clean(project.stage);
  return {
    ok: true,
    document: {
      documentId: project.id,
      title,
      url: project.url,
      publishedAt,
      ...(stage ? { stage } : {}),
      ...(project.sphereIds.length > 0
        ? { sphereIds: [...new Set(project.sphereIds)].sort((a, b) => a - b).map(String) }
        : {}),
      source: {
        system: "regulation.gov.ru",
        url: project.url,
        recordId: project.id,
        retrievedAt: options.retrievedAt,
        isModel: options.isModel ?? false,
      },
    },
  };
}
