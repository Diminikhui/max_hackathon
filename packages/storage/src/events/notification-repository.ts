// NotificationRepository на PostgreSQL (K-10c): кандидаты в уведомления и уведомления со статусом доставки.
// Документы хранятся в jsonb; колонки нужны для дедупликации, идемпотентности и очереди отправки.

import type {
  Id,
  Notification,
  NotificationCandidate,
  NotificationRepository,
  NotificationStatus,
} from "@max-hackathon/domain";
import type { SqlClient } from "../db/sql-client.js";

export type NotificationStatusUpdate = Parameters<NotificationRepository["updateStatus"]>[1];

/** Выборка для планировщика отправки (контракт SendQueueRepository.listQueuedFair из apps/worker). */
export interface FairQueuedBatch {
  /** Round-robin по чатам, FIFO внутри каждого чата. */
  items: Notification[];
  /** Оценка сверху числа прочитанных записей: не больше maxScan. */
  scanned: number;
}

export class PostgresNotificationRepository implements NotificationRepository {
  /** Последний чат прошлой выборки: следующая начинается после него и идёт по кругу. */
  #fairCursor: string | undefined;

  constructor(private readonly db: SqlClient) {}

  /**
   * Сохраняет кандидата. Пара (companyId, dedupKey) уникальна: повтор с тем же id или тем же dedupKey
   * ничего не меняет — первый кандидат остаётся. Проверить заранее можно через hasCandidate.
   */
  async saveCandidate(candidate: NotificationCandidate): Promise<void> {
    await this.db.query(
      `INSERT INTO notification_candidates (id, company_id, change_event_id, dedup_key, created_at, data)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [
        candidate.id,
        candidate.companyId,
        candidate.changeEventId,
        candidate.dedupKey,
        candidate.createdAt,
        JSON.stringify(candidate),
      ],
    );
  }

  async hasCandidate(companyId: Id, dedupKey: string): Promise<boolean> {
    const { rows } = await this.db.query(
      "SELECT 1 FROM notification_candidates WHERE company_id = $1 AND dedup_key = $2",
      [companyId, dedupKey],
    );
    return rows.length > 0;
  }

  /** Кандидат по id — для сборщика уведомления (K-21a) и отладки. Вне порта. */
  async getCandidate(id: Id): Promise<NotificationCandidate | undefined> {
    const { rows } = await this.db.query<{ data: NotificationCandidate }>(
      "SELECT data FROM notification_candidates WHERE id = $1",
      [id],
    );
    return rows[0]?.data;
  }

  /**
   * Ставит уведомление в очередь. Идемпотентно по idempotencyKey (и по id): повтор не создаёт дубль и
   * не меняет уже записанное уведомление, в том числе его статус. Результат — через findByIdempotencyKey.
   */
  async enqueue(notification: Notification): Promise<void> {
    assertConsistent(notification.status, notification.attempts, notification.sentAt, notification.error);
    await this.db.query(
      `INSERT INTO notifications
         (id, candidate_id, company_id, idempotency_key, status, attempts, created_at, sent_at, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
      [
        notification.id,
        notification.candidateId,
        notification.companyId,
        notification.idempotencyKey,
        notification.status,
        notification.attempts,
        notification.createdAt,
        notification.sentAt ?? null,
        JSON.stringify(notification),
      ],
    );
  }

  async findByIdempotencyKey(key: string): Promise<Notification | undefined> {
    const { rows } = await this.db.query<{ data: Notification }>(
      "SELECT data FROM notifications WHERE idempotency_key = $1",
      [key],
    );
    return rows[0]?.data;
  }

  /** Уведомления со статусом queued в порядке createdAt (при равенстве — по id). */
  async listQueued(limit: number): Promise<Notification[]> {
    if (!Number.isInteger(limit) || limit < 0) throw new Error(`Неверный limit: ${limit}`);
    const { rows } = await this.db.query<{ data: Notification }>(
      "SELECT data FROM notifications WHERE status = 'queued' ORDER BY created_at, id LIMIT $1",
      [limit],
    );
    return rows.map((row) => row.data);
  }

  /**
   * Честная выборка очереди: round-robin между чатами, FIFO внутри чата, не больше maxScan прочитанных записей
   * независимо от размера очереди. Чаты перебираются skip scan-ом по индексу notifications_queue_by_chat,
   * начиная после чата, на котором закончилась прошлая выборка этого экземпляра, с переходом через начало.
   * Поэтому длинная очередь одного чата не загораживает остальные: каждый чат попадает в выборку не реже
   * одного раза за полный круг. Курсор хранится в памяти экземпляра — рассчитано на одного отправителя.
   */
  async listQueuedFair({ maxItems, maxScan }: { maxItems: number; maxScan: number }): Promise<FairQueuedBatch> {
    if (!Number.isInteger(maxItems) || maxItems < 0) throw new Error(`Неверный maxItems: ${maxItems}`);
    if (!Number.isInteger(maxScan) || maxScan < 2) throw new Error(`Неверный maxScan: ${maxScan}`);
    if (maxItems === 0) return { items: [], scanned: 0 };

    // Половина бюджета — на поиск чатов (одна строка индекса на чат), остальное — на их головы.
    const chatLimit = Math.min(maxItems, Math.floor(maxScan / 2));
    const chats = await this.#queuedChatsAfter(this.#fairCursor, chatLimit);
    if (chats.length < chatLimit && this.#fairCursor !== undefined) {
      const wrapped = await this.#queuedChatsAfter(undefined, chatLimit - chats.length);
      const seen = new Set(chats);
      chats.push(...wrapped.filter((chat) => !seen.has(chat)));
    }
    if (chats.length === 0) {
      this.#fairCursor = undefined;
      return { items: [], scanned: 0 };
    }
    this.#fairCursor = chats[chats.length - 1];

    const perChat = Math.max(1, Math.floor((maxScan - chats.length) / chats.length));
    const { rows } = await this.db.query<{ data: Notification }>(
      `SELECT heads.data FROM unnest($1::text[]) WITH ORDINALITY AS c(chat_id, ord)
       CROSS JOIN LATERAL (
         SELECT n.data, row_number() OVER (ORDER BY n.created_at, n.id) AS position
         FROM (SELECT data, created_at, id FROM notifications
               WHERE status = 'queued' AND chat_id = c.chat_id
               ORDER BY created_at, id LIMIT $2) AS n
       ) AS heads
       ORDER BY heads.position, c.ord
       LIMIT $3`,
      [chats, perChat, maxItems],
    );
    return { items: rows.map((row) => row.data), scanned: chats.length + chats.length * perChat };
  }

  /** До limit чатов с queued-уведомлениями по возрастанию chat_id после after (skip scan: одна строка на чат). */
  async #queuedChatsAfter(after: string | undefined, limit: number): Promise<string[]> {
    if (limit <= 0) return [];
    const { rows } = await this.db.query<{ chat_id: string }>(
      `WITH RECURSIVE chats(chat_id, n) AS (
         (SELECT chat_id, 1 FROM notifications
          WHERE status = 'queued' AND chat_id IS NOT NULL AND ($1::text IS NULL OR chat_id > $1)
          ORDER BY chat_id LIMIT 1)
         UNION ALL
         SELECT (SELECT next.chat_id FROM notifications AS next
                 WHERE next.status = 'queued' AND next.chat_id > chats.chat_id
                 ORDER BY next.chat_id LIMIT 1), chats.n + 1
         FROM chats WHERE chats.chat_id IS NOT NULL AND chats.n < $2
       )
       SELECT chat_id FROM chats WHERE chat_id IS NOT NULL`,
      [after ?? null, limit],
    );
    return rows.map((row) => row.chat_id);
  }

  /**
   * Обновляет статус доставки в колонках и в документе. sentAt и error заменяются значениями из update:
   * не переданное поле удаляется из документа (например, error после успешной повторной отправки).
   * status = sent требует sentAt, status = failed — error (схема notification v1).
   */
  async updateStatus(id: Id, update: NotificationStatusUpdate): Promise<void> {
    assertConsistent(update.status, update.attempts, update.sentAt, update.error);
    await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ data: Notification }>(
        "SELECT data FROM notifications WHERE id = $1 FOR UPDATE",
        [id],
      );
      const current = rows[0]?.data;
      if (!current) throw new Error(`Уведомление ${id} не найдено`);
      const { sentAt: _sentAt, error: _error, ...rest } = current;
      const next: Notification = {
        ...rest,
        status: update.status,
        attempts: update.attempts,
        ...(update.sentAt !== undefined ? { sentAt: update.sentAt } : {}),
        ...(update.error !== undefined ? { error: update.error } : {}),
      };
      await tx.query(
        `UPDATE notifications SET status = $2, attempts = $3, sent_at = $4, data = $5, updated_at = now()
         WHERE id = $1`,
        [id, next.status, next.attempts, next.sentAt ?? null, JSON.stringify(next)],
      );
    });
  }
}

const assertConsistent = (
  status: NotificationStatus,
  attempts: number,
  sentAt: string | undefined,
  error: Notification["error"],
): void => {
  if (!Number.isInteger(attempts) || attempts < 0) throw new Error(`Неверное число попыток: ${attempts}`);
  if (status === "sent" && sentAt === undefined) throw new Error("Для статуса sent нужен sentAt");
  if (status === "failed" && error === undefined) throw new Error("Для статуса failed нужен error");
};
