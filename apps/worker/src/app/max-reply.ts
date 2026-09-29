// K-30b. Ответы диалога в MAX через общий rate-limited транспорт (K-21b).
// Правило чата: кнопки активны только у последнего сообщения бота. Каждый ответ уходит новым сообщением внизу
// (`POST /messages`), у предыдущего кнопки снимаются (`PUT /messages`), нажатие подтверждается (`POST /answers`).
import type { BotReplyPort, SentMessage } from "@max-hackathon/bot/dist/app/index.js";
import { buildReplyBody } from "@max-hackathon/bot/dist/app/index.js";
import type { MaxApiTransport } from "../sender/queue/index.js";

export interface MaxReplyLogger {
  warn(event: string, message: string, context?: Readonly<Record<string, unknown>>): void;
}

const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/json" };
const TIMEOUT_MS = 15_000;

/** Идентификатор сообщения из ответа `POST /messages`: `{ message: { body: { mid } } }` (схема `SendMessageResult`). */
export const messageIdFrom = (payload: unknown): string | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const message = (payload as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return undefined;
  const body = (message as { body?: unknown }).body;
  if (typeof body !== "object" || body === null) return undefined;
  const mid = (body as { mid?: unknown }).mid;
  return typeof mid === "string" && mid !== "" ? mid : undefined;
};

const discard = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Тело ответа не нужно.
  }
};

/** В лог не пишутся ни текст, ни идентификаторы чата, сообщения и callback. */
export const createMaxReplyPort = (transport: MaxApiTransport, logger: MaxReplyLogger): BotReplyPort => ({
  async send(chatId, reply): Promise<SentMessage | undefined> {
    const response = await transport.send({
      path: `messages?chat_id=${encodeURIComponent(chatId)}`,
      init: {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(buildReplyBody(reply)),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    });
    if (!response.ok) {
      logger.warn("bot.reply.send_failed", "MAX rejected a dialog reply", { status: response.status });
      await discard(response);
      return undefined;
    }
    const messageId = messageIdFrom(await response.json().catch(() => undefined));
    return messageId === undefined ? undefined : { messageId, text: reply.text };
  },

  async clearKeyboard(_chatId, message) {
    const response = await transport.service({
      path: `messages?message_id=${encodeURIComponent(message.messageId)}`,
      init: {
        method: "PUT",
        headers: JSON_HEADERS,
        // Пустой список вложений убирает клавиатуру; текст передаётся тем же, чтобы он не изменился.
        body: JSON.stringify({ text: message.text, attachments: [] }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    });
    if (!response.ok) {
      logger.warn("bot.reply.clear_keyboard_rejected", "MAX rejected removal of buttons", { status: response.status });
    }
    await discard(response);
  },

  async acknowledge(callbackId) {
    const response = await transport.service({
      path: `answers?callback_id=${encodeURIComponent(callbackId)}`,
      init: {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    });
    if (!response.ok)
      logger.warn("bot.reply.acknowledge_rejected", "MAX rejected a callback answer", { status: response.status });
    await discard(response);
  },
});
