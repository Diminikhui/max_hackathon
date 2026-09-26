import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_API_BUDGET, RateLimitedMaxTransport } from "../../../src/sender/queue/index.js";

describe("RateLimitedMaxTransport", () => {
  it("делит один безопасный бюджет между send, upload и service запросами", async () => {
    let now = 0;
    const waits: number[] = [];
    const calls: string[] = [];
    const transport = new RateLimitedMaxTransport({
      now: () => now,
      budget: { capacity: 1, refillPerSecond: 10 },
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
    });

    await Promise.all([
      transport.request("send", async () => calls.push("send")),
      transport.request("upload", async () => calls.push("upload")),
      transport.request("service", async () => calls.push("service")),
    ]);

    expect(calls).toEqual(["send", "upload", "service"]);
    expect(waits).toEqual([100, 100]);
  });

  it("по умолчанию оставляет резерв относительно документированного лимита 30 rps", () => {
    expect(DEFAULT_MAX_API_BUDGET.refillPerSecond).toBeLessThan(30);
  });
});
