// #295: единый путь события rulepack_version для контура K-30a и монитора 5-05.
// Публикация k28-rulepack-v2 → ровно одно уведомление и одно обновление снимка применимости каждой компании;
// последующий пересчёт профиля (2-09) и плановая перепроверка монитора второго уведомления не дают.
// Все данные, чаты и снимки модельные (снимки — в памяти: PostgreSQL-репозитория применимости пока нет).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type {
  ApplicabilityRepository,
  ApplicabilityResult,
  ChangeEvent,
  CompanyProfile,
  Id,
  Requirement,
} from "@max-hackathon/domain";
import { type PendingRecalculationOperation, ProfileRecalculationService } from "@max-hackathon/services";
import {
  createPgliteClient,
  PostgresChangeEventRepository,
  PostgresNotificationRepository,
  PostgresProfileRepository,
  PostgresRecalculationStateRepository,
  PostgresRequirementRepository,
  runMigrations,
} from "@max-hackathon/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMonitorLoop, SourceMonitor } from "../../src/monitor/index.js";
import {
  type ApplicabilitySnapshots,
  NotificationPipeline,
  PostgresNotificationHistory,
  recalculationSnapshots,
  runRulepackNotifications,
  StaticRecipientDirectory,
} from "../../src/notify/index.js";
import { planNotificationCandidates } from "../../src/planner/match/index.js";

interface PackFixture {
  packId: string;
  packVersion: number;
  requirements: Requirement[];
}

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dirname, "../../../../data/fixtures", name), "utf8")) as T;

const companies = fixture<CompanyProfile[]>("k28-companies.json");
const packV1 = fixture<PackFixture>("k28-rulepack-v1.json");
const packV2 = fixture<PackFixture>("k28-rulepack-v2.json");

const BEFORE = "2026-09-27T09:00:00.000Z";
const NOW = "2026-09-28T09:00:00.000Z";
const LATER = "2026-09-29T09:00:00.000Z";
const EVENT_ID = "rulepack_version:k28-model:1->2";

/** Модельный снимок применимости в памяти; считает замены с изменённым содержимым. */
class MemoryApplicability implements ApplicabilityRepository {
  readonly snapshots = new Map<Id, ApplicabilityResult[]>();
  readonly updates = new Map<Id, number>();
  async listByCompany(companyId: Id) {
    return structuredClone(this.snapshots.get(companyId) ?? []);
  }
  async replaceForCompany(companyId: Id, results: ApplicabilityResult[]) {
    const strip = (items: readonly ApplicabilityResult[]) =>
      JSON.stringify(items.map(({ evaluatedAt: _evaluatedAt, ...item }) => item));
    if (strip(this.snapshots.get(companyId) ?? []) !== strip(results)) {
      this.updates.set(companyId, (this.updates.get(companyId) ?? 0) + 1);
    }
    this.snapshots.set(companyId, structuredClone(results));
  }
}

let db: PGlite;
let client: ReturnType<typeof createPgliteClient>;

beforeAll(async () => {
  db = new PGlite();
  client = createPgliteClient(db);
  await runMigrations(client);
});
afterAll(() => db.close());

beforeEach(async () => {
  await client.exec(
    "TRUNCATE change_events, notification_candidates, notifications, requirements, rulepack_versions, facts, companies, recalculation_state CASCADE",
  );
  const profiles = new PostgresProfileRepository(client);
  for (const company of companies) await profiles.save(company);
  await new PostgresRequirementRepository(client).saveVersion(packV1.packId, 1, packV1.requirements);
});

const world = async () => {
  const profiles = new PostgresProfileRepository(client);
  const requirements = new PostgresRequirementRepository(client);
  const events = new PostgresChangeEventRepository(client);
  const notifications = new PostgresNotificationRepository(client);
  const applicability = new MemoryApplicability();
  const recalc = (clock: string) =>
    new ProfileRecalculationService({
      profiles,
      requirements,
      applicability,
      events,
      recalculationState: new PostgresRecalculationStateRepository<PendingRecalculationOperation>(client),
      clock: () => clock,
    });
  const pipeline = new NotificationPipeline({
    profiles,
    notifications,
    recipients: new StaticRecipientDirectory({ "k28-cafe-msk": "model-chat-k28-cafe-msk" }),
    history: new PostgresNotificationHistory(client),
    now: () => new Date(NOW),
  });
  const service = recalc(NOW);
  const snapshots = recalculationSnapshots(service.recalculate.bind(service), profiles);
  const contour = (snapshotPort: ApplicabilitySnapshots | null = snapshots) =>
    runRulepackNotifications({
      requirements,
      events,
      pipeline,
      now: () => NOW,
      ...(snapshotPort ? { snapshots: snapshotPort } : {}),
    });

  // Исходное состояние: снимки всех компаний посчитаны по v1 (как после онбординга).
  const baseline = recalc(BEFORE);
  for (const company of companies) await baseline.recalculate(company.companyId, { changedFactKeys: [] });
  applicability.updates.clear();

  return { profiles, events, applicability, recalc, contour, snapshots };
};

const publishV2 = () => new PostgresRequirementRepository(client).saveVersion(packV2.packId, 2, packV2.requirements);

const count = async (sql: string) => (await client.query<{ n: number }>(sql)).rows[0]?.n ?? 0;
const notificationCount = () => count("SELECT count(*)::int AS n FROM notifications");
const profileChanges = async (): Promise<ChangeEvent[]> =>
  (
    await client.query<{ data: ChangeEvent }>(
      "SELECT data FROM change_events WHERE kind = 'profile_change' AND occurred_at > $1 ORDER BY id",
      [BEFORE],
    )
  ).rows.map((row) => row.data);

/** Кандидаты, которые дали бы события profile_change после перехода: их должно быть ноль. */
const candidatesFromProfileChanges = async (profiles: PostgresProfileRepository) => {
  const all = (await Promise.all(companies.map(({ companyId }) => profiles.get(companyId)))).filter(
    (profile) => profile !== undefined,
  );
  const candidates = [];
  for (const event of await profileChanges()) {
    candidates.push(
      ...planNotificationCandidates(event, all, () => [
        { kind: "applicability", requirementId: "k28.water-marking", newStatus: "applies", matchedFactKeys: [] },
      ]),
    );
  }
  return candidates;
};

describe("#295: rulepack_version и снимок применимости", () => {
  it("новая версия пакета → одно уведомление и одно обновление снимка; пересчёт профиля второго не даёт", async () => {
    const { profiles, events, applicability, recalc, contour } = await world();
    await publishV2();

    const report = await contour();
    expect(report.processed).toHaveLength(1);
    expect(report.processed[0]?.queued).toHaveLength(1);
    expect(await notificationCount()).toBe(1);
    expect(await events.get(EVENT_ID)).toMatchObject({ kind: "rulepack_version" });

    // Снимок обновлён ровно один раз у каждой затронутой компании, и в нём уже новая запись.
    const msk = await applicability.listByCompany("k28-cafe-msk");
    expect(msk.find((item) => item.requirementId === "k28.water-marking")?.status).toBe("applies");
    expect(applicability.updates.get("k28-cafe-msk")).toBe(1);
    expect([...applicability.updates.values()].every((n) => n === 1)).toBe(true);
    // Обновление снимка отнесено к событию пакета: своего profile_change нет.
    expect(await profileChanges()).toEqual([]);

    // Повторный прогон контура ничего не меняет.
    expect(await contour()).toEqual({ processed: [], alreadyProcessed: [EVENT_ID] });

    // Следующий пересчёт профиля (2-09) сравнивает уже новый снимок с новым пакетом.
    const outcome = await recalc(LATER).recalculate("k28-cafe-msk", { changedFactKeys: [] });
    expect(outcome.status).toBe("unchanged");
    expect(await profileChanges()).toEqual([]);
    expect(await candidatesFromProfileChanges(profiles)).toEqual([]);
    expect(await notificationCount()).toBe(1);
    expect(applicability.updates.get("k28-cafe-msk")).toBe(1);
  });

  it("без обновления снимка (как было до #295) пересчёт выпустил бы profile_change о том же переходе", async () => {
    const { profiles, recalc, contour } = await world();
    await publishV2();

    await contour(null);
    const outcome = await recalc(LATER).recalculate("k28-cafe-msk", { changedFactKeys: [] });

    expect(outcome.status).toBe("changed");
    expect(await profileChanges()).toHaveLength(1);
    expect(await candidatesFromProfileChanges(profiles)).not.toEqual([]);
  });

  it("сбой обновления снимка → событие не записано; повтор даёт одно уведомление и обновляет снимки", async () => {
    const { events, applicability, contour, snapshots } = await world();
    await publishV2();
    let failOnce = true;
    const crashing: ApplicabilitySnapshots = {
      listCompanyIds: snapshots.listCompanyIds,
      refresh: async (companyId, event) => {
        if (failOnce && companyId === "k28-cafe-msk") {
          failOnce = false;
          throw new Error("модельный сбой процесса");
        }
        await snapshots.refresh(companyId, event);
      },
    };

    await expect(contour(crashing)).rejects.toThrow("модельный сбой процесса");
    expect(await events.get(EVENT_ID)).toBeUndefined();

    const retry = await contour();
    // Уведомление и кандидат сохранены в первом прогоне: повтор подавляет кандидата как дубль.
    expect(retry.processed[0]).toMatchObject({ queued: [], suppressed: [{ code: "duplicate" }] });
    expect(await events.get(EVENT_ID)).toBeDefined();
    expect(await notificationCount()).toBe(1);
    expect([...applicability.updates.values()].every((n) => n === 1)).toBe(true);
    expect(await profileChanges()).toEqual([]);
  });

  it("монитор с контуром в одном процессе: одно уведомление, перепроверка не выпускает profile_change", async () => {
    const { profiles, applicability, recalc, contour } = await world();
    await publishV2();
    const scheduled = recalc(LATER);
    const monitor = new SourceMonitor({
      sources: [],
      events: new PostgresChangeEventRepository(client),
      listCompanyIds: () => profiles.listCompanyIds(),
      recalculate: async (companyId) => {
        await scheduled.recalculate(companyId, { changedFactKeys: [] });
      },
      rulepacks: () => contour(),
    });

    const controller = new AbortController();
    const reports: string[] = [];
    await runMonitorLoop(monitor, {
      signal: controller.signal,
      sleep: async () => controller.abort(),
      onReport: (run, report) => reports.push(`${run}:${report.recalculated}:${report.errors.length}`),
    });

    expect(reports).toEqual(["poll:0:0", `recheck:${companies.length}:0`]);
    expect(await notificationCount()).toBe(1);
    expect(await profileChanges()).toEqual([]);
    expect([...applicability.updates.values()].every((n) => n === 1)).toBe(true);
  });
});
