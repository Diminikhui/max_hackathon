// K-30b. Сборка диалога: событие MAX (K-22a) → машина и сценарии (K-24a/b/c, K-09, K-29) → ответ в чат.
// Здесь только связывание портов; сервисы профиля и перечня, хранилище и отправка передаются снаружи (точка
// сборки процесса — apps/worker/src/main.ts, потому что контур уведомлений живёт в worker, а worker видит бота).
import { createDialogRouter, DIALOG_STATES, type DialogEvent, type DialogState } from "../dialog/index.js";
import { type BotButton, type ChecklistSource, createChecklistFlow, type FlowReply } from "../flows/checklist/index.js";
import { type ClarifySkipStore, clarifyButton, createClarifyFlow, type FactDeclarer } from "../flows/clarify/index.js";
import {
  createDemoChangeFlow,
  DEMO_CHANGE_CALLBACK_PAYLOAD,
  type DemoChangeFlowDeps,
  demoChangeButton,
} from "../flows/demo/index.js";
import { createExamplesFlow, type ExampleCompany } from "../flows/examples/index.js";
import { createExplainFlow, explainButton, type LlmProvider } from "../flows/explain/index.js";
import {
  createOnboardingFlow,
  InMemoryOnboardingSessions,
  type OnboardingSessions,
  type ProfileGateway,
} from "../flows/onboarding/index.js";
import { createSettingsFlow, decodeSettingsPayload, type NotificationSettingsStore } from "../flows/settings/index.js";
import { encodeButtonPayload, type InboundHandler, type TransportLogger } from "../transport/index.js";
import { type ChatDirectory, DialogChatDirectory } from "./chat-directory.js";

/** Сообщение бота, отправленное в чат: по нему у сообщения потом снимаются кнопки. */
export interface SentMessage {
  readonly messageId: string;
  /** Текст нужен, чтобы при снятии кнопок MAX оставил его без изменений. */
  readonly text: string;
}

/** Как ответ сценария попадает в чат. Реализация — транспорт MAX (worker) или модельная в тестах. */
export interface BotReplyPort {
  /** Отправить новое сообщение внизу чата. `undefined` — MAX не вернул идентификатор, кнопки потом не снять. */
  send(chatId: string, reply: FlowReply): Promise<SentMessage | undefined>;
  /**
   * Убрать кнопки у прежнего сообщения бота, текст оставить (`PUT /messages`). Правило чата: кнопки активны только
   * у последнего сообщения бота, поэтому нажатие кнопки из старого сообщения невозможно. Сбой не критичен.
   */
  clearKeyboard?(chatId: string, message: SentMessage): Promise<void>;
  /** Подтвердить нажатие кнопки (`POST /answers`), чтобы клиент MAX не ждал ответа. Сбой не критичен. */
  acknowledge?(callbackId: string): Promise<void>;
}

/**
 * Хранение состояния машины диалога. Реализация на PostgreSQL (#312) — `PostgresBotDialogRepository`
 * из @max-hackathon/storage: после перезапуска процесса диалог продолжается с того же места.
 */
export interface DialogStateStore {
  /** Строка из хранилища; неизвестное значение (например, после переименования состояния) читается как `idle`. */
  stateOf(dialogId: string): Promise<string | undefined>;
  saveState(dialogId: string, state: DialogState): Promise<void>;
}

/** Хранение в памяти процесса: для тестов. После перезапуска диалог начнётся заново. */
export const createMemoryDialogStateStore = (): DialogStateStore => {
  const states = new Map<string, DialogState>();
  return {
    stateOf: async (dialogId) => states.get(dialogId),
    saveState: async (dialogId, state) => {
      states.set(dialogId, state);
    },
  };
};

const isDialogState = (value: string | undefined): value is DialogState =>
  value !== undefined && (DIALOG_STATES as readonly string[]).includes(value);

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
  /** Порты хранения ниже по умолчанию — в памяти процесса; сборка процесса передаёт PostgreSQL (#312). */
  readonly sessions?: OnboardingSessions;
  readonly states?: DialogStateStore;
  readonly skips?: ClarifySkipStore;
  /** Тот же экземпляр передаётся контуру уведомлений как `recipients`. */
  readonly directory?: ChatDirectory;
  /** Без демо кнопка «🧪 Показать пример изменения (модельное)» в меню не показывается. */
  readonly demo?: BotDemoDeps;
  /** 2-22, флаг `BOT_FEATURES=explain`: кнопка «💬 Простым языком» на карточке. Без зависимости кнопки нет. */
  readonly explain?: { readonly provider?: LlmProvider };
  /** Модельные профили K-28, доступные кнопками на шаге ввода ИНН. Без зависимости функция выключена. */
  readonly examples?: readonly ExampleCompany[];
}

export interface BotApp {
  readonly handle: InboundHandler;
  readonly directory: ChatDirectory;
  /** Сохранённое состояние диалога: для тестов и диагностики. */
  stateOf(dialogId: string): Promise<DialogState>;
}

const OPEN_REQUIREMENTS = encodeButtonPayload({ type: "open_requirements" });

const hasPayload = (buttons: readonly BotButton[], payload: string): boolean =>
  buttons.some((button) => "payload" in button && button.payload === payload);

const insertBeforeLast = (buttons: readonly BotButton[], button: BotButton): BotButton[] =>
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
  const states = deps.states ?? createMemoryDialogStateStore();
  const companyOf = (dialogId: string) => sessions.companyOf(dialogId);

  const { unrecognized, ...onboarding } = createOnboardingFlow({ profiles: deps.profiles, sessions });
  const checklistFlow = createChecklistFlow({
    checklist: deps.checklist,
    companyOf,
    ...(deps.explain ? { cardButtons: (item) => [explainButton(item.requirement.id)] } : {}),
  });
  const settingsFlow = createSettingsFlow({ settings: deps.settings, companyOf });
  const clarify = createClarifyFlow({
    checklist: deps.checklist,
    companyOf,
    profiles: deps.profiles,
    ...(deps.skips ? { skips: deps.skips } : {}),
  });
  // Демо-сценарий запоминает чат синхронно и не ждёт записи, поэтому чат привязывается в `callback` до нажатия.
  const demo = deps.demo
    ? createDemoChangeFlow({ ...deps.demo, checklist: deps.checklist, companyOf, recipients: { remember: () => {} } })
    : undefined;
  const explain = deps.explain
    ? createExplainFlow({ ...deps.explain, checklist: deps.checklist, companyOf, logger: deps.logger })
    : undefined;
  const examples = deps.examples ? createExamplesFlow(deps.examples) : undefined;
  const router = createDialogRouter<FlowReply>({ ...onboarding, ...checklistFlow, ...settingsFlow.handlers });

  const stateOf = async (dialogId: string): Promise<DialogState> => {
    const stored = await states.stateOf(dialogId);
    return isDialogState(stored) ? stored : "idle";
  };

  interface Outcome {
    readonly reply: FlowReply;
    readonly state: DialogState;
    readonly route?: string;
  }

  const dispatch = async (dialogId: string, state: DialogState, event: DialogEvent): Promise<Outcome> => {
    const { transition, result } = await router.dispatch({ dialogId, state, event });
    return { reply: result, state: result.stateOverride ?? transition.state, route: transition.route };
  };

  /** Кнопки вне машины диалога: уточнения `c:`, настройки `s:`, пересказ `explain:`, демо. `undefined` — payload не распознан. */
  const callback = async (
    dialogId: string,
    chatId: string,
    state: DialogState,
    payload: string,
  ): Promise<Outcome | undefined> => {
    if (examples && state === "awaiting_inn") {
      const event = examples.eventFor(payload);
      if (event) return dispatch(dialogId, state, event);
    }

    const clarified = await clarify.handle(dialogId, payload);
    if (clarified) return { reply: clarified, state: clarified.stateOverride ?? state };

    const action = decodeSettingsPayload(payload);
    if (action) {
      const { transition, result } = await settingsFlow.handleAction({ router, dialogId, action });
      return { reply: result, state: result.stateOverride ?? transition.state, route: transition.route };
    }

    const explained = explain ? await explain.handle(dialogId, payload) : undefined;
    if (explained) return { reply: explained, state: explained.stateOverride ?? state };

    if (demo && payload === DEMO_CHANGE_CALLBACK_PAYLOAD) {
      // Нажатие делает этот чат получателем push компании до прогона контура уведомлений.
      const companyId = await companyOf(dialogId);
      if (companyId !== undefined) await directory.track(chatId, companyId);
      const reply = await demo.handle({ dialogId, chatId });
      return { reply, state: reply.stateOverride ?? state };
    }
    return undefined;
  };

  /** Кнопки, которые сценарии сами не добавляют: демо в меню, уточнение под перечнем с «недостаточно данных». */
  const decorate = async (dialogId: string, outcome: Outcome): Promise<FlowReply> => {
    let { reply } = outcome;
    if (examples && outcome.state === "awaiting_inn") reply = examples.decorate(reply);
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

  /** Последнее сообщение бота в каждом чате, у которого ещё есть кнопки. */
  const withKeyboard = new Map<string, SentMessage>();

  const deliver = async (event: Parameters<InboundHandler>[0]["event"], reply: FlowReply): Promise<void> => {
    const { chatId } = event;
    const sent = await deps.reply.send(chatId, reply);

    // Новое сообщение внизу чата доставлено: у предыдущего кнопки больше не нужны.
    const previous = withKeyboard.get(chatId);
    if (sent !== undefined && reply.buttons.length > 0) withKeyboard.set(chatId, sent);
    else if (sent !== undefined) withKeyboard.delete(chatId);
    if (previous !== undefined && sent !== undefined && deps.reply.clearKeyboard) {
      try {
        await deps.reply.clearKeyboard(chatId, previous);
      } catch (error) {
        deps.logger.warn("bot.reply.clear_keyboard_failed", "Could not remove buttons of the previous message", {
          error,
        });
      }
    }

    if (event.kind === "callback" && deps.reply.acknowledge) {
      try {
        await deps.reply.acknowledge(event.callbackId);
      } catch (error) {
        deps.logger.warn("bot.reply.acknowledge_failed", "Could not acknowledge the button press", { error });
      }
    }
  };

  const handle: InboundHandler = async (delivery) => {
    const { event } = delivery;
    const dialogId = event.chatId;
    const state = await stateOf(dialogId);

    let outcome: Outcome;
    try {
      outcome = await respond(dialogId, state, delivery);
    } catch (error) {
      deps.logger.error("bot.dialog.failed", "Dialog handler failed", { kind: event.kind, state, error });
      await deliver(event, FAILURE_REPLY);
      return;
    }

    await states.saveState(dialogId, outcome.state);
    await directory.track(event.chatId, await companyOf(dialogId));
    await deliver(event, await decorate(dialogId, outcome));
  };

  return { handle, directory, stateOf };
};
