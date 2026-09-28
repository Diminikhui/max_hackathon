import type { DialogEvent } from "../dialog/index.js";
import type { InboundEvent } from "./types.js";

/**
 * События, которые пользователь может вызвать кнопкой. Системные события (`profile_loaded`, `profile_not_found`,
 * `profile_lookup_failed`, `notification_settings_saved`) порождает только сам бот, поэтому из payload кнопки они не
 * принимаются, даже если кто-то подделает callback.
 */
export const BUTTON_EVENT_TYPES = [
  "start",
  "confirm_profile",
  "edit_profile",
  "open_requirements",
  "select_requirement",
  "open_notification_settings",
  "back",
  "home",
] as const;

export type ButtonEventType = (typeof BUTTON_EVENT_TYPES)[number];
export type ButtonDialogEvent = Extract<DialogEvent, { type: ButtonEventType }>;

const PAYLOAD_PREFIX = "d:";
/** Лимит `CallbackButton.payload` в Bot API MAX. */
export const MAX_CALLBACK_PAYLOAD_LENGTH = 1024;

const isButtonEventType = (value: string): value is ButtonEventType =>
  (BUTTON_EVENT_TYPES as readonly string[]).includes(value);

/** Payload для callback-кнопки. Отправитель сообщений (K-21b, K-24) строит кнопки только через эту функцию. */
export const encodeButtonPayload = (event: ButtonDialogEvent): string => {
  const payload =
    event.type === "select_requirement"
      ? `${PAYLOAD_PREFIX}select_requirement:${event.requirementId}`
      : `${PAYLOAD_PREFIX}${event.type}`;
  if (event.type === "select_requirement" && event.requirementId.length === 0) {
    throw new Error("requirementId must not be empty");
  }
  if (payload.length > MAX_CALLBACK_PAYLOAD_LENGTH) {
    throw new Error(`Callback payload exceeds ${MAX_CALLBACK_PAYLOAD_LENGTH} characters`);
  }
  return payload;
};

/** Обратная операция к `encodeButtonPayload`. Чужой или устаревший payload даёт `undefined`. */
export const decodeButtonPayload = (payload: string): ButtonDialogEvent | undefined => {
  if (!payload.startsWith(PAYLOAD_PREFIX)) return undefined;
  const body = payload.slice(PAYLOAD_PREFIX.length);
  const separator = body.indexOf(":");
  const type = separator === -1 ? body : body.slice(0, separator);
  const argument = separator === -1 ? undefined : body.slice(separator + 1);

  if (!isButtonEventType(type)) return undefined;
  if (type === "select_requirement") {
    return argument === undefined || argument.length === 0 ? undefined : { type, requirementId: argument };
  }
  return argument === undefined ? { type } : undefined;
};

const COMMANDS: Readonly<Record<string, DialogEvent>> = {
  "/start": { type: "start" },
  "/menu": { type: "home" },
};

// Та же нормализация, что `normalizeInnInput` в packages/services: подпись «ИНН», пробелы (включая неразрывные),
// дефисы и тире. Бот не зависит от services, поэтому выражения повторены здесь.
const INN_LABEL = /^\s*инн\s*[:№#]?/iu;
const INN_SEPARATORS = /[\s   ⁠\-‐-―−]/gu;

/**
 * Переводит внутреннее событие в событие машины диалога K-22b.
 * Текст из одних цифр считается попыткой ввести ИНН; длину и контрольную сумму проверяет обработчик (`parseInn`).
 */
export const toDialogEvent = (event: InboundEvent): DialogEvent | undefined => {
  switch (event.kind) {
    case "started":
      return { type: "start" };
    case "callback":
      return decodeButtonPayload(event.payload);
    case "text": {
      const command = COMMANDS[event.text.split(/\s+/u)[0]?.toLowerCase() ?? ""];
      if (command !== undefined) return command;
      const digits = event.text.replace(INN_LABEL, "").replace(INN_SEPARATORS, "");
      return /^\d+$/u.test(digits) ? { type: "submit_inn", inn: digits } : undefined;
    }
  }
};
