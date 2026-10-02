/**
 * Node/Vercel database adapter (decision SL-20, FEAT-003).
 *
 * `NodeSqliteAdapter` implements the SAME {@link DbAdapter} boundary that
 * `D1Adapter` implements, but over Node's built-in `node:sqlite`
 * (`DatabaseSync`, Node 22+) instead of Cloudflare's `D1Database`. It lets the
 * UNCHANGED Hono app from `src/index.ts` run on a Node/Vercel target backed by a
 * local SQLite file, so the exact same route -> service -> repository code (and
 * SQL) executes on both runtimes.
 *
 * This is modelled on `worker/test/helpers/d1.ts`, which has driven the whole
 * worker suite against real SQLite since Phase 1 — the return shapes
 * (`results`, `meta.changes`, `meta.last_row_id`) and the `batch()` ->
 * BEGIN/COMMIT/ROLLBACK transaction mapping are identical here. No new runtime
 * dependency is introduced: `node:sqlite` ships with Node.
 *
 * Fidelity: this is real SQLite, not workerd/D1. Engine-level behaviour is
 * faithful (CHECK/UNIQUE constraints, CTEs, `ON CONFLICT`, ISO-8601 string
 * comparisons, foreign keys once `PRAGMA foreign_keys = ON` runs). D1-specific
 * surface is NOT emulated: no D1 query limits, no D1 error codes/`cause`
 * objects, no replication lag, and `batch()` is a single local transaction
 * rather than D1's own batching primitive. Those differences are documented and
 * are not relied on by `repository.ts`.
 */
import type { DatabaseSync } from "node:sqlite";
import type { DbAdapter, DbPreparedStatement, DbValue } from "./adapter";

/**
 * Prepared-statement wrapper. Mirrors exactly the subset of the D1
 * prepared-statement API that `repository.ts` uses: `bind(...).first()/all()/run()`.
 * `node:sqlite` compiles eagerly on `prepare()`, so SQL is re-compiled per call
 * here (the same approach the test shim uses); the repository prepares a fresh
 * statement for every query, so there is no hot-loop cost difference.
 */
class NodeSqliteStatement implements DbPreparedStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: DbValue[] = []
  ) {}

  bind(...values: DbValue[]): DbPreparedStatement {
    // D1 accepts `undefined` bindings and stores NULL; match that so the Node
    // path behaves identically to the Worker path.
    return new NodeSqliteStatement(
      this.db,
      this.sql,
      values.map((value) => (value === undefined ? null : value)) as DbValue[]
    );
  }

  async first<T = unknown>(): Promise<T | null> {
    const rows = this.db.prepare(this.sql).all(...this.params) as T[];
    return rows.length > 0 ? rows[0] : null;
  }

  async all<T = unknown>(): Promise<{ results: T[]; success?: boolean; meta?: unknown }> {
    const rows = this.db.prepare(this.sql).all(...this.params) as T[];
    return { results: rows, success: true, meta: { changes: 0, last_row_id: 0 } };
  }

  async run(): Promise<{ meta: { changes: number; last_row_id: number } }> {
    const result = this.db.prepare(this.sql).run(...this.params);
    return {
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid)
      }
    };
  }
}

export class NodeSqliteAdapter implements DbAdapter {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): DbPreparedStatement {
    return new NodeSqliteStatement(this.db, sql);
  }

  /**
   * D1 runs a batch in a single implicit transaction. We wrap the statements in
   * an explicit BEGIN/COMMIT and roll back on error, which gives any
   * `repository.batch()` call sites the same all-or-nothing atomicity they rely
   * on under D1.
   */
  async batch(
    statements: DbPreparedStatement[]
  ): Promise<Array<{ meta: { changes: number; last_row_id: number } }>> {
    this.db.exec("BEGIN");
    try {
      const results: Array<{ meta: { changes: number; last_row_id: number } }> = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql: string): Promise<unknown> {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }
}
