import type { InboundEvent, NormalizeResult } from "./types.js";

// Поля update MAX (OpenAPI schema_2026_07_01): Update, MessageCreatedUpdate, MessageCallbackUpdate, BotStartedUpdate.
// Update пришёл из сети, поэтому каждое поле проверяется, а не приводится типом.

const ID_KEYS = new Set(["chat_id", "user_id"]);

/**
 * Разбирает тело webhook. Идентификаторы `chat_id` и `user_id` — int64: `JSON.parse` превратил бы значения больше
 * 2^53 в неточные числа, поэтому они берутся из исходного текста и сохраняются строками.
 */
export const parseMaxUpdateJson = (body: string): unknown =>
  JSON.parse(body, (key: string, value: unknown, context?: { source?: string }) =>
    ID_KEYS.has(key) && typeof value === "number" && context?.source !== undefined ? context.source : value,
  );

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const field = (value: unknown, key: string): unknown => (isObject(value) ? value[key] : undefined);

const idOf = (value: unknown): string | undefined => {
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
};

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const timeOf = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : undefined;

const ok = (event: InboundEvent): NormalizeResult => ({ ok: true, event });

const ignore = (updateType: string, reason: Extract<NormalizeResult, { ok: false }>["reason"]): NormalizeResult => ({
  ok: false,
  updateType,
  reason,
});

/** Переводит update MAX во внутреннее событие. Всё, что бот не обрабатывает, возвращается с причиной пропуска. */
export const normalizeMaxUpdate = (update: unknown): NormalizeResult => {
  if (!isObject(update)) return ignore("unknown", "not_an_object");

  const updateType = typeof update.update_type === "string" ? update.update_type : "unknown";
  const occurredAt = timeOf(update.timestamp);

  switch (updateType) {
    case "bot_started": {
      const chatId = idOf(update.chat_id);
      const userId = idOf(field(update.user, "user_id"));
      if (chatId === undefined || userId === undefined || occurredAt === undefined) {
        return ignore(updateType, "missing_field");
      }
      const startPayload = stringOf(update.payload);
      return ok({
        kind: "started",
        // У bot_started нет собственного id: повтор webhook приходит с тем же timestamp.
        eventId: `started:${chatId}:${String(update.timestamp)}`,
        chatId,
        userId,
        ...(startPayload === undefined ? {} : { startPayload }),
        occurredAt,
      });
    }

    case "message_created": {
      const message = update.message;
      const recipient = field(message, "recipient");
      if (field(recipient, "chat_type") !== "dialog") return ignore(updateType, "not_a_dialog");
      if (field(field(message, "sender"), "is_bot") === true) return ignore(updateType, "from_bot");

      const chatId = idOf(field(recipient, "chat_id"));
      const userId = idOf(field(field(message, "sender"), "user_id"));
      const mid = stringOf(field(field(message, "body"), "mid"));
      if (chatId === undefined || userId === undefined || mid === undefined || occurredAt === undefined) {
        return ignore(updateType, "missing_field");
      }

      const rawText = field(field(message, "body"), "text");
      const text = typeof rawText === "string" ? rawText.trim() : "";
      // Стикеры, файлы и геолокация приходят без текста: сценарию бота нечего с ними делать.
      if (text.length === 0) return ignore(updateType, "empty_text");

      return ok({ kind: "text", eventId: `message:${mid}`, chatId, userId, text, occurredAt });
    }

    case "message_callback": {
      const callback = update.callback;
      const recipient = field(update.message, "recipient");
      if (field(recipient, "chat_type") !== "dialog") return ignore(updateType, "not_a_dialog");

      const chatId = idOf(field(recipient, "chat_id"));
      const userId = idOf(field(field(callback, "user"), "user_id"));
      const callbackId = stringOf(field(callback, "callback_id"));
      const payload = field(callback, "payload");
      if (
        chatId === undefined ||
        userId === undefined ||
        callbackId === undefined ||
        typeof payload !== "string" ||
        occurredAt === undefined
      ) {
        return ignore(updateType, "missing_field");
      }

      const messageId = stringOf(field(field(update.message, "body"), "mid"));
      return ok({
        kind: "callback",
        eventId: `callback:${callbackId}`,
        chatId,
        userId,
        callbackId,
        payload,
        ...(messageId === undefined ? {} : { messageId }),
        occurredAt,
      });
    }

    default:
      return ignore(updateType, "unsupported_update_type");
  }
};
