-- K-10c: события изменений, кандидаты в уведомления и уведомления со статусом доставки.
-- Документ контракта v1 целиком хранится в data (jsonb); колонки — для поиска, порядка и ограничений.
-- Внешних ключей на companies и между таблицами нет: события и уведомления бывают по модельным
-- компаниям без сохранённого профиля, а порядок записи задают вызывающие потоки (K-20b, K-21a, K-30a).

CREATE TABLE change_events (
  id           text PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('rulepack_version', 'regulation_document', 'profile_change')),
  company_id   text,
  occurred_at  timestamptz NOT NULL,
  data         jsonb NOT NULL
);

CREATE INDEX change_events_occurred ON change_events (occurred_at, id);

CREATE TABLE notification_candidates (
  id               text PRIMARY KEY,
  company_id       text NOT NULL,
  change_event_id  text NOT NULL,
  dedup_key        text NOT NULL,
  created_at       timestamptz NOT NULL,
  data             jsonb NOT NULL,
  UNIQUE (company_id, dedup_key)
);

CREATE TABLE notifications (
  id               text PRIMARY KEY,
  candidate_id     text NOT NULL,
  company_id       text NOT NULL,
  idempotency_key  text NOT NULL UNIQUE,
  status           text NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'suppressed')),
  attempts         integer NOT NULL CHECK (attempts >= 0),
  created_at       timestamptz NOT NULL,
  sent_at          timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  data             jsonb NOT NULL,
  CHECK (status <> 'sent' OR sent_at IS NOT NULL),
  CHECK (status <> 'failed' OR data ? 'error')
);

-- Очередь отправки: только queued, в порядке создания.
CREATE INDEX notifications_queue ON notifications (created_at, id) WHERE status = 'queued';
