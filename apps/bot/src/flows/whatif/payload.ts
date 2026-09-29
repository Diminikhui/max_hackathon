export const WHATIF_PAYLOAD_PREFIX = "whatif:";

export type WhatIfAction =
  | { readonly type: "show_scenarios" }
  | { readonly type: "run"; readonly scenarioId: string }
  | { readonly type: "card"; readonly scenarioId: string; readonly requirementId: string };

export const encodeWhatIfPayload = (action: WhatIfAction): string => {
  switch (action.type) {
    case "show_scenarios":
      return `${WHATIF_PAYLOAD_PREFIX}start`;
    case "run":
      return `${WHATIF_PAYLOAD_PREFIX}run:${action.scenarioId}`;
    case "card":
      return `${WHATIF_PAYLOAD_PREFIX}card:${action.scenarioId}:${encodeURIComponent(action.requirementId)}`;
  }
};

/** Чужой, устаревший или повреждённый payload не обрабатывается. */
export const decodeWhatIfPayload = (payload: string): WhatIfAction | undefined => {
  if (payload === `${WHATIF_PAYLOAD_PREFIX}start`) return { type: "show_scenarios" };
  if (!payload.startsWith(WHATIF_PAYLOAD_PREFIX)) return undefined;

  const body = payload.slice(WHATIF_PAYLOAD_PREFIX.length);
  if (body.startsWith("run:")) {
    const scenarioId = body.slice("run:".length);
    return scenarioId ? { type: "run", scenarioId } : undefined;
  }
  if (!body.startsWith("card:")) return undefined;
  const encoded = body.slice("card:".length);
  const separator = encoded.indexOf(":");
  if (separator <= 0 || separator === encoded.length - 1) return undefined;
  try {
    return {
      type: "card",
      scenarioId: encoded.slice(0, separator),
      requirementId: decodeURIComponent(encoded.slice(separator + 1)),
    };
  } catch {
    return undefined;
  }
};
