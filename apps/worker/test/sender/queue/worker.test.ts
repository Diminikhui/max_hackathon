// Воркер очереди отправки (K-21a) на модельном отправителе и in-memory репозитории: успех, повтор после
// временной ошибки, исчерпание попыток, постоянная ошибка, отсутствие дублей при повторном запуске и сбое,
// ограничение скорости, статусы проходят схему notification v1.
import type { Notification } from "@max-hackathon/domain";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DELIVERY_IN_PROGRESS,
  DELIVERY_UNKNOWN,
  FakeMessageSender,
  type FakeSendStep,
  type SendQueueRepository,
  SendQueueWorker,
  type SendQueueWorkerOptions,
} from "../../../src/sender/queue/index.js";
import { manualClock, notificationValidator, queued } from "./support/fixtures.js";
import { bind, MemoryNotificationRepository } from "./support/memory-repository.js";

const temporary: FakeSendStep = { ok: false, code: "max_unavailable", retryable: true };
const permanent: FakeSendStep = { ok: false, code: "max_chat_not_found", retryable: false };

let repository: MemoryNotificationRepository;
let clock: ReturnType<typeof manualClock>;

beforeEach(() => {
  repository = new MemoryNotificationRepository();
  clock = manualClock();
});

const setup = (script: FakeSendStep[] = [], options: Partial<SendQueueWorkerOptions> = {}) => {
  const sender = new FakeMessageSender(script);
  const worker = new SendQueueWorker({
    repository,
    sender,
    now: clock.now,
    perChatRateLimit: { capacity: 100, refillPerSecond: 100 },
    ...options,
  });
  return { sender, worker };
};

const stored = (id: string): Notification => {
  const item = repository.items.get(id);
  if (!item) throw new Error(`нет ${id}`);
  return item;
};

const expectValid = (item: Notification) => {
  const validate = notificationValidator();
  expect(validate(item), JSON.stringify(validate.errors)).toBe(true);
};

describe("SendQueueWorker", () => {
  it("успех: sent, attempts = 1, sentAt, без error", async () => {
    await repository.enqueue(queued("n1"));
    const { sender, worker } = setup();
    const report = await worker.processBatch();
    expect(report.sent).toEqual(["n1"]);
    expect(sender.calls).toEqual([{ id: "n1", idempotencyKey: "key-n1" }]);
    const item = stored("n1");
    expect(item).toMatchObject({ status: "sent", attempts: 1, sentAt: "2026-09-25T12:00:00.000Z" });
    expect(item.error).toBeUndefined();
    expectValid(item);
  });

  it("повтор после временной ошибки: queued с кодом, отсрочка, затем sent без error", async () => {
    await repository.enqueue(queued("n1"));
    const { sender, worker } = setup([temporary], { backoff: { baseMs: 1000, maxMs: 60_000 } });

    const first = await worker.processBatch();
    expect(first.retried).toEqual(["n1"]);
    expect(first.nextDelayMs).toBe(1000);
    expect(stored("n1")).toMatchObject({ status: "queued", attempts: 1, error: { code: "max_unavailable" } });
    expectValid(stored("n1"));

    // До конца отсрочки не отправляется.
    clock.advance(999);
    expect((await worker.processBatch()).skipped).toEqual(["n1"]);
    expect(sender.calls).toHaveLength(1);

    clock.advance(1);
    expect((await worker.processBatch()).sent).toEqual(["n1"]);
    const item = stored("n1");
    expect(item).toMatchObject({ status: "sent", attempts: 2 });
    expect(item.error).toBeUndefined();
    expect(sender.countFor("key-n1")).toBe(2);
    expectValid(item);
  });

  it("экспоненциальная отсрочка и исчерпание попыток → failed с кодом отправителя", async () => {
    await repository.enqueue(queued("n1"));
    const { sender, worker } = setup([temporary, temporary, temporary, temporary], {
      maxAttempts: 3,
      backoff: { baseMs: 1000, maxMs: 60_000 },
    });
    expect((await worker.processBatch()).nextDelayMs).toBe(1000);
    clock.advance(1000);
    expect((await worker.processBatch()).nextDelayMs).toBe(2000);
    clock.advance(2000);
    const last = await worker.processBatch();
    expect(last.failed).toEqual([{ id: "n1", code: "max_unavailable" }]);
    expect(stored("n1")).toMatchObject({
      status: "failed",
      attempts: 3,
      error: { code: "max_unavailable", message: "Исчерпаны попытки: 3" },
    });
    expectValid(stored("n1"));

    clock.advance(60_000);
    await worker.processBatch();
    expect(sender.calls).toHaveLength(3);
  });

  it("постоянная ошибка → сразу failed, без повторов", async () => {
    await repository.enqueue(queued("n1"));
    const { sender, worker } = setup([{ ...permanent, message: "чат не найден" }]);
    const report = await worker.processBatch();
    expect(report.failed).toEqual([{ id: "n1", code: "max_chat_not_found" }]);
    expect(stored("n1")).toMatchObject({
      status: "failed",
      attempts: 1,
      error: { code: "max_chat_not_found", message: "чат не найден" },
    });
    expectValid(stored("n1"));
    clock.advance(600_000);
    await worker.processBatch();
    expect(sender.calls).toHaveLength(1);
  });

  it("повторный запуск и новый экземпляр воркера не шлют дубль уже отправленного", async () => {
    await repository.enqueue(queued("n1"));
    const { sender, worker } = setup();
    await worker.processBatch();
    await worker.processBatch();
    const restarted = new SendQueueWorker({ repository, sender, now: clock.now });
    await restarted.processBatch();
    // Повторная постановка в очередь с тем же ключом тоже не создаёт дубль.
    await repository.enqueue(queued("n1-again", { idempotencyKey: "key-n1" }));
    await restarted.processBatch();
    expect(sender.countFor("key-n1")).toBe(1);
  });

  it("сбой между send и updateStatus: после перезапуска сообщение не отправляется повторно", async () => {
    await repository.enqueue(queued("n1"));
    const sender = new FakeMessageSender();
    const crashing: SendQueueRepository = {
      ...bind(repository),
      updateStatus: async (id, update) => {
        if (update.status === "sent") throw new Error("процесс упал");
        return repository.updateStatus(id, update);
      },
    };
    const worker = new SendQueueWorker({ repository: crashing, sender, now: clock.now });
    await expect(worker.processBatch()).rejects.toThrow("процесс упал");
    expect(stored("n1")).toMatchObject({ status: "queued", attempts: 1, error: { code: DELIVERY_IN_PROGRESS } });
    expectValid(stored("n1"));

    const restarted = new SendQueueWorker({ repository, sender, now: clock.now });
    const report = await restarted.processBatch();
    expect(report.failed).toEqual([{ id: "n1", code: DELIVERY_UNKNOWN }]);
    expect(stored("n1")).toMatchObject({ status: "failed", attempts: 1, error: { code: DELIVERY_UNKNOWN } });
    expectValid(stored("n1"));
    await restarted.processBatch();
    expect(sender.countFor("key-n1")).toBe(1);
  });

  it("политика unknownOutcome = retry: повтор после сбоя (только если MAX дедуплицирует по ключу)", async () => {
    await repository.enqueue(queued("n1", { attempts: 1, error: { code: DELIVERY_IN_PROGRESS } }));
    const { sender, worker } = setup([], { unknownOutcome: "retry", backoff: { baseMs: 1000, maxMs: 60_000 } });
    expect((await worker.processBatch()).retried).toEqual(["n1"]);
    expect(stored("n1")).toMatchObject({ status: "queued", attempts: 1, error: { code: DELIVERY_UNKNOWN } });
    clock.advance(1000);
    expect((await worker.processBatch()).sent).toEqual(["n1"]);
    expect(stored("n1")).toMatchObject({ status: "sent", attempts: 2 });
    expect(sender.calls).toHaveLength(1);
  });

  it("исключение отправителя — неизвестный исход: failed delivery_unknown, без повтора", async () => {
    await repository.enqueue(queued("n1"));
    const { sender, worker } = setup([{ throws: "timeout" }]);
    const report = await worker.processBatch();
    expect(report.failed).toEqual([{ id: "n1", code: DELIVERY_UNKNOWN }]);
    expectValid(stored("n1"));
    clock.advance(600_000);
    await worker.processBatch();
    expect(sender.calls).toHaveLength(1);
  });

  it("не отправляет уведомление, статус которого изменился после listQueued", async () => {
    await repository.enqueue(queued("n1"));
    const sender = new FakeMessageSender();
    const racing: SendQueueRepository = {
      ...bind(repository),
      listQueuedFair: async (options) => {
        const result = await repository.listQueuedFair(options);
        await repository.updateStatus("n1", { status: "suppressed", attempts: 0 });
        return result;
      },
    };
    const report = await new SendQueueWorker({ repository: racing, sender, now: clock.now }).processBatch();
    expect(report.skipped).toEqual(["n1"]);
    expect(sender.calls).toHaveLength(0);
    expect(stored("n1").status).toBe("suppressed");
  });

  it("по умолчанию сглаживает чат до 2 msg/s; общий бюджет принадлежит MAX transport", async () => {
    await repository.enqueue(queued("a1", { recipient: { channel: "max_bot", chatId: "chat-a" } }));
    await repository.enqueue(queued("a2", { recipient: { channel: "max_bot", chatId: "chat-a" } }));
    await repository.enqueue(queued("b1", { recipient: { channel: "max_bot", chatId: "chat-b" } }));
    const sender = new FakeMessageSender();
    const worker = new SendQueueWorker({ repository, sender, now: clock.now });

    expect(await worker.processBatch()).toMatchObject({ sent: ["a1", "b1"], nextDelayMs: 500 });
    clock.advance(500);
    expect((await worker.processBatch()).sent).toEqual(["a2"]);
    expect(sender.calls.map((call) => call.id)).toEqual(["a1", "b1", "a2"]);
  });

  it("сохраняет FIFO внутри чата и даёт ход другим чатам", async () => {
    for (const id of ["a1", "a2", "a3"]) {
      await repository.enqueue(queued(id, { recipient: { channel: "max_bot", chatId: "chat-a" } }));
    }
    await repository.enqueue(
      queued("b1", {
        createdAt: "2026-09-25T12:00:01Z",
        recipient: { channel: "max_bot", chatId: "chat-b" },
      }),
    );
    const sender = new FakeMessageSender();
    const worker = new SendQueueWorker({
      repository,
      sender,
      now: clock.now,
    });

    const first = await worker.processBatch();
    expect(first.sent).toEqual(["a1", "b1"]);
    expect(first.skipped).toEqual(["a2", "a3"]);
    clock.advance(500);
    expect((await worker.processBatch()).sent).toEqual(["a2"]);
    clock.advance(500);
    expect((await worker.processBatch()).sent).toEqual(["a3"]);
    expect(sender.calls.map((call) => call.id)).toEqual(["a1", "b1", "a2", "a3"]);
  });

  it("не допускает starvation: chat B виден за большим throttled FIFO-префиксом chat A", async () => {
    for (let index = 0; index < 80; index += 1) {
      await repository.enqueue(
        queued(`a-${String(index).padStart(2, "0")}`, {
          createdAt: `2026-09-25T11:00:00.${String(index).padStart(3, "0")}Z`,
          recipient: { channel: "max_bot", chatId: "chat-a" },
        }),
      );
    }
    await repository.enqueue(
      queued("b-1", {
        createdAt: "2026-09-25T13:00:00Z",
        recipient: { channel: "max_bot", chatId: "chat-b" },
      }),
    );
    const { sender, worker } = setup([], {
      batchSize: 2,
      perChatRateLimit: { capacity: 1, refillPerSecond: 0.01 },
    });

    const report = await worker.processBatch();
    expect(report.sent).toEqual(["a-00", "b-1"]);
    expect(sender.calls.map((call) => call.id)).toEqual(["a-00", "b-1"]);
  });

  it("ограничивает чтение при огромном backlog и видит B за A через fair index", async () => {
    for (let index = 0; index < 10_000; index += 1) {
      await repository.enqueue(
        queued(`a-${index}`, {
          createdAt: `2026-09-25T11:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
          recipient: { channel: "max_bot", chatId: "chat-a" },
        }),
      );
    }
    await repository.enqueue(
      queued("b-boundary", {
        createdAt: "2026-09-25T23:59:59Z",
        recipient: { channel: "max_bot", chatId: "chat-b" },
      }),
    );
    let observedScanned = 0;
    const bounded = {
      ...bind(repository),
      listQueuedFair: async (options: { maxItems: number; maxScan: number }) => {
        const result = await repository.listQueuedFair(options);
        observedScanned = result.scanned;
        return result;
      },
    };
    const sender = new FakeMessageSender();
    const worker = new SendQueueWorker({
      repository: bounded,
      sender,
      now: clock.now,
      batchSize: 2,
      maxScanPerTick: 20,
      perChatRateLimit: { capacity: 1, refillPerSecond: 0.01 },
    });
    expect((await worker.processBatch()).sent).toEqual(["a-0", "b-boundary"]);
    expect(observedScanned).toBeLessThanOrEqual(20);
  });

  it("удаляет idle chat buckets по TTL", async () => {
    await repository.enqueue(queued("a1", { recipient: { channel: "max_bot", chatId: "chat-a" } }));
    const { worker } = setup([], { chatBucketIdleTtlMs: 1000 });
    await worker.processBatch();
    expect(worker.activeChatBucketCount()).toBe(1);
    clock.advance(1000);
    await worker.processBatch();
    expect(worker.activeChatBucketCount()).toBe(0);
  });

  it("retryAfterMs от отправителя ставит на паузу всю очередь", async () => {
    await repository.enqueue(queued("n1"));
    await repository.enqueue(queued("n2"));
    const { sender, worker } = setup([{ ok: false, code: "max_rate_limited", retryable: true, retryAfterMs: 3000 }]);
    const first = await worker.processBatch();
    expect(first).toMatchObject({ retried: ["n1"], throttled: true, nextDelayMs: 3000 });
    clock.advance(2000);
    expect(await worker.processBatch()).toMatchObject({ throttled: true, nextDelayMs: 1000 });
    expect(sender.calls).toHaveLength(1);
    clock.advance(1000);
    expect((await worker.processBatch()).sent).toEqual(["n1", "n2"]);
  });

  it("batchSize ограничивает итерацию; отложенные не вытесняют готовые", async () => {
    await repository.enqueue(queued("n1", { createdAt: "2026-09-25T11:00:00Z" }));
    for (const id of ["n2", "n3", "n4"]) await repository.enqueue(queued(id));
    const { worker } = setup([temporary], { batchSize: 2 });
    const first = await worker.processBatch();
    expect(first).toMatchObject({ retried: ["n1"], sent: ["n2"], nextDelayMs: 0 });
    const second = await worker.processBatch();
    expect(second).toMatchObject({ skipped: ["n1"], sent: ["n3", "n4"] });
  });

  it("параллельный вызов processBatch на одном воркере запрещён", async () => {
    await repository.enqueue(queued("n1"));
    const { worker } = setup();
    const running = worker.processBatch();
    await expect(worker.processBatch()).rejects.toThrow("уже выполняется");
    await running;
  });
});
