import type { ApplicabilityStatus, ChangeEvent, CompanyProfile, Id } from "@max-hackathon/domain";

/** A recalculation result showing how one requirement changed for a profile. */
export interface ApplicabilityMatch {
  kind: "applicability";
  requirementId: Id;
  previousStatus?: ApplicabilityStatus;
  newStatus: ApplicabilityStatus;
  matchedFactKeys: readonly string[];
}

/** A preliminary match with a document from the regulatory-change feed. */
export interface EarlySignalMatch {
  kind: "early_signal";
  matchedFactKeys: readonly string[];
}

export type EventProfileMatch = ApplicabilityMatch | EarlySignalMatch;

/**
 * Domain-specific matching stays outside the scheduler: rule evaluation and
 * document classification provide these matches without being duplicated here.
 */
export type ProfileMatcher = (
  event: ChangeEvent,
  profile: CompanyProfile,
) => EventProfileMatch | readonly EventProfileMatch[] | undefined;

export interface PlanCandidatesOptions {
  now?: () => Date;
  candidateId?: (input: {
    event: ChangeEvent;
    profile: CompanyProfile;
    match: EventProfileMatch;
    sequence: number;
  }) => Id;
}
