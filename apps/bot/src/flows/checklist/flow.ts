import type { DialogRouteContext, DialogRouteHandler } from "../../dialog/index.js";
import { renderNoCompany, renderRequirementCard, renderRequirementList } from "./render.js";
import type { ChecklistSource, FlowReply } from "./types.js";

export interface ChecklistFlowDeps {
  readonly checklist: ChecklistSource;
  /** Компания, привязанная к диалогу после онбординга (K-24a). `undefined` — ИНН ещё не введён. */
  readonly companyOf: (dialogId: string) => Promise<string | undefined>;
}

export interface ChecklistFlowHandlers {
  readonly show_requirement_list: DialogRouteHandler<FlowReply>;
  readonly show_requirement_details: DialogRouteHandler<FlowReply>;
}

/**
 * Обработчики маршрутов K-22b для перечня и карточки. Перечень строится заново при каждом показе: так карточка
 * и список всегда соответствуют последней версии пакета и профиля.
 */
export const createChecklistFlow = ({ checklist, companyOf }: ChecklistFlowDeps): ChecklistFlowHandlers => {
  const load = async (dialogId: string) => {
    const companyId = await companyOf(dialogId);
    if (companyId === undefined) return undefined;
    const outcome = await checklist.build(companyId);
    return outcome.status === "ok" ? outcome : undefined;
  };

  const showList = async ({ dialogId }: DialogRouteContext): Promise<FlowReply> => {
    const outcome = await load(dialogId);
    if (outcome === undefined) return renderNoCompany();
    return renderRequirementList(outcome.checklist, { profileIsModel: outcome.profile.isModel });
  };

  const showDetails = async ({ dialogId, event }: DialogRouteContext): Promise<FlowReply> => {
    const outcome = await load(dialogId);
    if (outcome === undefined) return renderNoCompany();

    const requirementId = event.type === "select_requirement" ? event.requirementId : undefined;
    const item = outcome.checklist.items.find((candidate) => candidate.requirement.id === requirementId);
    if (item === undefined) {
      // Кнопка из старого сообщения: запись удалена новой версией пакета.
      return {
        ...renderRequirementList(outcome.checklist, {
          profileIsModel: outcome.profile.isModel,
          notice: "Этой записи больше нет в перечне: пакет правил обновился. Ниже — актуальный перечень.",
        }),
        stateOverride: "requirement_list",
      };
    }
    return renderRequirementCard(item);
  };

  return { show_requirement_list: showList, show_requirement_details: showDetails };
};
