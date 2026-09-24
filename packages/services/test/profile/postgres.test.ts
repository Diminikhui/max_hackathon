// Интеграционный тест K-25b: сервис профиля на PostgresProfileRepository (K-10a) в PGlite, без Docker.
// Модельные данные K-28, ИНН вымышленные.
import { PGlite } from "@electric-sql/pglite";
import { FixtureProfileSource } from "@max-hackathon/adapters";
import type { CompanyProfile } from "@max-hackathon/domain";
import { createPgliteClient, PostgresProfileRepository, runMigrations } from "@max-hackathon/storage";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileService } from "../../src/index.js";

const NOW = "2026-09-25T10:00:00Z";
const LATER = "2026-09-26T10:00:00Z";

// Как createTestDatabase из packages/storage/test/support: новая пустая БД с применёнными миграциями.
const createTestDatabase = async () => {
  const db = new PGlite();
  const client = createPgliteClient(db);
  await runMigrations(client);
  return { client, close: () => db.close() };
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("ProfileService + PostgresProfileRepository", () => {
  it("подтверждение, заявленное рядом с официальным, повторное заявление и повторный lookup", async () => {
    const db = await createTestDatabase();
    close = db.close;
    const repository = new PostgresProfileRepository(db.client);
    let now = NOW;
    const service = new ProfileService({ source: new FixtureProfileSource(), repository, clock: () => now });

    const lookup = await service.lookup("7700000016");
    if (lookup.status !== "found") throw new Error(lookup.status);
    const confirmed = await service.confirm(lookup.profile, [{ key: "employment.headcount", value: 5 }]);
    expect(confirmed).toMatchObject({ status: "ok", companyId: "k28-cafe-msk" });

    now = LATER;
    await service.declare("k28-cafe-msk", "employment.headcount", 7);
    const saved = (await repository.get("k28-cafe-msk")) as CompanyProfile;
    const headcount = saved.facts.filter((f) => f.key === "employment.headcount");
    expect(headcount.map((f) => [f.kind, f.value, f.observedAt])).toEqual([
      ["official", 12, "2026-09-10T00:00:00Z"],
      ["declared", 7, LATER],
    ]);

    const again = await service.lookup("7700000016");
    expect(again).toMatchObject({ status: "found", alreadySaved: true });
    if (again.status !== "found") return;
    await service.confirm(again.profile);
    const resaved = (await repository.get("k28-cafe-msk")) as CompanyProfile;
    expect(resaved.facts).toHaveLength(saved.facts.length);
    expect(resaved.facts.filter((f) => f.key === "employment.headcount").map((f) => f.value)).toEqual([12, 7]);
    expect(await repository.listCompanyIds()).toEqual(["k28-cafe-msk"]);
  });
});
