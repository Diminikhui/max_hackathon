// Единая архитектурная граница для ВСЕХ исходящих запросов к MAX Bot API.
// Один экземпляр должен разделяться отправителем сообщений, загрузчиком медиа и служебным клиентом
// одной интеграции/токена. Так резерв общей квоты нельзя случайно потратить только на сообщения.

import { TokenBucket, type TokenBucketOptions } from "./rate-limiter.js";

export type MaxApiOperation = "send" | "upload" | "service";

export interface MaxApiTransport {
  request<T>(operation: MaxApiOperation, perform: () => Promise<T>): Promise<T>;
}

export interface RateLimitedMaxTransportOptions {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Безопасный общий бюджет. Значение по умолчанию 27 rps оставляет 10% от лимита 30 rps. */
  budget?: TokenBucketOptions;
}

export const DEFAULT_MAX_API_BUDGET: Readonly<TokenBucketOptions> = Object.freeze({
  capacity: 1,
  refillPerSecond: 27,
});

/**
 * Общий rate-limited transport для одного MAX token/integration.
 * Все адаптеры обязаны получать один и тот же экземпляр через composition root.
 */
export class RateLimitedMaxTransport implements MaxApiTransport {
  private readonly bucket: TokenBucket;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: RateLimitedMaxTransportOptions = {}) {
    this.bucket = new TokenBucket(options.budget ?? DEFAULT_MAX_API_BUDGET);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  request<T>(_operation: MaxApiOperation, perform: () => Promise<T>): Promise<T> {
    // Сериализация резервирования не даёт параллельным клиентам взять один токен одновременно.
    const turn = this.tail.then(async () => {
      let wait = this.bucket.take(this.now());
      while (wait > 0) {
        await this.sleep(wait);
        wait = this.bucket.take(this.now());
      }
    });
    this.tail = turn.catch(() => undefined);
    return turn.then(perform);
  }
}
