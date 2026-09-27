import type { FetchPage, NpaProject } from "./client/index.js";
import type { DocumentStore } from "./document-store.js";
import { type NormalizationError, normalizeProject } from "./normalize.js";

export interface RegulationProjectSource {
  listNpa(params?: { limit?: number }): Promise<FetchPage>;
}

export interface IngestReport {
  fetched: number;
  /** Записи, отброшенные клиентом до нормализации (например, без id). */
  sourceSkipped: number;
  stored: number;
  duplicates: number;
  rejected: { documentId: string; error: NormalizationError }[];
  retrievedAt: string;
}

export interface RegulationIngestJobOptions {
  source: RegulationProjectSource;
  store: DocumentStore;
  now?: () => number;
  limit?: number;
  /** Ставьте true только для явно модельного источника; значение попадёт в контракт и UI. */
  isModel?: boolean;
}

export class RegulationIngestJob {
  private readonly source: RegulationProjectSource;
  private readonly store: DocumentStore;
  private readonly now: () => number;
  private readonly limit: number;
  private readonly isModel: boolean;
  private running = false;

  constructor(options: RegulationIngestJobOptions) {
    this.source = options.source;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.limit = options.limit ?? 500;
    this.isModel = options.isModel ?? false;
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 500) {
      throw new Error("limit должен быть от 1 до 500");
    }
  }

  /** Одна выборка. Параллельный запуск одного экземпляра запрещён, чтобы не создавать гонку дедупликации. */
  async runOnce(): Promise<IngestReport> {
    if (this.running) throw new Error("Загрузка regulation.gov.ru уже выполняется");
    this.running = true;
    try {
      const retrievedAt = new Date(this.now()).toISOString();
      const page = await this.source.listNpa({ limit: this.limit });
      return await this.storePage(page, retrievedAt);
    } finally {
      this.running = false;
    }
  }

  private async storePage(page: FetchPage, retrievedAt: string): Promise<IngestReport> {
    const report: IngestReport = {
      fetched: page.items.length,
      sourceSkipped: page.skipped,
      stored: 0,
      duplicates: 0,
      rejected: [],
      retrievedAt,
    };
    for (const project of page.items) await this.storeProject(project, retrievedAt, report);
    return report;
  }

  private async storeProject(project: NpaProject, retrievedAt: string, report: IngestReport): Promise<void> {
    const normalized = normalizeProject(project, { retrievedAt, isModel: this.isModel });
    if (!normalized.ok) {
      report.rejected.push({ documentId: normalized.documentId, error: normalized.error });
      return;
    }
    const result = await this.store.put(normalized.document);
    report[result === "stored" ? "stored" : "duplicates"] += 1;
  }
}
