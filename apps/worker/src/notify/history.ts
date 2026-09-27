// K-30a: счётчик уведомлений компании за месяц МСК для политики частоты K-20b.
// В NotificationRepository такого метода нет (см. результат K-20b), поэтому здесь — чтение из той же
// таблицы notifications (K-10c) только на чтение. Правило подсчёта совпадает с countInMskMonth.

import type { DateTime, Id } from "@max-hackathon/domain";
import type { SqlClient } from "@max-hackathon/storage";
import { mskMonthKey } from "../planner/policy/index.js";
import type { NotificationHistory } from "./types.js";

/** Начало месяца МСК, в который попадает `now`, как момент UTC. */
const mskMonthStart = (now: DateTime): string => `${mskMonthKey(now)}-01T00:00:00+03:00`;

export class PostgresNotificationHistory implements NotificationHistory {
  constructor(private readonly db: Pick<SqlClient, "query">) {}

  async sentThisMonth(companyId: Id, now: DateTime): Promise<number> {
    const { rows } = await this.db.query<{ count: number | string }>(
      `SELECT count(*) AS count FROM notifications
       WHERE company_id = $1
         AND ((status = 'sent' AND coalesce(sent_at, created_at) >= $2::timestamptz)
           OR (status = 'queued' AND created_at >= $2::timestamptz))`,
      [companyId, mskMonthStart(now)],
    );
    return Number(rows[0]?.count ?? 0);
  }
}
