// In-memory NotificationRepository для тестов очереди: та же семантика, что у PostgresNotificationRepository
// (enqueue идемпотентен по idempotencyKey, listQueued по createdAt и id, updateStatus удаляет не переданные
// sentAt и error). Кандидаты очереди не нужны.
import type { Id, Notification, NotificationRepository } from "@max-hackathon/domain";

export class MemoryNotificationRepository implements NotificationRepository {
  readonly items = new Map<Id, Notification>();

  async saveCandidate(): Promise<void> {}
  async hasCandidate(): Promise<boolean> {
    return false;
  }

  async enqueue(notification: Notification): Promise<void> {
    if (this.items.has(notification.id)) return;
    if ([...this.items.values()].some((item) => item.idempotencyKey === notification.idempotencyKey)) return;
    this.items.set(notification.id, structuredClone(notification));
  }

  async findByIdempotencyKey(key: string): Promise<Notification | undefined> {
    const found = [...this.items.values()].find((item) => item.idempotencyKey === key);
    return found && structuredClone(found);
  }

  async listQueued(limit: number): Promise<Notification[]> {
    return [...this.items.values()]
      .filter((item) => item.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((item) => structuredClone(item));
  }

  async updateStatus(id: Id, update: Parameters<NotificationRepository["updateStatus"]>[1]): Promise<void> {
    const current = this.items.get(id);
    if (!current) throw new Error(`Уведомление ${id} не найдено`);
    if (update.status === "sent" && update.sentAt === undefined) throw new Error("Для статуса sent нужен sentAt");
    if (update.status === "failed" && update.error === undefined) throw new Error("Для статуса failed нужен error");
    const { sentAt: _sentAt, error: _error, ...rest } = current;
    this.items.set(id, {
      ...rest,
      status: update.status,
      attempts: update.attempts,
      ...(update.sentAt !== undefined ? { sentAt: update.sentAt } : {}),
      ...(update.error !== undefined ? { error: update.error } : {}),
    });
  }
}

/** Методы репозитория, привязанные к экземпляру, — для подмены отдельных методов в тестах. */
export const bind = (repo: NotificationRepository): NotificationRepository => ({
  saveCandidate: repo.saveCandidate.bind(repo),
  hasCandidate: repo.hasCandidate.bind(repo),
  enqueue: repo.enqueue.bind(repo),
  findByIdempotencyKey: repo.findByIdempotencyKey.bind(repo),
  listQueued: repo.listQueued.bind(repo),
  updateStatus: repo.updateStatus.bind(repo),
});
