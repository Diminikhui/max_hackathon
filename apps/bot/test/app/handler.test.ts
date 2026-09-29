// K-30b: сквозной диалог через сборку бота на модельных сервисах K-28 (ИНН 1600000011 — кафе в Казани).
// Отправка в MAX модельная: ответы собираются в массив, реальный MAX не вызывается.
import { describe, expect, it } from "vitest";
import { createBotApp, layoutButtons } from "../../src/app/index.js";
import type { FlowReply } from "../../src/flows/checklist/index.js";
import { createMemorySettingsStore } from "../../src/flows/settings/index.js";
import type { InboundEvent, TransportLogger } from "../../src/transport/index.js";
import { toDialogEvent } from "../../src/transport/index.js";
import { createK28Services } from "../flows/clarify/support/k28.js";

const CHAT = "100500";
const KZN_INN = "1600000011";

const silent: TransportLogger = { info: () => {}, warn: () => {}, error: () => {} };

const setup = (options: { readonly answerWorks?: boolean } = {}) => {
  const services = createK28Services();
  const settings = createMemorySettingsStore();
  const sent: { chatId: string; reply: FlowReply; via: "send" | "answer" }[] = [];
  const app = createBotApp({
    profiles: services.profiles,
    checklist: services.checklist,
    settings,
    logger: silent,
    reply: {
      send: async (chatId, reply) => {
        sent.push({ chatId, reply, via: "send" });
      },
      answer: async (_callbackId, reply) => {
        if (options.answerWorks === false) return false;
        sent.push({ chatId: CHAT, reply, via: "answer" });
        return true;
      },
    },
  });

  let counter = 0;
  const base = (chatId = CHAT) => ({
    eventId: `e${++counter}`,
    chatId,
    userId: "model-user",
    occurredAt: "2026-09-29T10:00:00Z",
  });
  const receive = async (event: InboundEvent): Promise<FlowReply> => {
    const before = sent.length;
    await app.handle({ event, dialogEvent: toDialogEvent(event) });
    expect(sent.length, "на событие должен прийти ровно один ответ").toBe(before + 1);
    return (sent.at(-1) as { reply: FlowReply }).reply;
  };
  const last = () => (sent.at(-1) as { reply: FlowReply }).reply;
  const press = (text: string, reply: FlowReply = last()) => {
    const button = reply.buttons.find((candidate) => candidate.text === text);
    if (button === undefined || !("payload" in button)) {
      throw new Error(`Нет кнопки «${text}»: ${reply.buttons.map((b) => b.text).join(", ")}`);
    }
    return receive({ kind: "callback", callbackId: `cb${counter}`, payload: button.payload, ...base() });
  };
  const type = (text: string) => receive({ kind: "text", text, ...base() });
  const start = () => receive({ kind: "started", ...base() });

  const onboard = async () => {
    const asked = await start();
    expect(asked.text).toContain("ИНН");
    await type(KZN_INN);
    return press("✅ Всё верно");
  };

  return { app, services, settings, sent, press, type, start, onboard, last };
};

describe("сборка бота K-30b", () => {
  it("проводит от старта до меню и привязывает чат к компании для уведомлений", async () => {
    const { app, onboard, services } = setup();

    const menu = await onboard();

    expect(app.stateOf(CHAT)).toBe("menu");
    expect(menu.buttons.map((b) => b.text)).toContain("📋 Мой перечень");
    const companyId = (await services.repository.findByInn(KZN_INN))?.companyId;
    expect(companyId).toBeDefined();
    expect(await app.directory.chatFor(companyId as string)).toBe(CHAT);
  });

  it("под перечнем с «недостаточно данных» есть «❔ Уточнить данные», и уточнение отвечает с первоисточником", async () => {
    const { app, onboard, press } = setup();
    await onboard();

    const list = await press("📋 Мой перечень");
    expect(app.stateOf(CHAT)).toBe("requirement_list");
    const texts = list.buttons.map((b) => b.text);
    expect(texts).toContain("❔ Уточнить данные");
    expect(texts.at(-1)).toBe("🏠 Меню");

    const question = await press("❔ Уточнить данные");
    expect(question.text).toContain("Есть ли у вас работники");

    const answered = await press("Да");
    expect(answered.text).toContain("Записали по вашим словам");
    expect(answered.text).toContain("Первоисточник:");
    expect(answered.sourceUrls.length).toBeGreaterThan(0);
  });

  it("настройки: отключение сохраняется для компании, диалог возвращается в меню настроек", async () => {
    const { app, onboard, press, settings, services } = setup();
    await onboard();

    await press("🔔 Уведомления");
    expect(app.stateOf(CHAT)).toBe("notification_settings");
    const saved = await press("🔕 Отключить уведомления");
    expect(saved.text).toContain("Уведомления отключены");

    const companyId = (await services.repository.findByInn(KZN_INN))?.companyId as string;
    expect((await settings.settingsFor(companyId))?.enabled).toBe(false);
  });

  it("непонятный текст на экране перечня не остаётся без ответа", async () => {
    const { app, onboard, press, type } = setup();
    await onboard();
    await press("📋 Мой перечень");

    const reply = await type("что это вообще");

    expect(reply.text).toContain("Не понял сообщение");
    expect(reply.buttons.length).toBeGreaterThan(0);
    expect(app.stateOf(CHAT)).toBe("menu");
  });

  it("нажатие кнопки заменяет сообщение ответом на callback, при сбое — новым сообщением", async () => {
    const works = setup();
    await works.onboard();
    expect(works.sent.at(-1)?.via).toBe("answer");

    const broken = setup({ answerWorks: false });
    await broken.onboard();
    expect(broken.sent.at(-1)?.via).toBe("send");
  });

  it("без демо-зависимостей кнопки демо в меню нет", async () => {
    const { onboard } = setup();
    const menu = await onboard();
    expect(menu.buttons.map((b) => b.text)).not.toContain("🧪 Показать пример изменения (модельное)");
  });
});

describe("раскладка клавиатуры", () => {
  it("номера — в общий ряд до 7, длинные подписи — по одной в ряд", () => {
    const numbers = Array.from({ length: 9 }, (_, index) => ({ text: String(index + 1), payload: `d:${index}` }));
    const rows = layoutButtons([...numbers, { text: "🏠 Меню", payload: "d:home" }]);
    expect(rows.map((row) => row.length)).toEqual([7, 2, 1]);
    expect(rows[2]?.[0]).toEqual({ type: "callback", text: "🏠 Меню", payload: "d:home" });
  });

  it("ссылка превращается в link-кнопку MAX", () => {
    expect(layoutButtons([{ text: "Первоисточник", url: "https://pravo.gov.ru/" }])).toEqual([
      [{ type: "link", text: "Первоисточник", url: "https://pravo.gov.ru/" }],
    ]);
  });
});
