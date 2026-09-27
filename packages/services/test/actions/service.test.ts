import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ApplicabilityResult,
  ApplicabilityStatus,
  CompanyProfile,
  DateTime,
  Id,
  ProfileRepository,
  Requirement,
  RequirementRepository,
} from "@max-hackathon/domain";
import { describe, expect, it } from "vitest";
import {
  type ActionPriority,
  ActionQueueService,
  createDueResolver,
  DEFAULT_DUE_CALENDAR,
} from "../../src/actions/index.js";
import { type ChecklistOutcome, ChecklistService } from "../../src/checklist/index.js";

const evaluatedAt = "2026-09-25T09:00:00Z" as DateTime;
const companyId = "model-cafe";

const requirement = (
  id: Id,
  deadline: string | undefined,
  options: { kind?: Requirement["kind"]; isModel?: boolean; packId?: Id; packVersion?: number } = {},
): Requirement => ({
  contractVersion: 1,
  id,
  packId: options.packId ?? "model-actions",
  packVersion: options.packVersion ?? 1,
  kind: options.kind ?? "obligation",
  title: `${id} (модельная запись)`,
  summary: "Синтетическое действие для теста очереди.",
  basis: [{ act: "Модельный источник — не юридическое утверждение", url: "https://example.invalid/model-actions" }],
  ...(deadline === undefined ? {} : { deadline }),
  condition: { type: "always" },
  coverage: "full",
  source: {
    system: "fixture",
    recordId: id,
    retrievedAt: evaluatedAt,
    isModel: options.isModel ?? true,
  },
});

const applicability = (item: Requirement, status: ApplicabilityStatus = "applies"): ApplicabilityResult => ({
  contractVersion: 1,
  companyId,
  requirementId: item.id,
  packId: item.packId,
  packVersion: item.packVersion,
  status,
  explanation: [{ kind: "source", text: "Модельный источник", url: "https://example.invalid/model-actions" }],
  evaluatedAt,
});

const profile: CompanyProfile = {
  contractVersion: 1,
  companyId,
  inn: "7707083893",
  entityType: "legal_entity",
  facts: [],
  isModel: true,
  updatedAt: evaluatedAt,
};

const checklistOutcome = (
  items: Array<{ requirement: Requirement; status?: ApplicabilityStatus }>,
): Extract<ChecklistOutcome, { status: "ok" }> => ({
  status: "ok",
  profile,
  checklist: {
    companyId,
    evaluatedAt,
    asOf: "2026-09-25",
    packs: [{ packId: "model-actions", packVersion: 1, itemCount: items.length }],
    items: items.map((item) => ({
      requirement: item.requirement,
      applicability: applicability(item.requirement, item.status),
    })),
    statusCounts: {
      applies: items.filter((item) => (item.status ?? "applies") === "applies").length,
      not_applies: items.filter((item) => item.status === "not_applies").length,
      insufficient_data: 0,
      needs_review: 0,
      out_of_coverage: 0,
    },
  },
});

class ChecklistStub {
  constructor(readonly outcome: ChecklistOutcome) {}

  async build(): Promise<ChecklistOutcome> {
    return structuredClone(this.outcome);
  }
}

const root = join(import.meta.dirname, "../../../..");
const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(root, path), "utf8")) as T;

interface PackFile {
  packId: Id;
  packVersion: number;
  requirements: Requirement[];
}

const realPacks = [
  readJson<PackFile>("data/rulepacks/a/foodservice-federal-v1.json"),
  readJson<PackFile>("data/rulepacks/b/autoservice-federal-v1.json"),
];

const packRepository = (
  packs: readonly PackFile[],
): Pick<RequirementRepository, "listByPack" | "latestVersion" | "listPackIds"> => ({
  listByPack: async (packId) => structuredClone(packs.find((pack) => pack.packId === packId)?.requirements ?? []),
  latestVersion: async (packId) => packs.find((pack) => pack.packId === packId)?.packVersion,
  listPackIds: async () => packs.map((pack) => pack.packId),
});

const profileRepository = (profiles: readonly CompanyProfile[]): Pick<ProfileRepository, "get"> => ({
  get: async (id) => structuredClone(profiles.find((item) => item.companyId === id)),
});

describe("ActionQueueService", () => {
  it("строит датированный список по явным датам срока и сортирует его по приоритету", async () => {
    const cases: Array<[Id, string, ActionPriority]> = [
      ["overdue", "Срок 2026-09-01", "overdue"],
      ["today", "Исполнить 2026-09-25", "today"],
      ["soon", "Подать до 2026-09-30", "soon"],
      ["planned", "Подать до 2026-11-10", "planned"],
    ];
    const outcome = checklistOutcome(
      [...cases].reverse().map(([id, deadline]) => ({ requirement: requirement(id, deadline) })),
    );
    const service = new ActionQueueService({ checklists: new ChecklistStub(outcome) });

    const result = await service.build(companyId);

    if (result.status !== "ok") throw new Error("Модельный профиль должен существовать");
    expect(
      result.queue.actions.map(({ requirementId, dueDate, priority, dueSource }) => [
        requirementId,
        dueDate,
        priority,
        dueSource,
      ]),
    ).toEqual(
      cases.map(([id, deadline, priority]) => [
        id,
        deadline.match(/\d{4}-\d{2}-\d{2}/)?.[0],
        priority,
        "deadline_text",
      ]),
    );
    expect(result.queue.actions.every((action) => action.isModel && action.basis.length > 0)).toBe(true);
  });

  it("берёт только применимые требования со сроком и сообщает причину, по которой даты нет", async () => {
    const applicable = requirement("applicable", "Сначала 2026-10-10, крайний срок 2026-10-05");
    const freeText = requirement("free-text", "Ежегодно после окончания отчётного периода");
    const withoutDeadline = requirement("without-deadline", undefined);
    const notApplicable = requirement("not-applicable", "2026-09-26");
    const service = new ActionQueueService({
      checklists: new ChecklistStub(
        checklistOutcome([
          { requirement: freeText },
          { requirement: notApplicable, status: "not_applies" },
          { requirement: withoutDeadline },
          { requirement: applicable },
        ]),
      ),
    });

    const result = await service.build(companyId);

    if (result.status !== "ok") throw new Error("Модельный профиль должен существовать");
    expect(result.queue.actions.map(({ requirementId, dueDate }) => [requirementId, dueDate])).toEqual([
      ["applicable", "2026-10-05"],
    ]);
    expect(result.queue.undated).toMatchObject([
      { requirementId: "free-text", reason: "not_in_calendar", deadline: "Ежегодно после окончания отчётного периода" },
    ]);
  });

  it("поддерживает предметный вычислитель срока и сохраняет возможности в той же модели", async () => {
    const opportunity = requirement("support", "Приём заявок — ежегодно", { kind: "opportunity" });
    const service = new ActionQueueService({
      checklists: new ChecklistStub(checklistOutcome([{ requirement: opportunity }])),
      resolveDue: () => ({ type: "dated", dueDate: "2026-10-20", source: "calendar" }),
    });

    const result = await service.build(companyId);

    if (result.status !== "ok") throw new Error("Модельный профиль должен существовать");
    expect(result.queue.actions).toMatchObject([
      { requirementId: "support", kind: "opportunity", dueDate: "2026-10-20", priority: "planned" },
    ]);
    expect(result.queue.undated).toEqual([]);
  });

  it("возвращает отсутствие профиля без генерации очереди", async () => {
    const service = new ActionQueueService({
      checklists: new ChecklistStub({ status: "profile_not_found", companyId: "missing" }),
    });

    await expect(service.build("missing")).resolves.toEqual({ status: "profile_not_found", companyId: "missing" });
  });
});

describe("календарь сроков", () => {
  const resolve = createDueResolver([
    {
      packId: "model-actions",
      requirementId: "daily",
      packVersion: 1,
      rule: { type: "daily", action: "Сделать запись" },
    },
    {
      packId: "model-actions",
      requirementId: "event",
      packVersion: 1,
      rule: { type: "event", trigger: "при поставке" },
    },
    {
      packId: "model-actions",
      requirementId: "periodic",
      packVersion: 1,
      rule: { type: "periodic", period: "раз в год" },
    },
    { packId: "model-actions", requirementId: "always", packVersion: 1, rule: { type: "continuous" } },
  ]);

  it("даёт дату только ежедневному действию и явной дате в тексте", () => {
    expect(resolve(requirement("daily", "Ежедневно"), "2026-09-25")).toEqual({
      type: "dated",
      dueDate: "2026-09-25",
      source: "calendar",
      action: "Сделать запись",
    });
    expect(resolve(requirement("event", "До 2026-10-01 и при каждой поставке"), "2026-09-25")).toMatchObject({
      type: "dated",
      dueDate: "2026-10-01",
      source: "deadline_text",
    });
    expect(resolve(requirement("event", "При каждой поставке"), "2026-09-25")).toEqual({
      type: "undated",
      reason: "event",
      detail: "при поставке",
    });
    expect(resolve(requirement("periodic", "Раз в год"), "2026-09-25")).toMatchObject({
      reason: "periodic_without_last_date",
    });
    expect(resolve(requirement("always", "Постоянно"), "2026-09-25")).toMatchObject({ reason: "continuous" });
  });

  it("не применяет правило к другой версии пакета", () => {
    expect(resolve(requirement("daily", "Ежедневно", { packVersion: 2 }), "2026-09-25")).toMatchObject({
      type: "undated",
      reason: "calendar_outdated",
    });
  });

  it("покрывает каждое требование со сроком в текущих пакетах и только их", () => {
    const withDeadline = realPacks.flatMap((pack) =>
      pack.requirements.filter((item) => item.deadline).map((item) => `${pack.packId}:${pack.packVersion}:${item.id}`),
    );
    const calendar = DEFAULT_DUE_CALENDAR.map((item) => `${item.packId}:${item.packVersion}:${item.requirementId}`);

    expect([...calendar].sort()).toEqual([...withDeadline].sort());
  });
});

describe("очередь по модельной компании K-28 и опубликованным пакетам", () => {
  const companies = readJson<CompanyProfile[]>("data/fixtures/k28-companies.json");
  const service = new ActionQueueService({
    checklists: new ChecklistService({
      profiles: profileRepository(companies) as ProfileRepository,
      requirements: packRepository(realPacks) as RequirementRepository,
      clock: () => "2026-09-28T09:00:00Z",
    }),
  });

  it("строит датированные действия для модельной кофейни", async () => {
    const result = await service.build("k28-cafe-msk", { asOf: "2026-09-28" });

    if (result.status !== "ok") throw new Error("Модельная компания должна существовать");
    expect(
      result.queue.actions.map(({ requirementId, dueDate, priority, dueSource }) => [
        requirementId,
        dueDate,
        priority,
        dueSource,
      ]),
    ).toEqual([
      ["a.fed.cleaning-pest-control", "2026-09-28", "today", "calendar"],
      ["a.fed.staff-daily-health-check", "2026-09-28", "today", "calendar"],
      ["a.fed.storage-and-temperature-control", "2026-09-28", "today", "calendar"],
    ]);
    expect(result.queue.actions.every((action) => action.dueAction && action.basis.length > 0)).toBe(true);
    expect(result.queue.actions.every((action) => action.applicability.status === "applies")).toBe(true);
    expect(result.queue.undated.map(({ requirementId, reason }) => [requirementId, reason])).toEqual([
      ["a.fed.cash-register-before-payment", "event"],
      ["a.fed.consumer-information-menu", "event"],
      ["a.fed.haccp-production-control", "continuous"],
      ["a.fed.incoming-control-traceability", "event"],
      ["a.fed.no-smoking", "event"],
      ["a.fed.technical-documents", "continuous"],
    ]);
  });

  it("детерминирована: повторный расчёт даёт ту же очередь", async () => {
    const first = await service.build("k28-cafe-msk", { asOf: "2026-09-28" });
    const second = await service.build("k28-cafe-msk", { asOf: "2026-09-28" });

    if (first.status !== "ok" || second.status !== "ok") throw new Error("Модельная компания должна существовать");
    expect(second.queue).toEqual(first.queue);
  });
});
