// Тесты K-25a: разбор ИНН. Все номера вымышленные (модельные), валидные взяты из data/fixtures/k28-companies.json.
import { describe, expect, it } from "vitest";
import {
  hasValidInnChecksum,
  INN_ERROR_CODES,
  INN_MESSAGES,
  type InnErrorCode,
  normalizeInnInput,
  parseInn,
} from "../../../src/index.js";

const VALID_LEGAL = ["7700000016", "1600000011", "7700000023", "7700000030"];
const VALID_IP = "770000000082";

function errorCode(input: string): InnErrorCode | undefined {
  const result = parseInn(input);
  return result.ok ? undefined : result.error.code;
}

describe("parseInn: валидные ИНН", () => {
  it.each(VALID_LEGAL)("10 цифр %s — организация", (inn) => {
    expect(parseInn(inn)).toEqual({ ok: true, inn, entityType: "legal_entity" });
  });

  it("12 цифр — ИП", () => {
    expect(parseInn(VALID_IP)).toEqual({ ok: true, inn: VALID_IP, entityType: "individual_entrepreneur" });
  });
});

describe("parseInn: нормализация ввода", () => {
  it.each([
    ["  7700000016  ", "7700000016"],
    ["77 00 000 016", "7700000016"],
    ["7700-000-016", "7700000016"],
    [" 7700 000016 ", "7700000016"],
    ["7700 000 016", "7700000016"],
    ["\t7700000016\n", "7700000016"],
    ["7700–000—016", "7700000016"],
    ["ИНН 7700000016", "7700000016"],
    ["инн: 7700000016", "7700000016"],
    ["ИНН № 7700 0000 0082", VALID_IP],
  ])("%j → %s", (input, inn) => {
    const result = parseInn(input);
    expect(result.ok && result.inn).toBe(inn);
  });

  it("normalizeInnInput сохраняет посторонние символы для сообщения об ошибке", () => {
    expect(normalizeInnInput(" 77 00-0a ")).toBe("77000a");
  });
});

describe("parseInn: ошибки", () => {
  it.each(["", "   ", " - ", "ИНН", "ИНН:"])("пусто: %j", (input) => {
    expect(errorCode(input)).toBe("empty");
  });

  it.each([
    "77000000I6",
    "7700000016a",
    "770.000.0016",
    "+7700000016",
    "7700000016/7701",
    "７７００００００１６", // полноширинные цифры
  ])("недопустимые символы: %j", (input) => {
    expect(errorCode(input)).toBe("invalid_characters");
  });

  it.each([
    ["1", "1 цифру"],
    ["770000001", "9 цифр"],
    ["77000000161", "11 цифр"],
    ["7700000000822", "13 цифр"],
    ["77000000008222", "14 цифр"],
    ["770000000082222222222", "21 цифру"],
    ["77", "2 цифры"],
  ])("неверная длина: %s (%s)", (input, count) => {
    const result = parseInn(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_length");
      expect(result.error.message).toBe(`ИНН организации — 10 цифр, ИП — 12. Вы ввели ${count}.`);
    }
  });

  it.each(["7700000017", "7700000061", "1600000012", "0700000016"])("неверная контрольная сумма (10): %s", (input) => {
    expect(errorCode(input)).toBe("invalid_checksum");
  });

  it("12 цифр: ошибка только в последней цифре", () => {
    expect(hasValidInnChecksum("770000000082")).toBe(true);
    for (let d = 0; d <= 9; d++) {
      const inn = `77000000008${d}`;
      expect(errorCode(inn)).toBe(d === 2 ? undefined : "invalid_checksum");
    }
  });

  it("12 цифр: ошибка только в 11-й цифре", () => {
    expect(errorCode("770000000072")).toBe("invalid_checksum");
  });

  it("перестановка соседних цифр ловится контрольной суммой", () => {
    expect(errorCode("7700000061")).toBe("invalid_checksum");
    expect(errorCode("0770000016")).toBe("invalid_checksum");
  });
});

describe("граничные случаи", () => {
  it("ИНН из одних нулей формально проходит контрольную сумму, но отклоняется: кода инспекции 00 нет", () => {
    expect(errorCode("0000000000")).toBe("invalid_checksum");
    expect(errorCode("000000000000")).toBe("invalid_checksum");
  });

  it("номер с кодом инспекции 00 отклоняется, даже если контрольная сумма сходится", () => {
    expect(hasValidInnChecksum("0012345673")).toBe(false);
  });

  it("hasValidInnChecksum не принимает ненормализованный ввод", () => {
    expect(hasValidInnChecksum(" 7700000016")).toBe(false);
    expect(hasValidInnChecksum("77000000161")).toBe(false);
  });

  it("порядок проверок: символы важнее длины", () => {
    expect(errorCode("abc")).toBe("invalid_characters");
  });
});

describe("сообщения", () => {
  it.each(INN_ERROR_CODES)("%s: по-русски, без технических слов", (code) => {
    const message = INN_MESSAGES[code];
    expect(message).toMatch(/[А-Яа-яЁё]/);
    expect(message).not.toMatch(/checksum|regex|null|undefined|контрольн|формат|валид/i);
  });

  it("коды ошибок стабильны", () => {
    expect(INN_ERROR_CODES).toEqual(["empty", "invalid_characters", "invalid_length", "invalid_checksum"]);
  });
});
