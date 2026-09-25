import type { DateTime, Id, Notification } from "@max-hackathon/domain";

/** Москва живёт в UTC+3 без перехода на летнее время (с 2014 года). */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Календарный месяц по МСК в виде "YYYY-MM". */
export function mskMonthKey(at: Date | DateTime): string {
  const time = typeof at === "string" ? Date.parse(at) : at.getTime();
  if (Number.isNaN(time)) {
    throw new RangeError(`Некорректная дата: ${String(at)}`);
  }
  const msk = new Date(time + MSK_OFFSET_MS);
  return `${msk.getUTCFullYear()}-${String(msk.getUTCMonth() + 1).padStart(2, "0")}`;
}

type CountedNotification = Pick<Notification, "companyId" | "status" | "createdAt" | "sentAt">;

/**
 * Сколько уведомлений компании расходуют лимит в месяце МСК, куда попадает `now`:
 * отправленные (по sentAt) и стоящие в очереди (по createdAt). failed и suppressed не считаются.
 */
export function countInMskMonth(
  notifications: readonly CountedNotification[],
  companyId: Id,
  now: Date | DateTime,
): number {
  const month = mskMonthKey(now);
  let count = 0;
  for (const notification of notifications) {
    if (notification.companyId !== companyId) continue;
    const at =
      notification.status === "sent"
        ? (notification.sentAt ?? notification.createdAt)
        : notification.status === "queued"
          ? notification.createdAt
          : undefined;
    if (at !== undefined && mskMonthKey(at) === month) count += 1;
  }
  return count;
}
