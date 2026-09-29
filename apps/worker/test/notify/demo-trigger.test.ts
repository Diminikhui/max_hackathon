// K-29: демо-триггер бота через настоящий контур K-30a и хранилище (PGlite). Нажатие публикует подготовленную
// версию data/rulepacks/_demo поверх k28-rulepack-v1 → событие версии → планировщик → политика → шаблон K-23 →
// очередь → МОДЕЛЬНЫЙ отправитель. Все данные и чаты модельные; реальный MAX не вызывается.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  createDemoChangeFlow,
  DEMO_PACK_FILE,
  DemoRecipientDirectory,
  loadDemoPack,
} from "@max-hackathon/bot/dist/flows/demo/index.js";
import type { ApplicabilityStatus, CompanyProfile, Notification, Requirement } from "@max-hackathon/domain";
import { assessRequirement } from "@max-hackathon/rules";
import {
  createPgliteClient,
  PostgresChangeEventRepository,
  PostgresNotificationRepository,
  PostgresProfileRepository,
  PostgresRequirementRepository,
  runMigrations,
} from "@max-hackathon/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NotificationPipeline, PostgresNotificationHistory, runRulepackNotifications } from "../../src/notify/index.js";
import { FakeMessageSender, SendQueueWorker } from "../../src/sender/queue/index.js";
import { manualClock } from "../sender/queue/support/fixtures.js";

const ROOT = join(import.meta.dirname, "../../../..");
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(ROOT, "data/fixtures", name), "utf8")) as T;

const companies = fixture<CompanyProfile[]>("k28-companies.json");
const packV1 = fixture<{ packId: string; requirements: Requirement[] }>("k28-rulepack-v1.json");
const NOW = "2026-09-28T09:00:00.000Z";

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

/** Минимальный перечень по форме K-26: последняя версия каждого пакета, статусы вычислителя K-16. */
const checklist = (requirements: PostgresRequirementRepository, profiles: PostgresProfileRepository) => ({
  async build(companyId: string) {
    const profile = await profiles.get(companyId);
    if (!profile) return { status: "profile_not_found" as const };
    const items = [];
    const packs = [];
    for (const packId of await requirements.listPackIds()) {
      const packVersion = (await requirements.latestVersion(packId)) as number;
      packs.push({ packId, packVersion });
      for (const requirement of await requirements.listByPack(packId, packVersion)) {
        items.push({ requirement, applicability: assessRequirement(requirement, profile, { evaluatedAt: NOW }) });
      }
    }
    const statusCounts: Record<ApplicabilityStatus, number> = {
      applies: 0,
      not_applies: 0,
      insufficient_data: 0,
      needs_review: 0,
      out_of_coverage: 0,
    };
    for (const item of items) statusCounts[item.applicability.status] += 1;
    return {
      status: "ok" as const,
      profile: { isModel: profile.isModel },
      checklist: { evaluatedAt: NOW, asOf: NOW.slice(0, 10), packs, items, statusCounts },
    };
  },
});

/** Сборка как в точке входа: один справочник получателей у сценария бота и у контура уведомлений. */
const setup = async (dialogs: Record<string, string>) => {
  const requirements = new PostgresRequirementRepository(client);
  const profiles = new PostgresProfileRepository(client);
  const notifications = new PostgresNotificationRepository(client);
  const recipients = new DemoRecipientDirectory();
  const pipeline = new NotificationPipeline({
    profiles,
    notifications,
    recipients,
    history: new PostgresNotificationHistory(client),
    now: () => new Date(NOW),
  });
  const events = new PostgresChangeEventRepository(client);
  const flow = createDemoChangeFlow({
    pack: await loadDemoPack(join(ROOT, DEMO_PACK_FILE)),
    requirements,
    checklist: checklist(requirements, profiles),
    companyOf: async (dialogId) => dialogs[dialogId],
    recipients,
    runNotifications: () => runRulepackNotifications({ requirements, events, pipeline, now: () => NOW }),
    notifications,
  });
  const sender = new FakeMessageSender();
  const deliver = () =>
    new SendQueueWorker({ repository: notifications, sender, now: manualClock(Date.parse(NOW)).now }).processBatch();
  return { flow, sender, deliver };
};

const readNotifications = async (): Promise<Notification[]> =>
  (await client.query<{ data: Notification }>("SELECT data FROM notifications ORDER BY id")).rows.map(
    (row) => row.data,
  );

describe("демо-триггер K-29 через контур K-30a", () => {
  it("нажатие доставляет уведомление в чат нажатия, повтор даёт тот же результат без дубля", async () => {
    const { flow, sender, deliver } = await setup({ "dialog-cafe": "k28-cafe-msk" });

    const first = await flow.handle({ dialogId: "dialog-cafe", chatId: "model-chat-cafe" });
    await deliver();

    const [notification, ...rest] = await readNotifications();
    expect(rest).toEqual([]);
    // Ключ, по которому бот находит уведомление, совпадает с ключом контура (dedupKey планировщика K-20a).
    expect(notification).toMatchObject({
      idempotencyKey: "notify:k28-cafe-msk:k28.water-marking:applies:k28-model@2",
      companyId: "k28-cafe-msk",
      recipient: { channel: "max_bot", chatId: "model-chat-cafe" },
      status: "sent",
      isModel: true,
      automated: true,
    });
    expect(notification?.text).toContain("маркировка упакованной воды");
    expect(notification?.text).toContain("Требование стало применяться к вашей компании");
    expect(notification?.text).toContain("Модельные данные");
    expect(notification?.sourceUrls).toEqual(["http://pravo.gov.ru/"]);

    expect(first.text).toContain("МОДЕЛЬНОЕ ИЗМЕНЕНИЕ");
    expect(first.text).toContain("• Добавлена обязанность: Новая обязанность: маркировка упакованной воды");
    expect(first.text).toContain("Основной ОКВЭД: 56.10");
    expect(first.text).toContain("регион: 77 — выполнено");
    expect(first.text).toContain("приходит в этот чат");
    expect(first.sourceUrls).toEqual(["http://pravo.gov.ru/"]);

    const second = await flow.handle({ dialogId: "dialog-cafe", chatId: "model-chat-cafe" });
    await deliver();
    // Ответ тот же, кроме строки об уведомлении: оно уже доставлено, поэтому бот не обещает нового.
    const withoutNotificationLine = (text: string) => text.replace(/🔔 Уведомление об этом изменении.*\n?/, "");
    expect(second.text).toContain("уже отправлено в этот чат раньше");
    expect(second.text).not.toContain("приходит в этот чат");
    expect(withoutNotificationLine(second.text)).toBe(withoutNotificationLine(first.text));
    expect(second.buttons).toEqual(first.buttons);
    expect(second.sourceUrls).toEqual(first.sourceUrls);
    expect(sender.calls).toHaveLength(1);
    expect(await readNotifications()).toHaveLength(1);
  });

  it("компании вне изменения уведомление не приходит, ответ объясняет почему", async () => {
    const { flow, deliver, sender } = await setup({ "dialog-auto": "k28-autoservice-msk" });

    const reply = await flow.handle({ dialogId: "dialog-auto", chatId: "model-chat-auto" });
    await deliver();

    expect(sender.calls).toEqual([]);
    expect(reply.text).toContain("Вашей компании это изменение не касается:");
    expect(reply.text).toContain("ОКВЭД начинается с 56 — не выполнено");
    expect(reply.text).toContain("модельный ИНН 7700000016");
  });
});
