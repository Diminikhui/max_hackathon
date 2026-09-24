export const REDACTED = "[REDACTED]";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogContext = Readonly<Record<string, unknown>>;

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  event: string;
  message: string;
  context: Record<string, unknown>;
}

export type LogSink = (record: Readonly<LogRecord>) => void;

const SENSITIVE_KEY =
  /(?:^|_)(?:authorization|cookie|password|passwd|secret|token|api_?key|init_?data|inn|ogrn|snils|email|phone|address|full_?name|first_?name|last_?name|user_?id|chat_?id)(?:$|_)/i;
const EMAIL = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/gu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const RUSSIAN_PHONE = /(?<!\d)(?:\+7|8)[\s()-]*\d{3}[\s()-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/gu;
const LEGAL_IDENTIFIER = /(?<!\d)\d{10,15}(?!\d)/gu;
const SECRET_QUERY = /([?&](?:token|access_token|api_key|secret|password)=)[^&#\s]*/giu;

function sanitizeString(value: string): string {
  return value
    .replace(EMAIL, REDACTED)
    .replace(BEARER, REDACTED)
    .replace(JWT, REDACTED)
    .replace(RUSSIAN_PHONE, REDACTED)
    .replace(LEGAL_IDENTIFIER, REDACTED)
    .replace(SECRET_QUERY, `$1${REDACTED}`);
}

function sanitizeValue(value: unknown, key: string | undefined, seen: WeakSet<object>, depth: number): unknown {
  if (key && SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return "[MAX_DEPTH]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: sanitizeString(value.name),
      message: sanitizeString(value.message),
      ...(Reflect.has(value, "code") ? { code: sanitizeString(String(Reflect.get(value, "code"))) } : {}),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, undefined, seen, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    result[childKey] = sanitizeValue(childValue, childKey, seen, depth + 1);
  }
  return result;
}

/** Создаёт копию контекста, в которой известные ПДн и секреты заменены маркером. */
export function sanitizeLogContext(context: LogContext): Record<string, unknown> {
  return sanitizeValue(context, undefined, new WeakSet(), 0) as Record<string, unknown>;
}

export interface Logger {
  debug(event: string, message: string, context?: LogContext): void;
  info(event: string, message: string, context?: LogContext): void;
  warn(event: string, message: string, context?: LogContext): void;
  error(event: string, message: string, context?: LogContext): void;
}

/** Структурный logger с обязательной очисткой сообщения и контекста до вызова sink. */
export function createLogger(sink: LogSink, now: () => Date = () => new Date()): Logger {
  const write = (level: LogLevel, event: string, message: string, context: LogContext = {}): void => {
    sink({
      timestamp: now().toISOString(),
      level,
      event: sanitizeString(event),
      message: sanitizeString(message),
      context: sanitizeLogContext(context),
    });
  };
  return {
    debug: (event, message, context) => write("debug", event, message, context),
    info: (event, message, context) => write("info", event, message, context),
    warn: (event, message, context) => write("warn", event, message, context),
    error: (event, message, context) => write("error", event, message, context),
  };
}

/** Sink для JSON Lines. Передавайте stderr/stdout приложения; сам пакет не пишет в консоль. */
export function createJsonLogSink(write: (line: string) => void): LogSink {
  return (record) => write(JSON.stringify(record));
}
