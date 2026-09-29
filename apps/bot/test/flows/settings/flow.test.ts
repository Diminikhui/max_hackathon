// Тесты сценария настроек уведомлений (K-24c). Компании и ИНН модельные (K-28).
import assert from "node:assert/strict";
import { CONTRACT_VERSION, type NotificationCandidate, type NotificationReason } from "@max-hackathon/domain";
import { describe, it } from "vitest";

// Политика частоты K-20b из worker: проверяем, что сохранённое в боте отключение действительно подавляет отправку.
import { decide } from "../../../../worker/src/planner/policy/index.js";
import {
  createDialogRouter,
  DIALOG_ROUTES,
  type DialogEvent,
  type DialogRouteHandlers,
} from "../../../src/dialog/index.js";
import {
  applySettingsAction,
  createMemorySettingsStore,
  createSettingsFlow,
  decodeSettingsPayload,
  encodeSettingsPayload,
  type FlowReply,
  type NotificationSettingsStore,
  SETTINGS_ACTIONS,
} from "../../../src/flows/settings/index.js";
import { decodeButtonPayload, MAX_CALLBACK_PAYLOAD_LENGTH } from "../../../src/transport/index.js";

const COMPANY = "model-company-7700000016";

const stub = (route: string): FlowReply => ({ text: route, sourceUrls: [], automated: true, buttons: [] });

const setup = (options: { companyId?: string | undefined; store?: NotificationSettingsStore } = {}) => {
  const store = options.store ?? createMemorySettingsStore();
  const companyId = "companyId" in options ? options.companyId : COMPANY;
  const flow = createSettingsFlow({ settings: store, companyOf: async () => companyId });
  const handlers = {
    ...Object.fromEntries(DIALOG_ROUTES.map((route) => [route, () => stub(route)])),
    ...flow.handlers,
  } as DialogRouteHandlers<FlowReply>;
  const router = createDialogRouter(handlers);
  const send = (state: string, event: DialogEvent) => router.dispatch({ dialogId: "dialog-1", state, event });
  /** Нажатие кнопки так, как его передаст сборка контура: payload → действие → `handleAction`. */
  const press = (payload: string) => {
    const action = decodeSettingsPayload(payload);
    assert.ok(action, `payload ${payload} не распознан`);
    return flow.handleAction({ router, dialogId: "dialog-1", action });
  };
  const button = (reply: FlowReply, text: string): string => {
    const found = reply.buttons.find((candidate) => candidate.text.includes(text));
    assert.ok(found && "payload" in found, `нет кнопки «${text}»`);
    return found.payload;
  };
  return { store, send, press, button };
};

let sequence = 0;
const candidate = (reason: NotificationReason): NotificationCandidate => {
  sequence += 1;
  const early = reason === "early_signal";
  return {
    contractVersion: CONTRACT_VERSION,
    id: `model-candidate-${sequence}`,
    companyId: COMPANY,
    changeEventId: "model-event-1",
    reason,
    ...(early ? {} : { requirementId: `model-req-${sequence}`, previousStatus: "not_applies" as const }),
    newStatus: early ? "needs_review" : "applies",
    matchedFactKeys: ["okved.main"],
    dedupKey: `${reason}:${sequence}`,
    isModel: true,
    createdAt: "2026-09-25T09:00:00Z",
  };
};

describe("сценарий настроек K-24c через машину диалога K-22b", () => {
  it("меню → настройки показывает значения по умолчанию: всё включено", async () => {
    const { send } = setup();
    const reply = await send("menu", { type: "open_notification_settings" });

    assert.equal(reply.transition.state, "notification_settings");
    assert.ok(reply.result.text.includes("Уведомления: включены"));
    assert.ok(reply.result.text.includes("Ранние сигналы: включены"));
    assert.deepEqual(
      reply.result.buttons.map((b) => b.text),
      ["🔕 Отключить уведомления", "Отключить ранние сигналы", "🏠 Меню"],
    );
  });

  it("кнопка «Отключить уведомления» сохраняет отключение и возвращает в меню", async () => {
    const { store, send, press, button } = setup();
    const screen = await send("menu", { type: "open_notification_settings" });

    const saved = await press(button(screen.result, "Отключить уведомления"));
    assert.equal(saved.transition.route, "notification_settings_saved");
    assert.equal(saved.transition.state, "menu");
    assert.equal(saved.result.stateOverride, undefined);
    assert.ok(saved.result.text.includes("🔕 Уведомления отключены."));
    assert.deepEqual(await store.settingsFor(COMPANY), { enabled: false, earlySignals: true });

    const again = await send("menu", { type: "open_notification_settings" });
    assert.ok(again.result.text.includes("Уведомления: выключены"));
    assert.ok(!again.result.text.includes("Ранние сигналы"));
    assert.deepEqual(
      again.result.buttons.map((b) => b.text),
      ["🔔 Включить уведомления", "🏠 Меню"],
    );
  });

  it("отключение действует: политика K-20b подавляет все причины, включая важные", async () => {
    const { store, send, press, button } = setup();
    const screen = await send("menu", { type: "open_notification_settings" });
    await press(button(screen.result, "Отключить уведомления"));

    const settings = await store.settingsFor(COMPANY);
    for (const reason of ["became_applicable", "no_longer_applicable", "status_changed", "early_signal"] as const) {
      assert.deepEqual(decide(candidate(reason), { isDuplicate: false, sentThisMonth: 0, settings, relevance: 1 }), {
        action: "suppress",
        code: "notifications_disabled",
        countsTowardLimit: false,
      });
    }
  });

  it("повторное включение возвращает отправку", async () => {
    const { store, send, press, button } = setup({
      store: createMemorySettingsStore([[COMPANY, { enabled: false, earlySignals: true }]]),
    });
    const screen = await send("menu", { type: "open_notification_settings" });
    await press(button(screen.result, "Включить уведомления"));

    const settings = await store.settingsFor(COMPANY);
    assert.deepEqual(settings, { enabled: true, earlySignals: true });
    assert.equal(
      decide(candidate("became_applicable"), { isDuplicate: false, sentThisMonth: 0, settings }).action,
      "send",
    );
  });

  it("отключение ранних сигналов подавляет только ранние сигналы", async () => {
    const { store, send, press, button } = setup();
    const screen = await send("menu", { type: "open_notification_settings" });
    const saved = await press(button(screen.result, "Отключить ранние сигналы"));
    assert.ok(saved.result.text.includes("Ранние сигналы: выключены"));

    const settings = await store.settingsFor(COMPANY);
    assert.equal(
      decide(candidate("early_signal"), { isDuplicate: false, sentThisMonth: 0, settings, relevance: 1 }).code,
      "early_signals_disabled",
    );
    assert.equal(
      decide(candidate("became_applicable"), { isDuplicate: false, sentThisMonth: 0, settings }).action,
      "send",
    );

    const back = await send("menu", { type: "open_notification_settings" });
    assert.ok(back.result.buttons.some((b) => b.text === "Включить ранние сигналы"));
  });

  it("кнопка из старого сообщения срабатывает в любом состоянии диалога", async () => {
    const { store, press } = setup();
    // Сборка контура не передаёт текущее состояние: сохранение всегда проводится из экрана настроек.
    const saved = await press(encodeSettingsPayload("disable_all"));
    assert.equal(saved.transition.accepted, true);
    assert.equal(saved.transition.state, "menu");
    assert.deepEqual(await store.settingsFor(COMPANY), { enabled: false, earlySignals: true });
  });

  it("без компании в диалоге предлагает ввести ИНН и ничего не сохраняет", async () => {
    const saves: string[] = [];
    const inner = createMemorySettingsStore();
    const store: NotificationSettingsStore = {
      settingsFor: inner.settingsFor,
      save: async (companyId, value) => {
        saves.push(companyId);
        await inner.save(companyId, value);
      },
    };
    const { send, press } = setup({ companyId: undefined, store });

    const screen = await send("menu", { type: "open_notification_settings" });
    assert.ok(screen.result.text.includes("сначала укажите ИНН"));
    assert.equal(screen.result.stateOverride, "idle");

    const saved = await press(encodeSettingsPayload("disable_all"));
    assert.equal(saved.result.stateOverride, "idle");
    assert.deepEqual(saves, []);
  });

  it("«🏠 Меню» и «назад» с экрана настроек ведут в меню", async () => {
    const { send } = setup();
    assert.equal((await send("notification_settings", { type: "home" })).transition.state, "menu");
    assert.equal((await send("notification_settings", { type: "back" })).transition.state, "menu");
  });

  it("пометка об автоматической обработке и лимит длины сообщения соблюдены", async () => {
    const { send } = setup();
    const reply = await send("menu", { type: "open_notification_settings" });
    assert.equal(reply.result.automated, true);
    assert.ok(reply.result.text.includes("ℹ️"));
    assert.ok(reply.result.text.length <= 4000);
  });
});

describe("кнопки настроек", () => {
  it("payload кодируется и декодируется для каждого действия", () => {
    for (const action of SETTINGS_ACTIONS) {
      const payload = encodeSettingsPayload(action);
      assert.ok(payload.length <= MAX_CALLBACK_PAYLOAD_LENGTH);
      assert.equal(decodeSettingsPayload(payload), action);
      // Транспорт K-22a не принимает такую кнопку как событие машины диалога.
      assert.equal(decodeButtonPayload(payload), undefined);
    }
  });

  it("чужой или испорченный payload не распознаётся", () => {
    for (const payload of ["", "s:", "s:drop_all", "d:home", "s:disable_all:x", "disable_all"]) {
      assert.equal(decodeSettingsPayload(payload), undefined, payload);
    }
  });

  it("действия задают итоговое значение, повтор ничего не меняет", () => {
    assert.deepEqual(applySettingsAction(undefined, "disable_all"), { enabled: false, earlySignals: true });
    assert.deepEqual(applySettingsAction({ enabled: false, earlySignals: true }, "disable_all"), {
      enabled: false,
      earlySignals: true,
    });
    assert.deepEqual(applySettingsAction({ enabled: false, earlySignals: false }, "enable_all"), {
      enabled: true,
      earlySignals: false,
    });
    assert.deepEqual(applySettingsAction(undefined, "disable_early"), { enabled: true, earlySignals: false });
    assert.deepEqual(applySettingsAction({ enabled: true, earlySignals: false }, "enable_early"), {
      enabled: true,
      earlySignals: true,
    });
  });

  it("хранилище в памяти возвращает копию: снаружи настройки не изменить", async () => {
    const store = createMemorySettingsStore();
    await store.save(COMPANY, { enabled: false, earlySignals: false });
    const read = (await store.settingsFor(COMPANY)) as { enabled: boolean };
    read.enabled = true;
    assert.deepEqual(await store.settingsFor(COMPANY), { enabled: false, earlySignals: false });
  });
});
