// Ограничение скорости отправки: token bucket. Время передаётся параметром — поведение детерминировано.

export interface TokenBucketOptions {
  /** Максимум токенов (допустимый всплеск). */
  capacity: number;
  /** Скорость пополнения: токенов в секунду. */
  refillPerSecond: number;
}

export class TokenBucket {
  private tokens: number;
  private updatedAt: number | undefined;

  constructor(private readonly options: TokenBucketOptions) {
    if (!(options.capacity >= 1)) throw new Error(`Неверная ёмкость: ${options.capacity}`);
    if (!(options.refillPerSecond > 0)) throw new Error(`Неверная скорость: ${options.refillPerSecond}`);
    this.tokens = options.capacity;
  }

  /**
   * Взять один токен в момент nowMs. Возвращает 0, если токен взят, иначе — сколько миллисекунд ждать
   * до появления следующего токена.
   */
  take(nowMs: number): number {
    this.refill(nowMs);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.tokens) * 1000) / this.options.refillPerSecond);
  }

  private refill(nowMs: number): void {
    if (this.updatedAt !== undefined && nowMs > this.updatedAt) {
      const added = ((nowMs - this.updatedAt) * this.options.refillPerSecond) / 1000;
      this.tokens = Math.min(this.options.capacity, this.tokens + added);
    }
    if (this.updatedAt === undefined || nowMs > this.updatedAt) this.updatedAt = nowMs;
  }
}
