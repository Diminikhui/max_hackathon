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

export const ACTION_PRIORITIES = ["overdue", "today", "soon", "planned"] as const;
export type ActionPriority = (typeof ACTION_PRIORITIES)[number];

export interface ActionItem {
  /** Устойчив в пределах версии требования и даты исполнения. */
  id: Id;
  companyId: Id;
  requirementId: Id;
  packId: Id;
  packVersion: number;
  kind: RequirementKind;
  title: string;
  summary?: string;
  deadline: string;
  dueDate: IsoDate;
  priority: ActionPriority;
  basis: LegalBasis[];
  applicability: ApplicabilityResult;
  isModel: boolean;
}

export interface ActionQueue {
  companyId: Id;
  evaluatedAt: DateTime;
  asOf: IsoDate;
  actions: ActionItem[];
  /** Применимые требования со свободным сроком, для которого пока нельзя честно вычислить дату. */
  unresolvedDeadlineRequirementIds: Id[];
}

export type ActionQueueOutcome =
  | { status: "ok"; queue: ActionQueue }
  | { status: "profile_not_found"; companyId: Id };

export interface ActionQueueServiceDeps {
  checklists: Pick<ChecklistService, "build">;
  /** Позволяет подключить предметный разбор регулярных сроков без изменения алгоритма очереди. */
  resolveDueDate?: DueDateResolver;
}

export type DueDateResolver = (requirement: Requirement, asOf: IsoDate) => IsoDate | undefined;

/**
 * Превращает вычисленный перечень в очередь только после подтверждения применимости.
 * Сервис не интерпретирует юридический текст через LLM и не придумывает дату для свободного срока.
 */
export class ActionQueueService {
  readonly #checklists: Pick<ChecklistService, "build">;
  readonly #resolveDueDate: DueDateResolver;

  constructor(deps: ActionQueueServiceDeps) {
    this.#checklists = deps.checklists;
    this.#resolveDueDate = deps.resolveDueDate ?? resolveIsoDueDate;
  }

  async build(companyId: Id, options: BuildChecklistOptions = {}): Promise<ActionQueueOutcome> {
    const outcome = await this.#checklists.build(companyId, options);
    if (outcome.status === "profile_not_found") return outcome;

    return {
      status: "ok",
      queue: buildActionQueue(outcome, this.#resolveDueDate),
    };
  }
}

export const buildActionQueue = (outcome: Extract<ChecklistOutcome, { status: "ok" }>, resolve: DueDateResolver): ActionQueue => {
  const { checklist } = outcome;
  const actions: ActionItem[] = [];
  const unresolved: Id[] = [];

  for (const item of checklist.items) {
    if (item.applicability.status !== "applies" || !item.requirement.deadline) continue;

    const dueDate = resolve(item.requirement, checklist.asOf);
    if (!dueDate || !isIsoDate(dueDate)) {
      unresolved.push(item.requirement.id);
      continue;
    }

    actions.push(toAction(item.requirement, item.applicability, checklist.companyId, checklist.asOf, dueDate));
  }

  actions.sort(compareActions);
  unresolved.sort((left, right) => left.localeCompare(right));

  return {
    companyId: checklist.companyId,
    evaluatedAt: checklist.evaluatedAt,
    asOf: checklist.asOf,
    actions,
    unresolvedDeadlineRequirementIds: unresolved,
  };
};

/** Берёт самую раннюю корректную ISO-дату YYYY-MM-DD из свободного текста срока. */
export const resolveIsoDueDate: DueDateResolver = (requirement) => {
  const candidates = requirement.deadline?.match(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g) ?? [];
  return candidates.filter(isIsoDate).sort()[0];
};

const toAction = (
  requirement: Requirement,
  applicability: ApplicabilityResult,
  companyId: Id,
  asOf: IsoDate,
  dueDate: IsoDate,
): ActionItem => ({
  id: `action:${requirement.packId}:${requirement.id}:${dueDate}`,
  companyId,
  requirementId: requirement.id,
  packId: requirement.packId,
  packVersion: requirement.packVersion,
  kind: requirement.kind,
  title: requirement.title,
  ...(requirement.summary === undefined ? {} : { summary: requirement.summary }),
  deadline: requirement.deadline!,
  dueDate,
  priority: priorityFor(dueDate, asOf),
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
  kindRank(left.kind) - kindRank(right.kind) ||
  left.requirementId.localeCompare(right.requirementId);

const kindRank = (kind: RequirementKind): number => (kind === "obligation" ? 0 : 1);

const epochDay = (value: IsoDate): number => {
  if (!isIsoDate(value)) throw new Error(`Ожидалась дата YYYY-MM-DD: ${value}`);
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day) / 86_400_000;
};

const isIsoDate = (value: string): value is IsoDate => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
