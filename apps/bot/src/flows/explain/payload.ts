import type { NotificationButton } from "@max-hackathon/domain";
import { MAX_CALLBACK_PAYLOAD_LENGTH } from "../../transport/index.js";

/**
 * Кнопка «Простым языком» (2-22). Префикс `explain:` не пересекается с кнопками машины диалога (`d:`), уточнений
 * (`c:`), настроек (`s:`), демо и покрытия: обработчик колбэков передаёт такие payload в `ExplainFlow.handle`.
 */
export const EXPLAIN_PAYLOAD_PREFIX = "explain:";

export const encodeExplainPayload = (requirementId: string): string => {
  if (requirementId.length === 0) throw new Error("requirementId must not be empty");
  const payload = `${EXPLAIN_PAYLOAD_PREFIX}${requirementId}`;
  if (payload.length > MAX_CALLBACK_PAYLOAD_LENGTH) {
    throw new Error(`Callback payload exceeds ${MAX_CALLBACK_PAYLOAD_LENGTH} characters`);
  }
  return payload;
};

/** Обратная операция к `encodeExplainPayload`. Чужой payload даёт `undefined`. */
export const decodeExplainPayload = (payload: string): string | undefined => {
  if (!payload.startsWith(EXPLAIN_PAYLOAD_PREFIX)) return undefined;
  const requirementId = payload.slice(EXPLAIN_PAYLOAD_PREFIX.length);
  return requirementId.length > 0 ? requirementId : undefined;
};

export const explainButton = (requirementId: string): NotificationButton => ({
  text: "💬 Простым языком",
  payload: encodeExplainPayload(requirementId),
});
