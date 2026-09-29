import { MAX_CALLBACK_PAYLOAD_LENGTH } from "../../transport/index.js";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  SETTINGS_ACTIONS,
  type SettingsAction,
} from "./types.js";

// Префикс отличается от `d:` транспорта K-22a: `decodeButtonPayload` не примет такую кнопку и вернёт `undefined`,
// а сборка контура (K-30b) передаст payload в `decodeSettingsPayload`. Сохранение порождает системное событие
// `notification_settings_saved`, которое из кнопки подделать нельзя.
const PAYLOAD_PREFIX = "s:";

const isSettingsAction = (value: string): value is SettingsAction =>
  (SETTINGS_ACTIONS as readonly string[]).includes(value);

export const encodeSettingsPayload = (action: SettingsAction): string => {
  const payload = `${PAYLOAD_PREFIX}${action}`;
  if (payload.length > MAX_CALLBACK_PAYLOAD_LENGTH) throw new Error("Callback payload is too long");
  return payload;
};

/** Обратная операция к `encodeSettingsPayload`. Чужой payload даёт `undefined`. */
export const decodeSettingsPayload = (payload: string): SettingsAction | undefined => {
  if (!payload.startsWith(PAYLOAD_PREFIX)) return undefined;
  const action = payload.slice(PAYLOAD_PREFIX.length);
  return isSettingsAction(action) ? action : undefined;
};

/** Итоговые настройки после действия. Ранние сигналы при отключении уведомлений сохраняют своё значение. */
export const applySettingsAction = (
  current: NotificationSettings | undefined,
  action: SettingsAction,
): NotificationSettings => {
  const base = current ?? DEFAULT_NOTIFICATION_SETTINGS;
  switch (action) {
    case "disable_all":
      return { ...base, enabled: false };
    case "enable_all":
      return { ...base, enabled: true };
    case "disable_early":
      return { ...base, earlySignals: false };
    case "enable_early":
      return { ...base, earlySignals: true };
  }
};
