// Модельные тесты: токен и пользователь выдуманы, реальные данные не используются.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INIT_DATA_MAX_AGE_SEC,
  INIT_DATA_MAX_LENGTH,
  InitDataError,
  isSafeStartParam,
  isValidStartParam,
  signInitDataForTest,
  verifyInitData,
} from "../src/index.js";

const MODEL_TOKEN = "model-token-not-real";
const NOW = 1_790_000_000_000;
const AUTH_DATE = String(NOW / 1000 - 60);
const MODEL_USER = JSON.stringify({
  id: 1001,
  first_name: "Модельный",
  last_name: "Пользователь",
  username: "model_user",
  photo_url: "https://example.test/photo.jpg",
  language_code: "ru",
});

function signed(extra: Record<string, string> = {}): string {
  return signInitDataForTest(
    { auth_date: AUTH_DATE, query_id: "q1", user: MODEL_USER, start_param: "case_42", ...extra },
    MODEL_TOKEN,
  );
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof InitDataError ? error.code : "other";
  }
  return undefined;
}

describe("verifyInitData", () => {
  it("принимает корректно подписанный initData и возвращает только нужные поля", () => {
    const result = verifyInitData(signed({ chat: JSON.stringify({ id: -77, type: "group" }) }), MODEL_TOKEN, {
      now: NOW,
    });
    expect(result).toEqual({
      maxUserId: 1001,
      authDate: Number(AUTH_DATE),
      startParam: "case_42",
      chat: { id: -77, type: "group" },
      languageCode: "ru",
      queryId: "q1",
    });
  });

  it("не отдаёт имя, username и фото пользователя", () => {
    const serialized = JSON.stringify(verifyInitData(signed(), MODEL_TOKEN, { now: NOW }));
    for (const value of ["Модельный", "Пользователь", "model_user", "photo"]) {
      expect(serialized).not.toContain(value);
    }
  });

  it("порядок полей не влияет на проверку", () => {
    const reversed = signed().split("&").reverse().join("&");
    expect(verifyInitData(reversed, MODEL_TOKEN, { now: NOW }).maxUserId).toBe(1001);
  });

  it("отклоняет подмену поля и чужой токен", () => {
    expect(codeOf(() => verifyInitData(signed().replace("case_42", "case_43"), MODEL_TOKEN, { now: NOW }))).toBe(
      "bad_hash",
    );
    expect(codeOf(() => verifyInitData(signed(), "other-model-token", { now: NOW }))).toBe("bad_hash");
    expect(codeOf(() => verifyInitData(signed().replace(/hash=[0-9a-f]+/, "hash=zz"), MODEL_TOKEN, { now: NOW }))).toBe(
      "bad_hash",
    );
  });

  it("отклоняет пустой, слишком длинный, битый и неполный initData", () => {
    expect(codeOf(() => verifyInitData("", MODEL_TOKEN))).toBe("empty");
    expect(codeOf(() => verifyInitData(undefined, MODEL_TOKEN))).toBe("empty");
    expect(codeOf(() => verifyInitData("a=".padEnd(INIT_DATA_MAX_LENGTH + 1, "x"), MODEL_TOKEN))).toBe("too_long");
    expect(codeOf(() => verifyInitData("novalue", MODEL_TOKEN))).toBe("malformed");
    expect(codeOf(() => verifyInitData("a=%E0%A4%A", MODEL_TOKEN))).toBe("malformed");
    expect(codeOf(() => verifyInitData(`${signed()}&auth_date=1`, MODEL_TOKEN, { now: NOW }))).toBe("duplicate");
    const noHash = signed().replace(/&?hash=[0-9a-f]+/, "");
    expect(codeOf(() => verifyInitData(noHash, MODEL_TOKEN, { now: NOW }))).toBe("no_hash");
  });

  it("требует пользователя с числовым id", () => {
    const noUser = signInitDataForTest({ auth_date: AUTH_DATE }, MODEL_TOKEN);
    expect(codeOf(() => verifyInitData(noUser, MODEL_TOKEN, { now: NOW }))).toBe("no_user");
    const badUser = signed({ user: JSON.stringify({ id: "1001" }) });
    expect(codeOf(() => verifyInitData(badUser, MODEL_TOKEN, { now: NOW }))).toBe("no_user");
  });

  it("по умолчанию принимает initData не старше часа", () => {
    const at = (ageSec: number) =>
      signInitDataForTest({ auth_date: String(NOW / 1000 - ageSec), user: MODEL_USER }, MODEL_TOKEN);
    expect(DEFAULT_INIT_DATA_MAX_AGE_SEC).toBe(3600);
    expect(verifyInitData(at(3600), MODEL_TOKEN, { now: NOW }).maxUserId).toBe(1001);
    expect(codeOf(() => verifyInitData(at(3601), MODEL_TOKEN, { now: NOW }))).toBe("expired");
    expect(verifyInitData(at(90_000), MODEL_TOKEN, { now: NOW, maxAgeSec: 0 }).maxUserId).toBe(1001);
  });

  it("отклоняет auth_date из будущего сверх допуска часов", () => {
    const at = (aheadSec: number) =>
      signInitDataForTest({ auth_date: String(NOW / 1000 + aheadSec), user: MODEL_USER }, MODEL_TOKEN);
    expect(verifyInitData(at(30), MODEL_TOKEN, { now: NOW }).maxUserId).toBe(1001);
    expect(codeOf(() => verifyInitData(at(3600), MODEL_TOKEN, { now: NOW }))).toBe("from_future");
  });

  it("отклоняет start_param неверного формата", () => {
    expect(codeOf(() => verifyInitData(signed({ start_param: "a b" }), MODEL_TOKEN, { now: NOW }))).toBe(
      "bad_start_param",
    );
  });

  it("сообщение ошибки не содержит значений из initData", () => {
    try {
      verifyInitData(`${signed()}&user=${encodeURIComponent(MODEL_USER)}`, MODEL_TOKEN, { now: NOW });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("model_user");
      expect((error as Error).message).not.toContain("user");
    }
  });

  it("требует токен бота", () => {
    expect(() => verifyInitData(signed(), "", { now: NOW })).toThrow("MAX_BOT_TOKEN");
  });
});

describe("start_param", () => {
  it("проверяет формат и отсутствие длинных номеров", () => {
    expect(isValidStartParam("case_42")).toBe(true);
    expect(isValidStartParam("x".repeat(513))).toBe(false);
    expect(isValidStartParam("привет")).toBe(false);
    expect(isSafeStartParam("case_42")).toBe(true);
    // Модельный ИНН из data/fixtures/k28-companies.json.
    expect(isValidStartParam("inn_7700000016")).toBe(true);
    expect(isSafeStartParam("inn_7700000016")).toBe(false);
  });
});
