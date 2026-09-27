import { type ChangeEventRepository, CONTRACT_VERSION, type Id, type RegulationDocument } from "@max-hackathon/domain";

export type DocumentStoreResult = "stored" | "duplicate";

/** Хранилище нормализованных проектов НПА. Повторная запись одного documentId идемпотентна. */
export interface DocumentStore {
  put(document: RegulationDocument): Promise<DocumentStoreResult>;
  get(documentId: Id): Promise<RegulationDocument | undefined>;
}

export function documentEventId(documentId: Id): Id {
  return `regulation-document:${documentId}`;
}

/**
 * Адаптер к постоянному ChangeEventRepository из K-10c. Детерминированный id события и
 * ON CONFLICT в PostgreSQL дают защиту от дублей между запусками и после перезапуска процесса.
 */
export class ChangeEventDocumentStore implements DocumentStore {
  constructor(private readonly events: ChangeEventRepository) {}

  async put(document: RegulationDocument): Promise<DocumentStoreResult> {
    const id = documentEventId(document.documentId);
    const existing = await this.events.get(id);
    if (existing) {
      if (existing.kind !== "regulation_document") {
        throw new Error(`Событие ${id} уже занято другим типом`);
      }
      return "duplicate";
    }

    await this.events.append({
      contractVersion: CONTRACT_VERSION,
      id,
      kind: "regulation_document",
      occurredAt: document.publishedAt,
      isModel: document.source.isModel,
      document,
    });
    return "stored";
  }

  async get(documentId: Id): Promise<RegulationDocument | undefined> {
    const event = await this.events.get(documentEventId(documentId));
    if (!event) return undefined;
    if (event.kind !== "regulation_document") {
      throw new Error(`Событие ${event.id} имеет тип ${event.kind}`);
    }
    return event.document;
  }
}
