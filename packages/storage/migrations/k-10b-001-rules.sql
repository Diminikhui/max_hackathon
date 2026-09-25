-- K-10b: версии пакетов правил и их записи (Requirement v1).
-- Опубликованная версия неизменяема: пересчёт по старой версии воспроизводим.

CREATE TABLE rulepack_versions (
  pack_id       text NOT NULL,
  version       integer NOT NULL CHECK (version >= 1),
  published_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pack_id, version)
);

CREATE TABLE requirements (
  pack_id   text NOT NULL,
  version   integer NOT NULL,
  id        text NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('obligation', 'opportunity')),
  position  integer NOT NULL,
  data      jsonb NOT NULL,
  PRIMARY KEY (pack_id, version, id),
  FOREIGN KEY (pack_id, version) REFERENCES rulepack_versions (pack_id, version) ON DELETE CASCADE
);
