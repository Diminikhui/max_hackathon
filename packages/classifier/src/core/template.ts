import type { DocumentDraft } from "./schema.js";
import type { DocumentInput, LlmProvider, LlmRequest } from "./types.js";

export function templateDraft(document: Readonly<DocumentInput>): DocumentDraft {
  return { summary: document.title.trim().slice(0, 2000) };
}

/** Резервный провайдер без ИИ: использует только заголовок документа. */
export class TemplateProvider implements LlmProvider {
  readonly name = "template" as const;

  async generate({ document }: LlmRequest): Promise<unknown> {
    return templateDraft(document);
  }
}
