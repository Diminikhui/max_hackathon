export type ProviderName = "template" | "gigachat" | "local" | "test-double";

export interface DocumentInput {
  id: string;
  title: string;
  /** Текст внешнего документа — недоверенные данные. */
  text: string;
  /** Ссылка на официальный первоисточник; модель не выбирает её сама. */
  sourceUrl: string;
  /** Модельный или синтетический документ помечается при выводе. */
  isModel: boolean;
}

export interface LlmRequest {
  document: Readonly<DocumentInput>;
  /** Схема, которой должен соответствовать ответ. Провайдер может передать её модели. */
  responseSchema: Readonly<Record<string, unknown>>;
  /** Доверенное дополнительное системное указание от вызывающего сценария; никогда не берётся из документа. */
  instruction?: string;
}

export interface LlmProvider {
  readonly name: ProviderName;
  /** Непроверенные данные; валидация всегда выполняется в классификаторе. */
  generate(request: LlmRequest): Promise<unknown>;
}

export interface ClassifierProfile<TDraft extends { summary: string }> {
  /** Строгая JSON Schema ответа провайдера. */
  responseSchema: Readonly<Record<string, unknown>>;
  /** Детерминированный ответ без ИИ, проходящий ту же схему. */
  template(document: Readonly<DocumentInput>): TDraft;
  /** Сколько ждать ответа провайдера, мс; по истечении — откат на шаблон. По умолчанию 30 000. */
  timeoutMs?: number;
}

export interface Classification<TDraft extends { summary: string } = { summary: string }> {
  documentId: string;
  summary: string;
  draft: TDraft;
  sourceUrl: string;
  /** Автоматически подготовленный черновик, не юридическое заключение. */
  automated: true;
  reviewRequired: true;
  isModel: boolean;
  provider: ProviderName;
  usedFallback: boolean;
}
