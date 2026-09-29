import { describe, expect, it } from "vitest";
import type { ChecklistOutcomeView, ChecklistView } from "../../../src/flows/checklist/index.js";
import {
  createClarifyFlow,
  decodeClarifyPayload,
  encodeClarifyPayload,
  type FactDeclarer,
  planClarification,
} from "../../../src/flows/clarify/index.js";
import { modelChecklist, modelItems } from "../checklist/support/model-checklist.js";

const withMissing = (checklist: ChecklistView, missing: Readonly<Record<string, string[]>>): ChecklistView => ({
  ...checklist,
  items: checklist.items.map((item) => {
    const keys = missing[item.requirement.id];
    return keys ? { ...item, applicability: { ...item.applicability, missingFactKeys: keys } } : item;
  }),
});

const insufficient = (id: string, keys: string[]) => {
  const base = modelItems.find((item) => item.applicability.status === "insufficient_data");
  if (!base) throw new Error("в модельном перечне нет записи «недостаточно данных»");
  return {
    requirement: { ...base.requirement, id, title: `Запись ${id}` },
    applicability: { ...base.applicability, requirementId: id, missingFactKeys: keys },
  };
};

describe("payload уточнения", () => {
  it("кодирует и декодирует все действия", () => {
    for (const action of [
      { type: "start" },
      { type: "finish" },
      { type: "skip", key: "sales.alcohol" },
      { type: "answer", key: "employment.has_employees", option: 1 },
    ] as const) {
      expect(decodeClarifyPayload(encodeClarifyPayload(action))).toEqual(action);
    }
  });

  it("не принимает чужие и подделанные payload", () => {
    for (const payload of [
      "d:start",
      "coverage",
      "c:",
      "c:start:x",
      "c:answer:sales.alcohol",
      "c:answer:sales.alcohol:-1",
      "c:answer:sales.alcohol:1:2",
      "c:answer:Sales:1",
      "c:skip:alcohol",
      "c:delete",
    ]) {
      expect(decodeClarifyPayload(payload), payload).toBeUndefined();
    }
  });

  it("не кодирует некорректный ключ", () => {
    expect(() => encodeClarifyPayload({ type: "skip", key: "a:b" })).toThrow();
  });
});

describe("planClarification", () => {
  it("спрашивает только о недостающих фактах записей «недостаточно данных», сначала о самых нужных", () => {
    const checklist = modelChecklist([
      ...modelItems.filter((item) => item.applicability.status !== "insufficient_data"),
      insufficient("x1", ["sales.alcohol"]),
      insufficient("x2", ["employment.has_employees", "sales.alcohol"]),
      insufficient("x3", ["location.region_code"]),
    ]);
    const plan = planClarification(checklist);
    expect(plan.blocked.map((item) => item.requirement.id)).toEqual(["x1", "x2", "x3"]);
    expect(plan.questions.map((question) => question.key)).toEqual(["sales.alcohol", "employment.has_employees"]);
    expect(plan.unaskedKeys).toEqual(["location.region_code"]);
    expect(planClarification(checklist, new Set(["sales.alcohol"])).questions.map((q) => q.key)).toEqual([
      "employment.has_employees",
    ]);
  });

  it("не спрашивает о фактах записей с другими статусами", () => {
    const withoutInsufficient = modelItems.filter((item) => item.applicability.status !== "insufficient_data");
    const checklist = withMissing(modelChecklist(withoutInsufficient), { "a-review-1": ["sales.alcohol"] });
    expect(planClarification(checklist).questions).toEqual([]);
  });
});

describe("createClarifyFlow: нештатные случаи", () => {
  const ok = (checklist: ChecklistView): ChecklistOutcomeView => ({
    status: "ok",
    profile: { isModel: true },
    checklist,
  });
  const blockedChecklist = modelChecklist([
    insufficient("x1", ["sales.alcohol"]),
    insufficient("x2", ["location.region_code"]),
  ]);
  const setup = (declarer: FactDeclarer, options: { readonly company?: boolean } = {}) =>
    createClarifyFlow({
      checklist: { build: async () => ok(blockedChecklist) },
      companyOf: async () => (options.company === false ? undefined : "model-cafe"),
      profiles: declarer,
    });
  const noDeclare: FactDeclarer = {
    declare: async () => {
      throw new Error("не должен вызываться");
    },
  };

  it("чужой payload не обрабатывает", async () => {
    expect(await setup(noDeclare).handle("d1", "d:home")).toBeUndefined();
  });

  it("без компании предлагает ввести ИНН", async () => {
    const reply = await setup(noDeclare, { company: false }).run("d1", { type: "start" });
    expect(reply.text).toContain("сначала укажите ИНН");
    expect(reply.stateOverride).toBe("idle");
  });

  it("устаревшая кнопка ответа не сохраняет ничего и показывает актуальный вопрос", async () => {
    const reply = await setup(noDeclare).run("d1", { type: "answer", key: "sales.alcohol", option: 9 });
    expect(reply.text).toContain("Эта кнопка устарела");
    expect(reply.text).toContain("Продаёте ли вы алкоголь?");
  });

  it("ошибка сохранения — объяснение и тот же вопрос", async () => {
    const flow = setup({ declare: async () => ({ status: "invalid_value", message: "Недопустимое значение." }) });
    const reply = await flow.run("d1", { type: "answer", key: "sales.alcohol", option: 0 });
    expect(reply.text).toContain("Не удалось сохранить ответ: Недопустимое значение.");
    expect(reply.text).toContain("Продаёте ли вы алкоголь?");
  });

  it("профиль удалён — предлагает ввести ИНН", async () => {
    const flow = setup({ declare: async () => ({ status: "company_not_found", message: "нет" }) });
    const reply = await flow.run("d1", { type: "answer", key: "sales.alcohol", option: 0 });
    expect(reply.stateOverride).toBe("idle");
  });

  it("о фактах реестра не спрашивает, а объясняет в итоге", async () => {
    const flow = setup(noDeclare);
    const reply = await flow.run("d1", { type: "skip", key: "sales.alcohol" });
    expect(reply.text).toContain("Без итогового статуса осталось записей: 2.");
    expect(reply.text).toContain("Бот не спрашивает в диалоге: регион.");
    expect(reply.text).toContain("Нет ответа на вопросы: продажа алкоголя.");
  });

  it("под каждым вопросом есть выход к перечню и в меню", async () => {
    const reply = await setup(noDeclare).run("d1", { type: "start" });
    const texts = reply.buttons.map((button) => button.text);
    expect(texts).toEqual(expect.arrayContaining(["Пропустить", "← К перечню", "🏠 Меню"]));
  });
});
