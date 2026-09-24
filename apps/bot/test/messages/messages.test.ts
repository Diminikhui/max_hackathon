import { describe, expect, it } from "vitest";
import { renderObligationCard, renderRequirementDelta } from "../../src/messages/index.js";

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

describe("renderRequirementDelta", () => {
  it("рендерит изменение статуса без модельной пометки для реального источника", () => {
    expect(
      renderRequirementDelta({
        requirement: { ...modelRequirement, source: { isModel: false } },
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
