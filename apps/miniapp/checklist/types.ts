export const CHECKLIST_STATUSES = [
  "applies",
  "not_applies",
  "insufficient_data",
  "needs_review",
  "out_of_coverage",
] as const;

export type ChecklistStatus = (typeof CHECKLIST_STATUSES)[number];
export type ChecklistFilter = "all" | ChecklistStatus;

export interface ChecklistRequirement {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly deadline?: string;
  readonly basis: readonly { readonly act: string; readonly article?: string; readonly url: string }[];
  readonly source: { readonly url?: string; readonly retrievedAt: string; readonly isModel: boolean };
}

export interface ChecklistItem {
  readonly requirement: ChecklistRequirement;
  readonly applicability: {
    readonly status: ChecklistStatus;
    readonly statusReason?: string;
    readonly evaluatedAt: string;
  };
}

export interface CompanyChecklist {
  readonly evaluatedAt: string;
  readonly asOf: string;
  readonly items: readonly ChecklistItem[];
  readonly statusCounts: Readonly<Record<ChecklistStatus, number>>;
}
