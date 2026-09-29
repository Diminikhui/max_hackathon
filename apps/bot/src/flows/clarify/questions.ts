import { FACT_KEYS, type FactValue } from "@max-hackathon/domain";

export interface ClarifyOption {
  /** Текст кнопки. */
  readonly label: string;
  readonly value: FactValue;
  /** Как ответ звучит в подтверждении «Записали по вашим словам: …». */
  readonly answerText: string;
}

export interface ClarifyQuestion {
  readonly key: string;
  /** Короткое название факта для подтверждения и итога. */
  readonly label: string;
  readonly text: string;
  readonly hint?: string;
  readonly options: readonly ClarifyOption[];
}

const yesNo = (yes: string, no: string): ClarifyOption[] => [
  { label: "Да", value: true, answerText: yes },
  { label: "Нет", value: false, answerText: no },
];

/**
 * Вопросы о фактах, которые знает только владелец (в контракте они «заявляются»). Значения — из
 * contracts/rulepack/conditions/README.md. Факты реестра (ОКВЭД, регион, категория МСП) бот не спрашивает:
 * владелец их не заявляет, их обновляет источник профиля. Численность тоже не спрашивается: условие `headcount`
 * сравнивает точное число, а ответ кнопкой его не даёт.
 */
export const CLARIFY_QUESTIONS: readonly ClarifyQuestion[] = [
  {
    key: FACT_KEYS.hasEmployees,
    label: "Есть работники",
    text: "Есть ли у вас работники — в том числе по договору?",
    hint: "От ответа зависят обязанности работодателя: медосмотры, охрана труда, обучение.",
    options: yesNo("есть работники", "работников нет"),
  },
  {
    key: FACT_KEYS.salesAlcohol,
    label: "Продажа алкоголя",
    text: "Продаёте ли вы алкоголь?",
    hint: "Если продаёте и пиво, и крепкий алкоголь, выберите «Крепкий алкоголь».",
    options: [
      { label: "Нет", value: "none", answerText: "алкоголь не продаёте" },
      { label: "Только пиво, сидр, медовуху", value: "beer", answerText: "продаёте пиво, сидр или медовуху" },
      { label: "Крепкий алкоголь", value: "strong", answerText: "продаёте крепкий алкоголь" },
    ],
  },
  {
    key: FACT_KEYS.hasLicenses,
    label: "Есть лицензии",
    text: "Есть ли у компании действующие лицензии?",
    options: yesNo("лицензии есть", "лицензий нет"),
  },
  {
    key: FACT_KEYS.taxRegime,
    label: "Налоговый режим",
    text: "Какой у вас налоговый режим?",
    hint: "Если режимов несколько (например, патент и УСН), выберите основной.",
    options: [
      { label: "ОСНО", value: "osno", answerText: "ОСНО" },
      { label: "УСН «доходы»", value: "usn_income", answerText: "УСН «доходы»" },
      { label: "УСН «доходы минус расходы»", value: "usn_income_expenses", answerText: "УСН «доходы минус расходы»" },
      { label: "Патент", value: "psn", answerText: "патент" },
      { label: "АУСН", value: "ausn", answerText: "АУСН" },
      { label: "ЕСХН", value: "eshn", answerText: "ЕСХН" },
    ],
  },
];

const BY_KEY = new Map(CLARIFY_QUESTIONS.map((question) => [question.key, question]));

export const questionFor = (key: string): ClarifyQuestion | undefined => BY_KEY.get(key);
