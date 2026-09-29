import { classifyDocument, type LlmProvider, type ProviderName, TemplateProvider } from "@max-hackathon/classifier";
import {
  composeText,
  modelLabel,
  renderAutomaticProcessingNote,
  renderSources,
  STATUS_TEXT,
} from "../../messages/shared.js";
import type { TransportLogger } from "../../transport/index.js";
import {
  backToListButton,
  type ChecklistItemView,
  type ChecklistSource,
  type FlowReply,
  homeButton,
  renderNoCompany,
  renderRequirementList,
} from "../checklist/index.js";
import { decodeExplainPayload } from "./payload.js";
import { EXPLAIN_TIMEOUT_MS } from "./provider.js";
import {
  composeRetell,
  isEmptyInput,
  looksTechnical,
  mentionsStatus,
  RETELL_SCHEMA,
  type RetellDraft,
  type RetellInput,
  retellDocumentText,
  retellInputOf,
  templateRetell,
} from "./retell.js";

export interface ExplainFlowDeps {
  readonly checklist: ChecklistSource;
  readonly companyOf: (dialogId: string) => Promise<string | undefined>;
  /** По умолчанию — `template` без ИИ. Сборка процесса выбирает провайдер через `explainProviderFromEnv`. */
  readonly provider?: LlmProvider;
  readonly logger?: TransportLogger;
  /** Для тестов; по умолчанию 8 секунд. */
  readonly timeoutMs?: number;
}

export interface ExplainFlow {
  /** Ответ на кнопку «💬 Простым языком». `undefined` — payload не этого сценария. */
  handle(dialogId: string, payload: string): Promise<FlowReply | undefined>;
}

interface Retelling {
  readonly summary: string;
  /** Кто написал текст: `template` — шаблон, иначе — модель. */
  readonly provider: ProviderName;
}

const MODEL_NAMES: Partial<Record<ProviderName, string>> = { gigachat: "GigaChat", local: "локальной" };

const retellLabel = (provider: ProviderName): string =>
  provider === "template"
    ? "📝 Пересказ по шаблону, без ИИ:"
    : `🤖 Пересказ модели ${MODEL_NAMES[provider] ?? `(${provider})`} — проверьте по источнику:`;

export const createExplainFlow = (deps: ExplainFlowDeps): ExplainFlow => {
  const provider = deps.provider ?? new TemplateProvider();
  const timeoutMs = deps.timeoutMs ?? EXPLAIN_TIMEOUT_MS;

  const retell = async (input: RetellInput, item: ChecklistItemView): Promise<Retelling> => {
    const template: Retelling = { summary: templateRetell(input), provider: "template" };
    if (provider.name === "template" || isEmptyInput(input)) return template;

    const sourceUrl = item.requirement.basis[0]?.url;
    if (sourceUrl === undefined) return template;
    try {
      const result = await classifyDocument<RetellDraft>(
        {
          id: input.requirementId,
          title: input.title,
          text: retellDocumentText(input),
          sourceUrl,
          isModel: item.requirement.source.isModel,
        },
        provider,
        { responseSchema: RETELL_SCHEMA, template: () => ({ summary: template.summary, points: [] }), timeoutMs },
      );
      if (result.usedFallback) {
        deps.logger?.warn("bot.explain.fallback", "Model retelling failed, template shown", {
          provider: provider.name,
        });
        return template;
      }
      const text = composeRetell(result.draft);
      if (result.draft.summary.trim() === "" || looksTechnical(text)) {
        deps.logger?.warn("bot.explain.unusable", "Model retelling was empty or technical, template shown", {
          provider: provider.name,
        });
        return template;
      }
      if (mentionsStatus(text)) {
        deps.logger?.warn("bot.explain.status_comment", "Model retelling commented on the status, template shown", {
          provider: provider.name,
        });
        return template;
      }
      return { summary: text, provider: result.provider };
    } catch (error) {
      deps.logger?.warn("bot.explain.failed", "Retelling failed, template shown", { provider: provider.name, error });
      return template;
    }
  };

  const handle = async (dialogId: string, payload: string): Promise<FlowReply | undefined> => {
    const requirementId = decodeExplainPayload(payload);
    if (requirementId === undefined) return undefined;

    const companyId = await deps.companyOf(dialogId);
    if (companyId === undefined) return renderNoCompany();
    const outcome = await deps.checklist.build(companyId);
    if (outcome.status !== "ok") return renderNoCompany();

    const item = outcome.checklist.items.find((candidate) => candidate.requirement.id === requirementId);
    if (item === undefined) {
      return {
        ...renderRequirementList(outcome.checklist, {
          profileIsModel: outcome.profile.isModel,
          notice: "Этой записи больше нет в перечне: пакет правил обновился. Ниже — актуальный перечень.",
        }),
        stateOverride: "requirement_list",
      };
    }

    const input = retellInputOf(item);
    const retelling = await retell(input, item);
    const isModel = outcome.profile.isModel || item.requirement.source.isModel || retelling.provider === "test-double";
    return { ...renderExplanation(item, input, retelling, isModel), stateOverride: "requirement_details" };
  };

  return { handle };
};

/** Статус и первоисточник выводит бот, а не модель: пересказ только объясняет готовые шаги простыми словами. */
const renderExplanation = (
  item: ChecklistItemView,
  input: RetellInput,
  retelling: Retelling,
  isModel: boolean,
): FlowReply => {
  const { applicability } = item;
  const reason = applicability.statusReason ? ` — ${applicability.statusReason}` : "";
  const sources = renderSources(item.requirement.basis);
  const body = [
    `💬 Простым языком${modelLabel(isModel)}`,
    "",
    `${input.kind}: ${input.title}`,
    `Статус: ${STATUS_TEXT[applicability.status]}${reason}`,
    "",
    retellLabel(retelling.provider),
    retelling.summary,
    "",
    ...sources.lines,
  ];
  return {
    text: composeText(body, renderAutomaticProcessingNote(isModel)),
    sourceUrls: sources.urls,
    automated: true,
    buttons: [backToListButton(), homeButton()],
  };
};
