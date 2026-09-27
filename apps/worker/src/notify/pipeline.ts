// K-30a: один прогон контура для одного события изменений:
// профили → планировщик (K-20a) → политика частоты (K-20b) → текст (K-23) → очередь отправки (K-21a).
//
// Защита от дублей при повторе прогона (сбой, перезапуск, второй экземпляр):
// 1. Кандидат с тем же dedupKey уже сохранён — политика подавляет его как дубль.
// 2. Уведомление ставится в очередь ДО сохранения кандидата и с idempotencyKey из dedupKey. Если процесс
//    упал между этими шагами, повтор найдёт уведомление по ключу, не создаст второе и допишет кандидата.
// 3. Отправку «не больше одного раза» обеспечивает воркер очереди K-21a.

import {
  type ChangeEvent,
  CONTRACT_VERSION,
  type CompanyProfile,
  type DateTime,
  type Id,
  type Notification,
  type NotificationCandidate,
  type ProfileRepository,
} from "@max-hackathon/domain";
import { type ProfileMatcher, planNotificationCandidates } from "../planner/match/index.js";
import { decideAll, type PolicyConfig, type PolicyDecisionCode } from "../planner/policy/index.js";
import type {
  NotificationHistory,
  NotificationRenderer,
  NotificationSettingsSource,
  NotificationSink,
  RecipientDirectory,
} from "./types.js";

export interface NotificationPipelineDeps {
  profiles: Pick<ProfileRepository, "get" | "listCompanyIds">;
  notifications: NotificationSink;
  recipients: RecipientDirectory;
  history: NotificationHistory;
  settings?: NotificationSettingsSource;
  policy?: Partial<PolicyConfig>;
  /**
   * События ленты классификатора (regulation_document) подключаются флагом, когда лента готова (K-18, K-19).
   * По умолчанию выключено: такие события пропускаются целиком.
   */
  earlySignals?: boolean;
  now?: () => Date;
}

export interface PipelineReport {
  eventId: Id;
  /** Событие пропущено флагом ранних сигналов. */
  ignored: boolean;
  /** Поставлены в очередь в этом прогоне. */
  queued: Id[];
  /** Уже были в очереди (повтор прогона после сбоя) — второе уведомление не создано. */
  alreadyQueued: Id[];
  /** Отложены в ежемесячную сводку. */
  digest: Id[];
  suppressed: { candidateId: Id; code: PolicyDecisionCode }[];
  /** Нет чата компании: компания не подписана, кандидат не сохраняется. */
  noRecipient: Id[];
  /** Шаблон не смог собрать текст (нет записи или первоисточника) — уведомление не создаётся. */
  unrendered: Id[];
}

export const notificationIdempotencyKey = (candidate: Pick<NotificationCandidate, "dedupKey">): string =>
  `notify:${candidate.dedupKey}`;

export class NotificationPipeline {
  readonly #deps: NotificationPipelineDeps;

  constructor(deps: NotificationPipelineDeps) {
    this.#deps = deps;
  }

  async process(event: ChangeEvent, matcher: ProfileMatcher, render: NotificationRenderer): Promise<PipelineReport> {
    const report: PipelineReport = {
      eventId: event.id,
      ignored: false,
      queued: [],
      alreadyQueued: [],
      digest: [],
      suppressed: [],
      noRecipient: [],
      unrendered: [],
    };
    if (event.kind === "regulation_document" && !this.#deps.earlySignals) return { ...report, ignored: true };

    const now = (this.#deps.now ?? (() => new Date()))();
    const profiles = await this.#profiles();
    const candidates = planNotificationCandidates(event, profiles, matcher, { now: () => now });
    const context = await this.#policyContext(candidates, now.toISOString());
    const decisions = decideAll(candidates, context, this.#deps.policy);

    for (const { candidate, decision } of decisions) {
      if (decision.action === "suppress") {
        report.suppressed.push({ candidateId: candidate.id, code: decision.code });
        if (decision.code !== "duplicate") await this.#deps.notifications.saveCandidate(candidate);
        continue;
      }
      if (decision.action === "digest") {
        report.digest.push(candidate.id);
        await this.#deps.notifications.saveCandidate(candidate);
        continue;
      }

      const chatId = await this.#deps.recipients.chatFor(candidate.companyId);
      if (chatId === undefined) {
        report.noRecipient.push(candidate.id);
        continue;
      }
      const message = render(candidate);
      if (!message) {
        report.unrendered.push(candidate.id);
        continue;
      }

      const idempotencyKey = notificationIdempotencyKey(candidate);
      const existing = await this.#deps.notifications.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        report.alreadyQueued.push(existing.id);
      } else {
        await this.#deps.notifications.enqueue(toNotification(candidate, chatId, message, idempotencyKey));
        report.queued.push(`notification:${candidate.id}`);
      }
      await this.#deps.notifications.saveCandidate(candidate);
    }

    return report;
  }

  /** Профили в устойчивом порядке: от него зависят идентификаторы кандидатов. */
  async #profiles(): Promise<CompanyProfile[]> {
    const ids = [...(await this.#deps.profiles.listCompanyIds())].sort();
    const profiles = await Promise.all(ids.map((id) => this.#deps.profiles.get(id)));
    return profiles.filter((profile) => profile !== undefined);
  }

  async #policyContext(candidates: readonly NotificationCandidate[], now: DateTime) {
    const companies = [...new Set(candidates.map((candidate) => candidate.companyId))];
    const duplicates = new Set<string>();
    const counts = new Map<Id, number>();
    const settings = new Map<Id, Awaited<ReturnType<NotificationSettingsSource["settingsFor"]>>>();

    for (const candidate of candidates) {
      if (await this.#deps.notifications.hasCandidate(candidate.companyId, candidate.dedupKey)) {
        duplicates.add(JSON.stringify([candidate.companyId, candidate.dedupKey]));
      }
    }
    for (const companyId of companies) {
      counts.set(companyId, await this.#deps.history.sentThisMonth(companyId, now));
      settings.set(companyId, await this.#deps.settings?.settingsFor(companyId));
    }

    return {
      isDuplicate: (companyId: Id, dedupKey: string) => duplicates.has(JSON.stringify([companyId, dedupKey])),
      sentThisMonth: (companyId: Id) => counts.get(companyId) ?? 0,
      settings: (companyId: Id) => settings.get(companyId),
    };
  }
}

const toNotification = (
  candidate: NotificationCandidate,
  chatId: string,
  message: NonNullable<ReturnType<NotificationRenderer>>,
  idempotencyKey: string,
): Notification => ({
  contractVersion: CONTRACT_VERSION,
  id: `notification:${candidate.id}`,
  candidateId: candidate.id,
  companyId: candidate.companyId,
  recipient: { channel: "max_bot", chatId },
  text: message.text,
  ...(message.buttons ? { buttons: message.buttons } : {}),
  sourceUrls: message.sourceUrls,
  automated: message.automated,
  isModel: candidate.isModel,
  idempotencyKey,
  status: "queued",
  attempts: 0,
  createdAt: candidate.createdAt,
});
