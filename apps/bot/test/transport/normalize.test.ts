import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { normalizeMaxUpdate, parseMaxUpdateJson } from "../../src/transport/index.js";
import { botStarted, MODEL_CHAT_ID, MODEL_USER_ID, messageCallback, messageCreated } from "./support/updates.js";

const occurredAt = "2026-09-21T14:13:20.000Z";

describe("normalizeMaxUpdate", () => {
  it("переводит текстовое сообщение в событие text", () => {
    assert.deepEqual(normalizeMaxUpdate(messageCreated("  Привет  ")), {
      ok: true,
      event: {
        kind: "text",
        eventId: "message:mid.model-1",
        chatId: String(MODEL_CHAT_ID),
        userId: String(MODEL_USER_ID),
        text: "Привет",
        occurredAt,
      },
    });
  });

  it("переводит нажатие кнопки в событие callback", () => {
    assert.deepEqual(normalizeMaxUpdate(messageCallback("d:home")), {
      ok: true,
      event: {
        kind: "callback",
        eventId: "callback:cb.model-1",
        chatId: String(MODEL_CHAT_ID),
        userId: String(MODEL_USER_ID),
        callbackId: "cb.model-1",
        payload: "d:home",
        messageId: "mid.model-bot",
        occurredAt,
      },
    });
  });

  it("переводит запуск бота в событие started и сохраняет payload deep link", () => {
    const result = normalizeMaxUpdate(botStarted("demo"));
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.event, {
      kind: "started",
      eventId: `started:${MODEL_CHAT_ID}:1790000000000`,
      chatId: String(MODEL_CHAT_ID),
      userId: String(MODEL_USER_ID),
      startPayload: "demo",
      occurredAt,
    });
  });

  it("не добавляет startPayload, если его нет", () => {
    const result = normalizeMaxUpdate(botStarted());
    assert.equal(result.ok && "startPayload" in result.event, false);
  });

  const ignored: [string, unknown, string, string][] = [
    ["не объект", "строка", "unknown", "not_an_object"],
    ["массив", [], "unknown", "not_an_object"],
    ["неподдерживаемый тип", { update_type: "bot_stopped", timestamp: 1 }, "bot_stopped", "unsupported_update_type"],
    ["нет update_type", { timestamp: 1 }, "unknown", "unsupported_update_type"],
    ["групповой чат", messageCreated("ИНН", { chatType: "chat" }), "message_created", "not_a_dialog"],
    ["сообщение другого бота", messageCreated("ИНН", { isBot: true }), "message_created", "from_bot"],
    ["стикер без текста", messageCreated(null), "message_created", "empty_text"],
    ["только пробелы", messageCreated("   "), "message_created", "empty_text"],
    [
      "нет mid",
      { ...messageCreated("x"), message: { ...messageCreated("x").message, body: {} } },
      "message_created",
      "missing_field",
    ],
    ["нет timestamp", { ...messageCreated("x"), timestamp: undefined }, "message_created", "missing_field"],
    [
      "callback без payload",
      { ...messageCallback("x"), callback: { callback_id: "c", user: { user_id: 1 } } },
      "message_callback",
      "missing_field",
    ],
    ["callback вне диалога", { ...messageCallback("x"), message: null }, "message_callback", "not_a_dialog"],
    ["bot_started без chat_id", { ...botStarted(), chat_id: undefined }, "bot_started", "missing_field"],
    ["дробный chat_id", { ...botStarted(), chat_id: 1.5 }, "bot_started", "missing_field"],
  ];

  for (const [name, update, updateType, reason] of ignored) {
    it(`пропускает update: ${name}`, () => {
      assert.deepEqual(normalizeMaxUpdate(update), { ok: false, updateType, reason });
    });
  }
});

describe("parseMaxUpdateJson", () => {
  it("сохраняет int64 chat_id и user_id без потери точности", () => {
    const body =
      '{"update_type":"bot_started","timestamp":1,"chat_id":9007199254740993,"user":{"user_id":-9007199254740995}}';
    const update = parseMaxUpdateJson(body) as { chat_id: unknown; user: { user_id: unknown } };
    assert.equal(update.chat_id, "9007199254740993");
    assert.equal(update.user.user_id, "-9007199254740995");

    const result = normalizeMaxUpdate(update);
    assert.equal(result.ok && result.event.chatId, "9007199254740993");
  });

  it("не трогает остальные числа", () => {
    assert.deepEqual(parseMaxUpdateJson('{"timestamp":5,"seq":7}'), { timestamp: 5, seq: 7 });
  });

  it("бросает ошибку на невалидном JSON", () => {
    assert.throws(() => parseMaxUpdateJson("{"));
  });
});
