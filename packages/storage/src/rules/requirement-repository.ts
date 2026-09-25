// RequirementRepository на PostgreSQL (K-10b): версии пакетов правил и их записи.
// Версия неизменяема и строго больше предыдущей; записи хранятся документами jsonb в исходном порядке.

import type { Id, Requirement, RequirementRepository, RulepackChange } from "@max-hackathon/domain";
import type { SqlClient } from "../db/sql-client.js";

export class PostgresRequirementRepository implements RequirementRepository {
  constructor(private readonly db: SqlClient) {}

  async listByPack(packId: Id, version?: number): Promise<Requirement[]> {
    const target = version ?? (await this.latestVersion(packId));
    if (target === undefined) return [];
    const { rows } = await this.db.query<{ data: Requirement }>(
      "SELECT data FROM requirements WHERE pack_id = $1 AND version = $2 ORDER BY position",
      [packId, target],
    );
    return rows.map((row) => row.data);
  }

  async latestVersion(packId: Id): Promise<number | undefined> {
    const { rows } = await this.db.query<{ version: number | null }>(
      "SELECT MAX(version) AS version FROM rulepack_versions WHERE pack_id = $1",
      [packId],
    );
    return rows[0]?.version ?? undefined;
  }

  async listPackIds(): Promise<Id[]> {
    const { rows } = await this.db.query<{ pack_id: string }>(
      "SELECT DISTINCT pack_id FROM rulepack_versions ORDER BY pack_id",
    );
    return rows.map((row) => row.pack_id);
  }

  /** Публикует новую версию пакета. Отклоняет повтор версии, версию не выше последней и несогласованные записи. */
  async saveVersion(packId: Id, version: number, requirements: Requirement[]): Promise<void> {
    assertConsistent(packId, version, requirements);
    await this.db.transaction(async (tx) => {
      // Блокировка по пакету: две публикации одного пакета не пройдут одновременно.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [packId]);
      const { rows } = await tx.query<{ version: number | null }>(
        "SELECT MAX(version) AS version FROM rulepack_versions WHERE pack_id = $1",
        [packId],
      );
      const latest = rows[0]?.version ?? undefined;
      if (latest !== undefined && version <= latest) {
        throw new Error(`Версия ${version} пакета ${packId} не больше опубликованной ${latest}: версии неизменяемы`);
      }
      await tx.query("INSERT INTO rulepack_versions (pack_id, version) VALUES ($1, $2)", [packId, version]);
      for (const [position, requirement] of requirements.entries()) {
        await tx.query(
          "INSERT INTO requirements (pack_id, version, id, kind, position, data) VALUES ($1, $2, $3, $4, $5, $6)",
          [packId, version, requirement.id, requirement.kind, position, JSON.stringify(requirement)],
        );
      }
    });
  }

  /**
   * Разница между версиями пакета — для события `rulepack_version` (ChangeEvent) и пересчёта (K-30a).
   * Запись «изменена», если отличается чем-либо, кроме номера версии пакета.
   * Без `fromVersion` — первая публикация: все записи добавлены.
   */
  async diff(packId: Id, toVersion: number, fromVersion?: number): Promise<RulepackChange> {
    const after = await this.requireVersion(packId, toVersion);
    const before = fromVersion === undefined ? [] : await this.requireVersion(packId, fromVersion);
    const beforeById = new Map(before.map((requirement) => [requirement.id, comparable(requirement)]));
    const afterIds = new Set(after.map((requirement) => requirement.id));
    return {
      packId,
      ...(fromVersion === undefined ? {} : { fromVersion }),
      toVersion,
      addedRequirementIds: after.filter((r) => !beforeById.has(r.id)).map((r) => r.id),
      changedRequirementIds: after
        .filter((r) => beforeById.has(r.id) && beforeById.get(r.id) !== comparable(r))
        .map((r) => r.id),
      removedRequirementIds: before.filter((r) => !afterIds.has(r.id)).map((r) => r.id),
    };
  }

  private async requireVersion(packId: Id, version: number): Promise<Requirement[]> {
    const { rows } = await this.db.query("SELECT 1 FROM rulepack_versions WHERE pack_id = $1 AND version = $2", [
      packId,
      version,
    ]);
    if (rows.length === 0) throw new Error(`Версия ${version} пакета ${packId} не найдена`);
    return this.listByPack(packId, version);
  }
}

const assertConsistent = (packId: Id, version: number, requirements: readonly Requirement[]): void => {
  if (!Number.isInteger(version) || version < 1)
    throw new Error(`Версия пакета должна быть целым числом ≥ 1: ${version}`);
  const mismatched = requirements.filter((r) => r.packId !== packId || r.packVersion !== version);
  if (mismatched.length > 0) {
    throw new Error(`Записи не принадлежат версии ${packId}@${version}: ${mismatched.map((r) => r.id).join(", ")}`);
  }
  const ids = requirements.map((r) => r.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) throw new Error(`Повтор id записей: ${[...new Set(duplicates)].join(", ")}`);
};

/** Сравнимое представление записи без номера версии пакета; порядок ключей стабилизирован. */
const comparable = (requirement: Requirement): string => {
  const { packVersion: _ignored, ...rest } = requirement;
  return stableStringify(rest);
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
