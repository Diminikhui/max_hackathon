// Тестовый диалог: вход MAX (K-22a) → событие машины (K-22b) → обработчики сценариев → сохранение состояния.
// Кнопки нажимаются по тексту из последнего ответа, поэтому тест проходит ровно тот путь, что пользователь.
import assert from "node:assert/strict";
import {
  allowedDialogEvents,
  createDialogRouter,
  DIALOG_ROUTES,
  type DialogRouteHandlers,
  type DialogState,
} from "../../../../src/dialog/index.js";
import { createChecklistFlow, type FlowReply } from "../../../../src/flows/checklist/index.js";
import {
  createOnboardingFlow,
  InMemoryOnboardingSessions,
  type ProfileGateway,
} from "../../../../src/flows/onboarding/index.js";
import {
  decodeButtonPayload,
  type InboundEvent,
  type TransportLogger,
  toDialogEvent,
} from "../../../../src/transport/index.js";
import { okOutcome } from "../../checklist/support/model-checklist.js";

const DIALOG_ID = "chat-1";

const stub = (route: string): FlowReply => ({ text: `stub:${route}`, sourceUrls: [], automated: true, buttons: [] });

/**
 * Ответ сценария не тупиковый: в нём есть кнопки, и каждая ведёт к событию, которое машина примет в новом состоянии.
 * Заглушки чужих сценариев (K-24c) не проверяются.
 */
const assertNoDeadEnd = (state: string, reply: FlowReply): void => {
  if (reply.text.startsWith("stub:")) return;
  assert.ok(reply.buttons.length > 0, `ответ без кнопок в состоянии ${state}:\n${reply.text}`);
  const allowed = allowedDialogEvents(state as DialogState);
  for (const button of reply.buttons) {
    // Кнопка-ссылка открывает первоисточник и диалог не двигает.
    if (!("payload" in button)) continue;
    const event = decodeButtonPayload(button.payload);
    assert.ok(event, `кнопка «${button.text}» не декодируется`);
    assert.ok(allowed.includes(event.type), `кнопка «${button.text}» (${event.type}) не работает в состоянии ${state}`);
  }
};

export const createTestDialog = (profiles: ProfileGateway, initialState: string = "idle", logger?: TransportLogger) => {
  const sessions = new InMemoryOnboardingSessions();
  const { unrecognized, ...onboarding } = createOnboardingFlow({ profiles, sessions, ...(logger ? { logger } : {}) });
  const checklist = createChecklistFlow({
    companyOf: (dialogId) => sessions.companyOf(dialogId),
    checklist: { build: async () => okOutcome() },
  });
  const router = createDialogRouter({
    ...Object.fromEntries(DIALOG_ROUTES.map((route) => [route, () => stub(route)])),
    ...onboarding,
    ...checklist,
  } as DialogRouteHandlers<FlowReply>);

  let state: string = initialState;
  let last: FlowReply | undefined;
  let counter = 0;
  const base = () => ({
    eventId: `e${++counter}`,
    chatId: DIALOG_ID,
    userId: "user-1",
    occurredAt: "2026-09-28T10:00:00Z",
  });

  const receive = async (event: InboundEvent): Promise<FlowReply> => {
    const dialogEvent = toDialogEvent(event);
    let reply: FlowReply;
    if (dialogEvent === undefined) {
      const answer = await unrecognized({ dialogId: DIALOG_ID, state });
      assert.ok(answer, `нет ответа на нераспознанный ввод в состоянии ${state}`);
      reply = answer;
      state = reply.stateOverride ?? state;
    } else {
      const { transition, result } = await router.dispatch({ dialogId: DIALOG_ID, state, event: dialogEvent });
      reply = result;
      state = result.stateOverride ?? transition.state;
    }
    assertNoDeadEnd(state, reply);
    last = reply;
    return reply;
  };

  const callback = (payload: string) => receive({ kind: "callback", callbackId: `cb${counter}`, payload, ...base() });

  return {
    sessions,
    get state(): DialogState {
      return state as DialogState;
    },
    get last(): FlowReply | undefined {
      return last;
    },
    start: () => receive({ kind: "started", ...base() }),
    type: (text: string) => receive({ kind: "text", text, ...base() }),
    /** Нажимает кнопку из последнего ответа; падает, если такой кнопки нет. */
    press: (text: string) => {
      const button = last?.buttons.find((candidate) => candidate.text === text);
      assert.ok(button && "payload" in button, `нет кнопки «${text}» в ответе:\n${last?.text}`);
      return callback(button.payload);
    },
    /** Нажатие кнопки из старого сообщения. */
    callback,
  };
};
