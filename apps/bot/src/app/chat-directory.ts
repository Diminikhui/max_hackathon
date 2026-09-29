// K-30b. Справочник «компания → чат» для контура уведомлений (порт `RecipientDirectory.chatFor` worker K-30a).
// Строится от текущей привязки диалога к компании: при смене компании (#310) чат перестаёт получать уведомления
// прежней компании. Хранится в памяти процесса: бот и контур уведомлений работают в одном процессе.

export class DialogChatDirectory {
  /** Чат → текущая компания. */
  readonly #companyOfChat = new Map<string, string>();
  /** Компания → чаты в порядке последней привязки (последний — в конце). */
  readonly #chatsOfCompany = new Map<string, string[]>();

  /** Запомнить, что чат сейчас работает с компанией; `undefined` снимает привязку. */
  track(chatId: string, companyId: string | undefined): void {
    const previous = this.#companyOfChat.get(chatId);
    if (previous !== undefined) this.#detach(previous, chatId);
    if (companyId === undefined) {
      this.#companyOfChat.delete(chatId);
      return;
    }
    this.#companyOfChat.set(chatId, companyId);
    this.#chatsOfCompany.set(companyId, [...(this.#chatsOfCompany.get(companyId) ?? []), chatId]);
  }

  /** Порт `DemoRecipientDirectory.remember` демо-сценария K-29: нажатие кнопки привязывает чат к компании. */
  remember(companyId: string, chatId: string): void {
    this.track(chatId, companyId);
  }

  /** Чат, в котором компанию выбрали последним. Нет чата — компания не подписана, уведомление не создаётся. */
  async chatFor(companyId: string): Promise<string | undefined> {
    return this.#chatsOfCompany.get(companyId)?.at(-1);
  }

  #detach(companyId: string, chatId: string): void {
    const rest = (this.#chatsOfCompany.get(companyId) ?? []).filter((chat) => chat !== chatId);
    if (rest.length === 0) this.#chatsOfCompany.delete(companyId);
    else this.#chatsOfCompany.set(companyId, rest);
  }
}
