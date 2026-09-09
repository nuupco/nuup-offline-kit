import type { Exec } from '../types';

// `exec` is `(sql, params?) => Promise<{ rows: any[] }>`, provided by the db adapter.

export async function columnExists(exec: Exec, table: string, column: string): Promise<boolean> {
  const { rows } = await exec(`PRAGMA table_info(${table})`);
  return rows.some((row: any) => row.name === column);
}

export async function addColumnIfNotExists(
  exec: Exec,
  table: string,
  column: string,
  type: string
): Promise<void> {
  const exists = await columnExists(exec, table, column);
  if (!exists) {
    await exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export async function tableExists(exec: Exec, table: string): Promise<boolean> {
  const { rows } = await exec(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table]);
  return rows.length > 0;
}

export async function indexExists(exec: Exec, indexName: string): Promise<boolean> {
  const { rows } = await exec(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`, [indexName]);
  return rows.length > 0;
}

export async function createIndexIfNotExists(
  exec: Exec,
  indexName: string,
  createIndexSql: string
): Promise<void> {
  const exists = await indexExists(exec, indexName);
  if (!exists) {
    await exec(createIndexSql);
  }
}
