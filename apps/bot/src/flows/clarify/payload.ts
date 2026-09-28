import { MAX_CALLBACK_PAYLOAD_LENGTH } from "../../transport/index.js";

/**
 * Кнопки уточнения. Префикс `c:` не пересекается с кнопками машины диалога (`d:`, K-22b) и кнопкой покрытия
 * (`coverage`, K-34): обработчик колбэков K-30b передаёт такие payload в `ClarifyFlow.handle`.
 */
export type ClarifyAction =
  | { readonly type: "start" }
  | { readonly type: "answer"; readonly key: string; readonly option: number }
  | { readonly type: "skip"; readonly key: string }
  | { readonly type: "finish" };

export const CLARIFY_PAYLOAD_PREFIX = "c:";

const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u;

export const encodeClarifyPayload = (action: ClarifyAction): string => {
  const body = (() => {
    switch (action.type) {
      case "start":
      case "finish":
        return action.type;
      case "answer":
        return `answer:${action.key}:${action.option}`;
      case "skip":
        return `skip:${action.key}`;
    }
  })();
  if ("key" in action && !KEY_PATTERN.test(action.key)) throw new Error(`Некорректный ключ факта: ${action.key}`);
  const payload = `${CLARIFY_PAYLOAD_PREFIX}${body}`;
  if (payload.length > MAX_CALLBACK_PAYLOAD_LENGTH) {
    throw new Error(`Callback payload exceeds ${MAX_CALLBACK_PAYLOAD_LENGTH} characters`);
  }
  return payload;
};

export const isClarifyPayload = (payload: string): boolean => payload.startsWith(CLARIFY_PAYLOAD_PREFIX);

/** Обратная операция к `encodeClarifyPayload`. Чужой или подделанный payload даёт `undefined`. */
export const decodeClarifyPayload = (payload: string): ClarifyAction | undefined => {
  if (!isClarifyPayload(payload)) return undefined;
  const [type, key, option, ...rest] = payload.slice(CLARIFY_PAYLOAD_PREFIX.length).split(":");
  if (rest.length > 0) return undefined;
  if ((type === "start" || type === "finish") && key === undefined) return { type };
  if (key === undefined || !KEY_PATTERN.test(key)) return undefined;
  if (type === "skip" && option === undefined) return { type, key };
  if (type === "answer" && option !== undefined && /^\d{1,2}$/u.test(option)) {
    return { type, key, option: Number(option) };
  }
  return undefined;
};
