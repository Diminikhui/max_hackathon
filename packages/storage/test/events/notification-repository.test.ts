// Интеграционные тесты NotificationRepository на PostgreSQL (PGlite): чтение = записанное,
// дедупликация кандидатов, идемпотентность очереди, порядок очереди, обновление статуса доставки,
// прочитанные документы проходят схемы notification-candidate и notification v1.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Notification, NotificationCandidate } from "@max-hackathon/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { PostgresNotificationRepository } from "../../src/index.js";
import { contractValidator } from "../support/contracts.js";
import { type TestDatabase, useSharedTestDatabase } from "../support/test-db.js";

const examples = join(import.meta.dirname, "../../../../contracts/v1/examples");
const read = <T>(file: string) => JSON.parse(readFileSync(join(examples, file), "utf8")) as T;
const candidate = read<NotificationCandidate>("notification-candidate.became-applicable.json");
const earlySignal = read<NotificationCandidate>("notification-candidate.early-signal.json");
const sent = read<Notification>("notification.sent.json");

/** Модельное уведомление в очереди на основе примера контракта. */
const queued = (id: string, createdAt: string, overrides: Partial<Notification> = {}): Notification => {
  const { sentAt: _sentAt, ...base } = sent;
  return { ...base, id, idempotencyKey: `key-${id}`, status: "queued", attempts: 0, createdAt, ...overrides };
};

const testDatabase = useSharedTestDatabase();
let db: TestDatabase;
let repository: PostgresNotificationRepository;

beforeEach(() => {
  db = testDatabase();
  repository = new PostgresNotificationRepository(db);
});

const count = async (table: string): Promise<number> => {
  const { rows } = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`);
  return rows[0]?.count ?? 0;
};

describe("PostgresNotificationRepository: кандидаты", () => {
  it("saveCandidate + hasCandidate по паре companyId и dedupKey", async () => {
    expect(await repository.hasCandidate(candidate.companyId, candidate.dedupKey)).toBe(false);
    await repository.saveCandidate(candidate);
    await repository.saveCandidate(earlySignal);
    expect(await repository.hasCandidate(candidate.companyId, candidate.dedupKey)).toBe(true);
    expect(await repository.hasCandidate(earlySignal.companyId, earlySignal.dedupKey)).toBe(true);
    expect(await repository.hasCandidate("other-company", candidate.dedupKey)).toBe(false);
    expect(await repository.getCandidate(candidate.id)).toEqual(candidate);
    expect(await repository.getCandidate(earlySignal.id)).toEqual(earlySignal);
  });

  it("дедупликация: повтор с тем же dedupKey или id не создаёт второго кандидата", async () => {
    await repository.saveCandidate(candidate);
    await repository.saveCandidate({ ...candidate, id: "cand-duplicate" });
    await repository.saveCandidate({ ...candidate, dedupKey: "another-key" });
    expect(await count("notification_candidates")).toBe(1);
    expect(await repository.getCandidate(candidate.id)).toEqual(candidate);
    expect(await repository.getCandidate("cand-duplicate")).toBeUndefined();
  });

  it("тот же dedupKey у другой компании — отдельный кандидат", async () => {
    await repository.saveCandidate(candidate);
    await repository.saveCandidate({ ...candidate, id: "cand-other", companyId: "model-company-other" });
    expect(await count("notification_candidates")).toBe(2);
  });

  it("прочитанные кандидаты проходят схему notification-candidate v1", async () => {
    const validate = contractValidator("notification-candidate");
    for (const item of [candidate, earlySignal]) {
      await repository.saveCandidate(item);
      expect(validate(await repository.getCandidate(item.id)), JSON.stringify(validate.errors)).toBe(true);
    }
  });
});

describe("PostgresNotificationRepository: уведомления", () => {
  it("findByIdempotencyKey возвращает ровно записанное уведомление", async () => {
    await repository.enqueue(sent);
    expect(await repository.findByIdempotencyKey(sent.idempotencyKey)).toEqual(sent);
    expect(await repository.findByIdempotencyKey("missing")).toBeUndefined();
  });

  it("enqueue идемпотентен по idempotencyKey: повтор не создаёт дубль и не меняет статус", async () => {
    const first = queued("n1", "2026-09-25T12:00:00Z");
    await repository.enqueue(first);
    await repository.updateStatus("n1", { status: "sent", attempts: 1, sentAt: "2026-09-25T12:00:01Z" });
    await repository.enqueue(first);
    await repository.enqueue({ ...first, id: "n1-retry", text: "Другой текст" });
    expect(await count("notifications")).toBe(1);
    expect((await repository.findByIdempotencyKey(first.idempotencyKey))?.status).toBe("sent");
    expect(await repository.listQueued(10)).toEqual([]);
  });

  it("listQueued — только queued, в порядке createdAt, с ограничением", async () => {
    await repository.enqueue(queued("c", "2026-09-25T12:00:03Z"));
    await repository.enqueue(queued("a", "2026-09-25T12:00:01Z"));
    await repository.enqueue(sent);
    await repository.enqueue(queued("b", "2026-09-25T15:00:02+03:00"));
    await repository.enqueue(queued("d", "2026-09-25T12:00:04Z", { status: "suppressed" }));
    expect((await repository.listQueued(10)).map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect((await repository.listQueued(2)).map((item) => item.id)).toEqual(["a", "b"]);
    expect(await repository.listQueued(0)).toEqual([]);
    await expect(repository.listQueued(-1)).rejects.toThrow(/limit/);
  });

  it("updateStatus: sent — статус, попытки и sentAt в колонках и документе", async () => {
    const item = queued("n1", "2026-09-25T12:00:00Z");
    await repository.enqueue(item);
    await repository.updateStatus("n1", { status: "sent", attempts: 1, sentAt: "2026-09-25T12:00:07Z" });
    expect(await repository.findByIdempotencyKey(item.idempotencyKey)).toEqual({
      ...item,
      status: "sent",
      attempts: 1,
      sentAt: "2026-09-25T12:00:07Z",
    });
    const { rows } = await db.query<{ status: string; attempts: number; sent: boolean }>(
      "SELECT status, attempts, sent_at IS NOT NULL AS sent FROM notifications WHERE id = 'n1'",
    );
    expect(rows[0]).toEqual({ status: "sent", attempts: 1, sent: true });
  });

  it("updateStatus: failed с error, затем повтор в очередь без error", async () => {
    const item = queued("n1", "2026-09-25T12:00:00Z");
    await repository.enqueue(item);
    const error = { code: "max_api_unavailable", message: "Модельная ошибка" };
    await repository.updateStatus("n1", { status: "failed", attempts: 1, error });
    expect(await repository.findByIdempotencyKey(item.idempotencyKey)).toEqual({
      ...item,
      status: "failed",
      attempts: 1,
      error,
    });
    expect(await repository.listQueued(10)).toEqual([]);
    await repository.updateStatus("n1", { status: "queued", attempts: 1 });
    expect(await repository.listQueued(10)).toEqual([{ ...item, attempts: 1 }]);
  });

  it("updateStatus отклоняет неизвестный id и несогласованный статус", async () => {
    await expect(repository.updateStatus("missing", { status: "queued", attempts: 0 })).rejects.toThrow(/не найдено/);
    await repository.enqueue(queued("n1", "2026-09-25T12:00:00Z"));
    await expect(repository.updateStatus("n1", { status: "sent", attempts: 1 })).rejects.toThrow(/sentAt/);
    await expect(repository.updateStatus("n1", { status: "failed", attempts: 1 })).rejects.toThrow(/error/);
    await expect(repository.updateStatus("n1", { status: "queued", attempts: -1 })).rejects.toThrow(/попыток/);
    await expect(repository.enqueue(queued("n2", "2026-09-25T12:00:00Z", { status: "sent" }))).rejects.toThrow(
      /sentAt/,
    );
  });

  it("прочитанные уведомления проходят схему notification v1 после каждого обновления", async () => {
    const validate = contractValidator("notification");
    const item = queued("n1", "2026-09-25T12:00:00Z");
    const check = async () => {
      const stored = await repository.findByIdempotencyKey(item.idempotencyKey);
      expect(validate(stored), JSON.stringify(validate.errors)).toBe(true);
    };
    await repository.enqueue(sent);
    expect(validate(await repository.findByIdempotencyKey(sent.idempotencyKey))).toBe(true);
    await repository.enqueue(item);
    await check();
    await repository.updateStatus("n1", { status: "failed", attempts: 1, error: { code: "timeout" } });
    await check();
    await repository.updateStatus("n1", { status: "sent", attempts: 2, sentAt: "2026-09-25T12:01:00Z" });
    await check();
    expect((await repository.listQueued(10)).every((stored) => validate(stored))).toBe(true);
  });
});
