/** Стабильный каталог ошибок приложения. Коды подходят для API, метрик и поддержки. */
export const ERROR_DEFINITIONS = {
  INVALID_INPUT: {
    httpStatus: 400,
    retryable: false,
    message: "Проверьте введённые данные и попробуйте ещё раз.",
  },
  UNAUTHENTICATED: {
    httpStatus: 401,
    retryable: false,
    message: "Не удалось подтвердить пользователя. Откройте сервис из MAX и попробуйте ещё раз.",
  },
  FORBIDDEN: {
    httpStatus: 403,
    retryable: false,
    message: "У вас нет доступа к этому действию.",
  },
  NOT_FOUND: {
    httpStatus: 404,
    retryable: false,
    message: "Запрошенные данные не найдены.",
  },
  CONFLICT: {
    httpStatus: 409,
    retryable: false,
    message: "Данные уже изменились. Обновите страницу и повторите действие.",
  },
  RATE_LIMITED: {
    httpStatus: 429,
    retryable: true,
    message: "Слишком много запросов. Подождите немного и попробуйте ещё раз.",
  },
  DEPENDENCY_UNAVAILABLE: {
    httpStatus: 503,
    retryable: true,
    message: "Внешний сервис временно недоступен. Попробуйте позже.",
  },
  DEPENDENCY_TIMEOUT: {
    httpStatus: 504,
    retryable: true,
    message: "Внешний сервис не успел ответить. Попробуйте позже.",
  },
  CONFIGURATION_ERROR: {
    httpStatus: 500,
    retryable: false,
    message: "Сервис временно не готов к работе. Мы уже знаем о проблеме.",
  },
  INTERNAL_ERROR: {
    httpStatus: 500,
    retryable: false,
    message: "Что-то пошло не так. Попробуйте позже.",
  },
} as const;

export type ErrorCode = keyof typeof ERROR_DEFINITIONS;

export interface PublicError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;

  constructor(code: ErrorCode, options: ErrorOptions = {}) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message, options);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = definition.httpStatus;
    this.retryable = definition.retryable;
  }
}

/** Возвращает только безопасный пользовательский текст; внутреннее сообщение исключения наружу не передаётся. */
export function toPublicError(error: unknown): PublicError {
  const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
  const definition = ERROR_DEFINITIONS[code];
  return { code, message: definition.message, retryable: definition.retryable };
}

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_DEFINITIONS, value);
}
