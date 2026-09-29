// K-30b. Сборка диалога: событие MAX (K-22a) → машина и сценарии (K-24a/b/c, K-09, K-29) → ответ в чат.
// Здесь только связывание портов; сервисы профиля и перечня, хранилище и отправка передаются снаружи (точка
// сборки процесса — apps/worker/src/main.ts, потому что контур уведомлений живёт в worker, а worker видит бота).
import type { NotificationButton } from "@max-hackathon/domain";
import { createDialogRouter, type DialogEvent, type DialogState } from "../dialog/index.js";
import { type ChecklistSource, createChecklistFlow, type FlowReply } from "../flows/checklist/index.js";
import { clarifyButton, createClarifyFlow, type FactDeclarer } from "../flows/clarify/index.js";
import {
  createDemoChangeFlow,
  DEMO_CHANGE_CALLBACK_PAYLOAD,
  type DemoChangeFlowDeps,
  demoChangeButton,
} from "../flows/demo/index.js";
import {
  createOnboardingFlow,
  InMemoryOnboardingSessions,
  type OnboardingSessions,
  type ProfileGateway,
} from "../flows/onboarding/index.js";
import { createSettingsFlow, decodeSettingsPayload, type NotificationSettingsStore } from "../flows/settings/index.js";
import { encodeButtonPayload, type InboundHandler, type TransportLogger } from "../transport/index.js";
import { DialogChatDirectory } from "./chat-directory.js";

/** Как ответ сценария попадает в чат. Реализация — транспорт MAX (worker) или модельная в тестах. */
export interface BotReplyPort {
  /** Отправить новое сообщение в чат. */
  send(chatId: string, reply: FlowReply): Promise<void>;
  /**
   * Ответить на нажатие кнопки, заменив нажатое сообщение (`POST /answers` с `message`). `false` — не получилось,
   * тогда ответ уходит новым сообщением. Не задан — ответы всегда новыми сообщениями.
   */
  answer?(callbackId: string, reply: FlowReply): Promise<boolean>;
}

/** Демо-триггер K-29 без портов, которые даёт сборка бота. */
export type BotDemoDeps = Omit<DemoChangeFlowDeps, "checklist" | "companyOf" | "recipients">;

export interface BotAppDeps {
  /** `ProfileService` K-25b: поиск по ИНН, подтверждение и заявленные факты. */
  readonly profiles: ProfileGateway & FactDeclarer;
  /** `ChecklistService` K-26. */
  readonly checklist: ChecklistSource;
  readonly settings: NotificationSettingsStore;
  readonly reply: BotReplyPort;
  readonly logger: TransportLogger;
  readonly sessions?: OnboardingSessions;
  /** Тот же экземпляр передаётся контуру уведомлений как `recipients`. */
  readonly directory?: DialogChatDirectory;
  /** Без демо кнопка «🧪 Показать пример изменения (модельное)» в меню не показывается. */
  readonly demo?: BotDemoDeps;
}

export interface BotApp {
  readonly handle: InboundHandler;
  readonly directory: DialogChatDirectory;
  /** Сохранённое состояние диалога: для тестов и диагностики. */
  stateOf(dialogId: string): DialogState;
}

const OPEN_REQUIREMENTS = encodeButtonPayload({ type: "open_requirements" });

const hasPayload = (buttons: readonly NotificationButton[], payload: string): boolean =>
  buttons.some((button) => "payload" in button && button.payload === payload);

const insertBeforeLast = (buttons: readonly NotificationButton[], button: NotificationButton): NotificationButton[] =>
  buttons.length === 0 ? [button] : [...buttons.slice(0, -1), button, ...buttons.slice(-1)];

const prefixText = (reply: FlowReply, line: string): FlowReply => ({ ...reply, text: `${line}\n\n${reply.text}` });

const FAILURE_REPLY: FlowReply = {
  text: "⚠️ Не получилось обработать сообщение. Попробуйте ещё раз или вернитесь в меню.",
  sourceUrls: [],
  automated: true,
  buttons: [{ text: "🏠 Меню", payload: encodeButtonPayload({ type: "home" }) }],
};

export const createBotApp = (deps: BotAppDeps): BotApp => {
  const sessions = deps.sessions ?? new InMemoryOnboardingSessions();
  const directory = deps.directory ?? new DialogChatDirectory();
  const companyOf = (dialogId: string) => sessions.companyOf(dialogId);

  const { unrecognized, ...onboarding } = createOnboardingFlow({ profiles: deps.profiles, sessions });
  const checklistFlow = createChecklistFlow({ checklist: deps.checklist, companyOf });
  const settingsFlow = createSettingsFlow({ settings: deps.settings, companyOf });
  const clarify = createClarifyFlow({ checklist: deps.checklist, companyOf, profiles: deps.profiles });
  const demo = deps.demo
    ? createDemoChangeFlow({ ...deps.demo, checklist: deps.checklist, companyOf, recipients: directory })
    : undefined;
  const router = createDialogRouter<FlowReply>({ ...onboarding, ...checklistFlow, ...settingsFlow.handlers });

  const states = new Map<string, DialogState>();
  const stateOf = (dialogId: string): DialogState => states.get(dialogId) ?? "idle";

  interface Outcome {
    readonly reply: FlowReply;
    readonly state: DialogState;
    readonly route?: string;
  }

  const dispatch = async (dialogId: string, state: DialogState, event: DialogEvent): Promise<Outcome> => {
    const { transition, result } = await router.dispatch({ dialogId, state, event });
    return { reply: result, state: result.stateOverride ?? transition.state, route: transition.route };
  };

  /** Кнопки вне машины диалога: уточнения `c:`, настройки `s:`, демо. `undefined` — payload не распознан. */
  const callback = async (
    dialogId: string,
    chatId: string,
    state: DialogState,
    payload: string,
  ): Promise<Outcome | undefined> => {
    const clarified = await clarify.handle(dialogId, payload);
    if (clarified) return { reply: clarified, state: clarified.stateOverride ?? state };

    const action = decodeSettingsPayload(payload);
    if (action) {
      const { transition, result } = await settingsFlow.handleAction({ router, dialogId, action });
      return { reply: result, state: result.stateOverride ?? transition.state, route: transition.route };
    }

    if (demo && payload === DEMO_CHANGE_CALLBACK_PAYLOAD) {
      const reply = await demo.handle({ dialogId, chatId });
      return { reply, state: reply.stateOverride ?? state };
    }
    return undefined;
  };

  /** Кнопки, которые сценарии сами не добавляют: демо в меню, уточнение под перечнем с «недостаточно данных». */
  const decorate = async (dialogId: string, outcome: Outcome): Promise<FlowReply> => {
    const { reply } = outcome;
    if (demo && outcome.state === "menu" && hasPayload(reply.buttons, OPEN_REQUIREMENTS)) {
      const button = demoChangeButton();
      if ("payload" in button && !hasPayload(reply.buttons, button.payload)) {
        return { ...reply, buttons: [...reply.buttons, button] };
      }
    }
    if (outcome.route === "show_requirement_list" && outcome.state === "requirement_list") {
      const button = clarifyButton();
      const companyId = await companyOf(dialogId);
      if (companyId !== undefined && "payload" in button && !hasPayload(reply.buttons, button.payload)) {
        const built = await deps.checklist.build(companyId);
        if (built.status === "ok" && built.checklist.statusCounts.insufficient_data > 0) {
          return { ...reply, buttons: insertBeforeLast(reply.buttons, button) };
        }
      }
    }
    return reply;
  };

  const respond = async (dialogId: string, state: DialogState, delivery: Parameters<InboundHandler>[0]) => {
    const { event, dialogEvent } = delivery;
    if (event.kind === "callback" && dialogEvent === undefined) {
      const handled = await callback(dialogId, event.chatId, state, event.payload);
      if (handled) return handled;
    }
    if (dialogEvent !== undefined) return dispatch(dialogId, state, dialogEvent);

    const answer = await unrecognized({ dialogId, state });
    if (answer) return { reply: answer, state: answer.stateOverride ?? state };
    // Текст на экране другого сценария или неизвестная кнопка: возвращаем в меню с подсказкой.
    const home = await dispatch(dialogId, state, { type: "home" });
    return { ...home, reply: prefixText(home.reply, "Не понял сообщение. Выберите действие кнопками.") };
  };

  const deliver = async (event: Parameters<InboundHandler>[0]["event"], reply: FlowReply): Promise<void> => {
    if (event.kind === "callback" && deps.reply.answer) {
      try {
        if (await deps.reply.answer(event.callbackId, reply)) return;
      } catch (error) {
        deps.logger.warn("bot.reply.answer_failed", "Callback answer failed, sending a new message", { error });
      }
    }
    await deps.reply.send(event.chatId, reply);
  };

  const handle: InboundHandler = async (delivery) => {
    const { event } = delivery;
    const dialogId = event.chatId;
    const state = stateOf(dialogId);

    let outcome: Outcome;
    try {
      outcome = await respond(dialogId, state, delivery);
    } catch (error) {
      deps.logger.error("bot.dialog.failed", "Dialog handler failed", { kind: event.kind, state, error });
      await deliver(event, FAILURE_REPLY);
      return;
    }

    states.set(dialogId, outcome.state);
    directory.track(event.chatId, await companyOf(dialogId));
    await deliver(event, await decorate(dialogId, outcome));
  };

  return { handle, directory, stateOf };
};
