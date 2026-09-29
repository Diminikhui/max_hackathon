// Читаемые подписи узлов и значений для трассы (ConditionResult.expected / actual).
// Цепочку объяснения для пользователя строит K-16c; здесь — короткие детерминированные формулировки.

import type { ConditionNode, EntityType, FactValue, MspCategory, TaxRegime } from "@max-hackathon/domain";

const MSP_NAMES: Record<MspCategory, string> = { micro: "микро", small: "малое", medium: "среднее" };

const TAX_NAMES: Record<TaxRegime, string> = {
  osno: "ОСНО",
  usn_income: "УСН «доходы»",
  usn_income_expenses: "УСН «доходы минус расходы»",
  psn: "патент",
  eshn: "ЕСХН",
  ausn: "АУСН",
  npd: "НПД",
};

const ENTITY_NAMES: Record<EntityType, string> = { legal_entity: "организация", individual_entrepreneur: "ИП" };

export const describeEntityType = (entityType: EntityType): string => ENTITY_NAMES[entityType];

export const formatValue = (value: FactValue): string => {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "да" : "нет";
  return String(value);
};

const range = (min: number | undefined, max: number | undefined): string =>
  [min !== undefined ? `от ${min}` : "", max !== undefined ? `до ${max}` : ""].filter(Boolean).join(" ");

export const describeExpected = (node: ConditionNode): string => {
  switch (node.type) {
    case "always":
      return "применяется ко всем";
    case "all":
      return "выполнены все условия";
    case "any":
      return "выполнено хотя бы одно условие";
    case "not":
      return "условие не выполнено";
    case "okved_prefix":
      return node.scope === "main_or_additional"
        ? `основной или дополнительный ОКВЭД начинается с ${node.prefix}`
        : `ОКВЭД начинается с ${node.prefix}`;
    case "region":
      return `регион: ${node.codes.join(", ")}`;
    case "msp_category":
      return `категория МСП: ${node.in.map((category) => MSP_NAMES[category]).join(", ")}`;
    case "has_employees":
      return node.value ? "есть работники" : "нет работников";
    case "headcount":
      return `численность работников ${range(node.min, node.max)}`;
    case "tax_regime":
      return `налоговый режим: ${node.in.map((regime) => TAX_NAMES[regime]).join(", ")}`;
    case "fact_equals":
      return `${node.key} = ${formatValue(node.value)}`;
    case "fact_in":
      return `${node.key}: одно из ${node.values.join(", ")}`;
    case "fact_range":
      return `${node.key} ${range(node.min, node.max)}`;
    case "entity_type":
      return `тип лица: ${node.in.map(describeEntityType).join(", ")}`;
  }
};
