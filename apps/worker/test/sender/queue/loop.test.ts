// Внешний цикл: ждёт nextDelayMs, переживает ошибку итерации, останавливается по signal.
import { describe, expect, it } from "vitest";
import { FakeMessageSender, runSendLoop, SendQueueWorker } from "../../../src/sender/queue/index.js";
import { manualClock, queued } from "./support/fixtures.js";
import { bind, MemoryNotificationRepository } from "./support/memory-repository.js";

describe("runSendLoop", () => {
  it("отправляет очередь, после ошибки ждёт errorDelayMs и останавливается по abort", async () => {
    const repository = new MemoryNotificationRepository();
    await repository.enqueue(queued("n1"));
    const clock = manualClock();
    const sender = new FakeMessageSender();
    let failOnce = true;
    const worker = new SendQueueWorker({
      repository: {
        ...bind(repository),
        listQueuedFair: async (options) => {
          if (failOnce) {
            failOnce = false;
            throw new Error("БД недоступна");
          }
          return repository.listQueuedFair(options);
        },
      },
      sender,
      now: clock.now,
      idleDelayMs: 7000,
    });
    const controller = new AbortController();
    const delays: number[] = [];
    const errors: unknown[] = [];
    await runSendLoop(worker, {
      signal: controller.signal,
      errorDelayMs: 1234,
      onError: (error) => errors.push(error),
      sleep: async (ms) => {
        delays.push(ms);
        clock.advance(ms);
        if (delays.length === 3) controller.abort();
      },
    });
    expect(errors).toHaveLength(1);
    expect(delays).toEqual([1234, 7000, 7000]);
    expect(sender.calls).toHaveLength(1);
    expect(repository.items.get("n1")?.status).toBe("sent");
  });
});
