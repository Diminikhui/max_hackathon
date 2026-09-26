// K-13a. Always-available, explicitly modelled RequirementSource.
import type { Condition, Requirement, RequirementQuery, RequirementSource, SourceInfo } from "@max-hackathon/domain";

const retrievedAt = "2026-09-25T00:00:00Z";

/**
 * Model records based on the shapes explored by K-03a and the food-service
 * scenarios collected by K-06a. They are examples, not legal obligations.
 */
export const MODEL_REQUIREMENTS: readonly Requirement[] = [
  {
    contractVersion: 1,
    id: "k13a.model.foodservice.base",
    packId: "k13a-model",
    packVersion: 1,
    kind: "obligation",
    title: "Модельное требование для общепита — не юридическая обязанность",
    summary: "Синтетическая запись для демонстрации отбора по ОКВЭД 56.",
    basis: [{ act: "Модельный акт", url: "https://example.invalid/k13a/model-foodservice" }],
    condition: { type: "okved_prefix", prefix: "56" },
    coverage: "partial",
    source: {
      system: "fixture",
      url: "https://example.invalid/k13a/model-foodservice",
      retrievedAt,
      isModel: true,
    },
  },
  {
    contractVersion: 1,
    id: "k13a.model.foodservice.employees",
    packId: "k13a-model",
    packVersion: 1,
    kind: "obligation",
    title: "Модельное требование для общепита с работниками — не юридическая обязанность",
    summary: "Синтетический сценарий по форме эталонного чеклиста K-06a.",
    basis: [{ act: "Модельный акт", url: "https://example.invalid/k13a/model-employees" }],
    condition: {
      type: "all",
      items: [
        { type: "okved_prefix", prefix: "56" },
        { type: "has_employees", value: true },
      ],
    },
    coverage: "partial",
    source: {
      system: "fixture",
      url: "https://example.invalid/k13a/model-employees",
      retrievedAt,
      isModel: true,
    },
  },
  {
    contractVersion: 1,
    id: "k13a.model.foodservice.tatarstan",
    packId: "k13a-model",
    packVersion: 1,
    kind: "obligation",
    title: "Модельное региональное требование — не юридическая обязанность",
    summary: "Синтетическая запись для проверки отбора по региону Татарстана.",
    basis: [{ act: "Модельный региональный акт", url: "https://example.invalid/k13a/model-region" }],
    condition: {
      type: "all",
      items: [
        { type: "okved_prefix", prefix: "56" },
        { type: "region", codes: ["16"] },
      ],
    },
    coverage: "partial",
    source: {
      system: "fixture",
      url: "https://example.invalid/k13a/model-region",
      retrievedAt,
      isModel: true,
    },
  },
  {
    contractVersion: 1,
    id: "k13a.model.retail",
    packId: "k13a-model",
    packVersion: 1,
    kind: "obligation",
    title: "Модельное требование для розничной торговли — не юридическая обязанность",
    summary: "Синтетическая запись для демонстрации отбора по ОКВЭД 47.",
    basis: [{ act: "Модельный акт", url: "https://example.invalid/k13a/model-retail" }],
    condition: { type: "okved_prefix", prefix: "47" },
    coverage: "partial",
    source: {
      system: "fixture",
      url: "https://example.invalid/k13a/model-retail",
      retrievedAt,
      isModel: true,
    },
  },
] as const;

type Scopes = { okvedPrefixes: string[]; regionCodes: string[] };

const collectScopes = (condition: Condition, scopes: Scopes): void => {
  if (condition.type === "okved_prefix" && typeof condition.prefix === "string") {
    scopes.okvedPrefixes.push(condition.prefix);
  }
  if (condition.type === "region" && Array.isArray(condition.codes)) {
    scopes.regionCodes.push(...condition.codes.filter((code): code is string => typeof code === "string"));
  }
  if (Array.isArray(condition.items)) {
    for (const item of condition.items) {
      if (typeof item === "object" && item !== null && typeof item.type === "string") {
        collectScopes(item as Condition, scopes);
      }
    }
  }
};

const overlapsPrefix = (left: string, right: string): boolean => left.startsWith(right) || right.startsWith(left);

const matchesQuery = (requirement: Requirement, query: RequirementQuery): boolean => {
  const scopes: Scopes = { okvedPrefixes: [], regionCodes: [] };
  collectScopes(requirement.condition, scopes);
  if (
    query.okvedPrefixes?.length &&
    scopes.okvedPrefixes.length &&
    !query.okvedPrefixes.some((queryPrefix) => scopes.okvedPrefixes.some((scope) => overlapsPrefix(queryPrefix, scope)))
  ) {
    return false;
  }
  if (
    query.regionCodes?.length &&
    scopes.regionCodes.length &&
    !query.regionCodes.some((region) => scopes.regionCodes.includes(region))
  ) {
    return false;
  }
  return true;
};

/** In-memory source which never performs network or filesystem I/O. */
export class FixtureRequirementSource implements RequirementSource {
  readonly info: SourceInfo = { name: "fixture", isModel: true };
  readonly #requirements: readonly Requirement[];

  constructor(requirements: readonly Requirement[] = MODEL_REQUIREMENTS) {
    const ids = new Set<string>();
    for (const requirement of requirements) {
      if (!requirement.source.isModel) {
        throw new Error(`Требование ${requirement.id} не помечено модельным (source.isModel = true)`);
      }
      if (ids.has(requirement.id)) throw new Error(`Требование ${requirement.id} встречается в fixture дважды`);
      ids.add(requirement.id);
    }
    this.#requirements = structuredClone(requirements);
  }

  async listRequirements(query: RequirementQuery): Promise<Requirement[]> {
    return structuredClone(this.#requirements.filter((requirement) => matchesQuery(requirement, query)));
  }
}
