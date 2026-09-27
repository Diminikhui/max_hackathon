import type {
  ApplicabilityResult,
  DateTime,
  Id,
  IsoDate,
  LegalBasis,
  Requirement,
  RequirementKind,
} from "@max-hackathon/domain";
import type { BuildChecklistOptions, ChecklistOutcome, ChecklistService } from "../checklist/index.js";
import { createDueResolver, type DueResolver, isIsoDate, type UndatedReason } from "./calendar.js";

export const ACTION_PRIORITIES = ["overdue", "today", "soon", "planned"] as const;
export type ActionPriority = (typeof ACTION_PRIORITIES)[number];

interface ActionBase {
  companyId: Id;
  requirementId: Id;
  packId: Id;
  packVersion: number;
  kind: RequirementKind;
  title: string;
  summary?: string;
  /** Исходный текст срока из записи пакета. */
  deadline: string;
  basis: LegalBasis[];
  applicability: ApplicabilityResult;
  isModel: boolean;
}

export interface ActionItem extends ActionBase {
  /** Устойчив в пределах версии требования и даты исполнения. */
  id: Id;
  dueDate: IsoDate;
  /** Откуда дата: явная дата в тексте срока или модельный календарь сроков. */
  dueSource: "deadline_text" | "calendar";
  /** Конкретное действие на эту дату, если срок записи шире (например, ежедневная часть). */
  dueAction?: string;
  priority: ActionPriority;
}

/** Применимое требование со сроком, для которого дату честно назвать нельзя. */
export interface UndatedAction extends ActionBase {
  reason: UndatedReason;
  /** Событие или периодичность из календаря, например «при каждой поставке». */
  detail?: string;
}

export interface ActionQueue {
  companyId: Id;
  evaluatedAt: DateTime;
  asOf: IsoDate;
  actions: ActionItem[];
  undated: UndatedAction[];
}

export type ActionQueueOutcome = { status: "ok"; queue: ActionQueue } | { status: "profile_not_found"; companyId: Id };

export interface ActionQueueServiceDeps {
  checklists: Pick<ChecklistService, "build">;
  /** По умолчанию — явная дата в тексте срока, затем `DEFAULT_DUE_CALENDAR`. */
  resolveDue?: DueResolver;
}

/**
 * Превращает вычисленный перечень в очередь только после подтверждения применимости.
 * Сервис не интерпретирует юридический текст через LLM и не придумывает дату для свободного срока.
 */
export class ActionQueueService {
  readonly #checklists: Pick<ChecklistService, "build">;
  readonly #resolveDue: DueResolver;

  constructor(deps: ActionQueueServiceDeps) {
    this.#checklists = deps.checklists;
    this.#resolveDue = deps.resolveDue ?? createDueResolver();
  }

  async build(companyId: Id, options: BuildChecklistOptions = {}): Promise<ActionQueueOutcome> {
    const outcome = await this.#checklists.build(companyId, options);
    if (outcome.status === "profile_not_found") return outcome;

    return { status: "ok", queue: buildActionQueue(outcome, this.#resolveDue) };
  }
}

export const buildActionQueue = (
  outcome: Extract<ChecklistOutcome, { status: "ok" }>,
  resolve: DueResolver,
): ActionQueue => {
  const { checklist } = outcome;
  const actions: ActionItem[] = [];
  const undated: UndatedAction[] = [];

  for (const { requirement, applicability } of checklist.items) {
    const { deadline } = requirement;
    if (applicability.status !== "applies" || !deadline) continue;

    const base = toBase(requirement, deadline, applicability, checklist.companyId);
    const due = resolve(requirement, checklist.asOf);
    if (due.type === "dated" && isIsoDate(due.dueDate)) {
      actions.push({
        ...base,
        id: `action:${requirement.packId}:${requirement.id}:${due.dueDate}`,
        dueDate: due.dueDate,
        dueSource: due.source,
        ...(due.action === undefined ? {} : { dueAction: due.action }),
        priority: priorityFor(due.dueDate, checklist.asOf),
      });
    } else {
      undated.push({
        ...base,
        reason: due.type === "undated" ? due.reason : "not_in_calendar",
        ...(due.type === "undated" && due.detail !== undefined ? { detail: due.detail } : {}),
      });
    }
  }

  actions.sort(compareActions);
  undated.sort(compareKeys);

  return {
    companyId: checklist.companyId,
    evaluatedAt: checklist.evaluatedAt,
    asOf: checklist.asOf,
    actions,
    undated,
  };
};

const toBase = (
  requirement: Requirement,
  deadline: string,
  applicability: ApplicabilityResult,
  companyId: Id,
): ActionBase => ({
  companyId,
  requirementId: requirement.id,
  packId: requirement.packId,
  packVersion: requirement.packVersion,
  kind: requirement.kind,
  title: requirement.title,
  ...(requirement.summary === undefined ? {} : { summary: requirement.summary }),
  deadline,
  basis: structuredClone(requirement.basis),
  applicability: structuredClone(applicability),
  isModel: requirement.source.isModel,
});

const priorityFor = (dueDate: IsoDate, asOf: IsoDate): ActionPriority => {
  const days = epochDay(dueDate) - epochDay(asOf);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= 7) return "soon";
  return "planned";
};

const PRIORITY_RANK = new Map<ActionPriority, number>(ACTION_PRIORITIES.map((value, index) => [value, index]));

const compareActions = (left: ActionItem, right: ActionItem): number =>
  (PRIORITY_RANK.get(left.priority) ?? Number.MAX_SAFE_INTEGER) -
    (PRIORITY_RANK.get(right.priority) ?? Number.MAX_SAFE_INTEGER) ||
  left.dueDate.localeCompare(right.dueDate) ||
  compareKeys(left, right);

const compareKeys = (left: ActionBase, right: ActionBase): number =>
  kindRank(left.kind) - kindRank(right.kind) ||
  left.packId.localeCompare(right.packId) ||
  left.requirementId.localeCompare(right.requirementId);

const kindRank = (kind: RequirementKind): number => (kind === "obligation" ? 0 : 1);

const epochDay = (value: IsoDate): number => {
  if (!isIsoDate(value)) throw new Error(`Ожидалась дата YYYY-MM-DD: ${value}`);
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day) / 86_400_000;
};
