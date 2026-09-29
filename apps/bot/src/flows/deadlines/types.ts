import type { LegalBasis, RequirementKind } from "@max-hackathon/domain";
import type { FlowReply } from "../checklist/index.js";

interface ActionBaseView {
  readonly companyId: string;
  readonly requirementId: string;
  readonly kind: RequirementKind;
  readonly title: string;
  /** Исходный текст срока из записи пакета. */
  readonly deadline: string;
  readonly basis: readonly LegalBasis[];
  readonly isModel: boolean;
}

export interface DatedActionView extends ActionBaseView {
  readonly dueDate: string;
  readonly dueAction?: string;
}

export type UndatedReason =
  | "event"
  | "continuous"
  | "periodic_without_last_date"
  | "calendar_outdated"
  | "not_in_calendar";

export interface UndatedActionView extends ActionBaseView {
  readonly reason: UndatedReason;
  readonly detail?: string;
}

export interface ActionQueueView {
  readonly companyId: string;
  readonly asOf: string;
  readonly actions: readonly DatedActionView[];
  readonly undated: readonly UndatedActionView[];
}

export type ActionQueueOutcomeView =
  | { readonly status: "ok"; readonly queue: ActionQueueView }
  | { readonly status: "profile_not_found" };

/** Форма совпадает с `ActionQueueService`: бот зависит только от узкого порта. */
export interface ActionQueueSource {
  build(companyId: string): Promise<ActionQueueOutcomeView>;
}

export interface DeadlinesFlow {
  handle(dialogId: string, payload: string): Promise<FlowReply | undefined>;
}
