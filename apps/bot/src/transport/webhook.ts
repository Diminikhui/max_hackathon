import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { InboundDedup } from "./dedup.js";
import type { InboundDispatcher } from "./dispatcher.js";
import { normalizeMaxUpdate, parseMaxUpdateJson } from "./normalize.js";
import type { TransportLogger } from "./types.js";

/** Заголовок, в котором MAX передаёт secret, заданный при `POST /subscriptions`. */
export const MAX_SECRET_HEADER = "x-max-bot-api-secret";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
// Требование схемы MAX к secret подписки.
const SECRET_PATTERN = /^[A-Za-z0-9_-]{5,256}$/;

export interface MaxWebhookOptions {
  readonly secret: string;
  readonly dispatcher: InboundDispatcher;
  readonly dedup: InboundDedup;
  readonly logger: TransportLogger;
  readonly maxBodyBytes?: number;
}

export type MaxWebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

class BodyTooLargeError extends Error {}

const readBody = async (req: IncomingMessage, limit: number): Promise<string> => {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError();

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const reply = (res: ServerResponse, status: number): void => {
  if (!res.headersSent) res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(status === 200 ? "ok" : "");
};

/**
 * Приём webhook MAX. Отвечает 200 сразу после того, как событие принято в очередь: MAX ждёт ответ не дольше 30 с
 * и после 8 ч без успешных ответов снимает подписку, поэтому сценарий бота выполняется уже после ответа.
 *
 * Коды ответа: 200 — принято, пропущено или повтор; 400 — тело не JSON; 403 — неверный secret; 405 — не POST;
 * 413 — тело больше лимита; 503 — очередь переполнена (MAX повторит доставку позже).
 */
export const createMaxWebhookHandler = ({
  secret,
  dispatcher,
  dedup,
  logger,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
}: MaxWebhookOptions): MaxWebhookHandler => {
  if (!SECRET_PATTERN.test(secret)) {
    throw new Error("MAX webhook secret must be 5–256 characters of A-Z, a-z, 0-9, _ or -");
  }
  // Сравниваются хеши одинаковой длины: так время сравнения не выдаёт длину secret.
  const expected = digest(secret);

  return async (req, res) => {
    if (req.method !== "POST") {
      reply(res, 405);
      return;
    }

    const supplied = req.headers[MAX_SECRET_HEADER];
    if (typeof supplied !== "string" || !timingSafeEqual(expected, digest(supplied))) {
      logger.warn("bot.webhook.rejected", "Webhook request rejected: secret mismatch");
      reply(res, 403);
      return;
    }

    let update: unknown;
    try {
      update = parseMaxUpdateJson(await readBody(req, maxBodyBytes));
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        logger.warn("bot.webhook.too_large", "Webhook body exceeds limit", { maxBodyBytes });
        reply(res, 413);
        return;
      }
      logger.warn("bot.webhook.invalid_json", "Webhook body is not valid JSON");
      reply(res, 400);
      return;
    }

    const normalized = normalizeMaxUpdate(update);
    if (!normalized.ok) {
      logger.info("bot.webhook.ignored", "MAX update ignored", {
        updateType: normalized.updateType,
        reason: normalized.reason,
      });
      reply(res, 200);
      return;
    }

    const { event } = normalized;
    if (!dedup.claim(event.eventId)) {
      logger.info("bot.webhook.duplicate", "Duplicate MAX update skipped", { eventId: event.eventId });
      reply(res, 200);
      return;
    }

    if (!dispatcher.dispatch(event)) {
      dedup.release(event.eventId);
      reply(res, 503);
      return;
    }

    reply(res, 200);
  };
};
