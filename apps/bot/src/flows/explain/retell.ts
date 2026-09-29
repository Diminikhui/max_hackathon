import type { ChecklistItemView } from "../checklist/index.js";

/**
 * Вход пересказа (ADR-0001, п. 4 и 6): только уже вычисленный результат — шаги «факт» и «условие» из объяснения
 * `buildExplanation` (K-16c, по решающим листьям `decisiveLeaves`), название записи и её вид. Текст документов,
 * ввод пользователя и произвольные строки сюда не попадают. Статус модели не передаётся: его показывает бот сам,
 * модель его не меняет и не комментирует.
 */
export interface RetellInput {
  readonly requirementId: string;
  readonly kind: "Обязанность" | "Возможность";
  readonly title: string;
  readonly facts: readonly string[];
  readonly conditions: readonly string[];
}

/** Ограничения на вход модели: объяснение одной записи короткое, длинные строки — признак чужих данных. */
const MAX_STEP_LENGTH = 300;
const MAX_STEPS = 12;

/** Сколько символов может занять пересказ: вместе с шапкой и первоисточником он помещается в сообщение MAX. */
export const MAX_SUMMARY_LENGTH = 1500;

const clip = (text: string): string =>
  text.length <= MAX_STEP_LENGTH ? text : `${text.slice(0, MAX_STEP_LENGTH - 1)}…`;

export const retellInputOf = ({ requirement, applicability }: ChecklistItemView): RetellInput => {
  const steps = (kind: "fact" | "condition") =>
    applicability.explanation
      .filter((step) => step.kind === kind)
      .slice(0, MAX_STEPS)
      .map((step) => clip(step.text));
  return {
    requirementId: requirement.id,
    kind: requirement.kind === "opportunity" ? "Возможность" : "Обязанность",
    title: clip(requirement.title),
    facts: steps("fact"),
    conditions: steps("condition"),
  };
};

/** Пересказывать нечего: у записи нет проверенных условий (вне покрытия, требуется проверка). */
export const isEmptyInput = (input: RetellInput): boolean => input.facts.length === 0 && input.conditions.length === 0;

/** Текст для провайдера: строки вычисленного результата. Провайдер кладёт его в конверт недоверенных данных. */
export const retellDocumentText = (input: RetellInput): string =>
  [
    `${input.kind}: ${input.title}`,
    "Учтённые факты о компании:",
    ...(input.facts.length > 0 ? input.facts.map((fact) => `- ${fact}`) : ["- нет"]),
    "Проверенные условия записи:",
    ...(input.conditions.length > 0 ? input.conditions.map((condition) => `- ${condition}`) : ["- нет"]),
  ].join("\n");

/** Детерминированный пересказ без ИИ: работает без ключей и при любом сбое модели. */
export const templateRetell = (input: RetellInput): string => {
  const lines = isEmptyInput(input)
    ? ["Условия этой записи по данным компании не проверялись — причина указана в статусе выше."]
    : [
        ...(input.facts.length > 0
          ? ["Что мы посмотрели в данных компании:", ...input.facts.map((f) => `• ${f}`)]
          : []),
        ...(input.conditions.length > 0
          ? ["Какие условия записи сверили:", ...input.conditions.map((c) => `• ${c}`)]
          : []),
      ];
  const text = lines.join("\n");
  return text.length <= MAX_SUMMARY_LENGTH ? text : `${text.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
};

/** Строгая схема ответа: одно поле без anyOf/oneOf/allOf — её принимает GigaChat (K-19b). */
export const RETELL_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    summary: { type: "string", minLength: 1, maxLength: MAX_SUMMARY_LENGTH },
  },
  required: ["summary"],
  additionalProperties: false,
} as const;

/**
 * Модель не судит о применимости: пересказ со словами о статусе отбрасывается, и показывается шаблон.
 * Проверка грубая намеренно — ложное срабатывание стоит только замены пересказа шаблоном.
 */
const STATUS_WORDS =
  /применя(ет|ют)ся|применим|не касается|касается вас|недостаточно данных|требуется проверка|вне покрыти/iu;

export const mentionsStatus = (summary: string): boolean => STATUS_WORDS.test(summary);
