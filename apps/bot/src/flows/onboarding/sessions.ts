import type { OnboardingSessions, PendingProfile } from "./types.js";

/** Хранение в памяти процесса: для тестов и демо. После перезапуска диалог попросит ИНН заново. */
export class InMemoryOnboardingSessions implements OnboardingSessions {
  readonly #pending = new Map<string, PendingProfile>();
  readonly #companies = new Map<string, string>();

  async pendingProfile(dialogId: string): Promise<PendingProfile | undefined> {
    const pending = this.#pending.get(dialogId);
    return pending === undefined ? undefined : structuredClone(pending);
  }

  async setPendingProfile(dialogId: string, pending: PendingProfile | undefined): Promise<void> {
    if (pending === undefined) this.#pending.delete(dialogId);
    else this.#pending.set(dialogId, structuredClone(pending));
  }

  async companyOf(dialogId: string): Promise<string | undefined> {
    return this.#companies.get(dialogId);
  }

  async bindCompany(dialogId: string, companyId: string): Promise<void> {
    this.#companies.set(dialogId, companyId);
  }
}
