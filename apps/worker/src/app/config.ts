// K-30b. Настройки процесса из окружения. Секреты (токен MAX, secret webhook) не выводятся ни в лог, ни в ошибки.
import { type ExplainProviderChoice, explainProviderFromEnv } from "@max-hackathon/bot/dist/flows/explain/index.js";

export interface AppConfig {
  readonly databaseUrl: string;
  /** Опциональные функции бота, включаемые владельцем сервера списком через запятую. */
  readonly botFeatures?: readonly string[];
  /** 2-22: провайдер пересказа «Простым языком»; только при `BOT_FEATURES` с `explain`. */
  readonly explain?: ExplainProviderChoice;
  /** Принимать события MAX и отправлять ответы. Локально — `false` (ADR-0003: токен только на VPS). */
  readonly maxEventsEnabled: boolean;
  readonly max?: {
    readonly token: string;
    readonly baseUrl: string;
    readonly webhookSecret: string;
  };
  /** Порт HTTP-сервера бота внутри контейнера: `POST /webhook`, `GET /health`. */
  readonly botHttpPort: number;
  readonly botHttpHost: string;
}

const DEFAULT_MAX_API_BASE_URL = "https://platform-api2.max.ru";

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Не задана переменная окружения ${name}`);
  return value;
};

export const readConfig = (env: NodeJS.ProcessEnv): AppConfig => {
  const maxEventsEnabled = env.MAX_EVENTS_ENABLED?.trim() === "true";
  const port = Number(env.BOT_HTTP_PORT?.trim() || "3001");
  if (!Number.isInteger(port) || port <= 0 || port > 65_535)
    throw new Error("BOT_HTTP_PORT должен быть портом 1–65535");

  const botFeatures = [
    ...new Set(
      (env.BOT_FEATURES ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];

  return {
    databaseUrl: required(env, "DATABASE_URL"),
    botFeatures,
    ...(botFeatures.includes("explain") ? { explain: explainProviderFromEnv(env) } : {}),
    maxEventsEnabled,
    ...(maxEventsEnabled
      ? {
          max: {
            token: required(env, "MAX_BOT_TOKEN"),
            baseUrl: env.MAX_API_BASE_URL?.trim() || DEFAULT_MAX_API_BASE_URL,
            webhookSecret: required(env, "MAX_WEBHOOK_SECRET"),
          },
        }
      : {}),
    botHttpPort: port,
    botHttpHost: env.BOT_HTTP_HOST?.trim() || "0.0.0.0",
  };
};
