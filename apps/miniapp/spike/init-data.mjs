// Spike K-05b: проверка подписи initData мини-приложения MAX и deep links.
// Алгоритм по https://dev.max.ru/docs/webapps/validation:
//   secret = HMAC-SHA256(key="WebAppData", data=BOT_TOKEN)
//   hash   = hex(HMAC-SHA256(key=secret, data=отсортированные "k=v" через "\n", без hash))
import { createHmac, timingSafeEqual } from "node:crypto";

export class InitDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InitDataError";
    this.code = code;
  }
}

function parsePairs(initData) {
  if (typeof initData !== "string" || initData.length === 0) {
    throw new InitDataError("empty", "initData пуст");
  }
  const fields = new Map();
  for (const part of initData.split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) throw new InitDataError("malformed", "Некорректная пара в initData");
    const key = decodeURIComponent(part.slice(0, eq));
    const value = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, "%20"));
    // Каждый параметр должен встречаться ровно один раз.
    if (fields.has(key)) throw new InitDataError("duplicate", `Повтор параметра ${key}`);
    fields.set(key, value);
  }
  return fields;
}

export function computeHash(fields, botToken) {
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const dataCheckString = [...fields.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  return createHmac("sha256", secret).update(dataCheckString).digest("hex");
}

/**
 * Проверяет подпись и срок initData. Возвращает разобранные поля.
 * Бросает InitDataError с code: empty | malformed | duplicate | no_hash | bad_hash | no_auth_date | expired.
 */
export function validateInitData(initData, botToken, { maxAgeSec = 24 * 3600, now = Date.now() } = {}) {
  if (!botToken) throw new Error("MAX_BOT_TOKEN не задан");
  const fields = parsePairs(initData);
  const hash = fields.get("hash");
  if (!hash) throw new InitDataError("no_hash", "В initData нет hash");

  const expected = Buffer.from(computeHash(fields, botToken), "hex");
  const actual = Buffer.from(hash, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new InitDataError("bad_hash", "Подпись initData не совпала");
  }

  const authDate = Number(fields.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate <= 0) {
    throw new InitDataError("no_auth_date", "В initData нет auth_date");
  }
  if (maxAgeSec > 0 && now / 1000 - authDate > maxAgeSec) {
    throw new InitDataError("expired", "initData устарел");
  }

  const json = (key) => {
    const raw = fields.get(key);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };
  return {
    authDate,
    queryId: fields.get("query_id"),
    user: json("user"),
    chat: json("chat"),
    startParam: fields.get("start_param"),
    fields: Object.fromEntries(fields),
  };
}

// start_param: до 512 символов, только A-Z a-z 0-9 _ - (https://dev.max.ru/docs/webapps/introduction).
const START_PARAM_RE = /^[A-Za-z0-9_-]{1,512}$/;

export function isValidStartParam(value) {
  return typeof value === "string" && START_PARAM_RE.test(value);
}

export function buildDeepLink(botName, startParam) {
  if (!/^[A-Za-z0-9_]+$/.test(botName ?? "")) throw new Error("Некорректное имя бота");
  const url = new URL(`https://max.ru/${botName}`);
  if (startParam !== undefined) {
    if (!isValidStartParam(startParam)) throw new Error("start_param: только A-Z a-z 0-9 _ -, до 512 символов");
    url.searchParams.set("startapp", startParam);
  }
  return url.toString();
}

/** Подписывает поля так же, как MAX. Только для модельных тестов и локальной проверки. */
export function signInitDataForTest(fields, botToken) {
  const map = new Map(Object.entries(fields));
  const hash = computeHash(map, botToken);
  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}
