// Агрегатор статусов (K-16b): результат вычисления условия + покрытие записи → один из 5 статусов.
// Детерминирован: одинаковый вход — одинаковый статус и причина.

import {
  CONTRACT_VERSION,
  type ApplicabilityResult,
  type ApplicabilityStatus,
  type CompanyProfile,
  type ConditionNode,
  type DateTime,
  type IsoDate,
  type Requirement,
} from "@max-hackathon/domain";
import { evaluateCondition, type ConditionEvaluation, type EvaluationMode } from "../conditions/index.js";
import { buildExplanation, factLabel } from "../explain/index.js";

export interface StatusDecision {
  status: ApplicabilityStatus;
  statusReason?: string;
  /** Для insufficient_data — что спросить у пользователя. */
  missingFactKeys?: string[];
}

export interface StatusInput {
  requirement: Pick<Requirement, "coverage" | "validity">;
  /** Результат K-16a. Не нужен для записи с coverage = none. */
  evaluation?: ConditionEvaluation;
  /** Дата расчёта: запись, которая на эту дату не действует, не применяется. */
  asOf: IsoDate;
}

export const REASONS = {
  outOfCoverage: "Норма пока не проверяется системой автоматически",
  notInForce: (asOf: IsoDate) => `Норма не действует на ${asOf}`,
  partial: "Часть условий нормы не формализована — нужна проверка",
  dataIssue: "Данные профиля в неверном формате — нужна проверка",
  missing: (keys: string[]) => `Не хватает данных: ${keys.map(factLabel).join(", ")}`,
} as const;

/**
 * Правила по порядку:
 * 1. coverage = none → out_of_coverage.
 * 2. Запись не действует на asOf → not_applies.
 * 3. Условие yes → applies; при coverage = partial → needs_review (формализована только часть условий).
 * 4. Условие no → not_applies: не выполнено формализованное необходимое условие.
 * 5. Условие unknown: есть недостающие факты → insufficient_data; только ошибки данных → needs_review.
 */
export const determineStatus = ({ requirement, evaluation, asOf }: StatusInput): StatusDecision => {
  if (requirement.coverage === "none") return { status: "out_of_coverage", statusReason: REASONS.outOfCoverage };
  if (!isInForce(requirement.validity, asOf)) return { status: "not_applies", statusReason: REASONS.notInForce(asOf) };
  if (!evaluation) throw new Error("Для записи с coverage full или partial нужен результат вычисления условия");

  switch (evaluation.result.outcome) {
    case "yes":
      return requirement.coverage === "partial"
        ? { status: "needs_review", statusReason: REASONS.partial }
        : { status: "applies" };
    case "no":
      return { status: "not_applies" };
    case "unknown":
      return evaluation.missingFactKeys.length > 0
        ? {
            status: "insufficient_data",
            statusReason: REASONS.missing(evaluation.missingFactKeys),
            missingFactKeys: evaluation.missingFactKeys,
          }
        : { status: "needs_review", statusReason: REASONS.dataIssue };
  }
};

const isInForce = (validity: Requirement["validity"], asOf: IsoDate): boolean =>
  !validity || ((validity.from === undefined || validity.from <= asOf) && (validity.to === undefined || asOf <= validity.to));

export interface AssessOptions {
  /** Момент расчёта; попадает в ApplicabilityResult.evaluatedAt. */
  evaluatedAt: DateTime;
  /** Дата, на которую считаются факты и действие нормы. По умолчанию — дата из evaluatedAt. */
  asOf?: IsoDate;
  mode?: EvaluationMode;
}

/** Применимость одной записи к одной компании: вычисление (K-16a) → статус → объяснение (K-16c). */
export const assessRequirement = (
  requirement: Requirement,
  profile: Pick<CompanyProfile, "companyId" | "facts">,
  options: AssessOptions,
): ApplicabilityResult => {
  const asOf = options.asOf ?? options.evaluatedAt.slice(0, 10);
  const evaluation =
    requirement.coverage === "none"
      ? undefined
      : evaluateCondition(requirement.condition as ConditionNode, profile.facts, {
          asOf,
          ...(options.mode ? { mode: options.mode } : {}),
        });
  const decision = determineStatus({ requirement, asOf, ...(evaluation ? { evaluation } : {}) });
  const trace = evaluation?.result;

  return {
    contractVersion: CONTRACT_VERSION,
    companyId: profile.companyId,
    requirementId: requirement.id,
    packId: requirement.packId,
    packVersion: requirement.packVersion,
    ...decision,
    ...(trace ? { trace } : {}),
    explanation: buildExplanation({
      requirement,
      status: decision.status,
      facts: profile.facts,
      ...(trace ? { trace } : {}),
      ...(decision.statusReason ? { statusReason: decision.statusReason } : {}),
    }),
    evaluatedAt: options.evaluatedAt,
  };
};
