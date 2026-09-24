// Цепочка объяснения (K-16c): трасса вычисления → «факт → условие → правило → результат → источник».
// Строится детерминированно из трассы K-16a; ИИ может только переформулировать готовые шаги.

import type {
  ApplicabilityStatus,
  ConditionResult,
  ExplanationStep,
  Fact,
  FactKind,
  Requirement,
} from "@max-hackathon/domain";
import { formatValue } from "../conditions/describe.js";

export interface ExplanationInput {
  requirement: Requirement;
  status: ApplicabilityStatus;
  /** Трасса K-16a. Может отсутствовать у out_of_coverage и needs_review. */
  trace?: ConditionResult;
  /** Факты профиля: по ним шаги «факт» получают значение и происхождение. */
  facts: readonly Fact[];
  statusReason?: string;
}

export const STATUS_TEXT: Record<ApplicabilityStatus, string> = {
  applies: "Применяется",
  not_applies: "Не применяется",
  insufficient_data: "Недостаточно данных",
  needs_review: "Требуется проверка",
  out_of_coverage: "Вне покрытия системы",
};

const FACT_LABELS: Record<string, string> = {
  "activity.okved_main": "Основной ОКВЭД",
  "activity.okved_additional": "Дополнительные ОКВЭД",
  "location.region_code": "Регион",
  "scale.msp_category": "Категория МСП",
  "employment.headcount": "Численность работников",
  "employment.has_employees": "Есть работники",
  "tax.regime": "Налоговый режим",
  "licenses.has_any": "Есть лицензии",
  "sales.alcohol": "Продажа алкоголя",
};

const ORIGIN: Record<FactKind, (fact: Fact) => string> = {
  official: (fact) => `по данным ${fact.source.system}`,
  declared: () => "со слов пользователя",
  derived: () => "вычислено из других данных",
  scenario: () => "сценарий «что будет, если…»",
};

const OUTCOME_TEXT = { yes: "выполнено", no: "не выполнено", unknown: "неизвестно" } as const;

export const factLabel = (key: string): string => FACT_LABELS[key] ?? key;

export const buildExplanation = (input: ExplanationInput): ExplanationStep[] => {
  const { requirement, status, trace } = input;
  const leaves = trace ? decisiveLeaves(trace) : [];
  const factsById = new Map(input.facts.map((fact) => [fact.id, fact]));

  return [
    ...factSteps(leaves, factsById),
    ...conditionSteps(trace, leaves),
    ruleStep(requirement),
    resultStep(status, input.statusReason),
    ...requirement.basis.map(
      (basis): ExplanationStep => ({
        kind: "source",
        text: basis.article ? `${basis.act}, ${basis.article}` : basis.act,
        url: basis.url,
      }),
    ),
  ];
};

export interface DecisiveLeaf {
  node: ConditionResult;
  /** Число `not` над листом: чётное — лист прямо влияет на результат, нечётное — через отрицание. */
  negations: number;
}

/**
 * Листья, которые определили результат: для yes/no в `all` и `any` — дочерние узлы с тем же итогом
 * (для `any` = no и `all` = yes — все), для unknown — неизвестные. Отрицание проходится насквозь.
 */
export const decisiveLeaves = (root: ConditionResult): DecisiveLeaf[] => {
  const result: DecisiveLeaf[] = [];
  const walk = (node: ConditionResult, negations: number): void => {
    const children = node.children ?? [];
    if (children.length === 0) {
      if (node.conditionType !== "always") result.push({ node, negations });
      return;
    }
    if (node.conditionType === "not") {
      children.forEach((child) => walk(child, negations + 1));
      return;
    }
    const matching = children.filter((child) => child.outcome === node.outcome);
    (matching.length > 0 ? matching : children).forEach((child) => walk(child, negations));
  };
  walk(root, 0);
  return result;
};

const factSteps = (leaves: DecisiveLeaf[], factsById: ReadonlyMap<string, Fact>): ExplanationStep[] => {
  const steps: ExplanationStep[] = [];
  const seen = new Set<string>();
  for (const { node } of leaves) {
    const used = node.factIds.map((id) => factsById.get(id)).filter((fact) => fact !== undefined);
    for (const fact of used) {
      if (seen.has(fact.id)) continue;
      seen.add(fact.id);
      const model = fact.source.isModel ? ", модельные данные" : "";
      steps.push({
        kind: "fact",
        text: `${factLabel(fact.key)}: ${formatValue(fact.value)} (${ORIGIN[fact.kind](fact)}${model})`,
        refId: fact.id,
      });
    }
    if (node.outcome !== "unknown") continue;
    const usedKeys = new Set(used.map((fact) => fact.key));
    for (const key of node.factKeys.filter((key) => !usedKeys.has(key))) {
      if (seen.has(key)) continue;
      seen.add(key);
      steps.push({ kind: "fact", text: `${factLabel(key)}: нет данных`, refId: key });
    }
  }
  return steps;
};

const conditionSteps = (trace: ConditionResult | undefined, leaves: DecisiveLeaf[]): ExplanationStep[] => {
  if (!trace) return [];
  const steps = leaves.map(
    ({ node, negations }): ExplanationStep => ({
      kind: "condition",
      text: negations % 2 === 1
        ? `Исключение «${node.expected ?? node.conditionType}» — ${OUTCOME_TEXT[node.outcome]}`
        : `${node.expected ?? node.conditionType} — ${OUTCOME_TEXT[node.outcome]}`,
      refId: node.path,
    }),
  );
  // Итог составного условия (или условие «применяется ко всем»), чтобы было видно, как сложились листья.
  if (leaves.length !== 1 || leaves[0]?.node !== trace) {
    steps.push({
      kind: "condition",
      text: `Итог условия: ${trace.expected ?? trace.conditionType} — ${OUTCOME_TEXT[trace.outcome]}`,
      refId: trace.path,
    });
  }
  return steps;
};

const ruleStep = (requirement: Requirement): ExplanationStep => ({
  kind: "rule",
  text: `${requirement.kind === "opportunity" ? "Возможность" : "Обязанность"}: ${requirement.title}${requirement.source.isModel ? " (модельная запись)" : ""}`,
  refId: requirement.id,
});

const resultStep = (status: ApplicabilityStatus, reason: string | undefined): ExplanationStep => ({
  kind: "result",
  text: reason ? `${STATUS_TEXT[status]}: ${reason}` : STATUS_TEXT[status],
});
