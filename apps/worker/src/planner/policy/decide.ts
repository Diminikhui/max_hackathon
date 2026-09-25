import type { NotificationCandidate } from "@max-hackathon/domain";
import type {
  NotificationSettings,
  PolicyBatchContext,
  PolicyBatchItem,
  PolicyConfig,
  PolicyContext,
  PolicyDecision,
} from "./types.js";

/**
 * Лимит по умолчанию — 4 уведомления в календарный месяц МСК.
 * Концепт обещает «единицы сообщений в месяц, а не десятки»; замер ленты regulation.gov.ru
 * даёт 1,8–2,8 значимых документа в месяц на отрасль (docs/proposals/2026-09-23-gaps-and-proposals.md).
 * 4 покрывает обычный месяц с запасом и режет всплески; важные причины лимитом не режутся.
 */
export const DEFAULT_MONTHLY_LIMIT = 4;

/** Ранний сигнал ниже этой релевантности (0..1) не отправляется. */
export const DEFAULT_EARLY_SIGNAL_THRESHOLD = 0.5;

export const DEFAULT_POLICY_CONFIG: Readonly<PolicyConfig> = Object.freeze({
  monthlyLimit: DEFAULT_MONTHLY_LIMIT,
  earlySignalThreshold: DEFAULT_EARLY_SIGNAL_THRESHOLD,
  priorityReasons: Object.freeze(["became_applicable", "no_longer_applicable"] as const),
});

export const DEFAULT_NOTIFICATION_SETTINGS: Readonly<NotificationSettings> = Object.freeze({
  enabled: true,
  earlySignals: true,
});

/** Дополняет частичную конфигурацию значениями по умолчанию и проверяет её. */
export function resolvePolicyConfig(config: Partial<PolicyConfig> = {}): PolicyConfig {
  const resolved: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, ...config };
  if (!Number.isInteger(resolved.monthlyLimit) || resolved.monthlyLimit < 0) {
    throw new RangeError(`monthlyLimit должен быть целым числом ≥ 0, получено ${resolved.monthlyLimit}`);
  }
  if (
    !Number.isFinite(resolved.earlySignalThreshold) ||
    resolved.earlySignalThreshold < 0 ||
    resolved.earlySignalThreshold > 1
  ) {
    throw new RangeError(
      `earlySignalThreshold должен быть в диапазоне 0..1, получено ${resolved.earlySignalThreshold}`,
    );
  }
  return resolved;
}

const suppress = (code: PolicyDecision["code"]): PolicyDecision => ({
  action: "suppress",
  code,
  countsTowardLimit: false,
});

/**
 * Решение по одному кандидату. Чистая детерминированная функция: без БД, часов и случайности.
 * Правила применяются по порядку, срабатывает первое (см. README.md рядом).
 */
export function decide(
  candidate: NotificationCandidate,
  context: PolicyContext,
  config: Partial<PolicyConfig> = {},
): PolicyDecision {
  const policy = resolvePolicyConfig(config);
  const settings = context.settings ?? DEFAULT_NOTIFICATION_SETTINGS;

  if (context.isDuplicate) return suppress("duplicate");
  if (!settings.enabled) return suppress("notifications_disabled");

  if (candidate.reason === "early_signal") {
    if (!settings.earlySignals) return suppress("early_signals_disabled");
    const relevance = context.relevance;
    if (relevance === undefined || !Number.isFinite(relevance)) return suppress("relevance_unknown");
    if (relevance < policy.earlySignalThreshold) return suppress("below_relevance_threshold");
  }

  if (policy.priorityReasons.includes(candidate.reason)) {
    return { action: "send", code: "priority_reason", countsTowardLimit: true };
  }
  if (context.sentThisMonth >= policy.monthlyLimit) {
    return { action: "digest", code: "monthly_limit_reached", countsTowardLimit: false };
  }
  return { action: "send", code: "within_monthly_limit", countsTowardLimit: true };
}

/**
 * Решения по пакету кандидатов одного прогона планировщика, в порядке входа.
 * Учитывает решения внутри пакета: второй кандидат с тем же dedupKey — дубль,
 * отправленные в этом прогоне расходуют лимит компании.
 */
export function decideAll(
  candidates: readonly NotificationCandidate[],
  context: PolicyBatchContext,
  config: Partial<PolicyConfig> = {},
): PolicyBatchItem[] {
  const policy = resolvePolicyConfig(config);
  const seen = new Set<string>();
  const sentInRun = new Map<string, number>();

  return candidates.map((candidate) => {
    const key = JSON.stringify([candidate.companyId, candidate.dedupKey]);
    const decision = decide(
      candidate,
      {
        isDuplicate: seen.has(key) || context.isDuplicate(candidate.companyId, candidate.dedupKey),
        sentThisMonth: context.sentThisMonth(candidate.companyId) + (sentInRun.get(candidate.companyId) ?? 0),
        settings: context.settings?.(candidate.companyId),
        relevance: context.relevance?.(candidate),
      },
      policy,
    );
    seen.add(key);
    if (decision.countsTowardLimit) {
      sentInRun.set(candidate.companyId, (sentInRun.get(candidate.companyId) ?? 0) + 1);
    }
    return { candidate, decision };
  });
}
