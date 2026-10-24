import type { ReplaceTableConfig, ScopedExec, SqlParam, UpsertTableConfig } from '../types';
import { assertIdentifier } from './validate';

export function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

export const DEFAULT_BATCH_SIZE = 200;

/** Breakdown of rows applied by one apply* call, so the engine can report observability without re-deriving it. */
export interface ApplyResult {
  /** Total rows applied (upserts + deletes for upsert; all inserted rows for replace). */
  count: number;
  /** INSERT/UPDATE rows among `count`. */
  upserts: number;
  /** DELETE (tombstone) rows among `count`. Always 0 for replace. */
  deletes: number;
}

function buildMultiRowInsertSql(tableName: string, columns: string[], rowCount: number, suffix = ''): string {
  const placeholders = `(${columns.map(() => '?').join(', ')})`;
  const valuesClause = Array.from({ length: rowCount }, () => placeholders).join(', ');
  return `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${valuesClause}${suffix}`;
}

function flattenRowValues(rows: Record<string, unknown>[], columns: string[]): SqlParam[] {
  return rows.flatMap(row => columns.map(column => (row[column] ?? null) as SqlParam));
}

/**
 * Deletes all rows from `table.name`, then inserts the given rows.
 * SQL identifiers (table/column names) come only from the declared `table`
 * config — never from remote row keys. Values are always bound parameters.
 * Each batch is sent as a single multi-row `INSERT ... VALUES (...), (...)`
 * statement instead of one `INSERT` per row, to cut adapter roundtrips.
 */
export async function applyReplace(
  exec: ScopedExec,
  table: ReplaceTableConfig,
  rows: Record<string, unknown>[]
): Promise<ApplyResult> {
  const tableName = assertIdentifier(table.name, 'table.name');
  const columns = table.columns.map((column, index) => assertIdentifier(column, `columns[${index}]`));

  await exec(`DELETE FROM ${tableName}`);

  if (rows.length === 0) return { count: 0, upserts: 0, deletes: 0 };

  const batches = chunk(rows, table.batchSize ?? DEFAULT_BATCH_SIZE);
  for (const batch of batches) {
    const sql = buildMultiRowInsertSql(tableName, columns, batch.length);
    await exec(sql, flattenRowValues(batch, columns));
  }

  return { count: rows.length, upserts: rows.length, deletes: 0 };
}

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
export async function applyReplaceShadow(
  exec: ScopedExec,
  table: ReplaceTableConfig,
  rows: Record<string, unknown>[]
): Promise<ApplyResult> {
  const tableName = assertIdentifier(table.name, 'table.name');
  const columns = table.columns.map((column, index) => assertIdentifier(column, `columns[${index}]`));
  const shadowName = assertIdentifier(`${tableName}__shadow`, 'table.name (shadow)');

  const { rows: schemaRows } = await exec<{ sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [tableName]
  );
  const createTableSql = schemaRows[0]?.sql;
  if (!createTableSql) {
    throw new Error(
      `applyReplaceShadow: table "${tableName}" does not exist — it must be created by a migration before sync runs`
    );
  }

  const bodyMatch = createTableSql.match(/\(([\s\S]*)\)\s*(?:WITHOUT ROWID\s*)?;?\s*$/i);
  if (!bodyMatch) {
    throw new Error(`applyReplaceShadow: could not parse the schema of table "${tableName}" to build its shadow`);
  }
  const shadowCreateSql = `CREATE TABLE ${shadowName} (${bodyMatch[1]})`;

  await exec(`DROP TABLE IF EXISTS ${shadowName}`);
  await exec(shadowCreateSql);

  if (rows.length > 0) {
    const batches = chunk(rows, table.batchSize ?? DEFAULT_BATCH_SIZE);
    for (const batch of batches) {
      const sql = buildMultiRowInsertSql(shadowName, columns, batch.length);
      await exec(sql, flattenRowValues(batch, columns));
    }
  }

  await exec(`DROP TABLE ${tableName}`);
  await exec(`ALTER TABLE ${shadowName} RENAME TO ${tableName}`);

  return { count: rows.length, upserts: rows.length, deletes: 0 };
}

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
export async function applyUpsert(
  exec: ScopedExec,
  table: UpsertTableConfig,
  rows: Record<string, unknown>[]
): Promise<ApplyResult> {
  const tableName = assertIdentifier(table.name, 'table.name');
  const columns = table.columns.map((column, index) => assertIdentifier(column, `columns[${index}]`));
  const primaryKey = assertIdentifier(table.primaryKey, 'table.primaryKey');
  const deletedAtColumn =
    table.deletedAtColumn !== undefined
      ? assertIdentifier(table.deletedAtColumn, 'table.deletedAtColumn')
      : undefined;

  if (rows.length === 0) return { count: 0, upserts: 0, deletes: 0 };

  const preserveColumns = new Set(table.preserveColumns ?? []);
  const updateAssignments = columns
    .filter(column => column !== primaryKey && !preserveColumns.has(column))
    .map(column => `${column} = excluded.${column}`)
    .join(', ');
  const conflictSuffix = updateAssignments
    ? ` ON CONFLICT(${primaryKey}) DO UPDATE SET ${updateAssignments}`
    : ` ON CONFLICT(${primaryKey}) DO NOTHING`;

  const deleteSql = deletedAtColumn !== undefined ? `DELETE FROM ${tableName} WHERE ${primaryKey} = ?` : undefined;

  function isTombstone(row: Record<string, unknown>): boolean {
    return deleteSql !== undefined && row[deletedAtColumn as string] != null;
  }

  let upserts = 0;
  let deletes = 0;

  const batches = chunk(rows, table.batchSize ?? DEFAULT_BATCH_SIZE);
  for (const batch of batches) {
    let i = 0;
    while (i < batch.length) {
      const row = batch[i];

      if (isTombstone(row)) {
        const key = row[primaryKey];
        if (key == null) {
          throw new Error(
            `applyUpsert: table "${tableName}" received a tombstoned row (deletedAtColumn "${deletedAtColumn}") ` +
              `with a missing primaryKey "${primaryKey}" value`
          );
        }
        await exec(deleteSql as string, [key as never]);
        deletes += 1;
        i += 1;
        continue;
      }

      // Accumulate a run of consecutive, distinct-key upsert rows to send as one multi-row INSERT.
      const run: Record<string, unknown>[] = [];
      const seenKeys = new Set<unknown>();
      while (i < batch.length) {
        const candidate = batch[i];
        if (isTombstone(candidate)) break;
        const key = candidate[primaryKey];
        if (seenKeys.has(key)) break;
        seenKeys.add(key);
        run.push(candidate);
        i += 1;
      }

      const sql = buildMultiRowInsertSql(tableName, columns, run.length, conflictSuffix);
      await exec(sql, flattenRowValues(run, columns));
      upserts += run.length;
    }
  }

  return { count: upserts + deletes, upserts, deletes };
}
