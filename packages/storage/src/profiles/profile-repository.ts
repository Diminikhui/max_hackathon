// ProfileRepository на PostgreSQL (K-10a). Профиль и факты хранятся документами jsonb;
// порядок фактов сохраняется. Заявленный факт добавляется рядом с официальным и его не заменяет.

import type { CompanyProfile, Fact, Id, ProfileRepository } from "@max-hackathon/domain";
import type { SqlClient } from "../db/sql-client.js";

type CompanyData = Omit<CompanyProfile, "facts">;

export class PostgresProfileRepository implements ProfileRepository {
  constructor(private readonly db: SqlClient) {}

  async get(companyId: Id): Promise<CompanyProfile | undefined> {
    return this.load("company_id = $1", companyId);
  }

  async findByInn(inn: string): Promise<CompanyProfile | undefined> {
    return this.load("inn = $1", inn);
  }

  /** Сохраняет профиль целиком: данные компании и полный набор фактов (прежние факты заменяются). */
  async save(profile: CompanyProfile): Promise<void> {
    const { facts, ...company } = profile;
    assertOwnFacts(profile.companyId, facts);
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO companies (company_id, inn, is_model, data, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (company_id) DO UPDATE SET inn = $2, is_model = $3, data = $4, updated_at = now()`,
        [company.companyId, company.inn, company.isModel, JSON.stringify(company)],
      );
      await tx.query("DELETE FROM facts WHERE company_id = $1", [profile.companyId]);
      await insertFacts(tx, facts, 0);
    });
  }

  /**
   * Добавляет факты к существующему профилю, ничего не удаляя. Факт с уже известным id заменяется
   * (повтор — идемпотентен). Официальный факт того же ключа остаётся: выбор делает вычислитель (K-16a).
   */
  async addFacts(companyId: Id, facts: Fact[]): Promise<void> {
    assertOwnFacts(companyId, facts);
    await this.db.transaction(async (tx) => {
      const exists = await tx.query("SELECT 1 FROM companies WHERE company_id = $1", [companyId]);
      if (exists.rows.length === 0) throw new Error(`Компания ${companyId} не найдена`);
      const { rows } = await tx.query<{ next: number }>(
        "SELECT COALESCE(MAX(position) + 1, 0) AS next FROM facts WHERE company_id = $1",
        [companyId],
      );
      await insertFacts(tx, facts, Number(rows[0]?.next ?? 0));
    });
  }

  async listCompanyIds(): Promise<Id[]> {
    const { rows } = await this.db.query<{ company_id: string }>(
      "SELECT company_id FROM companies ORDER BY company_id",
    );
    return rows.map((row) => row.company_id);
  }

  private async load(where: string, value: string): Promise<CompanyProfile | undefined> {
    const company = await this.db.query<{ company_id: string; data: CompanyData }>(
      `SELECT company_id, data FROM companies WHERE ${where}`,
      [value],
    );
    const row = company.rows[0];
    if (!row) return undefined;
    const facts = await this.db.query<{ data: Fact }>(
      "SELECT data FROM facts WHERE company_id = $1 ORDER BY position, id",
      [row.company_id],
    );
    return { ...row.data, facts: facts.rows.map((fact) => fact.data) };
  }
}

const insertFacts = async (tx: SqlClient, facts: Fact[], start: number): Promise<void> => {
  for (const [index, fact] of facts.entries()) {
    const { rows } = await tx.query(
      `INSERT INTO facts (id, company_id, key, kind, data, position) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET key = $3, kind = $4, data = $5 WHERE facts.company_id = $2
       RETURNING id`,
      [fact.id, fact.companyId, fact.key, fact.kind, JSON.stringify(fact), start + index],
    );
    if (rows.length === 0) throw new Error(`Факт ${fact.id} уже принадлежит другой компании`);
  }
};

const assertOwnFacts = (companyId: Id, facts: readonly Fact[]): void => {
  const foreign = facts.filter((fact) => fact.companyId !== companyId);
  if (foreign.length > 0) throw new Error(`Факты другой компании: ${foreign.map((fact) => fact.id).join(", ")}`);
};
