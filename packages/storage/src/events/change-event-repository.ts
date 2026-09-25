// ChangeEventRepository на PostgreSQL (K-10c). Событие хранится документом jsonb;
// append идемпотентен по id: повтор с тем же id ничего не меняет (первая запись остаётся).

import type { ChangeEvent, ChangeEventRepository, Id } from "@max-hackathon/domain";
import type { SqlClient } from "../db/sql-client.js";

export class PostgresChangeEventRepository implements ChangeEventRepository {
  constructor(private readonly db: SqlClient) {}

  async append(event: ChangeEvent): Promise<void> {
    const companyId = event.kind === "profile_change" ? event.profile.companyId : null;
    await this.db.query(
      `INSERT INTO change_events (id, kind, company_id, occurred_at, data) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [event.id, event.kind, companyId, event.occurredAt, JSON.stringify(event)],
    );
  }

  async get(id: Id): Promise<ChangeEvent | undefined> {
    const { rows } = await this.db.query<{ data: ChangeEvent }>("SELECT data FROM change_events WHERE id = $1", [id]);
    return rows[0]?.data;
  }
}
