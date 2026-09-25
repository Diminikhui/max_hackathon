import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { type DocumentDraft, DRAFT_SCHEMA } from "./schema.js";
import { TemplateProvider, templateDraft } from "./template.js";
import type { Classification, ClassifierProfile, DocumentInput, LlmProvider, LlmRequest } from "./types.js";

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats.default(ajv);

/** Зависший провайдер не должен лишать пользователя ответа: по истечении срока работает шаблон. */
export const DEFAULT_TIMEOUT_MS = 30_000;

async function generateWithTimeout(provider: LlmProvider, request: LlmRequest, timeoutMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Provider response timed out")), timeoutMs);
  });
  try {
    return await Promise.race([provider.generate(request), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const DEFAULT_PROFILE: ClassifierProfile<DocumentDraft> = {
  responseSchema: DRAFT_SCHEMA,
  template: templateDraft,
};

function validateInput(document: DocumentInput): void {
  if (!document.id.trim() || !document.title.trim()) {
    throw new Error("Document id and title are required");
  }
  let url: URL;
  try {
    url = new URL(document.sourceUrl);
  } catch {
    throw new Error("Document sourceUrl must be an HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Document sourceUrl must be an HTTP(S) URL");
  }
}

/** Ответ провайдера и шаблона проходят одну схему. Расширенный профиль задаёт K-19d. */
export async function classifyDocument<TDraft extends DocumentDraft>(
  document: DocumentInput,
  provider: LlmProvider = new TemplateProvider(),
  profile: ClassifierProfile<TDraft> = DEFAULT_PROFILE as ClassifierProfile<TDraft>,
): Promise<Classification<TDraft>> {
  validateInput(document);
  const validateDraft = ajv.compile<TDraft>(profile.responseSchema);
  const request = { document, responseSchema: profile.responseSchema };
  let draft: TDraft;
  let usedFallback = false;

  try {
    const response = await generateWithTimeout(provider, request, profile.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (!validateDraft(response)) throw new Error("Invalid provider response");
    draft = response;
  } catch {
    usedFallback = provider.name !== "template";
    const response: unknown = profile.template(document);
    if (!validateDraft(response)) throw new Error("Template response does not match the schema");
    draft = response;
  }

  return {
    documentId: document.id,
    summary: draft.summary,
    draft,
    sourceUrl: document.sourceUrl,
    automated: true,
    reviewRequired: true,
    isModel: document.isModel || provider.name === "test-double",
    provider: usedFallback ? "template" : provider.name,
    usedFallback,
  };
}
