// Модельные тесты K-05b: токен и пользователь выдуманы, реальные данные не используются.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateInitData,
  signInitDataForTest,
  buildDeepLink,
  isValidStartParam,
  InitDataError,
} from "./init-data.mjs";

const MODEL_TOKEN = "model-token-not-real";
const NOW = 1_790_000_000_000;
const AUTH_DATE = String(NOW / 1000 - 60);
const MODEL_USER = JSON.stringify({ id: 1, first_name: "Модельный", username: "model_user", language_code: "ru" });

function signed(extra = {}) {
  return signInitDataForTest({ auth_date: AUTH_DATE, query_id: "q1", user: MODEL_USER, start_param: "case_42", ...extra }, MODEL_TOKEN);
}

test("принимает корректно подписанный initData", () => {
  const result = validateInitData(signed(), MODEL_TOKEN, { now: NOW });
  assert.equal(result.user.username, "model_user");
  assert.equal(result.startParam, "case_42");
  assert.equal(result.authDate, Number(AUTH_DATE));
});

test("порядок полей не влияет на проверку", () => {
  const reversed = signed().split("&").reverse().join("&");
  assert.ok(validateInitData(reversed, MODEL_TOKEN, { now: NOW }));
});

test("отклоняет подмену поля", () => {
  const tampered = signed().replace("case_42", "case_43");
  assert.throws(() => validateInitData(tampered, MODEL_TOKEN, { now: NOW }), (e) => e.code === "bad_hash");
});

test("отклоняет чужой токен", () => {
  assert.throws(() => validateInitData(signed(), "other-model-token", { now: NOW }), (e) => e.code === "bad_hash");
});

test("отклоняет отсутствие hash, повтор и мусор", () => {
  const noHash = signed().replace(/&?hash=[0-9a-f]+/, "");
  assert.throws(() => validateInitData(noHash, MODEL_TOKEN, { now: NOW }), (e) => e.code === "no_hash");
  assert.throws(() => validateInitData(signed() + "&auth_date=1", MODEL_TOKEN, { now: NOW }), (e) => e.code === "duplicate");
  assert.throws(() => validateInitData("", MODEL_TOKEN), (e) => e instanceof InitDataError && e.code === "empty");
  assert.throws(() => validateInitData(signed().replace(/hash=[0-9a-f]+/, "hash=zz"), MODEL_TOKEN, { now: NOW }), (e) => e.code === "bad_hash");
});

test("отклоняет устаревший initData", () => {
  const old = signInitDataForTest({ auth_date: String(NOW / 1000 - 90_000), user: MODEL_USER }, MODEL_TOKEN);
  assert.throws(() => validateInitData(old, MODEL_TOKEN, { now: NOW }), (e) => e.code === "expired");
  assert.ok(validateInitData(old, MODEL_TOKEN, { now: NOW, maxAgeSec: 0 }));
});

test("deep link и start_param", () => {
  assert.equal(buildDeepLink("t214_hakaton_max_bot"), "https://max.ru/t214_hakaton_max_bot");
  assert.equal(buildDeepLink("t214_hakaton_max_bot", "inn_7700000000"), "https://max.ru/t214_hakaton_max_bot?startapp=inn_7700000000");
  assert.ok(!isValidStartParam("a b"));
  assert.ok(!isValidStartParam("x".repeat(513)));
  assert.throws(() => buildDeepLink("bot", "привет"));
});
