/**
 * Защита от повторной обработки. MAX повторяет webhook до 10 раз с интервалами 60, 150, 375 с и далее ×2,5,
 * поэтому повтор может прийти через несколько часов после первой доставки.
 */
export interface InboundDedup {
  /** `true` — событие встречается впервые и его нужно обработать; `false` — повтор. */
  claim(eventId: string): boolean;
  /** Снимает отметку, если обработку не удалось даже начать, чтобы повтор MAX прошёл. */
  release(eventId: string): void;
}

export interface MemoryDedupOptions {
  /** Сколько идентификаторов помнить. Старейшие вытесняются первыми. */
  readonly capacity?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

const DEFAULT_CAPACITY = 10_000;
// Восьмой повтор MAX приходит примерно через 17 ч после первой доставки (60 × (2,5^8 − 1) / 1,5 с), девятый — через
// 42 ч. Сутки покрывают восемь повторов; повтор имеет смысл, только если наш ответ 200 до MAX не дошёл.
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Дедупликация в памяти процесса. После перезапуска бота отметки теряются: повтор, пришедший после рестарта,
 * будет обработан ещё раз. Для одного процесса на VPS этого достаточно; общее хранилище — отдельная задача.
 */
export const createMemoryDedup = ({
  capacity = DEFAULT_CAPACITY,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
}: MemoryDedupOptions = {}): InboundDedup => {
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error("capacity must be a positive integer");
  // Map хранит порядок вставки: первый ключ — самый старый.
  const seenAt = new Map<string, number>();

  const evict = (time: number): void => {
    for (const [eventId, at] of seenAt) {
      if (time - at < ttlMs && seenAt.size <= capacity) break;
      seenAt.delete(eventId);
    }
  };

  return {
    claim(eventId) {
      const time = now();
      const at = seenAt.get(eventId);
      if (at !== undefined && time - at < ttlMs) return false;
      seenAt.delete(eventId);
      seenAt.set(eventId, time);
      evict(time);
      return true;
    },
    release(eventId) {
      seenAt.delete(eventId);
    },
  };
};
