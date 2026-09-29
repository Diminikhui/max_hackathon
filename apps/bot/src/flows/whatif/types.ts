import type { ApplicabilityResult, FactValue, Requirement } from "@max-hackathon/domain";

export interface ScenarioFactInputView {
  readonly key: string;
  readonly value: FactValue;
}

export interface ScenarioDeltaEntryView {
  readonly requirement: Requirement;
  readonly before: ApplicabilityResult;
  readonly after: ApplicabilityResult;
}

export interface ScenarioRequirementDeltaView {
  readonly appeared: readonly ScenarioDeltaEntryView[];
  readonly disappeared: readonly ScenarioDeltaEntryView[];
  readonly changed: readonly ScenarioDeltaEntryView[];
}

export type ScenarioDeltaOutcomeView =
  | { readonly status: "profile_not_found"; readonly companyId: string }
  | {
      readonly status: "ok";
      readonly delta: {
        readonly obligations: ScenarioRequirementDeltaView;
        readonly opportunities: ScenarioRequirementDeltaView;
      };
    };

/** Структурно совпадает с `ScenarioDeltaService` из `@max-hackathon/services`. */
export interface ScenarioDeltaSource {
  compare(companyId: string, inputs: readonly ScenarioFactInputView[]): Promise<ScenarioDeltaOutcomeView>;
}

export interface WhatIfScenario {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  readonly inputs: readonly ScenarioFactInputView[];
}
