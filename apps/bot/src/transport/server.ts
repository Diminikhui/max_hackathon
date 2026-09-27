import { createServer, type Server } from "node:http";
import type { MaxWebhookHandler } from "./webhook.js";

export interface BotHttpServerOptions {
  readonly webhook: MaxWebhookHandler;
  /** Путь, на который nginx проксирует webhook MAX (K-08: `/webhook`). */
  readonly webhookPath?: string;
}

/**
 * HTTP-сервер бота: `POST <webhookPath>` — webhook MAX, `GET /health` — проверка для мониторинга K-08.
 * TLS завершает nginx, поэтому сервер слушает только локальный адрес (задаётся в `listen`).
 */
export const createBotHttpServer = ({ webhook, webhookPath = "/webhook" }: BotHttpServerOptions): Server =>
  createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ok");
      return;
    }
    if (path !== webhookPath) {
      res.writeHead(404).end();
      return;
    }
    webhook(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
