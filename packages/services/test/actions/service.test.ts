import type {
  ApplicabilityResult,
  ApplicabilityStatus,
  CompanyProfile,
  DateTime,
  Id,
  Requirement,
} from "@max-hackathon/domain";
import { describe, expect, it } from "vitest";
import { ActionQueueService, type ActionPriority } from "../../src/actions/index.js";
import type { ChecklistOutcome } from "../../src/checklist/index.js";

const evaluatedAt = "2026-09-25T09:00:00Z" as DateTime;
const companyId = "model-cafe";

const requirement = (
  id: Id,
  deadline: string | undefined,
  options: { kind?: Requirement["kind"]; isModel?: boolean } = {},
): Requirement => ({
  contractVersion: 1,
  id,
  packId: "model-actions",
  packVersion: 1,
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
  facts: [],
  source: { system: "fixture", retrievedAt: evaluatedAt, isModel: true },
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

describe("ActionQueueService", () => {
  it("строит датированный список действий для модельной компании и сортирует его по приоритету", async () => {
    const cases: Array<[Id, string, ActionPriority]> = [
      ["planned", "Подать до 2026-11-10", "planned"],
      ["soon", "Подать до 2026-09-30", "soon"],
      ["overdue", "Срок 2026-09-01", "overdue"],
      ["today", "Исполнить 2026-09-25", "today"],
    ];
    const outcome = checklistOutcome(
      [...cases].reverse().map(([id, deadline]) => ({ requirement: requirement(id, deadline) })),
    );
    const service = new ActionQueueService({ checklists: new ChecklistStub(outcome) });

    const result = await service.build(companyId);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.queue.actions.map(({ requirementId, dueDate, priority }) => [requirementId, dueDate, priority])).toEqual(
      cases.map(([id, deadline, priority]) => [id, deadline.match(/\d{4}-\d{2}-\d{2}/)?.[0], priority]),
    );
    expect(result.queue.actions.every((action) => action.isModel && action.basis.length > 0)).toBe(true);
  });

  it("берёт только применимые требования со сроком и явно сообщает о неразобранном сроке", async () => {
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
    expect(result.queue.unresolvedDeadlineRequirementIds).toEqual(["free-text"]);
  });

  it("поддерживает предметный вычислитель даты и сохраняет возможности в той же модели", async () => {
    const opportunity = requirement("support", "Приём заявок — ежегодно", { kind: "opportunity" });
    const service = new ActionQueueService({
      checklists: new ChecklistStub(checklistOutcome([{ requirement: opportunity }])),
      resolveDueDate: (item) => (item.id === "support" ? "2026-10-20" : undefined),
    });

    const result = await service.build(companyId);

    if (result.status !== "ok") throw new Error("Модельный профиль должен существовать");
    expect(result.queue.actions).toMatchObject([
      {
        requirementId: "support",
        kind: "opportunity",
        dueDate: "2026-10-20",
        priority: "planned",
      },
    ]);
    expect(result.queue.unresolvedDeadlineRequirementIds).toEqual([]);
  });

  it("возвращает отсутствие профиля без генерации очереди", async () => {
    const service = new ActionQueueService({
      checklists: new ChecklistStub({ status: "profile_not_found", companyId: "missing" }),
    });

    await expect(service.build("missing")).resolves.toEqual({ status: "profile_not_found", companyId: "missing" });
  });
});
