import type { ApplicabilityStatus } from "@max-hackathon/domain";
import type { NpaProject } from "../client/index.js";

export const EARLY_SIGNAL_STATUS = "needs_review" satisfies ApplicabilityStatus;

export type FeedSignalKind = "sphere" | "title_keyword" | "department";

/** One deterministic rule for an industry/direction. Signals inside a rule are combined with OR. */
export interface FeedSelectionRule {
  id: string;
  sphereIds?: number[];
  titleKeywords?: string[];
  departments?: string[];
}

export interface FeedMatch {
  ruleId: string;
  kind: FeedSignalKind;
  /** Configured value that matched; sphere identifiers are serialized as decimal strings. */
  value: string;
}

export interface SelectedFeedProject {
  project: NpaProject;
  /** A portal project is only an early signal; the filter must never claim exact applicability. */
  status: typeof EARLY_SIGNAL_STATUS;
  matches: FeedMatch[];
}

export interface LabeledFeedProject {
  project: NpaProject;
  relevant: boolean;
}

export interface FeedSelectionMetrics {
  total: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  precision: number;
  recall: number;
}

export interface ExtractedProjectText {
  text: string;
  /** JSON paths of allow-listed fields that contributed text. */
  fieldPaths: string[];
  truncated: boolean;
}
