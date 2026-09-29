// K-30c: основной сценарий «Пульса» через настоящий процесс: HTTP webhook → проверка secret → диалог → уточнения →
// демо-триггер → push из очереди отправки. MAX и реестры модельные (K-28); реальные сервисы не вызываются.

import { DEMO_CHANGE_CALLBACK_PAYLOAD } from "@max-hackathon/bot/dist/flows/demo/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTOSERVICE_INN,
  CAFE_INN,
  DEMO_BUTTON,
  KAZAN_CAFE_INN,
  type Stand,
  startStand,
  WEBHOOK_SECRET,
} from "./support/harness.js";

let stand: Stand;

afterEach(async () => {
  await stand.stop();
});

describe("webhook и здоровье процесса", () => {
  beforeEach(async () => {
    stand = await startStand();
  });

  it("GET /health отвечает 200", async () => {
    const response = await fetch(`http://127.0.0.1:${stand.port}/health`);
    expect(response.status).toBe(200);
  });

  it("без secret и с неверным secret — 403, бот не отвечает", async () => {
    const update = { update_type: "bot_started", timestamp: Date.now(), chat_id: 1, user: { user_id: 2 } };
    expect(await stand.post(update, null)).toBe(403);
    expect(await stand.post(update, "wrong_secret_value")).toBe(403);
    await stand.quiet(300);
    expect(stand.max.messages).toHaveLength(0);
  });

  it("неподдерживаемое обновление принимается (200) и молча пропускается", async () => {
    expect(await stand.post({ update_type: "user_added", timestamp: Date.now(), chat_id: 1 })).toBe(200);
    await stand.quiet(300);
    expect(stand.max.messages).toHaveLength(0);
  });

  it("повторная доставка того же обновления не даёт второго ответа", async () => {
    const update = { update_type: "bot_started", timestamp: 1_790_000_000_000, chat_id: 4242, user: { user_id: 7 } };
    expect(await stand.post(update)).toBe(200);
    await stand.waitFor("первый ответ", () => stand.max.dialog("4242").length === 1);
    expect(await stand.post(update)).toBe(200);
    await stand.quiet(500);
    expect(stand.max.dialog("4242")).toHaveLength(1);
    expect(WEBHOOK_SECRET.length).toBeGreaterThan(4);
  });
});

describe("основной сценарий: ИНН → уточнения → смена компании → демо → push", () => {
  beforeEach(async () => {
    stand = await startStand();
  });

  it("проходит весь путь в одном чате", async () => {
    const chat = stand.chat("100500");

    // 1. Старт и онбординг кафе в Казани: у него нет данных о работниках и алкоголе.
    const welcome = await chat.start();
    expect(welcome.text).toContain("ИНН");
    const card = await chat.say(KAZAN_CAFE_INN);
    expect(card.text).toContain(KAZAN_CAFE_INN);
    expect(card.text).toContain("МОДЕЛЬН");
    const menu = await chat.press("✅ Всё верно");
    expect(menu.buttons.map((button) => button.text)).toEqual(
      expect.arrayContaining(["📋 Мой перечень", "🔔 Уведомления", "🔄 Другая компания", DEMO_BUTTON]),
    );

    // 2. Перечень с записями «недостаточно данных» и кнопкой уточнения.
    const list = await chat.press("📋 Мой перечень");
    expect(list.text).toContain("Недостаточно данных");
    expect(list.buttons.map((button) => button.text)).toContain("❔ Уточнить данные");

    // 3. Уточнение: подключённый налоговый пакет сначала спрашивает режим, затем работников и алкоголь.
    // Каждый ответ сопровождается ссылкой на первоисточник.
    const first = await chat.press("❔ Уточнить данные");
    expect(first.text).toContain("Какой у вас налоговый режим?");
    const second = await chat.press("ОСНО");
    expect(second.text).toContain("Записали по вашим словам: ОСНО.");
    expect(second.text).toContain("Первоисточник:");
    expect(second.text).toContain("Есть ли у вас работники");
    const third = await chat.press("Да");
    expect(third.text).toContain("Записали по вашим словам: есть работники.");
    expect(third.text).toContain("Первоисточник:");
    expect(third.text).toContain("Продаёте ли вы алкоголь?");
    const done = await chat.press("Только пиво, сидр, медовуху");
    expect(done.text).toContain("Записали по вашим словам: продаёте пиво, сидр или медовуху.");
    expect(done.text).toContain("Ваш перечень");

    // 4. Кнопка старого сообщения, которую бот не смог заменить (её сообщение неизвестно боту), не переписывает
    //    уже данный ответ. Быстрый повтор кнопки из только что заменённого сообщения игнорируется (см. ниже).
    const staleButton = first.buttons.find((button) => button.text === "Патент");
    const stale = await chat.pressPayload(staleButton?.payload as string);
    expect(stale?.text).toContain("Эта кнопка устарела");

    // 5. Смена компании на московскую кофейню, которой демо-изменение касается.
    const back = await chat.press("🏠 Меню");
    expect(back.buttons.map((button) => button.text)).toContain("🔄 Другая компания");
    await chat.press("🔄 Другая компания");
    await chat.say(CAFE_INN);
    await chat.press("✅ Всё верно");

    // 6. Демо-триггер: сразу ответ в чате, затем push из очереди.
    const demo = await chat.press(DEMO_BUTTON);
    expect(demo.text).toContain("МОДЕЛЬНОЕ ИЗМЕНЕНИЕ");
    expect(demo.text).toContain("приходит в этот чат");
    // Кнопка «Открыть карточку» скрыта, пока корень сайта отдаёт страницу K-05b (Issue #347).
    expect(demo.buttons.map((button) => button.text)).not.toContain("Открыть карточку");
    await stand.waitFor("push из очереди", () => stand.max.pushes("100500").length === 1);
    const push = stand.max.pushes("100500")[0];
    expect(push?.text).toContain("🔔 Изменение");
    expect(push?.text).toContain("МОДЕЛЬНЫЕ ДАННЫЕ");
    expect(push?.text).toContain("Первоисточник");
    expect(push?.text).toContain("Текст сформирован автоматически");

    // 7. Повтор нажатия: ответ тот же, второго push нет.
    const again = await chat.pressPayload(DEMO_CHANGE_CALLBACK_PAYLOAD);
    expect(again?.text).toContain("МОДЕЛЬНОЕ ИЗМЕНЕНИЕ");
    await stand.quiet();
    expect(stand.max.pushes("100500")).toHaveLength(1);
  });

  it("кнопки активны только у последнего сообщения бота, нажатия подтверждаются", async () => {
    const chat = stand.chat("200500");
    await chat.onboard(KAZAN_CAFE_INN);
    await chat.press("📋 Мой перечень");

    const dialog = stand.max.dialog("200500");
    const last = dialog.at(-1);
    expect(dialog.length).toBeGreaterThan(3);
    // Снятие кнопок уходит в MAX уже после отправки нового сообщения: ждём, а не проверяем мгновенно.
    await stand.waitFor("кнопки у прежних сообщений сняты", () =>
      dialog.every((message) => message === last || message.buttons.length === 0 || message.keyboardRemoved),
    );
    expect(last?.keyboardRemoved, "у последнего кнопки остаются").toBe(false);
    // Каждое нажатие подтверждено (`POST /answers`): «Всё верно» и «Мой перечень».
    await stand.waitFor("подтверждения нажатий", () => stand.max.acknowledged.length === 2);
  });
});

describe("демо-триггер для нескольких проверяющих", () => {
  beforeEach(async () => {
    stand = await startStand();
  });

  it("автосервис нажал демо первым — кафе всё равно получает ровно один push", async () => {
    const autoservice = stand.chat("300001");
    await autoservice.onboard(AUTOSERVICE_INN);
    const notConcerned = await autoservice.press(DEMO_BUTTON);
    expect(notConcerned.text).toContain("МОДЕЛЬН");
    await stand.quiet(1_500);
    expect(stand.max.pushes("300001")).toHaveLength(0);

    const cafe = stand.chat("300002");
    await cafe.onboard(CAFE_INN);
    const concerned = await cafe.press(DEMO_BUTTON);
    expect(concerned.text).toContain("приходит в этот чат");
    await stand.waitFor("push кафе", () => stand.max.pushes("300002").length === 1);

    await cafe.pressPayload(DEMO_CHANGE_CALLBACK_PAYLOAD);
    await stand.quiet();
    expect(stand.max.pushes("300002")).toHaveLength(1);
    expect(stand.max.pushes("300001")).toHaveLength(0);
  });

  it("второй чат с тем же ИНН получает свой push, а не сообщение «ушло в другой чат»", async () => {
    const first = stand.chat("400001");
    await first.onboard(CAFE_INN);
    await first.press(DEMO_BUTTON);
    await stand.waitFor("push первого чата", () => stand.max.pushes("400001").length === 1);

    const second = stand.chat("400002");
    await second.onboard(CAFE_INN);
    const reply = await second.press(DEMO_BUTTON);
    expect(reply.text).toContain("приходит в этот чат");
    await stand.waitFor("push второго чата", () => stand.max.pushes("400002").length === 1);

    await stand.quiet();
    expect(stand.max.pushes("400001")).toHaveLength(1);
    expect(stand.max.pushes("400002")).toHaveLength(1);
  });

  it("отключённые уведомления: демо отвечает в чате, push не приходит", async () => {
    const chat = stand.chat("500001");
    await chat.onboard(CAFE_INN);
    await chat.press("🔔 Уведомления");
    const saved = await chat.press("🔕 Отключить уведомления");
    expect(saved.text).toContain("Уведомления отключены");

    const demo = await chat.press(DEMO_BUTTON);
    expect(demo.text).toContain("МОДЕЛЬНОЕ ИЗМЕНЕНИЕ");
    await stand.quiet();
    expect(stand.max.pushes("500001")).toHaveLength(0);
  });
});

describe("правки по ручному прогону в MAX", () => {
  beforeEach(async () => {
    stand = await startStand();
  });

  it("три быстрых нажатия одной кнопки дают один ответ, все подтверждены", async () => {
    const chat = stand.chat("700001");
    const menu = await chat.onboard(CAFE_INN);
    const before = stand.max.dialog("700001").length;
    const acknowledgedBefore = stand.max.acknowledged.length;

    const statuses = await chat.tapRepeatedly(menu, "🔔 Уведомления", 3);

    expect(statuses).toEqual([200, 200, 200]);
    await stand.waitFor("первый ответ", () => stand.max.dialog("700001").length > before);
    await stand.quiet(1_500);
    expect(stand.max.dialog("700001").length - before).toBe(1);
    expect(stand.max.last("700001").text).toContain("Настройки уведомлений");
    await stand.waitFor(
      "подтверждения всех трёх нажатий",
      () => stand.max.acknowledged.length - acknowledgedBefore === 3,
    );
  });

  it("если вопросов больше нет, кнопки «❔ Уточнить данные» под перечнем нет", async () => {
    const chat = stand.chat("700002");
    await chat.onboard(KAZAN_CAFE_INN);
    await chat.press("📋 Мой перечень");
    let reply = await chat.press("❔ Уточнить данные");
    for (let step = 0; step < 6 && reply.text.includes("❔ Уточнение"); step += 1) {
      const answer = reply.buttons.find((button) => !["Пропустить", "← К перечню", "🏠 Меню"].includes(button.text));
      reply = await chat.press(answer?.text as string);
    }
    expect(reply.text).toContain("Бот не спрашивает в диалоге");

    await chat.press("🏠 Меню");
    const list = await chat.press("📋 Мой перечень");

    // Одна запись ждёт численность работников из реестра: бот её не спрашивает, поэтому и кнопки нет.
    expect(list.text).toContain("Недостаточно данных: 1");
    expect(list.buttons.map((button) => button.text)).not.toContain("❔ Уточнить данные");
  });

  it("повторная демо-кнопка после доставки push честно говорит, что уведомление уже отправлено", async () => {
    const chat = stand.chat("700003");
    await chat.onboard(CAFE_INN);
    await chat.press(DEMO_BUTTON);
    await stand.waitFor("push из очереди", () => stand.max.pushes("700003").length === 1);
    await stand.quiet(600);

    const again = await chat.pressPayload(DEMO_CHANGE_CALLBACK_PAYLOAD);

    expect(again?.text).toContain("уже отправлено в этот чат раньше");
    expect(again?.text).not.toContain("приходит в этот чат");
    await stand.quiet();
    expect(stand.max.pushes("700003")).toHaveLength(1);
  });
});

describe("демо после отключённых уведомлений", () => {
  beforeEach(async () => {
    stand = await startStand();
  });

  it("выключил → демо (push нет) → включил → демо: push приходит один раз", async () => {
    const chat = stand.chat("720001");
    await chat.onboard(CAFE_INN);
    await chat.press("🔔 Уведомления");
    await chat.press("🔕 Отключить уведомления");

    const disabled = await chat.press(DEMO_BUTTON);
    expect(disabled.text).toContain("Уведомление в этот чат не создано");
    expect(disabled.text).toContain("включите их в «🔔 Уведомления»");
    await stand.quiet();
    expect(stand.max.pushes("720001")).toHaveLength(0);

    await chat.press("🏠 Меню");
    await chat.press("🔔 Уведомления");
    await chat.press("🔔 Включить уведомления");
    const enabled = await chat.press(DEMO_BUTTON);

    expect(enabled.text).toContain("приходит в этот чат");
    await stand.waitFor("push после включения", () => stand.max.pushes("720001").length === 1);
    await chat.pressPayload(DEMO_CHANGE_CALLBACK_PAYLOAD);
    await stand.quiet();
    expect(stand.max.pushes("720001")).toHaveLength(1);
  });
});

describe("кнопка «Открыть карточку»", () => {
  it("с флагом BOT_FEATURES=cards демо-ответ содержит кнопку открытия карточки", async () => {
    stand = await startStand({ botFeatures: ["cards"] });
    const chat = stand.chat("710001");
    await chat.onboard(CAFE_INN);

    const demo = await chat.press(DEMO_BUTTON);

    expect(demo.buttons.map((button) => button.text)).toContain("Открыть карточку");
  });
});

describe("сбои MAX", () => {
  it("если MAX отвергает снятие кнопок и подтверждение, диалог продолжается", async () => {
    stand = await startStand({ max: { failEdits: true } });
    const chat = stand.chat("600001");

    const menu = await chat.onboard(KAZAN_CAFE_INN);
    const list = await chat.press("📋 Мой перечень");

    expect(menu.text).toContain("Главное меню");
    expect(list.text).toContain("Ваш перечень");
    expect(stand.max.dialog("600001").every((message) => !message.keyboardRemoved)).toBe(true);
  });
});
