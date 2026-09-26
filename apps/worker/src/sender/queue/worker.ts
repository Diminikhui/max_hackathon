// Воркер очереди отправки (K-21a): берёт уведомления в статусе queued, отправляет через MessageSender,
// обновляет статус доставки, повторяет временные ошибки с отсрочкой и ограничивает скорость.
//
// Защита от дублей («не больше одного раза»):
// 1. Отправляются только уведомления в статусе queued; перед отправкой статус перечитывается из хранилища.
// 2. Перед вызовом MessageSender уведомление получает отметку error.code = delivery_in_progress (статус
//    остаётся queued, attempts увеличен). Если воркер упадёт между отправкой и записью результата,
//    отметка останется в БД, и следующий запуск не отправит сообщение повторно, а по политике
//    unknownOutcome переведёт его в failed с кодом delivery_unknown (по умолчанию) или вернёт в очередь.
// 3. Воркер рассчитан на одного отправителя: listQueued не блокирует строки (см. README пакета storage).
//
// В отчёт и ошибки не попадают text, chatId и ИНН — только id уведомлений и коды ошибок.

import type { Id, Notification, NotificationRepository } from "@max-hackathon/domain";
import { TokenBucket, type TokenBucketOptions } from "./rate-limiter.js";
import {
  DELIVERY_IN_PROGRESS,
  DELIVERY_UNKNOWN,
  type MessageSender,
  SENDER_EXCEPTION,
  type SendFailure,
} from "./sender.js";

export interface SendQueueWorkerOptions {
  repository: SendQueueRepository;
  sender: MessageSender;
  /** Текущее время в миллисекундах Unix. В тестах — управляемые часы. */
  now: () => number;
  /** Сколько уведомлений отправлять за одну итерацию. По умолчанию 20. */
  batchSize?: number;
  /** Максимум попыток, включая первую. По умолчанию 5. */
  maxAttempts?: number;
  /** Отсрочка повтора: base * 2^(попытка-1), не больше maxMs. По умолчанию 1 с и 5 мин. */
  backoff?: { baseMs: number; maxMs: number };
  /** Лимит отправки в один чат. По умолчанию не более 2 сообщений/с без всплеска. */
  perChatRateLimit?: TokenBucketOptions;
  /**
   * Что делать с уведомлением, исход отправки которого неизвестен (воркер упал после начала отправки,
   * отправитель бросил исключение). "fail" (по умолчанию) — failed с кодом delivery_unknown: без дублей,
   * но сообщение может потеряться. "retry" — повторить: допустимо, только если MAX отбрасывает повтор
   * по idempotencyKey.
   */
  unknownOutcome?: "fail" | "retry";
  /** Пауза, если работы нет. По умолчанию 5 с. */
  idleDelayMs?: number;
  /** Жёсткая верхняя граница записей, которые fair query вправе просмотреть за tick. */
  maxScanPerTick?: number;
  /** Неактивные per-chat buckets удаляются после этого срока. По умолчанию 10 минут. */
  chatBucketIdleTtlMs?: number;
}

export interface FairQueuedBatch {
  /** Round-robin по чатам, FIFO внутри каждого чата. */
  items: Notification[];
  /** Реальное число просмотренных хранилищем записей, не больше maxScan. */
  scanned: number;
}

/** Обязательный query-контракт scheduler. Обычный FIFO listQueued недостаточен для честности. */
export interface SendQueueRepository extends Pick<NotificationRepository, "findByIdempotencyKey" | "updateStatus"> {
  listQueuedFair(options: { maxItems: number; maxScan: number }): Promise<FairQueuedBatch>;
}

export interface BatchReport {
  sent: Id[];
  /** Вернулись в очередь после временной ошибки. */
  retried: Id[];
  failed: { id: Id; code: string }[];
  /** Отложены (backoff) или уже не в очереди к моменту отправки. */
  skipped: Id[];
  /** Итерация остановлена ограничением скорости или паузой по retryAfterMs. */
  throttled: boolean;
  /** Через сколько миллисекунд имеет смысл следующая итерация. */
  nextDelayMs: number;
}

export class SendQueueWorker {
  private readonly repository: SendQueueRepository;
  private readonly sender: MessageSender;
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly backoff: { baseMs: number; maxMs: number };
  private readonly perChatLimit: TokenBucketOptions;
  private readonly chatBuckets = new Map<string, { bucket: TokenBucket; lastUsedAt: number }>();
  private readonly unknownOutcome: "fail" | "retry";
  private readonly idleDelayMs: number;
  private readonly maxScanPerTick: number;
  private readonly chatBucketIdleTtlMs: number;
  /** Не раньше какого момента повторять уведомление (в памяти: после перезапуска повтор наступит раньше). */
  private readonly notBefore = new Map<Id, number>();
  /** Общая пауза после ответа с retryAfterMs (например, 429). */
  private pausedUntil = 0;
  private running = false;

  constructor(options: SendQueueWorkerOptions) {
    this.repository = options.repository;
    this.sender = options.sender;
    this.now = options.now;
    this.batchSize = options.batchSize ?? 20;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.backoff = options.backoff ?? { baseMs: 1000, maxMs: 300_000 };
    this.perChatLimit = options.perChatRateLimit ?? { capacity: 1, refillPerSecond: 2 };
    // Проверяем настройки сразу, даже если очередь пока пуста.
    new TokenBucket(this.perChatLimit);
    this.unknownOutcome = options.unknownOutcome ?? "fail";
    this.idleDelayMs = options.idleDelayMs ?? 5000;
    this.maxScanPerTick = options.maxScanPerTick ?? Math.max(100, this.batchSize * 10);
    this.chatBucketIdleTtlMs = options.chatBucketIdleTtlMs ?? 600_000;
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) throw new Error("batchSize должен быть >= 1");
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) throw new Error("maxAttempts должен быть >= 1");
    if (!Number.isInteger(this.maxScanPerTick) || this.maxScanPerTick < this.batchSize)
      throw new Error("maxScanPerTick должен быть целым и не меньше batchSize");
  }

  /** Одна итерация очереди. Параллельные вызовы на одном воркере запрещены. */
  async processBatch(): Promise<BatchReport> {
    if (this.running) throw new Error("processBatch уже выполняется");
    this.running = true;
    try {
      return await this.run();
    } finally {
      this.running = false;
    }
  }

  private async run(): Promise<BatchReport> {
    const report: BatchReport = { sent: [], retried: [], failed: [], skipped: [], throttled: false, nextDelayMs: 0 };
    const startedAt = this.now();
    this.evictIdleChatBuckets(startedAt);
    if (startedAt < this.pausedUntil) {
      report.throttled = true;
      report.nextDelayMs = this.pausedUntil - startedAt;
      return report;
    }

    const selection = await this.repository.listQueuedFair({
      maxItems: this.maxScanPerTick,
      maxScan: this.maxScanPerTick,
    });
    if (selection.scanned > this.maxScanPerTick || selection.items.length > this.maxScanPerTick)
      throw new Error("listQueuedFair нарушил maxScanPerTick");
    const queued = selection.items;
    this.pruneBackoff(queued);

    let handled = 0;
    let delay: number | undefined;
    for (const item of queued) {
      if (handled >= this.batchSize) break;
      if (item.error?.code === DELIVERY_IN_PROGRESS) {
        await this.resolveUnknown(item, report);
        handled += 1;
        continue;
      }
      const notBefore = this.notBefore.get(item.id);
      if (notBefore !== undefined && notBefore > this.now()) {
        report.skipped.push(item.id);
        continue;
      }

      // Статус мог измениться после listQueued: отправляем только то, что всё ещё в очереди.
      const current = await this.repository.findByIdempotencyKey(item.idempotencyKey);
      if (
        !current ||
        current.id !== item.id ||
        current.status !== "queued" ||
        current.error?.code === DELIVERY_IN_PROGRESS
      ) {
        report.skipped.push(item.id);
        continue;
      }

      const now = this.now();
      const chatBucket = this.chatBucket(current.recipient.chatId);
      const chatWait = chatBucket.availableIn(now);
      if (chatWait > 0) {
        // Не блокируем другие чаты: они используют отдельные квоты.
        report.skipped.push(item.id);
        delay = Math.min(delay ?? Number.POSITIVE_INFINITY, chatWait);
        continue;
      }

      // Общий MAX API budget расходует общий transport; здесь — только квота конкретного чата.
      chatBucket.take(now);

      handled += 1;
      const paused = await this.deliver(current, report);
      if (paused) {
        report.throttled = true;
        delay = this.pausedUntil - this.now();
        break;
      }
    }

    // Пакет заполнен целиком — в очереди может остаться работа.
    if (delay === undefined && handled >= this.batchSize) delay = 0;
    report.nextDelayMs = Math.max(0, delay ?? this.idleDelay());
    return report;
  }

  /** Отправка одного уведомления. Возвращает true, если отправитель попросил общую паузу. */
  private async deliver(notification: Notification, report: BatchReport): Promise<boolean> {
    const attempts = notification.attempts + 1;
    await this.repository.updateStatus(notification.id, {
      status: "queued",
      attempts,
      error: { code: DELIVERY_IN_PROGRESS },
    });

    let result: Awaited<ReturnType<MessageSender["send"]>>;
    try {
      result = await this.sender.send(notification);
    } catch {
      // Исключение не говорит, дошёл ли запрос до MAX: исход неизвестен.
      await this.settleUnknown(notification.id, attempts, SENDER_EXCEPTION, report);
      return false;
    }

    if (result.ok) {
      await this.repository.updateStatus(notification.id, {
        status: "sent",
        attempts,
        sentAt: new Date(this.now()).toISOString(),
      });
      this.notBefore.delete(notification.id);
      report.sent.push(notification.id);
      return false;
    }

    if (result.retryable && attempts < this.maxAttempts) {
      await this.repository.updateStatus(notification.id, {
        status: "queued",
        attempts,
        error: errorOf(result),
      });
      this.notBefore.set(notification.id, this.now() + (result.retryAfterMs ?? this.backoffDelay(attempts)));
      report.retried.push(notification.id);
      if (result.retryAfterMs !== undefined) {
        this.pausedUntil = Math.max(this.pausedUntil, this.now() + result.retryAfterMs);
        return true;
      }
      return false;
    }

    const error = result.retryable ? { code: result.code, message: `Исчерпаны попытки: ${attempts}` } : errorOf(result);
    await this.fail(notification.id, attempts, error, report);
    return false;
  }

  /** Уведомление с отметкой delivery_in_progress, оставшейся после сбоя воркера. */
  private async resolveUnknown(notification: Notification, report: BatchReport): Promise<void> {
    await this.settleUnknown(notification.id, notification.attempts, DELIVERY_UNKNOWN, report);
  }

  private async settleUnknown(id: Id, attempts: number, code: string, report: BatchReport): Promise<void> {
    const message = "Исход отправки неизвестен";
    if (this.unknownOutcome === "retry" && attempts < this.maxAttempts) {
      await this.repository.updateStatus(id, { status: "queued", attempts, error: { code, message } });
      this.notBefore.set(id, this.now() + this.backoffDelay(Math.max(attempts, 1)));
      report.retried.push(id);
      return;
    }
    await this.fail(id, attempts, { code: DELIVERY_UNKNOWN, message: `${message} (${code})` }, report);
  }

  private async fail(id: Id, attempts: number, error: { code: string; message?: string }, report: BatchReport) {
    await this.repository.updateStatus(id, { status: "failed", attempts, error });
    this.notBefore.delete(id);
    report.failed.push({ id, code: error.code });
  }

  private backoffDelay(attempts: number): number {
    return Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** (attempts - 1));
  }

  private chatBucket(chatId: string): TokenBucket {
    const now = this.now();
    let entry = this.chatBuckets.get(chatId);
    if (!entry) {
      entry = { bucket: new TokenBucket(this.perChatLimit), lastUsedAt: now };
      this.chatBuckets.set(chatId, entry);
    }
    entry.lastUsedAt = now;
    return entry.bucket;
  }

  private evictIdleChatBuckets(now: number): void {
    for (const [chatId, entry] of this.chatBuckets) {
      if (now - entry.lastUsedAt >= this.chatBucketIdleTtlMs) this.chatBuckets.delete(chatId);
    }
  }

  /** Диагностика bounded cache; не раскрывает chatId. */
  activeChatBucketCount(): number {
    return this.chatBuckets.size;
  }

  private idleDelay(): number {
    const now = this.now();
    let delay = this.idleDelayMs;
    for (const at of this.notBefore.values()) delay = Math.min(delay, Math.max(0, at - now));
    return delay;
  }

  /** Забыть отсрочки уведомлений, которых больше нет в очереди (отправлены или подавлены извне). */
  private pruneBackoff(queued: Notification[]): void {
    const ids = new Set(queued.map((item) => item.id));
    for (const id of this.notBefore.keys()) if (!ids.has(id)) this.notBefore.delete(id);
  }
}

const errorOf = (failure: SendFailure): { code: string; message?: string } =>
  failure.message === undefined ? { code: failure.code } : { code: failure.code, message: failure.message };
