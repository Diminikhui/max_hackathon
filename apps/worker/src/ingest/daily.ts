import type { IngestReport, RegulationIngestJob } from "./job.js";

export const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RETRY_DELAY_MS = 60 * 60 * 1000;

export interface DailyIngestOptions {
  signal?: AbortSignal;
  intervalMs?: number;
  retryDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onReport?: (report: IngestReport) => void;
  onError?: (error: unknown) => void;
}

/** Запускает загрузку сразу, затем раз в сутки; после ошибки повторяет через час. */
export async function runDailyIngest(job: RegulationIngestJob, options: DailyIngestOptions = {}): Promise<void> {
  const intervalMs = positiveDelay(options.intervalMs ?? DAILY_INTERVAL_MS, "intervalMs");
  const retryDelayMs = positiveDelay(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, "retryDelayMs");
  const sleep = options.sleep ?? defaultSleep;

  while (!options.signal?.aborted) {
    let delay = intervalMs;
    try {
      const report = await job.runOnce();
      options.onReport?.(report);
    } catch (error) {
      options.onError?.(error);
      delay = retryDelayMs;
    }
    if (options.signal?.aborted) break;
    await sleep(delay, options.signal);
  }
}

function positiveDelay(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} должен быть положительным`);
  return value;
}

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
