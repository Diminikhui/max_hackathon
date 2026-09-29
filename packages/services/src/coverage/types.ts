import type {
  ApplicabilityResult,
  ApplicabilityStatus,
  CompanyProfile,
  DateTime,
  Id,
  IsoDate,
  Period,
  Requirement,
  SourceRef,
} from "@max-hackathon/domain";

export interface RulepackHistorySnapshot {
  packId: Id;
  packVersion: number;
  title: string;
  owner: { name: string; contact?: string };
  source: SourceRef & { url: string };
  publishedAt: DateTime;
  validity: Period;
  isModel: boolean;
  requirements: Requirement[];
}

export interface ProfileHistorySnapshot {
  companyId: Id;
  recordedAt: DateTime;
  profile: CompanyProfile;
}

export interface CoverageHistoryReader {
  listRulepacks(): Promise<RulepackHistorySnapshot[]>;
  listProfiles(companyId: Id): Promise<ProfileHistorySnapshot[]>;
}

export interface CoverageHistoryWriter {
  appendRulepack(snapshot: RulepackHistorySnapshot): Promise<void>;
  appendProfile(snapshot: ProfileHistorySnapshot): Promise<void>;
}

export interface HistoricalCalculationPack {
  packId: Id;
  packVersion: number;
  title: string;
  publishedAt: DateTime;
  validity: Period;
  source: SourceRef & { url: string };
  isModel: boolean;
  itemCount: number;
}

export interface HistoricalCalculationItem {
  requirement: Requirement;
  applicability: ApplicabilityResult;
}

export interface HistoricalCalculation {
  companyId: Id;
  asOf: IsoDate;
  evaluatedAt: DateTime;
  profileRecordedAt: DateTime;
  packs: HistoricalCalculationPack[];
  items: HistoricalCalculationItem[];
  statusCounts: Record<ApplicabilityStatus, number>;
}

export type HistoricalCalculationOutcome =
  | { status: "ok"; profile: CompanyProfile; calculation: HistoricalCalculation }
  | { status: "profile_not_found_for_date"; companyId: Id; asOf: IsoDate };

export interface ReproduceCalculationOptions {
  asOf: IsoDate;
  evaluatedAt?: DateTime;
  packIds?: readonly Id[];
}
