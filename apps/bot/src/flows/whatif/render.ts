import type { NotificationButton } from "@max-hackathon/domain";
import { composeText, renderAutomaticProcessingNote } from "../../messages/shared.js";
import { encodeButtonPayload } from "../../transport/index.js";
import { type FlowReply, renderRequirementCard } from "../checklist/index.js";
import { encodeWhatIfPayload } from "./payload.js";
import { WHATIF_SCENARIOS } from "./scenarios.js";
import type {
  ScenarioDeltaEntryView,
  ScenarioDeltaOutcomeView,
  ScenarioRequirementDeltaView,
  WhatIfScenario,
} from "./types.js";

const HEADER = "🔮 Сценарный расчёт — не ваши текущие данные";

export const whatIfButton = (): NotificationButton => ({
  text: "🔮 Что будет, если…",
  payload: encodeWhatIfPayload({ type: "show_scenarios" }),
});

export const scenariosButton = (): NotificationButton => ({
  text: "← Сценарии",
  payload: encodeWhatIfPayload({ type: "show_scenarios" }),
});

const homeButton = (): NotificationButton => ({
  text: "🏠 Меню",
  payload: encodeButtonPayload({ type: "home" }),
});

const reply = (
  lines: readonly string[],
  buttons: NotificationButton[],
  sourceUrls: readonly string[] = [],
): FlowReply => ({
  text: composeText(lines, renderAutomaticProcessingNote(true)),
  sourceUrls: [...new Set(sourceUrls)],
  automated: true,
  buttons,
});

export const renderScenarioMenu = (): FlowReply =>
  reply(
    [
      HEADER,
      "",
      "Выберите гипотетическое изменение. Бот сравнит обязанности и меры поддержки, не меняя профиль компании.",
    ],
    [
      ...WHATIF_SCENARIOS.map((scenario) => ({
        text: scenario.label,
        payload: encodeWhatIfPayload({ type: "run", scenarioId: scenario.id }),
      })),
      homeButton(),
    ],
  );

export const renderNoCompany = (): FlowReply =>
  reply([HEADER, "", "Сначала выберите и подтвердите компанию, затем запустите сценарный расчёт."], [homeButton()]);

export const renderScenarioUnavailable = (): FlowReply =>
  reply(
    [HEADER, "", "Не удалось выполнить сценарный расчёт. Реальный профиль не изменён — попробуйте ещё раз."],
    [scenariosButton(), homeButton()],
  );

const count = (delta: ScenarioRequirementDeltaView): string =>
  `+${delta.appeared.length}, −${delta.disappeared.length}, изменилось ${delta.changed.length}`;

const sourceLine = (entry: ScenarioDeltaEntryView): string => {
  const basis = entry.requirement.basis[0];
  if (basis === undefined) return "Источник в записи не указан";
  return `${basis.act}: ${basis.url}`;
};

const appearedLines = (title: string, entries: readonly ScenarioDeltaEntryView[], offset = 0): string[] =>
  entries.length === 0
    ? []
    : [
        "",
        title,
        ...entries.map(
          (entry, index) => `${offset + index + 1}. ${entry.requirement.title}\n   Источник: ${sourceLine(entry)}`,
        ),
      ];

const allEntries = (outcome: Extract<ScenarioDeltaOutcomeView, { status: "ok" }>): ScenarioDeltaEntryView[] => [
  ...outcome.delta.obligations.appeared,
  ...outcome.delta.opportunities.appeared,
];

export const renderScenarioDelta = (
  scenario: WhatIfScenario,
  outcome: Extract<ScenarioDeltaOutcomeView, { status: "ok" }>,
): FlowReply => {
  const { obligations, opportunities } = outcome.delta;
  // MAX допускает не больше 210 кнопок; оставляем запас под навигацию и возможное расширение экрана.
  const entries = allEntries(outcome).slice(0, 200);
  const shownObligations = entries.filter(({ requirement }) => requirement.kind === "obligation");
  const shownOpportunities = entries.filter(({ requirement }) => requirement.kind === "opportunity");
  const appearedTotal = obligations.appeared.length + opportunities.appeared.length;
  const total =
    obligations.appeared.length +
    obligations.disappeared.length +
    obligations.changed.length +
    opportunities.appeared.length +
    opportunities.disappeared.length +
    opportunities.changed.length;
  const lines = [
    HEADER,
    "Реальный профиль не изменён и не сохранён.",
    "",
    `Если ${scenario.summary}: ${count(obligations)} обязанностей.`,
    `Меры поддержки: ${count(opportunities)}.`,
    ...(total === 0 ? ["", "Изменений для текущего перечня нет."] : []),
    ...appearedLines("Появятся обязанности:", shownObligations),
    ...appearedLines("Станут доступны меры поддержки:", shownOpportunities, shownObligations.length),
    ...(entries.length < appearedTotal
      ? ["", `Показаны ${entries.length} из ${appearedTotal} появившихся записей из-за лимита кнопок MAX.`]
      : []),
  ];
  const buttons: NotificationButton[] = [
    ...entries.map((entry, index) => ({
      text: String(index + 1),
      payload: encodeWhatIfPayload({
        type: "card",
        scenarioId: scenario.id,
        requirementId: entry.requirement.id,
      }),
    })),
    scenariosButton(),
    homeButton(),
  ];
  return reply(
    lines,
    buttons,
    entries.flatMap((entry) => entry.requirement.basis.map(({ url }) => url)),
  );
};

export const renderScenarioCard = (scenario: WhatIfScenario, entry: ScenarioDeltaEntryView): FlowReply => {
  const card = renderRequirementCard({ requirement: entry.requirement, applicability: entry.after });
  return {
    ...card,
    text: `${HEADER}\nЕсли ${scenario.summary}. Реальный профиль не изменён.\n\n${card.text}`,
    buttons: [scenariosButton(), homeButton()],
  };
};
