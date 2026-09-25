/** Четыре вида изменения, которые классификатор умеет извлекать из документа. */
export const IMPACT_TYPES = ["new_obligation", "changed_obligation", "removed_obligation", "new_opportunity"] as const;

export type ImpactType = (typeof IMPACT_TYPES)[number];

/** Приоритетные направления MVP; пустое знание выражается значением unknown. */
export const INDUSTRIES = ["food_service", "auto_service", "retail", "cross_industry", "unknown"] as const;

export type Industry = (typeof INDUSTRIES)[number];

export interface RegulatoryImpactDraft {
  summary: string;
  /** Пустой список означает, что в документе недостаточно данных для выбора вида воздействия. */
  impactTypes: ImpactType[];
  /** Дата вступления нормы в силу в ISO-формате либо null, если она не указана однозначно. */
  effectiveDate: string | null;
  industry: Industry;
}

/**
 * Схема намеренно не использует anyOf/oneOf/allOf: её можно передать провайдеру GigaChat.
 * additionalProperties запрещает модели незаметно расширять утверждённый результат.
 */
export const REGULATORY_IMPACT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 2000 },
    impactTypes: {
      type: "array",
      items: { enum: IMPACT_TYPES },
      maxItems: IMPACT_TYPES.length,
      uniqueItems: true,
    },
    effectiveDate: { type: ["string", "null"], format: "date" },
    industry: { enum: INDUSTRIES },
  },
  required: ["summary", "impactTypes", "effectiveDate", "industry"],
  additionalProperties: false,
} as const;
