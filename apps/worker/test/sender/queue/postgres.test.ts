// Воркер очереди на настоящем PostgresNotificationRepository (PGlite, K-10c): успех, повтор после временной
// ошибки, сбой между send и updateStatus не даёт дубля; прочитанные документы проходят схему notification v1.

import { PGlite } from "@electric-sql/pglite";
import type { Notification, NotificationRepository } from "@max-hackathon/domain";
import { createPgliteClient, PostgresNotificationRepository, runMigrations } from "@max-hackathon/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELIVERY_UNKNOWN, FakeMessageSender, SendQueueWorker } from "../../../src/sender/queue/index.js";
import { manualClock, notificationValidator, queued } from "./support/fixtures.js";
import { bind } from "./support/memory-repository.js";

let db: PGlite;
let repository: PostgresNotificationRepository;

beforeEach(async () => {
  db = new PGlite();
  const client = createPgliteClient(db);
  await runMigrations(client);
  repository = new PostgresNotificationRepository(client);
});
afterEach(() => db.close());

const read = async (key: string): Promise<Notification> => {
  const item = await repository.findByIdempotencyKey(key);
  if (!item) throw new Error(`нет ${key}`);
  const validate = notificationValidator();
  expect(validate(item), JSON.stringify(validate.errors)).toBe(true);
  return item;
};

describe("SendQueueWorker + PostgresNotificationRepository", () => {
  it("успех и повтор после временной ошибки; повторный запуск не шлёт дубль", async () => {
    await repository.enqueue(queued("n1"));
    await repository.enqueue(queued("n2", { createdAt: "2026-09-25T12:00:01Z" }));
    const clock = manualClock();
    const sender = new FakeMessageSender([{ ok: true }, { ok: false, code: "max_unavailable", retryable: true }]);
    const worker = new SendQueueWorker({
      repository,
      sender,
      now: clock.now,
      backoff: { baseMs: 1000, maxMs: 1000 },
      perChatRateLimit: { capacity: 100, refillPerSecond: 100 },
    });

    expect(await worker.processBatch()).toMatchObject({ sent: ["n1"], retried: ["n2"] });
    expect(await read("key-n1")).toMatchObject({ status: "sent", attempts: 1 });
    expect(await read("key-n2")).toMatchObject({ status: "queued", attempts: 1, error: { code: "max_unavailable" } });

    clock.advance(1000);
    expect((await worker.processBatch()).sent).toEqual(["n2"]);
    const n2 = await read("key-n2");
    expect(n2).toMatchObject({ status: "sent", attempts: 2 });
    expect(n2.error).toBeUndefined();

    await new SendQueueWorker({ repository, sender, now: clock.now }).processBatch();
    expect(sender.countFor("key-n1")).toBe(1);
    expect(sender.countFor("key-n2")).toBe(2);
  });

  it("сбой между send и updateStatus: после перезапуска — failed delivery_unknown, без повторной отправки", async () => {
    await repository.enqueue(queued("n1"));
    const clock = manualClock();
    const sender = new FakeMessageSender();
    const crashing: NotificationRepository = {
      ...bind(repository),
      updateStatus: async (id, update) => {
        if (update.status === "sent") throw new Error("процесс упал");
        return repository.updateStatus(id, update);
      },
    };
    await expect(
      new SendQueueWorker({ repository: crashing, sender, now: clock.now }).processBatch(),
    ).rejects.toThrow();

    const restarted = new SendQueueWorker({ repository, sender, now: clock.now });
    expect((await restarted.processBatch()).failed).toEqual([{ id: "n1", code: DELIVERY_UNKNOWN }]);
    await restarted.processBatch();
    expect(await read("key-n1")).toMatchObject({ status: "failed", attempts: 1, error: { code: DELIVERY_UNKNOWN } });
    expect(sender.calls).toHaveLength(1);
  });
});
