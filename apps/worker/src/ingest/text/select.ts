import type { NpaProject } from "../client/index.js";
import {
  EARLY_SIGNAL_STATUS,
  type FeedMatch,
  type FeedSelectionMetrics,
  type FeedSelectionRule,
  type LabeledFeedProject,
  type SelectedFeedProject,
} from "./types.js";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Case-folds Russian text, treats е/ё equally and makes punctuation a token boundary. */
export function normalizeSignalText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е")
    .replace(/[\p{P}\p{S}_]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueText(values: string[] | undefined, label: string): string[] {
  const result = new Set<string>();
  for (const value of values ?? []) {
    const prefix = value.trim().endsWith("*");
    const normalized = normalizeSignalText(prefix ? value.trim().slice(0, -1) : value);
    if (!normalized) throw new TypeError(`${label} contains an empty value`);
    if (prefix && (normalized.includes(" ") || normalized.length < 3)) {
      throw new TypeError(`${label} prefix must be one word of at least three characters`);
    }
    result.add(`${normalized}${prefix ? "*" : ""}`);
  }
  return [...result].sort(compareText);
}

function normalizeRule(rule: FeedSelectionRule): Required<FeedSelectionRule> {
  const id = rule.id.trim();
  if (!id) throw new TypeError("Feed rule id must not be empty");
  const sphereIds = [...new Set(rule.sphereIds ?? [])].sort((a, b) => a - b);
  if (sphereIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new TypeError(`Feed rule ${id} contains an invalid portal sphere id`);
  }
  const normalized = {
    id,
    sphereIds,
    titleKeywords: uniqueText(rule.titleKeywords, `Feed rule ${id} titleKeywords`),
    departments: uniqueText(rule.departments, `Feed rule ${id} departments`),
  };
  if (normalized.sphereIds.length + normalized.titleKeywords.length + normalized.departments.length === 0) {
    throw new TypeError(`Feed rule ${id} must contain at least one signal`);
  }
  return normalized;
}

function containsPhrase(text: string, phrase: string): boolean {
  if (phrase.endsWith("*")) {
    const prefix = phrase.slice(0, -1);
    return text.split(" ").some((word) => word.startsWith(prefix));
  }
  return ` ${text} `.includes(` ${phrase} `);
}

function matchesFor(project: NpaProject, rule: Required<FeedSelectionRule>): FeedMatch[] {
  const matches: FeedMatch[] = [];
  const projectSpheres = new Set(project.sphereIds);
  for (const sphereId of rule.sphereIds) {
    if (projectSpheres.has(sphereId)) matches.push({ ruleId: rule.id, kind: "sphere", value: String(sphereId) });
  }

  const title = normalizeSignalText(project.title ?? "");
  for (const keyword of rule.titleKeywords) {
    if (containsPhrase(title, keyword)) matches.push({ ruleId: rule.id, kind: "title_keyword", value: keyword });
  }

  const department = normalizeSignalText(project.department ?? "");
  for (const candidate of rule.departments) {
    if (containsPhrase(department, candidate)) {
      matches.push({ ruleId: rule.id, kind: "department", value: candidate });
    }
  }
  return matches;
}

/**
 * Selects portal projects by sphere OR title keyword OR department.
 * Output order is independent of input/rule order, making repeated runs directly comparable.
 */
export function selectFeedProjects(
  projects: readonly NpaProject[],
  rules: readonly FeedSelectionRule[],
): SelectedFeedProject[] {
  const normalizedRules = rules.map(normalizeRule).sort((a, b) => compareText(a.id, b.id));
  const ruleIds = new Set<string>();
  for (const rule of normalizedRules) {
    if (ruleIds.has(rule.id)) throw new TypeError(`Duplicate feed rule id: ${rule.id}`);
    ruleIds.add(rule.id);
  }

  const projectsById = new Map<string, NpaProject>();
  for (const project of projects) {
    if (projectsById.has(project.id)) throw new TypeError(`Duplicate portal project id: ${project.id}`);
    projectsById.set(project.id, project);
  }

  const selected: SelectedFeedProject[] = [];
  for (const project of [...projectsById.values()].sort((a, b) => compareText(a.id, b.id))) {
    const matches = normalizedRules.flatMap((rule) => matchesFor(project, rule));
    if (matches.length > 0) selected.push({ project, status: EARLY_SIGNAL_STATUS, matches });
  }
  return selected;
}

/** Measures misses and extra matches on an explicitly labeled control sample. */
export function measureFeedSelection(
  sample: readonly LabeledFeedProject[],
  rules: readonly FeedSelectionRule[],
): FeedSelectionMetrics {
  const selectedIds = new Set(
    selectFeedProjects(
      sample.map(({ project }) => project),
      rules,
    ).map(({ project }) => project.id),
  );
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  for (const item of sample) {
    const selected = selectedIds.has(item.project.id);
    if (selected && item.relevant) truePositive++;
    else if (selected) falsePositive++;
    else if (item.relevant) falseNegative++;
    else trueNegative++;
  }
  const precision = truePositive + falsePositive === 0 ? 1 : truePositive / (truePositive + falsePositive);
  const recall = truePositive + falseNegative === 0 ? 1 : truePositive / (truePositive + falseNegative);
  return { total: sample.length, truePositive, falsePositive, falseNegative, trueNegative, precision, recall };
}
