// 5-05. Пересчёт запускается событием источника и по расписанию. Все события — модельные.
import type { ChangeEvent, ChangeEventRepository, Id } from "@max-hackathon/domain";
import { describe, expect, it } from "vitest";
import { type EventSource, type RecalcTrigger, runMonitorLoop, SourceMonitor } from "../../src/monitor/index.js";

const rulepackEvent = (id: string, occurredAt = "2026-09-27T10:00:00Z"): ChangeEvent => ({
  contractVersion: 1,
  id,
  kind: "rulepack_version",
  occurredAt,
  isModel: true,
  rulepack: {
    packId: "k28-model",
    fromVersion: 1,
    toVersion: 2,
    addedRequirementIds: ["k28.water-marking"],
    changedRequirementIds: [],
    removedRequirementIds: [],
  },
});

const documentEvent = (id: string): ChangeEvent => ({
  contractVersion: 1,
  id,
  kind: "regulation_document",
  occurredAt: "2026-09-27T09:00:00Z",
  isModel: true,
  document: {
    documentId: "model-doc",
    title: "Модельный проект акта",
    url: "https://regulation.gov.ru/model",
    publishedAt: "2026-09-27T09:00:00Z",
    source: { system: "fixture", retrievedAt: "2026-09-27T09:00:00Z", isModel: true },
  },
});

const profileEvent = (id: string): ChangeEvent => ({
  contractVersion: 1,
  id,
  kind: "profile_change",
  occurredAt: "2026-09-27T09:00:00Z",
  isModel: true,
  profile: { companyId: "c1", changedFactKeys: ["employment.has_employees"] },
});

class MemoryEvents implements ChangeEventRepository {
  readonly items = new Map<Id, ChangeEvent>();
  async append(event: ChangeEvent) {
    this.items.set(event.id, event);
  }
  async get(id: Id) {
    return this.items.get(id);
  }
}

const source = (name: string, batches: ChangeEvent[][]): EventSource => ({
  name,
  poll: async () => batches.shift() ?? [],
});

const setup = (sources: EventSource[], options: { failFor?: string } = {}) => {
  const calls: Array<{ companyId: Id; trigger: RecalcTrigger }> = [];
  const forwarded: Id[] = [];
  const events = new MemoryEvents();
  const monitor = new SourceMonitor({
    sources,
    events,
    listCompanyIds: async () => ["c2", "c1", "c1"],
    recalculate: async (companyId, trigger) => {
      if (companyId === options.failFor) throw new Error("сбой пересчёта");
      calls.push({ companyId, trigger });
    },
    onEvent: async (event) => {
      forwarded.push(event.id);
    },
    clock: () => new Date("2026-09-27T12:00:00Z"),
  });
  return { monitor, calls, forwarded, events };
};

describe("SourceMonitor.pollSources — пересчёт по событию", () => {
  it("новая версия пакета правил → пересчёт всех компаний один раз, событие сохранено и передано дальше", async () => {
    const { monitor, calls, forwarded, events } = setup([source("rulepacks", [[rulepackEvent("e1")]])]);
    const report = await monitor.pollSources();
    expect(report).toEqual({ newEvents: ["e1"], recalculated: 2, errors: [] });
    expect(calls.map((c) => c.companyId)).toEqual(["c1", "c2"]);
    expect(calls[0]?.trigger).toMatchObject({ kind: "event", event: { id: "e1" } });
    expect(events.items.has("e1")).toBe(true);
    expect(forwarded).toEqual(["e1"]);
  });

  it("известное событие и повтор в одном опросе не запускают пересчёт снова", async () => {
    const e1 = rulepackEvent("e1");
    const { monitor, calls } = setup([source("a", [[e1, e1], [e1]]), source("b", [[e1]])]);
    await monitor.pollSources();
    expect(calls).toHaveLength(2);
    expect(await monitor.pollSources()).toEqual({ newEvents: [], recalculated: 0, errors: [] });
    expect(calls).toHaveLength(2);
  });

  it("документ ленты и profile_change передаются планировщику без пересчёта", async () => {
    const { monitor, calls, forwarded } = setup([source("feed", [[documentEvent("d1"), profileEvent("p1")]])]);
    const report = await monitor.pollSources();
    expect(report.recalculated).toBe(0);
    expect(calls).toEqual([]);
    expect(forwarded.sort()).toEqual(["d1", "p1"]);
  });

  it("события обрабатываются по времени; недоступный источник не мешает остальным", async () => {
    const broken: EventSource = {
      name: "broken",
      poll: async () => {
        throw new Error("недоступен");
      },
    };
    const late = rulepackEvent("late", "2026-09-27T11:00:00Z");
    const early = rulepackEvent("early", "2026-09-27T08:00:00Z");
    const { monitor } = setup([broken, source("ok", [[late, early]])]);
    const report = await monitor.pollSources();
    expect(report.newEvents).toEqual(["early", "late"]);
    expect(report.errors).toMatchObject([{ stage: "poll", target: "broken" }]);
  });

  it("сбой пересчёта одной компании фиксируется, остальные пересчитываются", async () => {
    const { monitor, calls } = setup([source("r", [[rulepackEvent("e1")]])], { failFor: "c1" });
    const report = await monitor.pollSources();
    expect(calls.map((c) => c.companyId)).toEqual(["c2"]);
    expect(report.recalculated).toBe(1);
    expect(report.errors).toMatchObject([{ stage: "recalculate", target: "c1" }]);
  });
});

describe("SourceMonitor.recheckAll — плановая перепроверка", () => {
  it("пересчитывает все компании с триггером schedule", async () => {
    const { monitor, calls } = setup([]);
    expect(await monitor.recheckAll()).toEqual({ newEvents: [], recalculated: 2, errors: [] });
    expect(calls.map((c) => c.trigger)).toEqual([
      { kind: "schedule", startedAt: "2026-09-27T12:00:00.000Z" },
      { kind: "schedule", startedAt: "2026-09-27T12:00:00.000Z" },
    ]);
  });
});

describe("runMonitorLoop", () => {
  it("опрашивает каждый тик, перепроверяет сразу при старте и затем раз в recheckIntervalMs", async () => {
    const { monitor } = setup([]);
    const runs: string[] = [];
    const controller = new AbortController();
    let time = 0;
    let ticks = 0;
    await runMonitorLoop(monitor, {
      pollIntervalMs: 10,
      recheckIntervalMs: 25,
      signal: controller.signal,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
        if (++ticks === 6) controller.abort();
      },
      onReport: (run) => runs.push(`${time}:${run}`),
    });
    expect(runs).toEqual(["0:poll", "0:recheck", "10:poll", "20:poll", "30:poll", "30:recheck", "40:poll", "50:poll"]);
  });

  it("ошибка прогона не останавливает цикл", async () => {
    let polls = 0;
    const failing = {
      pollSources: async () => {
        polls += 1;
        throw new Error("БД недоступна");
      },
      recheckAll: async () => ({ newEvents: [], recalculated: 0, errors: [] }),
    } as unknown as SourceMonitor;
    const errors: unknown[] = [];
    const controller = new AbortController();
    await runMonitorLoop(failing, {
      signal: controller.signal,
      sleep: async () => {
        if (polls === 3) controller.abort();
      },
      onError: (error) => errors.push(error),
    });
    expect(polls).toBe(3);
    expect(errors).toHaveLength(3);
  });
});
