// Composition root отправки (3-05, #247): один transport на token, общий бюджет у send/upload/service,
// воркер на PostgresNotificationRepository (PGlite) с честной выборкой. Реальные запросы к MAX не выполняются.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createPgliteClient, PostgresNotificationRepository, runMigrations } from "@max-hackathon/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMaxSenderRuntime, MaxTransportRegistry } from "../../../src/sender/queue/index.js";
import { manualClock, queued } from "./support/fixtures.js";

const MODEL_MAX = { token: "model-token", baseUrl: "https://max.example.test" } as const;

let db: PGlite;
let repository: PostgresNotificationRepository;
let client: ReturnType<typeof createPgliteClient>;
beforeAll(async () => {
  db = new PGlite();
  client = createPgliteClient(db);
  await runMigrations(client);
});
beforeEach(async () => {
  await client.exec("TRUNCATE TABLE notifications RESTART IDENTITY CASCADE");
  repository = new PostgresNotificationRepository(client);
});
afterAll(() => db.close());

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
      first.sender.send(queued("n1")),
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
    await repository.enqueue(queued("a1"));
    await repository.enqueue(queued("a2", { createdAt: "2026-09-25T12:00:01Z" }));
    await repository.enqueue(
      queued("b1", { createdAt: "2026-09-25T12:00:02Z", recipient: { ...queued("b1").recipient, chatId: "chat-b" } }),
    );
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
    expect([...paths].sort()).toEqual([queued("a1").recipient.chatId, "chat-b"].sort());
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
