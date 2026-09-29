// Модельные данные: ИНН из data/fixtures/k28-companies.json, ФИО и id выдуманы.
import { createLogger, type LogRecord } from "@max-hackathon/observability";
import { describe, expect, it } from "vitest";
import {
  isPersonalInn,
  maskInn,
  pseudonymize,
  signInitDataForTest,
  toLogSafeProfile,
  verifyInitData,
} from "../src/index.js";

const MODEL_KEY = "model-pseudonym-key-not-real-0123456789";
const MODEL_TOKEN = "model-token-not-real";
const NOW = 1_790_000_000_000;
const MODEL_FULL_NAME = "Модельный Индивидуальный Предприниматель";
const MODEL_IP_INN = "770000000082";

const ipProfile = {
  companyId: "model-ip-1",
  inn: MODEL_IP_INN,
  entityType: "individual_entrepreneur",
  displayName: `ИП ${MODEL_FULL_NAME}`,
  facts: [{}, {}],
  isModel: true,
};

describe("pseudonymize", () => {
  it("стабилен для одного ключа и назначения и не раскрывает исходное значение", () => {
    const a = pseudonymize(1001, MODEL_KEY, "log");
    expect(a).toBe(pseudonymize("1001", MODEL_KEY, "log"));
    expect(a).toMatch(/^p_[A-Za-z0-9_-]{22}$/);
    expect(a).not.toContain("1001");
  });

  it("разводит назначения и ключи", () => {
    const a = pseudonymize(1001, MODEL_KEY, "log");
    expect(pseudonymize(1001, MODEL_KEY, "metrics")).not.toBe(a);
    expect(pseudonymize(1001, `${MODEL_KEY}-other`, "log")).not.toBe(a);
  });

  it("отклоняет короткий ключ и пустое назначение", () => {
    expect(() => pseudonymize(1001, "short", "log")).toThrow();
    expect(() => pseudonymize(1001, MODEL_KEY, "")).toThrow();
  });
});

describe("маскирование и профиль", () => {
  it("маскирует ИНН и различает ИНН ИП", () => {
    expect(maskInn("7700000016")).toBe("77******16");
    expect(maskInn(MODEL_IP_INN)).toBe("77********82");
    expect(maskInn("не ИНН")).toBe("***");
    expect(isPersonalInn(MODEL_IP_INN)).toBe(true);
    expect(isPersonalInn("7700000016")).toBe(false);
  });

  it("toLogSafeProfile убирает ИНН и ФИО", () => {
    expect(toLogSafeProfile(ipProfile)).toEqual({
      companyId: "model-ip-1",
      entityType: "individual_entrepreneur",
      isModel: true,
      factCount: 2,
    });
  });
});

describe("ПДн не попадают в логи", () => {
  function captureLogs() {
    const records: LogRecord[] = [];
    return { logger: createLogger((record) => records.push(record)), text: () => JSON.stringify(records) };
  }

  it("проверенный initData, псевдоним и безопасный профиль логируются без ПДн", () => {
    const initData = signInitDataForTest(
      {
        auth_date: String(NOW / 1000 - 10),
        user: JSON.stringify({ id: 5550001, first_name: "Модельный", username: "model_user" }),
        start_param: "case_42",
      },
      MODEL_TOKEN,
    );
    const verified = verifyInitData(initData, MODEL_TOKEN, { now: NOW });
    const { logger, text } = captureLogs();

    logger.info("miniapp.login", "Вход в мини-приложение", {
      initData,
      session: verified,
      user: pseudonymize(verified.maxUserId, MODEL_KEY, "log"),
      profile: toLogSafeProfile(ipProfile),
    });

    const logged = text();
    for (const value of ["5550001", "Модельный", "model_user", MODEL_IP_INN, MODEL_FULL_NAME, "hash="]) {
      expect(logged).not.toContain(value);
    }
  });

  it("ИНН и ФИО в тексте сообщения и в ключах ПДн маскируются логгером", () => {
    const { logger, text } = captureLogs();
    logger.warn("profile.lookup", `Не найден профиль по ИНН ${MODEL_IP_INN}`, {
      inn: MODEL_IP_INN,
      fullName: MODEL_FULL_NAME,
      chatId: "123456789012",
    });
    const logged = text();
    expect(logged).not.toContain(MODEL_IP_INN);
    expect(logged).not.toContain(MODEL_FULL_NAME);
    expect(logged).not.toContain("123456789012");
  });

  it("профиль целиком нельзя логировать: displayName ИП логгер не маскирует", () => {
    // Фиксирует известное ограничение observability: поэтому профиль логируется только через toLogSafeProfile.
    const { logger, text } = captureLogs();
    logger.info("profile.loaded", "Профиль загружен", { profile: ipProfile });
    expect(text()).toContain(MODEL_FULL_NAME);
    expect(text()).not.toContain(MODEL_IP_INN);
  });
});
