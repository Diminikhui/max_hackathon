import { describe, expect, it } from "vitest";
import {
  AccessDeniedError,
  assertCompanyAccess,
  canAccessCompany,
  DATA_CATEGORIES,
  DEFAULT_INIT_DATA_MAX_AGE_SEC,
  isRetentionExpired,
  RETENTION_POLICY,
  retentionCutoff,
} from "../src/index.js";

const NOW = new Date("2026-09-29T12:00:00Z");
const DAY_MS = 24 * 3600 * 1000;

describe("сроки хранения", () => {
  it("задан срок и основание для каждой категории", () => {
    for (const category of DATA_CATEGORIES) {
      const rule = RETENTION_POLICY[category];
      expect(rule.ttlSec).toBeGreaterThanOrEqual(0);
      expect(rule.basis.length).toBeGreaterThan(0);
    }
  });

  it("initData не хранится, сессия не переживает initData", () => {
    expect(RETENTION_POLICY.init_data.ttlSec).toBe(0);
    expect(RETENTION_POLICY.session.ttlSec).toBeLessThanOrEqual(DEFAULT_INIT_DATA_MAX_AGE_SEC);
  });

  it("связь пользователя с профилем живёт не дольше профиля", () => {
    expect(RETENTION_POLICY.user_binding.ttlSec).toBeLessThanOrEqual(RETENTION_POLICY.profile.ttlSec);
  });

  it("считает границу и истечение срока", () => {
    expect(retentionCutoff("notification", NOW).toISOString()).toBe(
      new Date(NOW.getTime() - 90 * DAY_MS).toISOString(),
    );
    expect(isRetentionExpired("notification", new Date(NOW.getTime() - 91 * DAY_MS), NOW)).toBe(true);
    expect(isRetentionExpired("notification", new Date(NOW.getTime() - 89 * DAY_MS), NOW)).toBe(false);
    expect(isRetentionExpired("init_data", NOW, NOW)).toBe(true);
  });
});

describe("доступ к данным", () => {
  const bindings = [
    { maxUserId: 1001, companyId: "model-cafe" },
    { maxUserId: 1002, companyId: "model-ip-1" },
  ];

  it("разрешает только привязанные профили", () => {
    expect(canAccessCompany({ maxUserId: 1001 }, "model-cafe", bindings)).toBe(true);
    expect(canAccessCompany({ maxUserId: 1001 }, "model-ip-1", bindings)).toBe(false);
    expect(canAccessCompany({ maxUserId: 1003 }, "model-cafe", [])).toBe(false);
  });

  it("assertCompanyAccess бросает AccessDeniedError без идентификаторов в сообщении", () => {
    expect(() => assertCompanyAccess({ maxUserId: 1001 }, "model-cafe", bindings)).not.toThrow();
    try {
      assertCompanyAccess({ maxUserId: 1001 }, "model-ip-1", bindings);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AccessDeniedError);
      expect((error as Error).message).not.toContain("1001");
      expect((error as Error).message).not.toContain("model-ip-1");
    }
  });
});
