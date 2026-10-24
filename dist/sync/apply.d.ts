import type { ReplaceTableConfig, ScopedExec, UpsertTableConfig } from '../types';
export declare function chunk<T>(items: T[], size: number): T[][];
export declare const DEFAULT_BATCH_SIZE = 200;
/** Breakdown of rows applied by one apply* call, so the engine can report observability without re-deriving it. */
export interface ApplyResult {
    /** Total rows applied (upserts + deletes for upsert; all inserted rows for replace). */
    count: number;
    /** INSERT/UPDATE rows among `count`. */
    upserts: number;
    /** DELETE (tombstone) rows among `count`. Always 0 for replace. */
    deletes: number;
}
/**
 * Deletes all rows from `table.name`, then inserts the given rows.
 * SQL identifiers (table/column names) come only from the declared `table`
 * config — never from remote row keys. Values are always bound parameters.
 * Each batch is sent as a single multi-row `INSERT ... VALUES (...), (...)`
 * statement instead of one `INSERT` per row, to cut adapter roundtrips.
 */
export declare function applyReplace(exec: ScopedExec, table: ReplaceTableConfig, rows: Record<string, unknown>[]): Promise<ApplyResult>;
/**
 * Replaces all rows via a shadow-table swap instead of DELETE+INSERT: builds
 * `${table.name}__shadow` with the exact schema of `table.name` (read from
 * `sqlite_master`, so PRIMARY KEY/NOT NULL/CHECK constraints carry over),
 * inserts the new rows into it, then drops the original and renames the
 * shadow into place. Run inside a transaction (as with `applyReplace`), this
 * means a crash or error at any point before the final rename leaves the
 * original table completely untouched — unlike DELETE+INSERT, which can
 * leave the table empty if interrupted mid-way.
 *
 * Known limitation: only the table's own schema is copied. Indexes, triggers,
 * and foreign keys declared via separate `CREATE INDEX`/`CREATE TRIGGER`
 * statements (not inline in the table's `CREATE TABLE`) are not recreated on
 * the new table and must be reapplied by the caller's migrations if needed.
 *
 * The target table must already exist (created by the consumer's migrations)
 * — this function only swaps data, it never creates a table's initial shape.
 */
export declare function applyReplaceShadow(exec: ScopedExec, table: ReplaceTableConfig, rows: Record<string, unknown>[]): Promise<ApplyResult>;
/**
 * Inserts new rows / updates existing rows by `table.primaryKey`, via
 * `INSERT ... ON CONFLICT(primaryKey) DO UPDATE`. SQL identifiers come only
 * from the declared `table` config; values are always bound parameters.
 *
 * Consecutive non-tombstoned rows are grouped into a single multi-row
 * `INSERT ... VALUES (...), (...) ON CONFLICT ...` statement instead of one
 * `INSERT` per row. A run breaks (and is flushed) whenever a tombstoned row
 * is encountered — each DELETE stays its own statement, interleaved in exact
 * array order — or whenever the same primary key would appear twice in the
 * same multi-row statement, since SQLite's upsert only resolves conflicts
 * against rows that already existed before the statement ran, not against
 * another row inserted earlier in the same multi-row VALUES list.
 */
export declare function applyUpsert(exec: ScopedExec, table: UpsertTableConfig, rows: Record<string, unknown>[]): Promise<ApplyResult>;
//# sourceMappingURL=apply.d.ts.map