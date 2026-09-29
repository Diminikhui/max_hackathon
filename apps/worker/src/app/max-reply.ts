// K-30b. Ответы диалога в MAX через общий rate-limited транспорт (K-21b): новое сообщение или замена нажатого.
import { type BotReplyPort, buildReplyBody } from "@max-hackathon/bot/dist/app/index.js";
import type { MaxApiTransport } from "../sender/queue/index.js";

export interface MaxReplyLogger {
  warn(event: string, message: string, context?: Readonly<Record<string, unknown>>): void;
}

const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/json" };
const TIMEOUT_MS = 15_000;

const discard = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Тело ответа не нужно.
  }
};

/**
 * `send` — `POST /messages?chat_id=…`. `answer` — `POST /answers?callback_id=…` с `message`: MAX заменяет нажатое
 * сообщение новым экраном (схема `CallbackAnswer`, github.com/max-messenger/api-schema). В лог не пишутся ни текст,
 * ни идентификаторы чата и callback.
 */
export const createMaxReplyPort = (transport: MaxApiTransport, logger: MaxReplyLogger): BotReplyPort => ({
  async send(chatId, reply) {
    const response = await transport.send({
      path: `messages?chat_id=${encodeURIComponent(chatId)}`,
      init: {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(buildReplyBody(reply)),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    });
    if (!response.ok) logger.warn("bot.reply.send_failed", "MAX rejected a dialog reply", { status: response.status });
    await discard(response);
  },

  async answer(callbackId, reply) {
    const response = await transport.service({
      path: `answers?callback_id=${encodeURIComponent(callbackId)}`,
      init: {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ message: buildReplyBody(reply) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    });
    if (!response.ok)
      logger.warn("bot.reply.answer_rejected", "MAX rejected a callback answer", { status: response.status });
    await discard(response);
    return response.ok;
  },
});
