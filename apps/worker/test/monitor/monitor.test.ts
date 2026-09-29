// 5-05 и #295. События источников, контур пакетов правил и плановая перепроверка. Все события — модельные.
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

interface SetupOptions {
  failFor?: string;
  failOnEventOnce?: boolean;
  rulepacks?: () => Promise<unknown>;
}

const setup = (sources: EventSource[], options: SetupOptions = {}) => {
  let failOnEvent = options.failOnEventOnce ?? false;
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
    ...(options.rulepacks ? { rulepacks: options.rulepacks } : {}),
    onEvent: async (event) => {
      if (failOnEvent) {
        failOnEvent = false;
        throw new Error("сбой планировщика");
      }
      forwarded.push(event.id);
    },
    clock: () => new Date("2026-09-27T12:00:00Z"),
  });
  return { monitor, calls, forwarded, events };
};

describe("SourceMonitor.pollSources — события источников", () => {
  it("документ ленты и profile_change передаются дальше без пересчёта и сохраняются", async () => {
    const { monitor, calls, forwarded, events } = setup([source("feed", [[documentEvent("d1"), profileEvent("p1")]])]);
    const report = await monitor.pollSources();
    expect(report).toEqual({ newEvents: ["d1", "p1"], recalculated: 0, errors: [] });
    expect(calls).toEqual([]);
    expect(forwarded).toEqual(["d1", "p1"]);
    expect([...events.items.keys()].sort()).toEqual(["d1", "p1"]);
  });

  it("известное событие и повтор в одном опросе не передаются снова", async () => {
    const d1 = documentEvent("d1");
    const { monitor, forwarded } = setup([source("a", [[d1, d1], [d1]]), source("b", [[d1]])]);
    await monitor.pollSources();
    expect(await monitor.pollSources()).toEqual({ newEvents: [], recalculated: 0, errors: [] });
    expect(forwarded).toEqual(["d1"]);
  });

  it("rulepack_version от источника отклоняется: его создаёт только контур K-30a", async () => {
    const { monitor, calls, forwarded, events } = setup([source("rulepacks", [[rulepackEvent("e1")]])]);
    const report = await monitor.pollSources();
    expect(report.newEvents).toEqual([]);
    expect(report.errors).toMatchObject([{ stage: "poll", target: "rulepacks" }]);
    expect(calls).toEqual([]);
    expect(forwarded).toEqual([]);
    expect(events.items.size).toBe(0);
  });

  it("события обрабатываются по времени; недоступный источник не мешает остальным", async () => {
    const broken: EventSource = {
      name: "broken",
      poll: async () => {
        throw new Error("недоступен");
      },
    };
    const late = { ...documentEvent("late"), occurredAt: "2026-09-27T11:00:00Z" };
    const early = { ...documentEvent("early"), occurredAt: "2026-09-27T08:00:00Z" };
    const { monitor } = setup([broken, source("ok", [[late, early]])]);
    const report = await monitor.pollSources();
    expect(report.newEvents).toEqual(["early", "late"]);
    expect(report.errors).toMatchObject([{ stage: "poll", target: "broken" }]);
  });

  it("событие записывается после передачи: сбой onEvent → событие обрабатывается при следующем опросе", async () => {
    const d1 = documentEvent("d1");
    const { monitor, forwarded, events } = setup([source("feed", [[d1], [d1]])], { failOnEventOnce: true });
    const first = await monitor.pollSources();
    expect(first.errors).toMatchObject([{ stage: "on_event", target: "d1" }]);
    expect(events.items.has("d1")).toBe(false);

    expect(await monitor.pollSources()).toEqual({ newEvents: ["d1"], recalculated: 0, errors: [] });
    expect(forwarded).toEqual(["d1"]);
  });

  it("контур пакетов правил выполняется в начале опроса; его сбой не мешает источникам", async () => {
    const order: string[] = [];
    const { monitor } = setup(
      [
        {
          name: "feed",
          poll: async () => {
            order.push("poll");
            return [];
          },
        },
      ],
      {
        rulepacks: async () => {
          order.push("rulepacks");
          throw new Error("сбой контура");
        },
      },
    );
    const report = await monitor.pollSources();
    expect(order).toEqual(["rulepacks", "poll"]);
    expect(report.errors).toMatchObject([{ stage: "rulepacks" }]);
  });
});

describe("SourceMonitor.recheckAll — плановая перепроверка", () => {
  it("пересчитывает все компании с триггером schedule; одна ошибка не прерывает остальные", async () => {
    const { monitor, calls } = setup([], { failFor: "c1" });
    const report = await monitor.recheckAll();
    expect(report).toMatchObject({ newEvents: [], recalculated: 1, errors: [{ stage: "recalculate", target: "c1" }] });
    expect(calls).toEqual([{ companyId: "c2", trigger: { kind: "schedule", startedAt: "2026-09-27T12:00:00.000Z" } }]);
  });

  it("сначала контур пакетов правил, затем пересчёт", async () => {
    const order: string[] = [];
    const { monitor, calls } = setup([], { rulepacks: async () => void order.push("rulepacks") });
    await monitor.recheckAll();
    expect(order).toEqual(["rulepacks"]);
    expect(calls).toHaveLength(2);
  });

  it("сбой контура пакетов правил → перепроверка не выполняется", async () => {
    const { monitor, calls } = setup([], {
      rulepacks: async () => {
        throw new Error("сбой контура");
      },
    });
    const report = await monitor.recheckAll();
    expect(report).toMatchObject({ recalculated: 0, errors: [{ stage: "rulepacks" }] });
    expect(calls).toEqual([]);
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

  it("перепроверка, пропущенная из-за сбоя контура пакетов правил, повторяется на следующем тике", async () => {
    let failures = 2;
    const { monitor } = setup([], {
      rulepacks: async () => {
        if (failures-- > 0) throw new Error("сбой контура");
      },
    });
    const runs: string[] = [];
    const controller = new AbortController();
    let time = 0;
    await runMonitorLoop(monitor, {
      pollIntervalMs: 10,
      recheckIntervalMs: 1000,
      signal: controller.signal,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
        if (time === 20) controller.abort();
      },
      onReport: (run, report) => runs.push(`${time}:${run}:${report.recalculated}`),
    });
    // Тик 0: контур упал в опросе и в перепроверке — пересчёта нет. Тик 10: контур исправен, перепроверка
    // выполняется, не дожидаясь recheckIntervalMs.
    expect(runs).toEqual(["0:poll:0", "0:recheck:0", "10:poll:0", "10:recheck:2"]);
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
