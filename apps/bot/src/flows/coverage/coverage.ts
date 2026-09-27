// K-34. Сообщения о покрытии: строка в перечне и ответ «Что проверяется и что нет».
// Вход совместим с `CoverageReport` из @max-hackathon/services (describeCoverage) без зависимости от пакета.
import { composeText, formatDate, type RenderedMessage, renderAutomaticProcessingNote } from "../../messages/shared.js";

export interface CoverageView {
  asOf: string;
  isModel: boolean;
  direction:
    | { status: "covered"; title: string }
    | { status: "outside_directions"; okvedMain: string }
    | { status: "unknown_okved" };
  regional?:
    | { status: "covered"; name: string; note: string }
    | { status: "out_of_coverage"; name: string }
    | { status: "unknown_region" };
  actualAt?: string;
  relevantItemCount: number;
  notChecked: readonly string[];
  testCompanies?: readonly { inn: string; title: string }[];
}

/** Payload кнопки «Что проверяется»: обработчик колбэка отвечает `renderCoverageMessage`. */
export const COVERAGE_CALLBACK_PAYLOAD = "coverage";

/** Кнопка под перечнем (формат inline-кнопки MAX `callback`). */
export const coverageButton = () => ({ type: "callback" as const, text: "ℹ️ Что проверяется", payload: COVERAGE_CALLBACK_PAYLOAD });

const regionalLine = (view: CoverageView): string | undefined => {
  const regional = view.regional;
  if (!regional) return undefined;
  switch (regional.status) {
    case "covered":
      return `Региональные требования (${regional.name}): проверены — ${regional.note}.`;
    case "out_of_coverage":
      return `Региональные требования (${regional.name}): вне покрытия — показаны только федеральные.`;
    case "unknown_region":
      return "Региональные требования: регион компании неизвестен — показаны только федеральные.";
  }
};

const outsideLines = (view: CoverageView): string[] => {
  const reason =
    view.direction.status === "outside_directions"
      ? `Основной ОКВЭД ${view.direction.okvedMain} пока не входит в проверяемые направления.`
      : "В профиле нет основного ОКВЭД, поэтому направление не определено.";
  return [
    reason,
    "Сейчас бот проверяет общепит (ОКВЭД 56) и автосервис (ОКВЭД 45.2). Пустой перечень не значит, что требований нет.",
    ...(view.testCompanies?.length
      ? ["", "Чтобы посмотреть, как работает проверка, введите тестовый ИНН (модельные данные):", ...view.testCompanies.map((company) => `• ${company.inn} — ${company.title}`)]
      : []),
  ];
};

/** Короткий блок над перечнем: всегда объясняет границу, чтобы федеральный перечень не выглядел полным. */
export const renderCoverageLine = (view: CoverageView): string => {
  if (view.direction.status !== "covered") return outsideLines(view)[0] ?? "";
  return [
    `Направление: ${view.direction.title.toLowerCase()} — федеральные требования проверены${view.actualAt ? ` (актуально на ${formatDate(view.actualAt)})` : ""}.`,
    regionalLine(view),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
};

/** Ответ на кнопку «Что проверяется»: что покрыто, что нет, дата актуальности пакета. */
export const renderCoverageMessage = (view: CoverageView): RenderedMessage => {
  const body =
    view.direction.status === "covered"
      ? [
          "ℹ️ Что проверяется и что нет",
          "",
          `✅ Федеральные требования: ${view.direction.title.toLowerCase()}.`,
          ...(view.actualAt ? [`Пакет правил актуален на ${formatDate(view.actualAt)}.`] : []),
          regionalLine(view) ?? "",
          `Записей, которые касаются вас или требуют уточнения: ${view.relevantItemCount}.`,
        ]
      : ["ℹ️ Что проверяется и что нет", "", ...outsideLines(view)];

  return {
    text: composeText(
      [
        ...body.filter((line, index, all) => line !== "" || all[index - 1] !== ""),
        "",
        "❌ Не проверяется:",
        ...view.notChecked.map((item) => `• ${item}`),
        "",
        `Расчёт на ${formatDate(view.asOf)}. Это не юридическая консультация.`,
      ],
      renderAutomaticProcessingNote(view.isModel),
    ),
    sourceUrls: [],
    automated: true,
  };
};
