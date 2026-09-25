import {
  type ApplicabilityStatus,
  type ChangeEvent,
  CONTRACT_VERSION,
  type CompanyProfile,
  type NotificationCandidate,
  type NotificationReason,
} from "@max-hackathon/domain";
import type { ApplicabilityMatch, EventProfileMatch, PlanCandidatesOptions, ProfileMatcher } from "./types.js";

const uniqueSorted = (values: readonly string[]): string[] => [...new Set(values)].sort();

const reasonForTransition = (
  previousStatus: ApplicabilityStatus | undefined,
  newStatus: ApplicabilityStatus,
): Exclude<NotificationReason, "early_signal"> => {
  if (newStatus === "applies" && previousStatus !== "applies") {
    return "became_applicable";
  }
  if (previousStatus === "applies" && newStatus !== "applies") {
    return "no_longer_applicable";
  }
  return "status_changed";
};

/**
 * Источник перехода статуса: версия пакета правил или само событие. Без него требование, ставшее применимым,
 * потом переставшее и снова ставшее применимым, дало бы тот же dedupKey, и второе уведомление отбросили бы как дубль.
 */
const transitionSource = (event: ChangeEvent): string =>
  event.kind === "rulepack_version" ? `${event.rulepack.packId}@${event.rulepack.toVersion}` : event.id;

/** Первичная оценка требования без предыдущего статуса: об «неприменимо» и «вне покрытия» пользователю не пишем. */
const isSilentFirstEvaluation = (match: ApplicabilityMatch): boolean =>
  match.previousStatus === undefined && (match.newStatus === "not_applies" || match.newStatus === "out_of_coverage");

const applicabilityCandidate = (
  event: ChangeEvent,
  profile: CompanyProfile,
  match: ApplicabilityMatch,
  id: string,
  createdAt: string,
): NotificationCandidate | undefined => {
  if (match.previousStatus === match.newStatus || isSilentFirstEvaluation(match)) {
    return undefined;
  }

  return {
    contractVersion: CONTRACT_VERSION,
    id,
    companyId: profile.companyId,
    changeEventId: event.id,
    reason: reasonForTransition(match.previousStatus, match.newStatus),
    requirementId: match.requirementId,
    ...(match.previousStatus === undefined ? {} : { previousStatus: match.previousStatus }),
    newStatus: match.newStatus,
    matchedFactKeys: uniqueSorted(match.matchedFactKeys),
    dedupKey: `${profile.companyId}:${match.requirementId}:${match.newStatus}:${transitionSource(event)}`,
    isModel: event.isModel || profile.isModel,
    createdAt,
  };
};

const earlySignalCandidate = (
  event: ChangeEvent,
  profile: CompanyProfile,
  match: EventProfileMatch & { kind: "early_signal" },
  id: string,
  createdAt: string,
): NotificationCandidate => {
  if (event.kind !== "regulation_document") {
    throw new Error("early_signal is only valid for a regulation_document event");
  }

  return {
    contractVersion: CONTRACT_VERSION,
    id,
    companyId: profile.companyId,
    changeEventId: event.id,
    reason: "early_signal",
    newStatus: "needs_review",
    matchedFactKeys: uniqueSorted(match.matchedFactKeys),
    dedupKey: `${profile.companyId}:doc:${event.document.documentId}`,
    isModel: event.isModel || profile.isModel,
    createdAt,
  };
};

/**
 * Turns matches between a change event and saved profiles into notification
 * candidates. Frequency limits and repository-level deduplication belong to
 * K-20b; duplicate matches within one run are removed here.
 */
export const planNotificationCandidates = (
  event: ChangeEvent,
  profiles: readonly CompanyProfile[],
  matchProfile: ProfileMatcher,
  options: PlanCandidatesOptions = {},
): NotificationCandidate[] => {
  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const makeId =
    options.candidateId ??
    ((input: { event: ChangeEvent; profile: CompanyProfile; sequence: number }) =>
      `candidate:${input.event.id}:${input.profile.companyId}:${input.sequence}`);
  const candidates: NotificationCandidate[] = [];
  const seenDedupKeys = new Set<string>();

  for (const profile of profiles) {
    const result = matchProfile(event, profile);
    const matches = result === undefined ? [] : Array.isArray(result) ? result : [result];

    for (const match of matches) {
      const sequence = candidates.length;
      const id = makeId({ event, profile, match, sequence });
      const candidate =
        match.kind === "early_signal"
          ? earlySignalCandidate(event, profile, match, id, createdAt)
          : applicabilityCandidate(event, profile, match, id, createdAt);

      if (candidate !== undefined && !seenDedupKeys.has(candidate.dedupKey)) {
        seenDedupKeys.add(candidate.dedupKey);
        candidates.push(candidate);
      }
    }
  }

  return candidates;
};
