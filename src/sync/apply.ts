import type { ReplaceTableConfig, ScopedExec, UpsertTableConfig } from '../types';
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

/**
 * Deletes all rows from `table.name`, then inserts the given rows.
 * SQL identifiers (table/column names) come only from the declared `table`
 * config — never from remote row keys. Values are always bound parameters.
 */
export async function applyReplace(
  exec: ScopedExec,
  table: ReplaceTableConfig,
  rows: Record<string, unknown>[]
): Promise<number> {
  const tableName = assertIdentifier(table.name, 'table.name');
  const columns = table.columns.map((column, index) => assertIdentifier(column, `columns[${index}]`));

  await exec(`DELETE FROM ${tableName}`);

  if (rows.length === 0) return 0;

  const placeholders = `(${columns.map(() => '?').join(', ')})`;
  const insertSql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${placeholders}`;

  const batches = chunk(rows, table.batchSize ?? DEFAULT_BATCH_SIZE);
  for (const batch of batches) {
    for (const row of batch) {
      const values = columns.map(column => (row[column] ?? null) as never);
      await exec(insertSql, values);
    }
  }

  return rows.length;
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
): Promise<number> {
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
    const placeholders = `(${columns.map(() => '?').join(', ')})`;
    const insertSql = `INSERT INTO ${shadowName} (${columns.join(', ')}) VALUES ${placeholders}`;
    const batches = chunk(rows, table.batchSize ?? DEFAULT_BATCH_SIZE);
    for (const batch of batches) {
      for (const row of batch) {
        const values = columns.map(column => (row[column] ?? null) as never);
        await exec(insertSql, values);
      }
    }
  }

  await exec(`DROP TABLE ${tableName}`);
  await exec(`ALTER TABLE ${shadowName} RENAME TO ${tableName}`);

  return rows.length;
}

/**
 * Inserts new rows / updates existing rows by `table.primaryKey`, via
 * `INSERT ... ON CONFLICT(primaryKey) DO UPDATE`. SQL identifiers come only
 * from the declared `table` config; values are always bound parameters.
 */
export async function applyUpsert(
  exec: ScopedExec,
  table: UpsertTableConfig,
  rows: Record<string, unknown>[]
): Promise<number> {
  const tableName = assertIdentifier(table.name, 'table.name');
  const columns = table.columns.map((column, index) => assertIdentifier(column, `columns[${index}]`));
  const primaryKey = assertIdentifier(table.primaryKey, 'table.primaryKey');
  const deletedAtColumn =
    table.deletedAtColumn !== undefined
      ? assertIdentifier(table.deletedAtColumn, 'table.deletedAtColumn')
      : undefined;

  if (rows.length === 0) return 0;

  const placeholders = `(${columns.map(() => '?').join(', ')})`;
  const updateAssignments = columns
    .filter(column => column !== primaryKey)
    .map(column => `${column} = excluded.${column}`)
    .join(', ');
  const insertSql =
    `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${placeholders}` +
    (updateAssignments
      ? ` ON CONFLICT(${primaryKey}) DO UPDATE SET ${updateAssignments}`
      : ` ON CONFLICT(${primaryKey}) DO NOTHING`);

  const deleteSql = deletedAtColumn !== undefined ? `DELETE FROM ${tableName} WHERE ${primaryKey} = ?` : undefined;

  const batches = chunk(rows, table.batchSize ?? DEFAULT_BATCH_SIZE);
  for (const batch of batches) {
    for (const row of batch) {
      if (deleteSql !== undefined && row[deletedAtColumn as string] != null) {
        const key = row[primaryKey];
        if (key == null) {
          throw new Error(
            `applyUpsert: table "${tableName}" received a tombstoned row (deletedAtColumn "${deletedAtColumn}") ` +
              `with a missing primaryKey "${primaryKey}" value`
          );
        }
        await exec(deleteSql, [key as never]);
        continue;
      }
      const values = columns.map(column => (row[column] ?? null) as never);
      await exec(insertSql, values);
    }
  }

  return rows.length;
}
