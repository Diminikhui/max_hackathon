-- 2-09 / #248: durable-состояние пересчёта применимости по компании.
-- committed_revision — последняя зафиксированная ревизия; pending — операция, начатая, но не доведённая
-- (событие → снимок → фиксация), её доигрывает следующий исполнитель после сбоя.
-- lock_token/lock_expires_at — аренда: пересчёты одной компании идут строго по очереди, а запись
-- состояния разрешена только держателю действующей аренды (fencing).

CREATE TABLE recalculation_state (
  company_id          text PRIMARY KEY,
  committed_revision  integer NOT NULL DEFAULT 0 CHECK (committed_revision >= 0),
  pending             jsonb,
  lock_token          text,
  lock_expires_at     timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (pending IS NULL OR (pending->>'revision')::integer = committed_revision + 1),
  CHECK ((lock_token IS NULL) = (lock_expires_at IS NULL))
);
