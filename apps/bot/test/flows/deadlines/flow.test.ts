// 2-21: очередь действий и отправка в MAX модельные; реальные внешние сервисы не вызываются.
import { describe, expect, it, vi } from "vitest";
import { createBotApp, createMemoryDialogStateStore } from "../../../src/app/index.js";
import type { FlowReply } from "../../../src/flows/checklist/index.js";
import {
  type ActionQueueSource,
  type ActionQueueView,
  createDeadlinesFlow,
  DEADLINES_START_PAYLOAD,
} from "../../../src/flows/deadlines/index.js";
import { InMemoryOnboardingSessions } from "../../../src/flows/onboarding/index.js";
import { createMemorySettingsStore } from "../../../src/flows/settings/index.js";
import { encodeButtonPayload, type TransportLogger, toDialogEvent } from "../../../src/transport/index.js";

const COMPANY = "7700000016";
const CHAT = "model-coffee-chat";
const SOURCE = "https://pravo.gov.ru/model/deadline";

const base = (id: string, title: string, deadline: string) => ({
  companyId: COMPANY,
  requirementId: id,
  kind: "obligation" as const,
  title,
  deadline,
  basis: [{ act: "Модельный закон", url: `${SOURCE}/${id}` }],
  isModel: true,
});

const queue = (): ActionQueueView => ({
  companyId: COMPANY,
  asOf: "2026-09-29",
  actions: [
    { ...base("today", "Проверить температуру", "ежедневно"), dueDate: "2026-09-29", dueAction: "Проверить сегодня" },
    { ...base("dated", "Подать отчёт", "до 2026-10-01"), dueDate: "2026-10-01" },
  ],
  undated: [
    { ...base("event-1", "Проверить поставку 1", "при каждой поставке"), reason: "event", detail: "при поставке" },
    { ...base("event-2", "Проверить поставку 2", "при каждой поставке"), reason: "event", detail: "при поставке" },
    { ...base("event-3", "Проверить поставку 3", "при каждой поставке"), reason: "event", detail: "при поставке" },
    { ...base("event-4", "Проверить поставку 4", "при каждой поставке"), reason: "event", detail: "при поставке" },
    { ...base("event-5", "Проверить поставку 5", "при каждой поставке"), reason: "event", detail: "при поставке" },
    { ...base("continuous", "Соблюдать санитарные требования", "постоянно"), reason: "continuous" },
    {
      ...base("periodic", "Провести медосмотр", "один раз в год"),
      reason: "periodic_without_last_date",
      detail: "ежегодно",
    },
  ],
});

const sourceFor = (value: ActionQueueView): ActionQueueSource => ({
  build: vi.fn(async () => ({ status: "ok" as const, queue: value })),
});

describe("flow «Что и когда делать»", () => {
  it("показывает честные группы, сроки, источники и сворачивает длинную группу", async () => {
    const source = sourceFor(queue());
    const flow = createDeadlinesFlow({ queue: source, companyOf: async () => COMPANY });

    const reply = await flow.handle(CHAT, DEADLINES_START_PAYLOAD);

    expect(source.build).toHaveBeenCalledWith(COMPANY);
    expect(reply?.text).toContain("Сегодня — 29.09.2026");
    expect(reply?.text).toContain("По дате — 01.10.2026");
    expect(reply?.text).toContain("При событии");
    expect(reply?.text).toContain("Событие: при поставке");
    expect(reply?.text).toContain("Постоянно");
    expect(reply?.text).toContain("Периодически — нужна дата последнего исполнения");
    expect(reply?.text).toContain("Срок: ежедневно");
    expect(reply?.text).toContain("Источник: https://pravo.gov.ru/model/deadline/today");
    expect(reply?.text).toContain("МОДЕЛЬНЫЕ ДАННЫЕ");
    expect(reply?.text).toContain("… ещё 2");
    expect(reply?.buttons.map((button) => button.text)).toContain("Ещё 2: При событии");
  });

  it("по кнопке «ещё N» открывает полный перечень группы и возвращает к срокам", async () => {
    const flow = createDeadlinesFlow({ queue: sourceFor(queue()), companyOf: async () => COMPANY });
    const overview = await flow.handle(CHAT, DEADLINES_START_PAYLOAD);
    const more = overview?.buttons.find((button) => button.text.startsWith("Ещё 2:"));
    if (!more || !("payload" in more)) throw new Error("Нет кнопки длинной группы");

    const reply = await flow.handle(CHAT, more.payload);

    expect(reply?.text).toContain("Проверить поставку 1");
    expect(reply?.text).toContain("Проверить поставку 5");
    expect(reply?.sourceUrls).toHaveLength(5);
    expect(reply?.buttons.map((button) => button.text)).toEqual(["← К срокам", "🏠 Меню"]);
  });

  it("для пустой очереди даёт понятный ответ", async () => {
    const empty = { ...queue(), actions: [], undated: [] };
    const flow = createDeadlinesFlow({ queue: sourceFor(empty), companyOf: async () => COMPANY });

    const reply = await flow.handle(CHAT, DEADLINES_START_PAYLOAD);

    expect(reply?.text).toContain("Применимых обязанностей со сроком сейчас нет");
    expect(reply?.buttons.map((button) => button.text)).toEqual(["🏠 Меню"]);
  });

  it("без компании просит ИНН, а чужой payload не перехватывает", async () => {
    const source = sourceFor(queue());
    const flow = createDeadlinesFlow({ queue: source, companyOf: async () => undefined });

    expect((await flow.handle(CHAT, DEADLINES_START_PAYLOAD))?.text).toContain("сначала укажите ИНН");
    expect(await flow.handle(CHAT, "another:payload")).toBeUndefined();
    expect(source.build).not.toHaveBeenCalled();
  });
});

const silent: TransportLogger = { info: () => {}, warn: () => {}, error: () => {} };

const appWith = async (deadlineSource?: ActionQueueSource) => {
  const sessions = new InMemoryOnboardingSessions();
  const states = createMemoryDialogStateStore();
  await sessions.bindCompany(CHAT, COMPANY);
  await states.saveState(CHAT, "menu");
  const sent: FlowReply[] = [];
  const app = createBotApp({
    profiles: {
      lookup: async () => {
        throw new Error("не используется");
      },
      confirm: async () => {
        throw new Error("не используется");
      },
      declare: async () => ({ status: "ok" }),
    },
    checklist: { build: async () => ({ status: "profile_not_found" }) },
    settings: createMemorySettingsStore(),
    sessions,
    states,
    logger: silent,
    reply: { send: async (_chatId, reply) => void sent.push(reply) },
    ...(deadlineSource ? { deadlines: { queue: deadlineSource } } : {}),
  });
  let index = 0;
  const receive = async (payload: string) => {
    const event = {
      kind: "callback" as const,
      eventId: `event-${++index}`,
      callbackId: `callback-${index}`,
      chatId: CHAT,
      userId: "model-user",
      occurredAt: "2026-09-29T10:00:00Z",
      payload,
    };
    await app.handle({ event, dialogEvent: toDialogEvent(event) });
    return sent.at(-1) as FlowReply;
  };
  return { receive };
};

describe("подключение через BOT_FEATURES", () => {
  it("с зависимостью добавляет ровно одну кнопку и обрабатывает payload", async () => {
    const source = sourceFor(queue());
    const { receive } = await appWith(source);

    const menu = await receive(encodeButtonPayload({ type: "home" }));
    expect(menu.buttons.filter((button) => button.text === "📅 Что и когда")).toHaveLength(1);

    const reply = await receive(DEADLINES_START_PAYLOAD);
    expect(reply.text).toContain("Что и когда делать");
    expect(source.build).toHaveBeenCalledWith(COMPANY);
  });

  it("без зависимости не показывает кнопку и не обрабатывает даже подставленный payload", async () => {
    const { receive } = await appWith();

    const menu = await receive(encodeButtonPayload({ type: "home" }));
    expect(menu.buttons.map((button) => button.text)).not.toContain("📅 Что и когда");

    const reply = await receive(DEADLINES_START_PAYLOAD);
    expect(reply.text).toContain("Не понял сообщение");
    expect(reply.buttons.map((button) => button.text)).not.toContain("📅 Что и когда");
  });
});
