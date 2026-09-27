// Composition root отправки в MAX (3-05, #247): один RateLimitedMaxTransport на MAX token, общий для
// отправки сообщений, загрузок и служебных запросов, и воркер очереди поверх честной выборки хранилища.
// Переменные окружения здесь не читаются: конфигурацию передаёт точка входа процесса (K-30a).

import { createHash } from "node:crypto";
import { MaxServiceClient, MaxUploadClient } from "./max-clients.js";
import { type MaxFetch, RateLimitedMaxTransport } from "./max-transport.js";
import type { TokenBucketOptions } from "./rate-limiter.js";
import { MaxMessageSender } from "./sender.js";
import { type SendQueueRepository, SendQueueWorker, type SendQueueWorkerOptions } from "./worker.js";

export interface MaxTransportConfig {
  token: string;
  baseUrl: string;
  fetch?: MaxFetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  budget?: TokenBucketOptions;
}

/**
 * Реестр транспортов процесса: второй запрос того же token возвращает уже созданный экземпляр, поэтому
 * две сборки не могут разделить лимит 30 rps на два независимых bucket. Ключ — хеш token, не сам token.
 */
export class MaxTransportRegistry {
  private readonly transports = new Map<string, { transport: RateLimitedMaxTransport; baseUrl: string }>();

  forToken(config: MaxTransportConfig): RateLimitedMaxTransport {
    if (config.token.trim() === "") throw new Error("MAX token не задан");
    const key = createHash("sha256").update(config.token).digest("hex");
    const existing = this.transports.get(key);
    if (existing) {
      if (existing.baseUrl !== config.baseUrl)
        throw new Error("Для одного MAX token уже создан transport с другим baseUrl");
      return existing.transport;
    }
    const transport = new RateLimitedMaxTransport(config);
    this.transports.set(key, { transport, baseUrl: config.baseUrl });
    return transport;
  }

  size(): number {
    return this.transports.size;
  }
}

/** Реестр по умолчанию — один на процесс. */
export const defaultMaxTransportRegistry = new MaxTransportRegistry();

export interface MaxSenderRuntimeOptions extends Omit<SendQueueWorkerOptions, "repository" | "sender" | "now"> {
  max: MaxTransportConfig;
  /** Хранилище с честной выборкой, например PostgresNotificationRepository из @max-hackathon/storage. */
  repository: SendQueueRepository;
  now?: () => number;
  registry?: MaxTransportRegistry;
}

export interface MaxSenderRuntime {
  transport: RateLimitedMaxTransport;
  sender: MaxMessageSender;
  upload: MaxUploadClient;
  service: MaxServiceClient;
  worker: SendQueueWorker;
}

export const createMaxSenderRuntime = (options: MaxSenderRuntimeOptions): MaxSenderRuntime => {
  const { max, repository, registry = defaultMaxTransportRegistry, now = Date.now, ...workerOptions } = options;
  const transport = registry.forToken({ now, ...max });
  const sender = new MaxMessageSender(transport);
  return {
    transport,
    sender,
    upload: new MaxUploadClient(transport),
    service: new MaxServiceClient(transport),
    worker: new SendQueueWorker({ ...workerOptions, repository, sender, now }),
  };
};
