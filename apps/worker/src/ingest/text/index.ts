export {
  extractProjectText,
  type LoadProjectTextOptions,
  loadProjectText,
  type TextExtractionOptions,
  toPlainProjectText,
} from "./extract.js";
export { measureFeedSelection, normalizeSignalText, selectFeedProjects } from "./select.js";
export {
  EARLY_SIGNAL_STATUS,
  type ExtractedProjectText,
  type FeedMatch,
  type FeedSelectionMetrics,
  type FeedSelectionRule,
  type FeedSignalKind,
  type LabeledFeedProject,
  type SelectedFeedProject,
} from "./types.js";
