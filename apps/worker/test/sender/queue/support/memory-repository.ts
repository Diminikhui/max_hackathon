// In-memory NotificationRepository для тестов очереди: та же семантика, что у PostgresNotificationRepository
// (enqueue идемпотентен по idempotencyKey, listQueued по createdAt и id, updateStatus удаляет не переданные
// sentAt и error). Кандидаты очереди не нужны.
import type { Id, Notification, NotificationRepository } from "@max-hackathon/domain";
import type { SendQueueRepository } from "../../../../src/sender/queue/worker.js";

export class MemoryNotificationRepository implements NotificationRepository, SendQueueRepository {
  readonly items = new Map<Id, Notification>();
  private readonly idByIdempotencyKey = new Map<string, Id>();
  private readonly queuedByChat = new Map<string, Id[]>();
  private readonly unsortedChats = new Set<string>();

  async saveCandidate(): Promise<void> {}
  async hasCandidate(): Promise<boolean> {
    return false;
  }

  async enqueue(notification: Notification): Promise<void> {
    if (this.items.has(notification.id)) return;
    if (this.idByIdempotencyKey.has(notification.idempotencyKey)) return;
    this.items.set(notification.id, structuredClone(notification));
    this.idByIdempotencyKey.set(notification.idempotencyKey, notification.id);
    if (notification.status === "queued") {
      const queue = this.queuedByChat.get(notification.recipient.chatId) ?? [];
      queue.push(notification.id);
      this.queuedByChat.set(notification.recipient.chatId, queue);
      this.unsortedChats.add(notification.recipient.chatId);
    }
  }

  async findByIdempotencyKey(key: string): Promise<Notification | undefined> {
    const id = this.idByIdempotencyKey.get(key);
    const found = id === undefined ? undefined : this.items.get(id);
    return found && structuredClone(found);
  }

  async listQueued(limit: number): Promise<Notification[]> {
    return [...this.items.values()]
      .filter((item) => item.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((item) => structuredClone(item));
  }

  async listQueuedFair({ maxItems, maxScan }: { maxItems: number; maxScan: number }) {
    for (const chatId of this.unsortedChats) {
      this.queuedByChat.get(chatId)?.sort((left, right) => {
        const a = this.items.get(left);
        const b = this.items.get(right);
        if (!a || !b) return 0;
        return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      });
    }
    this.unsortedChats.clear();
    const queues = [...this.queuedByChat.values()];
    const items: Notification[] = [];
    let scanned = 0;
    for (let position = 0; items.length < maxItems && scanned < maxScan; position += 1) {
      let added = false;
      for (const queue of queues) {
        if (items.length >= maxItems || scanned >= maxScan) break;
        const id = queue[position];
        if (!id) continue;
        scanned += 1;
        const item = this.items.get(id);
        if (item?.status === "queued") items.push(structuredClone(item));
        added = true;
      }
      if (!added) break;
    }
    return { items, scanned };
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
    if (update.status !== "queued") {
      const queue = this.queuedByChat.get(current.recipient.chatId);
      if (queue) {
        const position = queue.indexOf(id);
        if (position >= 0) queue.splice(position, 1);
        if (queue.length === 0) {
          this.queuedByChat.delete(current.recipient.chatId);
          this.unsortedChats.delete(current.recipient.chatId);
        }
      }
    }
  }
}

/** Методы репозитория, привязанные к экземпляру, — для подмены отдельных методов в тестах. */
export const bind = (
  repo: NotificationRepository & SendQueueRepository,
): NotificationRepository & SendQueueRepository => ({
  saveCandidate: repo.saveCandidate.bind(repo),
  hasCandidate: repo.hasCandidate.bind(repo),
  enqueue: repo.enqueue.bind(repo),
  findByIdempotencyKey: repo.findByIdempotencyKey.bind(repo),
  listQueued: repo.listQueued.bind(repo),
  listQueuedFair: repo.listQueuedFair.bind(repo),
  updateStatus: repo.updateStatus.bind(repo),
});
