// K-29. Получатель демо-уведомления — чат, где нажата кнопка. Класс подходит к порту `RecipientDirectory`
// контура K-30a (`apps/worker/src/notify/types.ts`) без переходника.

export interface ChatDirectory {
  chatFor(companyId: string): Promise<string | undefined>;
}

/**
 * Справочник «компания → чат» с чатами демо-нажатий поверх основного (онбординг K-24a). Демо-чат важнее:
 * уведомление должно прийти туда, где проверяющий нажал кнопку. Хранится в памяти процесса: после перезапуска
 * следующее нажатие запишет чат заново.
 */
export class DemoRecipientDirectory implements ChatDirectory {
  readonly #chats = new Map<string, string>();
  readonly #base: ChatDirectory | undefined;

  constructor(base?: ChatDirectory) {
    this.#base = base;
  }

  remember(companyId: string, chatId: string): void {
    this.#chats.set(companyId, chatId);
  }

  async chatFor(companyId: string): Promise<string | undefined> {
    return this.#chats.get(companyId) ?? (await this.#base?.chatFor(companyId));
  }
}
