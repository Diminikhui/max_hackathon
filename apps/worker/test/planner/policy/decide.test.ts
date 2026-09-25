// Тесты политики частоты уведомлений (K-20b). Все данные модельные, ИНН вымышленные (K-28).
import { CONTRACT_VERSION, type NotificationCandidate, type NotificationReason } from "@max-hackathon/domain";
import { describe, expect, it } from "vitest";
import {
  countInMskMonth,
  DEFAULT_MONTHLY_LIMIT,
  decide,
  decideAll,
  mskMonthKey,
  POLICY_DECISION_CODES,
  type PolicyBatchContext,
  type PolicyContext,
} from "../../../src/planner/policy/index.js";

const COMPANY = "model-company-7700000016";
const OTHER_COMPANY = "model-company-1600000011";

let sequence = 0;
const candidate = (reason: NotificationReason, extra: Partial<NotificationCandidate> = {}): NotificationCandidate => {
  sequence += 1;
  const early = reason === "early_signal";
  return {
    contractVersion: CONTRACT_VERSION,
    id: `candidate-${sequence}`,
    companyId: COMPANY,
    changeEventId: "model-event-1",
    reason,
    ...(early ? {} : { requirementId: `model-req-${sequence}`, previousStatus: "not_applies" as const }),
    newStatus: early ? "needs_review" : "applies",
    matchedFactKeys: ["okved.main"],
    dedupKey: `${reason}:${sequence}`,
    isModel: true,
    createdAt: "2026-09-25T09:00:00Z",
    ...extra,
  };
};

const context = (extra: Partial<PolicyContext> = {}): PolicyContext => ({
  isDuplicate: false,
  sentThisMonth: 0,
  ...extra,
});

describe("дедупликация", () => {
  it("повтор по dedupKey не отправляется ни для одной причины", () => {
    for (const reason of ["became_applicable", "no_longer_applicable", "status_changed", "early_signal"] as const) {
      expect(decide(candidate(reason), context({ isDuplicate: true, relevance: 1 }))).toEqual({
        action: "suppress",
        code: "duplicate",
        countsTowardLimit: false,
      });
    }
  });

  it("повтор внутри одного прогона подавляется, у другой компании — нет", () => {
    const first = candidate("became_applicable", { dedupKey: "req-1:applies" });
    const repeat = candidate("became_applicable", { dedupKey: "req-1:applies" });
    const otherCompany = candidate("became_applicable", { dedupKey: "req-1:applies", companyId: OTHER_COMPANY });
    const result = decideAll([first, repeat, otherCompany], {
      isDuplicate: () => false,
      sentThisMonth: () => 0,
    });
    expect(result.map((item) => item.decision.code)).toEqual(["priority_reason", "duplicate", "priority_reason"]);
  });

  it("уже сохранённый в хранилище кандидат подавляется в пакете", () => {
    const stored = new Set([`${COMPANY}|seen`]);
    const result = decideAll([candidate("status_changed", { dedupKey: "seen" })], {
      isDuplicate: (companyId, dedupKey) => stored.has(`${companyId}|${dedupKey}`),
      sentThisMonth: () => 0,
    });
    expect(result[0]?.decision.code).toBe("duplicate");
  });
});

describe("отключение", () => {
  it("отключённые уведомления подавляют любую причину, включая новую обязанность", () => {
    for (const reason of ["became_applicable", "no_longer_applicable", "status_changed", "early_signal"] as const) {
      const decision = decide(
        candidate(reason),
        context({ settings: { enabled: false, earlySignals: true }, relevance: 1 }),
      );
      expect(decision).toEqual({ action: "suppress", code: "notifications_disabled", countsTowardLimit: false });
    }
  });

  it("отключение ранних сигналов не трогает остальные причины", () => {
    const settings = { enabled: true, earlySignals: false };
    expect(decide(candidate("early_signal"), context({ settings, relevance: 1 })).code).toBe("early_signals_disabled");
    expect(decide(candidate("became_applicable"), context({ settings })).action).toBe("send");
    expect(decide(candidate("status_changed"), context({ settings })).action).toBe("send");
  });

  it("без настроек всё включено", () => {
    expect(decide(candidate("early_signal"), context({ relevance: 0.9 })).action).toBe("send");
  });
});

describe("порог релевантности", () => {
  it("ранний сигнал ниже порога и без оценки подавляется, на пороге — отправляется", () => {
    expect(decide(candidate("early_signal"), context({ relevance: 0.49 })).code).toBe("below_relevance_threshold");
    expect(decide(candidate("early_signal"), context()).code).toBe("relevance_unknown");
    expect(decide(candidate("early_signal"), context({ relevance: Number.NaN })).code).toBe("relevance_unknown");
    expect(decide(candidate("early_signal"), context({ relevance: 0.5 })).action).toBe("send");
  });

  it("порог настраивается и не применяется к изменениям обязанностей", () => {
    expect(decide(candidate("early_signal"), context({ relevance: 0.7 }), { earlySignalThreshold: 0.8 }).code).toBe(
      "below_relevance_threshold",
    );
    expect(decide(candidate("status_changed"), context({ relevance: 0 })).action).toBe("send");
  });
});

describe("месячный лимит", () => {
  it("лимит соблюдается: сверх лимита — в сводку, а не отправка", () => {
    expect(decide(candidate("status_changed"), context({ sentThisMonth: DEFAULT_MONTHLY_LIMIT - 1 }))).toEqual({
      action: "send",
      code: "within_monthly_limit",
      countsTowardLimit: true,
    });
    expect(decide(candidate("status_changed"), context({ sentThisMonth: DEFAULT_MONTHLY_LIMIT }))).toEqual({
      action: "digest",
      code: "monthly_limit_reached",
      countsTowardLimit: false,
    });
    expect(decide(candidate("early_signal"), context({ sentThisMonth: 10, relevance: 1 })).action).toBe("digest");
  });

  it("лимит настраивается; 0 отправляет всё неважное в сводку", () => {
    expect(decide(candidate("status_changed"), context({ sentThisMonth: 1 }), { monthlyLimit: 1 }).action).toBe(
      "digest",
    );
    expect(decide(candidate("status_changed"), context(), { monthlyLimit: 0 }).action).toBe("digest");
  });

  it("новая или снятая обязанность не теряется молча при исчерпанном лимите", () => {
    for (const reason of ["became_applicable", "no_longer_applicable"] as const) {
      expect(decide(candidate(reason), context({ sentThisMonth: 100 }))).toEqual({
        action: "send",
        code: "priority_reason",
        countsTowardLimit: true,
      });
    }
  });

  it("в пакете отправки этого прогона расходуют лимит, модельные кандидаты считаются так же", () => {
    const batch = [
      candidate("became_applicable"),
      candidate("status_changed"),
      candidate("status_changed", { isModel: false }),
      candidate("early_signal"),
      candidate("status_changed", { companyId: OTHER_COMPANY }),
    ];
    const ctx: PolicyBatchContext = {
      isDuplicate: () => false,
      sentThisMonth: (companyId) => (companyId === COMPANY ? 1 : 0),
      relevance: () => 0.9,
    };
    const result = decideAll(batch, ctx, { monthlyLimit: 3 });
    expect(result.map((item) => [item.decision.action, item.decision.code])).toEqual([
      ["send", "priority_reason"], // 1 → 2
      ["send", "within_monthly_limit"], // 2 → 3
      ["digest", "monthly_limit_reached"],
      ["digest", "monthly_limit_reached"],
      ["send", "within_monthly_limit"], // другая компания, свой лимит
    ]);
  });

  it("некорректная конфигурация отклоняется", () => {
    expect(() => decide(candidate("status_changed"), context(), { monthlyLimit: -1 })).toThrow(RangeError);
    expect(() => decide(candidate("status_changed"), context(), { monthlyLimit: 1.5 })).toThrow(RangeError);
    expect(() => decide(candidate("status_changed"), context(), { earlySignalThreshold: 2 })).toThrow(RangeError);
  });
});

describe("календарный месяц по МСК", () => {
  it("граница месяца считается по Москве (UTC+3)", () => {
    expect(mskMonthKey("2026-09-30T20:59:59Z")).toBe("2026-09");
    expect(mskMonthKey("2026-09-30T21:00:00Z")).toBe("2026-10");
    expect(mskMonthKey("2026-12-31T21:00:00Z")).toBe("2027-01");
    expect(mskMonthKey(new Date("2026-10-01T00:00:00+03:00"))).toBe("2026-10");
    expect(() => mskMonthKey("не дата")).toThrow(RangeError);
  });

  it("счётчик берёт sent и queued текущего месяца МСК своей компании", () => {
    const base = { companyId: COMPANY, createdAt: "2026-09-10T10:00:00Z" };
    const notifications = [
      { ...base, status: "sent" as const, sentAt: "2026-09-30T20:30:00Z" }, // 23:30 МСК 30.09 — сентябрь
      { ...base, status: "sent" as const, sentAt: "2026-09-30T21:30:00Z" }, // 00:30 МСК 01.10 — октябрь
      { ...base, status: "queued" as const, createdAt: "2026-10-05T10:00:00Z" },
      { ...base, status: "failed" as const, createdAt: "2026-10-05T10:00:00Z" },
      { ...base, status: "suppressed" as const, createdAt: "2026-10-05T10:00:00Z" },
      { ...base, companyId: OTHER_COMPANY, status: "sent" as const, sentAt: "2026-10-02T10:00:00Z" },
    ];
    expect(countInMskMonth(notifications, COMPANY, "2026-10-01T00:00:00+03:00")).toBe(2);
    expect(countInMskMonth(notifications, COMPANY, "2026-09-30T20:59:59Z")).toBe(1);
  });

  it("исчерпанный в сентябре лимит не мешает в октябре", () => {
    const sent = Array.from({ length: DEFAULT_MONTHLY_LIMIT }, (_, index) => ({
      companyId: COMPANY,
      status: "sent" as const,
      createdAt: "2026-09-29T10:00:00Z",
      sentAt: `2026-09-30T20:5${index}:00Z`,
    }));
    const september = countInMskMonth(sent, COMPANY, "2026-09-30T20:59:00Z");
    const october = countInMskMonth(sent, COMPANY, "2026-09-30T21:01:00Z");
    expect(decide(candidate("status_changed"), context({ sentThisMonth: september })).action).toBe("digest");
    expect(decide(candidate("status_changed"), context({ sentThisMonth: october })).action).toBe("send");
  });
});

describe("детерминизм и стабильность кодов", () => {
  it("одинаковый вход даёт одинаковый результат и не меняет вход", () => {
    const batch = [candidate("became_applicable"), candidate("early_signal"), candidate("status_changed")];
    const snapshot = structuredClone(batch);
    const ctx: PolicyBatchContext = { isDuplicate: () => false, sentThisMonth: () => 3, relevance: () => 0.6 };
    expect(decideAll(batch, ctx)).toEqual(decideAll(batch, ctx));
    expect(batch).toEqual(snapshot);
  });

  it("набор кодов причин зафиксирован", () => {
    expect(POLICY_DECISION_CODES).toEqual([
      "priority_reason",
      "within_monthly_limit",
      "monthly_limit_reached",
      "duplicate",
      "notifications_disabled",
      "early_signals_disabled",
      "relevance_unknown",
      "below_relevance_threshold",
    ]);
  });
});
