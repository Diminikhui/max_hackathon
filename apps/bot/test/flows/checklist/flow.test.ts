import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createDialogRouter,
  DIALOG_ROUTES,
  type DialogEvent,
  type DialogRouteHandlers,
} from "../../../src/dialog/index.js";
import { type ChecklistOutcomeView, createChecklistFlow, type FlowReply } from "../../../src/flows/checklist/index.js";
import { modelChecklist, modelItems, okOutcome } from "./support/model-checklist.js";

const stub = (route: string): FlowReply => ({ text: route, sourceUrls: [], automated: true, buttons: [] });

const setup = (options: { companyId?: string; outcome?: ChecklistOutcomeView } = {}) => {
  const builds: string[] = [];
  const flow = createChecklistFlow({
    companyOf: async () => options.companyId,
    checklist: {
      build: async (companyId) => {
        builds.push(companyId);
        return options.outcome ?? okOutcome();
      },
    },
  });
  const handlers = {
    ...Object.fromEntries(DIALOG_ROUTES.map((route) => [route, () => stub(route)])),
    ...flow,
  } as DialogRouteHandlers<FlowReply>;
  const router = createDialogRouter(handlers);
  const send = (state: string, event: DialogEvent) => router.dispatch({ dialogId: "dialog-1", state, event });
  return { send, builds };
};

describe("сценарий перечня K-24b через машину диалога K-22b", () => {
  it("меню → перечень → карточка → назад к перечню", async () => {
    const { send, builds } = setup({ companyId: "model-cafe" });

    const list = await send("menu", { type: "open_requirements" });
    assert.equal(list.transition.state, "requirement_list");
    assert.ok(list.result.text.includes("1. Уведомить о начале деятельности"));

    const card = await send("requirement_list", { type: "select_requirement", requirementId: "a-review-1" });
    assert.equal(card.transition.state, "requirement_details");
    assert.ok(card.result.text.includes("Статус: Требуется проверка"));
    assert.equal(card.result.stateOverride, undefined);

    const back = await send("requirement_details", { type: "back" });
    assert.equal(back.transition.route, "show_requirement_list");
    assert.ok(back.result.text.includes("📋 Ваш перечень"));

    assert.deepEqual(builds, ["model-cafe", "model-cafe", "model-cafe"]);
  });

  it("открывает карточку и записи со статусом «Не применяется»", async () => {
    const { send } = setup({ companyId: "model-cafe" });
    const card = await send("requirement_list", { type: "select_requirement", requirementId: "a-not-1" });
    assert.ok(card.result.text.includes("Статус: Не применяется"));
  });

  it("на кнопку из старого сообщения показывает актуальный перечень и оставляет диалог в перечне", async () => {
    const { send } = setup({ companyId: "model-cafe", outcome: okOutcome(modelChecklist(modelItems.slice(0, 2))) });
    const reply = await send("requirement_list", { type: "select_requirement", requirementId: "a-review-1" });

    assert.ok(reply.result.text.includes("Этой записи больше нет в перечне"));
    assert.equal(reply.result.stateOverride, "requirement_list");
  });

  it("без компании в диалоге предлагает ввести ИНН и сбрасывает диалог", async () => {
    const { send, builds } = setup();
    const reply = await send("menu", { type: "open_requirements" });

    assert.ok(reply.result.text.includes("сначала укажите ИНН"));
    assert.equal(reply.result.stateOverride, "idle");
    assert.deepEqual(builds, []);
  });

  it("если профиль компании не найден, тоже предлагает ввести ИНН", async () => {
    const { send } = setup({ companyId: "gone", outcome: { status: "profile_not_found" } });
    const reply = await send("requirement_list", { type: "select_requirement", requirementId: "a-applies-1" });

    assert.ok(reply.result.text.includes("сначала укажите ИНН"));
    assert.equal(reply.result.stateOverride, "idle");
  });
});
