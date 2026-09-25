// Внешний цикл воркера отправки: вызывает processBatch и ждёт nextDelayMs. Запуск — в K-30a.

import type { SendQueueWorker } from "./worker.js";

export interface SendLoopOptions {
  /** Остановка цикла. */
  signal?: AbortSignal;
  /** Ожидание; по умолчанию setTimeout, прерывается signal. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Пауза после ошибки итерации (например, недоступна БД). По умолчанию 5 с. */
  errorDelayMs?: number;
  /** Сообщение об ошибке итерации. Не логируйте в нём уведомления целиком: там text и chatId. */
  onError?: (error: unknown) => void;
}

export const runSendLoop = async (worker: SendQueueWorker, options: SendLoopOptions = {}): Promise<void> => {
  const sleep = options.sleep ?? defaultSleep;
  while (!options.signal?.aborted) {
    let delay: number;
    try {
      delay = (await worker.processBatch()).nextDelayMs;
    } catch (error) {
      options.onError?.(error);
      delay = options.errorDelayMs ?? 5000;
    }
    if (options.signal?.aborted) break;
    await sleep(delay, options.signal);
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
