import type { ClassifierProfile, DocumentInput } from "../core/index.js";
import { REGULATORY_IMPACT_SCHEMA, type RegulatoryImpactDraft } from "./schema.js";

export function regulatoryImpactTemplate(document: Readonly<DocumentInput>): RegulatoryImpactDraft {
  return {
    summary: document.title.trim().slice(0, 2000),
    impactTypes: [],
    effectiveDate: null,
    industry: "unknown",
  };
}

/** Готовый профиль для classifyDocument: строгая схема и безопасный режим без ИИ. */
export const REGULATORY_IMPACT_PROFILE: ClassifierProfile<RegulatoryImpactDraft> = {
  responseSchema: REGULATORY_IMPACT_SCHEMA,
  template: regulatoryImpactTemplate,
};
