// Все записи в тесте модельные; RegulationIngestJob вызывается с isModel: true.
import { PGlite } from "@electric-sql/pglite";
import type { ChangeEvent, ChangeEventRepository, Id } from "@max-hackathon/domain";
import { createPgliteClient, PostgresChangeEventRepository, runMigrations } from "@max-hackathon/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NpaProject } from "../../src/ingest/client/index.js";
import {
  ChangeEventDocumentStore,
  DAILY_INTERVAL_MS,
  documentEventId,
  normalizeDateTime,
  normalizeProject,
  RegulationIngestJob,
  runDailyIngest,
} from "../../src/ingest/index.js";

class MemoryEvents implements ChangeEventRepository {
  readonly items = new Map<Id, ChangeEvent>();

  async append(event: ChangeEvent): Promise<void> {
    if (!this.items.has(event.id)) this.items.set(event.id, structuredClone(event));
  }

  async get(id: Id): Promise<ChangeEvent | undefined> {
    const event = this.items.get(id);
    return event && structuredClone(event);
  }
}

const validProject: NpaProject = {
  id: "900001",
  url: "https://regulation.gov.ru/projects/900001",
  title: "  Модельный   проект для общепита ",
  publishedAt: "27.09.2026 12:30",
  stage: " Обсуждение ",
  sphereIds: [45, 23, 45],
};

const incompleteProject: NpaProject = {
  id: "900002",
  url: "https://regulation.gov.ru/projects/900002",
  publishedAt: "2026-09-27",
  sphereIds: [],
};

let db: PGlite;
let client: ReturnType<typeof createPgliteClient>;

beforeAll(async () => {
  db = new PGlite();
  client = createPgliteClient(db);
  await runMigrations(client);
});
afterAll(async () => {
  await db?.close();
});

describe("нормализация проектов НПА", () => {
  it("сохраняет источник, дату, ссылку и явно модельную отметку", () => {
    const result = normalizeProject(validProject, { retrievedAt: "2026-09-27T10:00:00.000Z", isModel: true });
    expect(result).toEqual({
      ok: true,
      document: {
        documentId: "900001",
        title: "Модельный проект для общепита",
        url: "https://regulation.gov.ru/projects/900001",
        publishedAt: "2026-09-27T09:30:00.000Z",
        stage: "Обсуждение",
        sphereIds: ["23", "45"],
        source: {
          system: "regulation.gov.ru",
          url: "https://regulation.gov.ru/projects/900001",
          recordId: "900001",
          retrievedAt: "2026-09-27T10:00:00.000Z",
          isModel: true,
        },
      },
    });
  });

  it("не выдумывает обязательные поля и отклоняет несуществующие даты", () => {
    expect(normalizeProject(incompleteProject, { retrievedAt: "2026-09-27T10:00:00.000Z", isModel: true })).toEqual({
      ok: false,
      documentId: "900002",
      error: "missing_title",
    });
    expect(normalizeDateTime("31.02.2026")).toBeUndefined();
    expect(normalizeDateTime("01.10.2026 10:00")).toBe("2026-10-01T07:00:00.000Z");
    expect(normalizeDateTime("2026-09-27T10:00:00+03:00")).toBe("2026-09-27T07:00:00.000Z");
  });
});

describe("RegulationIngestJob", () => {
  it("повторный запуск не создаёт дублей и первая запись остаётся в хранилище", async () => {
    const events = new MemoryEvents();
    const store = new ChangeEventDocumentStore(events);
    let call = 0;
    const source = {
      listNpa: async () => ({
        items: call++ === 0 ? [validProject, incompleteProject] : [{ ...validProject, title: "Изменённый заголовок" }],
        skipped: 1,
      }),
    };
    const job = new RegulationIngestJob({
      source,
      store,
      now: () => Date.parse("2026-09-27T10:00:00Z"),
      isModel: true,
    });

    await expect(job.runOnce()).resolves.toMatchObject({
      fetched: 2,
      sourceSkipped: 1,
      stored: 1,
      duplicates: 0,
      rejected: [{ documentId: "900002", error: "missing_title" }],
    });
    await expect(job.runOnce()).resolves.toMatchObject({ stored: 0, duplicates: 1 });

    expect(events.items).toHaveLength(1);
    expect(events.items.get(documentEventId("900001"))).toMatchObject({
      kind: "regulation_document",
      isModel: true,
      document: { title: "Модельный проект для общепита" },
    });
    await expect(store.get("900001")).resolves.toMatchObject({
      publishedAt: "2026-09-27T09:30:00.000Z",
      url: "https://regulation.gov.ru/projects/900001",
    });
  });

  it("повтор сохраняет одну строку в постоянном PostgreSQL-хранилище K-10c", async () => {
    const store = new ChangeEventDocumentStore(new PostgresChangeEventRepository(client));
    const job = new RegulationIngestJob({
      source: { listNpa: async () => ({ items: [validProject], skipped: 0 }) },
      store,
      now: () => Date.parse("2026-09-27T10:00:00Z"),
      isModel: true,
    });

    expect((await job.runOnce()).stored).toBe(1);
    expect((await job.runOnce()).duplicates).toBe(1);
    const { rows } = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM change_events WHERE id = $1",
      [documentEventId("900001")],
    );
    expect(rows[0]?.count).toBe(1);
    await expect(store.get("900001")).resolves.toMatchObject({
      source: { system: "regulation.gov.ru", isModel: true },
      publishedAt: "2026-09-27T09:30:00.000Z",
      url: "https://regulation.gov.ru/projects/900001",
    });
  });
});

describe("runDailyIngest", () => {
  it("запускает работу сразу, затем раз в сутки и останавливается по signal", async () => {
    const events = new MemoryEvents();
    const job = new RegulationIngestJob({
      source: { listNpa: async () => ({ items: [], skipped: 0 }) },
      store: new ChangeEventDocumentStore(events),
      isModel: true,
    });
    const controller = new AbortController();
    const delays: number[] = [];
    const reports: unknown[] = [];

    await runDailyIngest(job, {
      signal: controller.signal,
      onReport: (report) => reports.push(report),
      sleep: async (ms) => {
        delays.push(ms);
        if (delays.length === 2) controller.abort();
      },
    });

    expect(reports).toHaveLength(2);
    expect(delays).toEqual([DAILY_INTERVAL_MS, DAILY_INTERVAL_MS]);
  });

  it("после ошибки использует отдельную задержку повтора", async () => {
    let calls = 0;
    const job = new RegulationIngestJob({
      source: {
        listNpa: async () => {
          calls += 1;
          if (calls === 1) throw new Error("модельная ошибка источника");
          return { items: [], skipped: 0 };
        },
      },
      store: new ChangeEventDocumentStore(new MemoryEvents()),
      isModel: true,
    });
    const controller = new AbortController();
    const delays: number[] = [];
    const errors: unknown[] = [];
    await runDailyIngest(job, {
      signal: controller.signal,
      intervalMs: 100,
      retryDelayMs: 10,
      onError: (error) => errors.push(error),
      sleep: async (ms) => {
        delays.push(ms);
        if (delays.length === 2) controller.abort();
      },
    });
    expect({ errors: errors.length, calls, delays }).toEqual({ errors: 1, calls: 2, delays: [10, 100] });
  });
});
