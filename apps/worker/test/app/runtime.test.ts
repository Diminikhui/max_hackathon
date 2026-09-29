// K-30b: весь процесс на PGlite — бот, сервисы, демо-кнопка K-29, контур K-30a и очередь отправки.
// Все компании и чаты модельные (K-28); MAX не вызывается: ответы диалога и уведомления собираются в массивы.
import { PGlite } from "@electric-sql/pglite";
import type { BotReplyPort } from "@max-hackathon/bot/dist/app/index.js";
import type { FlowReply } from "@max-hackathon/bot/dist/flows/checklist/index.js";
import { DEMO_CHANGE_CALLBACK_PAYLOAD } from "@max-hackathon/bot/dist/flows/demo/index.js";
import { type InboundEvent, toDialogEvent } from "@max-hackathon/bot/dist/transport/index.js";
import type { CompanyProfile, ProfileSource } from "@max-hackathon/domain";
import { createPgliteClient } from "@max-hackathon/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withModelPackBoundary } from "../../src/app/rulepacks.js";
import { type AppAssembly, assembleApp } from "../../src/app/runtime.js";
import { FakeMessageSender } from "../../src/sender/queue/index.js";

const NOW = new Date("2026-09-29T10:00:00.000Z");
const CAFE_INN = "7700000016";
const AUTOSERVICE_INN = "7700000023";
const DEMO_BUTTON = "🧪 Показать пример изменения (модельное)";

const silent = { info: () => {}, warn: () => {}, error: () => {} };
/** Реальный источник в тестах не нужен: все ИНН модельные. */
const noRealSource: ProfileSource = {
  info: { name: "msp", isModel: false },
  lookupByInn: async () => {
    throw new Error("в тесте реестр МСП не вызывается");
  },
};

let db: PGlite;
let app: AppAssembly;
let sender: FakeMessageSender;
const replies: { chatId: string; reply: FlowReply }[] = [];

const assemble = async () => {
  sender = new FakeMessageSender();
  const reply: BotReplyPort = {
    send: async (chatId, message) => {
      replies.push({ chatId, reply: message });
      return { messageId: `m${replies.length}`, text: message.text };
    },
  };
  return assembleApp({
    db: createPgliteClient(db),
    reply,
    sender,
    logger: silent,
    realSource: noRealSource,
    now: () => NOW,
  });
};

beforeEach(async () => {
  db = new PGlite();
  replies.length = 0;
  app = await assemble();
});
afterEach(() => db.close());

const chat = (chatId: string) => {
  let counter = 0;
  const base = () => ({
    eventId: `${chatId}-${++counter}`,
    chatId,
    userId: `user-${chatId}`,
    occurredAt: NOW.toISOString(),
  });
  const receive = async (event: InboundEvent): Promise<FlowReply> => {
    await app.bot.handle({ event, dialogEvent: toDialogEvent(event) });
    const last = replies.filter((item) => item.chatId === chatId).at(-1);
    if (!last) throw new Error(`нет ответа в чате ${chatId}`);
    return last.reply;
  };
  const last = () => replies.filter((item) => item.chatId === chatId).at(-1)?.reply as FlowReply;
  const press = (text: string) => {
    const button = last().buttons.find((candidate) => candidate.text === text);
    if (button === undefined || !("payload" in button)) {
      throw new Error(
        `Нет кнопки «${text}»: ${last()
          .buttons.map((b) => b.text)
          .join(", ")}`,
      );
    }
    return receive({ kind: "callback", callbackId: `cb-${chatId}-${counter}`, payload: button.payload, ...base() });
  };
  /** Нажатие кнопки из любого прежнего сообщения. */
  const pressPayload = (payload: string) =>
    receive({ kind: "callback", callbackId: `cb-${chatId}-${counter}`, payload, ...base() });
  const onboard = async (inn: string) => {
    await receive({ kind: "started", ...base() });
    await receive({ kind: "text", text: inn, ...base() });
    return press("✅ Всё верно");
  };
  return { press, pressPayload, onboard, last };
};

/** Прогон очереди отправки: сколько уведомлений ушло в модельный MAX. */
const flushQueue = async () => {
  await app.queue.processBatch();
  return sender.calls.length;
};

const queuedChats = async () =>
  (await app.notifications.listQueued(100)).map((notification) => notification.recipient.chatId).sort();

describe("процесс K-30b на модельных данных", () => {
  it("меню содержит демо-кнопку, перечень кафе строится из реальных пакетов и модельного k28", async () => {
    const cafe = chat("1001");
    const menu = await cafe.onboard(CAFE_INN);
    expect(menu.buttons.map((b) => b.text)).toContain(DEMO_BUTTON);

    const list = await cafe.press("📋 Мой перечень");
    expect(list.text).toContain("МОДЕЛЬНЫЕ ДАННЫЕ");
    expect(list.buttons.at(-1)?.text).toBe("🏠 Меню");
  });

  it("демо не «сгорает»: автосервис нажал первым, кафе всё равно получает push", async () => {
    const autoservice = chat("2001");
    await autoservice.onboard(AUTOSERVICE_INN);
    const notConcerned = await autoservice.press(DEMO_BUTTON);
    expect(notConcerned.text).toContain("МОДЕЛЬН");
    expect(await queuedChats()).toEqual([]);

    const cafe = chat("2002");
    await cafe.onboard(CAFE_INN);
    const concerned = await cafe.press(DEMO_BUTTON);
    expect(concerned.text).toContain("приходит в этот чат");
    expect(await queuedChats()).toEqual(["2002"]);
    expect(await flushQueue()).toBe(1);
  });

  it("второй чат с тем же ИНН получает свой push, повторные нажатия дублей не дают", async () => {
    const first = chat("3001");
    await first.onboard(CAFE_INN);
    await first.press(DEMO_BUTTON);

    const second = chat("3002");
    await second.onboard(CAFE_INN);
    const reply = await second.press(DEMO_BUTTON);
    expect(reply.text).toContain("приходит в этот чат");

    expect(await queuedChats()).toEqual(["3001", "3002"]);
    expect(await flushQueue()).toBe(2);

    // Повтор в обоих чатах: новых уведомлений нет.
    await first.pressPayload(DEMO_CHANGE_CALLBACK_PAYLOAD);
    await second.pressPayload(DEMO_CHANGE_CALLBACK_PAYLOAD);
    expect(await queuedChats()).toEqual([]);
    expect(await flushQueue()).toBe(2);
  });

  it("повторный старт процесса не откатывает опубликованную демо-версию и не дублирует пакеты", async () => {
    const cafe = chat("4001");
    await cafe.onboard(CAFE_INN);
    await cafe.press(DEMO_BUTTON);

    app = await assemble();
    const again = chat("4002");
    await again.onboard(CAFE_INN);
    const reply = await again.press(DEMO_BUTTON);
    expect(reply.text).toContain("приходит в этот чат");
  });
});

describe("граница модельных пакетов", () => {
  it("реальной компании модельные пакеты не показываются, модельной — показываются", async () => {
    const calls: (readonly string[] | undefined)[] = [];
    const service = {
      build: async (_companyId: string, options?: { readonly packIds?: readonly string[] }) => {
        calls.push(options?.packIds);
        return "ok";
      },
    };
    const profiles = {
      get: async (companyId: string) => ({ companyId, isModel: companyId === "model" }) as CompanyProfile,
    };
    const requirements = { listPackIds: async () => ["a-foodservice-fed", "k28-model"] };
    const checklist = withModelPackBoundary(service, profiles, requirements, new Set(["k28-model"]));

    await checklist.build("real");
    await checklist.build("model");

    expect(calls).toEqual([["a-foodservice-fed"], undefined]);
  });
});
