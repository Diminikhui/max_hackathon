import type { Id } from "@max-hackathon/domain";
import type {
  ProcessStatus,
  ProcessStatusNotification,
  ProcessStatusRepository,
  ProcessStatusSource,
} from "./types.js";

export class ProcessStatusFeed {
  constructor(
    private readonly sources: readonly ProcessStatusSource[],
    private readonly repository: ProcessStatusRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async refresh(companyId: Id): Promise<ProcessStatusNotification[]> {
    const notifications: ProcessStatusNotification[] = [];
    for (const source of this.sources) {
      if (!source.info.isModel) throw new Error(`Источник ${source.info.name} должен быть явно помечен модельным`);
      for (const current of await source.list(companyId)) {
        if (!current.source.isModel) throw new Error(`Процесс ${current.processId} должен быть явно помечен модельным`);
        const previous = await this.repository.get(current.processId);
        if (previous && previous.updatedAt > current.updatedAt) continue;
        if (previous && previous.status !== current.status) {
          const dedupKey = `${current.processId}:${previous.status}:${current.status}:${current.updatedAt}`;
          if (!(await this.repository.hasNotification(dedupKey))) {
            notifications.push(this.notification(previous, current, dedupKey));
            await this.repository.markNotification(dedupKey);
          }
        }
        if (!previous || previous.updatedAt <= current.updatedAt) await this.repository.save(current);
      }
    }
    return notifications;
  }

  private notification(previous: ProcessStatus, current: ProcessStatus, dedupKey: string): ProcessStatusNotification {
    const createdAt = new Date(this.now()).toISOString();
    return {
      id: `process-status:${dedupKey}`,
      companyId: current.companyId,
      processId: current.processId,
      previousStatus: previous.status,
      newStatus: current.status,
      text: `Модельное уведомление: статус «${current.serviceName}» изменён: ${previous.status} → ${current.status}.`,
      sourceUrl: current.source.url ?? "https://example.invalid/model-process",
      isModel: true,
      createdAt,
      dedupKey,
    };
  }
}

export class MemoryProcessStatusRepository implements ProcessStatusRepository {
  private readonly statuses = new Map<Id, ProcessStatus>();
  private readonly notifications = new Set<string>();
  async get(processId: Id) {
    const value = this.statuses.get(processId);
    return value && structuredClone(value);
  }
  async save(status: ProcessStatus) {
    this.statuses.set(status.processId, structuredClone(status));
  }
  async hasNotification(dedupKey: string) {
    return this.notifications.has(dedupKey);
  }
  async markNotification(dedupKey: string) {
    this.notifications.add(dedupKey);
  }
}
