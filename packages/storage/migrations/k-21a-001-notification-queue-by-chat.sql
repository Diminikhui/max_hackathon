-- K-21a / 3-05 / #247: честная очередь отправки. chat_id вынесен из документа в вычисляемую колонку, индекс
-- по (chat_id, created_at, id) среди queued позволяет перебирать чаты skip scan-ом и брать голову
-- каждого чата, не читая длинный префикс одного чата целиком.

ALTER TABLE notifications ADD COLUMN chat_id text GENERATED ALWAYS AS (data #>> '{recipient,chatId}') STORED;

CREATE INDEX notifications_queue_by_chat ON notifications (chat_id, created_at, id) WHERE status = 'queued';
