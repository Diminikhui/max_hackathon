import type { DialogEvent } from "../dialog/index.js";

/**
 * Внутреннее событие бота: то, что осталось от update MAX после проверки и нормализации.
 * Идентификаторы MAX (int64) хранятся строками, чтобы не терять точность за пределами 2^53.
 */
export type InboundEvent =
  | {
      readonly kind: "started";
      readonly eventId: string;
      readonly chatId: string;
      readonly userId: string;
      /** Payload deep link `?start=…`, если бот открыт по ссылке. */
      readonly startPayload?: string;
      readonly occurredAt: string;
    }
  | {
      readonly kind: "text";
      readonly eventId: string;
      readonly chatId: string;
      readonly userId: string;
      readonly text: string;
      readonly occurredAt: string;
    }
  | {
      readonly kind: "callback";
      readonly eventId: string;
      readonly chatId: string;
      readonly userId: string;
      /** Нужен, чтобы ответить на нажатие через `POST /answers`. */
      readonly callbackId: string;
      readonly payload: string;
      /** Сообщение, в котором нажата кнопка (`message.body.mid`): по нему отсекаются нажатия из устаревших сообщений. */
      readonly messageId?: string;
      readonly occurredAt: string;
    };

export type InboundEventKind = InboundEvent["kind"];

export const IGNORE_REASONS = [
  "not_an_object",
  "unsupported_update_type",
  "not_a_dialog",
  "from_bot",
  "empty_text",
  "missing_field",
] as const;

export type IgnoreReason = (typeof IGNORE_REASONS)[number];

export type NormalizeResult =
  | { readonly ok: true; readonly event: InboundEvent }
  | { readonly ok: false; readonly updateType: string; readonly reason: IgnoreReason };

/** Событие, переданное обработчику: исходное внутреннее событие и его перевод для машины диалога. */
export interface InboundDelivery {
  readonly event: InboundEvent;
  /** `undefined` — ввод не распознан (например, произвольный текст); как ответить, решает обработчик. */
  readonly dialogEvent: DialogEvent | undefined;
}

export type InboundHandler = (delivery: InboundDelivery) => Promise<void> | void;

/** Совместим с `Logger` из `@max-hackathon/observability`. */
export interface TransportLogger {
  info(event: string, message: string, context?: Readonly<Record<string, unknown>>): void;
  warn(event: string, message: string, context?: Readonly<Record<string, unknown>>): void;
  error(event: string, message: string, context?: Readonly<Record<string, unknown>>): void;
}
