// K-29. Демо-триггер: нажатие кнопки публикует заранее подготовленную следующую версию модельного пакета и
// запускает тот же контур, что при реальном изменении (K-30a: событие версии → планировщик → политика → шаблон
// → очередь отправки). Отдельного «демо-уведомления» нет: в очередь попадает обычное уведомление контура.

import type { Id, NotificationRepository, Requirement, RequirementRepository } from "@max-hackathon/domain";
import type { ChecklistSource, FlowReply } from "../checklist/types.js";
import type { DemoPack } from "./pack.js";
import type { DemoRecipientDirectory } from "./recipients.js";
import {
  type ChangeKind,
  concernsCompany,
  type DemoChangeItem,
  type DemoChangeView,
  renderDemoChange,
  renderDemoNeedsCompany,
  renderDemoUnavailable,
} from "./render.js";

/** Модельная компания K-28, которой демо-изменение касается: кофейня в Москве. */
export const DEMO_EXAMPLE_COMPANY = { inn: "7700000016", title: "модельная кофейня в Москве" } as const;

export interface DemoChangeFlowDeps {
  /** Подготовленная версия из data/rulepacks/_demo (`loadDemoPack`). */
  readonly pack: DemoPack;
  readonly requirements: Pick<RequirementRepository, "latestVersion" | "listByPack" | "saveVersion">;
  /** Перечень K-26 (`ChecklistService`): статус и объяснение новой записи для компании. */
  readonly checklist: ChecklistSource;
  /** Компания, привязанная к диалогу после онбординга (K-24a). */
  readonly companyOf: (dialogId: string) => Promise<string | undefined>;
  /** Тот же экземпляр передаётся в `NotificationPipeline` как `recipients`. */
  readonly recipients: Pick<DemoRecipientDirectory, "remember">;
  /** Прогон контура K-30a: `() => runRulepackNotifications({ requirements, events, pipeline })`. */
  readonly runNotifications: () => Promise<unknown>;
  readonly notifications: Pick<NotificationRepository, "findByIdempotencyKey">;
  /** Подсказка, если изменение не касается компании нажавшего. `null` — не показывать. */
  readonly example?: DemoChangeView["example"] | null;
}

export interface DemoChangeRequest {
  readonly dialogId: string;
  /** Чат, где нажата кнопка: туда контур доставит уведомление. */
  readonly chatId: string;
}

export interface DemoChangeFlow {
  handle(request: DemoChangeRequest): Promise<FlowReply>;
}

/** Содержимое записи без полей версии — как в K-30a: одинаковая запись в двух версиях не считается изменённой. */
const content = (requirement: Requirement): string => {
  const { packVersion: _version, source, ...rest } = requirement;
  const { retrievedAt: _retrievedAt, ...stableSource } = source;
  return JSON.stringify({ ...rest, source: stableSource });
};

const diff = (from: readonly Requirement[], to: readonly Requirement[]) => {
  const before = new Map(from.map((item) => [item.id, item]));
  const after = new Map(to.map((item) => [item.id, item]));
  const changes: { kind: ChangeKind; requirement: Requirement }[] = [];
  for (const [id, item] of after) {
    const previous = before.get(id);
    if (!previous) changes.push({ kind: "added", requirement: item });
    else if (content(previous) !== content(item)) changes.push({ kind: "changed", requirement: item });
  }
  for (const [id, item] of before) if (!after.has(id)) changes.push({ kind: "removed", requirement: item });
  return changes;
};

/**
 * Ключ уведомления контура K-30a: `notify:<dedupKey>`, где dedupKey планировщика K-20a —
 * `<companyId>:<requirementId>:<newStatus>:<packId>@<toVersion>` (`apps/worker/src/planner/match/plan.ts`).
 * Совпадение проверяет сквозной тест `apps/worker/test/notify/demo-trigger.test.ts`.
 */
export const demoNotificationKey = (companyId: Id, item: DemoChangeItem, pack: DemoPack): string | undefined =>
  item.applicability
    ? `notify:${companyId}:${item.requirement.id}:${item.applicability.status}:${pack.packId}@${pack.packVersion}`
    : undefined;

export const createDemoChangeFlow = (deps: DemoChangeFlowDeps): DemoChangeFlow => {
  const { pack } = deps;
  const example = deps.example === null ? undefined : (deps.example ?? DEMO_EXAMPLE_COMPANY);
  const baseVersion = pack.packVersion - 1;

  /** Публикует версию один раз. `false` — предыдущей версии нет, и переход не получится. */
  const publish = async (): Promise<boolean> => {
    const latest = await deps.requirements.latestVersion(pack.packId);
    if (latest === undefined || latest < baseVersion) return false;
    if (latest >= pack.packVersion) return true;
    try {
      await deps.requirements.saveVersion(pack.packId, pack.packVersion, [...pack.requirements]);
    } catch (error) {
      // Одновременное нажатие в другом процессе: версия уже опубликована — это тот же результат.
      if (((await deps.requirements.latestVersion(pack.packId)) ?? 0) < pack.packVersion) throw error;
    }
    return true;
  };

  // Нажатия выполняются по очереди: публикация и прогон контура не должны пересекаться внутри процесса.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const handle = async ({ dialogId, chatId }: DemoChangeRequest): Promise<FlowReply> => {
    const companyId = await deps.companyOf(dialogId);
    if (companyId === undefined) return renderDemoNeedsCompany(example);

    deps.recipients.remember(companyId, chatId);
    const ready = await serialized(async () => {
      if (!(await publish())) return false;
      await deps.runNotifications();
      return true;
    });
    if (!ready) return renderDemoUnavailable();

    const outcome = await deps.checklist.build(companyId);
    if (outcome.status !== "ok") return renderDemoNeedsCompany(example);

    // Обе версии читаются из хранилища: так сравнение не зависит от порядка ключей (JSONB его не сохраняет).
    const [base, published] = await Promise.all([
      deps.requirements.listByPack(pack.packId, baseVersion),
      deps.requirements.listByPack(pack.packId, pack.packVersion),
    ]);
    const items: DemoChangeItem[] = [];
    for (const change of diff(base, published)) {
      const applicability =
        change.kind === "removed"
          ? undefined
          : outcome.checklist.items.find(
              (entry) => entry.requirement.id === change.requirement.id && entry.requirement.packId === pack.packId,
            )?.applicability;
      const item: DemoChangeItem = {
        ...change,
        ...(applicability ? { applicability } : {}),
        notification: "not_needed",
      };
      items.push({ ...item, notification: await notificationState(companyId, chatId, item) });
    }

    return renderDemoChange({
      packTitle: pack.title,
      fromVersion: baseVersion,
      toVersion: pack.packVersion,
      items,
      ...(example ? { example } : {}),
    });
  };

  const notificationState = async (
    companyId: Id,
    chatId: string,
    item: DemoChangeItem,
  ): Promise<DemoChangeItem["notification"]> => {
    const key = concernsCompany(item) ? demoNotificationKey(companyId, item, pack) : undefined;
    if (key === undefined) return "not_needed";
    const notification = await deps.notifications.findByIdempotencyKey(key);
    if (notification) return notification.recipient.chatId === chatId ? "sent_here" : "sent_elsewhere";
    // Изменённая запись без смены статуса уведомления не даёт — это не сбой.
    return item.kind === "changed" ? "not_needed" : "not_created";
  };

  return { handle };
};
