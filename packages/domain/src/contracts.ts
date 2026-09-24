// Типы контрактов v1. Источник правды — JSON Schema в contracts/v1/;
// тест packages/domain/test/contracts.test.ts сверяет перечисления ниже со схемами.

export const CONTRACT_VERSION = 1 as const;
export type ContractVersion = typeof CONTRACT_VERSION;

export const FACT_KINDS = ["official", "declared", "derived", "scenario"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const APPLICABILITY_STATUSES = [
  "applies",
  "not_applies",
  "insufficient_data",
  "needs_review",
  "out_of_coverage",
] as const;
export type ApplicabilityStatus = (typeof APPLICABILITY_STATUSES)[number];

export const CONDITION_OUTCOMES = ["yes", "no", "unknown"] as const;
export type ConditionOutcome = (typeof CONDITION_OUTCOMES)[number];

export const REQUIREMENT_KINDS = ["obligation", "opportunity"] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

export const REQUIREMENT_COVERAGES = ["full", "partial", "none"] as const;
export type RequirementCoverage = (typeof REQUIREMENT_COVERAGES)[number];

export const ENTITY_TYPES = ["legal_entity", "individual_entrepreneur"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const CHANGE_EVENT_KINDS = ["rulepack_version", "regulation_document", "profile_change"] as const;
export type ChangeEventKind = (typeof CHANGE_EVENT_KINDS)[number];

export const NOTIFICATION_REASONS = [
  "became_applicable",
  "no_longer_applicable",
  "status_changed",
  "early_signal",
] as const;
export type NotificationReason = (typeof NOTIFICATION_REASONS)[number];

export const NOTIFICATION_STATUSES = ["queued", "sent", "failed", "suppressed"] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const EXPLANATION_STEP_KINDS = ["fact", "condition", "rule", "result", "source"] as const;
export type ExplanationStepKind = (typeof EXPLANATION_STEP_KINDS)[number];

/** Известные ключи фактов v1. Список открыт: новый ключ добавляется в contracts/README.md. */
export const FACT_KEYS = {
  okvedMain: "activity.okved_main",
  okvedAdditional: "activity.okved_additional",
  regionCode: "location.region_code",
  mspCategory: "scale.msp_category",
  headcount: "employment.headcount",
  hasEmployees: "employment.has_employees",
  taxRegime: "tax.regime",
  hasLicenses: "licenses.has_any",
  salesAlcohol: "sales.alcohol",
} as const;

export type Id = string;
/** Дата и время в ISO 8601, например `2026-09-25T09:00:00Z`. */
export type DateTime = string;
/** Дата в формате `YYYY-MM-DD`. */
export type IsoDate = string;

export interface Period {
  from?: IsoDate;
  to?: IsoDate;
}

export interface SourceRef {
  system: string;
  url?: string;
  recordId?: string;
  retrievedAt: DateTime;
  /** Модельные данные: помечаются модельными в интерфейсе. */
  isModel: boolean;
}

export interface LegalBasis {
  act: string;
  article?: string;
  url: string;
}

export type FactValue = string | number | boolean | string[];

export interface Fact {
  id: Id;
  companyId: Id;
  key: string;
  value: FactValue;
  kind: FactKind;
  source: SourceRef;
  observedAt: DateTime;
  validity?: Period;
  /** Обязательно для kind = "derived". */
  derivedFrom?: Id[];
}

export interface CompanyProfile {
  contractVersion: ContractVersion;
  companyId: Id;
  inn: string;
  entityType: EntityType;
  /** Для ИП — ФИО, персональные данные: не логировать. */
  displayName?: string;
  facts: Fact[];
  isModel: boolean;
  updatedAt: DateTime;
}

/** Условие применимости. Формат задаёт K-15a; в v1 гарантировано только поле `type`. */
export interface Condition {
  type: string;
  [key: string]: unknown;
}

export interface Requirement {
  contractVersion: ContractVersion;
  id: Id;
  packId: Id;
  packVersion: number;
  kind: RequirementKind;
  title: string;
  summary?: string;
  basis: LegalBasis[];
  deadline?: string;
  validity?: Period;
  condition: Condition;
  coverage: RequirementCoverage;
  source: SourceRef;
}

export interface ConditionResult {
  /** Путь узла в дереве условия: `$`, `$.items[1]`. */
  path: string;
  conditionType: string;
  outcome: ConditionOutcome;
  factKeys: string[];
  factIds: Id[];
  expected?: string;
  actual?: string;
  children?: ConditionResult[];
}

export interface ExplanationStep {
  kind: ExplanationStepKind;
  text: string;
  refId?: string;
  /** Обязательно для kind = "source". */
  url?: string;
}

export interface ApplicabilityResult {
  contractVersion: ContractVersion;
  companyId: Id;
  requirementId: Id;
  packId: Id;
  packVersion: number;
  status: ApplicabilityStatus;
  statusReason?: string;
  /** Обязательно и непусто для status = "insufficient_data". */
  missingFactKeys?: string[];
  /** Обязательно для applies, not_applies, insufficient_data. */
  trace?: ConditionResult;
  explanation: ExplanationStep[];
  evaluatedAt: DateTime;
}

export interface RulepackChange {
  packId: Id;
  fromVersion?: number;
  toVersion: number;
  addedRequirementIds: Id[];
  changedRequirementIds: Id[];
  removedRequirementIds: Id[];
}

export interface RegulationDocument {
  documentId: Id;
  title: string;
  url: string;
  publishedAt: DateTime;
  stage?: string;
  /** Сферы regulation.gov.ru. Это не коды ОКВЭД. */
  sphereIds?: string[];
  source: SourceRef;
}

export interface ProfileChange {
  companyId: Id;
  changedFactKeys: string[];
}

interface ChangeEventBase {
  contractVersion: ContractVersion;
  id: Id;
  occurredAt: DateTime;
  isModel: boolean;
}

export type ChangeEvent =
  | (ChangeEventBase & { kind: "rulepack_version"; rulepack: RulepackChange })
  | (ChangeEventBase & { kind: "regulation_document"; document: RegulationDocument })
  | (ChangeEventBase & { kind: "profile_change"; profile: ProfileChange });

export interface NotificationCandidate {
  contractVersion: ContractVersion;
  id: Id;
  companyId: Id;
  changeEventId: Id;
  reason: NotificationReason;
  /** Обязательно, кроме reason = "early_signal". */
  requirementId?: Id;
  previousStatus?: ApplicabilityStatus;
  /** Обязательно, кроме early_signal; для early_signal — только "needs_review". */
  newStatus?: ApplicabilityStatus;
  matchedFactKeys: string[];
  dedupKey: string;
  isModel: boolean;
  createdAt: DateTime;
}

export type NotificationButton = { text: string; url: string } | { text: string; payload: string };

export interface Notification {
  contractVersion: ContractVersion;
  id: Id;
  candidateId: Id;
  companyId: Id;
  recipient: { channel: "max_bot"; chatId: string };
  text: string;
  buttons?: NotificationButton[];
  /** Минимум одна ссылка на официальный первоисточник. */
  sourceUrls: string[];
  /** Текст сформирован автоматически — в сообщении есть пометка. */
  automated: boolean;
  isModel: boolean;
  idempotencyKey: string;
  status: NotificationStatus;
  attempts: number;
  createdAt: DateTime;
  /** Обязательно для status = "sent". */
  sentAt?: DateTime;
  /** Обязательно для status = "failed"; code — из таксономии K-27. */
  error?: { code: string; message?: string };
}
