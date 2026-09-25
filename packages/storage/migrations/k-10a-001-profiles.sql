-- K-10a: профили компаний и факты.
-- Документ целиком хранится в data (jsonb) — чтение возвращает ровно то, что записано (контракт v1);
-- отдельные колонки нужны для поиска и ограничений.

CREATE TABLE companies (
  company_id  text PRIMARY KEY,
  inn         text NOT NULL UNIQUE CHECK (inn ~ '^[0-9]{10}([0-9]{2})?$'),
  is_model    boolean NOT NULL,
  data        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE facts (
  id          text PRIMARY KEY,
  company_id  text NOT NULL REFERENCES companies (company_id) ON DELETE CASCADE,
  key         text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('official', 'declared', 'derived', 'scenario')),
  data        jsonb NOT NULL,
  position    integer NOT NULL
);

CREATE INDEX facts_company_key ON facts (company_id, key);
