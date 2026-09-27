// K-30a: сквозной прогон контура уведомлений на фикстурах K-28 и настоящих репозиториях хранилища (PGlite).
// Публикация k28-rulepack-v2 поверх v1 (добавлена k28.water-marking) → планировщик → политика → очередь →
// МОДЕЛЬНЫЙ отправитель. Все данные и чаты модельные; реальный MAX не вызывается.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type {
  ChangeEvent,
  CompanyProfile,
  Notification,
  NotificationCandidate,
  Requirement,
} from "@max-hackathon/domain";
import {
  createPgliteClient,
  PostgresChangeEventRepository,
  PostgresNotificationRepository,
  PostgresProfileRepository,
  PostgresRequirementRepository,
  runMigrations,
} from "@max-hackathon/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  NotificationPipeline,
  type NotificationSink,
  notificationIdempotencyKey,
  PostgresNotificationHistory,
  runRulepackNotifications,
  StaticRecipientDirectory,
} from "../../src/notify/index.js";
import { FakeMessageSender, type SendQueueRepository, SendQueueWorker } from "../../src/sender/queue/index.js";
import { manualClock, notificationValidator } from "../sender/queue/support/fixtures.js";

interface PackFixture {
  packId: string;
  packVersion: number;
  requirements: Requirement[];
}

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dirname, "../../../../data/fixtures", name), "utf8")) as T;

const companies = fixture<CompanyProfile[]>("k28-companies.json");
const packV1 = fixture<PackFixture>("k28-rulepack-v1.json");
const packV2 = fixture<PackFixture>("k28-rulepack-v2.json");

const NOW = "2026-09-28T09:00:00.000Z";
const MODEL_CHAT = "model-chat-k28-cafe-msk";

let db: PGlite;
let client: ReturnType<typeof createPgliteClient>;

beforeAll(async () => {
  db = new PGlite();
  client = createPgliteClient(db);
  await runMigrations(client);
});
afterAll(() => db.close());

beforeEach(async () => {
  await client.exec(
    "TRUNCATE change_events, notification_candidates, notifications, requirements, rulepack_versions, facts, companies, recalculation_state CASCADE",
  );
  const profiles = new PostgresProfileRepository(client);
  for (const company of companies) await profiles.save(company);
  await new PostgresRequirementRepository(client).saveVersion(packV1.packId, 1, packV1.requirements);
});

const setup = (notifications: NotificationSink = new PostgresNotificationRepository(client)) => {
  const events = new PostgresChangeEventRepository(client);
  const requirements = new PostgresRequirementRepository(client);
  const pipeline = new NotificationPipeline({
    profiles: new PostgresProfileRepository(client),
    notifications,
    recipients: new StaticRecipientDirectory({ "k28-cafe-msk": MODEL_CHAT }),
    history: new PostgresNotificationHistory(client),
    now: () => new Date(NOW),
  });
  return {
    events,
    requirements,
    pipeline,
    run: () => runRulepackNotifications({ requirements, events, pipeline, now: () => NOW }),
  };
};

const deliver = async (sender: FakeMessageSender) => {
  const repository = new PostgresNotificationRepository(client);
  const queue: SendQueueRepository = {
    findByIdempotencyKey: repository.findByIdempotencyKey.bind(repository),
    updateStatus: repository.updateStatus.bind(repository),
    listQueuedFair: repository.listQueuedFair.bind(repository),
  };
  return new SendQueueWorker({ repository: queue, sender, now: manualClock(Date.parse(NOW)).now }).processBatch();
};

const publishV2 = () => new PostgresRequirementRepository(client).saveVersion(packV2.packId, 2, packV2.requirements);

const readNotifications = async (): Promise<Notification[]> =>
  (await client.query<{ data: Notification }>("SELECT data FROM notifications ORDER BY id")).rows.map(
    (row) => row.data,
  );

describe("контур уведомлений K-30a на фикстурах K-28", () => {
  it("первая публикация пакета не рассылает уведомления о каждой записи", async () => {
    const { run } = setup();

    expect(await run()).toEqual({ processed: [], alreadyProcessed: [] });
    expect(await readNotifications()).toEqual([]);
  });

  it("новая версия пакета доставляет одно уведомление без дублей при повторных прогонах", async () => {
    await publishV2();
    const { run, events } = setup();
    const sender = new FakeMessageSender();

    const first = await run();
    expect(first.processed).toHaveLength(1);
    const [report] = first.processed;
    expect(report).toMatchObject({ eventId: "rulepack_version:k28-model:1->2", ignored: false, alreadyQueued: [] });
    expect(report?.queued).toHaveLength(1);
    // k28-cafe-bad-data тоже затронута (ОКВЭД 56, Москва), но не подписана: чата нет — уведомления нет.
    expect(report?.noRecipient).toHaveLength(1);

    const event = await events.get("rulepack_version:k28-model:1->2");
    expect(event).toMatchObject({
      kind: "rulepack_version",
      isModel: true,
      rulepack: { fromVersion: 1, toVersion: 2, addedRequirementIds: ["k28.water-marking"] },
    });

    expect(await deliver(sender)).toMatchObject({ sent: [report?.queued[0]] });

    // Повторные прогоны и отправка: переход уже обработан, второго сообщения нет.
    expect(await run()).toEqual({ processed: [], alreadyProcessed: ["rulepack_version:k28-model:1->2"] });
    await deliver(sender);
    expect(sender.calls).toHaveLength(1);

    const [notification] = await readNotifications();
    const validate = notificationValidator();
    expect(validate(notification), JSON.stringify(validate.errors)).toBe(true);
    expect(notification).toMatchObject({
      companyId: "k28-cafe-msk",
      recipient: { channel: "max_bot", chatId: MODEL_CHAT },
      status: "sent",
      automated: true,
      isModel: true,
    });
    expect(notification?.sourceUrls.length).toBeGreaterThan(0);
    expect(notification?.text).toContain("Требование стало применяться к вашей компании");
    expect(notification?.text).toContain("Модельные данные");
  });

  it("повтор того же события (например, после сбоя до записи события) подавляется как дубль", async () => {
    await publishV2();
    const { run, events, pipeline } = setup();
    await run();
    const event = (await events.get("rulepack_version:k28-model:1->2")) as ChangeEvent;

    const again = await pipeline.process(
      event,
      () => [{ kind: "applicability", requirementId: "k28.water-marking", newStatus: "applies", matchedFactKeys: [] }],
      () => ({ text: "не должен понадобиться", sourceUrls: ["https://example.invalid"], automated: true }),
    );

    expect(again.queued).toEqual([]);
    expect(again.suppressed.map(({ code }) => code)).toContain("duplicate");
    expect(await readNotifications()).toHaveLength(1);
  });

  it("сбой между постановкой в очередь и записью кандидата не создаёт второе уведомление", async () => {
    await publishV2();
    const repository = new PostgresNotificationRepository(client);
    let failOnce = true;
    const crashing: NotificationSink = {
      hasCandidate: repository.hasCandidate.bind(repository),
      enqueue: repository.enqueue.bind(repository),
      findByIdempotencyKey: repository.findByIdempotencyKey.bind(repository),
      saveCandidate: async (candidate: NotificationCandidate) => {
        if (failOnce && candidate.companyId === "k28-cafe-msk") {
          failOnce = false;
          throw new Error("модельный сбой процесса");
        }
        await repository.saveCandidate(candidate);
      },
    };

    await expect(setup(crashing).run()).rejects.toThrow("модельный сбой процесса");
    // Событие не записано — переход будет обработан заново.
    expect(await setup().events.get("rulepack_version:k28-model:1->2")).toBeUndefined();

    const retry = await setup().run();
    expect(retry.processed[0]).toMatchObject({ queued: [], alreadyQueued: [expect.any(String)] });

    const sender = new FakeMessageSender();
    await deliver(sender);
    expect(sender.calls).toHaveLength(1);
    expect(await readNotifications()).toHaveLength(1);
  });

  it("события ленты классификатора выключены флагом по умолчанию", async () => {
    const { pipeline } = setup();
    const event: ChangeEvent = {
      contractVersion: 1,
      id: "doc-event",
      kind: "regulation_document",
      occurredAt: NOW,
      isModel: true,
      document: {
        documentId: "model-doc",
        title: "Модельный проект",
        url: "https://regulation.gov.ru/projects/000000",
        publishedAt: NOW,
        source: { system: "fixture", retrievedAt: NOW, isModel: true },
      },
    };

    const report = await pipeline.process(
      event,
      () => ({ kind: "early_signal", matchedFactKeys: [] }),
      () => undefined,
    );

    expect(report.ignored).toBe(true);
    expect(await readNotifications()).toEqual([]);
  });
});

describe("PostgresNotificationHistory", () => {
  it("считает sent и queued компании в текущем месяце МСК", async () => {
    await publishV2();
    await setup().run();
    const history = new PostgresNotificationHistory(client);

    expect(await history.sentThisMonth("k28-cafe-msk", NOW)).toBe(1);
    expect(await history.sentThisMonth("k28-cafe-msk", "2026-10-01T00:00:00.000Z")).toBe(0);
    expect(await history.sentThisMonth("k28-cafe-kzn", NOW)).toBe(0);
    expect(notificationIdempotencyKey({ dedupKey: "x" })).toBe("notify:x");
  });
});
