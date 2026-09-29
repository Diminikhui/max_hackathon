// Серверная проверка initData мини-приложения MAX (K-32b, перенос из spike K-05b).
// Алгоритм по https://dev.max.ru/docs/webapps/validation:
//   secret = HMAC-SHA256(key="WebAppData", data=BOT_TOKEN)
//   hash   = hex(HMAC-SHA256(key=secret, data=отсортированные "k=v" через "\n", без hash))
// Доверять можно только результату этой проверки; initDataUnsafe на клиенте — лишь для отображения.
import { createHmac, timingSafeEqual } from "node:crypto";

/** Срок жизни initData для входа: MAX рекомендует не больше часа. */
export const DEFAULT_INIT_DATA_MAX_AGE_SEC = 3600;
/** Допуск расхождения часов клиента и сервера для auth_date «из будущего». */
export const INIT_DATA_CLOCK_SKEW_SEC = 60;
/** initData реального запуска занимает около килобайта; длиннее — мусор или попытка нагрузить разбор. */
export const INIT_DATA_MAX_LENGTH = 8192;

export type InitDataErrorCode =
  | "empty"
  | "too_long"
  | "malformed"
  | "duplicate"
  | "no_hash"
  | "bad_hash"
  | "no_auth_date"
  | "expired"
  | "from_future"
  | "no_user"
  | "bad_start_param";

/** Ошибка проверки. Сообщение не содержит значений из initData и безопасно для логов. */
export class InitDataError extends Error {
  readonly code: InitDataErrorCode;

  constructor(code: InitDataErrorCode, message: string) {
    super(message);
    this.name = "InitDataError";
    this.code = code;
  }
}

/**
 * Минимизированный результат проверки. Имя, фамилия, username и фото пользователя сюда
 * намеренно не попадают: сервису для работы нужен только идентификатор.
 */
export interface VerifiedInitData {
  /** Идентификатор пользователя MAX. Для хранения и логов — только через `pseudonymize`. */
  maxUserId: number;
  /** Время подписи, секунды Unix. */
  authDate: number;
  startParam?: string;
  chat?: { id: number; type?: string };
  languageCode?: string;
  queryId?: string;
}

export interface VerifyInitDataOptions {
  /** Максимальный возраст auth_date в секундах; 0 отключает проверку (только для тестов). */
  maxAgeSec?: number;
  /** Текущее время в мс. */
  now?: number;
}

// start_param: до 512 символов, только A-Z a-z 0-9 _ - (https://dev.max.ru/docs/webapps/introduction).
const START_PARAM_RE = /^[A-Za-z0-9_-]{1,512}$/;
// ИНН (10 или 12 цифр), ОГРН, телефон и другие длинные номера в deep link не передаются.
const LONG_NUMBER_RE = /\d{10,}/;

export function isValidStartParam(value: unknown): value is string {
  return typeof value === "string" && START_PARAM_RE.test(value);
}

/**
 * Формат start_param верен и в нём нет длинных номеров. Deep link видят MAX, история чата
 * и пересылки, поэтому ИНН и другие идентификаторы в него не кладутся: передавайте
 * непрозрачный токен и сопоставляйте его на сервере.
 */
export function isSafeStartParam(value: unknown): value is string {
  return isValidStartParam(value) && !LONG_NUMBER_RE.test(value);
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, "%20"));
  } catch {
    throw new InitDataError("malformed", "Некорректное кодирование в initData");
  }
}

function parsePairs(initData: unknown): Map<string, string> {
  if (typeof initData !== "string" || initData.length === 0) {
    throw new InitDataError("empty", "initData пуст");
  }
  if (initData.length > INIT_DATA_MAX_LENGTH) {
    throw new InitDataError("too_long", "initData слишком длинный");
  }
  const fields = new Map<string, string>();
  for (const part of initData.split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) throw new InitDataError("malformed", "Некорректная пара в initData");
    const key = decode(part.slice(0, eq));
    // Каждый параметр должен встречаться ровно один раз.
    if (fields.has(key)) throw new InitDataError("duplicate", "Повтор параметра в initData");
    fields.set(key, decode(part.slice(eq + 1)));
  }
  return fields;
}

function computeHash(fields: ReadonlyMap<string, string>, botToken: string): string {
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const dataCheckString = [...fields.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  return createHmac("sha256", secret).update(dataCheckString).digest("hex");
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Проверяет подпись, срок и состав initData и возвращает только нужные сервису поля.
 * Бросает `InitDataError`; ответ клиенту при любой ошибке — одинаковый 401 без кода причины.
 */
export function verifyInitData(
  initData: unknown,
  botToken: string,
  { maxAgeSec = DEFAULT_INIT_DATA_MAX_AGE_SEC, now = Date.now() }: VerifyInitDataOptions = {},
): VerifiedInitData {
  if (!botToken) throw new Error("MAX_BOT_TOKEN не задан");
  const fields = parsePairs(initData);
  const hash = fields.get("hash");
  if (!hash) throw new InitDataError("no_hash", "В initData нет hash");

  const expected = Buffer.from(computeHash(fields, botToken), "hex");
  const actual = Buffer.from(hash, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new InitDataError("bad_hash", "Подпись initData не совпала");
  }

  const authDate = Number(fields.get("auth_date"));
  if (!Number.isSafeInteger(authDate) || authDate <= 0) {
    throw new InitDataError("no_auth_date", "В initData нет auth_date");
  }
  const ageSec = now / 1000 - authDate;
  if (ageSec < -INIT_DATA_CLOCK_SKEW_SEC) {
    throw new InitDataError("from_future", "auth_date в initData из будущего");
  }
  if (maxAgeSec > 0 && ageSec > maxAgeSec) {
    throw new InitDataError("expired", "initData устарел");
  }

  const maxUserId = positiveInteger(parseJsonObject(fields.get("user"))?.id);
  if (maxUserId === undefined) throw new InitDataError("no_user", "В initData нет пользователя");

  const startParam = fields.get("start_param");
  if (startParam !== undefined && !isValidStartParam(startParam)) {
    throw new InitDataError("bad_start_param", "Некорректный start_param");
  }

  const user = parseJsonObject(fields.get("user"));
  const languageCode = typeof user?.language_code === "string" ? user.language_code : undefined;
  const chatObject = parseJsonObject(fields.get("chat"));
  // Идентификатор группового чата может быть отрицательным.
  const chatId = Number.isSafeInteger(chatObject?.id) ? (chatObject?.id as number) : undefined;
  const queryId = fields.get("query_id");

  return {
    maxUserId,
    authDate,
    ...(startParam !== undefined ? { startParam } : {}),
    ...(chatId !== undefined
      ? { chat: { id: chatId, ...(typeof chatObject?.type === "string" ? { type: chatObject.type } : {}) } }
      : {}),
    ...(languageCode !== undefined ? { languageCode } : {}),
    ...(queryId !== undefined ? { queryId } : {}),
  };
}

/** Подписывает поля так же, как MAX. Только для модельных тестов и локальной проверки. */
export function signInitDataForTest(fields: Readonly<Record<string, string>>, botToken: string): string {
  const hash = computeHash(new Map(Object.entries(fields)), botToken);
  return new URLSearchParams({ ...fields, hash }).toString();
}
