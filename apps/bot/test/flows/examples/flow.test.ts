// Все компании и ИНН в тесте модельные: data/fixtures/k28-companies.json.
import { describe, expect, it } from "vitest";
import { createBotApp } from "../../../src/app/index.js";
import type { FlowReply } from "../../../src/flows/checklist/index.js";
import { EXAMPLE_PAYLOAD_PREFIX, selectExampleCompanies } from "../../../src/flows/examples/index.js";
import { createMemorySettingsStore } from "../../../src/flows/settings/index.js";
import type { InboundEvent, TransportLogger } from "../../../src/transport/index.js";
import { toDialogEvent } from "../../../src/transport/index.js";
import { createK28Services, K28_COMPANIES } from "../clarify/support/k28.js";

const silent: TransportLogger = { info: () => {}, warn: () => {}, error: () => {} };

const setup = (enabled: boolean) => {
  const services = createK28Services();
  const replies: FlowReply[] = [];
  const app = createBotApp({
    profiles: services.profiles,
    checklist: services.checklist,
    settings: createMemorySettingsStore(),
    logger: silent,
    reply: {
      send: async (_chatId, reply) => {
        replies.push(reply);
        return { messageId: `m${replies.length}`, text: reply.text };
      },
    },
    ...(enabled ? { examples: selectExampleCompanies(K28_COMPANIES) } : {}),
  });

  let sequence = 0;
  const receive = async (event: InboundEvent): Promise<FlowReply> => {
    await app.handle({ event, dialogEvent: toDialogEvent(event) });
    return replies.at(-1) as FlowReply;
  };
  const start = (chatId: string) =>
    receive({
      kind: "started",
      eventId: `event-${++sequence}`,
      chatId,
      userId: "model-user",
      occurredAt: "2026-09-29T10:00:00Z",
    });
  const press = (chatId: string, reply: FlowReply, text: string) => {
    const button = reply.buttons.find((candidate) => candidate.text === text);
    if (button === undefined || !("payload" in button)) throw new Error(`Нет кнопки «${text}»`);
    return receive({
      kind: "callback",
      callbackId: `callback-${sequence}`,
      payload: button.payload,
      eventId: `event-${++sequence}`,
      chatId,
      userId: "model-user",
      occurredAt: "2026-09-29T10:00:00Z",
    });
  };

  return { app, press, receive, start };
};

const EXAMPLES = [
  ["☕ Кафе, Москва", "7700000016"],
  ["☕ Кафе, Татарстан", "1600000011"],
  ["👤 ИП без работников", "770000000082"],
] as const;

describe("модельные примеры на шаге ИНН", () => {
  it("показывает только настроенные модельные профили", () => {
    const selected = selectExampleCompanies([
      { inn: "7700000016", isModel: true },
      { inn: "1600000011", isModel: false },
    ]);

    expect(selected.map(({ inn }) => inn)).toEqual(["7700000016"]);
  });

  it("с флагом проводит каждый пример обычным онбордингом к отличающемуся модельному перечню", async () => {
    const lists: string[] = [];

    for (const [label, inn] of EXAMPLES) {
      const { app, press, start } = setup(true);
      const chatId = `chat-${inn}`;
      const request = await start(chatId);
      expect(request.buttons.map((button) => button.text)).toEqual([...EXAMPLES.map(([text]) => text), "↩️ В начало"]);

      const profile = await press(chatId, request, label);
      expect(await app.stateOf(chatId)).toBe("confirming_profile");
      expect(profile.text).toContain(`ИНН ${inn}`);
      expect(profile.text).toContain("модельн");

      const menu = await press(chatId, profile, "✅ Всё верно");
      const list = await press(chatId, menu, "📋 Мой перечень");
      expect(list.text).toContain("модельн");
      lists.push(list.text);

      if (inn === "1600000011") {
        expect(list.text).toContain("Недостаточно данных");
        expect(list.buttons.map((button) => button.text)).toContain("❔ Уточнить данные");
      }
    }

    expect(new Set(lists).size).toBe(EXAMPLES.length);
  });

  it("без флага не показывает кнопки и не обрабатывает payload примера", async () => {
    const { app, receive, start } = setup(false);
    const chatId = "chat-disabled";
    const request = await start(chatId);
    expect(request.buttons.map((button) => button.text)).toEqual(["↩️ В начало"]);

    const reply = await receive({
      kind: "callback",
      callbackId: "forged-callback",
      payload: `${EXAMPLE_PAYLOAD_PREFIX}7700000016`,
      eventId: "forged-event",
      chatId,
      userId: "model-user",
      occurredAt: "2026-09-29T10:00:00Z",
    });

    expect(await app.stateOf(chatId)).toBe("awaiting_inn");
    expect(reply.text).toContain("Это не похоже на ИНН");
    expect(reply.text).not.toContain("Кофейня «Модель»");
  });
});
