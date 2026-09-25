export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthCheckResult {
  name: string;
  status: "up" | "down";
  critical: boolean;
  durationMs: number;
  message?: string;
}

export interface HealthReport {
  status: HealthStatus;
  checkedAt: string;
  checks: HealthCheckResult[];
}

export interface HealthCheck {
  name: string;
  critical?: boolean;
  timeoutMs?: number;
  check: () => boolean | Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 1_000;

async function withTimeout(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(check),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Health check timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Выполняет проверки параллельно и не раскрывает внутренние тексты исключений в ответе health. */
export async function checkHealth(
  checks: readonly HealthCheck[],
  options: { now?: () => Date; monotonicNow?: () => number } = {},
): Promise<HealthReport> {
  const now = options.now ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());

  const results = await Promise.all(
    checks.map(async ({ name, critical = true, timeoutMs = DEFAULT_TIMEOUT_MS, check }) => {
      const startedAt = monotonicNow();
      try {
        const up = await withTimeout(check, timeoutMs);
        return {
          name,
          status: up ? "up" : "down",
          critical,
          durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
          ...(!up ? { message: "Проверка не пройдена" } : {}),
        } satisfies HealthCheckResult;
      } catch {
        return {
          name,
          status: "down",
          critical,
          durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
          message: "Проверка недоступна",
        } satisfies HealthCheckResult;
      }
    }),
  );

  const status: HealthStatus = results.some((result) => result.status === "down" && result.critical)
    ? "unhealthy"
    : results.some((result) => result.status === "down")
      ? "degraded"
      : "healthy";

  return { status, checkedAt: now().toISOString(), checks: results };
}
