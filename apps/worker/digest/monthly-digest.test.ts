import type { ApplicabilityResult, Notification } from "@max-hackathon/domain";
import { describe, expect, it } from "vitest";
import {
  type MonthlyDigestChecklistSource,
  type MonthlyDigestItem,
  monthlyDigestKey,
  runMonthlyDigest,
  runMonthlyDigestLoop,
} from "./index.js";

const requirement = (id: string, url: string, isModel = false): MonthlyDigestItem["requirement"] => ({
  basis: [{ act: `Модельный акт ${id}`, url }],
  source: { system: "model:test", retrievedAt: "2026-09-28T09:00:00.000Z", isModel },
});

const item = (id: string, status: ApplicabilityResult["status"], isModel = false): MonthlyDigestItem => ({
  requirement: requirement(id, `https://example.test/source/${id}`, isModel),
  applicability: { status },
});

const checklist = {
  asOf: "2026-09-28",
  packs: [
    { packId: "b-pack", packVersion: 2 },
    { packId: "a-pack", packVersion: 1 },
  ],
  items: [
    item("rule-3", "needs_review", true),
    item("rule-2", "applies"),
    item("rule-1", "not_applies"),
    item("rule-4", "insufficient_data"),
  ],
};

const setup = (
  options: { sentThisMonth?: number; chatId?: string | null; outcome?: "ok" | "profile_not_found" } = {},
) => {
  const queued: Notification[] = [];
  const ids = new Map<string, Notification>();
  let builds = 0;
  const checklists: MonthlyDigestChecklistSource = {
    listCompanyIds: async () => ["company-b", "company-a", "company-a"],
    build: async (_companyId, buildOptions) => {
      builds += 1;
      return options.outcome === "profile_not_found"
        ? { status: "profile_not_found" }
        : { status: "ok", profile: { isModel: false }, checklist: { ...checklist, asOf: buildOptions.asOf } };
    },
  };
  const dependencies = {
    checklists,
    recipients: { chatFor: async () => (options.chatId === null ? undefined : (options.chatId ?? "model-chat")) },
    notifications: {
      enqueue: async (notification: Notification) => {
        ids.set(notification.idempotencyKey, notification);
        queued.push(notification);
      },
      findByIdempotencyKey: async (key: string) => ids.get(key),
    },
    history: { sentThisMonth: async () => options.sentThisMonth ?? 0 },
    now: () => new Date("2026-09-28T09:00:00.000Z"),
  };
  return {
    dependencies,
    queued,
    ids,
    get builds() {
      return builds;
    },
  };
};

describe("ежемесячная сводка", () => {
  it("считает записи по одному снимку перечня и ставит модельное уведомление с первоисточниками", async () => {
    const context = setup();

    const report = await runMonthlyDigest(context.dependencies);

    expect(report).toMatchObject({ period: "2026-09", queued: 2, alreadyQueued: 0 });
    expect(context.queued).toHaveLength(2);
    expect(context.queued[0]).toMatchObject({
      id: "monthly-digest:company-a:2026-09",
      idempotencyKey: "monthly-digest:company-a:2026-09",
      createdAt: "2026-09-28T09:00:00.000Z",
      recipient: { channel: "max_bot", chatId: "model-chat" },
      automated: true,
      isModel: true,
    });
    expect(context.queued[0]?.text).toContain("Проверено записей: 4.");
    expect(context.queued[0]?.text).toContain("Применяется к компании: 1.");
    expect(context.queued[0]?.text).toContain("Перечень актуален на 2026-09-28.");
    expect(context.queued[0]?.text).toContain("https://example.test/source/rule-2");
    expect(context.queued[0]?.text).toContain("Модельные данные");
    expect(context.queued[0]?.sourceUrls).toEqual([
      "https://example.test/source/rule-1",
      "https://example.test/source/rule-2",
      "https://example.test/source/rule-3",
      "https://example.test/source/rule-4",
    ]);
    expect(context.builds).toBe(2);
  });

  it("не ставит вторую сводку в очередь за тот же месяц, но ставит следующую за новый", async () => {
    const context = setup();
    await runMonthlyDigest(context.dependencies);

    const repeated = await runMonthlyDigest(context.dependencies);
    expect(repeated).toMatchObject({ queued: 0, alreadyQueued: 2 });
    expect(context.queued).toHaveLength(2);

    const nextMonth = await runMonthlyDigest({
      ...context.dependencies,
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(nextMonth.period).toBe("2026-10");
    expect(nextMonth.queued).toBe(2);
    expect(monthlyDigestKey("company-a", "2026-10")).not.toBe(monthlyDigestKey("company-a", "2026-09"));
  });

  it("использует московский календарный месяц при UTC-переходе границы", async () => {
    const context = setup();

    const report = await runMonthlyDigest({
      ...context.dependencies,
      now: () => new Date("2026-09-30T22:00:00.000Z"),
    });

    expect(report.period).toBe("2026-10");
    expect(context.queued[0]?.idempotencyKey).toBe("monthly-digest:company-a:2026-10");
    expect(context.queued[0]?.text).toContain("актуален на 2026-10-01");
  });

  it("соблюдает месячный лимит до построения перечня", async () => {
    const context = setup({ sentThisMonth: 4 });

    const report = await runMonthlyDigest(context.dependencies);

    expect(report).toMatchObject({ queued: 0, frequencyLimited: 2 });
    expect(context.queued).toHaveLength(0);
    expect(context.builds).toBe(0);
  });

  it("проверяет сводку при запуске, затем продолжает до отмены worker-процесса", async () => {
    const context = setup();
    const controller = new AbortController();
    const reports: string[] = [];

    await runMonthlyDigestLoop(context.dependencies, {
      signal: controller.signal,
      intervalMs: 60_000,
      onReport: (report) => reports.push(report.period),
      sleep: async () => controller.abort(),
    });

    expect(reports).toEqual(["2026-09"]);
    expect(context.queued).toHaveLength(2);
  });

  it("не создаёт уведомление без получателя, профиля или официального первоисточника", async () => {
    const noRecipient = setup({ chatId: null });
    expect(await runMonthlyDigest(noRecipient.dependencies)).toMatchObject({ noRecipient: 2, queued: 0 });

    const missingProfile = setup({ outcome: "profile_not_found" });
    expect(await runMonthlyDigest(missingProfile.dependencies)).toMatchObject({ missingProfile: 2, queued: 0 });

    const missingSource = setup();
    missingSource.dependencies.checklists.build = async (_companyId, options) => ({
      status: "ok",
      profile: { isModel: false },
      checklist: {
        ...checklist,
        asOf: options.asOf,
        items: [
          {
            requirement: {
              basis: [],
              source: { system: "model:test", retrievedAt: options.evaluatedAt, isModel: false },
            },
            applicability: { status: "applies" },
          },
        ],
      },
    });
    expect(await runMonthlyDigest(missingSource.dependencies)).toMatchObject({ missingPrimarySource: 2, queued: 0 });
  });
});
