// K-30a: порты контура уведомлений, которых нет в общих портах domain. Их реализуют потоки,
// владеющие данными: связь компании с чатом — онбординг (K-24a) или демо (K-29), настройки — K-24c.

import type { DateTime, Id, Notification, NotificationCandidate, NotificationRepository } from "@max-hackathon/domain";
import type { NotificationSettings } from "../planner/policy/index.js";

/** Куда доставлять уведомления компании. Нет чата — компания не подписана, уведомление не создаётся. */
export interface RecipientDirectory {
  chatFor(companyId: Id): Promise<string | undefined>;
}

/** Сколько уведомлений компании уже расходуют месячный лимит (sent и queued в месяце МСК). */
export interface NotificationHistory {
  sentThisMonth(companyId: Id, now: DateTime): Promise<number>;
}

/** Настройки уведомлений компании; отсутствие — значения по умолчанию (всё включено). */
export interface NotificationSettingsSource {
  settingsFor(companyId: Id): Promise<NotificationSettings | undefined>;
}

/** Часть NotificationRepository, которая нужна контуру. */
export type NotificationSink = Pick<
  NotificationRepository,
  "saveCandidate" | "hasCandidate" | "enqueue" | "findByIdempotencyKey"
>;

/** Текст уведомления для кандидата: шаблон K-23 и ссылки на первоисточник. */
export type NotificationRenderer = (
  candidate: NotificationCandidate,
) => Pick<Notification, "text" | "sourceUrls" | "automated" | "buttons"> | undefined;

/** Модельный справочник получателей для тестов и демо: companyId → chatId. */
export class StaticRecipientDirectory implements RecipientDirectory {
  readonly #chats: ReadonlyMap<Id, string>;

  constructor(chats: Readonly<Record<Id, string>>) {
    this.#chats = new Map(Object.entries(chats));
  }

  async chatFor(companyId: Id): Promise<string | undefined> {
    return this.#chats.get(companyId);
  }
}
