import { FACT_KEYS } from "@max-hackathon/domain";
import type { WhatIfScenario } from "./types.js";

/** Готовые сценарии используют только известные v1-ключи и значения, понятные rule-engine. */
export const WHATIF_SCENARIOS: readonly WhatIfScenario[] = [
  {
    id: "first-employee",
    label: "👤 Найму первого работника",
    summary: "найму первого работника",
    inputs: [{ key: FACT_KEYS.hasEmployees, value: true }],
  },
  {
    id: "sell-alcohol",
    label: "🍷 Начну продавать алкоголь",
    summary: "начну продавать алкоголь",
    inputs: [{ key: FACT_KEYS.salesAlcohol, value: "beer" }],
  },
  {
    id: "usn-income",
    label: "💳 Перейду на УСН «доходы»",
    summary: "перейду на УСН «доходы»",
    inputs: [{ key: FACT_KEYS.taxRegime, value: "usn_income" }],
  },
  {
    id: "tatarstan",
    label: "📍 Буду работать в Татарстане",
    summary: "буду работать в Татарстане",
    inputs: [{ key: FACT_KEYS.regionCode, value: "16" }],
  },
];

export const scenarioById = (id: string): WhatIfScenario | undefined =>
  WHATIF_SCENARIOS.find((scenario) => scenario.id === id);
