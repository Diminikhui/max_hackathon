// K-30b. Контур уведомлений для демо-кнопки K-29: тот же NotificationPipeline K-30a, но с двумя отличиями.
import type { ChangeEventRepository, Id, ProfileRepository, RequirementRepository } from "@max-hackathon/domain";
import type { NotificationSink } from "../notify/index.js";

/**
 * Журнал событий, который не помечает переход обработанным. С общим журналом первое нажатие от компании, которой
 * изменение не касается (автосервис), записывало событие `k28-model 1→2`, и кафе после этого уведомления не
 * получало. Повторов нет и так: кандидат и уведомление уникальны по ключу компании и версии (`hasCandidate`,
 * `idempotencyKey`).
 */
export const UNCONSUMED_EVENTS: ChangeEventRepository = {
  append: async () => {},
  get: async () => undefined,
};

/** Только модельные компании: изменение модельного пакета не уходит реальной компании, даже если её чат известен. */
export const modelProfilesOnly = (
  profiles: Pick<ProfileRepository, "get" | "listCompanyIds">,
): Pick<ProfileRepository, "get" | "listCompanyIds"> => ({
  get: async (companyId) => {
    const profile = await profiles.get(companyId);
    return profile?.isModel ? profile : undefined;
  },
  listCompanyIds: async () => {
    const ids: Id[] = [];
    for (const id of await profiles.listCompanyIds()) if ((await profiles.get(id))?.isModel) ids.push(id);
    return ids;
  },
});

/** Только демо-пакет: прогон по кнопке не трогает переходы реальных пакетов. */
export const onlyPack = (
  requirements: Pick<RequirementRepository, "listPackIds" | "latestVersion" | "listByPack">,
  packId: Id,
): Pick<RequirementRepository, "listPackIds" | "latestVersion" | "listByPack"> => ({
  listPackIds: async () => ((await requirements.listPackIds()).includes(packId) ? [packId] : []),
  latestVersion: (id) => requirements.latestVersion(id),
  listByPack: (id, version) => requirements.listByPack(id, version),
});

/**
 * Хранилище уведомлений для демо-контура: дубль — это уже созданное уведомление, а не уже сохранённый кандидат.
 * Обычный контур сохраняет и подавленного кандидата (уведомления отключены, месячный лимит); при повторном прогоне
 * он считался дублем, и демо после «выключил → нажал демо → включил» больше не давало push. Для демо повтор после
 * включения уведомлений должен создать уведомление; дубль исключён ключом идемпотентности уведомления.
 */
export const demoNotificationSink = (notifications: NotificationSink): NotificationSink => ({
  saveCandidate: (candidate) => notifications.saveCandidate(candidate),
  enqueue: (notification) => notifications.enqueue(notification),
  findByIdempotencyKey: (key) => notifications.findByIdempotencyKey(key),
  hasCandidate: async (_companyId, dedupKey) =>
    (await notifications.findByIdempotencyKey(`notify:${dedupKey}`)) !== undefined,
});
