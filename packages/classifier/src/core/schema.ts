/** Минимальный черновик K-19a. Расширенная схема воздействия — зона K-19d. */
export const DRAFT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 2000 },
  },
  required: ["summary"],
  additionalProperties: false,
} as const;

export interface DocumentDraft {
  summary: string;
}
