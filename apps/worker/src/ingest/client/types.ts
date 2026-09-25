// Типы клиента regulation.gov.ru. Это сырой проект акта с портала, а не ChangeEvent из contracts/v1:
// преобразование и отбор делают K-18b и K-18c.

/** Проект нормативного акта в том виде, в каком его удалось прочитать с портала. */
export interface NpaProject {
  /** Идентификатор проекта на портале (строкой: формат не гарантирован). */
  id: string;
  /** Ссылка на карточку проекта. */
  url: string;
  title?: string;
  /** Ведомство-разработчик. */
  department?: string;
  /** Дата публикации или создания, как пришла от портала (ISO или дд.мм.гггг). */
  publishedAt?: string;
  /** Стадия или процедура, текстом. */
  stage?: string;
  /**
   * Идентификаторы сфер портала (поле `okveds`). Это 60 укрупнённых сфер, **не коды ОКВЭД**
   * (ADR-0006, contracts/README.md).
   */
  sphereIds: number[];
}

export interface FetchPage {
  items: NpaProject[];
  /** Сколько записей пропущено: без идентификатора или неразборчивых. */
  skipped: number;
}

export interface FilteredQuery {
  /** Сферы портала; несколько — объединяются по «ИЛИ». */
  sphereIds?: number[];
  /** Подстрока заголовка. */
  titleContains?: string;
  /** Размер страницы, не больше 500. */
  pageSize?: number;
  /** Ограничение числа страниц, чтобы выборка не шла бесконечно. */
  maxPages?: number;
}

/** Совместимо с глобальным fetch; в тестах подменяется модельным. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Коды совпадают с каталогом ошибок K-27 (`@max-hackathon/observability`). */
export type RegulationErrorCode =
  | "INVALID_INPUT"
  | "RATE_LIMITED"
  | "DEPENDENCY_UNAVAILABLE"
  | "DEPENDENCY_TIMEOUT"
  | "INTERNAL_ERROR";

export class RegulationClientError extends Error {
  readonly code: RegulationErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(code: RegulationErrorCode, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "RegulationClientError";
    this.code = code;
    this.status = options.status;
    this.retryable = code === "RATE_LIMITED" || code === "DEPENDENCY_UNAVAILABLE" || code === "DEPENDENCY_TIMEOUT";
  }
}
