import type { Notification, NotificationButton } from "@max-hackathon/domain";
import type { MaxApiTransport } from "../queue/max-transport.js";
import { DELIVERY_UNKNOWN, type MessageSender, type SendFailure, type SendResult } from "../queue/sender.js";

export const MAX_MESSAGE_TEXT_LIMIT = 4_000;
export const MAX_BUTTONS = 210;
export const MAX_KEYBOARD_ROWS = 30;
export const MAX_CALLBACK_BUTTONS_PER_ROW = 7;
export const MAX_LARGE_BUTTONS_PER_ROW = 3;

const MAX_BUTTON_TEXT_LIMIT = 128;
const MAX_CALLBACK_PAYLOAD_LIMIT = 1_024;
const MAX_LINK_URL_LIMIT = 2_048;
const DEFAULT_TIMEOUT_MS = 40_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 300_000;

export interface MaxMessageSenderOptions {
  /**
   * Общий rate-limited транспорт MAX Bot API (sender/queue/max-transport.ts): токен, базовый URL и HTTP
   * находятся только в нём, поэтому отправка делит квоту 30 rps с upload- и service-клиентами.
   */
  transport: MaxApiTransport;
  timeoutMs?: number;
  maxRetryAfterMs?: number;
  now?: () => number;
}

interface MaxCallbackButton {
  type: "callback";
  text: string;
  payload: string;
}

interface MaxLinkButton {
  type: "link";
  text: string;
  url: string;
}

type MaxButton = MaxCallbackButton | MaxLinkButton;

interface MaxMessageBody {
  text: string;
  attachments?: Array<{
    type: "inline_keyboard";
    payload: { buttons: MaxButton[][] };
  }>;
}

/**
 * Отправитель уведомлений через MAX Bot API.
 *
 * Клиент не логирует токен, chatId, текст и тело ответа платформы. Ошибки всегда
 * возвращаются как SendFailure, чтобы очередь могла безопасно принять решение о повторе.
 */
export class MaxMessageSender implements MessageSender {
  private readonly transport: MaxApiTransport;
  private readonly timeoutMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly now: () => number;

  constructor(options: MaxMessageSenderOptions) {
    this.transport = options.transport;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxRetryAfterMs = positiveInteger(options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS, "maxRetryAfterMs");
    this.now = options.now ?? Date.now;
  }

  async send(notification: Notification): Promise<SendResult> {
    const invalid = validateNotification(notification);
    if (invalid) return failure("INVALID_INPUT", false, invalid);

    let response: Response;
    try {
      // Токен добавляет транспорт в заголовок Authorization; в URL он не попадает.
      response = await this.transport.send({
        path: `messages?chat_id=${encodeURIComponent(notification.recipient.chatId)}`,
        init: {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(buildMessageBody(notification)),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      });
    } catch (error) {
      // После передачи запроса транспорт не позволяет надёжно отличить сбой до отправки
      // от сбоя после приёма MAX. Повтор мог бы создать дубликат.
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return failure(
        DELIVERY_UNKNOWN,
        false,
        timeout ? "Исход отправки MAX неизвестен: таймаут" : "Исход отправки MAX неизвестен: ошибка транспорта",
      );
    }

    if (response.ok) {
      await discardBody(response);
      return { ok: true };
    }

    const retryAfterMs =
      response.status === 429
        ? parseRetryAfter(response.headers.get("retry-after"), this.now(), this.maxRetryAfterMs)
        : undefined;
    const result = failureForStatus(response.status, retryAfterMs);
    await discardBody(response);
    return result;
  }
}

export function buildMessageBody(notification: Notification): MaxMessageBody {
  const buttons = notification.buttons?.map(toMaxButton) ?? [];
  if (buttons.length === 0) return { text: notification.text };

  const rows: MaxButton[][] = [];
  let row: MaxButton[] = [];
  let rowLimit = MAX_CALLBACK_BUTTONS_PER_ROW;
  for (const button of buttons) {
    const buttonLimit = button.type === "link" ? MAX_LARGE_BUTTONS_PER_ROW : MAX_CALLBACK_BUTTONS_PER_ROW;
    const nextLimit = Math.min(rowLimit, buttonLimit);
    if (row.length >= nextLimit) {
      rows.push(row);
      row = [];
      rowLimit = MAX_CALLBACK_BUTTONS_PER_ROW;
    }
    row.push(button);
    rowLimit = Math.min(rowLimit, buttonLimit);
  }
  if (row.length > 0) rows.push(row);

  return {
    text: notification.text,
    attachments: [{ type: "inline_keyboard", payload: { buttons: rows } }],
  };
}

/** Retry-After в секундах или как HTTP-date; результат ограничен безопасным максимумом. */
export function parseRetryAfter(
  value: string | null,
  nowMs: number,
  maxMs = DEFAULT_MAX_RETRY_AFTER_MS,
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(maxMs, Math.round(seconds * 1_000));
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.min(maxMs, Math.max(0, date - nowMs));
}

function validateNotification(notification: Notification): string | undefined {
  if (notification.recipient.channel !== "max_bot") return "Неподдерживаемый канал получателя";
  if (!/^-?\d+$/.test(notification.recipient.chatId)) return "chatId должен быть целым числом";
  const textLength = unicodeLength(notification.text);
  if (textLength < 1 || textLength > MAX_MESSAGE_TEXT_LIMIT) {
    return `Текст должен содержать от 1 до ${MAX_MESSAGE_TEXT_LIMIT} символов`;
  }

  const buttons = notification.buttons ?? [];
  if (buttons.length > MAX_BUTTONS) return `Клавиатура содержит больше ${MAX_BUTTONS} кнопок`;
  for (const button of buttons) {
    const invalid = validateButton(button);
    if (invalid) return invalid;
  }

  // Проверяем фактическую раскладку, включая лимит 3 для link-кнопок.
  const rows = buildMessageBody(notification).attachments?.[0]?.payload.buttons ?? [];
  if (rows.length > MAX_KEYBOARD_ROWS) return `Клавиатура содержит больше ${MAX_KEYBOARD_ROWS} рядов`;
  return undefined;
}

function validateButton(button: NotificationButton): string | undefined {
  const textLength = unicodeLength(button.text);
  if (textLength < 1 || textLength > MAX_BUTTON_TEXT_LIMIT) {
    return `Текст кнопки должен содержать от 1 до ${MAX_BUTTON_TEXT_LIMIT} символов`;
  }
  if ("payload" in button) {
    if (unicodeLength(button.payload) > MAX_CALLBACK_PAYLOAD_LIMIT) {
      return `Payload кнопки длиннее ${MAX_CALLBACK_PAYLOAD_LIMIT} символов`;
    }
    return undefined;
  }
  if (unicodeLength(button.url) > MAX_LINK_URL_LIMIT) return `URL кнопки длиннее ${MAX_LINK_URL_LIMIT} символов`;
  try {
    const url = new URL(button.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "URL кнопки должен использовать HTTP(S)";
  } catch {
    return "URL кнопки некорректен";
  }
  return undefined;
}

function toMaxButton(button: NotificationButton): MaxButton {
  return "payload" in button
    ? { type: "callback", text: button.text, payload: button.payload }
    : { type: "link", text: button.text, url: button.url };
}

function failureForStatus(status: number, retryAfterMs?: number): SendFailure {
  const message = `MAX API вернул HTTP ${status}`;
  if (status === 400 || status === 405 || status === 422) return failure("INVALID_INPUT", false, message);
  if (status === 401) return failure("UNAUTHENTICATED", false, message);
  if (status === 403) return failure("FORBIDDEN", false, message);
  if (status === 404) return failure("NOT_FOUND", false, message);
  if (status === 408 || status === 504) return failure("DEPENDENCY_TIMEOUT", true, message);
  if (status === 409) return failure("CONFLICT", false, message);
  if (status === 429) return failure("RATE_LIMITED", true, message, retryAfterMs);
  if (status >= 500) return failure("DEPENDENCY_UNAVAILABLE", true, message);
  if (status >= 400) return failure("INVALID_INPUT", false, message);
  return failure("INTERNAL_ERROR", false, message);
}

function failure(code: string, retryable: boolean, message: string, retryAfterMs?: number): SendFailure {
  return {
    ok: false,
    code,
    retryable,
    message,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} должен быть положительным целым числом`);
  return value;
}

const unicodeLength = (value: string): number => [...value].length;
