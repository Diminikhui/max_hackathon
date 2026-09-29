// Типы формата условий применимости (K-15a). Источник правды —
// contracts/rulepack/conditions/condition.schema.json; семантика — README рядом со схемой.

import type { EntityType } from "./contracts.js";

export const CONDITION_TYPES = [
  "always",
  "all",
  "any",
  "not",
  "okved_prefix",
  "region",
  "msp_category",
  "has_employees",
  "headcount",
  "tax_regime",
  "fact_equals",
  "fact_in",
  "fact_range",
  "entity_type",
] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

export const MSP_CATEGORIES = ["micro", "small", "medium"] as const;
export type MspCategory = (typeof MSP_CATEGORIES)[number];

export const TAX_REGIMES = ["osno", "usn_income", "usn_income_expenses", "psn", "eshn", "ausn", "npd"] as const;
export type TaxRegime = (typeof TAX_REGIMES)[number];

export const OKVED_SCOPES = ["main", "main_or_additional"] as const;
export type OkvedScope = (typeof OKVED_SCOPES)[number];

export type ConditionNode =
  | { type: "always" }
  | { type: "all"; items: ConditionNode[] }
  | { type: "any"; items: ConditionNode[] }
  | { type: "not"; item: ConditionNode }
  /** По умолчанию scope = "main". */
  | { type: "okved_prefix"; prefix: string; scope?: OkvedScope }
  | { type: "region"; codes: string[] }
  | { type: "msp_category"; in: MspCategory[] }
  | { type: "has_employees"; value: boolean }
  /** Границы включительно; хотя бы одна задана. */
  | { type: "headcount"; min?: number; max?: number }
  | { type: "tax_regime"; in: TaxRegime[] }
  | { type: "fact_equals"; key: string; value: string | number | boolean }
  | { type: "fact_in"; key: string; values: (string | number)[] }
  /** Границы включительно; хотя бы одна задана. */
  | { type: "fact_range"; key: string; min?: number; max?: number }
  /** Тип лица из `CompanyProfile.entityType`, а не из фактов. */
  | { type: "entity_type"; in: EntityType[] };
