import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { type ProfileGateway, renderProfileCard } from "../../../src/flows/onboarding/index.js";
import { encodeButtonPayload, type TransportLogger } from "../../../src/transport/index.js";
import {
  CAFE_INN,
  KAZAN_CAFE_INN,
  MISSING_INN,
  MODEL_SOURCE,
  modelCafe,
  modelFact,
  modelProfileGateway,
  OUTAGE_INN,
} from "./support/model-profiles.js";
import { createTestDialog } from "./support/test-dialog.js";

describe("онбординг K-24a в тестовом диалоге", () => {
  it("«Начать» → ИНН → карточка компании → «Всё верно» → меню → перечень", async () => {
    const profiles = modelProfileGateway();
    const dialog = createTestDialog(profiles);

    const intro = await dialog.start();
    assert.equal(dialog.state, "awaiting_inn");
    assert.ok(intro.text.includes("👋"));
    assert.ok(intro.text.includes("Отправьте ИНН компании"));

    const card = await dialog.type("ИНН 7700 000 016");
    assert.deepEqual(profiles.lookups, [CAFE_INN]);
    assert.equal(dialog.state, "confirming_profile");
    for (const line of [
      "🏢 Это ваша компания? · МОДЕЛЬНЫЕ ДАННЫЕ",
      "Кофейня «Модель» (модельные данные)",
      `ИНН ${CAFE_INN} · организация`,
      "• Основной ОКВЭД: 56.10",
      "• Дополнительные ОКВЭД: 47.25",
      "• Код региона: 77",
      "• Категория МСП: микропредприятие",
      "• Численность работников: 12",
      `Источник: ${MODEL_SOURCE.name}.`,
      "🧪 Модельные данные — не результат реальной интеграции.",
    ]) {
      assert.ok(card.text.includes(line), `нет строки «${line}» в карточке:\n${card.text}`);
    }
    assert.deepEqual(
      card.buttons.map((button) => button.text),
      ["✅ Всё верно", "✏️ Другой ИНН", "↩️ В начало"],
    );

    const menu = await dialog.press("✅ Всё верно");
    assert.equal(dialog.state, "menu");
    assert.ok(menu.text.includes("Профиль сохранён"));
    assert.equal(profiles.confirmed.length, 1);
    assert.equal(await dialog.sessions.companyOf("chat-1"), "model-cafe");
    assert.equal(await dialog.sessions.pendingProfile("chat-1"), undefined);

    const list = await dialog.press("📋 Мой перечень");
    assert.equal(dialog.state, "requirement_list");
    assert.ok(list.text.includes("📋 Ваш перечень"));
  });

  it("повторно найденная компания помечается как уже сохранённая", async () => {
    const dialog = createTestDialog(modelProfileGateway({ alreadySaved: true }));
    await dialog.start();
    const card = await dialog.type(CAFE_INN);
    assert.ok(card.text.includes("Компания уже сохранена"));
  });
});

describe("ошибки онбординга не тупиковые", () => {
  it("текст вместо ИНН: подсказка, диалог остаётся на вводе ИНН, поиск не вызывается", async () => {
    const profiles = modelProfileGateway();
    const dialog = createTestDialog(profiles);
    await dialog.start();

    const reply = await dialog.type("кафе на Тверской");
    assert.equal(dialog.state, "awaiting_inn");
    assert.ok(reply.text.includes("Это не похоже на ИНН"));
    assert.deepEqual(profiles.lookups, []);

    await dialog.type(CAFE_INN);
    assert.equal(dialog.state, "confirming_profile");
  });

  it("неверный ИНН: текст ошибки проверки и повторный ввод", async () => {
    const dialog = createTestDialog(modelProfileGateway());
    await dialog.start();

    const reply = await dialog.type("12345");
    assert.equal(dialog.state, "awaiting_inn");
    assert.ok(reply.text.includes("⚠️ В ИНН должно быть 10 или 12 цифр."));
    assert.equal(reply.stateOverride, "awaiting_inn");

    await dialog.type(CAFE_INN);
    assert.equal(dialog.state, "confirming_profile");
  });

  it("компания не найдена: объяснение и повторный ввод", async () => {
    const dialog = createTestDialog(modelProfileGateway());
    await dialog.start();

    const reply = await dialog.type(MISSING_INN);
    assert.equal(dialog.state, "awaiting_inn");
    assert.ok(reply.text.includes("не найдена"));
    // #370: объясняем источник (реестр МСП), не обещаем ручной ввод и не просим «проверить номер» дважды.
    assert.ok(reply.text.includes("реестре малого и среднего бизнеса"));
    // Не путаем «нет в реестре МСП» с ошибкой в номере или с отсутствием компании.
    assert.ok(reply.text.includes("Это не обязательно значит, что номер неверный или что компании нет"));
    assert.ok(reply.text.includes("исключённых из реестра"));
    assert.ok(!reply.text.includes("вручную"));
    assert.equal(reply.text.split("Проверьте номер").length - 1, 1);

    await dialog.type(CAFE_INN);
    assert.equal(dialog.state, "confirming_profile");
  });

  it("исключение при поиске: пользователь видит «недоступен», в журнале имя ошибки без текста и ИНН (#370)", async () => {
    const entries: { level: string; event: string; context?: Readonly<Record<string, unknown>> }[] = [];
    const logger: TransportLogger = {
      info: (event, _message, context) => entries.push({ level: "info", event, ...(context ? { context } : {}) }),
      warn: (event, _message, context) => entries.push({ level: "warn", event, ...(context ? { context } : {}) }),
      error: (event, _message, context) => entries.push({ level: "error", event, ...(context ? { context } : {}) }),
    };
    const profiles: ProfileGateway = {
      ...modelProfileGateway(),
      lookup: async () => {
        throw new Error(`connection to database lost while reading ${CAFE_INN}`);
      },
    };
    const dialog = createTestDialog(profiles, "idle", logger);
    await dialog.start();

    const reply = await dialog.type(CAFE_INN);
    assert.ok(reply.text.includes("недоступен") || reply.text.includes("Не удалось получить данные"));
    assert.equal(dialog.state, "awaiting_inn");
    assert.deepEqual(entries, [{ level: "error", event: "bot.onboarding.lookup_failed", context: { error: "Error" } }]);
    assert.ok(!JSON.stringify(entries).includes(CAFE_INN));
  });

  it("источник недоступен: просьба повторить, повтор проходит", async () => {
    const dialog = createTestDialog(modelProfileGateway());
    await dialog.start();

    const reply = await dialog.type(OUTAGE_INN);
    assert.equal(dialog.state, "awaiting_inn");
    assert.ok(reply.text.includes("недоступен"));
    assert.ok(reply.text.includes("через минуту"));

    await dialog.type(CAFE_INN);
    assert.equal(dialog.state, "confirming_profile");
  });

  it("исключение сервиса при поиске считается временной недоступностью", async () => {
    const profiles = modelProfileGateway();
    profiles.lookup = async () => {
      throw new Error("db is down");
    };
    const dialog = createTestDialog(profiles);
    await dialog.start();

    const reply = await dialog.type(CAFE_INN);
    assert.equal(dialog.state, "awaiting_inn");
    assert.ok(reply.text.includes("Не удалось получить данные о компании"));
  });

  it("«Другой ИНН» на карточке сбрасывает найденный профиль", async () => {
    const dialog = createTestDialog(modelProfileGateway());
    await dialog.start();
    await dialog.type(CAFE_INN);

    const reply = await dialog.press("✏️ Другой ИНН");
    assert.equal(dialog.state, "awaiting_inn");
    assert.ok(reply.text.includes("Отправьте ИНН компании"));
    assert.equal(await dialog.sessions.pendingProfile("chat-1"), undefined);
  });

  it("ошибка сохранения: карточка остаётся, повторное «Всё верно» сохраняет", async () => {
    const profiles = modelProfileGateway({ failConfirm: 1 });
    const dialog = createTestDialog(profiles);
    await dialog.start();
    await dialog.type(CAFE_INN);

    const failed = await dialog.press("✅ Всё верно");
    assert.equal(dialog.state, "confirming_profile");
    assert.ok(failed.text.includes("Не удалось сохранить профиль"));
    assert.equal(await dialog.sessions.companyOf("chat-1"), undefined);

    await dialog.press("✅ Всё верно");
    assert.equal(dialog.state, "menu");
    assert.equal(await dialog.sessions.companyOf("chat-1"), "model-cafe");
  });

  it("текст на карточке: карточка показывается снова с подсказкой", async () => {
    const dialog = createTestDialog(modelProfileGateway());
    await dialog.start();
    await dialog.type(CAFE_INN);

    const reply = await dialog.type("да");
    assert.equal(dialog.state, "confirming_profile");
    assert.ok(reply.text.includes("Ответьте кнопкой"));
    assert.ok(reply.text.includes("Кофейня «Модель»"));
  });

  it("кнопка из старого сообщения на вводе ИНН: снова просит ИНН", async () => {
    const dialog = createTestDialog(modelProfileGateway());
    await dialog.start();

    const reply = await dialog.callback(encodeButtonPayload({ type: "confirm_profile" }));
    assert.equal(dialog.state, "awaiting_inn");
    assert.ok(reply.text.includes("Сейчас нужен ИНН компании"));
  });

  it("подтверждение после перезапуска бота (профиль не сохранился в памяти): просит ИНН заново", async () => {
    const dialog = createTestDialog(modelProfileGateway(), "confirming_profile");

    const reply = await dialog.callback(encodeButtonPayload({ type: "confirm_profile" }));
    assert.equal(dialog.state, "awaiting_inn");
    assert.ok(reply.text.includes("Данные компании устарели"));
  });

  it("прерванный поиск: любое действие возвращает к вводу ИНН", async () => {
    const byText = createTestDialog(modelProfileGateway(), "loading_profile");
    const textReply = await byText.type("алло");
    assert.equal(byText.state, "awaiting_inn");
    assert.ok(textReply.text.includes("Поиск компании прервался"));

    const byButton = createTestDialog(modelProfileGateway(), "loading_profile");
    await byButton.callback(encodeButtonPayload({ type: "open_requirements" }));
    assert.equal(byButton.state, "awaiting_inn");
  });

  it("неизвестное сохранённое состояние: приветствие и «Ввести ИНН»", async () => {
    const dialog = createTestDialog(modelProfileGateway(), "legacy_state");

    const reply = await dialog.type("/start");
    assert.equal(dialog.state, "idle");
    assert.ok(reply.text.includes("начнём сначала"));

    await dialog.press("Ввести ИНН");
    assert.equal(dialog.state, "awaiting_inn");
  });

  it("«В начало» до подтверждения ведёт к приветствию, оттуда — снова к ИНН", async () => {
    const dialog = createTestDialog(modelProfileGateway());
    await dialog.start();
    await dialog.type(CAFE_INN);

    const welcome = await dialog.press("↩️ В начало");
    assert.equal(dialog.state, "idle");
    assert.ok(welcome.text.includes("Для начала нужен ИНН"));

    const unrecognized = await dialog.type("что это?");
    assert.equal(dialog.state, "idle");
    assert.ok(unrecognized.text.includes("Нажмите «Ввести ИНН»"));

    await dialog.press("Ввести ИНН");
    assert.equal(dialog.state, "awaiting_inn");
  });

  it("«Другая компания» из меню: ввод ИНН, подтверждение заменяет компанию", async () => {
    const profiles = modelProfileGateway();
    const dialog = createTestDialog(profiles);
    await dialog.start();
    await dialog.type(CAFE_INN);
    const menu = await dialog.press("✅ Всё верно");
    assert.deepEqual(
      menu.buttons.map((button) => button.text),
      ["📋 Мой перечень", "🔔 Уведомления", "🔄 Другая компания"],
    );

    const request = await dialog.press("🔄 Другая компания");
    assert.equal(dialog.state, "awaiting_inn");
    assert.ok(request.text.includes("🔄 Смена компании"));
    assert.ok(request.text.includes("Текущая компания останется"));
    assert.equal(await dialog.sessions.companyOf("chat-1"), "model-cafe");

    const card = await dialog.type(KAZAN_CAFE_INN);
    assert.equal(dialog.state, "confirming_profile");
    assert.ok(card.text.includes("Казань"));
    assert.equal(await dialog.sessions.companyOf("chat-1"), "model-cafe");

    const saved = await dialog.press("✅ Всё верно");
    assert.equal(dialog.state, "menu");
    assert.ok(saved.text.includes("Профиль сохранён"));
    assert.equal(await dialog.sessions.companyOf("chat-1"), "model-cafe-kzn");
  });

  it("отмена смены компании «В начало» возвращает в меню к прежней компании", async () => {
    const dialog = createTestDialog(modelProfileGateway());
    await dialog.start();
    await dialog.type(CAFE_INN);
    await dialog.press("✅ Всё верно");
    await dialog.press("🔄 Другая компания");
    await dialog.type(KAZAN_CAFE_INN);

    const reply = await dialog.press("↩️ В начало");
    assert.equal(dialog.state, "menu");
    assert.ok(reply.text.includes("Компания не изменилась"));
    assert.equal(await dialog.sessions.companyOf("chat-1"), "model-cafe");
    assert.equal(await dialog.sessions.pendingProfile("chat-1"), undefined);

    await dialog.press("🔄 Другая компания");
    const again = await dialog.press("↩️ В начало");
    assert.equal(dialog.state, "menu");
    assert.ok(again.text.includes("Главное меню"));
  });

  it("меню без привязанной компании отправляет к вводу ИНН", async () => {
    const dialog = createTestDialog(modelProfileGateway(), "menu");

    const reply = await dialog.type("/menu");
    assert.equal(dialog.state, "idle");
    assert.ok(reply.text.includes("Сначала укажите ИНН компании"));
  });

  it("старая кнопка «Всё верно» в меню не сохраняет профиль повторно", async () => {
    const profiles = modelProfileGateway();
    const dialog = createTestDialog(profiles);
    await dialog.start();
    await dialog.type(CAFE_INN);
    await dialog.press("✅ Всё верно");

    const reply = await dialog.callback(encodeButtonPayload({ type: "confirm_profile" }));
    assert.equal(dialog.state, "menu");
    assert.ok(reply.text.includes("Выберите действие кнопками ниже"));
    assert.equal(profiles.confirmed.length, 1);
  });

  it("устаревшая кнопка в карточке требования после перезапуска: меню", async () => {
    const profiles = modelProfileGateway();
    const dialog = createTestDialog(profiles);
    await dialog.start();
    await dialog.type(CAFE_INN);
    await dialog.press("✅ Всё верно");
    await dialog.press("📋 Мой перечень");
    await dialog.press("1");
    assert.equal(dialog.state, "requirement_details");

    const reply = await dialog.callback(encodeButtonPayload({ type: "edit_profile" }));
    assert.equal(dialog.state, "menu");
    assert.ok(reply.text.includes("Это действие устарело"));
  });
});

describe("карточка профиля", () => {
  it("официальный факт главнее заявленного; заявленный помечается «по вашим словам»", () => {
    const profile = modelCafe([
      modelFact("employment.headcount", 3, "declared"),
      modelFact("sales.alcohol", "beer", "declared"),
      modelFact("tax.regime", "usn_income", "scenario"),
    ]);

    const card = renderProfileCard(profile, MODEL_SOURCE);
    assert.ok(card.text.includes("• Численность работников: 12\n"));
    assert.ok(card.text.includes("• Продажа алкоголя: пиво (по вашим словам)"));
    assert.ok(!card.text.includes("Налоговый режим"));
  });

  it("для ИП без фактов показывает ИНН и тип", () => {
    const profile = { ...modelCafe(), inn: "770000000012", entityType: "individual_entrepreneur" as const, facts: [] };
    const card = renderProfileCard(profile, undefined);
    assert.ok(card.text.includes("ИНН 770000000012 · индивидуальный предприниматель"));
    assert.ok(!card.text.includes("Источник:"));
  });
});
