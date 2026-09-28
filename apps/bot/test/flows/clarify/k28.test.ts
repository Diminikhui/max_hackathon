// Приёмка K-09: сценарий K-28 «кафе без данных о работниках и алкоголе» (модельный ИНН 1600000011).
import type { NotificationButton } from "@max-hackathon/domain";
import { describe, expect, it, vi } from "vitest";
import type { FlowReply } from "../../../src/flows/checklist/index.js";
import { clarifyButton, createClarifyFlow } from "../../../src/flows/clarify/index.js";
import { createK28Services } from "./support/k28.js";

const DIALOG = "dialog-kzn";
const KZN_INN = "1600000011";

const setup = async (inn = KZN_INN) => {
  const services = createK28Services();
  const companyId = await services.onboard(inn);
  const onDeclared = vi.fn(async () => {});
  const flow = createClarifyFlow({
    checklist: services.checklist,
    companyOf: async (dialogId) => (dialogId === DIALOG ? companyId : undefined),
    profiles: services.profiles,
    onDeclared,
  });
  const statuses = async () => {
    const outcome = await services.checklist.build(companyId);
    if (outcome.status !== "ok") throw new Error("перечень не построен");
    return Object.fromEntries(outcome.checklist.items.map((item) => [item.requirement.id, item.applicability.status]));
  };
  const press = async (reply: FlowReply, text: string): Promise<FlowReply> => {
    const button = reply.buttons.find((candidate) => candidate.text === text);
    if (button === undefined || !("payload" in button)) {
      throw new Error(`Нет кнопки «${text}»: ${reply.buttons.map((b) => b.text).join(", ")}`);
    }
    const next = await flow.handle(DIALOG, button.payload);
    if (next === undefined) throw new Error(`Кнопка «${text}» не относится к уточнению`);
    return next;
  };
  return { ...services, companyId, flow, onDeclared, statuses, press };
};

const start = (flow: ReturnType<typeof createClarifyFlow>) =>
  flow.handle(
    DIALOG,
    (clarifyButton() as Extract<NotificationButton, { payload: string }>).payload,
  ) as Promise<FlowReply>;

describe("K-09 на сценарии K-28: кафе в Казани без данных о работниках и алкоголе", () => {
  it("до ответов две записи «недостаточно данных»", async () => {
    const { statuses } = await setup();
    expect(await statuses()).toMatchObject({
      "k28.employer-duty": "insufficient_data",
      "k28.alcohol-accounting": "insufficient_data",
    });
  });

  it("задаёт ровно два вопроса и после ответов «да» и «пиво» обе записи применяются", async () => {
    const { flow, press, statuses, repository, companyId, onDeclared } = await setup();

    const first = await start(flow);
    expect(first.text).toContain("Есть ли у вас работники");
    expect(first.text).toContain("Обязанность работодателя общепита (модельная запись)");
    expect(first.text).toContain("Осталось вопросов: 2.");
    expect(first.text).toContain("МОДЕЛЬНЫЕ ДАННЫЕ");
    expect(first.text).toContain("Текст сформирован автоматически");
    expect(first.buttons.map((b) => b.text)).toEqual(["Да", "Нет", "Пропустить", "← К перечню", "🏠 Меню"]);
    expect(first.stateOverride).toBe("requirement_list");

    const second = await press(first, "Да");
    expect(second.text).toContain("Записали по вашим словам: есть работники.");
    expect(second.text).toContain(
      "• Обязанность работодателя общепита (модельная запись): Недостаточно данных → Применяется",
    );
    expect(second.text).toContain("Продаёте ли вы алкоголь?");
    expect(second.text).toContain("Это последний вопрос.");

    const done = await press(second, "Только пиво, сидр, медовуху");
    expect(done.text).toContain("Записали по вашим словам: продаёте пиво, сидр или медовуху.");
    expect(done.text).toContain("Учёт продажи алкоголя (модельная запись): Недостаточно данных → Применяется");
    expect(done.text).toContain("✅ Уточнение завершено: у всех записей есть итоговый статус.");
    expect(done.text).toContain("📋 Ваш перечень");
    expect(done.buttons.map((b) => b.text)).not.toContain("❔ Уточнить данные");
    expect(done.stateOverride).toBe("requirement_list");

    const result = await statuses();
    expect(result["k28.employer-duty"]).toBe("applies");
    expect(result["k28.alcohol-accounting"]).toBe("applies");
    expect(Object.values(result)).not.toContain("insufficient_data");

    const profile = await repository.get(companyId);
    const declared = profile?.facts.filter((fact) => fact.kind === "declared" && fact.source.system === "user");
    expect(declared?.map((fact) => [fact.key, fact.value])).toEqual([
      ["employment.has_employees", true],
      ["sales.alcohol", "beer"],
    ]);
    expect(declared?.every((fact) => fact.source.isModel)).toBe(true);
    expect(onDeclared.mock.calls).toEqual([
      [companyId, ["employment.has_employees"]],
      [companyId, ["sales.alcohol"]],
    ]);
  });

  it("ответы «нет» тоже дают итоговый статус: не применяется", async () => {
    const { flow, press, statuses } = await setup();
    const second = await press(await start(flow), "Нет");
    expect(second.text).toContain("Недостаточно данных → Не применяется");
    const done = await press(second, "Нет");
    expect(done.text).toContain("у всех записей есть итоговый статус");
    expect(await statuses()).toMatchObject({
      "k28.employer-duty": "not_applies",
      "k28.alcohol-accounting": "not_applies",
    });
  });

  it("пропуск вопроса не тупик: итог объясняет, что осталось, и кнопка возвращает к вопросу", async () => {
    const { flow, press, statuses } = await setup();
    const alcohol = await press(await start(flow), "Пропустить");
    expect(alcohol.text).toContain("Продаёте ли вы алкоголь?");
    expect(alcohol.text).not.toContain("Есть ли у вас работники");

    const partial = await press(alcohol, "Крепкий алкоголь");
    expect(partial.text).toContain("Без итогового статуса осталось записей: 1.");
    expect(partial.text).toContain("Нет ответа на вопросы: есть работники.");
    expect(partial.buttons.map((b) => b.text)).toContain("❔ Уточнить данные");
    expect(partial.buttons.at(-1)?.text).toBe("🏠 Меню");

    const again = await press(partial, "❔ Уточнить данные");
    expect(again.text).toContain("Есть ли у вас работники");
    const done = await press(again, "Да");
    expect(done.text).toContain("у всех записей есть итоговый статус");
    expect(await statuses()).toMatchObject({ "k28.employer-duty": "applies", "k28.alcohol-accounting": "applies" });
  });

  it("«← К перечню» посреди уточнения показывает перечень с кнопкой продолжить", async () => {
    const { flow, press } = await setup();
    const list = await press(await start(flow), "← К перечню");
    expect(list.text).toContain("📋 Ваш перечень");
    expect(list.text).toContain("Без итогового статуса осталось записей: 2.");
    expect(list.buttons.map((b) => b.text)).toContain("❔ Уточнить данные");
  });

  it("компании со всеми данными уточнять нечего", async () => {
    const { flow } = await setup("7700000016");
    const reply = await start(flow);
    expect(reply.text).toContain("у всех записей есть итоговый статус");
    expect(reply.buttons.map((b) => b.text)).not.toContain("❔ Уточнить данные");
  });
});
