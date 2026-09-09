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

const DEFAULT_BATCH_SIZE = 200;

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

  const batches = chunk(rows, table.batchSize ?? DEFAULT_BATCH_SIZE);
  for (const batch of batches) {
    for (const row of batch) {
      const values = columns.map(column => (row[column] ?? null) as never);
      await exec(insertSql, values);
    }
  }

  return rows.length;
}
