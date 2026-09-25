import type { LlmProvider, LlmRequest } from "./types.js";

/** Модельный тестовый двойник: возвращает заданный ответ или ошибку. */
export class TestDoubleProvider implements LlmProvider {
  readonly name = "test-double" as const;
  readonly calls: LlmRequest[] = [];

  constructor(private readonly reply: unknown | ((request: LlmRequest) => unknown | Promise<unknown>)) {}

  async generate(request: LlmRequest): Promise<unknown> {
    this.calls.push(request);
    if (this.reply instanceof Error) throw this.reply;
    return typeof this.reply === "function" ? this.reply(request) : this.reply;
  }
}
