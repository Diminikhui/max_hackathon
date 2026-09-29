// 5-05. Цикл монитора: опрос источников каждые `pollIntervalMs`, полная перепроверка раз в `recheckIntervalMs`.
// Время последней перепроверки хранится в памяти: после перезапуска перепроверка выполняется сразу —
// пересчёт идемпотентен, поэтому лишний прогон безопасен. Контур пакетов правил K-30a вызывается монитором
// внутри опроса и перепроверки (#295): отдельный runNotificationLoop в том же процессе не нужен.
import type { MonitorRunReport, SourceMonitor } from "./monitor.js";

export const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface MonitorLoopOptions {
  pollIntervalMs?: number;
  recheckIntervalMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Итог каждого прогона. Не логируйте профили целиком: только id и счётчики. */
  onReport?: (run: "poll" | "recheck", report: MonitorRunReport) => void;
  /** Непредвиденная ошибка прогона (например, недоступна БД). */
  onError?: (error: unknown) => void;
}

export const runMonitorLoop = async (monitor: SourceMonitor, options: MonitorLoopOptions = {}): Promise<void> => {
  const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const recheckInterval = options.recheckIntervalMs ?? DEFAULT_RECHECK_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  let lastRecheck: number | undefined;

  while (!options.signal?.aborted) {
    try {
      // Прогон вызывается отдельно: `onReport?.(…, await …)` пропустил бы его без onReport.
      const polled = await monitor.pollSources();
      options.onReport?.("poll", polled);
      if (lastRecheck === undefined || now() - lastRecheck >= recheckInterval) {
        lastRecheck = now();
        const rechecked = await monitor.recheckAll();
        options.onReport?.("recheck", rechecked);
        // Контур пакетов правил упал — перепроверка пропущена, повторяем её на следующем тике.
        if (rechecked.errors.some((error) => error.stage === "rulepacks")) lastRecheck = undefined;
      }
    } catch (error) {
      options.onError?.(error);
    }
    if (options.signal?.aborted) break;
    await sleep(pollInterval, options.signal);
  }
};

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
