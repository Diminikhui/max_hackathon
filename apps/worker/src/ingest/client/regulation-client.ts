// Клиент regulation.gov.ru: список проектов /api/npalist/ (XML) и серверный фильтр GetFiltered (JSON).
// Запросы идут последовательно с паузой между ними; временные ошибки повторяются с растущей задержкой.
import { PORTAL_URL, pageFromJson, pageFromXml } from "./normalize.js";
import { type FetchLike, type FetchPage, type FilteredQuery, RegulationClientError } from "./types.js";
import { parseXml, XmlParseError } from "./xml.js";

export const MAX_PAGE_SIZE = 500;

export interface RegulationClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  /** Минимальная пауза между запросами к порталу, мс. */
  minIntervalMs?: number;
  /** Повторы временных ошибок (429, 5xx, сеть, таймаут). */
  maxRetries?: number;
  /** Базовая задержка повтора, мс; растёт вдвое на каждой попытке. */
  retryBaseMs?: number;
  /** Верхняя граница ожидания по Retry-After и backoff, мс. */
  maxRetryDelayMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Экранирует значение для синтаксиса фильтров портала (Sieve): запятая и `|` — разделители. */
export function escapeFilterValue(value: string): string {
  return value.replace(/([\\,|])/g, "\\$1");
}

/** Строка фильтра GetFiltered: `okveds==23|45,title@=кафе`. */
export function buildFilter(query: FilteredQuery): string {
  const parts: string[] = [];
  const spheres = [...new Set(query.sphereIds ?? [])];
  for (const id of spheres) {
    if (!Number.isInteger(id) || id <= 0) throw new RegulationClientError("INVALID_INPUT", `Неверная сфера: ${id}`);
  }
  if (spheres.length > 0) parts.push(`okveds==${spheres.join("|")}`);
  const title = query.titleContains?.trim();
  if (title) parts.push(`title@=${escapeFilterValue(title)}`);
  return parts.join(",");
}

export class RegulationClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastRequestAt: number | undefined;

  constructor(options: RegulationClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? PORTAL_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.minIntervalMs = options.minIntervalMs ?? 1000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 2000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Последние проекты из /api/npalist/ (XML). */
  async listNpa(params: { limit?: number } = {}): Promise<FetchPage> {
    const limit = params.limit ?? MAX_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new RegulationClientError("INVALID_INPUT", `limit должен быть от 1 до ${MAX_PAGE_SIZE}`);
    }
    const initial = await this.fetchNpa(0, 1);
    const total = Number(initial.attributes.total);
    if (!Number.isSafeInteger(total) || total < 0 || initial.attributes.total === undefined) {
      throw new RegulationClientError("DEPENDENCY_UNAVAILABLE", "Ответ npalist не содержит корректный total");
    }
    if (total <= 1) return pageFromXml(initial);
    return pageFromXml(await this.fetchNpa(Math.max(0, total - limit), limit));
  }

  private async fetchNpa(offset: number, limit: number) {
    const text = await this.request(`/api/npalist/?offset=${offset}&limit=${limit}`, {
      method: "GET",
      headers: { Accept: "application/xml" },
    });
    try {
      return parseXml(text);
    } catch (error) {
      if (error instanceof XmlParseError) {
        throw new RegulationClientError("DEPENDENCY_UNAVAILABLE", `Ответ npalist не разобран: ${error.message}`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  /** Одна страница GetFiltered (нумерация с 1). */
  async getFilteredPage(query: FilteredQuery, page: number): Promise<ReturnType<typeof pageFromJson>> {
    const pageSize = query.pageSize ?? MAX_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw new RegulationClientError("INVALID_INPUT", `pageSize должен быть от 1 до ${MAX_PAGE_SIZE}`);
    }
    const body = JSON.stringify({
      listParams: { filterModel: { filters: buildFilter(query), sorts: "-id", page, pageSize } },
      orderedFields: [
        "id",
        "projectId",
        "title",
        "developedDepartment",
        "creationDate",
        "publicationDate",
        "stage",
        "status",
        "okveds",
      ],
    });
    const text = await this.request("/api/public/PublicProjects/GetFiltered", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new RegulationClientError("DEPENDENCY_UNAVAILABLE", "Ответ GetFiltered — не JSON", { cause: error });
    }
    try {
      return pageFromJson(parsed);
    } catch (error) {
      throw new RegulationClientError("DEPENDENCY_UNAVAILABLE", "Неизвестная структура ответа GetFiltered", {
        cause: error,
      });
    }
  }

  /** Вся выборка GetFiltered постранично: до пустой/неполной страницы, total или maxPages. */
  async getFiltered(query: FilteredQuery): Promise<FetchPage & { pages: number }> {
    const pageSize = query.pageSize ?? MAX_PAGE_SIZE;
    const maxPages = query.maxPages ?? 20;
    const seen = new Set<string>();
    const result: FetchPage & { pages: number } = { items: [], skipped: 0, pages: 0 };
    for (let page = 1; page <= maxPages; page++) {
      const current = await this.getFilteredPage(query, page);
      result.pages = page;
      result.skipped += current.skipped;
      for (const item of current.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        result.items.push(item);
      }
      const done = current.received < pageSize || (current.total !== undefined && page * pageSize >= current.total);
      if (done) break;
    }
    return result;
  }

  private async request(path: string, init: RequestInit): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let error: RegulationClientError;
      let retryAfterMs: number | undefined;
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.ok) return await response.text();
        retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), this.now());
        error = errorForStatus(response.status, path);
        await response.body?.cancel().catch(() => undefined);
      } catch (cause) {
        if (cause instanceof RegulationClientError) throw cause;
        const timeout = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
        error = timeout
          ? new RegulationClientError("DEPENDENCY_TIMEOUT", `Таймаут ${path}`, { cause })
          : new RegulationClientError("DEPENDENCY_UNAVAILABLE", `Сеть недоступна: ${path}`, { cause });
      }
      if (!error.retryable || attempt >= this.maxRetries) throw error;
      const backoff = this.retryBaseMs * 2 ** attempt;
      await this.sleep(Math.min(this.maxRetryDelayMs, Math.max(backoff, retryAfterMs ?? 0)));
    }
  }

  private async throttle(): Promise<void> {
    if (this.lastRequestAt !== undefined) {
      const wait = this.lastRequestAt + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
    }
    this.lastRequestAt = this.now();
  }
}

function errorForStatus(status: number, path: string): RegulationClientError {
  const message = `regulation.gov.ru ответил ${status} на ${path}`;
  if (status === 429) return new RegulationClientError("RATE_LIMITED", message, { status });
  if (status === 408 || status === 504) return new RegulationClientError("DEPENDENCY_TIMEOUT", message, { status });
  if (status >= 500) return new RegulationClientError("DEPENDENCY_UNAVAILABLE", message, { status });
  if (status === 400 || status === 404 || status === 422) {
    return new RegulationClientError("INVALID_INPUT", message, { status });
  }
  return new RegulationClientError("INTERNAL_ERROR", message, { status });
}

/** Retry-After: секунды или HTTP-дата. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}
