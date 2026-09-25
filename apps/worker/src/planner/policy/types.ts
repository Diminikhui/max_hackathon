import type { Id, NotificationCandidate, NotificationReason } from "@max-hackathon/domain";

/** Что сделать с кандидатом: отправить сейчас, отложить в ежемесячную сводку или подавить. */
export const POLICY_ACTIONS = ["send", "digest", "suppress"] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

/**
 * Стабильные коды причин решения. Коды пишутся в журнал, метрики (3-10) и тесты —
 * не переименовывайте их, добавляйте новые.
 */
export const POLICY_DECISION_CODES = [
  // send
  "priority_reason",
  "within_monthly_limit",
  // digest
  "monthly_limit_reached",
  // suppress
  "duplicate",
  "notifications_disabled",
  "early_signals_disabled",
  "relevance_unknown",
  "below_relevance_threshold",
] as const;
export type PolicyDecisionCode = (typeof POLICY_DECISION_CODES)[number];

export interface PolicyDecision {
  action: PolicyAction;
  code: PolicyDecisionCode;
  /** Расходует ли решение месячный лимит компании (true только для action = "send"). */
  countsTowardLimit: boolean;
}

/** Настройки уведомлений компании (меняют K-24c в боте и 2-05 в мини-приложении). */
export interface NotificationSettings {
  /** false — компания отключила уведомления целиком. */
  enabled: boolean;
  /** false — компания отключила ранние сигналы из ленты regulation.gov.ru. */
  earlySignals: boolean;
}

export interface PolicyConfig {
  /** Сколько уведомлений в календарный месяц (МСК) получает компания. */
  monthlyLimit: number;
  /** Минимальная релевантность раннего сигнала, 0..1 включительно. */
  earlySignalThreshold: number;
  /** Причины, которые не ограничиваются лимитом (важные изменения обязанностей). */
  priorityReasons: readonly NotificationReason[];
}

/** Состояние компании на момент решения. Всё читается вызывающим кодом заранее — функция чистая. */
export interface PolicyContext {
  /** Результат NotificationRepository.hasCandidate(companyId, dedupKey). */
  isDuplicate: boolean;
  /** Уведомления компании со статусом sent или queued в текущем месяце МСК (см. countInMskMonth). */
  sentThisMonth: number;
  /** Отсутствие настроек = значения по умолчанию (всё включено). */
  settings?: NotificationSettings | undefined;
  /** Релевантность раннего сигнала 0..1 от классификатора; для остальных причин не используется. */
  relevance?: number | undefined;
}

/** Контекст пакетного решения: состояние по компаниям до начала прогона. */
export interface PolicyBatchContext {
  isDuplicate(companyId: Id, dedupKey: string): boolean;
  sentThisMonth(companyId: Id): number;
  settings?(companyId: Id): NotificationSettings | undefined;
  relevance?(candidate: NotificationCandidate): number | undefined;
}

export interface PolicyBatchItem {
  candidate: NotificationCandidate;
  decision: PolicyDecision;
}
