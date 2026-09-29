// Сроки хранения данных MVP. Удаление выполняют владельцы хранилищ (storage, worker)
// по этим константам; описание и основания — docs/security.md, раздел «Сроки хранения».

export const DATA_CATEGORIES = [
  "init_data",
  "session",
  "profile",
  "user_binding",
  "notification",
  "change_event",
  "application_log",
] as const;
export type DataCategory = (typeof DATA_CATEGORIES)[number];

export interface RetentionRule {
  /** Срок хранения в секундах от точки отсчёта `from`. */
  ttlSec: number;
  /** От какого момента отсчитывается срок. */
  from: "created" | "last_activity" | "sent";
  /** Что содержит категория и почему выбран срок. */
  basis: string;
}

const HOUR = 3600;
const DAY = 24 * HOUR;

export const RETENTION_POLICY: Readonly<Record<DataCategory, RetentionRule>> = {
  init_data: {
    ttlSec: 0,
    from: "created",
    basis: "Строка initData не сохраняется: после проверки подписи из неё берётся только id пользователя.",
  },
  session: {
    ttlSec: HOUR,
    from: "created",
    basis: "Сессия мини-приложения живёт не дольше срока initData; после — повторный вход из MAX.",
  },
  profile: {
    ttlSec: 180 * DAY,
    from: "last_activity",
    basis: "Профиль, факты и заявленные ответы (у ИП — ПДн) нужны, пока пользователь получает уведомления.",
  },
  user_binding: {
    ttlSec: 180 * DAY,
    from: "last_activity",
    basis: "Связь пользователя и чата MAX с профилем удаляется вместе с профилем.",
  },
  notification: {
    ttlSec: 90 * DAY,
    from: "sent",
    basis: "Отправленные уведомления хранятся для дедупликации и разбора жалоб, затем удаляются.",
  },
  change_event: {
    ttlSec: 365 * DAY,
    from: "created",
    basis: "События изменений правил без ПДн; нужны для истории и воспроизведения расчётов.",
  },
  application_log: {
    ttlSec: 14 * DAY,
    from: "created",
    basis: "Логи без ПДн (маскирует observability), срок достаточен для разбора инцидентов.",
  },
};

/** Момент, записи раньше которого в категории подлежат удалению. */
export function retentionCutoff(category: DataCategory, now: Date = new Date()): Date {
  return new Date(now.getTime() - RETENTION_POLICY[category].ttlSec * 1000);
}

/** Истёк ли срок хранения записи с точкой отсчёта `since` (created / last_activity / sent). */
export function isRetentionExpired(category: DataCategory, since: Date, now: Date = new Date()): boolean {
  return since.getTime() <= retentionCutoff(category, now).getTime();
}
