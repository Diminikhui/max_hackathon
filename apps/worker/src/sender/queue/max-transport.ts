// Единственная HTTP-граница исходящих запросов к MAX Bot API.
// Fetch доступен только этой реализации: send/upload/service всегда проходят через один общий bucket.

import { TokenBucket, type TokenBucketOptions } from "./rate-limiter.js";

export type MaxApiOperation = "send" | "upload" | "service";
export type MaxFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface MaxApiRequest {
  path: string;
  init?: RequestInit;
}

export interface MaxApiTransport {
  request(operation: MaxApiOperation, request: MaxApiRequest): Promise<Response>;
  send(request: MaxApiRequest): Promise<Response>;
  upload(request: MaxApiRequest): Promise<Response>;
  service(request: MaxApiRequest): Promise<Response>;
}

export interface RateLimitedMaxTransportOptions {
  baseUrl: string;
  token: string;
  fetch?: MaxFetch;
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
  private readonly fetch: MaxFetch;
  private readonly baseUrl: string;
  private readonly token: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: RateLimitedMaxTransportOptions) {
    this.bucket = new TokenBucket(options.budget ?? DEFAULT_MAX_API_BUDGET);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
  }

  request(_operation: MaxApiOperation, request: MaxApiRequest): Promise<Response> {
    // Сериализация резервирования не даёт параллельным клиентам взять один токен одновременно.
    const turn = this.tail.then(async () => {
      let wait = this.bucket.take(this.now());
      while (wait > 0) {
        await this.sleep(wait);
        wait = this.bucket.take(this.now());
      }
    });
    this.tail = turn.catch(() => undefined);
    return turn.then(() => {
      const headers = new Headers(request.init?.headers);
      headers.set("Authorization", this.token);
      return this.fetch(`${this.baseUrl}/${request.path.replace(/^\//, "")}`, { ...request.init, headers });
    });
  }

  send(request: MaxApiRequest): Promise<Response> {
    return this.request("send", request);
  }

  upload(request: MaxApiRequest): Promise<Response> {
    return this.request("upload", request);
  }

  service(request: MaxApiRequest): Promise<Response> {
    return this.request("service", request);
  }
}
