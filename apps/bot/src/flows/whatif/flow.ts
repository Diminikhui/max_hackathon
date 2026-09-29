import type { FlowReply } from "../checklist/index.js";
import { decodeWhatIfPayload } from "./payload.js";
import {
  renderNoCompany,
  renderScenarioCard,
  renderScenarioDelta,
  renderScenarioMenu,
  renderScenarioUnavailable,
} from "./render.js";
import { scenarioById } from "./scenarios.js";
import type { ScenarioDeltaOutcomeView, ScenarioDeltaSource } from "./types.js";

export interface WhatIfFlowDeps {
  readonly delta: ScenarioDeltaSource;
  readonly companyOf: (dialogId: string) => Promise<string | undefined>;
}

export interface WhatIfFlow {
  handle(dialogId: string, payload: string): Promise<FlowReply | undefined>;
}

export const createWhatIfFlow = ({ delta, companyOf }: WhatIfFlowDeps): WhatIfFlow => {
  const compare = async (dialogId: string, scenarioId: string) => {
    const scenario = scenarioById(scenarioId);
    if (scenario === undefined) return undefined;
    const companyId = await companyOf(dialogId);
    if (companyId === undefined) return { scenario, outcome: undefined };
    try {
      const outcome = await delta.compare(companyId, scenario.inputs);
      return { scenario, outcome };
    } catch {
      return { scenario, outcome: null };
    }
  };

  const renderComparison = (
    comparison:
      | { scenario: NonNullable<ReturnType<typeof scenarioById>>; outcome: ScenarioDeltaOutcomeView | null | undefined }
      | undefined,
  ): FlowReply | undefined => {
    if (comparison === undefined) return undefined;
    if (comparison.outcome === undefined || comparison.outcome?.status === "profile_not_found")
      return renderNoCompany();
    if (comparison.outcome === null) return renderScenarioUnavailable();
    return renderScenarioDelta(comparison.scenario, comparison.outcome);
  };

  return {
    handle: async (dialogId, payload) => {
      const action = decodeWhatIfPayload(payload);
      if (action === undefined) return undefined;
      if (action.type === "show_scenarios") return renderScenarioMenu();

      const comparison = await compare(dialogId, action.scenarioId);
      if (action.type === "run") return renderComparison(comparison);
      if (comparison === undefined) return undefined;
      if (comparison.outcome === undefined || comparison.outcome?.status === "profile_not_found")
        return renderNoCompany();
      if (comparison.outcome === null) return renderScenarioUnavailable();

      const appeared = [
        ...comparison.outcome.delta.obligations.appeared,
        ...comparison.outcome.delta.opportunities.appeared,
      ];
      const entry = appeared.find(({ requirement }) => requirement.id === action.requirementId);
      return entry === undefined
        ? renderScenarioDelta(comparison.scenario, comparison.outcome)
        : renderScenarioCard(comparison.scenario, entry);
    },
  };
};
