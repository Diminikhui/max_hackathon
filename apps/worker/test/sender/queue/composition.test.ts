// Composition root отправки (3-05, #247): один transport на token, общий бюджет у send/upload/service,
// воркер на PostgresNotificationRepository (PGlite) с честной выборкой. Реальные запросы к MAX не выполняются.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createPgliteClient, PostgresNotificationRepository, runMigrations } from "@max-hackathon/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMaxSenderRuntime, MaxTransportRegistry } from "../../../src/sender/queue/index.js";
import { manualClock, queued } from "./support/fixtures.js";

const MODEL_MAX = { token: "model-token", baseUrl: "https://max.example.test" } as const;
// Клиент K-21b принимает только числовой chat_id MAX; идентификаторы модельные.
const MODEL_CHAT_A = "-900000000001";
const MODEL_CHAT_B = "-900000000002";
const inChat = (id: string, chatId: string, overrides: Parameters<typeof queued>[1] = {}) =>
  queued(id, { recipient: { channel: "max_bot", chatId }, ...overrides });

let db: PGlite;
let repository: PostgresNotificationRepository;
beforeEach(async () => {
  db = new PGlite();
  const client = createPgliteClient(db);
  await runMigrations(client);
  repository = new PostgresNotificationRepository(client);
});
afterEach(() => db.close());

describe("createMaxSenderRuntime", () => {
  it("send, upload и service одной сборки и повторная сборка с тем же token делят один бюджет", async () => {
    let now = 0;
    const waits: number[] = [];
    const calls: string[] = [];
    const registry = new MaxTransportRegistry();
    const max = {
      ...MODEL_MAX,
      budget: { capacity: 1, refillPerSecond: 10 },
      sleep: async (ms: number) => {
        waits.push(ms);
        now += ms;
      },
      fetch: async (input: string) => {
        calls.push(input);
        return new Response(null, { status: 200 });
      },
    };
    const first = createMaxSenderRuntime({ max, repository, registry, now: () => now });
    const second = createMaxSenderRuntime({ max, repository, registry, now: () => now });

    expect(second.transport).toBe(first.transport);
    expect(registry.size()).toBe(1);
    await Promise.all([
      first.sender.send(inChat("n1", MODEL_CHAT_A)),
      first.upload.upload({ path: "uploads" }),
      second.service.request({ path: "me" }),
    ]);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([100, 100]);
  });

  it("разные token получают разные transport; тот же token с другим baseUrl отвергается", () => {
    const registry = new MaxTransportRegistry();
    const a = createMaxSenderRuntime({ max: MODEL_MAX, repository, registry });
    const b = createMaxSenderRuntime({ max: { ...MODEL_MAX, token: "model-token-2" }, repository, registry });
    expect(a.transport).not.toBe(b.transport);
    expect(() =>
      createMaxSenderRuntime({ max: { ...MODEL_MAX, baseUrl: "https://other.example.test" }, repository, registry }),
    ).toThrow("baseUrl");
    expect(() => createMaxSenderRuntime({ max: { ...MODEL_MAX, token: " " }, repository, registry })).toThrow("token");
  });

  it("воркер сборки отправляет через общий transport из честной выборки PostgreSQL", async () => {
    await repository.enqueue(inChat("a1", MODEL_CHAT_A));
    await repository.enqueue(inChat("a2", MODEL_CHAT_A, { createdAt: "2026-09-25T12:00:01Z" }));
    await repository.enqueue(inChat("b1", MODEL_CHAT_B, { createdAt: "2026-09-25T12:00:02Z" }));
    const clock = manualClock();
    const paths: string[] = [];
    const runtime = createMaxSenderRuntime({
      max: {
        ...MODEL_MAX,
        sleep: async (ms: number) => clock.advance(ms),
        fetch: async (input: string) => {
          paths.push(new URL(input).searchParams.get("chat_id") ?? "");
          return new Response(null, { status: 200 });
        },
      },
      repository,
      registry: new MaxTransportRegistry(),
      now: clock.now,
    });

    const report = await runtime.worker.processBatch();
    // Голова каждого чата уходит в первом же tick; второе сообщение чата A ждёт свою per-chat квоту.
    expect([...report.sent].sort()).toEqual(["a1", "b1"]);
    expect(report.skipped).toEqual(["a2"]);
    expect([...paths].sort()).toEqual([MODEL_CHAT_A, MODEL_CHAT_B].sort());
  });

  it("воркер отправляет уведомление K-30a с кнопками клиентом K-21b: inline_keyboard в теле запроса", async () => {
    // Форма уведомления K-30a (NotificationPipeline): id и idempotencyKey от кандидата, кнопки от шаблона K-23.
    await repository.enqueue(
      inChat("notification:cand-model-1", MODEL_CHAT_A, {
        idempotencyKey: "notify:model-dedup-1",
        buttons: [
          { text: "Открыть карточку", payload: "open:model-requirement" },
          { text: "Первоисточник", url: "https://example.test/source" },
        ],
      }),
    );
    const bodies: unknown[] = [];
    const runtime = createMaxSenderRuntime({
      max: {
        ...MODEL_MAX,
        fetch: async (_input: string, init?: RequestInit) => {
          bodies.push(JSON.parse(String(init?.body)));
          return new Response(null, { status: 200 });
        },
      },
      repository,
      registry: new MaxTransportRegistry(),
    });

    const report = await runtime.worker.processBatch();
    expect(report.sent).toEqual(["notification:cand-model-1"]);
    expect(bodies).toEqual([
      {
        text: queued("x").text,
        attachments: [
          {
            type: "inline_keyboard",
            payload: {
              buttons: [
                [
                  { type: "callback", text: "Открыть карточку", payload: "open:model-requirement" },
                  { type: "link", text: "Первоисточник", url: "https://example.test/source" },
                ],
              ],
            },
          },
        ],
      },
    ]);
  });

  it("ошибки MAX возвращаются кодами K-27, Retry-After учитывается", async () => {
    const responses = [
      new Response(null, { status: 429, headers: { "Retry-After": "3" } }),
      new Response(null, { status: 403 }),
      new Response(null, { status: 503 }),
    ];
    const runtime = createMaxSenderRuntime({
      max: { ...MODEL_MAX, fetch: async () => responses.shift() ?? new Response(null, { status: 200 }) },
      repository,
      registry: new MaxTransportRegistry(),
    });

    expect(await runtime.sender.send(inChat("e1", MODEL_CHAT_A))).toMatchObject({
      ok: false,
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 3000,
    });
    expect(await runtime.sender.send(inChat("e2", MODEL_CHAT_A))).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
      retryable: false,
    });
    expect(await runtime.sender.send(inChat("e3", MODEL_CHAT_A))).toMatchObject({
      ok: false,
      code: "DEPENDENCY_UNAVAILABLE",
      retryable: true,
    });
    // Лимиты MAX проверяются до запроса: нечисловой chat_id не уходит в сеть.
    expect(
      await runtime.sender.send(queued("e4", { recipient: { channel: "max_bot", chatId: "model-chat" } })),
    ).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
      retryable: false,
    });
    expect(responses).toHaveLength(0);
  });
});

describe("граница HTTP отправителя", () => {
  it("fetch вызывается только в max-transport.ts", () => {
    const dir = join(import.meta.dirname, "../../../src/sender");
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts"));
    const offenders = files.filter(
      (file) =>
        !file.endsWith("max-transport.ts") &&
        /\bfetch\s*\(|globalThis\.fetch/.test(readFileSync(join(dir, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
