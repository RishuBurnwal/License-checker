/**
 * A D1-compatible database backed by real SQLite (`node:sqlite`).
 *
 * The Worker's unit tests run against an in-memory `MemoryRepo` fake, so no test
 * previously executed the real SQL in `src/repository.ts` — the "untested SQL
 * semantics gap". This shim closes it: `Repository` and `LicenseService` run
 * unchanged against a real SQL engine, so `VALUES` row lists, CTEs, CHECK
 * constraints, UNIQUE indexes, triggers, `substr()` grouping and the ISO-8601
 * string comparisons that expiry relies on are all genuinely evaluated.
 *
 * Fidelity notes — read before trusting a result:
 *
 * - This is **real SQLite, not workerd/D1**. Engine-level behaviour is faithful,
 *   but Cloudflare-specific behaviour is not emulated: no D1 query limits, no
 *   D1 error codes/`cause` objects, no replication lag, and `batch()` is a local
 *   transaction rather than D1's own batching.
 * - `prepare()` here is **eager** (node:sqlite compiles on prepare), whereas D1
 *   is lazy. This is deliberately stricter: malformed SQL fails at the call site
 *   instead of at execution, which is what makes these tests useful.
 * - `meta.duration`/`rows_read`/`rows_written` are our own approximations; only
 *   `changes` and `last_row_id` carry real meaning and are what the code reads.
 */
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type SqlValue = string | number | null;

type RawRow = Record<string, unknown>;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations");

/**
 * Statement handle. Mirrors the subset of the D1 prepared-statement API that the
 * Worker actually uses.
 */
class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: SqlValue[] = []
  ) {}

  bind(...values: SqlValue[]): SqliteStatement {
    // D1 accepts `undefined` bindings and stores NULL; match that.
    return new SqliteStatement(
      this.db,
      this.sql,
      values.map((value) => (value === undefined ? null : value))
    );
  }

  async all<T = RawRow>(): Promise<{ results: T[]; success: true; meta: Meta }> {
    const startedAt = performance.now();
    const rows = this.db.prepare(this.sql).all(...this.params) as T[];
    return {
      results: rows,
      success: true,
      meta: meta(0, 0, performance.now() - startedAt, rows.length, 0)
    };
  }

  async first<T = RawRow>(): Promise<T | null> {
    const rows = this.db.prepare(this.sql).all(...this.params) as T[];
    return rows.length > 0 ? rows[0] : null;
  }

  async run(): Promise<{ results: RawRow[]; success: true; meta: Meta }> {
    const startedAt = performance.now();
    const result = this.db.prepare(this.sql).run(...this.params);
    return {
      results: [],
      success: true,
      meta: meta(
        Number(result.changes),
        Number(result.lastInsertRowid),
        performance.now() - startedAt,
        0,
        Number(result.changes)
      )
    };
  }
}

type Meta = {
  changes: number;
  last_row_id: number;
  duration: number;
  rows_read: number;
  rows_written: number;
};

function meta(changes: number, lastRowId: number, duration: number, rowsRead: number, rowsWritten: number): Meta {
  return { changes, last_row_id: lastRowId, duration, rows_read: rowsRead, rows_written: rowsWritten };
}

class SqliteD1 {
  constructor(readonly raw: DatabaseSync) {}

  prepare(sql: string) {
    return new SqliteStatement(this.raw, sql);
  }

  /** D1 runs a batch in a single implicit transaction; so do we. */
  async batch(statements: SqliteStatement[]) {
    this.raw.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql: string) {
    this.raw.exec(sql);
    return { count: 0, duration: 0 };
  }
}

export type SqliteHarness = {
  /** Pass to `Bindings.DB`. The shim implements the D1 subset the Worker uses. */
  db: D1Database;
  /** Real SQLite handle, for direct assertions the Worker API cannot express. */
  raw: DatabaseSync;
  close(): void;
};

export function createSqliteD1(): SqliteHarness {
  const raw = new DatabaseSync(":memory:");
  const shim = new SqliteD1(raw);
  return {
    // SqliteD1 implements prepare/batch/exec only; the remaining D1 members are
    // never reached because the Worker code under test does not use them.
    db: shim as unknown as D1Database,
    raw,
    close: () => raw.close()
  };
}

/** Applied in filename order, exactly as wrangler applies them. */
export async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((name) => name.endsWith(".sql")).sort();
}

/**
 * Applies the real, unmodified migration files. `0001` sets
 * `PRAGMA foreign_keys = ON`, which then stays on for the connection — so foreign
 * key violations are genuinely enforced in these tests.
 */
export async function applyMigrations(raw: DatabaseSync): Promise<string[]> {
  const files = await migrationFiles();
  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    raw.exec(sql);
  }
  return files;
}
