// Интеграционный тест 2-09 (#248): пересчёт на PostgreSQL (PGlite) — состояние и события в БД.
// Проверяет одновременные пересчёты одной компании и восстановление после «перезапуска процесса».
import { PGlite } from "@electric-sql/pglite";
import { FACT_KEYS } from "@max-hackathon/domain";
import {
  createPgliteClient,
  PostgresChangeEventRepository,
  PostgresRecalculationStateRepository,
  runMigrations,
  type SqlClient,
} from "@max-hackathon/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type PendingRecalculationOperation, ProfileRecalculationService } from "../../src/recalc/index.js";
import { MemoryApplicability, MemoryProfiles, MemoryRequirements, NOW, profile, requirement } from "./support.js";

const COMPANY = "company:model-1";
let db: PGlite;
let client: SqlClient;
beforeAll(async () => {
  db = new PGlite();
  client = createPgliteClient(db);
  await runMigrations(client);
});
beforeEach(async () => {
  await client.exec("TRUNCATE recalculation_state, change_events");
});
afterAll(() => db.close());

const world = () => {
  const profiles = new MemoryProfiles(profile("47.11", "micro"));
  const applicability = new MemoryApplicability();
  const requirements = new MemoryRequirements([
    requirement("req:food", { type: "okved_prefix", prefix: "56" }),
    requirement("req:small", { type: "msp_category", in: ["small"] }),
  ]);
  const events = new PostgresChangeEventRepository(client);
  // Новый экземпляр сервиса и репозитория имитирует перезапуск процесса: общее у них только БД.
  const service = () =>
    new ProfileRecalculationService({
      profiles,
      requirements,
      applicability,
      events,
      recalculationState: new PostgresRecalculationStateRepository<PendingRecalculationOperation>(client),
      clock: () => NOW,
      leaseRetryMs: 1,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    });
  return { profiles, applicability, service };
};

const countEvents = async () =>
  (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM change_events")).rows[0]?.n;

describe("ProfileRecalculationService + PostgreSQL", () => {
  it("одновременные пересчёты одной компании: один переход — одно событие, ревизии не повторяются", async () => {
    const state = world();
    state.profiles.value = profile("56.10", "small");
    const results = await Promise.all(
      Array.from({ length: 4 }, () => state.service().recalculate(COMPANY, { changedFactKeys: [FACT_KEYS.okvedMain] })),
    );

    expect(results.filter((item) => item.status === "changed")).toHaveLength(1);
    expect(await countEvents()).toBe(1);
    const { rows } = await client.query<{ committed_revision: number; pending: unknown; lock_token: unknown }>(
      "SELECT committed_revision, pending, lock_token FROM recalculation_state",
    );
    expect(rows).toEqual([{ committed_revision: 4, pending: null, lock_token: null }]);
  });

  it("после сбоя между событием и снимком новый процесс доводит операцию без второго события", async () => {
    const state = world();
    state.profiles.value = profile("56.10", "small");
    state.applicability.failNextReplace = true;
    await expect(state.service().recalculate(COMPANY, { changedFactKeys: [] })).rejects.toThrow();
    expect(await countEvents()).toBe(1);

    const retried = await state.service().recalculate(COMPANY, { changedFactKeys: [] });
    expect(retried.status).toBe("changed");
    expect(await countEvents()).toBe(1);
    expect(state.applicability.value.filter((item) => item.status === "applies")).toHaveLength(2);
  });

  it("A→B→A→B с одинаковыми timestamps даёт три разных события", async () => {
    const state = world();
    for (const [okved, size] of [
      ["56.10", "small"],
      ["47.11", "micro"],
      ["56.10", "small"],
    ] as const) {
      state.profiles.value = profile(okved, size);
      await state.service().recalculate(COMPANY, { changedFactKeys: [FACT_KEYS.okvedMain] });
    }
    expect(await countEvents()).toBe(3);
  });
});
