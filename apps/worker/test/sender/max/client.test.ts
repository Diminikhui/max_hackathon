import type { Notification } from "@max-hackathon/domain";
import { describe, expect, it } from "vitest";
import { buildMessageBody, type MaxFetch, MaxMessageSender, parseRetryAfter } from "../../../src/sender/max/index.js";

const notification = (overrides: Partial<Notification> = {}): Notification => ({
  contractVersion: 1,
  id: "notification-model-1",
  candidateId: "candidate-model-1",
  companyId: "company-model-1",
  recipient: { channel: "max_bot", chatId: "-900000000001" },
  text: "Модельное уведомление. Сформировано автоматически: https://example.test/source",
  sourceUrls: ["https://example.test/source"],
  automated: true,
  isModel: true,
  idempotencyKey: "model-idempotency-key-1",
  status: "queued",
  attempts: 0,
  createdAt: "2026-09-27T12:00:00Z",
  ...overrides,
});

interface Call {
  input: string | URL;
  init: RequestInit | undefined;
}

function modelFetch(response: Response | Error): { fetch: MaxFetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ input, init });
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

describe("MaxMessageSender", () => {
  it("отправляет текст и оба типа кнопок, не раскрывая токен в URL", async () => {
    const transport = modelFetch(new Response('{"message":{"body":{"mid":"model-mid"}}}', { status: 200 }));
    const sender = new MaxMessageSender({
      token: "model-secret-token",
      baseUrl: "https://platform-api2.max.ru/api/",
      fetch: transport.fetch,
    });
    const result = await sender.send(
      notification({
        buttons: [
          { text: "Подробнее", url: "https://example.test/card" },
          { text: "Понятно", payload: "ack:model-1" },
        ],
      }),
    );

    expect(result).toEqual({ ok: true });
    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0];
    expect(String(call?.input)).toBe("https://platform-api2.max.ru/api/messages?chat_id=-900000000001");
    expect(String(call?.input)).not.toContain("model-secret-token");
    expect(call?.init?.headers).toMatchObject({
      Authorization: "model-secret-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      text: "Модельное уведомление. Сформировано автоматически: https://example.test/source",
      attachments: [
        {
          type: "inline_keyboard",
          payload: {
            buttons: [
              [
                { type: "link", text: "Подробнее", url: "https://example.test/card" },
                { type: "callback", text: "Понятно", payload: "ack:model-1" },
              ],
            ],
          },
        },
      ],
    });
  });

  it("не добавляет keyboard attachment без кнопок", () => {
    expect(buildMessageBody(notification())).toEqual({ text: notification().text });
  });

  it("раскладывает callback по 7, а link-кнопки не более чем по 3 в ряд", () => {
    const callbacks = Array.from({ length: 8 }, (_, index) => ({ text: `Кнопка ${index}`, payload: `p${index}` }));
    const callbackRows = buildMessageBody(notification({ buttons: callbacks })).attachments?.[0]?.payload.buttons;
    expect(callbackRows?.map((row) => row.length)).toEqual([7, 1]);

    const links = Array.from({ length: 4 }, (_, index) => ({
      text: `Ссылка ${index}`,
      url: `https://example.test/${index}`,
    }));
    const linkRows = buildMessageBody(notification({ buttons: links })).attachments?.[0]?.payload.buttons;
    expect(linkRows?.map((row) => row.length)).toEqual([3, 1]);
  });

  it.each([
    [400, "INVALID_INPUT", false],
    [401, "UNAUTHENTICATED", false],
    [403, "FORBIDDEN", false],
    [404, "NOT_FOUND", false],
    [409, "CONFLICT", false],
    [429, "RATE_LIMITED", true],
    [500, "DEPENDENCY_UNAVAILABLE", true],
    [503, "DEPENDENCY_UNAVAILABLE", true],
    [504, "DEPENDENCY_TIMEOUT", true],
  ])("мапит HTTP %i в K-27 %s", async (status, code, retryable) => {
    const sender = new MaxMessageSender({
      token: "model-token",
      fetch: modelFetch(new Response("model error", { status })).fetch,
    });
    await expect(sender.send(notification())).resolves.toMatchObject({ ok: false, code, retryable });
  });

  it("передаёт ограниченный Retry-After очереди", async () => {
    const sender = new MaxMessageSender({
      token: "model-token",
      maxRetryAfterMs: 60_000,
      fetch: modelFetch(new Response("", { status: 429, headers: { "Retry-After": "120" } })).fetch,
    });
    await expect(sender.send(notification())).resolves.toMatchObject({
      ok: false,
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 60_000,
    });
  });

  it("считает сетевую ошибку и таймаут неизвестным исходом без повтора", async () => {
    const networkSender = new MaxMessageSender({
      token: "model-token",
      fetch: modelFetch(new TypeError("model network failure")).fetch,
    });
    await expect(networkSender.send(notification())).resolves.toMatchObject({
      ok: false,
      code: "delivery_unknown",
      retryable: false,
    });

    const timeout = new Error("model timeout");
    timeout.name = "TimeoutError";
    const timeoutSender = new MaxMessageSender({ token: "model-token", fetch: modelFetch(timeout).fetch });
    await expect(timeoutSender.send(notification())).resolves.toMatchObject({
      ok: false,
      code: "delivery_unknown",
      retryable: false,
      message: expect.stringContaining("таймаут"),
    });
  });

  it("отклоняет сообщение и клавиатуру вне лимитов до запроса", async () => {
    const transport = modelFetch(new Response("{}"));
    const sender = new MaxMessageSender({ token: "model-token", fetch: transport.fetch });

    await expect(sender.send(notification({ text: "x".repeat(4_001) }))).resolves.toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
      retryable: false,
    });
    await expect(
      sender.send(
        notification({
          buttons: Array.from({ length: 91 }, (_, index) => ({
            text: `Ссылка ${index}`,
            url: `https://example.test/${index}`,
          })),
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_INPUT" });
    await expect(
      sender.send(notification({ buttons: [{ text: "Опасная ссылка", url: "javascript:alert(1)" }] })),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(transport.calls).toHaveLength(0);
  });

  it("валидирует конфигурацию при создании", () => {
    expect(() => new MaxMessageSender({ token: "" })).toThrow("MAX_BOT_TOKEN");
    expect(() => new MaxMessageSender({ token: "model", baseUrl: "http://platform-api2.max.ru" })).toThrow("HTTPS");
    expect(() => new MaxMessageSender({ token: "model", timeoutMs: 0 })).toThrow("timeoutMs");
  });
});

describe("parseRetryAfter", () => {
  it("понимает секунды и HTTP-date", () => {
    const now = Date.parse("2026-09-27T12:00:00Z");
    expect(parseRetryAfter("1.5", now)).toBe(1_500);
    expect(parseRetryAfter("Sun, 27 Sep 2026 12:00:05 GMT", now)).toBe(5_000);
    expect(parseRetryAfter("broken", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});
