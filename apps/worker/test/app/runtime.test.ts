// K-30b: весь процесс на PGlite — бот, сервисы, демо-кнопка K-29, контур K-30a и очередь отправки.
// Все компании и чаты модельные (K-28); MAX не вызывается: ответы диалога и уведомления собираются в массивы.
import { PGlite } from "@electric-sql/pglite";
import type { BotReplyPort } from "@max-hackathon/bot/dist/app/index.js";
import type { FlowReply } from "@max-hackathon/bot/dist/flows/checklist/index.js";
import { DEMO_CHANGE_CALLBACK_PAYLOAD } from "@max-hackathon/bot/dist/flows/demo/index.js";
import { type InboundEvent, toDialogEvent } from "@max-hackathon/bot/dist/transport/index.js";
import type { CompanyProfile, ProfileSource } from "@max-hackathon/domain";
import { createPgliteClient, PostgresBotDialogRepository } from "@max-hackathon/storage";
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
  const send = (text: string) => receive({ kind: "text", text, ...base() });
  return { press, pressPayload, onboard, send, last };
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

describe("перезапуск процесса (#312): состояние хранится в PostgreSQL", () => {
  /** Новая сборка на той же базе — то же, что перезапуск контейнера. */
  const restart = async () => {
    app = await assemble();
  };

  it("диалог продолжается с того же места: привязка и состояние сохранены", async () => {
    const cafe = chat("5001");
    await cafe.onboard(CAFE_INN);
    await restart();

    expect(await app.bot.stateOf("5001")).toBe("menu");
    const list = await cafe.press("📋 Мой перечень");
    expect(list.text).toContain("МОДЕЛЬНЫЕ ДАННЫЕ");
    expect(await app.bot.stateOf("5001")).toBe("requirement_list");
  });

  it("чат компании для push сохраняется", async () => {
    const cafe = chat("5002");
    await cafe.onboard(CAFE_INN);
    const companyId = await new PostgresBotDialogRepository(createPgliteClient(db)).companyOf("5002");
    expect(companyId).toBeDefined();
    await restart();

    expect(await app.bot.directory.chatFor(companyId as string)).toBe("5002");
  });

  it("отключение уведомлений действует и после перезапуска", async () => {
    const cafe = chat("5003");
    await cafe.onboard(CAFE_INN);
    await cafe.press("🔔 Уведомления");
    await cafe.press("🔕 Отключить уведомления");
    await restart();

    const settings = await cafe.press("🔔 Настройки");
    expect(settings.buttons.map((b) => b.text)).toContain("🔔 Включить уведомления");

    await cafe.pressPayload(DEMO_CHANGE_CALLBACK_PAYLOAD);
    expect(await queuedChats()).toEqual([]);
    expect(await flushQueue()).toBe(0);
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

describe("модельная компания начинается с фикстуры", () => {
  const KAZAN_CAFE_INN = "1600000011";
  const TAX_QUESTION = "Какой у вас налоговый режим?";

  it("ответы на уточнения прошлого проверяющего не переносятся: вопросы задаются заново", async () => {
    const first = chat("6001");
    await first.onboard(KAZAN_CAFE_INN);
    await first.press("📋 Мой перечень");
    expect((await first.press("❔ Уточнить данные")).text).toContain(TAX_QUESTION);
    expect((await first.press("ОСНО")).text).toContain("по вашим словам");

    const second = chat("6002");
    await second.onboard(KAZAN_CAFE_INN);
    await second.press("📋 Мой перечень");
    expect((await second.press("❔ Уточнить данные")).text).toContain(TAX_QUESTION);
  });

  it("повторный выбор той же компании в том же чате снова даёт вопросы", async () => {
    const cafe = chat("6003");
    await cafe.onboard(KAZAN_CAFE_INN);
    await cafe.press("📋 Мой перечень");
    await cafe.press("❔ Уточнить данные");
    await cafe.press("ОСНО");

    await cafe.press("🏠 Меню");
    await cafe.press("🔄 Другая компания");
    await cafe.send(KAZAN_CAFE_INN);
    await cafe.press("✅ Всё верно");
    await cafe.press("📋 Мой перечень");
    expect((await cafe.press("❔ Уточнить данные")).text).toContain(TAX_QUESTION);
  });
});

describe("K-34: пояснение о покрытии над перечнем", () => {
  it("ОКВЭД вне направлений: перечень объясняет, почему он пуст, и предлагает тестовые ИНН", async () => {
    const shop = chat("7001");
    await shop.onboard("770000000082");
    const list = await shop.press("📋 Мой перечень");
    expect(list.text).toContain("пока не входит в проверяемые направления");
    expect(list.text).toContain("Сейчас бот проверяет общепит (ОКВЭД 56) и автосервис (ОКВЭД 45.2).");
  });

  it("покрытые направление и регион: перечень без пояснения", async () => {
    const cafe = chat("7002");
    await cafe.onboard(CAFE_INN);
    const list = await cafe.press("📋 Мой перечень");
    expect(list.text).not.toContain("проверяемые направления");
    expect(list.text).not.toContain("вне покрытия — показаны только федеральные");
  });
});
