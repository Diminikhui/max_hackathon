// Spike K-05a: минимальный клиент MAX Bot API без зависимостей.
// Корневой сертификат НУЦ Минцифры доверяется только этому процессу: он добавляется
// к стандартным корням в агенте HTTPS, проверка TLS не отключается.
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { Agent, request } from "node:https";
import { rootCertificates } from "node:tls";

/** Нормализует отпечаток: "AA:BB..." и "aabb..." сравниваются одинаково. */
export function normalizeFingerprint(value) {
  return value.replaceAll(":", "").replaceAll(" ", "").toUpperCase();
}

/**
 * Читает сертификат и сверяет его SHA-256 отпечаток с ожидаемым.
 * Возвращает PEM для агента HTTPS; при несовпадении бросает ошибку.
 */
export function loadPinnedCa(path, expectedSha256) {
  if (!path) throw new Error("MAX_CA_CERT_PATH не задан (см. certs/README.md)");
  if (!expectedSha256) throw new Error("MAX_CA_CERT_SHA256 не задан: без отпечатка сертификат не используется");
  const pem = readFileSync(path, "utf8");
  const cert = new X509Certificate(pem);
  const actual = normalizeFingerprint(cert.fingerprint256);
  if (actual !== normalizeFingerprint(expectedSha256)) {
    throw new Error(`Отпечаток ${path} не совпадает с MAX_CA_CERT_SHA256 (получен ${cert.fingerprint256})`);
  }
  if (!cert.ca) throw new Error(`${path} не является сертификатом УЦ`);
  return pem;
}

export class MaxApiError extends Error {
  constructor(status, body) {
    super(`MAX API ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

export function createMaxClient({ token, baseUrl, caPem, timeoutMs = 40_000 }) {
  if (!token) throw new Error("MAX_BOT_TOKEN не задан");
  const agent = new Agent({ ca: [...rootCertificates, caPem], keepAlive: true });
  const base = new URL(baseUrl);

  function call(method, path, { query, body, timeout = timeoutMs } = {}) {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method,
          agent,
          timeout,
          // Токен только в заголовке: query-параметр MAX больше не поддерживает.
          headers: {
            Authorization: token,
            ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed = text;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              // Оставляем текст как есть.
            }
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) resolve(parsed);
            else reject(new MaxApiError(status, parsed));
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error(`Таймаут ${method} ${url.pathname}`)));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    getMe: () => call("GET", "/me"),
    /** Long polling: только для разработки; при активном webhook не работает. */
    getUpdates: ({ marker, timeout = 30, limit = 100, types } = {}) =>
      call("GET", "/updates", {
        query: { marker, timeout, limit, types: types?.join(",") },
        timeout: (timeout + 10) * 1000,
      }),
    sendMessage: ({ chatId, userId, text, buttons }) =>
      call("POST", "/messages", {
        query: { chat_id: chatId, user_id: userId },
        body: {
          text,
          ...(buttons ? { attachments: [{ type: "inline_keyboard", payload: { buttons } }] } : {}),
        },
      }),
    answerCallback: ({ callbackId, notification }) =>
      call("POST", "/answers", { query: { callback_id: callbackId }, body: { notification } }),
    close: () => agent.destroy(),
  };
}

export function clientFromEnv(env = process.env) {
  const caPem = loadPinnedCa(env.MAX_CA_CERT_PATH, env.MAX_CA_CERT_SHA256);
  return createMaxClient({
    token: env.MAX_BOT_TOKEN,
    baseUrl: env.MAX_API_BASE_URL ?? "https://platform-api2.max.ru",
    caPem,
  });
}
