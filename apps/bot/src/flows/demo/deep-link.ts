import type { BotButton } from "../checklist/types.js";

/** Имя связанного с ботом мини-приложения MAX (K-05b). */
export const MAX_WEB_APP = "t214_hakaton_max_bot";
export const REQUIREMENT_START_PREFIX = "requirement_";

/** Непрозрачный start_param без ПДн; hex сохраняет произвольный UTF-8 id в алфавите MAX. */
export const requirementStartParam = (requirementId: string): string => {
  if (requirementId.length === 0) throw new Error("Идентификатор требования не может быть пустым");
  const encoded = [...new TextEncoder().encode(requirementId)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const payload = `${REQUIREMENT_START_PREFIX}${encoded}`;
  if (payload.length > 512) throw new Error("Deep link требования превышает лимит MAX в 512 символов");
  return payload;
};

export const requirementCardButton = (requirementId: string): BotButton => ({
  text: "Открыть карточку",
  webApp: MAX_WEB_APP,
  payload: requirementStartParam(requirementId),
});
