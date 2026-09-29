// Состояние бота на PostgreSQL (#312, вариант Б K-30b): после перезапуска процесса диалог продолжается с того же
// места. Классы структурно совместимы с портами бота (apps/bot): `OnboardingSessions` и хранение состояния диалога,
// `ClarifySkipStore` (K-09), справочник «чат → компания» и `NotificationSettingsStore` (K-24c). storage не зависит
// от бота, поэтому профиль в ожидании подтверждения хранится как jsonb, а состояние — строкой: проверяет его бот.

import type { SqlClient } from "../db/sql-client.js";

/** Диалог: состояние машины, привязка к компании и профиль в ожидании подтверждения. */
export class PostgresBotDialogRepository<Pending = unknown> {
  constructor(private readonly db: SqlClient) {}

  async stateOf(dialogId: string): Promise<string | undefined> {
    const { rows } = await this.db.query<{ state: string | null }>(
      "SELECT state FROM bot_dialogs WHERE dialog_id = $1",
      [dialogId],
    );
    return rows[0]?.state ?? undefined;
  }

  async saveState(dialogId: string, state: string): Promise<void> {
    await this.db.query(
      `INSERT INTO bot_dialogs (dialog_id, state) VALUES ($1, $2)
       ON CONFLICT (dialog_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [dialogId, state],
    );
  }

  async pendingProfile(dialogId: string): Promise<Pending | undefined> {
    const { rows } = await this.db.query<{ pending_profile: Pending | null }>(
      "SELECT pending_profile FROM bot_dialogs WHERE dialog_id = $1",
      [dialogId],
    );
    return rows[0]?.pending_profile ?? undefined;
  }

  async setPendingProfile(dialogId: string, pending: Pending | undefined): Promise<void> {
    await this.db.query(
      `INSERT INTO bot_dialogs (dialog_id, pending_profile) VALUES ($1, $2)
       ON CONFLICT (dialog_id) DO UPDATE SET pending_profile = EXCLUDED.pending_profile, updated_at = now()`,
      [dialogId, pending === undefined ? null : JSON.stringify(pending)],
    );
  }

  async companyOf(dialogId: string): Promise<string | undefined> {
    const { rows } = await this.db.query<{ company_id: string | null }>(
      "SELECT company_id FROM bot_dialogs WHERE dialog_id = $1",
      [dialogId],
    );
    return rows[0]?.company_id ?? undefined;
  }

  /** Повторный вызов для того же диалога (смена компании, #310) заменяет привязку. */
  async bindCompany(dialogId: string, companyId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO bot_dialogs (dialog_id, company_id) VALUES ($1, $2)
       ON CONFLICT (dialog_id) DO UPDATE SET company_id = EXCLUDED.company_id, updated_at = now()`,
      [dialogId, companyId],
    );
  }
}

/** Пропущенные в текущем заходе вопросы уточнения (порт `ClarifySkipStore` K-09). */
export class PostgresClarifySkipRepository {
  constructor(private readonly db: SqlClient) {}

  async get(dialogId: string): Promise<readonly string[]> {
    const { rows } = await this.db.query<{ clarify_skipped: string[] }>(
      "SELECT clarify_skipped FROM bot_dialogs WHERE dialog_id = $1",
      [dialogId],
    );
    return rows[0]?.clarify_skipped ?? [];
  }

  async set(dialogId: string, keys: readonly string[]): Promise<void> {
    await this.db.query(
      `INSERT INTO bot_dialogs (dialog_id, clarify_skipped) VALUES ($1, $2)
       ON CONFLICT (dialog_id) DO UPDATE SET clarify_skipped = EXCLUDED.clarify_skipped, updated_at = now()`,
      [dialogId, [...keys]],
    );
  }
}

/**
 * Справочник «компания → чат» для push (порт `RecipientDirectory.chatFor` K-30a). Чат компании — тот, где её выбрали
 * последним: каждый `track` переносит чат в конец очереди, `undefined` снимает привязку.
 */
export class PostgresChatDirectoryRepository {
  constructor(private readonly db: SqlClient) {}

  async track(chatId: string, companyId: string | undefined): Promise<void> {
    if (companyId === undefined) {
      await this.db.query("DELETE FROM bot_chat_companies WHERE chat_id = $1", [chatId]);
      return;
    }
    await this.db.query(
      `INSERT INTO bot_chat_companies (chat_id, company_id) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE
         SET company_id = EXCLUDED.company_id, tracked_seq = nextval('bot_chat_companies_seq'), updated_at = now()`,
      [chatId, companyId],
    );
  }

  async chatFor(companyId: string): Promise<string | undefined> {
    const { rows } = await this.db.query<{ chat_id: string }>(
      "SELECT chat_id FROM bot_chat_companies WHERE company_id = $1 ORDER BY tracked_seq DESC LIMIT 1",
      [companyId],
    );
    return rows[0]?.chat_id;
  }
}

/** Настройки уведомлений компании. Форма — `NotificationSettings` бота (K-24c) и политики частоты K-20b. */
export interface StoredNotificationSettings {
  readonly enabled: boolean;
  readonly earlySignals: boolean;
}

/** Порт `NotificationSettingsStore` (K-24c): тот же экземпляр читает контур уведомлений K-30a. */
export class PostgresNotificationSettingsRepository {
  constructor(private readonly db: SqlClient) {}

  async settingsFor(companyId: string): Promise<StoredNotificationSettings | undefined> {
    const { rows } = await this.db.query<{ enabled: boolean; early_signals: boolean }>(
      "SELECT enabled, early_signals FROM notification_settings WHERE company_id = $1",
      [companyId],
    );
    const row = rows[0];
    return row === undefined ? undefined : { enabled: row.enabled, earlySignals: row.early_signals };
  }

  async save(companyId: string, settings: StoredNotificationSettings): Promise<void> {
    await this.db.query(
      `INSERT INTO notification_settings (company_id, enabled, early_signals) VALUES ($1, $2, $3)
       ON CONFLICT (company_id) DO UPDATE
         SET enabled = EXCLUDED.enabled, early_signals = EXCLUDED.early_signals, updated_at = now()`,
      [companyId, settings.enabled, settings.earlySignals],
    );
  }
}
