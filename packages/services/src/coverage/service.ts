import {
  APPLICABILITY_STATUSES,
  type ApplicabilityStatus,
  type DateTime,
  type Id,
  type IsoDate,
} from "@max-hackathon/domain";
import { assessRequirement } from "@max-hackathon/rules";
import type {
  CoverageHistoryReader,
  HistoricalCalculationItem,
  HistoricalCalculationOutcome,
  HistoricalCalculationPack,
  ProfileHistorySnapshot,
  ReproduceCalculationOptions,
  RulepackHistorySnapshot,
} from "./types.js";
import { endOfDay, isActiveOn, timestamp } from "./validation.js";

export interface CoverageHistoryServiceDeps {
  history: CoverageHistoryReader;
  clock?: () => DateTime;
}

/** Reproduces a decision from snapshots already known and active on the requested date. */
export class CoverageHistoryService {
  readonly #history: CoverageHistoryReader;
  readonly #clock: () => DateTime;

  constructor(deps: CoverageHistoryServiceDeps) {
    this.#history = deps.history;
    this.#clock = deps.clock ?? (() => new Date().toISOString());
  }

  async reproduce(companyId: Id, options: ReproduceCalculationOptions): Promise<HistoricalCalculationOutcome> {
    const cutoff = endOfDay(options.asOf);
    const profileSnapshot = selectProfileSnapshot(await this.#history.listProfiles(companyId), cutoff);
    if (!profileSnapshot) return { status: "profile_not_found_for_date", companyId, asOf: options.asOf };

    const requested = options.packIds === undefined ? undefined : new Set(options.packIds);
    const selectedPacks = selectRulepackSnapshots(await this.#history.listRulepacks(), options.asOf, cutoff, requested);
    const evaluatedAt = options.evaluatedAt ?? this.#clock();
    timestamp(evaluatedAt, "evaluatedAt");
    const packs: HistoricalCalculationPack[] = [];
    const items: HistoricalCalculationItem[] = [];

    for (const snapshot of selectedPacks) {
      packs.push({
        packId: snapshot.packId,
        packVersion: snapshot.packVersion,
        title: snapshot.title,
        publishedAt: snapshot.publishedAt,
        validity: snapshot.validity,
        source: snapshot.source,
        isModel: snapshot.isModel,
        itemCount: snapshot.requirements.length,
      });
      for (const requirement of snapshot.requirements) {
        items.push({
          requirement,
          applicability: assessRequirement(requirement, profileSnapshot.profile, {
            asOf: options.asOf,
            evaluatedAt,
          }),
        });
      }
    }

    return {
      status: "ok",
      profile: profileSnapshot.profile,
      calculation: {
        companyId,
        asOf: options.asOf,
        evaluatedAt,
        profileRecordedAt: profileSnapshot.recordedAt,
        packs,
        items,
        statusCounts: countStatuses(items),
      },
    };
  }
}

function selectProfileSnapshot(snapshots: readonly ProfileHistorySnapshot[], cutoff: number) {
  const candidates = snapshots
    .map((snapshot) => ({ snapshot, at: timestamp(snapshot.recordedAt, "recordedAt") }))
    .filter(({ at }) => at <= cutoff)
    .sort((left, right) => left.at - right.at);
  const latest = candidates.at(-1);
  if (latest && candidates.at(-2)?.at === latest.at) {
    throw new Error(`ambiguous profile history at ${latest.snapshot.recordedAt}`);
  }
  return latest?.snapshot;
}

function selectRulepackSnapshots(
  snapshots: readonly RulepackHistorySnapshot[],
  asOf: IsoDate,
  cutoff: number,
  requested: ReadonlySet<Id> | undefined,
): RulepackHistorySnapshot[] {
  const byPack = new Map<Id, Array<{ snapshot: RulepackHistorySnapshot; at: number }>>();
  for (const snapshot of snapshots) {
    if (requested && !requested.has(snapshot.packId)) continue;
    const at = timestamp(snapshot.publishedAt, "publishedAt");
    if (at > cutoff || !isActiveOn(snapshot.validity, asOf)) continue;
    const candidates = byPack.get(snapshot.packId) ?? [];
    candidates.push({ snapshot, at });
    byPack.set(snapshot.packId, candidates);
  }

  const result: RulepackHistorySnapshot[] = [];
  for (const [packId, candidates] of byPack) {
    candidates.sort((left, right) => left.at - right.at || left.snapshot.packVersion - right.snapshot.packVersion);
    const latest = candidates.at(-1);
    if (!latest) continue;
    const duplicates = candidates.filter(
      ({ at, snapshot }) => at === latest.at && snapshot.packVersion === latest.snapshot.packVersion,
    );
    if (duplicates.length > 1) {
      throw new Error(`ambiguous rulepack history at ${packId}@${latest.snapshot.packVersion}`);
    }
    result.push(latest.snapshot);
  }
  return result.sort((left, right) => left.packId.localeCompare(right.packId));
}

function countStatuses(items: readonly HistoricalCalculationItem[]): Record<ApplicabilityStatus, number> {
  const counts = Object.fromEntries(APPLICABILITY_STATUSES.map((status) => [status, 0])) as Record<
    ApplicabilityStatus,
    number
  >;
  for (const item of items) counts[item.applicability.status] += 1;
  return counts;
}
