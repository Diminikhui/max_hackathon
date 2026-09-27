// RecalculationStateRepository на PostgreSQL (2-09, #248). Структурно совместим с портом из
// @max-hackathon/services (recalc): storage не зависит от services, поэтому pending хранится как jsonb.
//
// Аренда берётся одним атомарным UPSERT: строка создаётся или перехватывается, только если аренды нет
// или она истекла. Время — часы БД (now()), чтобы расхождение часов процессов не ломало исключительность.
// save пишет только при совпадении токена и неистёкшей аренде; иначе возвращает false.

import { randomUUID } from "node:crypto";
import type { Id } from "@max-hackathon/domain";
import type { SqlClient } from "../db/sql-client.js";

export interface StoredRecalculationState<Pending> {
  committedRevision: number;
  pending?: Pending;
}

export interface RecalculationLeaseToken {
  readonly token: string;
}

export class PostgresRecalculationStateRepository<Pending extends { revision: number } = { revision: number }> {
  constructor(private readonly db: SqlClient) {}

  async acquire(companyId: Id, ttlMs: number): Promise<RecalculationLeaseToken | undefined> {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new Error(`Некорректный срок аренды: ${ttlMs}`);
    const token = randomUUID();
    const { rows } = await this.db.query<{ lock_token: string }>(
      `INSERT INTO recalculation_state (company_id, lock_token, lock_expires_at)
       VALUES ($1, $2, now() + $3 * interval '1 millisecond')
       ON CONFLICT (company_id) DO UPDATE
         SET lock_token = EXCLUDED.lock_token, lock_expires_at = EXCLUDED.lock_expires_at, updated_at = now()
         WHERE recalculation_state.lock_token IS NULL OR recalculation_state.lock_expires_at <= now()
       RETURNING lock_token`,
      [companyId, token, ttlMs],
    );
    return rows[0]?.lock_token === token ? { token } : undefined;
  }

  async release(companyId: Id, lease: RecalculationLeaseToken): Promise<void> {
    await this.db.query(
      `UPDATE recalculation_state SET lock_token = NULL, lock_expires_at = NULL, updated_at = now()
       WHERE company_id = $1 AND lock_token = $2`,
      [companyId, lease.token],
    );
  }

  async get(companyId: Id): Promise<StoredRecalculationState<Pending> | undefined> {
    const { rows } = await this.db.query<{ committed_revision: number; pending: Pending | null }>(
      "SELECT committed_revision, pending FROM recalculation_state WHERE company_id = $1",
      [companyId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return row.pending === null
      ? { committedRevision: row.committed_revision }
      : { committedRevision: row.committed_revision, pending: row.pending };
  }

  async save(
    companyId: Id,
    lease: RecalculationLeaseToken,
    state: StoredRecalculationState<Pending>,
  ): Promise<boolean> {
    const { rows } = await this.db.query(
      `UPDATE recalculation_state SET committed_revision = $3, pending = $4, updated_at = now()
       WHERE company_id = $1 AND lock_token = $2 AND lock_expires_at > now()
       RETURNING company_id`,
      [companyId, lease.token, state.committedRevision, state.pending ? JSON.stringify(state.pending) : null],
    );
    return rows.length === 1;
  }
}
