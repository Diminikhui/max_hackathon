// K-30b. Справочник «компания → чат» для контура уведомлений (порт `RecipientDirectory.chatFor` worker K-30a).
// Строится от текущей привязки диалога к компании: при смене компании (#310) чат перестаёт получать уведомления
// прежней компании. Бот и контур уведомлений работают в одном процессе и читают один экземпляр справочника.

/** Порт справочника. Реализация на PostgreSQL (#312) — `PostgresChatDirectoryRepository` из @max-hackathon/storage. */
export interface ChatDirectory {
  /** Запомнить, что чат сейчас работает с компанией; `undefined` снимает привязку. */
  track(chatId: string, companyId: string | undefined): Promise<void>;
  /** Чат, в котором компанию выбрали последним. Нет чата — компания не подписана, уведомление не создаётся. */
  chatFor(companyId: string): Promise<string | undefined>;
}

/** Хранение в памяти процесса: для тестов. После перезапуска справочник пуст. */
export class DialogChatDirectory implements ChatDirectory {
  /** Чат → текущая компания. */
  readonly #companyOfChat = new Map<string, string>();
  /** Компания → чаты в порядке последней привязки (последний — в конце). */
  readonly #chatsOfCompany = new Map<string, string[]>();

  async track(chatId: string, companyId: string | undefined): Promise<void> {
    const previous = this.#companyOfChat.get(chatId);
    if (previous !== undefined) this.#detach(previous, chatId);
    if (companyId === undefined) {
      this.#companyOfChat.delete(chatId);
      return;
    }
    this.#companyOfChat.set(chatId, companyId);
    this.#chatsOfCompany.set(companyId, [...(this.#chatsOfCompany.get(companyId) ?? []), chatId]);
  }

  async chatFor(companyId: string): Promise<string | undefined> {
    return this.#chatsOfCompany.get(companyId)?.at(-1);
  }

  #detach(companyId: string, chatId: string): void {
    const rest = (this.#chatsOfCompany.get(companyId) ?? []).filter((chat) => chat !== chatId);
    if (rest.length === 0) this.#chatsOfCompany.delete(companyId);
    else this.#chatsOfCompany.set(companyId, rest);
  }
}
