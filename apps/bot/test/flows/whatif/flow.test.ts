// Сценарии, компания и требования в тесте модельные; реальные профили не изменяются.
import { type ApplicabilityResult, CONTRACT_VERSION, type FactValue, type Requirement } from "@max-hackathon/domain";
import { describe, expect, it, vi } from "vitest";
import { createBotApp, createMemoryDialogStateStore } from "../../../src/app/index.js";
import type { FlowReply } from "../../../src/flows/checklist/index.js";
import { InMemoryOnboardingSessions } from "../../../src/flows/onboarding/index.js";
import { createMemorySettingsStore } from "../../../src/flows/settings/index.js";
import {
  createWhatIfFlow,
  encodeWhatIfPayload,
  type ScenarioDeltaOutcomeView,
  type ScenarioDeltaSource,
  WHATIF_SCENARIOS,
} from "../../../src/flows/whatif/index.js";
import type { InboundEvent, TransportLogger } from "../../../src/transport/index.js";
import { encodeButtonPayload, toDialogEvent } from "../../../src/transport/index.js";
import { createK28Services } from "../clarify/support/k28.js";

const NOW = "2026-09-29T10:00:00Z";
const COMPANY_ID = "model-company";
const SOURCE_URL = "https://example.invalid/model-requirement";

const requirement: Requirement = {
  contractVersion: CONTRACT_VERSION,
  id: "model:new-employer-duty",
  packId: "model-whatif",
  packVersion: 1,
  kind: "obligation",
  title: "Оформить первого работника",
  summary: "Модельная обязанность работодателя.",
  basis: [{ act: "Модельный акт", url: SOURCE_URL }],
  condition: { type: "has_employees", value: true },
  coverage: "full",
  source: { system: "model", retrievedAt: NOW, isModel: true },
};

const applicability = (status: ApplicabilityResult["status"]): ApplicabilityResult => ({
  contractVersion: CONTRACT_VERSION,
  companyId: COMPANY_ID,
  requirementId: requirement.id,
  packId: requirement.packId,
  packVersion: requirement.packVersion,
  status,
  explanation: [],
  evaluatedAt: NOW,
});

const emptyGroup = () => ({ appeared: [], disappeared: [], changed: [] });
const appearedOutcome = (): Extract<ScenarioDeltaOutcomeView, { status: "ok" }> => ({
  status: "ok",
  delta: {
    obligations: {
      appeared: [{ requirement, before: applicability("not_applies"), after: applicability("applies") }],
      disappeared: [],
      changed: [],
    },
    opportunities: emptyGroup(),
  },
});
const emptyOutcome = (): Extract<ScenarioDeltaOutcomeView, { status: "ok" }> => ({
  status: "ok",
  delta: { obligations: emptyGroup(), opportunities: emptyGroup() },
});

describe("flow «Что будет, если…»", () => {
  it("показывает четыре сценария на известных фактах", async () => {
    const delta: ScenarioDeltaSource = { compare: vi.fn(async () => emptyOutcome()) };
    const flow = createWhatIfFlow({ delta, companyOf: async () => COMPANY_ID });

    const reply = await flow.handle("chat", encodeWhatIfPayload({ type: "show_scenarios" }));

    expect(reply?.text).toContain("Сценарный расчёт — не ваши текущие данные");
    expect(reply?.buttons.map((button) => button.text)).toEqual([
      ...WHATIF_SCENARIOS.map(({ label }) => label),
      "🏠 Меню",
    ]);
  });

  it("показывает дельту, источник и обычную карточку появившейся обязанности", async () => {
    const compare = vi.fn(async (_companyId: string, _inputs: readonly { key: string; value: FactValue }[]) =>
      appearedOutcome(),
    );
    const flow = createWhatIfFlow({ delta: { compare }, companyOf: async () => COMPANY_ID });
    const scenario = WHATIF_SCENARIOS[0] as (typeof WHATIF_SCENARIOS)[number];

    const delta = await flow.handle("chat", encodeWhatIfPayload({ type: "run", scenarioId: scenario.id }));

    expect(compare).toHaveBeenCalledWith(COMPANY_ID, scenario.inputs);
    expect(delta?.text).toContain(`Если ${scenario.summary}: +1, −0, изменилось 0 обязанностей`);
    expect(delta?.text).toContain("Оформить первого работника");
    expect(delta?.text).toContain(SOURCE_URL);
    expect(delta?.sourceUrls).toEqual([SOURCE_URL]);
    expect(delta?.buttons.map((button) => button.text)).toEqual(["1", "← Сценарии", "🏠 Меню"]);

    const card = await flow.handle(
      "chat",
      encodeWhatIfPayload({ type: "card", scenarioId: scenario.id, requirementId: requirement.id }),
    );
    expect(card?.text).toContain("📋 Обязанность");
    expect(card?.text).toContain("Сценарный расчёт — не ваши текущие данные");
    expect(card?.text).toContain("Статус: Применяется");
    expect(card?.buttons.map((button) => button.text)).toEqual(["← Сценарии", "🏠 Меню"]);
  });

  it("пустую дельту объясняет как нормальный результат", async () => {
    const flow = createWhatIfFlow({
      delta: { compare: async () => emptyOutcome() },
      companyOf: async () => COMPANY_ID,
    });

    const reply = await flow.handle("chat", encodeWhatIfPayload({ type: "run", scenarioId: "sell-alcohol" }));

    expect(reply?.text).toContain("Изменений для текущего перечня нет");
    expect(reply?.buttons.map((button) => button.text)).toEqual(["← Сценарии", "🏠 Меню"]);
  });
});

const silent: TransportLogger = { info: () => {}, warn: () => {}, error: () => {} };

const setupApp = async (enabled: boolean) => {
  const chatId = enabled ? "chat-enabled" : "chat-disabled";
  const services = createK28Services();
  const sessions = new InMemoryOnboardingSessions();
  await sessions.bindCompany(chatId, COMPANY_ID);
  const states = createMemoryDialogStateStore();
  await states.saveState(chatId, "menu");
  const sent: FlowReply[] = [];
  const app = createBotApp({
    profiles: services.profiles,
    checklist: services.checklist,
    settings: createMemorySettingsStore(),
    sessions,
    states,
    logger: silent,
    reply: {
      send: async (_target, reply) => {
        sent.push(reply);
        return { messageId: `m${sent.length}`, text: reply.text };
      },
    },
    ...(enabled ? { whatif: { delta: { compare: async () => emptyOutcome() } } } : {}),
  });
  const receive = async (event: InboundEvent) => {
    await app.handle({ event, dialogEvent: toDialogEvent(event) });
    return sent.at(-1) as FlowReply;
  };
  return { app, chatId, receive };
};

describe("подключение whatif в приложение", () => {
  it("с флагом добавляет одну кнопку в меню и обрабатывает свой payload", async () => {
    const { chatId, receive } = await setupApp(true);
    const menu = await receive({
      kind: "callback",
      callbackId: "home",
      payload: encodeButtonPayload({ type: "home" }),
      eventId: "event-home",
      chatId,
      userId: "model-user",
      occurredAt: NOW,
    });
    expect(menu.buttons.filter(({ text }) => text === "🔮 Что будет, если…")).toHaveLength(1);

    const scenarios = await receive({
      kind: "callback",
      callbackId: "whatif",
      payload: encodeWhatIfPayload({ type: "show_scenarios" }),
      eventId: "event-whatif",
      chatId,
      userId: "model-user",
      occurredAt: NOW,
    });
    expect(scenarios.buttons.map(({ text }) => text)).toContain("👤 Найму первого работника");
  });

  it("без флага не показывает кнопку и не обрабатывает payload", async () => {
    const { app, chatId, receive } = await setupApp(false);
    const reply = await receive({
      kind: "callback",
      callbackId: "forged",
      payload: encodeWhatIfPayload({ type: "show_scenarios" }),
      eventId: "event-forged",
      chatId,
      userId: "model-user",
      occurredAt: NOW,
    });

    expect(await app.stateOf(chatId)).toBe("menu");
    expect(reply.text).toContain("Не понял сообщение");
    expect(reply.buttons.map(({ text }) => text)).not.toContain("🔮 Что будет, если…");
  });
});
