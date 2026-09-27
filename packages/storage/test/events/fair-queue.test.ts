// Интеграционные тесты честной выборки очереди (3-05, #247) на PostgreSQL (PGlite): round-robin между
// чатами, FIFO внутри чата, граница maxScan и отсутствие голодания за длинным префиксом одного чата.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Notification } from "@max-hackathon/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { PostgresNotificationRepository } from "../../src/index.js";
import { type TestDatabase, useSharedTestDatabase } from "../support/test-db.js";

const examples = join(import.meta.dirname, "../../../../contracts/v1/examples");
const sent = JSON.parse(readFileSync(join(examples, "notification.sent.json"), "utf8")) as Notification;

/** Модельное уведомление в очереди указанного модельного чата. */
const queued = (id: string, chatId: string, second: number): Notification => {
  const { sentAt: _sentAt, ...base } = sent;
  return {
    ...base,
    id,
    idempotencyKey: `key-${id}`,
    status: "queued",
    attempts: 0,
    createdAt: new Date(Date.UTC(2026, 8, 25, 12, 0, second)).toISOString(),
    recipient: { ...base.recipient, chatId },
  };
};

const testDatabase = useSharedTestDatabase();
let db: TestDatabase;
let repository: PostgresNotificationRepository;

beforeEach(() => {
  db = testDatabase();
  repository = new PostgresNotificationRepository(db);
});

const ids = (items: Notification[]) => items.map((item) => item.id);

/** Длинная очередь модельного чата одним INSERT … SELECT: без загрузки строк в тест. */
const bulkEnqueue = async (chatId: string, prefix: string, count: number) => {
  const template = queued("template", chatId, 0);
  await db.query(
    `INSERT INTO notifications (id, candidate_id, company_id, idempotency_key, status, attempts, created_at, data)
     SELECT $2 || g, $3, $4, 'key-' || $2 || g, 'queued', 0, timestamptz '2026-09-25T11:00:00Z' + g * interval '1 ms',
            $1::jsonb || jsonb_build_object('id', $2 || g, 'idempotencyKey', 'key-' || $2 || g)
     FROM generate_series(1, $5) AS g`,
    [JSON.stringify(template), prefix, template.candidateId, template.companyId, count],
  );
};

describe("PostgresNotificationRepository.listQueuedFair", () => {
  it("round-robin между чатами и FIFO внутри чата", async () => {
    for (const [id, chat, second] of [
      ["a1", "chat-a", 1],
      ["a2", "chat-a", 2],
      ["a3", "chat-a", 3],
      ["b1", "chat-b", 4],
      ["b2", "chat-b", 5],
      ["c1", "chat-c", 6],
    ] as const)
      await repository.enqueue(queued(id, chat, second));

    const batch = await repository.listQueuedFair({ maxItems: 10, maxScan: 20 });
    expect(ids(batch.items)).toEqual(["a1", "b1", "c1", "a2", "b2", "a3"]);
    expect(batch.scanned).toBeLessThanOrEqual(20);
  });

  it("не возвращает уведомления вне очереди", async () => {
    await repository.enqueue(queued("a1", "chat-a", 1));
    await repository.enqueue(queued("a2", "chat-a", 2));
    await repository.updateStatus("a1", { status: "sent", attempts: 1, sentAt: "2026-09-25T12:01:00Z" });
    expect(ids((await repository.listQueuedFair({ maxItems: 10, maxScan: 10 })).items)).toEqual(["a2"]);
  });

  it("чат за длинным префиксом другого чата попадает в первую же выборку, maxScan соблюдён", async () => {
    await bulkEnqueue("chat-a", "a", 20_000);
    await repository.enqueue(queued("b1", "chat-b", 59));

    const batch = await repository.listQueuedFair({ maxItems: 20, maxScan: 20 });
    expect(batch.scanned).toBeLessThanOrEqual(20);
    expect(batch.items.length).toBeLessThanOrEqual(20);
    expect(ids(batch.items).slice(0, 2)).toEqual(["a1", "b1"]);
  });

  it("при числе чатов больше бюджета перебирает их по кругу: каждый чат обслуживается", async () => {
    for (let chat = 0; chat < 7; chat += 1) await repository.enqueue(queued(`n${chat}`, `chat-${chat}`, chat));
    const seen = new Set<string>();
    for (let tick = 0; tick < 4; tick += 1) {
      const batch = await repository.listQueuedFair({ maxItems: 2, maxScan: 4 });
      expect(batch.scanned).toBeLessThanOrEqual(4);
      for (const id of ids(batch.items)) seen.add(id);
    }
    expect(seen.size).toBe(7);
  });

  it("пустая очередь и некорректные границы", async () => {
    expect(await repository.listQueuedFair({ maxItems: 5, maxScan: 5 })).toEqual({ items: [], scanned: 0 });
    await expect(repository.listQueuedFair({ maxItems: 5, maxScan: 1 })).rejects.toThrow("maxScan");
    await expect(repository.listQueuedFair({ maxItems: -1, maxScan: 5 })).rejects.toThrow("maxItems");
  });
});
