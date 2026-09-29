-- #312 (вариант Б K-30b): состояние бота переживает перезапуск процесса.
-- bot_dialogs — диалог MAX: состояние машины, найденный, но не подтверждённый профиль, привязанная компания и
-- пропущенные вопросы уточнения (K-09). bot_chat_companies — справочник «чат → компания» для push: чат компании —
-- последний по tracked_seq. notification_settings — настройки уведомлений компании (K-24c); нет строки — всё включено.

CREATE TABLE bot_dialogs (
  dialog_id        text PRIMARY KEY,
  state            text,
  pending_profile  jsonb,
  company_id       text,
  clarify_skipped  text[] NOT NULL DEFAULT '{}',
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE bot_chat_companies_seq;

CREATE TABLE bot_chat_companies (
  chat_id      text PRIMARY KEY,
  company_id   text NOT NULL,
  tracked_seq  bigint NOT NULL DEFAULT nextval('bot_chat_companies_seq'),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bot_chat_companies_by_company ON bot_chat_companies (company_id, tracked_seq DESC);

CREATE TABLE notification_settings (
  company_id     text PRIMARY KEY,
  enabled        boolean NOT NULL,
  early_signals  boolean NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
