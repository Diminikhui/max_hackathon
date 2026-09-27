import type { CompanyProfile, DateTime, Fact, FactValue, Id, Period, ProfileRepository } from "@max-hackathon/domain";

export interface ScenarioFactInput {
  key: string;
  value: FactValue;
  validity?: Period;
}

export interface ScenarioState {
  /** Явная пометка гипотетического состояния для интерфейса и зависимых сервисов. */
  isModel: true;
  createdAt: DateTime;
  baseProfileUpdatedAt: DateTime;
  profile: CompanyProfile;
  scenarioFactIds: Id[];
}

export type ScenarioProfileOutcome =
  | { status: "ok"; scenario: ScenarioState }
  | { status: "profile_not_found"; companyId: Id };

export interface CreateScenarioOptions {
  observedAt?: DateTime;
  factId?: (input: { companyId: Id; key: string; index: number }) => Id;
}

export interface ScenarioProfileServiceDeps {
  profiles: Pick<ProfileRepository, "get">;
  clock?: () => DateTime;
}

/**
 * Создаёт временную сценарную копию профиля без записи в ProfileRepository.
 *
 * Сценарные факты учитываются rule-engine только с `mode: "scenario"`, поэтому
 * эту копию нельзя случайно принять за новое реальное состояние компании.
 */
export class ScenarioProfileService {
  readonly #profiles: Pick<ProfileRepository, "get">;
  readonly #clock: () => DateTime;

  constructor(deps: ScenarioProfileServiceDeps) {
    this.#profiles = deps.profiles;
    this.#clock = deps.clock ?? (() => new Date().toISOString());
  }

  async create(
    companyId: Id,
    inputs: readonly ScenarioFactInput[],
    options: CreateScenarioOptions = {},
  ): Promise<ScenarioProfileOutcome> {
    assertUniqueKeys(inputs);

    const stored = await this.#profiles.get(companyId);
    if (!stored) return { status: "profile_not_found", companyId };

    const createdAt = options.observedAt ?? this.#clock();
    const factId = options.factId ?? defaultFactId;
    const profile = structuredClone(stored);
    profile.facts = profile.facts.filter((fact) => fact.kind !== "scenario");

    const scenarioFacts = inputs.map<Fact>((input, index) => ({
      id: factId({ companyId, key: input.key, index }),
      companyId,
      key: input.key,
      value: structuredClone(input.value),
      kind: "scenario",
      source: {
        system: "scenario",
        recordId: "what-if",
        retrievedAt: createdAt,
        isModel: true,
      },
      observedAt: createdAt,
      ...(input.validity ? { validity: structuredClone(input.validity) } : {}),
    }));
    profile.facts.push(...scenarioFacts);

    return {
      status: "ok",
      scenario: {
        isModel: true,
        createdAt,
        baseProfileUpdatedAt: stored.updatedAt,
        profile,
        scenarioFactIds: scenarioFacts.map(({ id }) => id),
      },
    };
  }
}

const assertUniqueKeys = (inputs: readonly ScenarioFactInput[]): void => {
  const keys = new Set<string>();
  for (const input of inputs) {
    if (keys.has(input.key)) throw new Error(`Сценарный факт ${input.key} задан повторно`);
    keys.add(input.key);
  }
};

const defaultFactId = ({ companyId, key, index }: { companyId: Id; key: string; index: number }): Id =>
  `scenario:${companyId}:${index}:${key}`;
