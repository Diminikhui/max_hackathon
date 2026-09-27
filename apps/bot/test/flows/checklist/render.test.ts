import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { renderRequirementCard, renderRequirementList } from "../../../src/flows/checklist/index.js";
import { MAX_TEXT_LENGTH } from "../../../src/messages/index.js";
import { decodeButtonPayload } from "../../../src/transport/index.js";
import { modelChecklist, modelItems } from "./support/model-checklist.js";

const payloadOf = (button: { payload?: string; url?: string } | undefined) =>
  button && "payload" in button && button.payload !== undefined ? decodeButtonPayload(button.payload) : undefined;

describe("renderRequirementList", () => {
  const reply = renderRequirementList(modelChecklist(), { profileIsModel: true });

  it("показывает счётчики всех пяти статусов", () => {
    for (const line of [
      "✅ Применяется: 2",
      "❔ Недостаточно данных: 1",
      "⚠️ Требуется проверка: 1",
      "⬜ Вне покрытия системы: 1",
      "➖ Не применяется: 1",
    ]) {
      assert.ok(reply.text.includes(line), line);
    }
  });

  it("нумерует записи по разделам и не перечисляет «Не применяется»", () => {
    const expectedOrder = [
      "1. Уведомить о начале деятельности",
      "2. Медицинские книжки работников",
      "3. Лицензия на продажу алкоголя",
      "4. Разработать программу производственного контроля",
      "5. Региональные требования Москвы",
    ];
    const positions = expectedOrder.map((line) => reply.text.indexOf(line));
    assert.ok(
      positions.every((position) => position >= 0),
      reply.text,
    );
    assert.deepEqual(
      [...positions].sort((a, b) => a - b),
      positions,
    );
    assert.equal(reply.text.includes("Лицензия на ремонт автомобилей"), false);
  });

  it("даёт кнопку-номер на каждую запись и кнопку меню", () => {
    assert.deepEqual(
      reply.buttons.map((button) => button.text),
      ["1", "2", "3", "4", "5", "🏠 Меню"],
    );
    assert.deepEqual(payloadOf(reply.buttons[0]), { type: "select_requirement", requirementId: "a-applies-1" });
    assert.deepEqual(payloadOf(reply.buttons[4]), { type: "select_requirement", requirementId: "a-out-1" });
    assert.deepEqual(payloadOf(reply.buttons.at(-1)), { type: "home" });
  });

  it("показывает дату расчёта, версию пакета и пометки модельных данных и автоматической обработки", () => {
    assert.ok(reply.text.includes("Расчёт на 27.09.2026. Пакеты правил: model-foodservice v3."));
    assert.ok(reply.text.startsWith("📋 Ваш перечень · МОДЕЛЬНЫЕ ДАННЫЕ"));
    assert.ok(reply.text.includes("Текст сформирован автоматически"));
    assert.equal(reply.automated, true);
  });

  it("без записей для показа объясняет, что касающихся компании записей нет", () => {
    const empty = renderRequirementList(modelChecklist(modelItems.slice(0, 1)), { profileIsModel: false });
    assert.ok(empty.text.includes("Записей, которые касаются компании или требуют уточнения, нет."));
    assert.deepEqual(
      empty.buttons.map((button) => button.text),
      ["🏠 Меню"],
    );
  });

  it("на длинном перечне показывает столько записей, сколько помещается, и даёт кнопку каждой показанной", () => {
    const many = Array.from({ length: 300 }, (_, index) => ({
      ...modelItems[1]!,
      requirement: {
        ...modelItems[1]!.requirement,
        id: `r-${index}`,
        title: `Длинное требование номер ${index} `.repeat(3),
      },
    }));
    const long = renderRequirementList(modelChecklist(many), { profileIsModel: true });
    const itemButtons = long.buttons.slice(0, -1);

    assert.ok(long.text.length <= MAX_TEXT_LENGTH);
    assert.ok(itemButtons.length > 0 && itemButtons.length < 300);
    assert.ok(long.text.includes(`Показаны ${itemButtons.length} из 300 записей`));
    assert.ok(long.text.includes("Расчёт на 27.09.2026"), "подвал не обрезан");
    assert.ok(long.text.includes(`${itemButtons.length}. Длинное требование`));
    assert.equal(long.text.includes(`${itemButtons.length + 1}. Длинное требование`), false);
    assert.deepEqual(payloadOf(itemButtons.at(-1)), {
      type: "select_requirement",
      requirementId: `r-${itemButtons.length - 1}`,
    });
  });

  it("не даёт больше 200 кнопок записей, даже если текст помещается", () => {
    const many = Array.from({ length: 250 }, (_, index) => ({
      ...modelItems[1]!,
      requirement: { ...modelItems[1]!.requirement, id: `s-${index}`, title: "К" },
    }));
    const reply = renderRequirementList(modelChecklist(many), { profileIsModel: false });
    const shown = reply.buttons.length - 1;
    assert.ok(shown <= 200);
    assert.ok(reply.text.includes(`Показаны ${shown} из 250 записей`));
    assert.equal(reply.text.includes(`${shown + 1}. К`), false);
  });
});

describe("renderRequirementCard", () => {
  it("показывает статус, причину, срок, дату проверки, первоисточник и навигацию", () => {
    const card = renderRequirementCard(modelItems[3]!);
    for (const line of [
      "Лицензия на продажу алкоголя",
      "Статус: Недостаточно данных",
      "Почему: Неизвестно, продаёте ли вы алкоголь",
      "Срок: до начала работы",
      "Проверено: 27.09.2026, 12:00 (МСК)",
      "Первоисточник:",
      "https://pravo.gov.ru/model/a-insufficient-1",
    ]) {
      assert.ok(card.text.includes(line), line);
    }
    assert.deepEqual(card.sourceUrls, ["https://pravo.gov.ru/model/a-insufficient-1"]);
    assert.deepEqual(
      card.buttons.map((button) => [button.text, payloadOf(button)]),
      [
        ["← К перечню", { type: "back" }],
        ["🏠 Меню", { type: "home" }],
      ],
    );
  });

  it("открывается для записи любого из пяти статусов", () => {
    for (const entry of modelItems) {
      assert.ok(renderRequirementCard(entry).text.includes(entry.requirement.title));
    }
  });
});
