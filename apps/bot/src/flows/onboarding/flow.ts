import {
  type DialogEvent,
  type DialogRouteContext,
  type DialogRouteHandler,
  type DialogState,
  transitionDialog,
} from "../../dialog/index.js";
import type { TransportLogger } from "../../transport/index.js";
import type { FlowReply } from "../checklist/index.js";
import {
  renderIntro,
  renderInvalidInn,
  renderLookupFailed,
  renderLookupInterrupted,
  renderMenu,
  renderProfileCard,
  renderProfileNotFound,
  renderRequestInn,
  renderSwitchCompany,
  renderWelcome,
} from "./render.js";
import type { OnboardingSessions, PendingProfile, ProfileGateway, ProfileLookupView } from "./types.js";

export interface OnboardingFlowDeps {
  readonly profiles: ProfileGateway;
  readonly sessions: OnboardingSessions;
  /** Для исключений при поиске компании: без записи в журнал «источник недоступен» нечем объяснить (#370). */
  readonly logger?: TransportLogger;
}

export interface OnboardingFlowHandlers {
  readonly show_welcome: DialogRouteHandler<FlowReply>;
  readonly request_inn: DialogRouteHandler<FlowReply>;
  readonly lookup_profile: DialogRouteHandler<FlowReply>;
  readonly confirm_profile: DialogRouteHandler<FlowReply>;
  readonly profile_not_found: DialogRouteHandler<FlowReply>;
  readonly profile_lookup_failed: DialogRouteHandler<FlowReply>;
  readonly show_menu: DialogRouteHandler<FlowReply>;
  readonly recover_current: DialogRouteHandler<FlowReply>;
  readonly reset_dialog: DialogRouteHandler<FlowReply>;
}

export interface OnboardingFlow extends OnboardingFlowHandlers {
  /**
   * Ответ на ввод, который транспорт K-22a не распознал (`dialogEvent === undefined`), например текст вместо ИНН.
   * Состояние не меняется. `undefined` — состояние не относится к онбордингу и меню, ответ за другим сценарием.
   */
  readonly unrecognized: (input: {
    readonly dialogId: string;
    readonly state: string;
  }) => Promise<FlowReply | undefined>;
}

const override = (reply: FlowReply, state: DialogState): FlowReply => ({ ...reply, stateOverride: state });

/**
 * Состояние после системного события поиска. Машина K-22b за один `dispatch` делает один переход, а поиск идёт внутри
 * `lookup_profile`, поэтому следующий переход считается здесь же той же машиной, а не задаётся вручную.
 */
const afterLookup = (event: DialogEvent): DialogState => transitionDialog("loading_profile", event).state;

/**
 * Обработчики маршрутов K-22b для онбординга: приветствие → ИНН → поиск (K-25b) → подтверждение → меню.
 * На любой ошибке пользователь получает объяснение и способ продолжить: ввести ИНН ещё раз или вернуться в начало.
 */
export const createOnboardingFlow = ({ profiles, sessions, logger }: OnboardingFlowDeps): OnboardingFlow => {
  const lookup = async (inn: string): Promise<ProfileLookupView> => {
    try {
      return await profiles.lookup(inn);
    } catch (error) {
      // Сервис сам не бросает на ошибках источника; исключение хранилища для пользователя выглядит так же. В журнал
      // идёт только имя класса ошибки: текст исключения базы может содержать ИНН (у ИП это персональные данные).
      logger?.error("bot.onboarding.lookup_failed", "Company lookup threw, «source unavailable» shown", {
        error: error instanceof Error ? error.name : "unknown",
      });
      return { status: "unavailable", inn, errorCode: "lookup_error", retryable: true, message: "" };
    }
  };

  const showCard = (pending: PendingProfile, notice?: string): FlowReply =>
    renderProfileCard(pending.profile, pending.source, {
      alreadySaved: pending.alreadySaved,
      ...(notice ? { notice } : {}),
    });

  const staleProfile = (): FlowReply =>
    override(renderRequestInn("Данные компании устарели. Отправьте ИНН ещё раз."), "awaiting_inn");

  const menuOrWelcome = async (dialogId: string, notice?: string): Promise<FlowReply> => {
    if ((await sessions.companyOf(dialogId)) === undefined) {
      return override(renderWelcome("Сначала укажите ИНН компании."), "idle");
    }
    return override(renderMenu(notice), "menu");
  };

  const lookupProfile = async ({ dialogId, event }: DialogRouteContext): Promise<FlowReply> => {
    if (event.type !== "submit_inn") return override(renderRequestInn(), "awaiting_inn");

    const outcome = await lookup(event.inn);
    switch (outcome.status) {
      case "invalid_inn":
        // Ошибка ввода, а не источника: остаёмся на вводе ИНН.
        return override(renderInvalidInn(outcome.error.message), "awaiting_inn");
      case "found": {
        const pending: PendingProfile = {
          profile: outcome.profile,
          source: outcome.source,
          alreadySaved: outcome.alreadySaved,
        };
        await sessions.setPendingProfile(dialogId, pending);
        return override(
          showCard(pending),
          afterLookup({ type: "profile_loaded", profileId: outcome.profile.companyId }),
        );
      }
      case "not_found":
        return override(renderProfileNotFound(outcome.message), afterLookup({ type: "profile_not_found" }));
      case "unavailable":
        return override(
          renderLookupFailed(outcome.retryable, outcome.message || undefined),
          afterLookup({ type: "profile_lookup_failed", retryable: outcome.retryable }),
        );
    }
  };

  const confirmProfile = async ({ dialogId, transition }: DialogRouteContext): Promise<FlowReply> => {
    const pending = await sessions.pendingProfile(dialogId);
    if (pending === undefined) return staleProfile();
    return showCard(pending, transition.accepted ? undefined : "Подтвердите данные компании или введите другой ИНН.");
  };

  const saveProfile = async (dialogId: string): Promise<FlowReply> => {
    const pending = await sessions.pendingProfile(dialogId);
    if (pending === undefined) return staleProfile();

    const retry = override(
      showCard(pending, "⚠️ Не удалось сохранить профиль. Нажмите «Всё верно» ещё раз."),
      "confirming_profile",
    );
    let outcome: Awaited<ReturnType<ProfileGateway["confirm"]>>;
    try {
      outcome = await profiles.confirm(pending.profile);
    } catch {
      return retry;
    }
    if (outcome.status !== "ok") return retry;

    await sessions.bindCompany(dialogId, outcome.companyId);
    await sessions.setPendingProfile(dialogId, undefined);
    return renderMenu("✅ Профиль сохранён. Теперь можно посмотреть перечень требований.");
  };

  const showMenu = async ({ dialogId, event, transition }: DialogRouteContext): Promise<FlowReply> => {
    if (transition.accepted && event.type === "confirm_profile") return saveProfile(dialogId);
    return menuOrWelcome(dialogId, transition.accepted ? undefined : "Выберите действие кнопками ниже.");
  };

  const requestInn = async ({ dialogId, event, transition }: DialogRouteContext): Promise<FlowReply> => {
    if (event.type === "edit_profile") await sessions.setPendingProfile(dialogId, undefined);
    if (transition.accepted && event.type === "start") return renderIntro();
    if (transition.accepted && transition.previousState === "menu") return renderSwitchCompany();
    return renderRequestInn(transition.accepted ? undefined : "Сейчас нужен ИНН компании.");
  };

  const recoverCurrent = async ({ dialogId, transition }: DialogRouteContext): Promise<FlowReply> => {
    // Из `loading_profile` сюда попадают, если поиск прервался между сообщениями (перезапуск бота).
    if (transition.previousState === "loading_profile") return override(renderLookupInterrupted(), "awaiting_inn");
    return menuOrWelcome(dialogId, "Это действие устарело. Выберите, что показать.");
  };

  const unrecognized: OnboardingFlow["unrecognized"] = async ({ dialogId, state }) => {
    switch (state) {
      case "idle":
        return renderWelcome("Нажмите «Ввести ИНН», чтобы начать.");
      case "awaiting_inn":
        return renderRequestInn("Это не похоже на ИНН.");
      case "loading_profile":
        return override(renderLookupInterrupted(), "awaiting_inn");
      case "confirming_profile": {
        const pending = await sessions.pendingProfile(dialogId);
        return pending === undefined
          ? staleProfile()
          : showCard(pending, "Ответьте кнопкой: подтвердите данные или введите другой ИНН.");
      }
      case "menu":
        return menuOrWelcome(dialogId, "Не понял сообщение. Выберите действие кнопками ниже.");
      default:
        return undefined;
    }
  };

  return {
    // «В начало» при уже сохранённой компании (отмена смены компании) возвращает в меню к ней.
    show_welcome: async ({ dialogId }) => {
      if ((await sessions.companyOf(dialogId)) === undefined) return renderWelcome();
      await sessions.setPendingProfile(dialogId, undefined);
      return override(renderMenu("Компания не изменилась."), "menu");
    },
    request_inn: requestInn,
    lookup_profile: lookupProfile,
    confirm_profile: confirmProfile,
    profile_not_found: () => renderProfileNotFound(),
    profile_lookup_failed: ({ event }) =>
      renderLookupFailed(event.type === "profile_lookup_failed" ? event.retryable : true),
    show_menu: showMenu,
    recover_current: recoverCurrent,
    reset_dialog: async ({ dialogId }) => {
      await sessions.setPendingProfile(dialogId, undefined);
      return renderWelcome("Прежний шаг диалога устарел, начнём сначала.");
    },
    unrecognized,
  };
};
