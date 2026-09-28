// Полностью модельные статусы и источники: реальных интеграций с ведомствами нет.

import { describe, expect, it } from "vitest";
import type { ProcessStatus } from "../../src/processes/index.js";
import {
  createModelSources,
  MemoryProcessStatusRepository,
  ModelProcessStatusSource,
  ProcessStatusFeed,
} from "../../src/processes/index.js";

const status = (authority: string, value: ProcessStatus["status"], updatedAt: string): ProcessStatus => ({
  contractVersion: 1,
  processId: `model-${authority}`,
  companyId: "model-company",
  authority,
  serviceName: "Модельное заявление",
  status: value,
  updatedAt,
  source: {
    system: "fixture",
    url: "https://example.invalid/model-process",
    recordId: `model-${authority}`,
    retrievedAt: updatedAt,
    isModel: true,
  },
});

describe("ProcessStatusFeed", () => {
  it("смена статуса даёт одно модельное уведомление, повтор — ни одного", async () => {
    const repository = new MemoryProcessStatusRepository();
    const first = new ProcessStatusFeed(
      [new ModelProcessStatusSource("ФНС России", [status("ФНС России", "submitted", "2026-09-27T10:00:00Z")])],
      repository,
    );
    expect(await first.refresh("model-company")).toEqual({ notifications: [], unavailable: [] });

    const changed = new ProcessStatusFeed(
      [new ModelProcessStatusSource("ФНС России", [status("ФНС России", "in_review", "2026-09-27T11:00:00Z")])],
      repository,
      () => Date.parse("2026-09-27T12:00:00Z"),
    );
    const {
      notifications: [notification],
      unavailable,
    } = await changed.refresh("model-company");
    expect(unavailable).toEqual([]);
    expect(notification).toMatchObject({
      previousStatus: "submitted",
      newStatus: "in_review",
      isModel: true,
      dedupKey: "model-ФНС России:submitted:in_review:2026-09-27T11:00:00Z",
    });
    expect(notification?.text).toBe(
      "Модельное уведомление: статус «Модельное заявление» изменён: подано → на рассмотрении.",
    );
    expect((await changed.refresh("model-company")).notifications).toEqual([]);
  });

  it("отказ одного ведомства не мешает получить смену статуса у другого", async () => {
    const repository = new MemoryProcessStatusRepository();
    await repository.save(status("Роспотребнадзор", "submitted", "2026-09-27T10:00:00Z"));
    const failing = {
      info: { name: "ФНС России", isModel: true },
      list: async (): Promise<ProcessStatus[]> => {
        throw new Error("модельный таймаут");
      },
    };
    const feed = new ProcessStatusFeed(
      [
        failing,
        new ModelProcessStatusSource("Роспотребнадзор", [
          status("Роспотребнадзор", "approved", "2026-09-27T11:00:00Z"),
        ]),
      ],
      repository,
    );

    const result = await feed.refresh("model-company");
    expect(result.unavailable).toEqual([{ source: "ФНС России", reason: "модельный таймаут" }]);
    expect(result.notifications.map((item) => item.newStatus)).toEqual(["approved"]);
  });

  it("создаёт явно модельные адаптеры нескольких ведомств", async () => {
    const sources = createModelSources([
      status("ФНС России", "accepted", "2026-09-27T10:00:00Z"),
      status("Роспотребнадзор", "approved", "2026-09-27T10:00:00Z"),
      status("МЧС России", "completed", "2026-09-27T10:00:00Z"),
    ]);
    expect(sources).toHaveLength(3);
    expect(sources.every((source) => source.info.isModel)).toBe(true);
    const items = await Promise.all(sources.map((source) => source.list("model-company")));
    expect(items.every((group) => group.every((item) => item.source.isModel))).toBe(true);
  });

  it("отвергает немодельную запись в модельном адаптере", () => {
    const invalid = {
      ...status("ФНС России", "accepted", "2026-09-27T10:00:00Z"),
      source: { ...status("ФНС России", "accepted", "2026-09-27T10:00:00Z").source, isModel: false },
    };
    expect(() => new ModelProcessStatusSource("ФНС России", [invalid])).toThrow("немодельный статус");
  });
});
