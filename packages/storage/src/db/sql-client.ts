// Общий интерфейс подключения к PostgreSQL для всех репозиториев пакета storage.
// Реализации: node-postgres (pg) для приложения и PGlite (PostgreSQL в WASM) для тестов.

import pg from "pg";

export interface QueryResult<Row> {
  rows: Row[];
}

export interface SqlClient {
  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
  /** Скрипт из нескольких SQL-выражений без параметров (миграции). */
  exec(sql: string): Promise<void>;
  /** Выполнить fn в одной транзакции: при исключении — откат. Вложенные вызовы не поддерживаются. */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}

/** Клиент поверх пула node-postgres. Строка подключения — из DATABASE_URL. */
export const createPgClient = (connectionString: string): SqlClient & { close(): Promise<void> } => {
  const pool = new pg.Pool({ connectionString });
  return {
    query: async <Row>(sql: string, params?: unknown[]) => {
      const result = await pool.query(sql, params);
      return { rows: result.rows as Row[] };
    },
    exec: async (sql) => {
      await pool.query(sql);
    },
    transaction: async (fn) => {
      const connection = await pool.connect();
      const tx: SqlClient = {
        query: async <Row>(sql: string, params?: unknown[]) => {
          const result = await connection.query(sql, params);
          return { rows: result.rows as Row[] };
        },
        exec: async (sql) => {
          await connection.query(sql);
        },
        transaction: () => Promise.reject(new Error("Вложенные транзакции не поддерживаются")),
      };
      try {
        await connection.query("BEGIN");
        const value = await fn(tx);
        await connection.query("COMMIT");
        return value;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    },
    close: () => pool.end(),
  };
};

/** Минимальный контракт PGlite, который нужен адаптеру: не тянет PGlite в зависимости приложения. */
interface PgliteQueryable {
  query<Row>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  exec(sql: string): Promise<unknown>;
}

export interface PgliteLike extends PgliteQueryable {
  transaction<T>(fn: (tx: PgliteQueryable) => Promise<T>): Promise<T>;
}

/** Клиент поверх PGlite — для тестов и локального запуска без сервера PostgreSQL. */
export const createPgliteClient = (db: PgliteLike): SqlClient => ({
  query: <Row>(sql: string, params?: unknown[]) => db.query<Row>(sql, params),
  exec: async (sql) => {
    await db.exec(sql);
  },
  transaction: (fn) =>
    db.transaction((tx) =>
      fn({
        query: <Row>(sql: string, params?: unknown[]) => tx.query<Row>(sql, params),
        exec: async (sql) => {
          await tx.exec(sql);
        },
        transaction: () => Promise.reject(new Error("Вложенные транзакции не поддерживаются")),
      }),
    ),
});
