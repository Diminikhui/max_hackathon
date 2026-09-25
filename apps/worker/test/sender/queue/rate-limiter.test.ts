// Token bucket: всплеск до capacity, пополнение по времени, ожидание до следующего токена.
import { describe, expect, it } from "vitest";
import { TokenBucket } from "../../../src/sender/queue/index.js";

describe("TokenBucket", () => {
  it("выдаёт capacity токенов сразу, затем по скорости пополнения", () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 2 });
    expect([bucket.take(0), bucket.take(0), bucket.take(0)]).toEqual([0, 0, 0]);
    expect(bucket.take(0)).toBe(500);
    expect(bucket.take(250)).toBe(250);
    expect(bucket.take(500)).toBe(0);
    expect(bucket.take(500)).toBe(500);
  });

  it("не копит больше capacity и не ломается от времени назад", () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1 });
    bucket.take(0);
    expect(bucket.take(100_000)).toBe(0);
    expect(bucket.take(100_000)).toBe(0);
    expect(bucket.take(100_000)).toBe(1000);
    expect(bucket.take(50_000)).toBe(1000);
  });

  it("отклоняет неверные параметры", () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 })).toThrow();
    expect(() => new TokenBucket({ capacity: 1, refillPerSecond: 0 })).toThrow();
  });
});
