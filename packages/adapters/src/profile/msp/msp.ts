// K-12b. `ProfileSource` на реестре МСП ФНС: ОКВЭД, регион, категория, численность и лицензии одним запросом.
// Источник — внутренний интерфейс веб-сервиса rmsp.nalog.ru (`search-proc.json`), без опубликованной
// спецификации; решение и ограничения — ADR-0006 п. 7 и README.md рядом. Реальные ИНН и ФИО не логируются.
import type { CompanyProfile, Fact, ProfileLookupResult, ProfileSource, SourceInfo } from "@max-hackathon/domain";

export const MSP_SEARCH_URL = "https://rmsp.nalog.ru/search-proc.json";
export const MSP_SYSTEM = "rmsp.nalog.ru";
const MSP_CARD_URL = "https://rmsp.nalog.ru/search.html";

const INN_PATTERN = /^\d{10}(\d{2})?$/;

/** Запись ответа `search-proc.json`, только используемые поля. Числовые признаки приходят как 0/1. */
export interface MspRecord {
  inn: string;
  ogrn?: string;
  name_ex?: string;
  nptype?: string;
  category?: number;
  is_active?: number;
  regioncode?: string;
  okved1?: string;
  od2_sschr?: number;
  has_licenses?: number;
}

interface MspResponse {
  data?: unknown;
}

export interface MspProfileSourceOptions {
  fetch?: typeof fetch;
  url?: string;
  /** Эндпоинт иногда отвечает дольше 30 с; по истечении — `unavailable`, `retryable = true`. */
  timeoutMs?: number;
  now?: () => Date;
  /** Повторов при временной ошибке (таймаут, сеть, 5xx): эндпоинт изредка обрывает запрос. */
  retries?: number;
  retryDelayMs?: number;
}

const CATEGORY: Record<number, "micro" | "small" | "medium"> = { 1: "micro", 2: "small", 3: "medium" };

/**
 * Реальный источник профиля. `not_found` — ИНН нет в действующем реестре МСП (в том числе компания
 * исключена: `is_active = 0`); тогда профиль берётся из запасного источника (K-12a) или заявленных фактов.
 */
export class MspProfileSource implements ProfileSource {
  readonly info: SourceInfo = { name: "msp", isModel: false };
  readonly #fetch: typeof fetch;
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  readonly #retries: number;
  readonly #retryDelayMs: number;

  constructor(options: MspProfileSourceOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#url = options.url ?? MSP_SEARCH_URL;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#now = options.now ?? (() => new Date());
    this.#retries = options.retries ?? 1;
    this.#retryDelayMs = options.retryDelayMs ?? 1_000;
  }

  async lookupByInn(inn: string): Promise<ProfileLookupResult> {
    const normalized = typeof inn === "string" ? inn.trim() : "";
    if (!INN_PATTERN.test(normalized)) return { status: "not_found" };
    let result = await this.#lookupOnce(normalized);
    for (let attempt = 0; attempt < this.#retries && result.status === "unavailable" && result.retryable; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, this.#retryDelayMs));
      result = await this.#lookupOnce(normalized);
    }
    return result;
  }

  async #lookupOnce(normalized: string): Promise<ProfileLookupResult> {
    let body: MspResponse;
    try {
      const response = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Accept: "application/json" },
        body: new URLSearchParams({ mode: "quick", query: normalized }).toString(),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) {
        return {
          status: "unavailable",
          errorCode: `msp_http_${response.status}`,
          retryable: response.status >= 500 || response.status === 429,
        };
      }
      body = (await response.json()) as MspResponse;
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      if (error instanceof SyntaxError)
        return { status: "unavailable", errorCode: "msp_bad_response", retryable: true };
      return { status: "unavailable", errorCode: timeout ? "msp_timeout" : "msp_network", retryable: true };
    }

    if (!Array.isArray(body?.data)) return { status: "unavailable", errorCode: "msp_bad_response", retryable: false };
    // Быстрый поиск ищет и по подстроке: берём только точное совпадение ИНН и действующую запись.
    const record = (body.data as MspRecord[]).find((item) => item?.inn === normalized && item.is_active !== 0);
    if (!record) return { status: "not_found" };
    return { status: "found", profile: mapMspRecord(record, this.#now()) };
  }
}

/** Преобразует запись реестра МСП в `CompanyProfile`. Факт не создаётся, если значения нет. */
export function mapMspRecord(record: MspRecord, retrievedAt: Date): CompanyProfile {
  const inn = record.inn;
  const companyId = `msp-${inn}`;
  const at = retrievedAt.toISOString();
  const source = {
    system: MSP_SYSTEM,
    url: MSP_CARD_URL,
    ...(record.ogrn ? { recordId: record.ogrn } : {}),
    retrievedAt: at,
    isModel: false,
  };
  const facts: Fact[] = [];
  const add = (suffix: string, key: string, value: Fact["value"]): void => {
    // Реестр отдаёт текущий срез: дата, на которую значение верно, — момент запроса.
    facts.push({ id: `${companyId}.${suffix}`, companyId, key, value, kind: "official", source, observedAt: at });
  };

  if (isNonEmpty(record.okved1)) add("okved", "activity.okved_main", record.okved1.trim());
  if (isNonEmpty(record.regioncode)) add("region", "location.region_code", record.regioncode.trim().padStart(2, "0"));
  const category = record.category === undefined ? undefined : CATEGORY[record.category];
  if (category) add("msp", "scale.msp_category", category);
  if (typeof record.od2_sschr === "number" && Number.isFinite(record.od2_sschr) && record.od2_sschr >= 0) {
    add("headcount", "employment.headcount", record.od2_sschr);
    // K-06a: has_employees = true только при численности ≥ 1; из нуля false не выводится.
    if (record.od2_sschr >= 1) {
      facts.push({
        id: `${companyId}.employees`,
        companyId,
        key: "employment.has_employees",
        value: true,
        kind: "derived",
        source: { system: "rules", retrievedAt: at, isModel: false },
        observedAt: at,
        derivedFrom: [`${companyId}.headcount`],
      });
    }
  }
  if (record.has_licenses === 0 || record.has_licenses === 1)
    add("licenses", "licenses.has_any", record.has_licenses === 1);

  return {
    contractVersion: 1,
    companyId,
    inn,
    entityType: inn.length === 12 ? "individual_entrepreneur" : "legal_entity",
    ...(isNonEmpty(record.name_ex) ? { displayName: record.name_ex.trim() } : {}),
    facts,
    isModel: false,
    updatedAt: at,
  };
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
