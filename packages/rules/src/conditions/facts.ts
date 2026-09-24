// Выбор одного факта на ключ из профиля: какой факт считать значением признака.

import type { Fact, FactKind, IsoDate } from "@max-hackathon/domain";

export type EvaluationMode = "current" | "scenario";

export interface FactSelectionOptions {
  /** current — реальное состояние; scenario — «что будет, если…»: сценарные факты важнее всех. */
  mode?: EvaluationMode;
  /** Дата расчёта. Если задана, факты с периодом действия, не покрывающим её, не учитываются. */
  asOf?: IsoDate;
}

// Официальный важнее вычисленного, вычисленный — заявленного: заявленный не затирает официальный (K-25b).
const PRIORITY: Record<FactKind, number> = { scenario: 3, official: 2, derived: 1, declared: 0 };

const isValidOn = (fact: Fact, asOf: IsoDate | undefined): boolean => {
  if (!asOf || !fact.validity) return true;
  const { from, to } = fact.validity;
  return (from === undefined || from <= asOf) && (to === undefined || asOf <= to);
};

/** Индекс «ключ → выбранный факт». Отсутствие ключа означает «неизвестно». */
export const selectFacts = (facts: readonly Fact[], options: FactSelectionOptions = {}): ReadonlyMap<string, Fact> => {
  const mode = options.mode ?? "current";
  const selected = new Map<string, Fact>();
  for (const fact of facts) {
    if (fact.kind === "scenario" && mode !== "scenario") continue;
    if (!isValidOn(fact, options.asOf)) continue;
    const current = selected.get(fact.key);
    if (!current || isPreferred(fact, current)) selected.set(fact.key, fact);
  }
  return selected;
};

const isPreferred = (candidate: Fact, current: Fact): boolean => {
  const byKind = PRIORITY[candidate.kind] - PRIORITY[current.kind];
  if (byKind !== 0) return byKind > 0;
  // Одного типа: более свежий; при равной дате — меньший id, чтобы результат не зависел от порядка фактов.
  const byTime = Date.parse(candidate.observedAt) - Date.parse(current.observedAt);
  if (byTime !== 0) return byTime > 0;
  return candidate.id < current.id;
};
