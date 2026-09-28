// Интеграционные тесты PostgresRecalculationStateRepository (2-09, #248) на PostgreSQL (PGlite):
// аренда исключительна и перехватывается после истечения, save пишет только при действующей аренде.
import { beforeEach, describe, expect, it } from "vitest";
import { PostgresRecalculationStateRepository } from "../../src/index.js";
import { type TestDatabase, useSharedTestDatabase } from "../support/test-db.js";

const COMPANY = "company:model-1";
const testDatabase = useSharedTestDatabase();
let db: TestDatabase;
let repository: PostgresRecalculationStateRepository<{ revision: number; marker: string }>;

beforeEach(() => {
  db = testDatabase();
  repository = new PostgresRecalculationStateRepository(db);
});

const expireLeases = () => db.query("UPDATE recalculation_state SET lock_expires_at = now() - interval '1 second'");

describe("PostgresRecalculationStateRepository", () => {
  it("неизвестная компания — undefined", async () => {
    expect(await repository.get(COMPANY)).toBeUndefined();
  });

  it("из одновременных acquire аренду получает ровно один", async () => {
    const leases = await Promise.all(Array.from({ length: 8 }, () => repository.acquire(COMPANY, 60_000)));
    expect(leases.filter(Boolean)).toHaveLength(1);
  });

  it("сохраняет pending и ревизию, читает ровно записанное", async () => {
    const lease = await repository.acquire(COMPANY, 60_000);
    if (!lease) throw new Error("lease");
    expect(await repository.get(COMPANY)).toEqual({ committedRevision: 0 });
    expect(await repository.save(COMPANY, lease, { committedRevision: 0, pending: { revision: 1, marker: "a" } })).toBe(
      true,
    );
    expect(await repository.get(COMPANY)).toEqual({ committedRevision: 0, pending: { revision: 1, marker: "a" } });
    expect(await repository.save(COMPANY, lease, { committedRevision: 1 })).toBe(true);
    expect(await repository.get(COMPANY)).toEqual({ committedRevision: 1 });
  });

  it("release освобождает аренду, чужой токен её не снимает", async () => {
    const lease = await repository.acquire(COMPANY, 60_000);
    if (!lease) throw new Error("lease");
    await repository.release(COMPANY, { token: "foreign" });
    expect(await repository.acquire(COMPANY, 60_000)).toBeUndefined();
    await repository.release(COMPANY, lease);
    expect(await repository.acquire(COMPANY, 60_000)).toBeDefined();
  });

  it("истёкшая аренда перехватывается, а прежний держатель больше не может писать (fencing)", async () => {
    const stale = await repository.acquire(COMPANY, 60_000);
    if (!stale) throw new Error("lease");
    await expireLeases();
    expect(await repository.save(COMPANY, stale, { committedRevision: 5 })).toBe(false);

    const fresh = await repository.acquire(COMPANY, 60_000);
    expect(fresh).toBeDefined();
    expect(await repository.save(COMPANY, stale, { committedRevision: 5 })).toBe(false);
    expect(await repository.get(COMPANY)).toEqual({ committedRevision: 0 });
  });

  it("схема отвергает pending, не следующий за зафиксированной ревизией", async () => {
    const lease = await repository.acquire(COMPANY, 60_000);
    if (!lease) throw new Error("lease");
    await expect(
      repository.save(COMPANY, lease, { committedRevision: 2, pending: { revision: 2, marker: "x" } }),
    ).rejects.toThrow();
  });

  it("отвергает некорректный срок аренды", async () => {
    await expect(repository.acquire(COMPANY, 0)).rejects.toThrow("срок аренды");
  });
});
