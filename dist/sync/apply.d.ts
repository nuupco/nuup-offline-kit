import type { ReplaceTableConfig, ScopedExec, UpsertTableConfig } from '../types';
export declare function chunk<T>(items: T[], size: number): T[][];
/**
 * Deletes all rows from `table.name`, then inserts the given rows.
 * SQL identifiers (table/column names) come only from the declared `table`
 * config — never from remote row keys. Values are always bound parameters.
 */
export declare function applyReplace(exec: ScopedExec, table: ReplaceTableConfig, rows: Record<string, unknown>[]): Promise<number>;
/**
 * Inserts new rows / updates existing rows by `table.primaryKey`, via
 * `INSERT ... ON CONFLICT(primaryKey) DO UPDATE`. SQL identifiers come only
 * from the declared `table` config; values are always bound parameters.
 */
export declare function applyUpsert(exec: ScopedExec, table: UpsertTableConfig, rows: Record<string, unknown>[]): Promise<number>;
//# sourceMappingURL=apply.d.ts.map