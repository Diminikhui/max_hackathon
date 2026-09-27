import assert from "node:assert/strict";
import { describe, it } from "vitest";

import type { DialogEvent } from "../../src/dialog/index.js";
import {
  BUTTON_EVENT_TYPES,
  type ButtonDialogEvent,
  decodeButtonPayload,
  encodeButtonPayload,
  type InboundEvent,
  MAX_CALLBACK_PAYLOAD_LENGTH,
  toDialogEvent,
} from "../../src/transport/index.js";

const base = { eventId: "e-1", chatId: "1", userId: "2", occurredAt: "2026-09-27T00:00:00.000Z" } as const;
const text = (value: string): InboundEvent => ({ ...base, kind: "text", text: value });
const callback = (payload: string): InboundEvent => ({ ...base, kind: "callback", callbackId: "c-1", payload });

describe("payload кнопок", () => {
  const events: ButtonDialogEvent[] = BUTTON_EVENT_TYPES.map((type) =>
    type === "select_requirement" ? { type, requirementId: "a-fire-safety:v2" } : { type },
  );

  for (const event of events) {
    it(`кодирует и раскодирует ${event.type} без потерь`, () => {
      assert.deepEqual(decodeButtonPayload(encodeButtonPayload(event)), event);
    });
  }

  it("отклоняет чужие, системные и испорченные payload", () => {
    for (const payload of [
      "spike:yes",
      "",
      "d:",
      "d:profile_loaded",
      "d:notification_settings_saved",
      "d:submit_inn",
      "d:home:extra",
      "d:select_requirement",
      "d:select_requirement:",
      "d:__proto__",
    ]) {
      assert.equal(decodeButtonPayload(payload), undefined, payload);
    }
  });

  it("не принимает пустой requirementId и слишком длинный payload", () => {
    assert.throws(() => encodeButtonPayload({ type: "select_requirement", requirementId: "" }));
    assert.throws(() =>
      encodeButtonPayload({ type: "select_requirement", requirementId: "x".repeat(MAX_CALLBACK_PAYLOAD_LENGTH) }),
    );
  });
});

describe("toDialogEvent", () => {
  const cases: [string, InboundEvent, DialogEvent | undefined][] = [
    ["запуск бота", { ...base, kind: "started" }, { type: "start" }],
    ["команда /start", text("/start"), { type: "start" }],
    ["команда /START с аргументом", text("/START demo"), { type: "start" }],
    ["команда /menu", text("/menu"), { type: "home" }],
    ["ИНН из 10 цифр", text("1234567890"), { type: "submit_inn", inn: "1234567890" }],
    ["ИНН с подписью и пробелами", text("ИНН: 1234 5678 90"), { type: "submit_inn", inn: "1234567890" }],
    ["ИНН с неразрывным пробелом и тире", text("1234 5678–9012"), { type: "submit_inn", inn: "123456789012" }],
    ["неполный ИНН тоже передаётся: длину проверяет обработчик", text("123"), { type: "submit_inn", inn: "123" }],
    ["произвольный текст", text("привет"), undefined],
    ["цифры с буквами", text("12345abc"), undefined],
    ["кнопка", callback("d:open_requirements"), { type: "open_requirements" }],
    ["чужая кнопка", callback("spike:yes"), undefined],
  ];

  for (const [name, event, expected] of cases) {
    it(name, () => {
      assert.deepEqual(toDialogEvent(event), expected);
    });
  }
});
