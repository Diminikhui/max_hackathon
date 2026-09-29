export type { FlowReply } from "../checklist/index.js";

// Форма совпадает с `NotificationSettings` политики частоты K-20b (apps/worker/src/planner/policy): worker зависит
// от бота, а не наоборот, поэтому тип повторён здесь.

/** Настройки уведомлений компании. Отсутствие записи означает «всё включено». */
export interface NotificationSettings {
  /** false — компания отключила уведомления целиком. */
  readonly enabled: boolean;
  /** false — компания отключила ранние сигналы из ленты regulation.gov.ru. */
  readonly earlySignals: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: Readonly<NotificationSettings> = Object.freeze({
  enabled: true,
  earlySignals: true,
});

/**
 * Хранилище настроек. `settingsFor` совпадает с портом `NotificationSettingsSource` конвейера уведомлений K-30a,
 * поэтому один объект передаётся и в сценарий бота, и в worker: отключение в боте сразу видит планировщик.
 */
export interface NotificationSettingsStore {
  settingsFor(companyId: string): Promise<NotificationSettings | undefined>;
  save(companyId: string, settings: NotificationSettings): Promise<void>;
}

/** Действие кнопки на экране настроек. Каждое задаёт итоговое значение, а не переключает его: повтор безопасен. */
export const SETTINGS_ACTIONS = ["disable_all", "enable_all", "disable_early", "enable_early"] as const;
export type SettingsAction = (typeof SETTINGS_ACTIONS)[number];
