import type {
  ApplicabilityResult,
  ApplicabilityStatus,
  DateTime,
  Id,
  IsoDate,
  ProfileRepository,
  Requirement,
  RequirementKind,
  RequirementRepository,
} from "@max-hackathon/domain";
import { assessRequirement } from "@max-hackathon/rules";
import {
  type CreateScenarioOptions,
  type ScenarioFactInput,
  ScenarioProfileService,
  type ScenarioState,
} from "./service.js";

export interface ScenarioDeltaEntry {
  requirement: Requirement;
  before: ApplicabilityResult;
  after: ApplicabilityResult;
}

export interface ScenarioRequirementDelta {
  appeared: ScenarioDeltaEntry[];
  disappeared: ScenarioDeltaEntry[];
  changed: ScenarioDeltaEntry[];
}

export interface ScenarioDelta {
  obligations: ScenarioRequirementDelta;
  opportunities: ScenarioRequirementDelta;
}

export interface ScenarioPackSnapshot {
  packId: Id;
  version: number;
}

export type ScenarioDeltaOutcome =
  | { status: "profile_not_found"; companyId: Id }
  | {
      status: "ok";
      scenario: ScenarioState;
      evaluatedAt: DateTime;
      asOf: IsoDate;
      packs: ScenarioPackSnapshot[];
      delta: ScenarioDelta;
    };

export interface BuildScenarioDeltaOptions extends CreateScenarioOptions {
  /** Если не задано, используются последние версии всех опубликованных пакетов. */
  packIds?: readonly Id[];
  evaluatedAt?: DateTime;
  asOf?: IsoDate;
}

export interface ScenarioDeltaServiceDeps {
  profiles: Pick<ProfileRepository, "get">;
  requirements: Pick<RequirementRepository, "listByPack" | "latestVersion" | "listPackIds">;
  clock?: () => DateTime;
}

/** Сравнивает применимость на реальном и временном сценарном состоянии. */
export class ScenarioDeltaService {
  readonly #profiles: Pick<ProfileRepository, "get">;
  readonly #requirements: Pick<RequirementRepository, "listByPack" | "latestVersion" | "listPackIds">;
  readonly #clock: () => DateTime;

  constructor(deps: ScenarioDeltaServiceDeps) {
    this.#profiles = deps.profiles;
    this.#requirements = deps.requirements;
    this.#clock = deps.clock ?? (() => new Date().toISOString());
  }

  async compare(
    companyId: Id,
    inputs: readonly ScenarioFactInput[],
    options: BuildScenarioDeltaOptions = {},
  ): Promise<ScenarioDeltaOutcome> {
    const evaluatedAt = options.evaluatedAt ?? options.observedAt ?? this.#clock();
    const scenarios = new ScenarioProfileService({ profiles: this.#profiles, clock: () => evaluatedAt });
    const outcome = await scenarios.create(companyId, inputs, {
      observedAt: options.observedAt ?? evaluatedAt,
      ...(options.factId ? { factId: options.factId } : {}),
    });
    if (outcome.status === "profile_not_found") return outcome;

    const { requirements, packs } = await this.#snapshot(options.packIds);
    const asOf = options.asOf ?? evaluatedAt.slice(0, 10);
    const entries = requirements.map<ScenarioDeltaEntry>((requirement) => ({
      requirement,
      before: assessRequirement(requirement, outcome.scenario.profile, { evaluatedAt, asOf }),
      after: assessRequirement(requirement, outcome.scenario.profile, {
        evaluatedAt,
        asOf,
        mode: "scenario",
      }),
    }));

    return {
      status: "ok",
      scenario: outcome.scenario,
      evaluatedAt,
      asOf,
      packs,
      delta: calculateScenarioDelta(entries),
    };
  }

  async #snapshot(requestedPackIds: readonly Id[] | undefined): Promise<{
    requirements: Requirement[];
    packs: ScenarioPackSnapshot[];
  }> {
    const packIds = [...new Set(requestedPackIds ?? (await this.#requirements.listPackIds()))].sort();
    const requirements: Requirement[] = [];
    const packs: ScenarioPackSnapshot[] = [];
    for (const packId of packIds) {
      const version = await this.#requirements.latestVersion(packId);
      if (version === undefined) continue;
      const records = await this.#requirements.listByPack(packId, version);
      assertPackSnapshot(packId, version, records);
      packs.push({ packId, version });
      requirements.push(...records);
    }
    requirements.sort((left, right) => left.id.localeCompare(right.id));
    return { requirements, packs };
  }
}

export const calculateScenarioDelta = (entries: readonly ScenarioDeltaEntry[]): ScenarioDelta => {
  const delta: ScenarioDelta = {
    obligations: emptyDelta(),
    opportunities: emptyDelta(),
  };
  for (const entry of entries) {
    const group = groupFor(entry.requirement.kind, delta);
    const beforeVisible = isVisible(entry.before.status);
    const afterVisible = isVisible(entry.after.status);
    if (!beforeVisible && afterVisible) group.appeared.push(entry);
    else if (beforeVisible && !afterVisible) group.disappeared.push(entry);
    else if (beforeVisible && afterVisible && entry.before.status !== entry.after.status) group.changed.push(entry);
  }
  return delta;
};

const emptyDelta = (): ScenarioRequirementDelta => ({ appeared: [], disappeared: [], changed: [] });

const groupFor = (kind: RequirementKind, delta: ScenarioDelta): ScenarioRequirementDelta =>
  kind === "obligation" ? delta.obligations : delta.opportunities;

const isVisible = (status: ApplicabilityStatus): boolean => status !== "not_applies" && status !== "out_of_coverage";

const assertPackSnapshot = (packId: Id, version: number, records: readonly Requirement[]): void => {
  const invalid = records.find((record) => record.packId !== packId || record.packVersion !== version);
  if (invalid) throw new Error(`Репозиторий вернул запись ${invalid.id} вне снимка ${packId}@${version}`);
};
