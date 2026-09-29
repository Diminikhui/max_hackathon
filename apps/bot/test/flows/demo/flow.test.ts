// K-29: сценарий демо-триггера на модельных данных и фейковых портах. Сквозной прогон через настоящий контур
// K-30a и хранилище — apps/worker/test/notify/demo-trigger.test.ts.

import {
  type ApplicabilityResult,
  type ApplicabilityStatus,
  CONTRACT_VERSION,
  type Notification,
  type Requirement,
} from "@max-hackathon/domain";
import { describe, expect, it, vi } from "vitest";
import type { ChecklistOutcomeView, ChecklistSource } from "../../../src/flows/checklist/index.js";
import {
  createDemoChangeFlow,
  DEMO_CHANGE_CALLBACK_PAYLOAD,
  type DemoPack,
  DemoRecipientDirectory,
  demoChangeButton,
} from "../../../src/flows/demo/index.js";

const NOW = "2026-09-28T09:00:00.000Z";
const PACK_ID = "model-demo";

const requirement = (id: string, version: number, title = `Модельная запись ${id}`): Requirement => ({
  contractVersion: CONTRACT_VERSION,
  id,
  packId: PACK_ID,
  packVersion: version,
  kind: "obligation",
  title,
  basis: [{ act: "Модельный правовой источник — не юридическое утверждение", url: "http://pravo.gov.ru/" }],
  condition: { type: "always" },
  coverage: "full",
  source: { system: "fixture", retrievedAt: NOW, isModel: true },
});

const v1 = [requirement("m.base", 1)];
const pack: DemoPack = {
  packId: PACK_ID,
  packVersion: 2,
  title: "Модельный пакет",
  requirements: [requirement("m.base", 2), requirement("m.new", 2, "Новая обязанность (модельная запись)")],
};

const applicability = (req: Requirement, status: ApplicabilityStatus): ApplicabilityResult => ({
  contractVersion: CONTRACT_VERSION,
  companyId: "model-cafe",
  requirementId: req.id,
  packId: req.packId,
  packVersion: req.packVersion,
  status,
  explanation: [
    { kind: "fact", text: "Основной ОКВЭД: 56.10 (модельные данные)" },
    {
      kind: "condition",
      text: status === "applies" ? "ОКВЭД начинается с 56 — выполнено" : "ОКВЭД начинается с 56 — не выполнено",
    },
    { kind: "condition", text: "Итог условия: выполнены все условия — выполнено" },
    { kind: "result", text: status },
  ],
  evaluatedAt: NOW,
});

class MemoryRequirements {
  readonly versions = new Map<number, Requirement[]>([[1, v1]]);
  saveCalls = 0;
  async latestVersion() {
    return this.versions.size === 0 ? undefined : Math.max(...this.versions.keys());
  }
  async listByPack(_packId: string, version?: number) {
    return this.versions.get(version ?? (await this.latestVersion()) ?? 0) ?? [];
  }
  async saveVersion(_packId: string, version: number, requirements: Requirement[]) {
    this.saveCalls += 1;
    if (version <= ((await this.latestVersion()) ?? 0)) throw new Error("версии неизменяемы");
    this.versions.set(version, requirements);
  }
}

const checklistFor = (requirements: MemoryRequirements, newStatus: ApplicabilityStatus): ChecklistSource => ({
  async build(): Promise<ChecklistOutcomeView> {
    const version = (await requirements.latestVersion()) ?? 0;
    const items = (await requirements.listByPack(PACK_ID, version)).map((req) => ({
      requirement: req,
      applicability: applicability(req, req.id === "m.new" ? newStatus : "applies"),
    }));
    return {
      status: "ok",
      profile: { isModel: true },
      checklist: {
        evaluatedAt: NOW,
        asOf: NOW.slice(0, 10),
        packs: [{ packId: PACK_ID, packVersion: version }],
        items,
        statusCounts: { applies: 0, not_applies: 0, insufficient_data: 0, needs_review: 0, out_of_coverage: 0 },
      },
    };
  },
});

/** Модель контура K-30a: при первом прогоне после публикации ставит уведомление чату из справочника. */
const setup = (options: { newStatus?: ApplicabilityStatus; company?: string | undefined } = {}) => {
  const requirements = new MemoryRequirements();
  const recipients = new DemoRecipientDirectory();
  const queued = new Map<string, Notification>();
  const processed = new Set<number>();
  const newStatus = options.newStatus ?? "applies";
  const runNotifications = vi.fn(async () => {
    const version = (await requirements.latestVersion()) ?? 0;
    if (version < 2 || processed.has(version)) return;
    processed.add(version);
    const chatId = await recipients.chatFor("model-cafe");
    if (chatId === undefined || newStatus === "not_applies") return;
    const key = `notify:model-cafe:m.new:${newStatus}:${PACK_ID}@2`;
    queued.set(key, { recipient: { channel: "max_bot", chatId } } as Notification);
  });
  const flow = createDemoChangeFlow({
    pack,
    requirements,
    checklist: checklistFor(requirements, newStatus),
    companyOf: async () => ("company" in options ? options.company : "model-cafe"),
    recipients,
    runNotifications,
    notifications: { findByIdempotencyKey: async (key) => queued.get(key) },
  });
  return { flow, requirements, recipients, queued, runNotifications };
};

describe("демо-триггер K-29", () => {
  it("кнопка видимая, модельная и обрабатывается по своему payload", () => {
    expect(demoChangeButton()).toEqual({
      text: "🧪 Показать пример изменения (модельное)",
      payload: DEMO_CHANGE_CALLBACK_PAYLOAD,
    });
  });

  it("публикует следующую версию, запускает контур и объясняет изменение", async () => {
    const { flow, requirements, queued, runNotifications } = setup();

    const reply = await flow.handle({ dialogId: "d1", chatId: "model-chat-1" });

    expect(await requirements.latestVersion()).toBe(2);
    expect(runNotifications).toHaveBeenCalledOnce();
    expect([...queued.values()].map((item) => item.recipient.chatId)).toEqual(["model-chat-1"]);

    expect(reply.text).toContain("МОДЕЛЬНОЕ ИЗМЕНЕНИЕ");
    expect(reply.text).toContain("опубликована версия 2 вместо 1");
    // Что изменилось: только новая запись, неизменённая m.base не упоминается.
    expect(reply.text).toContain("• Добавлена обязанность: Новая обязанность (модельная запись)");
    expect(reply.text).not.toContain("Модельная запись m.base");
    // Почему касается: факты и условия, без итоговой строки.
    expect(reply.text).toContain("Почему это касается вашей компании:");
    expect(reply.text).toContain("ОКВЭД начинается с 56 — выполнено");
    expect(reply.text).not.toContain("Итог условия");
    expect(reply.text).toContain("приходит в этот чат");
    expect(reply.text).toContain("Первоисточник:");
    expect(reply.sourceUrls).toEqual(["http://pravo.gov.ru/"]);
    expect(reply.text).toContain("Текст сформирован автоматически");
    expect(reply.text).toContain("Модельные данные");
    expect(reply.automated).toBe(true);
  });

  it("повторное нажатие даёт тот же ответ и не создаёт второе уведомление", async () => {
    const { flow, requirements, queued } = setup();

    const first = await flow.handle({ dialogId: "d1", chatId: "model-chat-1" });
    const second = await flow.handle({ dialogId: "d1", chatId: "model-chat-1" });

    expect(second).toEqual(first);
    expect(requirements.saveCalls).toBe(1);
    expect(queued.size).toBe(1);
  });

  it("одновременные нажатия публикуют версию один раз", async () => {
    const { flow, requirements } = setup();

    const replies = await Promise.all([
      flow.handle({ dialogId: "d1", chatId: "model-chat-1" }),
      flow.handle({ dialogId: "d1", chatId: "model-chat-1" }),
    ]);

    expect(requirements.saveCalls).toBe(1);
    expect(replies[1]).toEqual(replies[0]);
  });

  it("если изменение не касается компании, честно говорит об этом и подсказывает модельный ИНН", async () => {
    const { flow, queued } = setup({ newStatus: "not_applies" });

    const reply = await flow.handle({ dialogId: "d1", chatId: "model-chat-1" });

    expect(queued.size).toBe(0);
    expect(reply.text).toContain("Вашей компании это изменение не касается:");
    expect(reply.text).toContain("ОКВЭД начинается с 56 — не выполнено");
    expect(reply.text).toContain("модельный ИНН 7700000016");
    expect(reply.text).not.toContain("🔔");
  });

  it("говорит, что уведомление ушло в другой чат, если кнопку раньше нажали там", async () => {
    const { flow } = setup();

    await flow.handle({ dialogId: "d1", chatId: "model-chat-1" });
    const reply = await flow.handle({ dialogId: "d2", chatId: "model-chat-2" });

    expect(reply.text).toContain("для чата, где кнопку нажали первым");
  });

  it("без компании просит ИНН и ничего не публикует", async () => {
    const { flow, requirements, runNotifications } = setup({ company: undefined });

    const reply = await flow.handle({ dialogId: "d1", chatId: "model-chat-1" });

    expect(reply.stateOverride).toBe("idle");
    expect(reply.text).toContain("сначала укажите ИНН");
    expect(requirements.saveCalls).toBe(0);
    expect(runNotifications).not.toHaveBeenCalled();
  });

  it("без предыдущей версии пакета не публикует: первая публикация уведомлений не даёт", async () => {
    const { flow, requirements, runNotifications } = setup();
    requirements.versions.clear();

    const reply = await flow.handle({ dialogId: "d1", chatId: "model-chat-1" });

    expect(reply.text).toContain("Демонстрация сейчас недоступна");
    expect(requirements.saveCalls).toBe(0);
    expect(runNotifications).not.toHaveBeenCalled();
  });
});

describe("DemoRecipientDirectory", () => {
  it("чат демо-нажатия важнее основного справочника", async () => {
    const directory = new DemoRecipientDirectory({ chatFor: async (id) => (id === "a" ? "base-a" : undefined) });
    directory.remember("b", "demo-b");
    directory.remember("a", "demo-a");

    expect(await directory.chatFor("a")).toBe("demo-a");
    expect(await directory.chatFor("b")).toBe("demo-b");
    expect(await directory.chatFor("c")).toBeUndefined();
  });
});
