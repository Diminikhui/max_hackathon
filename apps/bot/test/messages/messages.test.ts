import { describe, expect, it } from "vitest";
import { MAX_TEXT_LENGTH, renderObligationCard, renderRequirementDelta } from "../../src/messages/index.js";

const modelRequirement = {
  kind: "obligation" as const,
  title: "Передавать сведения о маркированной воде",
  summary: "Фиксировать выбытие упакованной воды через кассу.",
  deadline: "при каждой продаже",
  validity: { from: "2026-09-01" },
  basis: [
    {
      act: "Модельный нормативный акт № 1",
      article: "п. 5",
      url: "https://pravo.gov.ru/",
    },
  ],
  source: { isModel: true },
};

const realRequirement = {
  kind: "obligation" as const,
  title: "Выдавать кассовый чек при расчёте",
  summary: "Применять ККТ и выдавать чек покупателю при каждом расчёте.",
  deadline: "при каждом расчёте",
  basis: [
    {
      act: "Федеральный закон от 22.05.2003 № 54-ФЗ",
      article: "ст. 1.2",
      url: "http://pravo.gov.ru/proxy/ips/?docbody=&nd=102081652",
    },
  ],
  source: { isModel: false },
};

describe("renderObligationCard", () => {
  it("рендерит карточку с источником и обязательными пометками", () => {
    expect(
      renderObligationCard({
        requirement: modelRequirement,
        status: "applies",
        statusReason: "Основной ОКВЭД начинается с 56",
        evaluatedAt: "2026-09-25T09:00:00Z",
      }),
    ).toMatchSnapshot();
  });

  it("отказывается создавать юридически значимый текст без первоисточника", () => {
    expect(() =>
      renderObligationCard({
        requirement: { ...modelRequirement, basis: [] },
        status: "needs_review",
      }),
    ).toThrow("хотя бы один официальный первоисточник");
  });
});

describe("ограничения MAX", () => {
  it("не превышает лимит 4000 символов и сохраняет пометку об автоматической обработке", () => {
    const { text } = renderObligationCard({
      requirement: { ...modelRequirement, summary: "очень длинный текст ".repeat(400) },
      status: "applies",
    });
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
    expect(text).toContain("Текст сформирован автоматически");
    expect(text).toContain("Модельные данные");
  });
});

describe("renderRequirementDelta", () => {
  it("рендерит изменение статуса без модельной пометки для реального источника", () => {
    expect(
      renderRequirementDelta({
        requirement: realRequirement,
        reason: "status_changed",
        previousStatus: "insufficient_data",
        newStatus: "applies",
        changedAt: "2026-09-25T10:00:00Z",
      }),
    ).toMatchSnapshot();
  });

  it("рендерит ранний сигнал как требующий проверки", () => {
    expect(
      renderRequirementDelta({
        requirement: modelRequirement,
        reason: "early_signal",
        newStatus: "needs_review",
      }),
    ).toMatchSnapshot();
  });
});
