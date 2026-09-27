import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "vitest";

import {
  createDialogRouter,
  DIALOG_ROUTES,
  type DialogRoute,
  type DialogRouteHandlers,
} from "../../src/dialog/index.js";
import {
  createBotHttpServer,
  createInboundDispatcher,
  createMaxWebhookHandler,
  createMemoryDedup,
  encodeButtonPayload,
  type InboundDelivery,
  type InboundHandler,
  MAX_SECRET_HEADER,
} from "../../src/transport/index.js";
import { createRecordingLogger } from "./support/logger.js";
import { botStarted, MODEL_CHAT_ID, messageCallback, messageCreated } from "./support/updates.js";

const SECRET = "model_webhook-secret";
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const startBot = async (handle: InboundHandler, options: { maxBodyBytes?: number; maxPendingTotal?: number } = {}) => {
  const logger = createRecordingLogger();
  const dispatcher = createInboundDispatcher({
    handle,
    logger,
    ...(options.maxPendingTotal === undefined ? {} : { maxPendingTotal: options.maxPendingTotal }),
  });
  const webhook = createMaxWebhookHandler({
    secret: SECRET,
    dispatcher,
    dedup: createMemoryDedup(),
    logger,
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
  });
  const server = createBotHttpServer({ webhook });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;

  const post = (body: unknown, init: { secret?: string | null; path?: string; raw?: string } = {}) =>
    fetch(`http://127.0.0.1:${port}${init.path ?? "/webhook"}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(init.secret === null ? {} : { [MAX_SECRET_HEADER]: init.secret ?? SECRET }),
      },
      body: init.raw ?? JSON.stringify(body),
    });

  return { port, post, dispatcher, logger };
};

describe("webhook MAX → внутреннее событие → обработчик", () => {
  it("доводит сообщение с ИНН через машину диалога K-22b до обработчика маршрута", async () => {
    const routed: { route: DialogRoute; dialogId: string; inn?: string }[] = [];
    const handlers = Object.fromEntries(
      DIALOG_ROUTES.map((route) => [
        route,
        ({ dialogId, event }) => {
          routed.push({ route, dialogId, ...(event.type === "submit_inn" ? { inn: event.inn } : {}) });
        },
      ]),
    ) as DialogRouteHandlers<void>;
    const router = createDialogRouter(handlers);

    // Состояние диалога хранит сценарий (K-24); здесь — модельное хранилище в памяти.
    const states = new Map<string, string>();
    const bot = await startBot(async ({ event, dialogEvent }) => {
      if (dialogEvent === undefined) return;
      const { transition } = await router.dispatch({
        dialogId: event.chatId,
        state: states.get(event.chatId) ?? "idle",
        event: dialogEvent,
      });
      states.set(event.chatId, transition.state);
    });

    assert.equal((await bot.post(botStarted())).status, 200);
    assert.equal((await bot.post(messageCreated("ИНН 1234567890", { mid: "mid.2" }))).status, 200);
    await bot.dispatcher.drain();

    assert.deepEqual(routed, [
      { route: "request_inn", dialogId: String(MODEL_CHAT_ID) },
      { route: "lookup_profile", dialogId: String(MODEL_CHAT_ID), inn: "1234567890" },
    ]);
    assert.equal(states.get(String(MODEL_CHAT_ID)), "loading_profile");
  });

  it("передаёт нажатие кнопки с callbackId для ответа", async () => {
    const received: InboundDelivery[] = [];
    const bot = await startBot((d) => void received.push(d));

    const response = await bot.post(messageCallback(encodeButtonPayload({ type: "open_requirements" })));
    await bot.dispatcher.drain();

    assert.equal(response.status, 200);
    assert.equal(received[0]?.event.kind === "callback" && received[0].event.callbackId, "cb.model-1");
    assert.deepEqual(received[0]?.dialogEvent, { type: "open_requirements" });
  });

  it("отвечает 200 до завершения обработки", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bot = await startBot(() => blocked);

    const response = await bot.post(messageCreated("/start"));
    assert.equal(response.status, 200);
    assert.equal(bot.dispatcher.pending, 1);

    release();
    await bot.dispatcher.drain();
  });

  it("обрабатывает повтор webhook один раз", async () => {
    const received: InboundDelivery[] = [];
    const bot = await startBot((d) => void received.push(d));

    assert.equal((await bot.post(messageCreated("/start"))).status, 200);
    assert.equal((await bot.post(messageCreated("/start"))).status, 200);
    await bot.dispatcher.drain();

    assert.equal(received.length, 1);
    assert.ok(bot.logger.records.some((r) => r.event === "bot.webhook.duplicate"));
  });

  it("подтверждает, но не обрабатывает неподдерживаемые update", async () => {
    const received: InboundDelivery[] = [];
    const bot = await startBot((d) => void received.push(d));

    const response = await bot.post({ update_type: "bot_stopped", timestamp: 1 });
    await bot.dispatcher.drain();

    assert.equal(response.status, 200);
    assert.equal(received.length, 0);
  });

  it("отклоняет запрос без secret или с чужим secret", async () => {
    const received: InboundDelivery[] = [];
    const bot = await startBot((d) => void received.push(d));

    assert.equal((await bot.post(messageCreated("/start"), { secret: null })).status, 403);
    assert.equal((await bot.post(messageCreated("/start"), { secret: "other_secret" })).status, 403);
    assert.equal((await bot.post(messageCreated("/start"), { secret: `${SECRET}x` })).status, 403);
    await bot.dispatcher.drain();
    assert.equal(received.length, 0);
  });

  it("возвращает 400 на невалидный JSON и 413 на слишком большое тело", async () => {
    const bot = await startBot(() => undefined, { maxBodyBytes: 64 });

    assert.equal((await bot.post(null, { raw: "{" })).status, 400);
    assert.equal((await bot.post(messageCreated("x".repeat(100)))).status, 413);
  });

  it("возвращает 503 при переполнении очереди, и повтор MAX потом принимается", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const received: string[] = [];
    const bot = await startBot(
      async ({ event }) => {
        await blocked;
        received.push(event.eventId);
      },
      { maxPendingTotal: 1 },
    );

    assert.equal((await bot.post(messageCreated("/start", { mid: "m-1" }))).status, 200);
    assert.equal((await bot.post(messageCreated("/start", { mid: "m-2" }))).status, 503);
    release();
    await bot.dispatcher.drain();

    assert.equal((await bot.post(messageCreated("/start", { mid: "m-2" }))).status, 200);
    await bot.dispatcher.drain();
    assert.deepEqual(received, ["message:m-1", "message:m-2"]);
  });

  it("отдаёт /health, 404 на чужой путь и 405 на GET webhook", async () => {
    const bot = await startBot(() => undefined);
    const base = `http://127.0.0.1:${bot.port}`;

    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await bot.post(messageCreated("/start"), { path: "/other" })).status, 404);
    assert.equal((await fetch(`${base}/webhook`)).status, 405);
  });

  it("не принимает secret, который MAX не разрешает", () => {
    const options = {
      dispatcher: createInboundDispatcher({ handle: () => undefined, logger: createRecordingLogger() }),
    };
    for (const secret of ["abcd", "с кириллицей", "a".repeat(257)]) {
      assert.throws(() =>
        createMaxWebhookHandler({ ...options, secret, dedup: createMemoryDedup(), logger: createRecordingLogger() }),
      );
    }
  });
});
