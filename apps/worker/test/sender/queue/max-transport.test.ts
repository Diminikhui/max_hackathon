import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_API_BUDGET, MaxMessageSender, RateLimitedMaxTransport } from "../../../src/sender/queue/index.js";
import { queued } from "./support/fixtures.js";

describe("RateLimitedMaxTransport", () => {
  it("делит один безопасный бюджет между send, upload и service запросами", async () => {
    let now = 0;
    const waits: number[] = [];
    const calls: string[] = [];
    const transport = new RateLimitedMaxTransport({
      baseUrl: "https://max.example.test/api/",
      token: "model-token",
      now: () => now,
      budget: { capacity: 1, refillPerSecond: 10 },
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
      fetch: async (input) => {
        calls.push(input);
        return new Response(null, { status: 200 });
      },
    });

    await Promise.all([
      transport.send({ path: "send" }),
      transport.upload({ path: "upload" }),
      transport.service({ path: "service" }),
    ]);

    expect(calls).toEqual([
      "https://max.example.test/api/send",
      "https://max.example.test/api/upload",
      "https://max.example.test/api/service",
    ]);
    expect(waits).toEqual([100, 100]);
  });

  it("один request резервирует один token и выполняет ровно один fetch", async () => {
    let fetches = 0;
    const transport = new RateLimitedMaxTransport({
      baseUrl: "https://max.example.test",
      token: "model-token",
      fetch: async () => {
        fetches += 1;
        return new Response(null, { status: 200 });
      },
    });
    await transport.request("service", { path: "/me" });
    expect(fetches).toBe(1);
  });

  it("MaxMessageSender требует transport и не принимает fetch/callback", async () => {
    const requests: string[] = [];
    const transport = new RateLimitedMaxTransport({
      baseUrl: "https://max.example.test",
      token: "model-token",
      fetch: async (input) => {
        requests.push(input);
        return new Response(null, { status: 200 });
      },
    });
    expect(await new MaxMessageSender(transport).send(queued("n1"))).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
  });

  it("по умолчанию оставляет резерв относительно документированного лимита 30 rps", () => {
    expect(DEFAULT_MAX_API_BUDGET.refillPerSecond).toBeLessThan(30);
  });
});
