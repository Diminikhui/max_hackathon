import { MAX_TEXT_LENGTH, renderAutomaticProcessingNote } from "@max-hackathon/bot/dist/messages/index.js";
import {
  type ApplicabilityResult,
  CONTRACT_VERSION,
  type CompanyProfile,
  type DateTime,
  type Id,
  type IsoDate,
  type Notification,
  type NotificationRepository,
  type Requirement,
} from "@max-hackathon/domain";
import type { NotificationHistory, RecipientDirectory } from "../src/notify/types.js";
import { DEFAULT_MONTHLY_LIMIT, mskMonthKey } from "../src/planner/policy/index.js";

export interface MonthlyDigestItem {
  requirement: Pick<Requirement, "basis" | "source">;
  applicability: Pick<ApplicabilityResult, "status">;
}

export interface MonthlyDigestChecklist {
  asOf: IsoDate;
  packs: readonly { packId: Id; packVersion: number }[];
  items: readonly MonthlyDigestItem[];
}

export type MonthlyDigestOutcome =
  | { status: "ok"; profile: Pick<CompanyProfile, "isModel">; checklist: MonthlyDigestChecklist }
  | { status: "profile_not_found" };

/** Combines ProfileRepository.listCompanyIds and ChecklistService.build behind one structural port. */
export interface MonthlyDigestChecklistSource {
  listCompanyIds(): Promise<readonly Id[]>;
  build(companyId: Id, options: { evaluatedAt: DateTime; asOf: IsoDate }): Promise<MonthlyDigestOutcome>;
}

export interface MonthlyDigestDependencies {
  checklists: MonthlyDigestChecklistSource;
  recipients: RecipientDirectory;
  notifications: Pick<NotificationRepository, "enqueue" | "findByIdempotencyKey">;
  history: Pick<NotificationHistory, "sentThisMonth">;
  now?: () => Date;
}

export interface MonthlyDigestReport {
  period: string;
  queued: number;
  alreadyQueued: number;
  noRecipient: number;
  missingProfile: number;
  missingPrimarySource: number;
  frequencyLimited: number;
}

export interface MonthlyDigestLoopOptions {
  signal: AbortSignal;
  /** Проверяет новый месяц раз в сутки. Идемпотентный ключ допускает безопасные повторные проверки. */
  intervalMs?: number;
  onReport?: (report: MonthlyDigestReport) => void;
  /** Не включайте в журнал текст уведомлений, идентификаторы компаний или данные профиля. */
  onError?: (error: unknown) => void;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Queue one deterministic checklist summary per company and Moscow calendar month.
 * Calling this during a month is safe: the persistent idempotency key prevents a second digest.
 */
export async function runMonthlyDigest(
  dependencies: MonthlyDigestDependencies,
  options: { monthlyLimit?: number } = {},
): Promise<MonthlyDigestReport> {
  const now = (dependencies.now ?? (() => new Date()))();
  if (Number.isNaN(now.getTime())) throw new RangeError("Некорректное время сводки");

  const evaluatedAt = now.toISOString();
  const asOf = mskDateKey(now);
  const period = mskMonthKey(now);
  const monthlyLimit = options.monthlyLimit ?? DEFAULT_MONTHLY_LIMIT;
  if (!Number.isInteger(monthlyLimit) || monthlyLimit < 0) {
    throw new RangeError("Лимит уведомлений за месяц должен быть целым неотрицательным числом");
  }

  const report: MonthlyDigestReport = {
    period,
    queued: 0,
    alreadyQueued: 0,
    noRecipient: 0,
    missingProfile: 0,
    missingPrimarySource: 0,
    frequencyLimited: 0,
  };

  const companyIds = [...new Set(await dependencies.checklists.listCompanyIds())].sort((a, b) => a.localeCompare(b));
  for (const companyId of companyIds) {
    const idempotencyKey = monthlyDigestKey(companyId, period);
    if (await dependencies.notifications.findByIdempotencyKey(idempotencyKey)) {
      report.alreadyQueued += 1;
      continue;
    }

    if ((await dependencies.history.sentThisMonth(companyId, evaluatedAt)) >= monthlyLimit) {
      report.frequencyLimited += 1;
      continue;
    }

    const chatId = await dependencies.recipients.chatFor(companyId);
    if (chatId === undefined) {
      report.noRecipient += 1;
      continue;
    }

    const outcome = await dependencies.checklists.build(companyId, { evaluatedAt, asOf });
    if (outcome.status !== "ok") {
      report.missingProfile += 1;
      continue;
    }

    const summary = summarize(outcome.profile.isModel, outcome.checklist, period);
    if (summary.sourceUrls.length === 0) {
      report.missingPrimarySource += 1;
      continue;
    }

    const notification: Notification = {
      contractVersion: CONTRACT_VERSION,
      id: idempotencyKey,
      candidateId: idempotencyKey,
      companyId,
      recipient: { channel: "max_bot", chatId },
      text: summary.text,
      sourceUrls: summary.sourceUrls,
      automated: true,
      isModel: summary.isModel,
      idempotencyKey,
      status: "queued",
      attempts: 0,
      createdAt: evaluatedAt,
    };
    await dependencies.notifications.enqueue(notification);
    report.queued += 1;
  }

  return report;
}

/** Проверяет месяц сразу при запуске, затем раз в сутки до остановки worker-процесса. */
export async function runMonthlyDigestLoop(
  dependencies: MonthlyDigestDependencies,
  options: MonthlyDigestLoopOptions,
): Promise<void> {
  const sleep = options.sleep ?? abortableSleep;
  const intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("Интервал проверки сводки должен быть положительным числом");
  }

  while (!options.signal.aborted) {
    try {
      options.onReport?.(await runMonthlyDigest(dependencies));
    } catch (error) {
      options.onError?.(error);
    }
    await sleep(intervalMs, options.signal);
  }
}

export function monthlyDigestKey(companyId: Id, period: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw new RangeError("Период сводки должен иметь формат YYYY-MM");
  }
  return `monthly-digest:${companyId}:${period}`;
}

function summarize(
  profileIsModel: boolean,
  checklist: MonthlyDigestChecklist,
  period: string,
): { text: string; sourceUrls: string[]; isModel: boolean } {
  const sourceUrls = [
    ...new Set(checklist.items.flatMap((item) => item.requirement.basis.map(({ url }) => url)).filter(isHttpUrl)),
  ].sort();
  const applicableCount = checklist.items.filter((item) => item.applicability.status === "applies").length;
  const isModel = profileIsModel || checklist.items.some((item) => item.requirement.source.isModel);
  const packVersions = checklist.packs
    .slice()
    .sort((left, right) => left.packId.localeCompare(right.packId))
    .map(({ packId, packVersion }) => `${packId} v${packVersion}`);
  const lines = [
    `📋 Ежемесячная сводка за ${formatMonth(period)}`,
    "",
    `Проверено записей: ${checklist.items.length}.`,
    `Применяется к компании: ${applicableCount}.`,
    `Перечень актуален на ${checklist.asOf}.`,
    ...(packVersions.length > 0 ? [`Пакеты правил: ${packVersions.join(", ")}.`] : []),
  ];
  const note = renderAutomaticProcessingNote(isModel);
  lines.push("", "Первоисточники:");

  let includedSources = 0;
  for (const url of sourceUrls) {
    const line = `• ${url}`;
    const remaining = sourceUrls.length - includedSources - 1;
    const omitted = remaining > 0 ? [`Ещё ${remaining} первоисточников доступны в карточках перечня.`] : [];
    if ([...lines, line, ...omitted, "", note].join("\n").length > MAX_TEXT_LENGTH) break;
    lines.push(line);
    includedSources += 1;
  }
  const omittedCount = sourceUrls.length - includedSources;
  if (omittedCount > 0) lines.push(`Ещё ${omittedCount} первоисточников доступны в карточках перечня.`);
  return { text: [...lines, "", note].join("\n"), sourceUrls: includedSources > 0 ? sourceUrls : [], isModel };
}

function mskDateKey(date: Date): IsoDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((value) => value.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!year || !month || !day) throw new RangeError("Не удалось определить дату по Москве");
  return `${year}-${month}-${day}`;
}

function formatMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const name = new Intl.DateTimeFormat("ru-RU", { month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(year ?? 0, (monthNumber ?? 1) - 1, 1)),
  );
  return `${name} ${year}`;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
