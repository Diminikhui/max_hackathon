export { createWhatIfFlow, type WhatIfFlow, type WhatIfFlowDeps } from "./flow.js";
export {
  decodeWhatIfPayload,
  encodeWhatIfPayload,
  WHATIF_PAYLOAD_PREFIX,
  type WhatIfAction,
} from "./payload.js";
export { whatIfButton } from "./render.js";
export { scenarioById, WHATIF_SCENARIOS } from "./scenarios.js";
export type {
  ScenarioDeltaEntryView,
  ScenarioDeltaOutcomeView,
  ScenarioDeltaSource,
  ScenarioFactInputView,
  ScenarioRequirementDeltaView,
  WhatIfScenario,
} from "./types.js";
