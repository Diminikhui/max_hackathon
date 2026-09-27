import type { DateTime, Id, SourceInfo, SourceRef } from "@max-hackathon/domain";

export const PROCESS_STATUS_VALUES = [
  "submitted",
  "accepted",
  "in_review",
  "action_required",
  "approved",
  "rejected",
  "completed",
] as const;
export type ProcessStatusValue = (typeof PROCESS_STATUS_VALUES)[number];

/** Локальный контракт 4-03; JSON-контракты v1 не изменяются. */
export interface ProcessStatus {
  contractVersion: 1;
  processId: Id;
  companyId: Id;
  authority: string;
  serviceName: string;
  status: ProcessStatusValue;
  updatedAt: DateTime;
  source: SourceRef;
}

export interface ProcessStatusSource {
  readonly info: SourceInfo;
  list(companyId: Id): Promise<ProcessStatus[]>;
}

export interface ProcessStatusRepository {
  get(processId: Id): Promise<ProcessStatus | undefined>;
  save(status: ProcessStatus): Promise<void>;
  hasNotification(dedupKey: string): Promise<boolean>;
  markNotification(dedupKey: string): Promise<void>;
}

export interface ProcessStatusNotification {
  id: Id;
  companyId: Id;
  processId: Id;
  previousStatus: ProcessStatusValue;
  newStatus: ProcessStatusValue;
  text: string;
  sourceUrl: string;
  isModel: boolean;
  createdAt: DateTime;
  dedupKey: string;
}
