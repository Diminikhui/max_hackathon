// K-34. Тексты покрытия: другой регион, Москва, ОКВЭД вне направлений.
import { describe, expect, it } from "vitest";
import {
  COVERAGE_CALLBACK_PAYLOAD,
  type CoverageView,
  coverageButton,
  renderCoverageLine,
  renderCoverageMessage,
  renderCoverageNotice,
} from "../../../src/flows/coverage/index.js";

const base = {
  asOf: "2026-09-27",
  isModel: true,
  actualAt: "2026-09-25",
  relevantItemCount: 12,
  notChecked: ["налоги, взносы и отчётность", "маркировка «Честный знак»"],
} as const;

const otherRegion: CoverageView = {
  ...base,
  direction: { status: "covered", title: "Общепит" },
  regional: { status: "out_of_coverage", name: "Воронежская область" },
};

describe("coverage flow", () => {
  it("другой регион: федеральные записи и «вне покрытия» с регионом", () => {
    expect(renderCoverageLine(otherRegion)).toBe(
      "Направление: общепит — федеральные требования проверены (актуально на 25.09.2026).\n" +
        "Региональные требования (Воронежская область): вне покрытия — показаны только федеральные.",
    );
  });

  it("сообщение «что проверяется и что нет» с датой актуальности и пометкой модельности", () => {
    const { text, automated, sourceUrls } = renderCoverageMessage(otherRegion);
    expect(text).toContain("Пакет правил актуален на 25.09.2026.");
    expect(text).toContain("вне покрытия");
    expect(text).toContain("❌ Не проверяется:\n• налоги, взносы и отчётность");
    expect(text).toContain("Записей, которые касаются вас или требуют уточнения: 12.");
    expect(text).toContain("🧪 Модельные данные");
    expect(text).not.toMatch(/\n\n\n/);
    expect(automated).toBe(true);
    expect(sourceUrls).toEqual([]);
  });

  it("проверенный регион", () => {
    const view: CoverageView = { ...otherRegion, isModel: false, regional: { status: "covered", name: "Москва", note: "отличий нет" } };
    expect(renderCoverageLine(view)).toContain("Региональные требования (Москва): проверены — отличий нет.");
    expect(renderCoverageMessage(view).text).not.toContain("Модельные данные");
  });

  it("регион неизвестен", () => {
    expect(renderCoverageLine({ ...otherRegion, regional: { status: "unknown_region" } })).toContain("регион компании неизвестен");
  });

  it("ОКВЭД вне направлений: понятное объяснение и тестовые ИНН", () => {
    const view: CoverageView = {
      ...base,
      direction: { status: "outside_directions", okvedMain: "47.11" },
      testCompanies: [{ inn: "7700000016", title: "кафе, Москва" }],
    };
    expect(renderCoverageLine(view)).toBe("Основной ОКВЭД 47.11 пока не входит в проверяемые направления.");
    const { text } = renderCoverageMessage(view);
    expect(text).toContain("Пустой перечень не значит, что требований нет.");
    expect(text).toContain("• 7700000016 — кафе, Москва");
    expect(renderCoverageLine({ ...view, direction: { status: "unknown_okved" } })).toContain("нет основного ОКВЭД");
  });

  it("кнопка из перечня ведёт к сообщению о покрытии", () => {
    expect(coverageButton()).toEqual({ type: "callback", text: "ℹ️ Что проверяется", payload: COVERAGE_CALLBACK_PAYLOAD });
  });
});

describe("renderCoverageNotice: пояснение над перечнем", () => {
  it("ОКВЭД вне направлений: причина, что проверяется и тестовые ИНН", () => {
    const notice = renderCoverageNotice({
      ...base,
      isModel: false,
      direction: { status: "outside_directions", okvedMain: "47.11" },
      testCompanies: [{ inn: "7700000016", title: "кафе, Москва" }],
    });
    expect(notice).toContain("Основной ОКВЭД 47.11 пока не входит в проверяемые направления.");
    expect(notice).toContain("Пустой перечень не значит, что требований нет.");
    expect(notice).toContain("• 7700000016 — кафе, Москва");
  });

  it("регион без проверенной части: строка о покрытии", () => {
    expect(renderCoverageNotice(otherRegion)).toContain("вне покрытия — показаны только федеральные");
  });

  it("направление и регион покрыты: пояснения нет, перечень не меняется", () => {
    expect(
      renderCoverageNotice({ ...otherRegion, regional: { status: "covered", name: "Москва", note: "отличий нет" } }),
    ).toBeUndefined();
  });
});
