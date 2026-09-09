import type { Adapter, Exec, ExpoSqliteDatabase, ScopedExec } from '../types';
/**
 * Builds the scoped `exec` handle passed to a transaction's `fn`.
 *
 * The returned value is callable with the pre-change signature
 * `await exec(sql, params, options)`, and additionally exposes:
 * - `exec.run`: an alias for `exec` itself.
 * - `exec.runInTransaction`: always rejects with `NESTED_TRANSACTION_ERROR`,
 *   without issuing a `BEGIN` or invoking its argument. This is the only
 *   detected nesting path; nesting via the root adapter handle
 *   (`adapter.runInTransaction`) remains undetected (documented misuse).
 *
 * The handle is frozen before being handed to `fn`.
 */
export declare function createScopedExec(execute: Exec): ScopedExec;
export declare function createExpoSqliteAdapter({ databaseName, database }?: {
    databaseName?: string;
    database?: ExpoSqliteDatabase;
}): Adapter;
//# sourceMappingURL=expo-sqlite.d.ts.map