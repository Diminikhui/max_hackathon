// Стенд e2e: настоящий `startApp` (HTTP-сервер бота, проверка secret webhook, диспетчер, отправка очереди) на PGlite
// и модельном MAX. Обновления отправляются настоящими HTTP-запросами на `POST /webhook` в формате Bot API.
import { request } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import type { ProfileSource } from "@max-hackathon/domain";
import { createPgliteClient } from "@max-hackathon/storage";
import { type AppConfig, startApp } from "@max-hackathon/worker/dist/app/index.js";
import { MaxTransportRegistry } from "@max-hackathon/worker/dist/sender/queue/index.js";
import { FakeMax, type FakeMaxOptions, type SentMessage } from "./fake-max.js";

export const WEBHOOK_SECRET = "e2e_secret_value_1";
export const CAFE_INN = "7700000016";
export const AUTOSERVICE_INN = "7700000023";
export const KAZAN_CAFE_INN = "1600000011";
export const DEMO_BUTTON = "🧪 Показать пример изменения (модельное)";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** Реестр МСП в e2e не вызывается: все ИНН сценария — модельные K-28. */
const noRealSource: ProfileSource = {
  info: { name: "msp", isModel: false },
  lookupByInn: async () => {
    throw new Error("в e2e реестр МСП не вызывается");
  },
};

export interface Stand {
  readonly max: FakeMax;
  readonly port: number;
  /** Отправить обновление MAX на webhook; возвращает HTTP-статус ответа процесса. */
  post(update: unknown, secret?: string | null): Promise<number>;
  chat(chatId: string): Chat;
  /** Ждать условия (например, появления push из очереди отправки). */
  waitFor(description: string, condition: () => boolean, timeoutMs?: number): Promise<void>;
  /** Подождать, чтобы убедиться, что новых сообщений нет. */
  quiet(ms?: number): Promise<void>;
  stop(): Promise<void>;
}

export interface Chat {
  readonly id: string;
  start(): Promise<SentMessage>;
  say(text: string): Promise<SentMessage>;
  /** Нажать кнопку последнего сообщения бота по подписи. */
  press(text: string): Promise<SentMessage>;
  /** Нажать кнопку из сообщения с указанным номером ответа (для проверки «старых» кнопок). */
  pressIn(message: SentMessage, text: string): Promise<SentMessage | undefined>;
  pressPayload(payload: string): Promise<SentMessage | undefined>;
  onboard(inn: string): Promise<SentMessage>;
}

const postJson = (port: number, body: string, secret: string | null): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/webhook",
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret === null ? {} : { "x-max-bot-api-secret": secret }),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(body);
  });

let tokenCounter = 0;

export const startStand = async (
  options: { readonly max?: FakeMaxOptions; readonly botFeatures?: readonly string[] } = {},
): Promise<Stand> => {
  const max = new FakeMax(options.max);
  const db = new PGlite();
  const client = createPgliteClient(db);
  const config: AppConfig = {
    databaseUrl: "pglite://in-memory",
    maxEventsEnabled: true,
    max: {
      // Токен уникален, чтобы реестр транспортов не делил лимит запросов между стендами.
      token: `e2e-token-${++tokenCounter}`,
      baseUrl: "https://max.invalid",
      webhookSecret: WEBHOOK_SECRET,
    },
    ...(options.botFeatures ? { botFeatures: options.botFeatures } : {}),
    botHttpPort: 0,
    botHttpHost: "127.0.0.1",
  };
  const app = await startApp(config, silent, {
    db: { ...client, close: () => db.close() },
    fetch: max.fetch,
    registry: new MaxTransportRegistry(),
    realSource: noRealSource,
  });
  const port = app.port as number;

  let counter = 0;
  const stamp = () => Date.now() + ++counter;
  const users = new Map<string, number>();
  const user = (chatId: string) => users.get(chatId) ?? users.set(chatId, 9_000 + users.size).get(chatId);

  /** `secret` не задан — верный; `null` — запрос без заголовка. */
  const post = (update: unknown, secret: string | null = WEBHOOK_SECRET) =>
    postJson(port, JSON.stringify(update), secret);

  // Ответ диалога появляется после того, как webhook уже вернул 200: ждём нового сообщения бота в чате.
  const nextReply = async (chatId: string, before: number): Promise<SentMessage> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (max.dialog(chatId).length > before) return max.last(chatId);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Бот не ответил в чате ${chatId}`);
  };

  const recipient = (chatId: string) => ({ chat_id: Number(chatId), chat_type: "dialog", user_id: 1 });

  const chat = (chatId: string): Chat => {
    const send = async (update: unknown): Promise<SentMessage> => {
      const before = max.dialog(chatId).length;
      const status = await post(update);
      if (status !== 200) throw new Error(`webhook ответил ${status}`);
      return nextReply(chatId, before);
    };
    const pressPayload = async (payload: string): Promise<SentMessage | undefined> => {
      const before = max.dialog(chatId).length;
      const callbackId = `cb-${chatId}-${stamp()}`;
      const status = await post({
        update_type: "message_callback",
        timestamp: stamp(),
        callback: { callback_id: callbackId, payload, user: { user_id: user(chatId) } },
        message: { recipient: recipient(chatId), body: { mid: `mid.user.${stamp()}` } },
      });
      if (status !== 200) throw new Error(`webhook ответил ${status}`);
      return nextReply(chatId, before);
    };
    const pressIn = async (message: SentMessage, text: string) => {
      const button = message.buttons.find((candidate) => candidate.text === text);
      if (button?.payload === undefined) {
        throw new Error(`Нет кнопки «${text}»: ${message.buttons.map((item) => item.text).join(", ")}`);
      }
      return pressPayload(button.payload);
    };
    const press = async (text: string) => (await pressIn(max.last(chatId), text)) as SentMessage;
    const self: Chat = {
      id: chatId,
      start: () =>
        send({
          update_type: "bot_started",
          timestamp: stamp(),
          chat_id: Number(chatId),
          user: { user_id: user(chatId) },
        }),
      say: (text) =>
        send({
          update_type: "message_created",
          timestamp: stamp(),
          message: {
            recipient: recipient(chatId),
            sender: { user_id: user(chatId), is_bot: false },
            body: { mid: `mid.user.${stamp()}`, text },
          },
        }),
      press,
      pressIn,
      pressPayload,
      onboard: async (inn) => {
        await self.start();
        await self.say(inn);
        return press("✅ Всё верно");
      },
    };
    return self;
  };

  const waitFor = async (description: string, condition: () => boolean, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Не дождались: ${description}`);
  };

  /** Показывает, что за `ms` новых сообщений в чате не появилось (например, второй push не создан). */
  const quiet = async (ms = 1_800): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  };

  return { max, port, post, chat, waitFor, quiet, stop: () => app.stop() };
};
