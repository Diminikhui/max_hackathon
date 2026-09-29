import { randomUUID } from "node:crypto";
import {
  DEFAULT_TIMEOUT_MS as CLASSIFIER_TIMEOUT_MS,
  type DocumentInput,
  type LlmProvider,
  type LlmRequest,
} from "../core/index.js";
import { buildClassificationPrompt, type ClassifierPromptMessage } from "../prompts/index.js";

const DEFAULT_AUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const DEFAULT_API_BASE_URL = "https://api.giga.chat/v1/";
const DEFAULT_MODEL = "GigaChat-2";
const DEFAULT_SCOPE = "GIGACHAT_API_PERS";
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;

const FORBIDDEN_SCHEMA_KEYWORDS = new Set(["anyOf", "oneOf", "allOf"]);
/** Ключевые слова, у которых ключи вложенного объекта — имена, а значения — схемы. */
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
/** Ключевые слова со значениями-данными, а не схемами: внутри них ограничения не проверяются. */
const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples"]);

export type GigaChatFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface GigaChatProviderOptions {
  /** Base64 Authorization key, без префикса Basic. */
  authKey: string;
  scope?: string;
  authUrl?: string;
  apiBaseUrl?: string;
  model?: string;
  fetch?: GigaChatFetch;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  uuid?: () => string;
  /**
   * Сколько запрос может ждать своей очереди. Дольше — вызывающий уже откатился на template по таймауту
   * classifyDocument, поэтому запрос не отправляется и не расходует лимит. По умолчанию — таймаут ядра.
   */
  queueDeadlineMs?: number;
  /**
   * Сообщения для модели по документу. По умолчанию — промпт классификации K-19d. Другой сценарий (пересказ 2-22)
   * передаёт свой промпт с теми же правилами: системные инструкции и недоверенные данные — разными сообщениями.
   */
  prompt?: (document: Readonly<DocumentInput>) => readonly ClassifierPromptMessage[];
}

interface AccessToken {
  value: string;
  expiresAtMs: number;
}

/**
 * GigaChat REST provider for the classifier.
 *
 * One instance serializes generations because GIGACHAT_API_PERS permits one
 * concurrent stream. Authentication tokens are cached and refreshed before expiry.
 */
export class GigaChatProvider implements LlmProvider {
  readonly name = "gigachat" as const;

  private readonly authKey: string;
  private readonly scope: string;
  private readonly authUrl: URL;
  private readonly completionsUrl: URL;
  private readonly model: string;
  private readonly fetchImpl: GigaChatFetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryDelayMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly uuid: () => string;
  private readonly queueDeadlineMs: number;
  private readonly prompt: (document: Readonly<DocumentInput>) => readonly ClassifierPromptMessage[];

  private accessToken: AccessToken | undefined;
  private tokenRequest: Promise<AccessToken> | undefined;
  private generationTail: Promise<void> = Promise.resolve();

  constructor(options: GigaChatProviderOptions) {
    this.authKey = stripBasicPrefix(options.authKey.trim());
    this.scope = options.scope?.trim() || DEFAULT_SCOPE;
    this.authUrl = httpsUrl(options.authUrl ?? DEFAULT_AUTH_URL, "GIGACHAT_AUTH_URL");
    const apiBaseUrl = httpsUrl(options.apiBaseUrl ?? DEFAULT_API_BASE_URL, "GIGACHAT_API_BASE_URL", true);
    this.completionsUrl = new URL("chat/completions", apiBaseUrl);
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxRetries = nonNegativeInteger(options.maxRetries ?? DEFAULT_MAX_RETRIES, "maxRetries");
    this.maxRetryDelayMs = positiveInteger(options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS, "maxRetryDelayMs");
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.uuid = options.uuid ?? randomUUID;
    this.queueDeadlineMs = positiveInteger(options.queueDeadlineMs ?? CLASSIFIER_TIMEOUT_MS, "queueDeadlineMs");
    this.prompt = options.prompt ?? buildClassificationPrompt;
  }

  generate(request: LlmRequest): Promise<unknown> {
    const enqueuedAt = this.now();
    const run = this.generationTail.then(() => {
      if (this.now() - enqueuedAt >= this.queueDeadlineMs) {
        throw new GigaChatError("Запрос GigaChat устарел в очереди и не отправлен");
      }
      return this.generateOnce(request);
    });
    this.generationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async generateOnce(request: LlmRequest): Promise<unknown> {
    assertSupportedSchema(request.responseSchema);
    const body = JSON.stringify({
      model: this.model,
      messages: this.prompt(request.document),
      response_format: {
        type: "json_schema",
        schema: schemaForGigaChat(request.responseSchema),
        strict: true,
      },
    });

    let refreshed = false;
    for (;;) {
      const token = await this.getAccessToken(refreshed);
      const response = await this.requestWithRateLimit(this.completionsUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
      });

      if (response.status === 401 && !refreshed) {
        await discardBody(response);
        this.accessToken = undefined;
        refreshed = true;
        continue;
      }
      if (!response.ok) {
        const status = response.status;
        await discardBody(response);
        throw new GigaChatError(`GigaChat completions вернул HTTP ${status}`, status);
      }

      const payload = await safeJson(response, "GigaChat completions");
      const content = completionContent(payload);
      if (typeof content !== "string") throw new GigaChatError("Ответ GigaChat не содержит choices[0].message.content");
      try {
        return JSON.parse(content);
      } catch (cause) {
        throw new GigaChatError("GigaChat вернул невалидный JSON в content", undefined, { cause });
      }
    }
  }

  private async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.accessToken && this.accessToken.expiresAtMs - this.now() > TOKEN_REFRESH_SKEW_MS) {
      return this.accessToken.value;
    }
    if (this.tokenRequest) return (await this.tokenRequest).value;

    this.tokenRequest = this.fetchAccessToken();
    try {
      this.accessToken = await this.tokenRequest;
      return this.accessToken.value;
    } finally {
      this.tokenRequest = undefined;
    }
  }

  private async fetchAccessToken(): Promise<AccessToken> {
    if (!this.authKey) throw new GigaChatError("GIGACHAT_AUTH_KEY не задан");
    const response = await this.requestWithRateLimit(this.authUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${this.authKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        RqUID: this.uuid(),
      },
      body: new URLSearchParams({ scope: this.scope }).toString(),
    });
    if (!response.ok) {
      const status = response.status;
      await discardBody(response);
      throw new GigaChatError(`GigaChat OAuth вернул HTTP ${status}`, status);
    }

    const payload = await safeJson(response, "GigaChat OAuth");
    if (!isRecord(payload) || typeof payload.access_token !== "string" || !payload.access_token) {
      throw new GigaChatError("Ответ GigaChat OAuth не содержит access_token");
    }
    const expiresAtMs = normalizeExpiry(payload.expires_at, this.now());
    return { value: payload.access_token, expiresAtMs };
  }

  private async requestWithRateLimit(url: URL, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (cause) {
        const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
        throw new GigaChatError(timedOut ? "Таймаут GigaChat" : "GigaChat недоступен", undefined, { cause });
      }
      if (response.status !== 429 || attempt >= this.maxRetries) return response;

      const retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.now(), this.maxRetryDelayMs);
      await discardBody(response);
      const backoff = Math.min(this.maxRetryDelayMs, 1_000 * 2 ** attempt);
      await this.sleep(retryAfter ?? backoff);
    }
  }
}

export class GigaChatError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "GigaChatError";
    this.status = status;
  }
}

/** Фабрика не читает и не выводит ключ нигде, кроме переданного env. */
export function gigachatProviderFromEnv(env: NodeJS.ProcessEnv = process.env): GigaChatProvider {
  return new GigaChatProvider({
    authKey: env.GIGACHAT_AUTH_KEY ?? "",
    ...(env.GIGACHAT_SCOPE ? { scope: env.GIGACHAT_SCOPE } : {}),
    ...(env.GIGACHAT_AUTH_URL ? { authUrl: env.GIGACHAT_AUTH_URL } : {}),
    ...(env.GIGACHAT_API_BASE_URL ? { apiBaseUrl: env.GIGACHAT_API_BASE_URL } : {}),
    ...(env.GIGACHAT_MODEL ? { model: env.GIGACHAT_MODEL } : {}),
  });
}

export function assertSupportedSchema(schema: Readonly<Record<string, unknown>>): void {
  visitSchema(schema, "$", new Set());
}

/** Убирает декларативный meta-keyword, который GigaChat не требует в response_format. */
export function schemaForGigaChat(schema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return cloneSchema(schema) as Record<string, unknown>;
}

/** Retry-After: количество секунд или HTTP-date. */
export function parseRetryAfter(value: string | null, nowMs: number, maxMs = DEFAULT_MAX_RETRY_DELAY_MS) {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(maxMs, Math.round(seconds * 1_000));
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.min(maxMs, Math.max(0, date - nowMs));
}

function visitSchema(value: unknown, path: string, seen: Set<object>): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new GigaChatError(`JSON Schema содержит цикл: ${path}`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) visitSchema(item, `${path}[${index}]`, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_SCHEMA_KEYWORDS.has(key)) {
        throw new GigaChatError(`GigaChat не поддерживает ${key} в JSON Schema (${path}.${key})`);
      }
      if (DATA_KEYWORDS.has(key)) continue;
      if (SCHEMA_MAP_KEYWORDS.has(key)) {
        visitSchemaMap(item, `${path}.${key}`, seen);
      } else {
        visitSchema(item, `${path}.${key}`, seen);
      }
    }
  }
  seen.delete(value);
}

/** Значения `properties` и подобных — схемы, а ключи — имена полей: поле может называться `anyOf`. */
function visitSchemaMap(value: unknown, path: string, seen: Set<object>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    visitSchema(value, path, seen);
    return;
  }
  if (seen.has(value)) throw new GigaChatError(`JSON Schema содержит цикл: ${path}`);
  seen.add(value);
  for (const [name, schema] of Object.entries(value)) visitSchema(schema, `${path}.${name}`, seen);
  seen.delete(value);
}

function cloneSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneSchema);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "$schema")
      .map(([key, item]) => [key, cloneSchema(item)]),
  );
}

function normalizeExpiry(value: unknown, nowMs: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return nowMs + 30 * 60_000;
  // В разных примерах API встречается Unix time; принимаем секунды и миллисекунды.
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function completionContent(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.choices)) return undefined;
  const first = value.choices[0];
  return isRecord(first) && isRecord(first.message) ? first.message.content : undefined;
}

async function safeJson(response: Response, source: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new GigaChatError(`${source} вернул невалидный JSON`, response.status, { cause });
  }
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function httpsUrl(value: string, name: string, directory = false): URL {
  let url: URL;
  try {
    const normalized = directory && !value.endsWith("/") ? `${value}/` : value;
    url = new URL(normalized);
  } catch (cause) {
    throw new Error(`${name} некорректен`, { cause });
  }
  if (url.protocol !== "https:") throw new Error(`${name} должен использовать HTTPS`);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} не должен содержать учётные данные, query или fragment`);
  }
  return url;
}

function stripBasicPrefix(value: string): string {
  return value.replace(/^Basic\s+/i, "");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} должен быть положительным целым числом`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} должен быть неотрицательным целым числом`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
