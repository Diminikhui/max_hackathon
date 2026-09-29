import { GigaChatProvider, type LlmProvider, TemplateProvider } from "@max-hackathon/classifier";

/** Критерий 2-22: ответ модели ждём не дольше 8 секунд, дальше — шаблон. */
export const EXPLAIN_TIMEOUT_MS = 8_000;

export interface ExplainProviderChoice {
  readonly provider: LlmProvider;
  /** Почему выбран шаблон при `LLM_PROVIDER=gigachat`: для журнала, без значения ключа. */
  readonly fallbackReason?: "missing_key" | "invalid_config";
}

/**
 * Провайдер пересказа по `LLM_PROVIDER` (ADR-0001): `gigachat` — только если задан `GIGACHAT_AUTH_KEY`, иначе и
 * при любом другом значении — `template` без ИИ. Ключ можно добавить на сервер позже: без него бот работает на
 * шаблоне и не падает. Ключ не читается нигде, кроме переданного `env`, и не выводится.
 */
export const explainProviderFromEnv = (env: NodeJS.ProcessEnv): ExplainProviderChoice => {
  if (env.LLM_PROVIDER?.trim() !== "gigachat") return { provider: new TemplateProvider() };

  const authKey = env.GIGACHAT_AUTH_KEY?.trim();
  if (!authKey) return { provider: new TemplateProvider(), fallbackReason: "missing_key" };

  const optional = (name: string) => env[name]?.trim() || undefined;
  const scope = optional("GIGACHAT_SCOPE");
  const authUrl = optional("GIGACHAT_AUTH_URL");
  const apiBaseUrl = optional("GIGACHAT_API_BASE_URL");
  const model = optional("GIGACHAT_MODEL");
  try {
    return {
      provider: new GigaChatProvider({
        authKey,
        ...(scope ? { scope } : {}),
        ...(authUrl ? { authUrl } : {}),
        ...(apiBaseUrl ? { apiBaseUrl } : {}),
        ...(model ? { model } : {}),
        // Пользователь ждёт ответа в чате: без повторов после 429, запрос из очереди старше срока не отправляется.
        timeoutMs: EXPLAIN_TIMEOUT_MS,
        maxRetries: 0,
        queueDeadlineMs: EXPLAIN_TIMEOUT_MS,
      }),
    };
  } catch {
    // Некорректный адрес в переопределениях: сообщение ошибки может содержать значение, поэтому не пробрасываем.
    return { provider: new TemplateProvider(), fallbackReason: "invalid_config" };
  }
};
