import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { createInboundDispatcher, type InboundDelivery, type InboundEvent } from "../../src/transport/index.js";
import { createRecordingLogger } from "./support/logger.js";

const event = (chatId: string, eventId: string, value = "/start"): InboundEvent => ({
  kind: "text",
  eventId,
  chatId,
  userId: "u",
  text: value,
  occurredAt: "2026-09-27T00:00:00.000Z",
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("createInboundDispatcher", () => {
  it("передаёт обработчику событие и его перевод для машины диалога", async () => {
    const received: InboundDelivery[] = [];
    const dispatcher = createInboundDispatcher({
      handle: (d) => void received.push(d),
      logger: createRecordingLogger(),
    });

    assert.equal(dispatcher.dispatch(event("1", "e-1", "ИНН 1234567890")), true);
    await dispatcher.drain();

    assert.equal(received.length, 1);
    assert.deepEqual(received[0]?.dialogEvent, { type: "submit_inn", inn: "1234567890" });
    assert.equal(received[0]?.event.eventId, "e-1");
  });

  it("обрабатывает события одного чата по очереди, разных чатов — параллельно", async () => {
    const order: string[] = [];
    const gate = deferred();
    const dispatcher = createInboundDispatcher({
      logger: createRecordingLogger(),
      handle: async ({ event: e }) => {
        order.push(`start ${e.eventId}`);
        if (e.eventId === "a-1") await gate.promise;
        order.push(`end ${e.eventId}`);
      },
    });

    dispatcher.dispatch(event("a", "a-1"));
    dispatcher.dispatch(event("a", "a-2"));
    dispatcher.dispatch(event("b", "b-1"));
    await new Promise((r) => setTimeout(r, 0));

    // Чат b не ждёт чат a, а a-2 не начинается до конца a-1.
    assert.deepEqual(order, ["start a-1", "start b-1", "end b-1"]);
    assert.equal(dispatcher.pending, 2);

    gate.resolve();
    await dispatcher.drain();
    assert.deepEqual(order.slice(3), ["end a-1", "start a-2", "end a-2"]);
    assert.equal(dispatcher.pending, 0);
  });

  it("ошибка обработчика не останавливает очередь чата и пишется в лог без текста", async () => {
    const logger = createRecordingLogger();
    const handled: string[] = [];
    const dispatcher = createInboundDispatcher({
      logger,
      handle: ({ event: e }) => {
        if (e.eventId === "e-1") throw new Error("boom");
        handled.push(e.eventId);
      },
    });

    dispatcher.dispatch(event("1", "e-1", "секретный текст"));
    dispatcher.dispatch(event("1", "e-2"));
    await dispatcher.drain();

    assert.deepEqual(handled, ["e-2"]);
    assert.equal(logger.records[0]?.event, "bot.inbound.handler_failed");
    assert.equal(JSON.stringify(logger.records).includes("секретный текст"), false);
  });

  it("отклоняет событие при переполнении очереди чата и общей очереди", async () => {
    const gate = deferred();
    const logger = createRecordingLogger();
    const dispatcher = createInboundDispatcher({
      logger,
      handle: () => gate.promise,
      maxPendingPerChat: 2,
      maxPendingTotal: 3,
    });

    assert.equal(dispatcher.dispatch(event("a", "a-1")), true);
    assert.equal(dispatcher.dispatch(event("a", "a-2")), true);
    assert.equal(dispatcher.dispatch(event("a", "a-3")), false);
    assert.equal(dispatcher.dispatch(event("b", "b-1")), true);
    assert.equal(dispatcher.dispatch(event("c", "c-1")), false);
    assert.equal(logger.records.filter((r) => r.event === "bot.inbound.overloaded").length, 2);

    gate.resolve();
    await dispatcher.drain();
    assert.equal(dispatcher.dispatch(event("a", "a-4")), true);
    await dispatcher.drain();
  });
});
