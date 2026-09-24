// Вычислитель условий (K-16a): (факты, условие) → ConditionResult с трёхзначной логикой.
// Семантика узлов — contracts/rulepack/conditions/README.md. Детерминирован, без ИИ.

import {
  type ConditionNode,
  type ConditionOutcome,
  type ConditionResult,
  FACT_KEYS,
  type Fact,
  type FactValue,
} from "@max-hackathon/domain";
import { describeExpected, formatValue } from "./describe.js";
import { type FactSelectionOptions, selectFacts } from "./facts.js";

export type EvaluationOptions = FactSelectionOptions;

/** Ошибка данных: факт есть, но его тип не подходит условию, или узел неизвестного типа. */
export interface EvaluationIssue {
  path: string;
  message: string;
  factId?: string;
}

export interface ConditionEvaluation {
  /** Дерево результатов (трасса). Корень — `result.outcome`. */
  result: ConditionResult;
  /** Для outcome = unknown: ключи отсутствующих фактов, от которых зависит результат. */
  missingFactKeys: string[];
  issues: EvaluationIssue[];
}

interface Context {
  facts: ReadonlyMap<string, Fact>;
  issues: EvaluationIssue[];
  /** path листа → ключи отсутствующих фактов. */
  missing: Map<string, string[]>;
}

export const evaluateCondition = (
  condition: ConditionNode,
  facts: readonly Fact[],
  options: EvaluationOptions = {},
): ConditionEvaluation => {
  const context: Context = { facts: selectFacts(facts, options), issues: [], missing: new Map() };
  const result = evaluateNode(condition, "$", context);
  return { result, missingFactKeys: collectMissing(result, context.missing), issues: context.issues };
};

const evaluateNode = (node: ConditionNode, path: string, context: Context): ConditionResult => {
  switch (node.type) {
    case "always":
      return composite(node, path, "yes", []);
    case "all": {
      const children = node.items.map((item, index) => evaluateNode(item, `${path}.items[${index}]`, context));
      return composite(node, path, allOf(children.map((child) => child.outcome)), children);
    }
    case "any": {
      const children = node.items.map((item, index) => evaluateNode(item, `${path}.items[${index}]`, context));
      return composite(node, path, anyOf(children.map((child) => child.outcome)), children);
    }
    case "not": {
      const child = evaluateNode(node.item, `${path}.item`, context);
      return composite(node, path, negate(child.outcome), [child]);
    }
    case "okved_prefix":
      return node.scope === "main_or_additional"
        ? okvedMainOrAdditional(node, path, context)
        : leaf(node, path, context, [FACT_KEYS.okvedMain], ([code]) =>
            isString(code) ? code.startsWith(node.prefix) : undefined,
          );
    case "region":
      return leaf(node, path, context, [FACT_KEYS.regionCode], ([code]) =>
        isString(code) ? node.codes.includes(code) : undefined,
      );
    case "msp_category":
      return leaf(node, path, context, [FACT_KEYS.mspCategory], ([category]) =>
        isString(category) ? (node.in as readonly string[]).includes(category) : undefined,
      );
    case "has_employees":
      return leaf(node, path, context, [FACT_KEYS.hasEmployees], ([value]) =>
        typeof value === "boolean" ? value === node.value : undefined,
      );
    case "headcount":
      return leaf(node, path, context, [FACT_KEYS.headcount], ([value]) =>
        typeof value === "number" ? inRange(value, node.min, node.max) : undefined,
      );
    case "tax_regime":
      return leaf(node, path, context, [FACT_KEYS.taxRegime], ([value]) =>
        intersects(value, node.in as readonly string[]),
      );
    case "fact_equals":
      return leaf(node, path, context, [node.key], ([value]) =>
        typeof value === typeof node.value ? value === node.value : undefined,
      );
    case "fact_in":
      return leaf(node, path, context, [node.key], ([value]) => intersects(value, node.values));
    case "fact_range":
      return leaf(node, path, context, [node.key], ([value]) =>
        typeof value === "number" ? inRange(value, node.min, node.max) : undefined,
      );
    default: {
      // Условие не прошло валидацию пакета (K-15c): не падаем, а честно возвращаем «неизвестно».
      const type = String((node as { type?: unknown }).type);
      context.issues.push({ path, message: `Неизвестный тип узла условия: ${type}` });
      return { path, conditionType: type, outcome: "unknown", factKeys: [], factIds: [] };
    }
  }
};

/**
 * Лист по одному или нескольким фактам. `test` получает значения фактов в порядке `keys`
 * и возвращает true/false или undefined, если тип значения не подходит.
 */
const leaf = (
  node: ConditionNode,
  path: string,
  context: Context,
  keys: string[],
  test: (values: FactValue[]) => boolean | undefined,
): ConditionResult => {
  const found = keys.map((key) => context.facts.get(key));
  const base = {
    path,
    conditionType: node.type,
    factKeys: keys,
    factIds: found.filter((fact) => fact !== undefined).map((fact) => fact.id),
    expected: describeExpected(node),
  };
  const missing = keys.filter((_, index) => found[index] === undefined);
  if (missing.length > 0) {
    context.missing.set(path, missing);
    return { ...base, outcome: "unknown" };
  }
  const facts = found as Fact[];
  const actual = facts.map((fact) => formatValue(fact.value)).join("; ");
  const passed = test(facts.map((fact) => fact.value));
  if (passed === undefined) {
    for (const fact of facts) {
      context.issues.push({
        path,
        factId: fact.id,
        message: `Тип значения факта ${fact.key} не подходит условию ${node.type}`,
      });
    }
    return { ...base, actual, outcome: "unknown" };
  }
  return { ...base, actual, outcome: passed ? "yes" : "no" };
};

/** okved_prefix со scope = main_or_additional: yes, если подходит основной или любой дополнительный код. */
const okvedMainOrAdditional = (
  node: Extract<ConditionNode, { type: "okved_prefix" }>,
  path: string,
  context: Context,
): ConditionResult => {
  const keys = [FACT_KEYS.okvedMain, FACT_KEYS.okvedAdditional];
  const [main, additional] = keys.map((key) => context.facts.get(key));
  const matches = (value: FactValue | undefined): boolean | undefined => {
    if (value === undefined) return undefined;
    const codes = Array.isArray(value) ? value : [value];
    return codes.every(isString) ? codes.some((code) => code.startsWith(node.prefix)) : undefined;
  };
  const mainMatch = matches(main?.value);
  const additionalMatch = matches(additional?.value);
  // Если основной код подходит, дополнительные не нужны: результат yes без них.
  if (mainMatch === true || additionalMatch === true) {
    const used = [main, additional].filter((fact) => fact !== undefined);
    return {
      path,
      conditionType: node.type,
      outcome: "yes",
      factKeys: keys,
      factIds: used.map((fact) => fact.id),
      expected: describeExpected(node),
      actual: used.map((fact) => formatValue(fact.value)).join("; "),
    };
  }
  return leaf(node, path, context, keys, ([mainValue, additionalValue]) => {
    const [a, b] = [matches(mainValue), matches(additionalValue)];
    return a === undefined || b === undefined ? undefined : a || b;
  });
};

const composite = (
  node: ConditionNode,
  path: string,
  outcome: ConditionOutcome,
  children: ConditionResult[],
): ConditionResult => ({
  path,
  conditionType: node.type,
  outcome,
  factKeys: [],
  factIds: [],
  expected: describeExpected(node),
  ...(children.length > 0 ? { children } : {}),
});

// Логика Клини: no поглощает в all, yes поглощает в any.
export const allOf = (outcomes: readonly ConditionOutcome[]): ConditionOutcome =>
  outcomes.includes("no") ? "no" : outcomes.every((outcome) => outcome === "yes") ? "yes" : "unknown";

export const anyOf = (outcomes: readonly ConditionOutcome[]): ConditionOutcome =>
  outcomes.includes("yes") ? "yes" : outcomes.every((outcome) => outcome === "no") ? "no" : "unknown";

export const negate = (outcome: ConditionOutcome): ConditionOutcome =>
  outcome === "yes" ? "no" : outcome === "no" ? "yes" : "unknown";

/** Ключи отсутствующих фактов, которые влияют на результат: только из поддеревьев с unknown. */
const collectMissing = (result: ConditionResult, missing: ReadonlyMap<string, string[]>): string[] => {
  const keys = new Set<string>();
  const walk = (node: ConditionResult): void => {
    if (node.outcome !== "unknown") return;
    missing.get(node.path)?.forEach((key) => keys.add(key));
    node.children?.forEach(walk);
  };
  walk(result);
  return [...keys];
};

const isString = (value: unknown): value is string => typeof value === "string";

const inRange = (value: number, min: number | undefined, max: number | undefined): boolean =>
  (min === undefined || value >= min) && (max === undefined || value <= max);

/** Значение (или массив значений) факта пересекается с допустимыми; undefined — неподходящий тип. */
const intersects = (value: FactValue | undefined, allowed: readonly (string | number)[]): boolean | undefined => {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (!values.every((item) => typeof item === "string" || typeof item === "number")) return undefined;
  return values.some((item) => allowed.includes(item));
};
