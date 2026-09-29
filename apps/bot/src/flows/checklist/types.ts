import type { ApplicabilityResult, ApplicabilityStatus, NotificationButton, Requirement } from "@max-hackathon/domain";
import type { DialogState } from "../../dialog/index.js";
import type { RenderedMessage } from "../../messages/index.js";

// Форма совпадает с `CompanyChecklist` и `ChecklistOutcome` из @max-hackathon/services (K-26): бот не зависит от
// пакета services, а `ChecklistService` подходит к порту `ChecklistSource` без переходника.

export interface ChecklistItemView {
  readonly requirement: Requirement;
  readonly applicability: ApplicabilityResult;
}

export interface ChecklistView {
  readonly evaluatedAt: string;
  readonly asOf: string;
  readonly packs: readonly { readonly packId: string; readonly packVersion: number }[];
  readonly items: readonly ChecklistItemView[];
  readonly statusCounts: Readonly<Record<ApplicabilityStatus, number>>;
}

export type ChecklistOutcomeView =
  | { readonly status: "ok"; readonly profile: { readonly isModel: boolean }; readonly checklist: ChecklistView }
  | { readonly status: "profile_not_found" };

export interface ChecklistSource {
  build(companyId: string): Promise<ChecklistOutcomeView>;
}

/** Локальное расширение кнопок домена: MAX открывает связанное мини-приложение через `open_app`. */
export type BotButton =
  | NotificationButton
  | { readonly text: string; readonly webApp: string; readonly payload: string };

/** Ответ сценария: текст и кнопки. Отправляет его K-21b (кнопка → inline-клавиатура MAX). */
export interface FlowReply extends RenderedMessage {
  readonly buttons: BotButton[];
  /**
   * Состояние, которое нужно сохранить вместо `transition.state`. Задаётся, когда показанный экран не совпал с
   * переходом: запись из старой кнопки исчезла (показан перечень) или компания неизвестна (диалог начинается заново).
   */
  readonly stateOverride?: DialogState;
}
