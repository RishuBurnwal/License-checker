/**
 * Database boundary (decision SL-20, FEAT-001).
 *
 * `Repository` depends on this `DbAdapter` interface instead of binding
 * directly to Cloudflare's `D1Database`. The interface describes EXACTLY the
 * subset of the D1 API that `repository.ts` uses today:
 *
 *   - `prepare(sql).bind(...).first()/all()/run()`
 *   - `batch([...])`
 *   - `exec(sql)`
 *   - the `result.results ?? []`, `result.meta.changes` and
 *     `result.meta.last_row_id` return shapes the repository reads.
 *
 * `D1Adapter` is a byte-for-byte pass-through over a real `D1Database`: every
 * method delegates 1:1 with no logic and no transformation, so the production
 * D1 path is behaviourally unchanged. A second adapter (node:sqlite) can satisfy
 * the same interface for the Node/Vercel entry point without touching the
 * repository.
 */

export type DbValue = string | number | null;

export interface DbPreparedStatement {
  bind(...values: DbValue[]): DbPreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[]; success?: boolean; meta?: unknown }>;
  run(): Promise<{ meta: { changes: number; last_row_id: number } }>;
}

export interface DbAdapter {
  prepare(sql: string): DbPreparedStatement;
  batch(statements: DbPreparedStatement[]): Promise<Array<{ meta: { changes: number; last_row_id: number } }>>;
  exec(sql: string): Promise<unknown>;
}

/**
 * Pass-through adapter over a Cloudflare `D1Database`. No logic, no transform:
 * each call forwards to the underlying D1 object exactly as the repository used
 * to call it directly.
 */
class D1PreparedStatement implements DbPreparedStatement {
  constructor(private readonly stmt: D1PreparedStatement_) {}

  bind(...values: DbValue[]): DbPreparedStatement {
    return new D1PreparedStatement(this.stmt.bind(...values));
  }

  first<T = unknown>(): Promise<T | null> {
    return this.stmt.first<T>();
  }

  all<T = unknown>(): Promise<{ results: T[]; success?: boolean; meta?: unknown }> {
    return this.stmt.all<T>();
  }

  run(): Promise<{ meta: { changes: number; last_row_id: number } }> {
    return this.stmt.run() as unknown as Promise<{ meta: { changes: number; last_row_id: number } }>;
  }
}

export class D1Adapter implements DbAdapter {
  constructor(private readonly db: D1Database) {}

  prepare(sql: string): DbPreparedStatement {
    return new D1PreparedStatement(this.db.prepare(sql));
  }

  batch(statements: DbPreparedStatement[]): Promise<Array<{ meta: { changes: number; last_row_id: number } }>> {
    return this.db.batch(statements as unknown as D1PreparedStatement_[]) as unknown as Promise<
      Array<{ meta: { changes: number; last_row_id: number } }>
    >;
  }

  exec(sql: string): Promise<unknown> {
    return this.db.exec(sql);
  }
}

// Local alias for the D1 prepared-statement type, kept distinct from this
// module's own `D1PreparedStatement` wrapper class.
type D1PreparedStatement_ = ReturnType<D1Database["prepare"]>;
