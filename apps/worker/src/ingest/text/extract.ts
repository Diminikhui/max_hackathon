import { type FetchLike, RegulationClientError } from "../client/index.js";
import type { ExtractedProjectText } from "./types.js";

const TEXT_FIELDS = new Set([
  "annotation",
  "description",
  "projecttext",
  "projectcontent",
  "text",
  "content",
  "fulltext",
  "documenttext",
  "textcontent",
  "acttext",
]);
const BLOCK_TAG =
  /<\/?(?:address|article|aside|blockquote|br|div|h[1-6]|hr|li|main|ol|p|pre|section|table|td|th|tr|ul)\b[^>]*>/gi;
const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
const TAG = /<[^>]*>/g;
const ENTITY = /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi;
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntity(entity: string): string {
  const lower = entity.toLowerCase();
  if (lower.startsWith("#x")) {
    const code = Number.parseInt(lower.slice(2), 16);
    return Number.isSafeInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  }
  if (lower.startsWith("#")) {
    const code = Number.parseInt(lower.slice(1), 10);
    return Number.isSafeInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  }
  return NAMED_ENTITIES[lower] ?? "";
}

/** Converts untrusted HTML/plain text to inert, compact plain text. */
export function toPlainProjectText(value: string): string {
  return value
    .replace(COMMENT, " ")
    .replace(SCRIPT_OR_STYLE, " ")
    .replace(BLOCK_TAG, "\n")
    .replace(TAG, " ")
    .replace(ENTITY, (_, entity: string) => decodeEntity(entity))
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export interface TextExtractionOptions {
  maxCharacters?: number;
  maxDepth?: number;
  maxNodes?: number;
}

/** Extracts only allow-listed textual fields from an untrusted project-stage JSON response. */
export function extractProjectText(payload: unknown, options: TextExtractionOptions = {}): ExtractedProjectText {
  const maxCharacters = options.maxCharacters ?? 200_000;
  const maxDepth = options.maxDepth ?? 8;
  const maxNodes = options.maxNodes ?? 10_000;
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) throw new TypeError("maxCharacters must be positive");
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new TypeError("maxDepth must be non-negative");
  if (!Number.isInteger(maxNodes) || maxNodes < 1) throw new TypeError("maxNodes must be positive");

  const paragraphs: string[] = [];
  const paths: string[] = [];
  const seenParagraphs = new Set<string>();
  let nodes = 0;
  let characters = 0;
  let truncated = false;

  const append = (raw: string, path: string) => {
    const plain = toPlainProjectText(raw);
    if (!plain || seenParagraphs.has(plain)) return;
    const separatorLength = paragraphs.length === 0 ? 0 : 2;
    const available = maxCharacters - characters - separatorLength;
    if (available <= 0) {
      truncated = true;
      return;
    }
    const value = plain.length > available ? plain.slice(0, available).trimEnd() : plain;
    if (plain.length > available) truncated = true;
    if (!value) return;
    seenParagraphs.add(plain);
    paragraphs.push(value);
    paths.push(path);
    characters += separatorLength + value.length;
  };

  const visit = (value: unknown, path: string, depth: number, collectStrings: boolean): void => {
    if (truncated || depth > maxDepth) {
      if (depth > maxDepth) truncated = true;
      return;
    }
    nodes++;
    if (nodes > maxNodes) {
      truncated = true;
      return;
    }
    if (typeof value === "string") {
      if (collectStrings) append(value, path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        visit(item, `${path}[${index}]`, depth + 1, collectStrings);
      });
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      visit(child, `${path}.${key}`, depth + 1, collectStrings || TEXT_FIELDS.has(key.toLowerCase()));
    }
  };

  visit(payload, "$", 0, false);
  return { text: paragraphs.join("\n\n"), fieldPaths: paths, truncated };
}

export interface LoadProjectTextOptions extends TextExtractionOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  stageIndex?: number;
  timeoutMs?: number;
}

/** Loads the public project-stage JSON and extracts inert text from known fields. */
export async function loadProjectText(
  projectId: string,
  options: LoadProjectTextOptions = {},
): Promise<ExtractedProjectText> {
  const id = projectId.trim();
  if (!id || id.length > 200) throw new RegulationClientError("INVALID_INPUT", "Invalid portal project id");
  const stageIndex = options.stageIndex ?? 0;
  if (!Number.isInteger(stageIndex) || stageIndex < 0) {
    throw new RegulationClientError("INVALID_INPUT", "stageIndex must be a non-negative integer");
  }
  const baseUrl = (options.baseUrl ?? "https://regulation.gov.ru").replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(
      `${baseUrl}/api/public/PublicProjects/GetProjectStageInfo/${encodeURIComponent(id)}/${stageIndex}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) },
    );
  } catch (cause) {
    const timeout = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
    throw new RegulationClientError(
      timeout ? "DEPENDENCY_TIMEOUT" : "DEPENDENCY_UNAVAILABLE",
      "Project text request failed",
      {
        cause,
      },
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const code =
      response.status === 429 ? "RATE_LIMITED" : response.status >= 500 ? "DEPENDENCY_UNAVAILABLE" : "INVALID_INPUT";
    throw new RegulationClientError(code, `regulation.gov.ru returned ${response.status} for project text`, {
      status: response.status,
    });
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new RegulationClientError("DEPENDENCY_UNAVAILABLE", "Project text response is not JSON", { cause });
  }
  const extracted = extractProjectText(payload, options);
  if (!extracted.text) {
    throw new RegulationClientError("DEPENDENCY_UNAVAILABLE", "Project text response has no supported text fields");
  }
  return extracted;
}
